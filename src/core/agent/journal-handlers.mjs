// src/core/agent/journal-handlers.mjs
//
// 第十五轮 Task 4：journal.mjs 的 reduceEvent 巨型 switch（48 case）拆为
// handler 表，随同常量区、投影构造器与进程重启收敛矩阵整体迁入本模块。
// 机械搬运：事件语义、校验顺序、错误文案与 journal.mjs 原实现逐字一致，
// 本文件不承载任何 I/O（segment store / session.json 仍归 journal.mjs）。
//
// 约定：
//   EVENT_HANDLERS 键集合与 FIXED_EVENT_TYPES 一一对应（对账红线测试
//   tests/agent/journal-handlers.test.mjs 把关）。handler 签名
//   (session, event, side)，原地更新 projection；需要换出 session 的 case
//   （session_created）由 reduceEvent 的引导逻辑创建，其余 handler 无返回值。
import { fail } from "./agent-utils.mjs";

// 计划固定的 44 个 journal 事件类型；未知类型一律拒绝。
// Task 6：新输入生命周期只产生六类事件（input_queued/input_started/input_completed/
// input_interrupted/input_withdrawn/priority_input_requested）；旧的 input_promoted/
// input_consumed/input_cancelled 已由新 generation 停止产生（Task 26 收口），类型
// 清单与 reducer legacy 分支只服务旧日志追加式重放（reducer 契约外事件，回放旧
// journal 仍可接受）。Task 12：旧工作流事件类型已随工作流概念整体删除（不再产生、
// 不再投影、reducer 拒绝）。
export const FIXED_EVENT_TYPES = Object.freeze([
  "session_created",
  "run_started",
  "run_status_changed",
  "input_queued",
  "input_started",
  "input_completed",
  "input_interrupted",
  "input_withdrawn",
  "priority_input_requested",
  "input_promoted",
  "input_consumed",
  "input_cancelled",
  "interrupt_requested",
  "interrupt_safe_point_reached",
  "model_turn_started",
  "model_turn_completed",
  "tool_call_started",
  "tool_output_delta",
  "tool_call_completed",
  "tool_call_failed",
  "decision_requested",
  "decision_resolved",
  "permission_grant_created",
  "permission_grant_cleared",
  "plan_updated",
  "reasoning_completed",
  "reasoning_delta",
  "history_compacted",
  "checkpoint_linked",
  "context_usage_updated",
  "context_compaction_started",
  "context_compaction_running",
  "context_compaction_cancel_requested",
  "context_compaction_completed",
  "context_compaction_failed",
  "context_compaction_cancelled",
  "context_compaction_noop",
  "context_volatile_degraded",
  "provider_retry",
  "assistant_message_delta",
  "assistant_message_completed",
  "run_completed",
  "run_failed",
  "run_cancelled",
  "run_interrupted",
  "journal_recovery_boundary",
  // 第九轮：系统事件注入（UI 侧恢复操作在对话流中的可见性）
  "chapter_rolled_back",
  "memory_file_restored"
]);

export const SESSION_STATUSES = Object.freeze([
  "idle",
  "running",
  "waiting_user",
  "interrupting",
  "stopping",
  "error"
]);

export const RUN_STATUSES = Object.freeze([
  "running",
  "waiting_user",
  "interrupting",
  "stopping",
  "completed",
  "failed",
  "cancelled",
  "interrupted"
]);

export const PLAN_STATUSES = Object.freeze(["pending", "in_progress", "completed"]);

export const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

// 非终态压缩状态（Task 8）：started/running/cancelling 之间不允许开启新的压缩。
export const COMPACTION_NON_TERMINAL_STATES = new Set(["started", "running", "cancelling"]);

// 有效工作时钟状态（transitionWorkClock 复用；模块级常量避免每次调用重建 Set）。
export const WORK_CLOCK_ACTIVE_STATUSES = new Set(["running", "interrupting", "stopping"]);

export const TERMINAL_EVENT_TO_STATUS = Object.freeze({
  run_completed: "completed",
  run_failed: "failed",
  run_cancelled: "cancelled",
  run_interrupted: "interrupted"
});

// 新追加事件的 schema version（Task 3 起为 2）：reducer 同时接受旧 v1 与 v2
// 事件（v1 重放走 legacy 分支），session projection 记录已重放事件的最高版本。
export const EVENT_SCHEMA_VERSION = 2;

// Run 状态到 Session 状态的映射：终结的 Run 使 Session 回到 idle。
export const RUN_STATUS_TO_SESSION = Object.freeze({
  running: "running",
  waiting_user: "waiting_user",
  interrupting: "interrupting",
  stopping: "stopping",
  completed: "idle",
  failed: "idle",
  cancelled: "idle",
  interrupted: "idle"
});

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) fail(`${name} 必须是非空字符串`);
  return value;
}

function toolCallIdOf(payload) {
  return requireString(payload.tool_call_id ?? payload.id, "tool_call_id");
}

export function createEmptySession({ sessionId, projectRoot, at }) {
  return {
    schema_version: 1,
    session_id: sessionId,
    project_root: projectRoot,
    status: "idle",
    active_run: null,
    queued_inputs: [],
    // Task 6：优先输入投影。null 表示无优先请求；priority_input_requested 设置、
    // 匹配的 input_started 清空。只指向排队中的输入，不立即改写 active_input_id。
    priority_input_id: null,
    // Task 6：上下文用量投影。null 表示尚无任何 context_usage_updated 事件
    //（旧 session 重放/项目刚打开），UI 显示"计算中/待校准"，绝不用假 0 冒充
    // 真实占用。revisions.context 只随 context_usage_updated 递增，供 UI 增量订阅。
    context_usage: null,
    // Task 8：active context checkpoint 指针与最近一次压缩投影。
    // active_context_checkpoint_id 只在 context_compaction_completed 时切换；
    // failed/cancelled 必须保持旧值。compaction 为最近一次压缩的投影
    //（CompactionProjection typedef：id/trigger/state/attempt/source_checkpoint_id/
    // checkpoint_id/pending_input_id/error_code/started_at/updated_at）。
    active_context_checkpoint_id: null,
    compaction: null,
    history_degraded: false,
    history_gaps: [],
    revisions: { context: 0 },
    last_seq: 0,
    updated_at: at
  };
}

function createRun(event, { inputId }) {
  return {
    id: event.run_id,
    status: "running",
    active_input_id: inputId,
    visible_plan: null,
    // 正文增量累积（assistant_message_delta 追加；assistant_message_completed
    // 以全文终态对齐或保留累积）。可回放可恢复，重建 projection 与实时一致。
    assistant_text: null,
    active_grants: [],
    started_at: event.at,
    finished_at: null,
    // 有效工作时钟：只累计 active（running/interrupting/stopping）状态下的耗时，
    // waiting_user 由 transitionWorkClock 排除。active_since 为 null 表示当前
    // 不在有效工作区间（等待确认/已终结）；active_elapsed_ms 为累计有效耗时。
    active_elapsed_ms: 0,
    active_since: event.at
  };
}

// 工作时钟转换：每次状态转换/终态事件必须先调用本函数，再写 run.status。
//   - 离开 active 状态（等待确认/终结）时把 [active_since, at] 计入累计耗时并
//     置空 active_since（等待用户的时间不计入有效工作耗时）；
//   - 进入 active 状态且当前不在计时区间时重新设置 active_since；
//   - 终态同时落 finished_at。
// retry（terminal→running）保留 active_elapsed_ms 并重新设置 active_since。
function transitionWorkClock(run, nextStatus, at) {
  if (run.active_since && !WORK_CLOCK_ACTIVE_STATUSES.has(nextStatus)) {
    run.active_elapsed_ms += Math.max(0, Date.parse(at) - Date.parse(run.active_since));
    run.active_since = null;
  }
  if (!run.active_since && WORK_CLOCK_ACTIVE_STATUSES.has(nextStatus)) run.active_since = at;
  if (["completed", "failed", "cancelled", "interrupted"].includes(nextStatus)) run.finished_at = at;
}

function activateInput(session, inputId) {
  session.queued_inputs = session.queued_inputs.filter((item) => item.id !== inputId);
  session.active_run.active_input_id = inputId;
}

export function createSideState() {
  return {
    eventIds: new Set(), // 全量 event_id（reducer 去重校验，含重放路径）
    openToolCalls: new Map(), // tool_call_id -> { seq, activity_id, name }（值形态见 tool_call_started 分支）
    openModelTurns: new Map(), // v2 turn_id -> { seq, reasoningCompleted }（供崩溃恢复检测）
    legacyOpenTurns: [], // v1 旧日志重放时的未闭合 turn 栈（legacy-<event_id>）
    openDecisions: new Map(), // decision_id -> seq
    terminalInputs: new Set(), // 已 consumed/cancelled 的 input id
    inputMeta: new Map() // input_id -> { id, text, status, queued_at }（re-queue 用）
  };
}

// 需要活动（非终结）Run 的事件校验（reduceEvent 原 requireActiveRun 闭包
// 模块化）：校验 run 存在、未终结、run_id 一致。
function requireActiveRun(session, event, what) {
  const run = session.active_run;
  if (!run) fail(`${what} 需要活动 Run，但当前没有 Run`);
  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    fail(`${what} 需要非终结 Run，但 Run ${run.id} 已处于 ${run.status}`);
  }
  if (event.run_id != null && event.run_id !== run.id) {
    fail(`${what} 的 run_id ${event.run_id} 与活动 Run ${run.id} 不一致`);
  }
  return run;
}

// ---------------------------------------------------------------------------
// Session/Run reducer（内部实现）：把一条事件应用到当前 projection。
// 严格校验：未知事件类型、两个 active Run、consumed input 残留队列、
// 两个 in_progress plan 项、无 retry 的 terminal→running 转换等一律拒绝。
// 48 个 case 拆为 EVENT_HANDLERS 表（与 FIXED_EVENT_TYPES 一一对应，对账
// 红线测试把关）；reduceEvent 保留引导逻辑（首事件/一致性校验）与尾部记账。
// ---------------------------------------------------------------------------

export const EVENT_HANDLERS = Object.freeze({
  // --- 会话元数据 ---

  session_created(session, event) {
    if (session.last_seq !== 0) fail("session_created 必须是 journal 的第一条事件");
  },

  // --- Run 生命周期：启动与状态迁移 ---

  run_started(session, event) {
    const payload = event?.payload ?? {};
    const inputId = payload.input_id ?? null;
    if (inputId !== null) requireString(inputId, "input_id");
    if (event.run_id == null) fail("run_started 必须携带 run_id");
    const run = session.active_run;
    if (run) {
      if (!TERMINAL_RUN_STATUSES.has(run.status)) {
        fail(`两个 active Run：Run ${run.id} 尚在 ${run.status}，拒绝启动 ${event.run_id}`);
      }
      if (run.id === event.run_id) {
        // retry：恢复同一可恢复 Run（保留 started_at/visible_plan/累计
        // 有效耗时）；正文增量按尝试重置（新尝试的 delta 从空开始累积）。
        // 工作时钟：保留 active_elapsed_ms 并重新设置 active_since。
        transitionWorkClock(run, "running", event.at);
        run.status = "running";
        session.status = "running";
        run.assistant_text = null;
      } else {
        session.active_run = createRun(event, { inputId });
        session.status = "running";
      }
    } else {
      session.active_run = createRun(event, { inputId });
      session.status = "running";
    }
    // 新 Run（或恢复的 Run）认领活动输入：从队列移除，避免 consumed input 残留队列
    if (inputId !== null) activateInput(session, inputId);
  },

  run_status_changed(session, event) {
    const payload = event?.payload ?? {};
    const target = payload.status;
    const run = session.active_run;
    if (!run) fail("run_status_changed 需要活动 Run，但当前没有 Run");
    if (event.run_id != null && event.run_id !== run.id) {
      fail(`run_status_changed 的 run_id ${event.run_id} 与活动 Run ${run.id} 不一致`);
    }
    if (!RUN_STATUSES.includes(target)) fail(`未知 run 状态: ${String(target)}`);
    const currentTerminal = TERMINAL_RUN_STATUSES.has(run.status);
    const targetTerminal = TERMINAL_RUN_STATUSES.has(target);
    if (currentTerminal) {
      if (targetTerminal) {
        fail(`Run ${run.id} 已终结（${run.status}），不能再次进入 ${target}`);
      }
      if (target !== "running" || payload.retry !== true) {
        fail(`Run ${run.id} 从终结状态 ${run.status} 转为 ${target} 必须携带 retry: true`);
      }
    }
    // 有效工作时钟先行：waiting_user 不计入耗时，恢复 running 时重新计时
    transitionWorkClock(run, target, event.at);
    run.status = target;
    session.status = RUN_STATUS_TO_SESSION[target];
    if (targetTerminal) run.active_input_id = null;
  },

  // --- 输入与队列 ---

  input_queued(session, event, side) {
    const payload = event?.payload ?? {};
    const inputId = requireString(payload.input_id, "input_id");
    if (typeof payload.text !== "string") fail("input_queued 必须携带 text");
    if (side.terminalInputs.has(inputId)) fail(`input ${inputId} 已终结，不得重新排队`);
    if (session.queued_inputs.some((item) => item.id === inputId)) fail(`input ${inputId} 已在队列中`);
    const item = {
      id: inputId,
      text: payload.text,
      status: "queued",
      queued_at: payload.queued_at ?? event.at
    };
    // Task 8：/compact 队列项带 kind:"compact"（运行中排队不打断当前模型/工具）
    if (payload.kind === "compact") item.kind = "compact";
    session.queued_inputs.push(item);
    side.inputMeta.set(inputId, item);
  },

  // -------------------------------------------------------------------------
  // Task 6：新输入生命周期（SPEC 3.2）。仅允许
  //   queued -> started -> completed | interrupted
  //   queued -> withdrawn
  // 每条输入恰好一个终态；input_started 是唯一把用户文本写入 transcript 的边界。
  // 旧 input_consumed/input_cancelled/input_promoted 分支保留为 legacy 兼容
  //（Task 26 起新 generation 不再产生，仅回放旧日志时生效；input_cancelled 仍由
  // 硬停止/压缩取消/历史缺口恢复路径产生——语义收窄的保留理由见
  // runtime.mjs cancelRunForStop / convergeCompactionCancelled 与
  // journal.mjs appendGapRecovery 的注释）。
  // -------------------------------------------------------------------------

  input_started(session, event, side) {
    const payload = event?.payload ?? {};
    const inputId = requireString(payload.input_id, "input_id");
    const activeRun = requireActiveRun(session, event, "input_started");
    // 生命周期不变量：前一条活动输入必须先收敛（completed/interrupted），否则
    // 它会停留在 started 且没有终态事件。优先级切换批次先写 input_interrupted
    // 再写 input_started，因此本校验不阻碍合法收敛。
    if (activeRun.active_input_id != null) {
      fail(`input_started 时活动输入 ${activeRun.active_input_id} 尚未收敛，拒绝切换`);
    }
    const index = session.queued_inputs.findIndex((item) => item.id === inputId);
    if (index === -1) fail(`input_started 引用非排队 input ${inputId}`);
    session.queued_inputs.splice(index, 1);
    activeRun.active_input_id = inputId;
    // 匹配 priority 的 input_started 清除优先标记（SPEC 3.3：真正开始后恢复优先）
    if (session.priority_input_id === inputId) session.priority_input_id = null;
    const startedMeta = side.inputMeta.get(inputId);
    if (startedMeta) startedMeta.status = "started";
  },

  input_completed(session, event, side) {
    const payload = event?.payload ?? {};
    const inputId = requireString(payload.input_id, "input_id");
    const activeRun = requireActiveRun(session, event, "input_completed");
    if (activeRun.active_input_id !== inputId) {
      fail(`input_completed 引用非活动 input ${inputId}`);
    }
    activeRun.active_input_id = null;
    const completedMeta = side.inputMeta.get(inputId);
    if (completedMeta) completedMeta.status = "completed";
    side.terminalInputs.add(inputId);
  },

  input_interrupted(session, event, side) {
    const payload = event?.payload ?? {};
    const inputId = requireString(payload.input_id, "input_id");
    const activeRun = requireActiveRun(session, event, "input_interrupted");
    if (activeRun.active_input_id !== inputId) {
      fail(`input_interrupted 引用非活动 input ${inputId}`);
    }
    activeRun.active_input_id = null;
    const interruptedMeta = side.inputMeta.get(inputId);
    if (interruptedMeta) interruptedMeta.status = "interrupted";
    side.terminalInputs.add(inputId);
  },

  input_withdrawn(session, event, side) {
    const payload = event?.payload ?? {};
    // 仅可撤回排队输入；活动输入只能 completed/interrupted（不产生"撤销"语义）
    const inputId = requireString(payload.input_id, "input_id");
    const index = session.queued_inputs.findIndex((item) => item.id === inputId);
    if (index === -1) fail(`input_withdrawn 引用非排队 input ${inputId}`);
    session.queued_inputs.splice(index, 1);
    // 撤回的正是优先输入时清空标记：input_started（唯一清空路径）对已撤回输入
    // 永远不会触发，若不清空则后续 priority_input_requested 全部被"已有优先输入"
    // 拒绝，用户再也无法使用"立即"（SPEC 3.3 rule 10：优先队列不得卡死）。
    if (session.priority_input_id === inputId) session.priority_input_id = null;
    const withdrawnMeta = side.inputMeta.get(inputId);
    if (withdrawnMeta) withdrawnMeta.status = "withdrawn";
    side.terminalInputs.add(inputId);
  },

  priority_input_requested(session, event) {
    const payload = event?.payload ?? {};
    // 只设置 priority_input_id，不立即改写 active_input_id（SPEC 3.3）。
    const inputId = requireString(payload.input_id, "input_id");
    if (!session.queued_inputs.some((item) => item.id === inputId)) {
      fail(`priority_input_requested 引用非排队 input ${inputId}`);
    }
    if (session.priority_input_id != null) {
      fail(`已有优先输入 ${session.priority_input_id}，拒绝第二个 priority_input_requested`);
    }
    session.priority_input_id = inputId;
  },

  input_consumed(session, event, side) {
    const payload = event?.payload ?? {};
    const inputId = requireString(payload.input_id, "input_id");
    const activeRun = requireActiveRun(session, event, "input_consumed");
    // 语义边界（Task 6 编排必须遵守，验收"活动闭环"不变量）：每条 input 恰好需要
    // 一个 input_consumed / input_cancelled 终态事件。当前活动输入完成时由其自身
    // 的 input_consumed 收敛（active_input_id → null）；被 input_promoted 打断的
    // 输入会放回队列、之后重新被消费。reducer 不隐式终结旧活动输入——下面"切换
    // 活动输入"分支只激活队列中的下一个输入，旧输入的终态事件由 runtime 负责。
    if (activeRun.active_input_id === inputId) {
      // 当前活动输入完成
      activeRun.active_input_id = null;
    } else {
      // 队列中的输入开始被消费（切换活动输入）
      const index = session.queued_inputs.findIndex((item) => item.id === inputId);
      if (index === -1) {
        fail(`input_consumed 引用未知 input ${inputId}（既非活动输入也不在队列）`);
      }
      session.queued_inputs.splice(index, 1);
      activeRun.active_input_id = inputId;
    }
    side.terminalInputs.add(inputId);
  },

  input_cancelled(session, event, side) {
    const payload = event?.payload ?? {};
    // 已知边角（Task 6 规格审查记录，Task 9/11 全量验证时评估，不改行为）：
    // 一条已被 input_consumed「切换激活」消费过的输入，若随后被 input_promoted
    // 放回队列、再次经 input_consumed 重新激活，则 stop 路径追加的 input_cancelled
    // 会给它产生第二个终态事件（本分支对活动输入不查 terminalInputs），与
    //「每条 input 恰好一个终态事件」的字面不变量冲突。冻结验收/agent 场景均不
    // 覆盖此链路（promote 后该输入立即重新被处理，stop 不会落在未消费的活动输入
    // 上）；如需严格化，应在 reducer 侧校验或由 runtime 的 stop 收敛跳过已终结输入。
    // Task 26：新 generation 不再产生 input_consumed/input_promoted，此链路仅旧
    // 日志追加式重放可触发；input_cancelled 本身仍由硬停止/运行级丢弃路径产生
    //（语义收窄，见 runtime.cancelRunForStop / convergeCompactionCancelled）。
    const inputId = requireString(payload.input_id, "input_id");
    if (session.active_run?.active_input_id === inputId) {
      session.active_run.active_input_id = null;
    } else {
      const index = session.queued_inputs.findIndex((item) => item.id === inputId);
      if (index === -1) {
        fail(`input_cancelled 引用未知 input ${inputId}（既非活动输入也不在队列）`);
      }
      session.queued_inputs.splice(index, 1);
    }
    // legacy 取消同样清空匹配的 priority 标记（缺口/保守恢复批次用 input_cancelled
    // 取消排队输入，取消优先输入后不得留下卡死 priority 指针）
    if (session.priority_input_id === inputId) session.priority_input_id = null;
    side.terminalInputs.add(inputId);
  },

  input_promoted(session, event, side) {
    const payload = event?.payload ?? {};
    const inputId = requireString(payload.input_id, "input_id");
    const activeRun = requireActiveRun(session, event, "input_promoted");
    const index = session.queued_inputs.findIndex((item) => item.id === inputId);
    if (index === -1) fail(`input_promoted 引用非排队 input ${inputId}`);
    session.queued_inputs.splice(index, 1);
    const previousId = activeRun.active_input_id;
    if (previousId != null && previousId !== inputId) {
      // 被打断的活动输入按原排队信息放回队首，剩余输入保持顺序
      const meta = side.inputMeta.get(previousId);
      if (meta) {
        session.queued_inputs.unshift({
          id: meta.id,
          text: meta.text,
          status: "queued",
          queued_at: meta.queued_at
        });
      }
    }
    activeRun.active_input_id = inputId;
  },

  // --- 中断 ---

  interrupt_requested(session, event) {
    const activeRun = requireActiveRun(session, event, "interrupt_requested");
    // 停止优先于中断（Task 6 规格审查）：Run 已进入 stopping 后拒绝再写入
    // interrupt_requested，防止「立即」击穿「停止」。Task 26：旧 promote 已退役，
    // 新 generation 不再产生 interrupt_requested（「立即」= requestPriority 只写
    // priority_input_requested），本分支与守卫仅服务旧日志重放——reducer 仍是
    // journal 锁内的唯一串行化兜底。
    if (activeRun.status === "stopping") {
      fail(`Run ${activeRun.id} 正在停止，不能写入 interrupt_requested`);
    }
    transitionWorkClock(activeRun, "interrupting", event.at);
    activeRun.status = "interrupting";
    session.status = "interrupting";
  },

  interrupt_safe_point_reached(session, event) {
    const activeRun = requireActiveRun(session, event, "interrupt_safe_point_reached");
    transitionWorkClock(activeRun, "running", event.at);
    activeRun.status = "running";
    session.status = "running";
  },

  // --- 模型轮次 ---

  model_turn_started(session, event, side) {
    const payload = event?.payload ?? {};
    const activeRun = requireActiveRun(session, event, "model_turn_started");
    // 每个 Provider 轮次拥有独立的临时正文。工具轮次可能先流出一句操作前言，
    // 下一轮必须从空白开始，避免前言与最终答复在 projection 中串接。
    activeRun.assistant_text = null;
    const turnId = payload.turn_id;
    if (turnId == null) {
      // v1 旧日志重放（schema_version 1 的 model_turn_* 没有 turn_id）：按开始
      // 顺序压入 legacy turn 栈，由下一条 v1 completed 关闭栈顶。只有 v1 重放
      // 走该分支；v2 追加缺 turn_id 一律拒绝。
      if (event.schema_version !== 1) fail("model_turn_started 必须携带 turn_id");
      side.legacyOpenTurns.push(`legacy-${event.event_id}`);
      return;
    }
    requireString(turnId, "turn_id");
    requireString(payload.input_id, "input_id");
    requireString(payload.reasoning_capability, "reasoning_capability");
    if (side.openModelTurns.has(turnId)) fail(`model turn ${turnId} 重复开始`);
    side.openModelTurns.set(turnId, { seq: event.seq, reasoningCompleted: false });
  },

  model_turn_completed(session, event, side) {
    const payload = event?.payload ?? {};
    requireActiveRun(session, event, "model_turn_completed");
    const turnId = payload.turn_id;
    if (turnId == null) {
      if (event.schema_version !== 1) fail("model_turn_completed 必须携带 turn_id");
      const legacyId = side.legacyOpenTurns.pop();
      if (!legacyId) fail("model_turn_completed 没有对应的 model_turn_started");
      return;
    }
    requireString(turnId, "turn_id");
    requireString(payload.input_id, "input_id");
    const outcome = requireString(payload.outcome, "outcome");
    if (!["completed", "failed", "cancelled"].includes(outcome)) {
      fail(`model_turn_completed 的 outcome 非法: ${String(outcome)}`);
    }
    // completed 只出现一次：delete 失败即该 turn 尚未开始或已闭合
    if (!side.openModelTurns.delete(turnId)) fail(`model_turn_completed 引用未开始的 turn ${turnId}`);
  },

  reasoning_delta(session, event, side) {
    const payload = event?.payload ?? {};
    requireActiveRun(session, event, "reasoning_delta");
    const turnId = requireString(payload.turn_id, "turn_id");
    if (!side.openModelTurns.has(turnId)) fail(`reasoning_delta 引用未知 turn ${turnId}`);
    requireString(payload.text, "text");
    requireString(payload.input_id, "input_id");
  },

  reasoning_completed(session, event, side) {
    const payload = event?.payload ?? {};
    requireActiveRun(session, event, "reasoning_completed");
    const turnId = requireString(payload.turn_id, "turn_id");
    const meta = side.openModelTurns.get(turnId);
    if (!meta) fail(`reasoning_completed 引用未知 turn ${turnId}`);
    if (meta.reasoningCompleted) fail(`turn ${turnId} 的 reasoning 已 completed（不得重复）`);
    requireString(payload.input_id, "input_id");
    if (typeof payload.text !== "string") fail("reasoning_completed 必须携带 text");
    const availability = payload.availability;
    if (!["available", "unsupported", "empty"].includes(availability)) {
      fail(`reasoning_completed 的 availability 非法: ${String(availability)}`);
    }
    meta.reasoningCompleted = true;
  },

  // --- 工具调用 ---

  tool_call_started(session, event, side) {
    const payload = event?.payload ?? {};
    requireActiveRun(session, event, "tool_call_started");
    const id = toolCallIdOf(payload);
    if (side.openToolCalls.has(id)) fail(`tool call ${id} 重复开始`);
    // 第十二轮 F2：值形态从 seq 改为 { seq, activity_id, name }——恢复批次
    // 补字段的前置（否则闭合孤儿时无从查得 activity_id，前端 work-items
    // 按 payload.activity_id 匹配，事件会被静默丢弃）。旧日志重放后
    // activity_id/name 为 null，恢复批次兜底 unknown/空。
    side.openToolCalls.set(id, {
      seq: event.seq,
      activity_id: payload.activity_id ?? null,
      name: typeof payload.name === "string" ? payload.name : null
    });
  },

  tool_output_delta(session, event, side) {
    const payload = event?.payload ?? {};
    requireActiveRun(session, event, "tool_output_delta");
    const id = toolCallIdOf(payload);
    if (!side.openToolCalls.has(id)) fail(`tool_output_delta 引用未开始的 tool call ${id}`);
  },

  tool_call_completed(session, event, side) {
    const payload = event?.payload ?? {};
    requireActiveRun(session, event, "tool_call_completed");
    const id = toolCallIdOf(payload);
    if (!side.openToolCalls.delete(id)) fail(`tool_call_completed 引用未开始的 tool call ${id}`);
  },

  tool_call_failed(session, event, side) {
    const payload = event?.payload ?? {};
    requireActiveRun(session, event, "tool_call_failed");
    const id = toolCallIdOf(payload);
    if (!side.openToolCalls.delete(id)) fail(`tool_call_failed 引用未开始的 tool call ${id}`);
  },

  // --- 决策与授权 ---

  decision_requested(session, event, side) {
    const payload = event?.payload ?? {};
    requireActiveRun(session, event, "decision_requested");
    const decisionId = requireString(payload.decision_id, "decision_id");
    if (side.openDecisions.has(decisionId)) fail(`decision ${decisionId} 重复请求`);
    side.openDecisions.set(decisionId, event.seq);
  },

  decision_resolved(session, event, side) {
    const payload = event?.payload ?? {};
    // 有意不对称：decision_resolved 只要求 decision 已打开，不要求活动 Run——
    // 批量顺序可能先终结 Run 再解析 decision（如停止时收尾），Run 状态与 decision
    // 闭合互不产生矛盾。开放 decision 只存在于内部 side 状态（openDecisions），
    // 不暴露在冻结 projection 中，Task 6 决定如何向用户暴露未解决确认。
    const decisionId = requireString(payload.decision_id, "decision_id");
    if (!side.openDecisions.delete(decisionId)) fail(`decision_resolved 引用未知 decision ${decisionId}`);
  },

  permission_grant_created(session, event) {
    const payload = event?.payload ?? {};
    const activeRun = requireActiveRun(session, event, "permission_grant_created");
    // 契约：grant 必须绑定 input_id，且引用的是活 input（活动或排队，覆盖
    // 同一批次内 grant 先于 consumed 到达的顺序变体）
    const inputId = requireString(payload.input_id, "input_id");
    const isLiveInput =
      activeRun.active_input_id === inputId ||
      session.queued_inputs.some((item) => item.id === inputId);
    if (!isLiveInput) {
      fail(`permission_grant_created 引用非活 input ${inputId}（既非活动输入也不在队列）`);
    }
    const grantKey = requireString(payload.grant_key, "grant_key");
    const targetClass = requireString(payload.target_class, "target_class");
    const grantId = payload.grant_id ?? payload.id ?? event.event_id;
    activeRun.active_grants.push({
      id: grantId,
      input_id: inputId,
      grant_key: grantKey,
      target_class: targetClass,
      created_at: payload.created_at ?? event.at
    });
  },

  permission_grant_cleared(session, event) {
    const payload = event?.payload ?? {};
    const run = session.active_run;
    if (!run) return; // 无 Run 时无从清除，容错跳过
    const inputId = payload.input_id ?? null;
    const grantKey = payload.grant_key ?? null;
    const grantId = payload.grant_id ?? payload.id ?? null;
    run.active_grants = run.active_grants.filter((grant) => {
      const byId = grantId != null && grant.id === grantId;
      const byInput =
        inputId != null &&
        grant.input_id === inputId &&
        (grantKey == null || grant.grant_key === grantKey);
      return !(byId || byInput);
    });
  },

  // --- 计划 ---

  plan_updated(session, event) {
    const payload = event?.payload ?? {};
    const activeRun = requireActiveRun(session, event, "plan_updated");
    const items = payload.items;
    if (!Array.isArray(items) || items.length === 0) fail("plan_updated 必须携带非空 items");
    const normalized = items.map((item, index) => {
      if (item == null || typeof item.step !== "string" || item.step.length === 0) {
        fail(`plan items[${index}].step 必须是非空字符串`);
      }
      if (!PLAN_STATUSES.includes(item.status)) {
        fail(`plan items[${index}].status 非法: ${String(item.status)}`);
      }
      // 向后兼容：旧格式 plan_updated 事件（items 无 id/description）必须能正常回放；
      // 缺 id 时按位置生成占位 id（item-<index>），比宽容通过更简单且投影形状统一
      const id = item.id === undefined ? `item-${index}` : item.id;
      if (typeof id !== "string" || id.length === 0) fail(`plan items[${index}].id 必须是非空字符串`);
      if (item.description !== undefined && typeof item.description !== "string") {
        fail(`plan items[${index}].description 必须是字符串`);
      }
      const entry = { id, step: item.step, status: item.status };
      if (typeof item.description === "string") entry.description = item.description;
      return entry;
    });
    const planIds = new Set();
    for (const item of normalized) {
      if (planIds.has(item.id)) fail(`plan 项 id 重复: ${item.id}`);
      planIds.add(item.id);
    }
    const inProgress = normalized.filter((item) => item.status === "in_progress");
    if (inProgress.length > 1) fail(`最多一个 in_progress plan 项，实际 ${inProgress.length} 个`);
    activeRun.visible_plan = {
      explanation: typeof payload.explanation === "string" ? payload.explanation : null,
      items: normalized
    };
  },

  // --- 对话正文 ---

  assistant_message_delta(session, event) {
    const payload = event?.payload ?? {};
    const activeRun = requireActiveRun(session, event, "assistant_message_delta");
    const delta = payload.text;
    if (typeof delta !== "string" || delta.length === 0) {
      fail("assistant_message_delta 必须携带非空 text");
    }
    // 在 active_run 累积正文：delta 拼接 + completed 终态对齐（或保留累积），
    // 重建 projection（重放）与实时追加得到同一结果。
    activeRun.assistant_text = (activeRun.assistant_text ?? "") + delta;
  },

  assistant_message_completed(session, event) {
    const payload = event?.payload ?? {};
    // 终态对齐：携带全文则以 payload.text 为权威最终值（覆盖累积）；不携带
    // 全文时保留 delta 序列累积的结果。assistant_text 只对「delta 已到、
    // completed 未到」的中间态有意义，completed 到达后即定稿。
    const activeRun = requireActiveRun(session, event, "assistant_message_completed");
    if (typeof payload.text === "string" && payload.text.length > 0) {
      activeRun.assistant_text = payload.text;
    }
  },

  // --- 上下文用量 ---

  context_usage_updated(session, event) {
    const payload = event?.payload ?? {};
    // Task 6：上下文用量投影（计划 §2 CONTEXT_EVENT_TYPES）。不要求活动 Run、
    // 不改变 Run 状态：只把最新 ContextUsage 深拷贝进 session.context_usage，
    // 并 bump context revision（供 UI 增量订阅）。旧 session 重放没有该事件时
    // context_usage 保持 null → UI 显示"计算中"，绝不出现假 0。
    const usage = payload.usage;
    if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
      fail("context_usage_updated 必须携带 usage 对象");
    }
    session.context_usage = structuredClone(usage);
    session.revisions = {
      ...(session.revisions ?? {}),
      context: (session.revisions?.context ?? 0) + 1
    };
  },

  // --- 压缩（Task 8：上下文压缩事件，计划 §2 CompactionProjection）---
  // 压缩是 Session 级活动：不要求活动 Run、不改变普通 Run 的 active_input_id；
  // started/running/cancelling 只更新 compaction 投影。只有 context_compaction_completed
  // 才切换 active_context_checkpoint_id；failed/cancelled 必须保持旧值。Run/input 的
  // 收敛（waiting_user/input_cancelled/run_cancelled）由 runtime 负责，reducer
  // 不隐式终结输入。

  context_compaction_started(session, event) {
    const payload = event?.payload ?? {};
    const compactionId = requireString(payload.compaction_id, "compaction_id");
    const trigger = payload.trigger;
    if (trigger !== "automatic" && trigger !== "manual") {
      fail(`context_compaction_started 的 trigger 非法: ${String(trigger)}`);
    }
    // 只拒绝并发压缩：前一个压缩尚未终结时不允许开启新的 compaction_id。
    if (
      session.compaction &&
      session.compaction.id !== compactionId &&
      COMPACTION_NON_TERMINAL_STATES.has(session.compaction.state)
    ) {
      fail(`压缩事件 compaction_id ${compactionId} 与进行中的投影 ${session.compaction.id} 不一致`);
    }
    session.compaction = {
      id: compactionId,
      trigger,
      state: "started",
      attempt: payload.attempt ?? 1,
      source_checkpoint_id: payload.source_checkpoint_id ?? null,
      checkpoint_id: payload.checkpoint_id ?? null,
      pending_input_id: payload.pending_input_id ?? null,
      error_code: null,
      started_at: payload.started_at ?? event.at,
      updated_at: event.at
    };
  },

  context_compaction_running(session, event) {
    const payload = event?.payload ?? {};
    const compactionId = requireString(payload.compaction_id, "compaction_id");
    if (session.compaction && session.compaction.id !== compactionId) {
      fail(`压缩事件 compaction_id ${compactionId} 与当前投影 ${session.compaction.id} 不一致`);
    }
    const nextState = "running";
    if (!session.compaction) {
      // 防御：running/cancel_requested 前缺少 started（如手工构造的日志）——
      // 从 payload 补投影，避免投影形状缺失。
      session.compaction = {
        id: compactionId,
        trigger: payload.trigger === "manual" ? "manual" : "automatic",
        state: nextState,
        attempt: payload.attempt ?? 1,
        source_checkpoint_id: payload.source_checkpoint_id ?? null,
        checkpoint_id: payload.checkpoint_id ?? null,
        pending_input_id: payload.pending_input_id ?? null,
        error_code: null,
        started_at: payload.started_at ?? event.at,
        updated_at: event.at
      };
    } else {
      session.compaction.state = nextState;
      session.compaction.updated_at = event.at;
    }
  },

  context_compaction_cancel_requested(session, event) {
    const payload = event?.payload ?? {};
    const compactionId = requireString(payload.compaction_id, "compaction_id");
    if (session.compaction && session.compaction.id !== compactionId) {
      fail(`压缩事件 compaction_id ${compactionId} 与当前投影 ${session.compaction.id} 不一致`);
    }
    const nextState = "cancelling";
    if (!session.compaction) {
      // 防御：running/cancel_requested 前缺少 started（如手工构造的日志）——
      // 从 payload 补投影，避免投影形状缺失。
      session.compaction = {
        id: compactionId,
        trigger: payload.trigger === "manual" ? "manual" : "automatic",
        state: nextState,
        attempt: payload.attempt ?? 1,
        source_checkpoint_id: payload.source_checkpoint_id ?? null,
        checkpoint_id: payload.checkpoint_id ?? null,
        pending_input_id: payload.pending_input_id ?? null,
        error_code: null,
        started_at: payload.started_at ?? event.at,
        updated_at: event.at
      };
    } else {
      session.compaction.state = nextState;
      session.compaction.updated_at = event.at;
    }
  },

  context_compaction_completed(session, event) {
    const payload = event?.payload ?? {};
    const compactionId = requireString(payload.compaction_id, "compaction_id");
    if (session.compaction && session.compaction.id !== compactionId) {
      fail(`压缩事件 compaction_id ${compactionId} 与当前投影 ${session.compaction.id} 不一致`);
    }
    // 只有 completed 才切换 active context 指针（候选已原子提交并落盘）。
    const checkpointId = requireString(payload.checkpoint_id, "checkpoint_id");
    session.active_context_checkpoint_id = checkpointId;
    const prev = session.compaction;
    session.compaction = {
      id: compactionId,
      trigger: prev?.trigger ?? (payload.trigger === "manual" ? "manual" : "automatic"),
      state: "completed",
      attempt: payload.attempt ?? prev?.attempt ?? 1,
      source_checkpoint_id: payload.source_checkpoint_id ?? prev?.source_checkpoint_id ?? null,
      checkpoint_id: checkpointId,
      pending_input_id: prev?.pending_input_id ?? payload.pending_input_id ?? null,
      error_code: null,
      started_at: prev?.started_at ?? payload.started_at ?? event.at,
      updated_at: event.at
    };
  },

  context_compaction_failed(session, event) {
    const payload = event?.payload ?? {};
    const compactionId = requireString(payload.compaction_id, "compaction_id");
    if (session.compaction && session.compaction.id !== compactionId) {
      fail(`压缩事件 compaction_id ${compactionId} 与当前投影 ${session.compaction.id} 不一致`);
    }
    // 失败/取消不切换 active_context_checkpoint_id（旧上下文继续生效）。
    const prev = session.compaction;
    session.compaction = {
      id: compactionId,
      trigger: prev?.trigger ?? (payload.trigger === "manual" ? "manual" : "automatic"),
      state: "failed",
      attempt: payload.attempt ?? prev?.attempt ?? 1,
      source_checkpoint_id: prev?.source_checkpoint_id ?? payload.source_checkpoint_id ?? null,
      checkpoint_id: prev?.checkpoint_id ?? payload.checkpoint_id ?? null,
      pending_input_id: prev?.pending_input_id ?? payload.pending_input_id ?? null,
      error_code: payload.error_code ?? null,
      started_at: prev?.started_at ?? payload.started_at ?? event.at,
      updated_at: event.at
    };
  },

  context_compaction_cancelled(session, event) {
    const payload = event?.payload ?? {};
    const compactionId = requireString(payload.compaction_id, "compaction_id");
    if (session.compaction && session.compaction.id !== compactionId) {
      fail(`压缩事件 compaction_id ${compactionId} 与当前投影 ${session.compaction.id} 不一致`);
    }
    // 失败/取消不切换 active_context_checkpoint_id（旧上下文继续生效）。
    const prev = session.compaction;
    session.compaction = {
      id: compactionId,
      trigger: prev?.trigger ?? (payload.trigger === "manual" ? "manual" : "automatic"),
      state: "cancelled",
      attempt: payload.attempt ?? prev?.attempt ?? 1,
      source_checkpoint_id: prev?.source_checkpoint_id ?? payload.source_checkpoint_id ?? null,
      checkpoint_id: prev?.checkpoint_id ?? payload.checkpoint_id ?? null,
      pending_input_id: prev?.pending_input_id ?? payload.pending_input_id ?? null,
      error_code: payload.error_code ?? null,
      started_at: prev?.started_at ?? payload.started_at ?? event.at,
      updated_at: event.at
    };
  },

  context_compaction_noop(session, event) {
    const payload = event?.payload ?? {};
    // 无历史可压缩：不调用模型，只记录 noop 投影（UI 显示"无需压缩"）。
    const compactionId = requireString(payload.compaction_id, "compaction_id");
    session.compaction = {
      id: compactionId,
      trigger: payload.trigger === "manual" ? "manual" : "automatic",
      state: "noop",
      attempt: payload.attempt ?? 1,
      source_checkpoint_id: null,
      checkpoint_id: null,
      pending_input_id: null,
      error_code: null,
      started_at: event.at,
      updated_at: event.at
    };
  },

  // --- 遥测 / 审计 pass-through ---

  context_volatile_degraded() {
    // 第十一轮（压缩审计发现 1）：volatile 大工具输出降级事件——纯观察/遥测，
    // 不改变 projection 状态，pass-through（与其它 context passthrough 事件一致）。
  },

  provider_retry() {
    // 第十二轮 §4.3：瞬态重试提示事件，无投影副作用（前端 work 投影直接消费）。
  },

  history_compacted() {
    // 不影响 Session projection（transcript/领域审计类事件）
  },

  checkpoint_linked() {
    // 不影响 Session projection（transcript/领域审计类事件）
  },

  journal_recovery_boundary(session, event, side) {
    // 恢复边界（Task 4）：以当前 session projection 为新的状态锚点——旧 Run 必须
    // 已收敛（恢复流程先追加 run_interrupted/input_cancelled），边界本身只清空
    // side 的开放活动集合（这些开放 tool/decision/model turn 属于被放弃的旧
    // generation，不再有后续事件闭合它们），并把 session 置 idle。从该边界开始
    // 允许用户创建新的 Run；旧 Run 一律 interrupted、不自动恢复。
    if (session.active_run && !TERMINAL_RUN_STATUSES.has(session.active_run.status)) {
      fail("journal_recovery_boundary 前必须没有活动 Run（旧 Run 应已 interrupted）");
    }
    side.openToolCalls.clear();
    side.openDecisions.clear();
    side.openModelTurns.clear();
    side.legacyOpenTurns.length = 0;
    session.status = "idle";
  },

  // --- 第九轮：系统事件注入（UI 侧恢复操作在对话流中的可见性）。pass-through：
  // 只存储不投影（不影响 Session/Run 状态），让前端通过事件流感知恢复操作。---

  chapter_rolled_back() {},

  memory_file_restored() {},

  // --- Run 终结 ---

  run_completed(session, event) {
    const activeRun = requireActiveRun(session, event, "run_completed");
    // 竞态守卫（Task 6 规格审查）：队列非空时拒绝自然终结——未消费输入不得
    // 滞留跨 Run 边界（runtime 在项目互斥锁内复查队列，此处是 reducer 兜底）。
    if (session.queued_inputs.length > 0) {
      fail(`run_completed 时队列非空（${session.queued_inputs.length} 条输入未消费），拒绝终结`);
    }
    transitionWorkClock(activeRun, "completed", event.at);
    activeRun.status = "completed";
    activeRun.active_input_id = null;
    session.status = "idle";
  },

  run_failed(session, event) {
    const activeRun = requireActiveRun(session, event, "run_failed");
    const terminalStatus = TERMINAL_EVENT_TO_STATUS.run_failed;
    transitionWorkClock(activeRun, terminalStatus, event.at);
    activeRun.status = terminalStatus;
    activeRun.active_input_id = null;
    session.status = "idle";
  },

  run_cancelled(session, event) {
    const activeRun = requireActiveRun(session, event, "run_cancelled");
    const terminalStatus = TERMINAL_EVENT_TO_STATUS.run_cancelled;
    transitionWorkClock(activeRun, terminalStatus, event.at);
    activeRun.status = terminalStatus;
    activeRun.active_input_id = null;
    session.status = "idle";
  },

  run_interrupted(session, event) {
    const activeRun = requireActiveRun(session, event, "run_interrupted");
    const terminalStatus = TERMINAL_EVENT_TO_STATUS.run_interrupted;
    transitionWorkClock(activeRun, terminalStatus, event.at);
    activeRun.status = terminalStatus;
    activeRun.active_input_id = null;
    session.status = "idle";
  }
});

// 把一条事件应用到当前 projection（reduceEvent 引导逻辑 + handler 表调度 +
// 尾部记账，与 journal.mjs 原实现逐字一致）。
export function reduceEvent(session, event, side) {
  const type = event?.type;
  const payload = event?.payload ?? {};
  if (typeof type !== "string" || !FIXED_EVENT_TYPES.includes(type)) {
    fail(`未知 journal 事件类型: ${String(type)}`);
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    fail(`事件 payload 必须是对象: ${type}`);
  }
  // event_id 全量唯一（覆盖 append 与重放两条路径）：重复即日志损坏或调用方传错。
  const eventId = requireString(event.event_id, "event_id");
  if (side.eventIds.has(eventId)) fail(`event_id ${eventId} 重复`);
  side.eventIds.add(eventId);

  if (session === null) {
    if (type !== "session_created") {
      fail(`journal 必须以 session_created 开始，实际首事件为 ${type}`);
    }
    session = createEmptySession({
      sessionId: requireString(event.session_id, "session_id"),
      projectRoot: requireString(event.project_root, "project_root"),
      at: requireString(event.at, "at")
    });
  } else if (event.session_id !== session.session_id) {
    // 单实例硬契约的兜底：同一日志流只允许同一 Session 的事件
    fail(`事件 session_id ${event.session_id} 与当前 Session ${session.session_id} 不一致`);
  }

  const handler = EVENT_HANDLERS[event.type];
  if (handler) {
    const result = handler(session, event, side);
    // handler 返回值契约：需要换出 session 的 case 返回新 session，其余无返回值
    if (result !== undefined) session = result;
  } else {
    // 表与 FIXED_EVENT_TYPES 失同步时的兜底（对账红线测试保证正常运行时不达）
    fail(`未知 journal 事件类型: ${type}`);
  }

  // session projection 记录已重放事件的最高 schema version：纯 v1 日志保持 1，
  // 追加过 v2 事件后升为 2。
  if (Number.isInteger(event.schema_version) && event.schema_version > session.schema_version) {
    session.schema_version = event.schema_version;
  }

  session.last_seq = event.seq;
  session.updated_at = event.at;
  return session;
}

// 第十二轮 F3：进程重启后的 Run 收敛矩阵（纯函数，runtime open() 消费）。
//   running       -> waiting_user（既有语义：等待用户，绝不自动模型调用）
//   waiting_user  -> 不收敛（审核修订 P0-1：TERMINAL_RUN_STATUSES 不含
//                    waiting_user，必须先于兜底分支排除——否则等待中的会话
//                    会被误中断；Step 3.1 断言 [] 即此口径）
//   stopping/interrupting -> run_interrupted（停止意图已表达，interrupted 可 retry）
//   终态/null -> 不收敛
export function buildProcessRestartedConvergence(run) {
  if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return [];
  if (run.status === "waiting_user") return [];
  if (run.status === "running") {
    return [{
      type: "run_status_changed",
      run_id: run.id,
      payload: { status: "waiting_user", reason: "process_restarted", resume_run_status: null }
    }];
  }
  return [{ type: "run_interrupted", run_id: run.id, payload: { reason: "process_restarted" } }];
}