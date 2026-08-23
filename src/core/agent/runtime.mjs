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
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { buildProcessRestartedConvergence, createAgentJournal, persistentToolResult, TERMINAL_RUN_STATUSES } from "./journal.mjs";
import { createSessionRegistry } from "./session-registry.mjs";
import { createToolRuntime } from "./tools/index.mjs";
import { assemblePrompt } from "./prompt.mjs";
import {
  estimateRequestUsage,
  observeProviderUsage,
  shouldCompact,
  exceedsHardWindow
} from "./context-window.mjs";
import { createContextCheckpointStore } from "./context-checkpoints.mjs";
import {
  buildCompactionSource,
  createCompactionCoordinator,
  COMPACTION_NON_TERMINAL_STATES,
  COMPACTION_RESUME_BLOCKED_STATES,
  COMPACTION_SEND_BLOCKED_STATES
} from "./compaction.mjs";
// Task 7（F5a）：历史装配层拆到 history-assembly.mjs——HISTORY_PAGE_LIMIT 以
// 本模块为单一来源；Task 10（F5d）buildCompactionSource 迁入 compaction.mjs 后，
// 纯转换函数（buildTurnsFromTranscript/transcriptToMessages/collectOpenToolCalls/
// summarizeLargeToolMessages）由该模块直接 import，此处不再转发。
import {
  HISTORY_PAGE_LIMIT,
  createHistoryAssembly,
  degradeVolatileToolRecords
} from "./history-assembly.mjs";
import { loadProject, loadChapterIndex } from "../project-store.mjs";
import { pathExists } from "../fs-utils.mjs";
import { createMutex } from "../async-utils.mjs";
import { readProjectMemory } from "../project-memory.mjs";
import { createRedactor } from "../shell/redaction.mjs";
import { resolveModelCapabilities } from "../model/capabilities.mjs";
import { resolveModelLimits } from "../model/model-identity.mjs";
import { createJournalDeltaWriter, reasoningAvailability } from "./stream-writer.mjs";
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
import { migrateBaselineVersions } from "../project-operations/versions.mjs";
import { detectLedgerDrift } from "../ledger-drift.mjs";
import { codedError as fail } from "./agent-utils.mjs";
// Task 8（F5b 第十五轮）：Run 收敛状态机（停止/优先切换/失败收束/循环推进与
// 等待）拆到 run-lifecycle.mjs——经 createRunLifecycle(ctx) 以 getter 注入
// state/sessionState，runtime.mjs 恢复为编排内核。
import { createRunLifecycle } from "./run-lifecycle.mjs";
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
// 停止/中断路径以 tool_cancelled 统一闭合（stop 与 requestPriority 并发测试钉住
// 该顺序），只有真实领域失败才把未启动的后续调用闭合为 tool_skipped_after_failure。
const TOOL_RESULT_CANCELLATION_CODES = new Set(["tool_cancelled", "shell_cancelled"]);

// 统一工具目录（Task 7）：不再按工作流切换——每一轮都提供相同的生产工具集：
// 八个通用工具 + 六个深工具恒可用（Task 8：旧 blueprint 事务工具已整体删除，
// 不再有注册表残留）。
// Task 6：名单由 ToolRuntime 注册表派生（tools.toolNames()），不再维护独立常量。

// 第九轮：派生记忆提取器退役。commit/finalize/rollback 结果附加固定记忆维护
// 提醒（memory_checklist），记忆由模型自调用 update_memory 工具维护。
const MEMORY_CHECKLIST = "记忆维护：请依次 update_memory → 更新 book_summary.md → 更新 WORKLOG.md";
const withMemoryChecklist = (result) => ({ ...(result ?? {}), memory_checklist: MEMORY_CHECKLIST });

const SOURCES = new Set(["chat", "maintenance"]);

const ASSISTANT_DELTA_FLUSH_MS = 24;
const ASSISTANT_DELTA_MAX_PENDING_CHARS = 2048;

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
        updateMemoryFromExtraction
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
      appendSafeTranscript,
      isCompactRunIdleInitiated,
      resetController,
      findInputMeta,
      processCompact,
      processInput
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

  // 首次"活动"信号：普通模型轮次（model_turn_started）与压缩调用（Task 8）都
  // 算作 Run 的第一个活动——submit 等待它拿到控制权（「立即」/「停止」需要
  // 飞行中的活动可打断）。
  function resolveFirstTurnIfPending(state) {
    if (state.firstTurn && !state.firstTurn.resolved) {
      state.firstTurn.resolved = true;
      state.firstTurn.resolve();
    }
  }

  // -------------------------------------------------------------------------
  // 模型/工具循环
  // -------------------------------------------------------------------------

  // 从 journal 事件里找回输入元数据（text + kind；findInputMeta 见 Task 8）。
  // 上限语义（Task 6 规格审查 Minor）：只扫描最近 100k 条事件；超出上限的输入
  // 视为找不到（返回 null，runLoop 对该输入做消费跳过）——长会话场景应由 UI 分页
  // 与历史压缩避免依赖无限回溯。
  async function readProjectInstructions(projectRoot) {
    try {
      const target = path.join(projectRoot, "AGENTS.md");
      if (!(await pathExists(target))) return "";
      const text = await fs.readFile(target, "utf8");
      return typeof text === "string" ? text : "";
    } catch {
      return "";
    }
  }

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

  function permissionModeOf(project) {
    const tp = project?.tool_permissions ?? {};
    if (tp.yolo === true) return "yolo";
    if (tp.auto_edit === true) return "trusted";
    return "ask";
  }

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

  // 落盘脱敏与 transcript 写入归位 journal（第十五轮 Task 4）：appendSafeTranscript
  // 已是 journal 工厂方法（脱敏实现由 createAgentJournal 的 redactText 注入），
  // 此处保留薄委托，既有调用点（appendSafeTranscript(journal, record)）零改动。
  async function appendSafeTranscript(journal, record) {
    await journal.appendSafeTranscript(record);
  }

  // 按统一工具目录过滤定义（Task 6：名单派生自 ToolRuntime 注册表——注册表即
  // 生产工具集的唯一权威来源，每轮相同）。当前 definitions() 与 toolNames()
  // 同源于同一注册表，Set 过滤是恒真校验；保留为防未来注册表与暴露集分叉的守卫。
  function allowedDefinitions(tools) {
    const allowed = new Set(tools.toolNames());
    return tools
      .definitions()
      .filter((definition) => allowed.has(definition?.function?.name));
  }

  // 追加用户消息到 transcript（retry 去重：同一 input 只出现一次）。
  async function ensureUserMessageInTranscript(journal, inputId, inputText) {
    const records = await journal.readTranscript();
    if (records.some((record) => record.input_id === inputId)) return;
    await appendSafeTranscript(journal, { role: "user", content: inputText, input_id: inputId });
  }

  // Task 2/9 冻结语义：每条 input 恰好一个终态事件。
  //   - 新生命周期（Task 9 起 submit/withdraw 路径）：input_queued → input_started →
  //     input_completed | input_interrupted（终态），input_queued → input_withdrawn
  //     （终态）；input_started 只激活、不终结，完成时才需要追加 input_completed。
  //   - legacy 兼容（Task 26 起仅回放旧日志时生效）：旧 input_consumed「切换激活」
  //     同时就是该输入的终态事件，完成时不再追加；input_promoted/run_started
  //     （retry）激活的输入完成时需要收敛。新 generation 不再产生这些旧事件，
  //     本分支只服务历史 journal 重放。
  // 返回当前输入完成时是否需要追加 input_completed。上限语义同 findInputText：
  // 只扫描最近 100k 条事件，超出视为需要收敛（保守方向）。
  // Task 3（第十五轮）：扫描逻辑迁入 journal.hasTerminalEvent，此处薄委托。
  async function needsCompletionTerminal(journal, runId, inputId) {
    return journal.hasTerminalEvent(runId, inputId);
  }

  // 从 journal 事件找回输入元数据（text + kind）。上限语义同 findInputText：
  // 只扫描最近 100k 条事件；超出上限视为找不到（返回 text: null）。
  // Task 3（第十五轮）：扫描逻辑迁入 journal.findInputMeta，此处薄委托。
  async function findInputMeta(journal, inputId) {
    return journal.findInputMeta(inputId);
  }

  // 该 Run 是否为 /compact 输入而创建（空闲发起）还是运行中排队（in-run）。
  // 决定手动压缩失败/取消后的收敛：in-run 恢复 resume_run_status("running")，
  // 空闲发起则 run_cancelled → idle。
  // Task 9：新生命周期下 run_started 不再携带 input_id，改为以该 Run 的第一条
  // input_started 判定（空闲发起 = Run 首个被激活输入就是 compact item）；legacy
  // 日志（retry 的 run_started 仍带 input_id）保留原判定分支。
  // Task 3（第十五轮）：扫描逻辑迁入 journal.isIdleInitiatedRun，此处薄委托。
  async function isCompactRunIdleInitiated(state, sessionState, runId, compactInputId) {
    return sessionState.journal.isIdleInitiatedRun(runId, compactInputId);
  }

  // 手动 /compact 处理（在安全点由 runLoop 调用，active_input_id 已是 compact
  // item）。返回 "compacted" | "compaction_blocked" | "compaction_resumed" |
  // "interrupted"。
  async function processCompact(state, sessionState, runId, inputId) {
    const session = await sessionState.journal.getSession();
    const run = session.active_run;
    if (!run || run.id !== runId || TERMINAL_RUN_STATUSES.has(run.status)) return "compaction_blocked";
    const project = await resolveWorkspaceConfig(state.key);
    const modelConfig = modelConfigOf(project);
    const idleInitiated = await isCompactRunIdleInitiated(state, sessionState, runId, inputId);
    // 相同队列中后续重复 /compact：输入安全点取消（duplicate_compact），避免
    // 连续无意义压缩（spec §5.5）。系统级丢弃排队项用 input_cancelled（Task 26
    // 语义收窄：无对应新生命周期事件，同 stop/压缩取消路径的保留理由）。
    await state.mutex.run(async () => {
      const s = await sessionState.journal.getSession();
      const r = s.active_run;
      if (!r || r.id !== runId || TERMINAL_RUN_STATUSES.has(r.status)) return;
      const laterDuplicates = s.queued_inputs.filter((item) => item.kind === "compact");
      if (laterDuplicates.length > 0) {
        await sessionState.journal.appendBatch(
          laterDuplicates.map((item) => ({
            type: "input_cancelled",
            run_id: runId,
            payload: { input_id: item.id, reason: "duplicate_compact" }
          }))
        );
      }
    });
    // 先构建源材料做 noop 预检（无可压缩历史则不调用模型）
    const built = await buildCompactionSource({
      journal: sessionState.journal,
      checkpointStore: sessionState.checkpointStore,
      resolveWorkspaceConfig,
      modelConfigOf,
      sourceCheckpointId: null,
      trigger: "manual",
      modelConfig,
      projectRoot: state.key
    });
    if (built.noop) {
      // 无可压缩历史：noop 事件统一由协调器落盘（压缩事件只有一个写作者），
      // 随后收敛该 /compact 输入（不调用模型）。Task 26：/compact 服从同一输入
      // 生命周期（规格 3.2），成功收敛用 input_completed（旧 input_consumed 退役）。
      await sessionState.compactionCoordinator.noop({ trigger: "manual", reason: built.reason ?? "nothing_to_compact" });
      await state.mutex.run(async () => {
        const s = await sessionState.journal.getSession();
        const r = s.active_run;
        if (!r || r.id !== runId || TERMINAL_RUN_STATUSES.has(r.status)) return;
        // input_completed reducer 只接受活动输入：压缩期间无任何路径能切换活动
        // 输入（stop 已按终态跳过），此守卫是防止异常竞态把 reducer 校验打成
        // 致命错误的防御层。
        if (r.active_input_id !== inputId) return;
        await sessionState.journal.append({
          type: "input_completed",
          run_id: runId,
          payload: { input_id: inputId }
        });
      });
      return "compacted";
    }
    resolveFirstTurnIfPending(state);
    const outcome = await sessionState.compactionCoordinator.start({
      projectRoot: state.key,
      trigger: "manual",
      pendingInputId: inputId,
      modelConfig,
      signal: state.controller?.signal
    });
    if (outcome.status === "completed") {
      await state.mutex.run(async () => {
        const s = await sessionState.journal.getSession();
        const r = s.active_run;
        if (!r || r.id !== runId || TERMINAL_RUN_STATUSES.has(r.status)) return;
        // 守卫同 noop 分支（input_completed reducer 只接受活动输入；压缩期间无
        // 路径能切换活动输入，此守卫是防御异常竞态的兜底层）。
        if (r.active_input_id !== inputId) return;
        await sessionState.journal.append({ type: "input_completed", run_id: runId, payload: { input_id: inputId } });
      });
      return "compacted";
    }
    if (outcome.status === "failed") {
      // 手动 /compact 失败：compact queue item 无终态（可重试），Run → waiting_user
      // 并保存 resume_run_status。互斥锁内读-判-写：cancel 恰在此时收敛则跳过。
      await state.mutex.run(async () => {
        const s = await sessionState.journal.getSession();
        const r = s.active_run;
        if (r && r.id === runId && !TERMINAL_RUN_STATUSES.has(r.status) && r.status !== "waiting_user") {
          await sessionState.journal.append({
            type: "run_status_changed",
            run_id: runId,
            payload: {
              status: "waiting_user",
              reason: "compaction_failed",
              resume_run_status: idleInitiated ? null : "running",
              error_code: outcome.error_code ?? null
            }
          });
        }
      });
      resetController(state);
      return "compaction_blocked";
    }
    // cancelled
    const sessionNow = await sessionState.journal.getSession();
    const runNow = sessionNow.active_run;
    if (!runNow || runNow.id !== runId || TERMINAL_RUN_STATUSES.has(runNow.status)) return "compaction_blocked";
    if (runNow.status === "stopping" || runNow.status === "interrupting") {
      return "interrupted"; // 停止/立即路径负责收敛
    }
    const compactionProjection = (await sessionState.journal.getSession()).compaction;
    await sessionState.lifecycle.convergeCompactionCancelled(compactionProjection);
    if (idleInitiated) return "compaction_blocked";
    // 手动 in-run 取消：input_cancelled + 恢复 resume_run_status，队列继续消费
    return "compaction_resumed";
  }

  // 处理一个输入：模型轮次循环直到文本回复 / 中断 / 停止 / 失败。
  // 返回 "done" | "compaction_blocked" | "interrupted" | "stopped" | "failed"
  // | "terminated"。compaction_blocked 表示自动压缩失败/取消后 Run 已收敛为
  // waiting_user 或 cancelled，runLoop 必须显式处理（不继续循环、不 run_completed）。
  async function processInput(state, sessionState, runId, inputId, inputText) {
    const { journal, tools } = sessionState;
    const volatileToolRecords = [];
    // Task 8/9：用户 transcript append 只在「输入开始处理且即将调用模型」的唯一路径
    // 发生（下方 model turn 前的 ensureUserMessageInTranscript）——压缩成功只 continue，
    // 由下一轮预检通过后在同一路径写入。cancelled/failed 时输入保持 draft/可重试，
    // 不写入 transcript（queued/withdrawn 输入永不进入 transcript，Task 9 边界）。
    let compactionAttemptedForInput = false;
    let volatileDegradedForInput = false; // 第十一轮：volatile 降级每输入至多一次（防装配循环）
    let closedToolResult = false;

    while (true) {
      const session = await journal.getSession();
      const run = session.active_run;
      if (!run || run.id !== runId) return "terminated";
      if (TERMINAL_RUN_STATUSES.has(run.status)) return "terminated";
      if (run.status === "stopping") {
        await sessionState.lifecycle.cancelRunForStop(state.stopReason);
        return "stopped";
      }
      if (run.status === "interrupting" || state.controller?.signal.aborted) {
        await journal.append({ type: "interrupt_safe_point_reached", run_id: runId, payload: {} });
        resetController(state);
        return "interrupted";
      }

      // Task 10：优先安全点（下一次模型请求前）。点击「立即」发生在工具结果已
      // 完成、下一次模型请求尚未发出之间时，不再发当前输入的下一次模型请求，
      // 直接切换：旧输入 input_interrupted + 优先输入 input_started（同一批次）。
      if (await sessionState.lifecycle.switchToPriorityAtSafePoint(runId, inputId)) {
        return "interrupted";
      }

      // ---- 装配模型请求 ----
      const project = await resolveWorkspaceConfig(state.key);
      const modelConfig = modelConfigOf(project);
      // 设计 D3 版本库基线迁移（模块 C）：每轮模型请求装配前，对索引 completed 且
      // 正式文件存在的章节幂等种 baseline（只写 .versions/）。失败只记录维护级
      // 警告（如索引损坏），绝不阻塞本轮 run，也绝不触碰正文/索引/校验和。
      try {
        const index = await loadChapterIndex(state.key);
        await migrateBaselineVersions({ projectRoot: state.key, chapters: index.chapters ?? [] });
      } catch (migrationError) {
        console.warn(
          `[agent] 章节版本基线迁移失败（尽力而为）: ${migrationError?.message ?? String(migrationError)}`
        );
      }
      // 账本一致性检测（模块 C，设计 D1）：每轮 prompt 装配前检测"正式文件与索引
      // 校验和/存在性不一致"。漏调 finalize_revision 时，这里在后续轮次发现并注入
      // 提示，让模型对相应章节调用 finalize_revision 入账（不依赖 prompt 自觉）。
      // 索引损坏等异常只记录维护级警告（与迁移挂接同口径），绝不阻塞本轮 run。
      let ledgerDrift = [];
      try {
        ledgerDrift = await detectLedgerDrift({ projectRoot: state.key });
      } catch (driftError) {
        console.warn(
          `[agent] 账本漂移检测失败（尽力而为）: ${driftError?.message ?? String(driftError)}`
        );
      }
      // Task 6：每个模型轮重新读取 WWRITING.md（新对话、上下文压缩后的下一轮、
      // 模型切换、retry 和应用重启都会重新读取）。readProjectMemory 容错：缺失
      // 返回空、不可读返回 unreadable 标记，绝不阻止 prompt、不把全文永久缓存到
      // ensureProject() state。
      const projectMemory = await readProjectMemory(state.key);
      const request = assemblePrompt({
        runtime: {
          absoluteProjectRoot: state.key,
          permissionMode: permissionModeOf(project),
          writableRoots: [state.key],
          network: project?.tool_permissions?.network_allowed === true ? "allowed" : "denied",
          shell: typeof shell === "function" ? "available" : "unavailable",
          nativeTools: "available",
          sessionId: session.session_id,
          runId,
          status: run.status,
          interruptRequested: run.status === "interrupting",
          budget: {},
          ledgerDrift
        },
        projectInstructions: await readProjectInstructions(state.key),
        projectMemory,
        skillCatalog: await state.readSkillCatalog(),
        // Task 7：无工作流切换，不再注入工作流选择的动态上下文（统一政策文本
        // 已承载章节纪律与记忆职责；模型按需自主读取项目文件）
        dynamicContext: [],
        history: await sessionState.history.buildHistory({
          excludeInputId: inputId,
          volatileRecords: volatileToolRecords
        }),
        currentInput: inputText,
        tools: allowedDefinitions(tools),
        modelConfig
      });
      // gateway 契约（src/core/model/gateway.mjs）：request 必须是装配完成的模型
      // 请求 { messages, tools, toolChoice, modelConfig, stream, metadata }——
      // 模型与阶段配置由 runtime 解析后放入 modelConfig（base_url/model_name/
      // api_key_env 等），adapter 依赖它选择模型与读取密钥。assemblePrompt 的预算
      // 直接消费 effective_context_window（Task 2 起 modelConfigOf 恒提供该字段），
      // 不负责回填，这里在调用前挂载。
      request.modelConfig = modelConfig;
      request.stream = true;
      // Task 6：统一上下文门禁预检。估算的唯一输入是已装配完成的最终 request——
      // currentInput 已由 assemblePrompt 放入最后一条 user message，这里绝不再把
      // currentInput 单独传入（单输入规则，避免双算）。每次预检追加
      // context_usage_updated，payload 只含数字与模型基础 ID，不含 prompt 原文。
      const contextEstimate = estimateRequestUsage({
        messages: request.messages,
        tools: request.tools ?? [],
        effectiveContextWindow: modelConfig.effective_context_window,
        calibration: sessionState.contextCalibration ?? 1,
        windowSource: modelConfig.window_source,
      });
      await journal.append({
        type: "context_usage_updated",
        run_id: runId,
        payload: {
          usage: { ...contextEstimate, model: modelConfig.model_name, cache_hit_rate: cacheHitRateOf(sessionState.cacheStats) }
        }
      });
      // Task 8：首次自动压缩门禁（brief Step 4/5）。同一待发送输入最多触发一次
      // 自动压缩：成功/取消/失败后 compactionAttemptedForInput 置位；重新估算时
      // 低于硬窗口继续发送、仍高于软阈值不再压缩、仍超硬窗口则 failRun
      //（error_code context_window_exceeded，原始输入回 UI draft）。
      const preflightCompact = shouldCompact({
        estimatedInput: contextEstimate.used_tokens,
        window: modelConfig.effective_context_window
      });
      // Task 8 修复（C1）：无 active checkpoint 时 buildHistory 只读最近
      // HISTORY_PAGE_LIMIT 条 transcript 原文；一旦 transcript 总长超过该尾部页，
      // 即使 token 估算远低于软阈值（高轮次/低 token 会话），最旧记录也会被静默
      // 排除出 prompt 且永远不会触发压缩——门禁必须加"尾部页溢出"这一条，不能把
      // 首压完全交给估算。有 checkpoint 时历史装配已受 checkpoint + delta 约束，
      // 不重复触发。
      const activePointer = await sessionState.checkpointStore.readActive();
      const transcriptBeyondTail =
        activePointer.checkpoint_id == null && journal.transcriptLastSeq > HISTORY_PAGE_LIMIT;
      const alreadyAttempted =
        compactionAttemptedForInput ||
        (session.compaction?.pending_input_id === inputId &&
          ["completed", "failed", "cancelled", "noop"].includes(session.compaction?.state));
      if ((preflightCompact || transcriptBeyondTail) && !alreadyAttempted) {
        // 安全点：工具结果刚闭合时先追加 interrupt_safe_point_reached 再压缩，
        // 绝不在工具原子写入中途压缩。
        if (closedToolResult) {
          await journal.append({ type: "interrupt_safe_point_reached", run_id: runId, payload: {} });
        }
        resolveFirstTurnIfPending(state);
        const compaction = await sessionState.compactionCoordinator.start({
          projectRoot: state.key,
          trigger: "automatic",
          pendingInputId: inputId,
          modelConfig,
          signal: state.controller?.signal
        });
        compactionAttemptedForInput = true;
        if (compaction.status === "completed" || compaction.status === "noop") {
          // 压缩成功（或无可压缩历史）：使用新 active context 继续——重新预检
          //（低于硬窗口直接发送）。transcript 写入仍发生在下方唯一发送路径。
          continue;
        }
        if (compaction.status === "failed") {
          // 自动压缩失败：Run 进入 waiting_user（不悬挂、不自动重启），输入保持
          // pending 可重试；发送门禁保持禁用直到 retry 成功或 cancel。互斥锁内
          // 读-判-写：若 cancel 恰在此时收敛（run_cancelled 终态），跳过追加。
          await state.mutex.run(async () => {
            const s = await journal.getSession();
            const r = s.active_run;
            if (r && r.id === runId && !TERMINAL_RUN_STATUSES.has(r.status) && r.status !== "waiting_user") {
              await journal.append({
                type: "run_status_changed",
                run_id: runId,
                payload: { status: "waiting_user", reason: "compaction_failed", error_code: compaction.error_code ?? null }
              });
            }
          });
          resetController(state);
          return "compaction_blocked";
        }
        // cancelled：自动压缩取消 → input_cancelled(reason:"compaction_cancelled")
        // + Run cancelled + 文本回 draft（输入从未写入 transcript）。
        const sessionNow = await journal.getSession();
        const runNow = sessionNow.active_run;
        if (!runNow || runNow.id !== runId || TERMINAL_RUN_STATUSES.has(runNow.status)) return "compaction_blocked";
        if (runNow.status === "stopping" || runNow.status === "interrupting") {
          return "interrupted"; // 停止/立即路径负责收敛
        }
        const compactionProjection = (await journal.getSession()).compaction;
        await sessionState.lifecycle.convergeCompactionCancelled(compactionProjection);
        return "compaction_blocked";
      }
      if (preflightCompact && alreadyAttempted) {
        // 已为本输入压缩过：仍高于软阈值不再次压缩；仍超硬窗口 -> 先降级
        // volatile 大工具输出（压缩盲区的最后出路，见 degradeVolatileToolRecords）
        // 再重新装配预检；降级后仍超硬窗口才 failRun。
        if (exceedsHardWindow({ estimatedInput: contextEstimate.used_tokens, window: modelConfig.effective_context_window })) {
          const degradedCount = volatileDegradedForInput ? 0 : degradeVolatileToolRecords(volatileToolRecords);
          if (degradedCount > 0) {
            volatileDegradedForInput = true;
            await journal.append({
              type: "context_volatile_degraded",
              run_id: runId,
              payload: { degraded_count: degradedCount }
            });
            continue; // 重新装配（volatile 已摘要化）后再预检
          }
          await sessionState.lifecycle.failRun(runId, {
            error: Object.assign(new Error("上下文仍超过硬窗口上限，无法发送。"), { code: "context_window_exceeded" }),
            inputId
          });
          return "failed";
        }
        // 低于硬窗口：继续发送（不重复压缩）
      }
      // 未达到阈值（或已压缩且低于硬窗口）：该输入已开始（input_started 已落盘），
      // 在调用模型前的唯一路径把用户文本写入 transcript（Task 9：queued/withdrawn
      // 永不写 transcript；retry 去重由 ensureUserMessageInTranscript 保证）。
      await ensureUserMessageInTranscript(journal, inputId, inputText);
      // 每个 Provider 轮次拥有稳定 turn id（v2 事件契约 §2.3）与独立 writer 对：
      // onToken 只接收公开正文、onReasoningToken 只接收 reasoning，两者不得互相
      // 兜底（§2.1）；reasoning 只经 reasoning_delta/reasoning_completed 进入
      // journal，绝不写入 provider history。
      const modelCaps = resolveModelCapabilities(modelConfig);
      const turnId = idFactory();
      const assistantWriter = createJournalDeltaWriter({
        journal,
        eventType: "assistant_message_delta",
        runId,
        basePayload: { input_id: inputId },
        secrets,
        flushMs: ASSISTANT_DELTA_FLUSH_MS,
        maxPendingChars: ASSISTANT_DELTA_MAX_PENDING_CHARS
      });
      const reasoningWriter = createJournalDeltaWriter({
        journal,
        eventType: "reasoning_delta",
        runId,
        basePayload: { turn_id: turnId, input_id: inputId },
        secrets,
        flushMs: ASSISTANT_DELTA_FLUSH_MS,
        maxPendingChars: ASSISTANT_DELTA_MAX_PENDING_CHARS
      });
      request.metadata = {
        ...(request.metadata ?? {}),
        onToken: (token) => assistantWriter.push(token),
        onReasoningToken: (token) => reasoningWriter.push(token)
      };

      // ---- 模型轮次（成功/失败/取消都必须完整闭合 model turn）----
      await journal.append({
        type: "model_turn_started",
        run_id: runId,
        payload: {
          turn_id: turnId,
          input_id: inputId,
          reasoning_capability: modelCaps.reasoningContent
        }
      });
      if (state.firstTurn && !state.firstTurn.resolved) {
        state.firstTurn.resolved = true;
        state.firstTurn.resolve();
      }
      // 每条 model turn 恰好一次 reasoning_completed + model_turn_completed
      //（v2 冻结契约 §2.3 顺序：先以 safe text 闭合 reasoning，再闭合 turn）。
      const closeTurn = async ({ outcome, reasoningText }) => {
        await journal.append({
          type: "reasoning_completed",
          run_id: runId,
          payload: {
            turn_id: turnId,
            input_id: inputId,
            text: reasoningText,
            availability: reasoningAvailability(modelCaps.reasoningContent, reasoningText)
          }
        });
        await journal.append({
          type: "model_turn_completed",
          run_id: runId,
          payload: { turn_id: turnId, input_id: inputId, outcome }
        });
      };
      let reply;
      let streamedReply = null;
      let reasoningResult = null;
      try {
        reply = await state.modelGateway.complete(request, {
          signal: state.controller?.signal,
          // 第十二轮 §4.3：网关重试即记 journal 事件（瞬态，不入 provider history）。
          onRetry: (info) => {
            void journal.append({
              type: "provider_retry",
              run_id: runId,
              payload: { attempt: info.attempt ?? null, max_attempts: info.maxAttempts ?? null }
            }).catch(() => {
              // 故意 best-effort：瞬态遥测事件，写失败走 journal 既有投影错误
              // 通道，不阻塞重试。
            });
          }
        });
        const finalRawText = String(reply?.text ?? "");
        // 兼容只漏掉尾帧回调、但最终响应正文完整的 Gateway：仅当前缀严格一致时
        // 补入尾部；完全不触发 onToken 的非流式 Gateway 不制造伪增量。
        if (assistantWriter.rawText.length > 0 && finalRawText.startsWith(assistantWriter.rawText)) {
          assistantWriter.push(finalRawText.slice(assistantWriter.rawText.length));
        }
        streamedReply = await assistantWriter.finish();
        reasoningResult = await reasoningWriter.finish();
        // Task 6 校准（成功路径）：provider 返回 input usage 后更新当前 session 的
        // EMA 倍率（夹在 0.5..2.0）。校准只影响下一次本地估算；无 input usage 时
        // 维持 approximate。同样追加 context_usage_updated，payload 只含数字与
        // 模型基础 ID。
        const calibration = observeProviderUsage({
          estimated: contextEstimate,
          usageReport: reply?.usageReport,
          previousCalibration: sessionState.contextCalibration
        });
        if (calibration.calibration != null) sessionState.contextCalibration = calibration.calibration;
        const calibratedEstimate = estimateRequestUsage({
          messages: request.messages,
          tools: request.tools ?? [],
          effectiveContextWindow: modelConfig.effective_context_window,
          calibration: sessionState.contextCalibration ?? 1,
          windowSource: modelConfig.window_source,
        });
        calibratedEstimate.approximate = calibration.approximate;
        // 第九轮：调用完成后累加会话级缓存统计，随 context_usage_updated 送达前端。
        accumulateCacheStats(sessionState.cacheStats, reply?.usageReport);
        await journal.append({
          type: "context_usage_updated",
          run_id: runId,
          payload: {
            usage: { ...calibratedEstimate, model: modelConfig.model_name, cache_hit_rate: cacheHitRateOf(sessionState.cacheStats) }
          }
        });
      } catch (error) {
        // 失败/取消时只排空已经确认安全的正文前缀，不 flush 可能仍是半截密钥的 carry。
        await assistantWriter.finish({ flushTail: false });
        const partialReasoning = await reasoningWriter.finish({ flushTail: false });
        // 必须以 partial safe reasoning 先闭合 reasoning，再用 failed/cancelled
        // 闭合 turn；turn 闭合失败不再加重失败（journal 已不可用时由崩溃恢复兜底）。
        await closeTurn({
          outcome: sessionState.lifecycle.isAbort(error) ? "cancelled" : "failed",
          reasoningText: partialReasoning.safeText
        }).catch(() => {});
        if (sessionState.lifecycle.isAbort(error)) return "interrupted";
        await sessionState.lifecycle.failRun(runId, { error, inputId });
        return "failed";
      }
      // 成功：先 reasoning_completed 闭合 reasoning，最后 model_turn_completed。
      await closeTurn({ outcome: "completed", reasoningText: reasoningResult.safeText });

      // 调用期间可能已到达停止/立即安全点。先落 assistant tool_calls 记录（若本
      // 轮是工具轮），再检查安全点——被打断的回复在中断路径用 cancelled 工具记录
      // 闭合 transcript，绝不留下悬空的 assistant tool_calls（retry/history 复用）。
      const toolCalls = Array.isArray(reply?.toolCalls) && reply.toolCalls.length > 0 ? reply.toolCalls : null;
      if (toolCalls) {
        const assistantToolRecord = {
          role: "assistant",
          content: null,
          tool_calls: toolCalls.map((tc) => ({
            id: tc?.id ?? null,
            name: tc?.name ?? null,
            arguments: tc?.arguments ?? null
          }))
        };
        volatileToolRecords.push(assistantToolRecord);
        await appendSafeTranscript(journal, assistantToolRecord);
      }

      const afterCall = await journal.getSession();
      const runAfterCall = afterCall.active_run;
      if (!runAfterCall || runAfterCall.id !== runId || TERMINAL_RUN_STATUSES.has(runAfterCall.status)) {
        await sessionState.lifecycle.closeDroppedToolCalls(toolCalls);
        return "terminated";
      }
      if (runAfterCall.status === "stopping") {
        await sessionState.lifecycle.closeDroppedToolCalls(toolCalls);
        await sessionState.lifecycle.cancelRunForStop(state.stopReason);
        return "stopped";
      }
      if (runAfterCall.status === "interrupting" || state.controller?.signal.aborted) {
        // 被打断的模型回复不再处理；安全点后读取最新输入（被提升的输入）
        await sessionState.lifecycle.closeDroppedToolCalls(toolCalls);
        await journal.append({ type: "interrupt_safe_point_reached", run_id: runId, payload: {} });
        resetController(state);
        return "interrupted";
      }

      // Task 10：优先安全点（模型响应完成后）。仅当本响应携带尚未开始的工具
      // 调用时切换——全部跳过（tool_skipped_for_priority_input 闭合 transcript），
      // 旧输入 input_interrupted + 优先输入 input_started（同一批次）；纯文本响应
      // 不在此切换：A 以 input_completed 自然完成，由 advanceOrComplete 优先激活
      // D（不伪造中断，SPEC 3.3 rule 6）。
      if (toolCalls && (await sessionState.lifecycle.switchToPriorityAtSafePoint(runId, inputId))) {
        await sessionState.lifecycle.closePrioritySkippedToolCalls(toolCalls);
        return "interrupted";
      }

      if (toolCalls) {
        for (let index = 0; index < toolCalls.length; index += 1) {
          const toolCall = toolCalls[index];
          // 停止/立即安全点：阻止新工具启动，等待当前原子操作；尚未执行的
          // 工具调用用 cancelled 记录闭合 transcript
          const beforeTool = await journal.getSession();
          const runBeforeTool = beforeTool.active_run;
          if (!runBeforeTool || runBeforeTool.id !== runId || TERMINAL_RUN_STATUSES.has(runBeforeTool.status)) {
            await sessionState.lifecycle.closeDroppedToolCalls(toolCalls.slice(index));
            return "terminated";
          }
          if (runBeforeTool.status === "stopping") {
            await sessionState.lifecycle.closeDroppedToolCalls(toolCalls.slice(index));
            await sessionState.lifecycle.cancelRunForStop(state.stopReason);
            return "stopped";
          }
          if (runBeforeTool.status === "interrupting" || state.controller?.signal.aborted) {
            await sessionState.lifecycle.closeDroppedToolCalls(toolCalls.slice(index));
            await journal.append({ type: "interrupt_safe_point_reached", run_id: runId, payload: {} });
            resetController(state);
            return "interrupted";
          }
          // Task 10：优先安全点（每个工具开始前）。尚未启动的调用（含当前）全部
          // 以 tool_skipped_for_priority_input 闭合 transcript 后切换到优先输入。
          if (await sessionState.lifecycle.switchToPriorityAtSafePoint(runId, inputId)) {
            await sessionState.lifecycle.closePrioritySkippedToolCalls(toolCalls.slice(index));
            return "interrupted";
          }
          // R5-5：截断工具参数拒绝。模型在 max_tokens 截断/流异常结束时产生的
          // tool call 参数不完整（adapter 在 finalizeStreamToolCalls 标记
          // arguments_complete=false）——不进入 ToolRuntime 执行，以
          // truncated_args_rejected 唯一闭合 transcript 结果（与 Task 3 的
          // closeSkippedToolCalls 同构：不产生 journal 活动，只补 transcript），
          // 同一响应剩余未启动调用按 skipped 闭合；Run 继续下一模型轮次，让模型
          // 看到结构化错误后重新规划。
          if (toolCall?.arguments_complete === false) {
            const truncatedResult = {
              ok: false,
              tool_call_id: toolCall?.id ?? toolCall?.tool_call_id ?? null,
              name: toolCall?.name ?? null,
              error: {
                code: "truncated_args_rejected",
                message: "模型输出的工具参数不完整（可能因输出截断），本次调用未执行。",
                retryable: true
              },
              message: "模型输出的工具参数不完整（可能因输出截断），本次调用未执行。"
            };
            const truncatedRecord = {
              role: "tool",
              tool_call_id: toolCall?.id ?? toolCall?.tool_call_id ?? null,
              name: toolCall?.name ?? null,
              content: JSON.stringify(truncatedResult)
            };
            volatileToolRecords.push(truncatedRecord);
            await appendSafeTranscript(journal, truncatedRecord);
            const skippedRecords = await sessionState.lifecycle.closeSkippedToolCalls(toolCalls.slice(index + 1));
            for (const record of skippedRecords) volatileToolRecords.push(record);
            break;
          }
          const toolResult = await tools.execute(toolCall, {
            projectRoot: state.key,
            project,
            run_id: runId,
            active_input_id: inputId,
            // Task 7：统一工具目录（每轮同一工具集），执行层独立强制授权
            // Task 6：名单派生自注册表（同 allowedDefinitions 同一来源）
            allowed_tool_names: tools.toolNames(),
            signal: state.controller?.signal
          });
          const toolRecord = {
            role: "tool",
            tool_call_id: toolCall?.id ?? toolCall?.tool_call_id ?? null,
            name: toolCall?.name ?? null,
            content: JSON.stringify(toolResult)
          };
          volatileToolRecords.push(toolRecord);
          await appendSafeTranscript(journal, {
            ...toolRecord,
            content: JSON.stringify(persistentToolResult(toolCall?.name ?? null, toolResult))
          });
          // Task 8：工具结果刚闭合——下一次预检若触发压缩，先追加安全点标记
          closedToolResult = true;
          // Task 10：优先安全点（每个工具结束后）。点击「立即」时已有工具正在
          // 执行：只等待当前工具完成（结果已完整入历史，D 的模型请求可见），
          // 同一轮剩余未启动调用跳过，随后切换——不 abort 在途工具。
          if (await sessionState.lifecycle.switchToPriorityAtSafePoint(runId, inputId)) {
            await sessionState.lifecycle.closePrioritySkippedToolCalls(toolCalls.slice(index + 1));
            return "interrupted";
          }
          // Task 3：前一个工具失败（真实领域失败）后，同一响应剩余未启动的调用
          // 不再执行，以 tool_skipped_after_failure 唯一闭合 transcript；取消/
          // 停止语义仍交给停止/中断路径闭合（closeDroppedToolCalls）
          if (toolResult?.ok === false && !TOOL_RESULT_CANCELLATION_CODES.has(toolResult.error?.code)) {
            const skippedRecords = await sessionState.lifecycle.closeSkippedToolCalls(toolCalls.slice(index + 1));
            for (const record of skippedRecords) volatileToolRecords.push(record);
            break;
          }
        }
        continue; // 工具结果已入 transcript，继续下一模型轮次
      }

      // ---- 文本回复：当前输入完成 ----
      const text = String(reply?.text ?? "");
      // completed 仍以最终回复的一次性脱敏为权威；正常 Provider 契约下，流式
      // redactor 的拼接结果与这里严格一致。非流式 Gateway 没有 delta，直接终态。
      const safeText = redactor.redact(text);
      if (streamedReply?.rawText && streamedReply.safeText !== safeText) {
        const error = new Error("Provider token stream 与最终正文不一致。");
        error.code = "provider_stream_mismatch";
        await sessionState.lifecycle.failRun(runId, { error, inputId });
        return "failed";
      }
      await appendSafeTranscript(journal, { role: "assistant", content: text });
      await journal.append({
        type: "assistant_message_completed",
        run_id: runId,
        payload: {
          input_id: inputId,
          text: safeText,
          // Task 4：max_tokens 截断透传。流式末帧 finish_reason="length" 时正文是
          // 半截内容，标记 truncated 让前端展示提示；非截断路径 payload 与旧契约一致。
          ...(reply?.raw?.finish_reason === "length" ? { truncated: true } : {})
        }
      });
      // 完成批次（input_completed + grant 清除）的读-判-写放进项目互斥锁，杜绝与
      // cancelRunForStop 交错产生「同一 input 双终态」（input_cancelled 与
      // input_completed 并存，违反 Task 2/9 冻结语义）：无论谁先拿到锁，后到者看到的
      // 投影都是终态——Run 已取消/停止时跳过完成批次（停止路径负责取消输入与
      // 清除 grant）；优先安全点切换已把该输入中断（input_interrupted 落盘、
      // active_input_id 已切换）时同样跳过——该输入的终态由切换批次负责。返回
      // "done" 后由 advanceOrComplete 读到终态收敛。
      await state.mutex.run(async () => {
        const sessionNow = await journal.getSession();
        const runNow = sessionNow.active_run;
        if (!runNow || TERMINAL_RUN_STATUSES.has(runNow.status)) return false;
        if (runNow.active_input_id !== inputId) return false;
        const grantsOfInput =
          runNow.active_grants?.filter((grant) => grant.input_id === inputId) ?? [];
        const completionBatch = [];
        if (await needsCompletionTerminal(journal, runId, inputId)) {
          completionBatch.push({ type: "input_completed", run_id: runId, payload: { input_id: inputId } });
        }
        for (const grant of grantsOfInput) {
          completionBatch.push({
            type: "permission_grant_cleared",
            run_id: runId,
            payload: { grant_id: grant.id, input_id: grant.input_id, grant_key: grant.grant_key, reason: "input_completed" }
          });
        }
        if (completionBatch.length > 0) await journal.appendBatch(completionBatch);
        return true;
      });
      return "done";
    }
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
