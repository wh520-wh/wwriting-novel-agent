// src/core/agent/runtime.mjs —— 编排内核（第十五轮波A收口后）。
//
// 深模块内部实现：生产调用方只能经 src/core/agent/index.mjs 使用；tests/agent/ 可以
// 测试本模块内部 seam。本文件只做编排：组合根注入 → 项目/会话物化（sessionState
// 组装 journal/tools/history/compaction/run-lifecycle/session-manager 域模块）→
// Run 循环编排（队列/安全点/收敛接线）；域职责见各模块头注释（run-lifecycle：
// 停止/优先切换/失败收束；session-manager：会话 CRUD；history-assembly：历史
// 装配；compaction：压缩状态机与源材料构建）。
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
  COMPACTION_RESUME_BLOCKED_STATES,
  COMPACTION_SEND_BLOCKED_STATES
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
import { createSessionManager, deriveSessionTitle, hasNonTerminalRun } from "./session-manager.mjs";

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

// Task 3：取消/停止语义的工具失败不触发「跳过同一响应后续调用」——这些结果由

// 统一工具目录（Task 7）：不再按工作流切换——每一轮都提供相同的生产工具集：
// 九个通用工具 + 六个深工具恒可用（Task 8：旧 blueprint 事务工具已整体删除，
// 不再有注册表残留）。
// Task 6：名单由 ToolRuntime 注册表派生（tools.toolNames()），不再维护独立常量。

// 第九轮：派生记忆提取器退役。commit/finalize/rollback 结果附加固定记忆维护
// 提醒（memory_checklist），记忆由模型自调用 update_memory 工具维护。
const MEMORY_CHECKLIST = "记忆维护：请依次 update_memory（含新埋（open）与回收（paid）的伏笔） → 更新 book_summary.md → 更新 WORKLOG.md";
const withMemoryChecklist = (result) => ({ ...(result ?? {}), memory_checklist: MEMORY_CHECKLIST });

const SOURCES = new Set(["chat", "maintenance"]);

// Task 9（F5c 第十五轮）：会话标题派生、注册表同步、自动命名与删除守卫
//（deriveSessionTitle/syncSessionRegistry/autoNameSessionIfDefault/
// hasNonTerminalRun/requireSessionId）已随会话 CRUD 拆到 session-manager.mjs——
// runtime 经 sessionManager 实例调用（12 个同步点 + 1 个自动命名点），
// deriveSessionTitle 由惰性创建路径（submit 隐式建会话）继续消费。

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
    const key = path.resolve(projectRoot);
    let state = projects.get(key);
    if (!state) {
      // Task 4：agentRoot 即应用的私有 agent storage root；每会话的 journal/
      // checkpoint 落在 <agentRoot>/sessions/<id>/ 下（ensureSessionState）。
      const agentRoot = agentStorageRootFor(key);
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
        key,
        agentRoot,
        // Task 4：会话注册表（<agentRoot>/sessions/index.json）+ 每会话运行状态
        registry: createSessionRegistry({ root: agentRoot }),
        sessions: new Map(), // sessionId -> sessionState（ensureSessionState 惰性物化）
        projectOperations,
        modelGateway: resolveGateway(key),
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
              const { active } = await projectSkills.catalog({ projectRoot: key });
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
      findInputMeta,
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
  // 实例与 ensureProject 等每项目基础设施并列创建（最早使用点 :1488 之前）；
  // 内部 13 个同步/命名调用点（sessionManager.xxx）与公共 API 单行委托
  // （index.mjs 转发链零改动）。函数设计注释随逻辑迁入新模块。
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

  function abortController(state) {
    try {
      state.controller?.abort();
    } catch {
      // 已终止的 controller 忽略
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

  // 从 journal 事件找回输入元数据（text + kind）。上限语义同 findInputText：
  // 只扫描最近 100k 条事件；超出上限视为找不到（返回 text: null）。
  // Task 3（第十五轮）：扫描逻辑迁入 journal.findInputMeta，此处薄委托。
  async function findInputMeta(journal, inputId) {
    return journal.findInputMeta(inputId);
  }

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

  async function submit({ projectRoot, text, source = "chat", sessionId = null }) {
    if (typeof projectRoot !== "string" || projectRoot.length === 0) {
      throw fail("invalid_project_root", "projectRoot 必须是非空路径。");
    }
    if (typeof text !== "string" || text.trim().length === 0) {
      throw fail("empty_input", "text 必须是非空字符串。");
    }
    if (!SOURCES.has(source)) {
      throw fail("invalid_source", `source 只允许 ${[...SOURCES].join("/")}，仅用于审计来源。`);
    }
    const state = ensureProject(projectRoot);
    // Task 8：只把精确的 text === "/compact" 识别为 kind:"compact"；"/compact now"
    // 等其余文本都是普通输入。
    const kind = text === "/compact" ? "compact" : undefined;
    // 互斥锁内只做会话解析、串行门、读-判-写与循环启动；waitForFirstTurn 必须在
    // 锁外等待（循环的安全点路径 cancelRunForStop/advanceOrComplete 需要取同一把
    // 锁，锁内等待会死锁）。sessionState 提升到函数级：锁外
    // lifecycle.waitForFirstTurn 需要持锁内物化的会话状态。
    let sessionState = null;
    const created = await state.mutex.run(async () => {
      // 1) 会话解析：显式 sessionId → 校验存在；缺省 → 最近活跃；都没有 → 惰性
      //    创建新会话（registry.create + journal 首次 load 写 session_created）。
      let targetId = await resolveSessionId(state, sessionId);
      // 2) 串行门：目标会话之外若有任一会话存在非终态 run → project_busy。
      //    惰性创建路径（targetId == null）下，所有已物化会话都算"其他会话"；
      //    目标会话尚未物化、不可能有 run。门禁在创建/恢复之前执行，被拒的提交
      //    不产生任何会话副作用。同会话运行中走下方 FIFO 队列（行为不变）。
      const blockers = await Promise.all(
        [...state.sessions]
          .filter(([sid]) => targetId == null || sid !== targetId)
          .map(async ([, other]) => other.journal.getSession())
      );
      if (blockers.some(hasNonTerminalRun)) {
        throw fail("project_busy", "另一个对话正在运行，请稍候。");
      }
      // 3) 惰性创建（缺省且无会话）
      if (targetId == null) {
        const meta = await state.registry.create({ title: deriveSessionTitle(text) });
        targetId = meta.session_id;
      }
      sessionState = await ensureSessionState(state, targetId);
      // 4) 恢复可恢复 Run（等价旧 submit → open() 的启动恢复）：非终态且未被压缩
      //    阻塞 → 接续执行（新输入在下方 FIFO 排队在其后）。串行门已保证没有
      //    其他会话的飞行循环，此处启动是安全的。
      const session = await sessionState.journal.getSession();
      const run = session.active_run;
      const compactionBlocked =
        session.compaction != null && COMPACTION_SEND_BLOCKED_STATES.includes(session.compaction.state);
      // whfind-bugs #5：压缩 failed 态循环不会复活（下方守卫跳过重启），此时
      // 排队输入没有消费者、返回 queued:true 是谎言——诚实拒绝。UI composer 在
      // 这些状态本就禁用发送，只影响直连 API 客户端；running/cancelling 等活跃
      // 态不拦（循环存活，压缩完成后继续消费队列）。
      if (session.compaction?.state === "failed") {
        throw fail("compaction_failed_blocked", "上下文压缩失败：请先重试或取消压缩，再发送新消息。");
      }
      if (run && !TERMINAL_RUN_STATUSES.has(run.status) && !compactionBlocked) {
        sessionState.lifecycle.startLoop(run.id);
      }
      // 5) 现有 FIFO / 新 Run 逻辑（作用于目标会话的 journal）
      const inputId = idFactory();
      let result;
      if (!run || TERMINAL_RUN_STATUSES.has(run.status)) {
        // 空闲：创建新 Run。同一批次原子写入 run_started + input_queued +
        // input_started（Task 9 新生命周期：run_started 不再携带 input_id，由
        // input_started 激活；三者同批保证「每条输入一个终态」与队列/活动投影一致）。
        const runId = idFactory();
        await sessionState.journal.appendBatch([
          {
            type: "run_started",
            run_id: runId,
            payload: {}
          },
          {
            type: "input_queued",
            payload: { input_id: inputId, text, source, ...(kind === undefined ? {} : { kind }) }
          },
          {
            type: "input_started",
            run_id: runId,
            payload: { input_id: inputId }
          }
        ]);
        sessionState.lifecycle.startLoop(runId);
        result = { input_id: inputId, run_id: runId, queued: false, session_id: targetId };
      } else {
        // 运行中：FIFO 队列（/compact 不打断当前模型/工具，按普通消息排队）
        await sessionState.journal.append({
          type: "input_queued",
          payload: { input_id: inputId, text, source, ...(kind === undefined ? {} : { kind }) }
        });
        result = { input_id: inputId, run_id: run.id, queued: true, session_id: targetId };
      }
      // 注册表同步（调用方可等待的边界；updated_at 刷新）+ 自动命名：显式创建
      // （"新对话"默认标题）的会话按首条消息摘要命名
      await sessionManager.syncSessionRegistry(state, sessionState);
      await sessionManager.autoNameSessionIfDefault(state, targetId, text);
      return result;
    });
    if (!created.queued) {
      // 等待第一个模型轮次开始（或循环已结束）：保证调用方拿到控制权时
      // 「立即」/「停止」有飞行中的活动可打断（输入落盘仍先于 resolve）
      await sessionState.lifecycle.waitForFirstTurn();
    }
    return created;
  }

  // 请求优先（Task 9，SPEC 3.3 rule 10）：同一 session 项目互斥锁内做
  // getSession -> validate -> appendBatch。只接受排队输入且当前无优先请求：
  //   - 非排队输入 → input_not_queued（reducer 还有第二道守卫）；
  //   - 已有优先输入在途 → priority_pending（在途输入撤回或开始后才可再请求）。
  // 本任务只追加 priority_input_requested（priority_input_id 投影 + 前端按钮态）；
  // 安全点切换逻辑（打断活动输入、优先消费）由 Task 10 实现。
  // Task 26：旧 promote 方法（interrupt_requested + input_promoted 立即打断、被打断
  // 输入回队重跑）已整体退役——前端「立即」= requestPriority，规格 3.3 明确「不取消
  // 当前模型请求、A 不回队不重跑」，一条用户动作一条权威路径。
  async function requestPriority({ projectRoot, inputId, sessionId = null }) {
    if (typeof inputId !== "string" || inputId.length === 0) {
      throw fail("invalid_input_id", "inputId 必须是非空字符串。");
    }
    const state = ensureProject(projectRoot);
    const sessionState = await resolveSessionState(state, sessionId);
    if (!sessionState) throw fail("input_not_queued", "该输入不在排队队列中。");
    await sessionState.journal.load();
    return state.mutex.run(async () => {
      const session = await sessionState.journal.getSession();
      const run = session.active_run;
      if (!session.queued_inputs.some((item) => item.id === inputId)) {
        throw fail("input_not_queued", "该输入不在排队队列中。");
      }
      if (session.priority_input_id != null) {
        throw fail("priority_pending", "已有优先输入在途，请等待当前优先输入开始或撤回。");
      }
      await sessionState.journal.append({
        type: "priority_input_requested",
        run_id: run?.id ?? null,
        payload: { input_id: inputId }
      });
      await sessionManager.syncSessionRegistry(state, sessionState);
      return {
        session_id: sessionState.sessionId,
        run_id: run?.id ?? null,
        input_id: inputId,
        priority_pending: true
      };
    });
  }

  // 撤回排队输入（Task 9，SPEC 3.2）：同一 session 项目互斥锁内读-判-写。只接受
  // 排队输入——活动输入只能 completed/interrupted（不产生"撤销"语义）；input_started
  // 已落盘的输入同样拒绝（撤回先于开始才生效）。追加 input_withdrawn（invisible
  // journal 事件：投影移除排队项、清空匹配的 priority_input_id），返回事件中的
  // 原始文本（draft_text）供 UI 恢复输入框。
  async function withdrawInput({ projectRoot, inputId, sessionId = null }) {
    if (typeof inputId !== "string" || inputId.length === 0) {
      throw fail("invalid_input_id", "inputId 必须是非空字符串。");
    }
    const state = ensureProject(projectRoot);
    const sessionState = await resolveSessionState(state, sessionId);
    if (!sessionState) throw fail("input_not_queued", "该输入不在排队队列中。");
    await sessionState.journal.load();
    return state.mutex.run(async () => {
      const session = await sessionState.journal.getSession();
      const run = session.active_run;
      const item = session.queued_inputs.find((queued) => queued.id === inputId);
      if (!item) {
        throw fail("input_not_queued", "该输入不在排队队列中。");
      }
      await sessionState.journal.append({
        type: "input_withdrawn",
        run_id: run?.id ?? null,
        payload: { input_id: inputId }
      });
      await sessionManager.syncSessionRegistry(state, sessionState);
      return {
        session_id: sessionState.sessionId,
        run_id: run?.id ?? null,
        input_id: inputId,
        withdrawn: true,
        draft_text: typeof item.text === "string" ? item.text : ""
      };
    });
  }

  async function decide({ projectRoot, decisionId, choice, sessionId = null }) {
    if (typeof decisionId !== "string" || decisionId.length === 0) {
      throw fail("invalid_decision_id", "decisionId 必须是非空字符串。");
    }
    if (typeof choice !== "string" || choice.length === 0) {
      throw fail("invalid_choice", "choice 必须是非空字符串。");
    }
    const state = ensureProject(projectRoot);
    const sessionState = await resolveSessionState(state, sessionId);
    if (!sessionState) throw fail("decision_not_found", "决策不存在或已过期。");
    await sessionState.journal.load();
    return sessionState.tools.resolveDecision({ decisionId, choice, confirmationText: choice });
  }

  // 停止（Task 9）：runId 可选。显式 runId 时在项目互斥锁内重读并精确匹配活动
  // Run（不匹配/无活动 Run → run_not_found，HTTP 层不再用快照预校验——消除 B15
  // TOCTOU：调用顺序由持久事件顺序唯一决定）；缺省 runId 保留旧语义（停止当前
  // 会话的活动 Run，无 Run 时安全无操作）。
  async function stop({ projectRoot, runId = null, reason = "user_stop", sessionId = null }) {
    if (runId != null && (typeof runId !== "string" || runId.length === 0)) {
      throw fail("invalid_run_id", "runId 必须是非空字符串。");
    }
    const state = ensureProject(projectRoot);
    // 会话解析 + 读-判-写放进项目互斥锁，与 requestPriority 的临界区串行化：调用
    // 顺序决定胜负——stop 先落盘时其 input_cancelled 把优先输入移出队列，后到的
    // requestPriority 以 input_not_queued 拒绝（新测试「stop 与 requestPriority
    // 并发」钉住同一竞态）；requestPriority 先落盘时 stop 的取消批次清空匹配的
    // priority_input_id（reducer 的 input_cancelled 分支），不留卡死指针。
    const outcome = await state.mutex.run(async () => {
      const sessionState = await resolveSessionState(state, sessionId);
      if (!sessionState) {
        // 没有会话：显式 runId 必须报 not_found；缺省 = 旧语义安全无操作
        if (runId != null) throw fail("run_not_found", `Run ${runId} 不是当前会话的活动 Run。`);
        return { run_id: null, cancelled: false, sessionState: null };
      }
      await sessionState.journal.load();
      const session = await sessionState.journal.getSession();
      const run = session.active_run;
      if (!run || TERMINAL_RUN_STATUSES.has(run.status)) {
        if (runId != null) throw fail("run_not_found", `Run ${runId} 不是当前会话的活动 Run。`);
        return { run_id: null, cancelled: false, sessionState }; // 没有可停止的 Run：无操作
      }
      if (runId != null && run.id !== runId) {
        throw fail("run_not_found", `Run ${runId} 不是当前会话的活动 Run。`);
      }
      if (run.status === "stopping") {
        return { run_id: run.id, cancelled: true, sessionState, alreadyStopping: true };
      }
      try {
        await sessionState.journal.append({
          type: "run_status_changed",
          run_id: run.id,
          payload: { status: "stopping", reason }
        });
      } catch (error) {
        // 竞态：Run 恰在此时终结，停止自然失效（reducer 拒绝终结状态上的
        // run_status_changed）；真实 journal 错误由外层 .catch abort + 上抛。
        const message = error?.message ?? "";
        if (message.includes("需要活动 Run") || message.includes("必须携带 retry") || message.includes("不能再次进入")) {
          if (runId != null) throw fail("run_not_found", `Run ${runId} 不是当前会话的活动 Run。`);
          return { run_id: run.id, cancelled: false, sessionState };
        }
        throw error;
      }
      state.stopReason = reason;
      return { run_id: run.id, cancelled: true, sessionState };
    }).catch((error) => {
      // mutex.run 内已对可识别竞态返回；这里的 reject 是真实 journal 错误
      abortController(state);
      throw error;
    });
    // 锁外：abort + 等待收敛（循环的安全点路径 cancelRunForStop 需要取同一把锁，
    // 锁内等待会死锁）
    if (!outcome.cancelled) {
      return { session_id: outcome.sessionState?.sessionId ?? null, run_id: outcome.run_id ?? null, cancelled: false };
    }
    const { sessionState } = outcome;
    if (outcome.alreadyStopping) {
      await sessionState.lifecycle.waitForIdle();
      return { session_id: sessionState.sessionId, run_id: outcome.run_id, cancelled: true };
    }
    abortController(state);
    await sessionState.lifecycle.waitForIdle();
    await sessionManager.syncSessionRegistry(state, sessionState);
    return { session_id: sessionState.sessionId, run_id: outcome.run_id, cancelled: true };
  }

  // 从 journal 事件找回可恢复 Run 的未终结输入（run_failed 记录了 input_id；
  // 崩溃恢复的 run_interrupted 没有，则退回 run_started/input_promoted 的信息）。
  // Task 3（第十五轮）：扫描逻辑迁入 journal.findTerminalInputId，此处薄委托。
  async function findTerminalInputId(journal, runId) {
    return journal.findTerminalInputId(runId);
  }

  async function retry({ projectRoot, runId, sessionId = null }) {
    if (typeof runId !== "string" || runId.length === 0) {
      throw fail("invalid_run_id", "runId 必须是非空字符串。");
    }
    const state = ensureProject(projectRoot);
    const sessionState = await resolveSessionState(state, sessionId);
    if (!sessionState) throw fail("run_not_found", "没有可恢复的 Run。");
    await sessionState.journal.load();
    return state.mutex.run(async () => {
      const session = await sessionState.journal.getSession();
      const run = session.active_run;
      if (!run) throw fail("run_not_found", "没有可恢复的 Run。");
      if (run.id !== runId) throw fail("run_not_found", `Run ${runId} 不是当前会话的 Run。`);
      if (!TERMINAL_RUN_STATUSES.has(run.status)) {
        throw fail("run_not_recoverable", `Run 处于 ${run.status}，无需重试。`);
      }
      if (run.status !== "failed" && run.status !== "interrupted") {
        throw fail("run_not_recoverable", `只有 failed/interrupted 的 Run 可以重试，当前为 ${run.status}。`);
      }
      let inputId = await findTerminalInputId(sessionState.journal, runId);
      if (inputId === null) {
        // 兜底：以 transcript 最近一条用户消息重建输入（崩溃现场无 input 记录）
        const records = await sessionState.journal.readTranscript();
        const lastUser = [...records].reverse().find((record) => record?.role === "user");
        inputId = idFactory();
        await sessionState.journal.append({
          type: "input_queued",
          payload: { input_id: inputId, text: String(lastUser?.content ?? "继续执行") }
        });
      }
      await sessionState.journal.append({
        type: "run_started",
        run_id: runId,
        payload: { input_id: inputId }
      });
      await sessionManager.syncSessionRegistry(state, sessionState);
      sessionState.lifecycle.startLoop(runId);
      return { run_id: runId, input_id: inputId, retried: true };
    });
  }

  // 压缩重试（Task 8 Step 7）：继续同一 compaction_id 的新 attempt。只允许
  // failed/cancelled（取消后 pending input 仍在时）状态；成功后原输入只继续一次
  //（输入写回 transcript 前的收敛由 runLoop/processInput 处理，绝不让旧
  // processInput 自动再次执行）。ESC/按钮/HTTP 与 cancelCompaction 复用同一
  // AbortSignal 链。
  async function retryCompaction({ projectRoot, compactionId, sessionId = null }) {
    if (typeof compactionId !== "string" || compactionId.length === 0) {
      throw fail("invalid_compaction_id", "compactionId 必须是非空字符串。");
    }
    const state = ensureProject(projectRoot);
    const sessionState = await resolveSessionState(state, sessionId);
    if (!sessionState) throw fail("compaction_not_found", `compaction ${compactionId} 不存在。`);
    const session = await sessionState.journal.getSession();
    const compaction = session.compaction;
    if (!compaction || compaction.id !== compactionId) {
      throw fail("compaction_not_found", `compaction ${compactionId} 不存在。`);
    }
    if (compaction.state === "completed" || compaction.state === "noop") {
      throw fail("compaction_not_retryable", `压缩已${compaction.state === "completed" ? "完成" : "无需压缩"}，无法重试。`);
    }
    if (compaction.state === "started" || compaction.state === "running" || compaction.state === "cancelling") {
      throw fail("compaction_in_flight", "压缩正在进行中，无法重试。");
    }
    const run = session.active_run;
    if (!run || TERMINAL_RUN_STATUSES.has(run.status)) {
      throw fail("compaction_no_run", "当前没有可继续压缩的 Run。");
    }
    const outcome = await sessionState.compactionCoordinator.retry({
      compactionId,
      signal: state.controller?.signal
    });
    if (outcome.status === "completed" || outcome.status === "noop") {
      // 恢复 Run 为 running 并重启循环。手动 /compact 的 retry 成功后 compact
      // item 已达成目的（input_completed 收敛，绝不重复启动第二次压缩）；自动压缩
      // 的 retry 成功后原 pending input 由 processInput 继续（压缩成功后预检低于
      // 硬窗口直接发送；仍超阈值因已尝试不再重复压缩）。retry 重建源后无可压缩
      // 历史（noop）视为等价成功——输入照常继续，由 processInput 重新预检。
      await state.mutex.run(async () => {
        const s = await sessionState.journal.getSession();
        const r = s.active_run;
        if (r && r.id === run.id && !TERMINAL_RUN_STATUSES.has(r.status) && r.status !== "running") {
          await sessionState.journal.append({
            type: "run_status_changed",
            run_id: run.id,
            payload: { status: "running", reason: "compaction_retried" }
          });
        }
        if (compaction.trigger === "manual") {
          const s2 = await sessionState.journal.getSession();
          const r2 = s2.active_run;
          if (r2 && r2.id === run.id && !TERMINAL_RUN_STATUSES.has(r2.status)) {
            // compact item 是活动输入（失败后保持 active、无终态）；Task 26 以
            // input_completed 收敛（旧 input_consumed 退役），守卫同 processCompact。
            if (r2.active_input_id !== compaction.pending_input_id) return;
            await sessionState.journal.append({
              type: "input_completed",
              run_id: run.id,
              payload: { input_id: compaction.pending_input_id }
            });
          }
        }
      });
      sessionState.lifecycle.startLoop(run.id);
      await sessionManager.syncSessionRegistry(state, sessionState);
      return { status: "completed", compaction_id: compactionId, attempt: outcome.attempt };
    }
    if (outcome.status === "failed") {
      // 仍失败：Run 保持 waiting_user，发送门禁保持禁用（熔断后只等用户再次 retry/cancel）
      const s = await sessionState.journal.getSession();
      const r = s.active_run;
      if (r && r.id === run.id && !TERMINAL_RUN_STATUSES.has(r.status) && r.status !== "waiting_user") {
        await sessionState.journal.append({
          type: "run_status_changed",
          run_id: run.id,
          payload: { status: "waiting_user", reason: "compaction_failed", error_code: outcome.error_code ?? null }
        });
      }
      await sessionManager.syncSessionRegistry(state, sessionState);
      return { status: "failed", compaction_id: compactionId, attempt: outcome.attempt, error_code: outcome.error_code };
    }
    // cancelled（ESC 中断重试）：取消收敛（input_cancelled + run_cancelled / 恢复）
    const compactionNow = (await sessionState.journal.getSession()).compaction;
    await sessionState.lifecycle.convergeCompactionCancelled(compactionNow);
    await sessionManager.syncSessionRegistry(state, sessionState);
    return { status: "cancelled", compaction_id: compactionId };
  }

  // 压缩取消（Task 8 Step 7）：ESC、按钮与 HTTP 取消都调用本方法，复用当前
  // project state 的 AbortController（不创建第二套进程终止协议）。running 时
  // 先进入 cancelling（cancel_requested），底层确认终止后追加 cancelled，随后
  // 按触发来源收敛 Run/input（自动 → input_cancelled + run_cancelled，文本回
  // draft；手动 → input_cancelled + 恢复 resume_run_status 或 idle）。
  async function cancelCompaction({ projectRoot, compactionId, sessionId = null }) {
    if (typeof compactionId !== "string" || compactionId.length === 0) {
      throw fail("invalid_compaction_id", "compactionId 必须是非空字符串。");
    }
    const state = ensureProject(projectRoot);
    const sessionState = await resolveSessionState(state, sessionId);
    if (!sessionState) throw fail("compaction_not_found", `compaction ${compactionId} 不存在。`);
    await sessionState.journal.load();
    const session = await sessionState.journal.getSession();
    const compaction = session.compaction;
    if (!compaction || compaction.id !== compactionId) {
      throw fail("compaction_not_found", `compaction ${compactionId} 不存在。`);
    }
    const outcome = await sessionState.compactionCoordinator.cancel({ compactionId });
    const compactionNow = (await sessionState.journal.getSession()).compaction;
    // I5：取消请求与提交竞态——coordinator 报告实际终态（或会话投影已是 completed）
    // 时，压缩确实成功（指针已切换、completed 已落盘），原输入由 runLoop 继续，
    // 绝不把成功压缩收敛成 input_cancelled + run_cancelled（UI 不得显示"已取消"
    // 覆盖已切换的上下文）。
    if (outcome?.status === "completed" || outcome?.state === "completed") {
      await sessionManager.syncSessionRegistry(state, sessionState);
      return {
        status: "completed",
        compaction_id: compactionId,
        checkpoint_id: outcome?.checkpoint_id ?? compactionNow?.checkpoint_id ?? null
      };
    }
    await sessionState.lifecycle.convergeCompactionCancelled(compactionNow);
    await sessionManager.syncSessionRegistry(state, sessionState);
    return { status: "cancelled", compaction_id: compactionId };
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
  // Task 4：多会话管理 API（Task 9 F5c 第十五轮：全部委托 session-manager；
  // 实例创建见 resolveSessionState 之后）
  // -------------------------------------------------------------------------

  // 会话列表 + 最近活跃（dashboard 数据源，含 run_status 投影）。
  async function sessions({ projectRoot }) {
    return sessionManager.sessions({ projectRoot });
  }

  // 显式建会话（前端"+"按钮 / 对话 B 场景）。
  async function newSession({ projectRoot, title }) {
    return sessionManager.newSession({ projectRoot, title });
  }

  async function renameSession({ projectRoot, sessionId, title }) {
    return sessionManager.renameSession({ projectRoot, sessionId, title });
  }

  async function archiveSession({ projectRoot, sessionId }) {
    return sessionManager.archiveSession({ projectRoot, sessionId });
  }

  async function restoreSession({ projectRoot, sessionId }) {
    return sessionManager.restoreSession({ projectRoot, sessionId });
  }

  // 永久删除（Task 10 设置页）：注册表元数据 + 会话数据目录一并移除。
  async function deleteSession({ projectRoot, sessionId }) {
    return sessionManager.deleteSession({ projectRoot, sessionId });
  }

  // 第九轮：系统事件注入（UI 侧恢复操作在对话流中的可见性；run_id=null）。
  async function appendSystemEvent({ projectRoot, type, payload }) {
    return sessionManager.appendSystemEvent({ projectRoot, type, payload });
  }

  return {
    open,
    submit,
    requestPriority,
    withdrawInput,
    decide,
    stop,
    retry,
    retryCompaction,
    cancelCompaction,
    snapshot,
    exportHistory,
    clearHistory,
    sessions,
    newSession,
    renameSession,
    archiveSession,
    restoreSession,
    deleteSession,
    appendSystemEvent
  };
}
