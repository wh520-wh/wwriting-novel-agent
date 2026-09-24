// src/core/agent/runtime.mjs —— 编排内核（第十五轮波A收口后）。
//
// 深模块内部实现：生产调用方只能经 src/core/agent/index.mjs 使用；tests/agent/ 可以
// 测试本模块内部 seam。本文件只做编排：组合根注入 → 项目/会话物化（sessionState
// 组装 journal/tools/history/compaction/run-lifecycle/session-manager 域模块）→
// Run 循环编排（队列/安全点/收敛接线）；域职责见各模块头注释（run-lifecycle：
// 停止/优先切换/失败收束；run-control：Run 命令面；session-manager：会话 CRUD；
// history-assembly：历史装配；compaction：压缩状态机与源材料构建）。
// 承重不变式：模型调用失败必须闭合 model turn（补 model_turn_completed），绝不
// 留下 dangling assistant 活动；事件真相与 crash 对账在 journal.mjs（各域模块
// 不直接落盘）。
import path from "node:path";
import { randomUUID } from "node:crypto";

import { buildProcessRestartedConvergence, createAgentJournal, TERMINAL_RUN_STATUSES } from "./journal.mjs";
import { createSessionRegistry } from "./session-registry.mjs";
import { createToolRuntime } from "./tools/index.mjs";
import { createContextCheckpointStore } from "./context-checkpoints.mjs";
import {
  buildCompactionSource,
  createCompactionCoordinator,
  COMPACTION_NON_TERMINAL_STATES,
  COMPACTION_RESUME_BLOCKED_STATES
} from "./compaction.mjs";
// Task 7（F5a）：历史装配层拆到 history-assembly.mjs——HISTORY_PAGE_LIMIT 以
// 本模块为单一来源；相关纯转换函数（buildTurnsFromTranscript/transcriptToMessages/
// collectOpenToolCalls/summarizeLargeToolMessages）已随压缩源材料构建迁入
// compaction.mjs（Task 10），Run 输入流水线迁出后（Task 10b）此处不再转发。
import { createHistoryAssembly } from "./history-assembly.mjs";
import { loadProject } from "../project-store.mjs";
import { createMutex } from "../async-utils.mjs";
import { createRedactor } from "../shell/redaction.mjs";
import { resolveModelLimits } from "../model/model-identity.mjs";
import { skillService } from "../skills/index.mjs";

import {
  appendChapterSegment,
  commitChapter,
  finalizeChapter,
  inspectChapterContext,
  rollbackChapter,
  updateMemoryFromExtraction,
  ProjectOperationError
} from "../project-operations/chapter.mjs";
import { readContinuityBriefing } from "../chapter-memory.mjs";
import { codedError as fail } from "./agent-utils.mjs";
// Task 8（F5b 第十五轮）：Run 收敛状态机（停止/优先切换/失败收束/循环推进与
// 等待）拆到 run-lifecycle.mjs——经 createRunLifecycle(ctx) 以 getter 注入
// state/sessionState，runtime.mjs 恢复为编排内核。
import { createRunLifecycle } from "./run-lifecycle.mjs";
// Task 10b（F5d 第十五轮）：Run 输入流水线（processInput/processCompact 及其
// 独占辅助）拆到 run-pipeline.mjs——经 createRunPipeline(ctx) 注入 runtime
// 内部函数引用；其导出同时供 run-lifecycle ctx 改接（见 ensureSessionState）。
import { createRunPipeline } from "./run-pipeline.mjs";
// Task 9（F5c 第十五轮）：会话 CRUD/registry 同步/标题派生/系统事件拆到
// session-manager.mjs——ensureProject/resolveSessionState 经 ctx 注入函数引用，
// 实例创建见 resolveSessionState 之后；导出符号的消费说明见下方标记块。
import { createSessionManager, hasNonTerminalRun } from "./session-manager.mjs";
// Task 18（F6 第二十轮）：Run 命令面（submit/requestPriority/withdrawInput/decide/
// stop/retry/retryCompaction/cancelCompaction 及其独占辅助）拆到 run-control.mjs
// ——经 createRunControl(ctx) 注入 runtime 内部函数引用；见下方标记块。
import { createRunControl } from "./run-control.mjs";

// 第九轮：会话级缓存命中率累计（token 加权）。命中 token 不超过输入 token
//（与 cost-tracker.mjs 的 clamp 一致）；非法/缺失 usage 不改变累计。
export function accumulateCacheStats(stats, usageReport) {
  if (!stats || typeof stats !== "object") return stats;
  const hit = Number(usageReport?.cacheHitTokens);
  const input = Number(usageReport?.inputTokens);
  if (!Number.isFinite(hit) || !Number.isFinite(input) || input <= 0) return stats;
  stats.hitTokens += Math.min(hit, input);
  stats.inputTokens += input;
  return stats;
}

export function cacheHitRateOf(stats) {
  if (!stats || typeof stats !== "object") return null;
  return Number.isFinite(Number(stats.inputTokens)) && Number(stats.inputTokens) > 0
    ? Number(stats.hitTokens) / Number(stats.inputTokens)
    : null;
}

// 统一工具目录（Task 7）：不再按工作流切换——每一轮都提供相同的生产工具集：
// 十个通用工具 + 六个深工具恒可用（Task 8：旧 blueprint 事务工具已整体删除，
// 不再有注册表残留）。
// Task 6：名单由 ToolRuntime 注册表派生（tools.toolNames()），不再维护独立常量。

// 第九轮：派生记忆提取器退役。commit/finalize/rollback 结果附加固定记忆维护
// 提醒（memory_checklist），记忆由模型自调用 update_memory 工具维护。
const MEMORY_CHECKLIST = "记忆维护：请依次 update_memory（含新埋（open）与回收（paid）的伏笔） → 更新 book_summary.md → 更新 WORKLOG.md";
const withMemoryChecklist = (result) => ({ ...(result ?? {}), memory_checklist: MEMORY_CHECKLIST });

// Task 9（F5c 第十五轮）：会话标题派生、注册表同步、自动命名与删除守卫
//（deriveSessionTitle/syncSessionRegistry/autoNameSessionIfDefault/
// hasNonTerminalRun/requireSessionId）已随会话 CRUD 拆到 session-manager.mjs——
// runtime 经 sessionManager 实例调用（12 个同步点 + 1 个自动命名点）。
// Task 18（第二十轮）：deriveSessionTitle 的惰性创建消费点（submit）随 run 命令面
// 迁入 run-control.mjs。

// ---------------------------------------------------------------------------
// 每项目状态：journal + ToolRuntime + 当前 Run 的循环控制
// ---------------------------------------------------------------------------

export function createAgentRuntime({
  modelGateway = null,
  // Task 9 接线：composition root 可注入 gatewayFactory(projectRoot) -> gateway，
  // 让每个项目持有独立的 ModelGateway（per-project CostTracker/cost.json 记账）。
  // 与 modelGateway 二选一；测试 harness 继续只传 modelGateway。
  gatewayFactory = null,
  shell = null,
  projectLocks = null,
  secrets = [],
  // Task 12：skills service seam（src/core/skills/index.mjs）。生产缺省用全局
  // 单例；测试注入临时 root 的 service，避免迁移 marker 写进真实用户目录。
  skills = null,
  idFactory = randomUUID,
  // Task 3：工具期限透传（默认与 ToolRuntime 系统上限一致；测试可注入毫秒级
  // 期限，在真实 agent 循环内产生 tool_timeout 回归面）
  toolIdleTimeoutMs = 300000,
  toolAbsoluteTimeoutMs = 3600000,
  // Task 3：journal 落盘位置（生产组合根必须显式传应用私有 storageRoot；默认
  // 项目内 .wwriting/agent 只保留给低层兼容测试）。
  agentStorageRootFor = (projectRoot) => path.join(projectRoot, ".wwriting", "agent"),
  // Task 5：每模型轮读取有效工作区配置的加载器（组合根注入 loadEffectiveWorkspaceConfig
  // + 全局默认模型兜底）。缺省读 project.yaml（与旧 loadProjectSafe 语义一致），供低层
  // 测试与无注入调用方使用。每轮调用、不在 Runtime 缓存整份配置——模型/权限切换在下一
  // 模型轮自然生效。
  workspaceConfigLoader = null
} = {}) {
  if (!modelGateway && typeof gatewayFactory !== "function") {
    throw new TypeError("createProjectAgent 需要注入带 complete(request, { signal }) 的 modelGateway");
  }
  const resolveGateway = typeof gatewayFactory === "function" ? gatewayFactory : () => modelGateway;
  const redactor = createRedactor({ secrets });
  // 技能 service：注入优先，缺省全局单例（生产组合根不传，catalog 迁移先行）。
  const projectSkills = skills ?? skillService;

  const projects = new Map(); // projectRoot -> project state

  function ensureProject(projectRoot) {
    const resolved = path.resolve(projectRoot);
    // win32 大小写不敏感 FS：Map 键归一小写（否则 D:\Foo/D:\foo 分裂成两个 state：两把锁/两个 journal 写同一物理目录；审计 Downgraded #1，
    // 口径对齐 project-lock.mjs:38）。只归一「键」——resolved 仍按调用方书写大小写流向 state.key/prompt/工具 cwd/journal 的 project_root，不把全小写路径写进用户可见事件。
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    let state = projects.get(key);
    if (!state) {
      // Task 4：agentRoot 即应用的私有 agent storage root；每会话的 journal/
      // checkpoint 落在 <agentRoot>/sessions/<id>/ 下（ensureSessionState）。
      const agentRoot = agentStorageRootFor(resolved);
      const projectOperations = {
        inspectChapterContext,
        appendChapterSegment,
        commitChapter: async (params, options) => withMemoryChecklist(await commitChapter(params, options)),
        finalizeChapter: async (params, options) => withMemoryChecklist(await finalizeChapter(params, options)),
        rollbackChapter: async (params, options) => withMemoryChecklist(await rollbackChapter(params, options)),
        updateMemoryFromExtraction,
        readContinuityBriefing
      };
      state = {
        key: resolved,
        agentRoot,
        // Task 4：会话注册表（<agentRoot>/sessions/index.json）+ 每会话运行状态
        registry: createSessionRegistry({ root: agentRoot }),
        sessions: new Map(), // sessionId -> sessionState（ensureSessionState 惰性物化）
        projectOperations,
        modelGateway: resolveGateway(resolved),
        skills: projectSkills,
        // 当前 Run 的循环控制（一次一个模型/工具循环）。Task 4 串行门保证整个
        // 项目同时至多一个非终态 Run，因此循环控制保持项目级即可；loopSessionId
        // 记录该循环属于哪个会话（clearHistory 跨会话复位判断用）。
        runId: null,
        loopSessionId: null,
        controller: null,
        loopPromise: null,
        firstTurn: null,
        stopReason: "user_stop",
        mutex: createMutex(),
        // Prompt 的 Available Skills 目录摘要：只取 name/description，绝不注入正文
        // （完整指令由 read_skill 按需读取）。catalog 失败不阻塞 agent（沿用兜底语义）。
        // 每 runId 记忆一次发现结果（Important 4）：模型每个轮次都会走到这里，
        // 不记忆则每个轮次都要重读 + YAML 解析全部 SKILL.md 并遍历资源树。
        catalogCache: null,
        readSkillCatalog: async () => {
          if (state.catalogCache && state.catalogCache.runId === state.runId) {
            return state.catalogCache.promise;
          }
          const promise = (async () => {
            try {
              const { active } = await projectSkills.catalog({ projectRoot: resolved });
              return active.map((skill) => ({ name: skill.name, description: skill.description ?? "", category: skill.category ?? null }));
            } catch {
              return [];
            }
          })();
          state.catalogCache = { runId: state.runId, promise };
          return promise;
        }
      };
      projects.set(key, state);
    }
    return state;
  }

  // 物化（或复用）某会话的运行状态：独立 journal/checkpoint/tools/压缩协调器，
  // 存储根 = <agentRoot>/sessions/<id>/。注册表条目由调用方先行保证存在（open/
  // submit/newSession 已 create 或校验）。
  //
  // 会话 id 对齐结论（Task 4 前序审查要点 3，调查后决策）：
  //   - 新会话（惰性创建/newSession/open 首开）：journal 首次空载（load() 内部
  //     createFirstSession）用一次性 idFactory 产出「注册表 id」作为其内部
  //     session_id——两者相等，事件的 session_id 与外部书签一致。
  //   Task 13：迁移会话路径已删除，所有会话都经 createAgentJournal 的
  //   initialSessionId 与注册表 id 对齐（见下方修复说明），不再有「注册表 id 仅作
  //   外部书签、内部沿用旧 id」的错位形态。
  async function ensureSessionState(state, sessionId) {
    let sessionState = state.sessions.get(sessionId);
    if (sessionState) {
      await sessionState.ready;
      return sessionState;
    }
    const storageRoot = path.join(state.agentRoot, "sessions", sessionId);
    // 修复（2026-08-11）：不要把 idFactory 包装成「首次调用返回 sessionId」的闭包
    // 传给 journal（旧实现）——journal 实例在进程重启/会话重新物化后重建时，首个
    // 常规 append 会拿到 event_id=sessionId；同一会话跨实例重复盖章产生重复
    // event_id，journal 重放时唯一性校验失败（event_id <id> 重复），该会话从此
    // 无法加载，submit 立即报 INTERNAL_ERROR →「操作未完成」。对齐改由
    // createAgentJournal 的 initialSessionId 显式承担（仅空 journal 的
    // session_created 消费），event_id 恒走随机 idFactory。
    const checkpointStore = createContextCheckpointStore({ agentDir: storageRoot, idFactory });
    const journal = createAgentJournal({
      projectRoot: state.key,
      storageRoot,
      idFactory,
      initialSessionId: sessionId,
      retireExtraFiles: (clearedDir) => checkpointStore.retireForClear(clearedDir),
      restoreExtraFiles: (moved, clearedDir) => checkpointStore.restoreFromClear(moved, clearedDir),
      // transcript 落盘脱敏（journal 工厂方法 appendSafeTranscript 消费）
      redactText: (json) => redactor.redact(json)
    });
    const tools = createToolRuntime({
      projectOperations: state.projectOperations,
      journal,
      shellRuntime: shell,
      projectLocks,
      secrets,
      skills: state.skills,
      idFactory,
      toolIdleTimeoutMs,
      toolAbsoluteTimeoutMs
    });
    const compactionCoordinator = createCompactionCoordinator({
      journal,
      gateway: state.modelGateway,
      checkpointStore,
      buildInput: (params) =>
        buildCompactionSource({
          journal,
          checkpointStore,
          resolveWorkspaceConfig,
          modelConfigOf,
          ...params,
          // 进程重启后的 retry 走协调器重建路径，entry.projectRoot 为空——
          // 闭包默认注入本项目根，供 buildCompactionSource 解析当前 modelConfig。
          projectRoot: params.projectRoot ?? state.key
        }),
      idFactory
    });
    // Task 7（F5a）：历史装配层（transcript/checkpoint -> 模型消息的纯转换与
    // buildHistory）拆到 history-assembly.mjs。buildHistory 只经工厂闭包持有
    // journal/checkpointStore——不直接触盘、不脱敏，故不注入 storageRoot/redactor
    //（原调用点传入的 storageRoot 仅为签名残留，函数体并不使用）。
    const history = createHistoryAssembly({ journal, checkpointStore });
    sessionState = {
      sessionId,
      storageRoot,
      journal,
      checkpointStore,
      history,
      tools,
      compactionCoordinator,
      // 当前 session 的上下文估算校准倍率（provider usage 的 EMA 比例，夹在
      // 0.5..2.0，只属于本会话；clearHistory 时一并复位）。null 表示尚无 provider
      // 观测，估算用默认倍率 1 并保持 approximate。
      contextCalibration: null,
      // 第九轮：会话级缓存命中率累计（token 加权，进程内；重启用例下归零 → 前端不显示）。
      cacheStats: { hitTokens: 0, inputTokens: 0 }
    };
    // Task 8（F5b）：Run 收敛状态机（停止/优先切换/失败收束/循环推进与等待）拆到
    // run-lifecycle.mjs——per-session 实例绑定本会话：getter 惰性读取 state 与
    // sessionState（循环/等待期间 state.controller/loopPromise 等字段变化可见），
    // runtime 内部函数经 ctx 注入原签名引用。仅本模块内部经 sessionState 消费，
    // 不流出 runtime.mjs。
    sessionState.lifecycle = createRunLifecycle({
      getState: () => state,
      getSessionState: () => sessionState,
      // Task 10b：processCompact/processInput 与 appendSafeTranscript/
      // isCompactRunIdleInitiated 已归 run-pipeline，改接 runPipeline 导出
      //（单源，不再经 runtime 闭包转发）。
      appendSafeTranscript: runPipeline.appendSafeTranscript,
      isCompactRunIdleInitiated: runPipeline.isCompactRunIdleInitiated,
      resetController,
      processCompact: runPipeline.processCompact,
      processInput: runPipeline.processInput
    });
    state.sessions.set(sessionId, sessionState);
    sessionState.ready = (async () => {
      await journal.load();
      await reconcileSessionAfterLoad(sessionState);
    })();
    try {
      await sessionState.ready;
      return sessionState;
    } catch (error) {
      if (state.sessions.get(sessionId) === sessionState) state.sessions.delete(sessionId);
      throw error;
    }
  }

  // 解析目标会话 id：显式 sessionId → 校验存在；缺省 → 最近活跃；
  // 都没有 → null（品牌新项目，不物化任何会话——惰性创建）。
  // 显式 id 先查内存已物化会话（SSE 轮询热路径：已打开的会话无需每次读盘），
  // 未物化才回退注册表（注册表条目存在但 journal 未建立的会话依然可解析）。
  async function resolveSessionId(state, sessionId) {
    if (sessionId != null && sessionId !== "") {
      if (state.sessions.has(sessionId)) return sessionId;
      const meta = await state.registry.get(sessionId);
      if (!meta) throw fail("session_not_found", `会话不存在: ${sessionId}`);
      return sessionId;
    }
    return state.registry.getLastActive();
  }

  // 解析目标会话状态（不存在 → null，不物化新会话）。
  async function resolveSessionState(state, sessionId) {
    const id = await resolveSessionId(state, sessionId);
    if (id == null) return null;
    return await ensureSessionState(state, id);
  }

  // Task 9（F5c 第十五轮）：会话 CRUD/registry 同步/标题派生/系统事件拆到
  // session-manager.mjs——ensureProject/resolveSessionState 闭包引用经 ctx 注入，
  // 实例与 ensureProject 等每项目基础设施并列创建；
  // 内部 13 个同步/命名调用点（sessionManager.xxx）与公共 API 单行委托
  // （index.mjs 转发链零改动）。函数设计注释随逻辑迁入新模块。
  // Task 18：项目串行门 assertNoOtherSessionRunning 随 run 命令面迁入
  // run-control.mjs（其唯一三个消费方 submit/retry/retryCompaction 同迁）。
  const sessionManager = createSessionManager({ ensureProject, resolveSessionState });

  // 会话 load 后的崩溃对账（等价旧 open() 的恢复序列，不含 startLoop——循环启动
  // 由调用方在串行门通过后决定）：checkpoint 对账 → 非终态压缩收敛。
  async function reconcileSessionAfterLoad(sessionState) {
    // Task 8：checkpoint 崩溃对账（提交 marker 裁决 + 孤儿清理）必须在检查压缩
    // 投影之前执行——对账可能补写 completed（裁决 2）或 failed（裁决 1），使压缩
    // 变为终态。storage 损坏（checkpoint_corrupt）暴露可诊断错误，不猜测回滚。
    await sessionState.checkpointStore.reconcileAfterCrash({ journal: sessionState.journal });
    // Task 8：非终态压缩对账（brief Step 3 结尾）。先通过 commit marker 对账
    //（上面 reconcileAfterCrash），未完成 attempt 统一追加
    // context_compaction_cancelled(reason:"process_restarted")，然后按收敛矩阵
    // 把 Run 收敛为 waiting_user（自动失败/取消、手动失败均保持 waiting_user，
    // 不自动模型调用）。active_context_checkpoint_id 保持旧值（cancelled 不切换）。
    const loadedSession = await sessionState.journal.getSession();
    const loadedCompaction = loadedSession.compaction;
    if (loadedCompaction && COMPACTION_RESUME_BLOCKED_STATES.includes(loadedCompaction.state)) {
      if (COMPACTION_NON_TERMINAL_STATES.includes(loadedCompaction.state)) {
        await sessionState.journal.append({
          type: "context_compaction_cancelled",
          payload: {
            compaction_id: loadedCompaction.id,
            trigger: loadedCompaction.trigger,
            attempt: loadedCompaction.attempt ?? 1,
            source_checkpoint_id: loadedCompaction.source_checkpoint_id ?? null,
            checkpoint_id: loadedCompaction.checkpoint_id ?? null,
            source_seq: null,
            source_transcript_seq: null,
            provider_model_id: null,
            estimated_tokens_before: null,
            estimated_tokens_after: null,
            released_tokens: null,
            summary_schema_version: 1,
            duration_ms: null,
            validation: null,
            error_code: null,
            cancel_reason: "process_restarted"
          }
        });
      }
      // 收敛 Run/input：残留 running（崩溃窗口）收敛为 waiting_user；
      // 已是 waiting_user 保持原状。stopping/interrupting 残留（停止+压缩在途
      // 崩溃窗口）收敛为 interrupted——此前永久卡死 stopping、不可删不可停（F3）。
      const recoveryRun = (await sessionState.journal.getSession()).active_run;
      for (const recoveryEvent of buildProcessRestartedConvergence(recoveryRun)) {
        await sessionState.journal.append(recoveryEvent);
      }
    }
  }

  function resetController(state) {
    if (state.controller && state.controller.signal.aborted) {
      state.controller = new AbortController();
    }
  }

  // -------------------------------------------------------------------------
  // 模型/工具循环
  // -------------------------------------------------------------------------

  // project.yaml 缺失/损坏时的最小兜底（只读工具仍可用；深工具由 project
  // operations 自行校验）。兜底对象永不被持久化。Task 12：enabled_skills 已废弃。
  const FALLBACK_PROJECT = Object.freeze({
    project_id: null,
    tool_permissions: {},
    output_format: "md",
    archived_at: null,
    active_model: null,
    min_words_per_chapter: 0,
    target_words_per_chapter: 0
  });

  async function loadProjectSafe(projectRoot) {
    try {
      const project = await loadProject(projectRoot);
      return project && typeof project === "object" ? project : FALLBACK_PROJECT;
    } catch {
      return FALLBACK_PROJECT;
    }
  }

  // 有效配置加载器：注入优先，缺省回退 loadProjectSafe（旧语义）。
  const resolveWorkspaceConfig = typeof workspaceConfigLoader === "function"
    ? workspaceConfigLoader
    : loadProjectSafe;

  function modelConfigOf(project) {
    const active = project?.active_model ?? {};
    // 第十三轮（ADR 0004）：有效窗口/最大输出唯一来自 context_window /
    // max_output_tokens 字段（缺省 256k / 64k，resolveModelLimits 统一解析），
    // 模型名原样透传不再剥尾标。持久配置绝不写回：只覆盖运行时副本。
    const limits = resolveModelLimits(active);
    return {
      ...active,
      provider: typeof active.provider === "string" ? active.provider : "unknown",
      configured_model_id: active.model_name ?? "",
      model_name: active.model_name ?? "",
      effective_context_window: limits.effective_context_window,
      max_output_tokens: limits.effective_max_output_tokens,
      compaction_threshold: limits.compaction_threshold,
      window_source: limits.window_source,
      // 项目级思考强度（project.yaml.reasoning_effort）：仅透传，是否真正发送
      // 由 adapter 按模型 capability（reasoningEffortLevels）决定，auto/缺省不发。
      ...(typeof project?.reasoning_effort === "string" ? { reasoning_effort: project.reasoning_effort } : {})
    };
  }

  // Task 10b（F5d）：Run 输入流水线（processInput/processCompact 及其独占辅助）
  // 拆到 run-pipeline.mjs——经 createRunPipeline(ctx) 注入 runtime 内部函数引用
  //（resolveWorkspaceConfig/modelConfigOf 仍被 buildInput 闭包消费，不随迁；
  // accumulateCacheStats/cacheHitRateOf 为 runtime 导出，tests 直测）。
  // run-lifecycle ctx 的 processCompact/processInput/appendSafeTranscript/
  // isCompactRunIdleInitiated 亦改接本实例（见 ensureSessionState）。
  const runPipeline = createRunPipeline({
    resolveWorkspaceConfig,
    modelConfigOf,
    resetController,
    redactor,
    secrets,
    idFactory,
    accumulateCacheStats,
    cacheHitRateOf,
    // shell 可用性（生产由 app-server 注入 runShellCommand）——run-pipeline 的
    // processInput 在 runtime policy 中宣告 shell 能力，漏注入会静默降级为
    // unavailable（P1 回归）。
    shell
  });

  // Task 18（F6 第二十轮）：Run 命令面（提交/优先/撤回/决策/停止/重试/压缩重试/
  // 压缩取消）拆到 run-control.mjs——经 ctx 注入 runtime 内部闭包引用。ctx 的 6 个
  // 键与迁出前各方法自由引用的捕获变量一一对应（见 run-control.mjs 头注释），
  // 故迁出后语义逐字不变。实例创建置于 sessionManager/runPipeline 之后。
  const runControl = createRunControl({
    ensureProject,
    resolveSessionId,
    ensureSessionState,
    resolveSessionState,
    sessionManager,
    idFactory
  });

  // -------------------------------------------------------------------------
  // 公共接口
  // -------------------------------------------------------------------------

  async function open({ projectRoot, sessionId = null }) {
    if (typeof projectRoot !== "string" || projectRoot.length === 0) {
      throw fail("invalid_project_root", "projectRoot 必须是非空路径。");
    }
    const state = ensureProject(projectRoot);
    // 解析目标会话：显式 sessionId → registry.get 校验存在；缺省 → 最近活跃；
    // 品牌新项目（无任何会话）→ 空项目状态，不建 journal、不建会话（惰性创建）。
    const targetId = await resolveSessionId(state, sessionId);
    if (targetId == null) {
      return { session_id: null, status: "idle" };
    }
    const sessionState = await ensureSessionState(state, targetId);
    // 注册表 updated_at 同步（幂等）：以用户动作时刻刷新会话活跃排序依据。
    // 同步失败只告警，派生元数据以事件流为准。
    await sessionManager.syncSessionRegistry(state, sessionState);
    // 恢复：只恢复有效非终态 Run（journal.load 已把 dangling assistant 活动标记
    // 为 interrupted；那些 Run 等待 retry，不自动恢复）。压缩处于阻塞状态
    //（started/running/cancelling/failed）时绝不自动启动循环——绝不让
    // 旧 processInput 自动再次执行。
    const session = await sessionState.journal.getSession();
    const run = session.active_run;
    const compactionBlocked =
      session.compaction != null && COMPACTION_RESUME_BLOCKED_STATES.includes(session.compaction.state);
    if (run && !TERMINAL_RUN_STATUSES.has(run.status) && !compactionBlocked) {
      sessionState.lifecycle.startLoop(run.id);
    }
    // session_id 返回注册表 id（外部书签）；status 为恢复后的会话状态。
    return { session_id: targetId, status: session.status };
  }

  // 项目级忙判（审计交叉印证 2026-09-23）：覆盖全部已物化会话，且在项目互斥锁内
  // 判定（与 submit/retry 的 run 启动原子）。供 rollback / memory restore 等破坏性
  // 项目操作做忙门——snapshot 缺省只解析最近活跃单会话，会漏掉非活跃会话。
  // 锁序：本函数取 state.mutex 后只调 journal.getSession()（取 journal 自身锁），
  // 与 submit/assertNoOtherSessionRunning 同序（state.mutex → journal.mutex），
  // 无反向持锁路径，不成环。
  async function projectBusy({ projectRoot }) {
    const state = ensureProject(projectRoot);
    return state.mutex.run(async () => {
      for (const [, other] of state.sessions) {
        const session = await other.journal.getSession();
        if (hasNonTerminalRun(session)) return true;
      }
      return false;
    });
  }

  // 快照：{ session, events, gaps, has_more } 是 AgentSurface 的唯一实时数据源。
  // Task 5 双向分页：
  //   tail === true      → journal.readTail({ limit })（首次展示：尾部最新一页）
  //   beforeSeq != null  → journal.readBefore({ beforeSeq, limit })（向上滚动旧页）
  //   否则               → journal.readAfter({ afterSeq, limit })（增量拉取）
  // afterSeq=0 只表示从头读取（旧客户端兼容），AgentSurface 首次打开不得用
  // afterSeq=0 补齐所有历史（前端改用 tail/beforeSeq，Task 9/10 接线）。
  async function snapshot({ projectRoot, sessionId = null, afterSeq = 0, beforeSeq = null, tail = false, limit = 100 } = {}) {
    const state = ensureProject(projectRoot);
    const sessionState = await resolveSessionState(state, sessionId);
    if (!sessionState) {
      // 无会话：空快照（惰性创建——不产生会话条目）
      return { session: null, events: [], gaps: [], has_more: false };
    }
    await sessionState.journal.load();
    const session = await sessionState.journal.getSession();
    let page;
    if (tail === true) {
      page = await sessionState.journal.readTail({ limit });
    } else if (beforeSeq != null) {
      page = await sessionState.journal.readBefore({ beforeSeq, limit });
    } else {
      page = await sessionState.journal.readAfter({ afterSeq, limit });
    }
    const events = page.events;
    const lastSeq = sessionState.journal.lastSeq;
    let has_more;
    if (tail === true) {
      has_more = events.length > 0 ? events[0].seq > 1 : lastSeq > 0;
    } else if (beforeSeq != null) {
      has_more = events.length > 0 ? events[0].seq > 1 : beforeSeq > 1;
    } else {
      has_more = events.length > 0 ? events.at(-1).seq < lastSeq : lastSeq > afterSeq;
    }
    return { session, events, gaps: page.gaps, has_more };
  }

  // 历史导出（NDJSON 异步流）：只读动作，不追加 Journal 事件；由 journal 层顺序
  // 迭代 events/transcript 两个 segment store，每行 { stream, record }；对每条
  // record 应用 runtime 的 redactor（API key/模型密钥/provider header 脱敏）。
  //
  // Task 9：input_withdrawn 是 invisible journal 事件——普通导出（缺省）过滤被
  // 撤回输入的全部事件（input_queued/input_withdrawn 及其引用），UI/模型历史/
  // 普通导出都不暴露；audit:true 的原始诊断导出保留这些事件并显式标
  // audit_only:true（撤回不丢审计线索，只对普通消费者隐藏）。
  async function* exportHistory({ projectRoot, sessionId = null, audit = false } = {}) {
    if (typeof projectRoot !== "string" || projectRoot.length === 0) {
      throw fail("invalid_project_root", "projectRoot 必须是非空路径。");
    }
    const state = ensureProject(projectRoot);
    const sessionState = await resolveSessionState(state, sessionId);
    if (!sessionState) return; // 无会话：空流
    // 先扫描事件流找出全部 withdrawn input id（撤回输入已从投影移除，事件是唯一
    // 线索；导出是显式用户动作，全量扫描成本可接受）。
    const withdrawnInputs = new Set();
    const rawEvents = await sessionState.journal.read({ afterSeq: 0 });
    for (const event of rawEvents) {
      if (event.type === "input_withdrawn" && typeof event.payload?.input_id === "string") {
        withdrawnInputs.add(event.payload.input_id);
      }
    }
    const referencesWithdrawn = (record) => {
      if (withdrawnInputs.size === 0 || record == null) return false;
      if (typeof record.input_id === "string" && withdrawnInputs.has(record.input_id)) return true;
      const payloadId = record.payload?.input_id;
      return typeof payloadId === "string" && withdrawnInputs.has(payloadId);
    };
    for await (const line of sessionState.journal.exportHistory({
      redact: (record) => {
        try {
          return JSON.parse(redactor.redact(JSON.stringify(record)));
        } catch {
          return { role: record?.role ?? "note", content: "[REDACTED]" };
        }
      }
    })) {
      if ((line.stream === "event" || line.stream === "transcript") && referencesWithdrawn(line.record)) {
        // 普通导出过滤；audit 导出保留并显式标注
        if (audit) yield { ...line, record: { ...line.record, audit_only: true } };
        continue;
      }
      yield line;
    }
  }

  // 不可逆清空：只允许 session idle 且 confirmIrreversible === true（守卫在
  // journal 内、与其 mutex 串行）；成功后清空同一 journal 实例并立即创建新
  // generation + session_created。runtime 侧在项目互斥锁内调用，并清掉本项目的
  // per-Run 循环状态（runId/controller/loopPromise/firstTurn/catalogCache），
  // 保证 projects Map 里不留旧 session 的运行时状态——同一实例立即可用。
  async function clearHistory({ projectRoot, sessionId = null, confirmIrreversible = false } = {}) {
    if (typeof projectRoot !== "string" || projectRoot.length === 0) {
      throw fail("invalid_project_root", "projectRoot 必须是非空路径。");
    }
    const state = ensureProject(projectRoot);
    const sessionState = await resolveSessionState(state, sessionId);
    if (!sessionState) throw fail("session_not_found", "会话不存在。");
    await sessionState.journal.load();
    return state.mutex.run(async () => {
      const result = await sessionState.journal.clearHistory({ confirmIrreversible });
      // 项目级循环状态复位只针对「无飞行循环」或「飞行循环属于被清空的会话」：
      // journal 守卫只保证目标会话 idle，若另一会话 B 正在运行（串行门保证是唯一
      // 运行），无条件复位 state.controller/loopPromise 会让 B 失去可中断性，且
      // submit 的恢复路径会因 loopPromise 已空为同一 runId 启动第二个并发循环
      //（双重模型调用）。清空空闲会话历史不应被其他会话运行阻塞，也绝不清运行中
      // 会话的控制状态。
      const runInFlight = state.loopPromise != null;
      if (!runInFlight || state.loopSessionId === sessionState.sessionId) {
        state.runId = null;
        state.loopSessionId = null;
        state.controller = null;
        state.loopPromise = null;
        state.firstTurn = null;
        state.catalogCache = null;
        state.stopReason = "user_stop";
      }
      // 目标会话自身的校准只属于它，恒复位
      sessionState.contextCalibration = null;
      // 注册表同步（clearHistory 不经逐事件同步通道，这里显式 touch + lastSeq）
      await sessionManager.syncSessionRegistry(state, sessionState);
      return {
        session_id: result.session_id,
        status: result.status,
        generation_id: result.generation_id,
        old_session_id: result.old_session_id,
        cleared_dir: result.cleared_dir
      };
    });
  }

  // -------------------------------------------------------------------------
  // 对外组合：数据面与项目/会话物化（本模块）+ Run 命令面（run-control.mjs）
  // + 多会话管理 API（session-manager.mjs）。三方均无 this 依赖，直接引用等价于
  // 逐方法转发（Task 9/Task 18）。
  // -------------------------------------------------------------------------

  return {
    open,
    // Run 命令面（Task 18）：8 个方法由 run-control.mjs 提供，签名/错误 code 不变。
    submit: runControl.submit,
    requestPriority: runControl.requestPriority,
    withdrawInput: runControl.withdrawInput,
    decide: runControl.decide,
    stop: runControl.stop,
    retry: runControl.retry,
    retryCompaction: runControl.retryCompaction,
    cancelCompaction: runControl.cancelCompaction,
    snapshot,
    projectBusy,
    exportHistory,
    clearHistory,
    // 会话列表 + 最近活跃（dashboard 数据源，含 run_status 投影）。
    sessions: sessionManager.sessions,
    // 显式建会话（前端"+"按钮 / 对话 B 场景）。
    newSession: sessionManager.newSession,
    renameSession: sessionManager.renameSession,
    archiveSession: sessionManager.archiveSession,
    restoreSession: sessionManager.restoreSession,
    // 永久删除（Task 10 设置页）：注册表元数据 + 会话数据目录一并移除。
    deleteSession: sessionManager.deleteSession,
    // 第九轮：系统事件注入（UI 侧恢复操作在对话流中的可见性；run_id=null）。
    appendSystemEvent: sessionManager.appendSystemEvent
  };
}
