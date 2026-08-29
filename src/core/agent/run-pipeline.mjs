// src/core/agent/run-pipeline.mjs —— Run 输入流水线（第十五轮 F5d Task 10b）。
//
// 从 runtime.mjs 机械迁出（不改逻辑）：processInput（模型轮次循环/工具执行/
// 停止中断安全点/权限确认）与 processCompact（手动 /compact 消费），连同它们
// 独占的辅助函数（resolveFirstTurnIfPending / readProjectInstructions /
// permissionModeOf / allowedDefinitions / ensureUserMessageInTranscript /
// needsCompletionTerminal / isCompactRunIdleInitiated / appendSafeTranscript
// 薄委托）与模块级常量（TOOL_RESULT_CANCELLATION_CODES / ASSISTANT_DELTA_*）。
//
// 依赖形态（与 run-lifecycle 同款 createXxx(ctx) 模式，经 ctx 解构函数引用）：
//   - state/sessionState 双闭包态经参数传入（runLoop 每次调用注入当前值——
//     processInput 循环期间 state.controller 等字段变化可见）；
//   - runtime 内部函数（resolveWorkspaceConfig / modelConfigOf / resetController /
//     redactor / secrets / idFactory / accumulateCacheStats / cacheHitRateOf /
//     shell）经 ctx 注入函数引用——它们同时被 runtime 其它路径（buildInput 闭包、
//     回放、run-lifecycle ctx）消费，不随迁；shell 漏注入会让 typeof 未绑定
//     identifier 恒为 "undefined"，policy 静默降级为 unavailable（P1 回归点）。
//   - 模块级常量/纯依赖本模块直接持有或 import。单源纪律：
//     TERMINAL_RUN_STATUSES 从 journal.mjs import，不复制。
//
// 消费接线：本模块导出的 processCompact/processInput 由 run-lifecycle 的 runLoop
// 经 ctx 调用（createRunLifecycle 注入点在 runtime.mjs 改接本工厂实例）；
// appendSafeTranscript/isCompactRunIdleInitiated 同时被 run-lifecycle ctx 消费，
// 亦从本工厂导出（单源）。
import fs from "node:fs/promises";
import path from "node:path";

import { TERMINAL_RUN_STATUSES, persistentToolResult } from "./journal.mjs";
import { assemblePrompt } from "./prompt.mjs";
import {
  estimateRequestUsage,
  observeProviderUsage,
  shouldCompact,
  exceedsHardWindow
} from "./context-window.mjs";
import { HISTORY_PAGE_LIMIT, degradeVolatileToolRecords } from "./history-assembly.mjs";
import { loadChapterIndex } from "../project-store.mjs";
import { pathExists } from "../fs-utils.mjs";
import { readProjectMemory } from "../project-memory.mjs";
import { resolveModelCapabilities } from "../model/capabilities.mjs";
import { createJournalDeltaWriter, reasoningAvailability } from "./stream-writer.mjs";
import { migrateBaselineVersions } from "../project-operations/versions.mjs";
import { detectLedgerDrift } from "../ledger-drift.mjs";
import { buildCompactionSource } from "./compaction.mjs";

// 停止/中断路径以 tool_cancelled 统一闭合（stop 与 requestPriority 并发测试钉住
// 该顺序），只有真实领域失败才把未启动的后续调用闭合为 tool_skipped_after_failure。
const TOOL_RESULT_CANCELLATION_CODES = new Set(["tool_cancelled", "shell_cancelled"]);

const ASSISTANT_DELTA_FLUSH_MS = 24;
const ASSISTANT_DELTA_MAX_PENDING_CHARS = 2048;

export function createRunPipeline(ctx) {
  const {
    resolveWorkspaceConfig,
    modelConfigOf,
    resetController,
    redactor,
    secrets,
    idFactory,
    accumulateCacheStats,
    cacheHitRateOf,
    shell
  } = ctx;

// 首次"活动"信号：普通模型轮次（model_turn_started）与压缩调用（Task 8）都
// 算作 Run 的第一个活动——submit 等待它拿到控制权（「立即」/「停止」需要
// 飞行中的活动可打断）。
function resolveFirstTurnIfPending(state) {
  if (state.firstTurn && !state.firstTurn.resolved) {
    state.firstTurn.resolved = true;
    state.firstTurn.resolve();
  }
}

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

function permissionModeOf(project) {
  const tp = project?.tool_permissions ?? {};
  if (tp.yolo === true) return "yolo";
  if (tp.auto_edit === true) return "trusted";
  return "ask";
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

// -------------------------------------------------------------------------
// Run 输入流水线主体：压缩管道（processCompact，手动 /compact 消费）与
// 输入循环（processInput，普通输入的模型轮次流水线）
// -------------------------------------------------------------------------

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
    // onToken 只接收公开正文、onReasoningToken 只接收 reasoning，两者不得
    // 互相兜底（§2.1）；reasoning 经 reasoning_delta/reasoning_completed 进入
    // journal，并随 assistant transcript 记录回传 provider history（官方
    // thinking_mode 回传契约，见 history-assembly 的 reasoning_content）。
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
        // 思考回传契约：本轮思考随 assistant 记录持久化，历史装配层据此在后续
        // 请求里回传 reasoning_content（官方 thinking_mode 契约，工具轮强制）。
        ...(reasoningResult.safeText ? { reasoning: reasoningResult.safeText } : {}),
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
    await appendSafeTranscript(journal, {
      role: "assistant",
      content: text,
      // 思考回传契约：同工具轮——本轮思考随记录持久化供后续请求回传。
      ...(reasoningResult.safeText ? { reasoning: reasoningResult.safeText } : {})
    });
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
  return { processCompact, processInput, isCompactRunIdleInitiated, appendSafeTranscript };
}
