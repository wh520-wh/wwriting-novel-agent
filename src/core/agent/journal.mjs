// src/core/agent/journal.mjs
//
// 项目级 Agent journal（统一 Agent 内核计划 Task 2；Task 4 起物理层分段化）。
//
// journal 是 Agent 状态的唯一真相源（计划 Rule 9）：事件日志记录 Session/Run/
// queue/plan/decision/grant/activity 的全部事件；session.json 是可重建的 Session/Run
// projection；transcript 只保存合法模型消息链与历史摘要，不承担产品状态；
// migration.json 标记一次性 legacy 导入（Task 7 使用）；checkpoints/ 为预留目录。
//
// 存储布局（agentDir = storageRoot，默认 <projectRoot>/.wwriting/agent/ 仅供低层
// 兼容测试；生产组合根必须显式传应用私有 storageRoot）：
//   segments/events/*.jsonl        —— canonical source（分段 JSONL，可轮转）
//   segments/transcript/*.jsonl    —— 模型消息链/历史摘要（同分段格式）
//   journal-manifest.json          —— 派生数据（generation/roots/last seqs/gaps）
//   session.json                   —— 可重建 projection（每次追加后原子重写）
//   migration.json                 —— { schema_version: 1, legacy_imported: false, project_agent_imported: false }
//   checkpoints/                   —— 预留目录
//
// 物理 I/O（追加/读取/轮转/索引/legacy 迁移）全部委托给 journal-segments.mjs 的
// segment store；本模块只保留 reducer、事件盖章、投影与恢复编排。事件 JSONL 是
// 真相；manifest 与 .index.json 都是可删除重建的派生数据。旧单体 events.jsonl /
// transcript.jsonl 只在一次性 legacy 迁移时出现（导入后改名为 *.legacy.jsonl）；
// runtime 不得再依赖这两个路径判断当前存储。
//
// 崩溃模型：appendBatch 先分配连续 seq、对克隆状态严格校验（dry-run，违规在落盘前
// 拒绝），再追加完整 JSON 行到 segment store，最后原子重写 session.json（临时文件 +
// rename，复用 fs-utils.writeJsonAtomic，Windows 兼容）。两步之间崩溃时 session.json
// 落后于事件日志，由下一次 load() 在同一把锁内重放 journal 并修复 projection。
// load() 还负责恢复：segment 中间损坏被隔离为 .corrupt（manifest 记录 gap，绝不
// 猜测跳过）；缺失尾部（不完整的最后一行 = 崩溃痕迹）截断修复；"dangling assistant
// 活动"（未闭合的 model turn / tool call）的 Run 不能恢复执行，恢复逻辑把其不可恢复
// grant 全部清除并把 Run 标记为 interrupted（对应事件 run_interrupted），绝不让这种
// 状态被交给 provider。存在中间 gap 时以有效的 session.json 为只读恢复锚点，清除
// active Run/queued inputs 并追加 journal_recovery_boundary（resume_allowed:false）。
//
// 投影写入语义：session.json 是可重建的尽力而为缓存，事件日志才是真相源。
// append/appendBatch 的 resolve 只与事件实际落盘绑定；session.json 原子重写失败
//（磁盘满/权限）不阻断追加也不抛错，失败信息通过 journal.projection_write_error
// 暴露，下一次 load() 会重放修复。append/appendBatch/load/getSession 返回的都是
// projection 的独立副本，调用方篡改返回值不会污染内部状态。
//
// 单实例硬契约：同一 projectRoot 在同一进程内只允许一个 journal 实例。每实例持有
// 一个进程内异步互斥锁，不同项目（不同实例）互不共享锁、可以并行（计划 Rule 3）；
// 但同项目多实例/跨进程并发写不受保护（无文件锁）。reducer 兜底校验事件
// session_id 与当前 Session 一致，跨 Session 事件混入同一日志流会被拒绝。
//
// 深模块内部实现：生产调用方只能经 src/core/agent/index.mjs 使用；tests/agent/ 可以
// 直接测试本模块内部 seam。
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, pathExists, readJson, writeJsonAtomic } from "../fs-utils.mjs";
import { createJournalSegmentStore } from "./journal-segments.mjs";

// 计划固定的 32 个 journal 事件类型；未知类型一律拒绝。
export const FIXED_EVENT_TYPES = Object.freeze([
  "session_created",
  "run_started",
  "run_status_changed",
  "input_queued",
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
  "workflow_changed",
  "plan_updated",
  "reasoning_completed",
  "reasoning_delta",
  "history_compacted",
  "checkpoint_linked",
  "assistant_message_delta",
  "assistant_message_completed",
  "run_completed",
  "run_failed",
  "run_cancelled",
  "run_interrupted",
  "journal_recovery_boundary"
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

export const WORKFLOWS = Object.freeze(["general", "chapter", "init"]);
export const PLAN_STATUSES = Object.freeze(["pending", "in_progress", "completed"]);

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

// 有效工作时钟状态（transitionWorkClock 复用；模块级常量避免每次调用重建 Set）。
const WORK_CLOCK_ACTIVE_STATUSES = new Set(["running", "interrupting", "stopping"]);

const TERMINAL_EVENT_TO_STATUS = Object.freeze({
  run_completed: "completed",
  run_failed: "failed",
  run_cancelled: "cancelled",
  run_interrupted: "interrupted"
});

// 新追加事件的 schema version（Task 3 起为 2）：reducer 同时接受旧 v1 与 v2
// 事件（v1 重放走 legacy 分支），session projection 记录已重放事件的最高版本。
const EVENT_SCHEMA_VERSION = 2;

// Run 状态到 Session 状态的映射：终结的 Run 使 Session 回到 idle。
const RUN_STATUS_TO_SESSION = Object.freeze({
  running: "running",
  waiting_user: "waiting_user",
  interrupting: "interrupting",
  stopping: "stopping",
  completed: "idle",
  failed: "idle",
  cancelled: "idle",
  interrupted: "idle"
});

function fail(message) {
  throw new Error(message);
}

function defaultClock() {
  return Date.now();
}

function defaultIdFactory() {
  return randomUUID();
}

// clock 允许返回毫秒时间戳或 ISO-8601 字符串；统一归一化为 ISO-8601。
function normalizeAt(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) fail(`非法时间值: ${String(value)}`);
  return date.toISOString();
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) fail(`${name} 必须是非空字符串`);
  return value;
}

function toolCallIdOf(payload) {
  return requireString(payload.tool_call_id ?? payload.id, "tool_call_id");
}

// 进程内异步互斥锁：同一 journal 实例的所有操作（load/append/appendBatch/read/
// transcript）串行执行；不同实例各自持有独立锁，互不共享。
function createMutex() {
  let tail = Promise.resolve();
  return {
    run(task) {
      const result = tail.then(() => task());
      tail = result.then(() => undefined, () => undefined);
      return result;
    }
  };
}

function createEmptySession({ sessionId, projectRoot, at }) {
  return {
    schema_version: 1,
    session_id: sessionId,
    project_root: projectRoot,
    status: "idle",
    active_run: null,
    queued_inputs: [],
    last_seq: 0,
    updated_at: at
  };
}

function createRun(event, { workflow, inputId }) {
  return {
    id: event.run_id,
    status: "running",
    workflow,
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

// ---------------------------------------------------------------------------
// Session/Run reducer（内部实现）：把一条事件应用到当前 projection。
// 严格校验：未知事件类型、两个 active Run、consumed input 残留队列、
// 两个 in_progress plan 项、无 retry 的 terminal→running 转换等一律拒绝。
// ---------------------------------------------------------------------------

function createSideState() {
  return {
    eventIds: new Set(), // 全量 event_id（reducer 去重校验，含重放路径）
    openToolCalls: new Map(), // tool_call_id -> 开始事件的 seq
    openModelTurns: new Map(), // v2 turn_id -> { seq, reasoningCompleted }（供崩溃恢复检测）
    legacyOpenTurns: [], // v1 旧日志重放时的未闭合 turn 栈（legacy-<event_id>）
    openDecisions: new Map(), // decision_id -> seq
    terminalInputs: new Set(), // 已 consumed/cancelled 的 input id
    inputMeta: new Map() // input_id -> { id, text, status, queued_at }（re-queue 用）
  };
}

function reduceEvent(session, event, side) {
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

  const run = session.active_run;

  // 需要活动（非终结）Run 的事件：校验 run 存在、未终结、run_id 一致。
  const requireActiveRun = (what) => {
    if (!run) fail(`${what} 需要活动 Run，但当前没有 Run`);
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      fail(`${what} 需要非终结 Run，但 Run ${run.id} 已处于 ${run.status}`);
    }
    if (event.run_id != null && event.run_id !== run.id) {
      fail(`${what} 的 run_id ${event.run_id} 与活动 Run ${run.id} 不一致`);
    }
    return run;
  };

  switch (type) {
    case "session_created": {
      if (session.last_seq !== 0) fail("session_created 必须是 journal 的第一条事件");
      break;
    }

    case "run_started": {
      const workflow = payload.workflow ?? "general";
      if (!WORKFLOWS.includes(workflow)) fail(`未知 workflow: ${workflow}`);
      const inputId = payload.input_id ?? null;
      if (inputId !== null) requireString(inputId, "input_id");
      if (event.run_id == null) fail("run_started 必须携带 run_id");
      if (run) {
        if (!TERMINAL_RUN_STATUSES.has(run.status)) {
          fail(`两个 active Run：Run ${run.id} 尚在 ${run.status}，拒绝启动 ${event.run_id}`);
        }
        if (run.id === event.run_id) {
          // retry：恢复同一可恢复 Run（保留 workflow/started_at/visible_plan/累计
          // 有效耗时）；正文增量按尝试重置（新尝试的 delta 从空开始累积）。
          // 工作时钟：保留 active_elapsed_ms 并重新设置 active_since。
          transitionWorkClock(run, "running", event.at);
          run.status = "running";
          session.status = "running";
          run.assistant_text = null;
        } else {
          session.active_run = createRun(event, { workflow, inputId });
          session.status = "running";
        }
      } else {
        session.active_run = createRun(event, { workflow, inputId });
        session.status = "running";
      }
      // 新 Run（或恢复的 Run）认领活动输入：从队列移除，避免 consumed input 残留队列
      if (inputId !== null) activateInput(session, inputId);
      break;
    }

    case "run_status_changed": {
      const target = payload.status;
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
      break;
    }

    case "input_queued": {
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
      session.queued_inputs.push(item);
      side.inputMeta.set(inputId, item);
      break;
    }

    case "input_consumed": {
      const inputId = requireString(payload.input_id, "input_id");
      const activeRun = requireActiveRun("input_consumed");
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
      break;
    }

    case "input_cancelled": {
      // 已知边角（Task 6 规格审查记录，Task 9/11 全量验证时评估，不改行为）：
      // 一条已被 input_consumed「切换激活」消费过的输入，若随后被 input_promoted
      // 放回队列、再次经 input_consumed 重新激活，则 stop 路径追加的 input_cancelled
      // 会给它产生第二个终态事件（本分支对活动输入不查 terminalInputs），与
      //「每条 input 恰好一个终态事件」的字面不变量冲突。冻结验收/agent 场景均不
      // 覆盖此链路（promote 后该输入立即重新被处理，stop 不会落在未消费的活动输入
      // 上）；如需严格化，应在 reducer 侧校验或由 runtime 的 stop 收敛跳过已终结输入。
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
      side.terminalInputs.add(inputId);
      break;
    }

    case "input_promoted": {
      const inputId = requireString(payload.input_id, "input_id");
      const activeRun = requireActiveRun("input_promoted");
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
      break;
    }

    case "interrupt_requested": {
      const activeRun = requireActiveRun("interrupt_requested");
      // 停止优先于中断（Task 6 规格审查）：Run 已进入 stopping 后拒绝再写入
      // interrupt_requested，防止「立即」击穿「停止」（promote 的预检查只是
      // 第一道防线，reducer 是 journal 锁内的唯一串行化兜底）。
      if (activeRun.status === "stopping") {
        fail(`Run ${run.id} 正在停止，不能写入 interrupt_requested`);
      }
      transitionWorkClock(activeRun, "interrupting", event.at);
      activeRun.status = "interrupting";
      session.status = "interrupting";
      break;
    }

    case "interrupt_safe_point_reached": {
      const activeRun = requireActiveRun("interrupt_safe_point_reached");
      transitionWorkClock(activeRun, "running", event.at);
      activeRun.status = "running";
      session.status = "running";
      break;
    }

    case "model_turn_started": {
      const activeRun = requireActiveRun("model_turn_started");
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
        break;
      }
      requireString(turnId, "turn_id");
      requireString(payload.input_id, "input_id");
      requireString(payload.reasoning_capability, "reasoning_capability");
      if (side.openModelTurns.has(turnId)) fail(`model turn ${turnId} 重复开始`);
      side.openModelTurns.set(turnId, { seq: event.seq, reasoningCompleted: false });
      break;
    }

    case "model_turn_completed": {
      requireActiveRun("model_turn_completed");
      const turnId = payload.turn_id;
      if (turnId == null) {
        if (event.schema_version !== 1) fail("model_turn_completed 必须携带 turn_id");
        const legacyId = side.legacyOpenTurns.pop();
        if (!legacyId) fail("model_turn_completed 没有对应的 model_turn_started");
        break;
      }
      requireString(turnId, "turn_id");
      requireString(payload.input_id, "input_id");
      const outcome = requireString(payload.outcome, "outcome");
      if (!["completed", "failed", "cancelled"].includes(outcome)) {
        fail(`model_turn_completed 的 outcome 非法: ${String(outcome)}`);
      }
      // completed 只出现一次：delete 失败即该 turn 尚未开始或已闭合
      if (!side.openModelTurns.delete(turnId)) fail(`model_turn_completed 引用未开始的 turn ${turnId}`);
      break;
    }

    case "reasoning_delta": {
      requireActiveRun("reasoning_delta");
      const turnId = requireString(payload.turn_id, "turn_id");
      if (!side.openModelTurns.has(turnId)) fail(`reasoning_delta 引用未知 turn ${turnId}`);
      requireString(payload.text, "text");
      requireString(payload.input_id, "input_id");
      break;
    }

    case "reasoning_completed": {
      requireActiveRun("reasoning_completed");
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
      break;
    }

    case "tool_call_started": {
      requireActiveRun("tool_call_started");
      const id = toolCallIdOf(payload);
      if (side.openToolCalls.has(id)) fail(`tool call ${id} 重复开始`);
      side.openToolCalls.set(id, event.seq);
      break;
    }

    case "tool_output_delta": {
      requireActiveRun("tool_output_delta");
      const id = toolCallIdOf(payload);
      if (!side.openToolCalls.has(id)) fail(`tool_output_delta 引用未开始的 tool call ${id}`);
      break;
    }

    case "tool_call_completed": {
      requireActiveRun("tool_call_completed");
      const id = toolCallIdOf(payload);
      if (!side.openToolCalls.delete(id)) fail(`tool_call_completed 引用未开始的 tool call ${id}`);
      break;
    }

    case "tool_call_failed": {
      requireActiveRun("tool_call_failed");
      const id = toolCallIdOf(payload);
      if (!side.openToolCalls.delete(id)) fail(`tool_call_failed 引用未开始的 tool call ${id}`);
      break;
    }

    case "decision_requested": {
      requireActiveRun("decision_requested");
      const decisionId = requireString(payload.decision_id, "decision_id");
      if (side.openDecisions.has(decisionId)) fail(`decision ${decisionId} 重复请求`);
      side.openDecisions.set(decisionId, event.seq);
      break;
    }

    case "decision_resolved": {
      // 有意不对称：decision_resolved 只要求 decision 已打开，不要求活动 Run——
      // 批量顺序可能先终结 Run 再解析 decision（如停止时收尾），Run 状态与 decision
      // 闭合互不产生矛盾。开放 decision 只存在于内部 side 状态（openDecisions），
      // 不暴露在冻结 projection 中，Task 6 决定如何向用户暴露未解决确认。
      const decisionId = requireString(payload.decision_id, "decision_id");
      if (!side.openDecisions.delete(decisionId)) fail(`decision_resolved 引用未知 decision ${decisionId}`);
      break;
    }

    case "permission_grant_created": {
      const activeRun = requireActiveRun("permission_grant_created");
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
      break;
    }

    case "permission_grant_cleared": {
      if (!run) break; // 无 Run 时无从清除，容错跳过
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
      break;
    }

    case "workflow_changed": {
      const activeRun = requireActiveRun("workflow_changed");
      const workflow = requireString(payload.workflow, "workflow");
      if (!WORKFLOWS.includes(workflow)) fail(`未知 workflow: ${workflow}`);
      activeRun.workflow = workflow;
      break;
    }

    case "plan_updated": {
      const activeRun = requireActiveRun("plan_updated");
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
      break;
    }

    case "assistant_message_delta": {
      const activeRun = requireActiveRun("assistant_message_delta");
      const delta = payload.text;
      if (typeof delta !== "string" || delta.length === 0) {
        fail("assistant_message_delta 必须携带非空 text");
      }
      // 在 active_run 累积正文：delta 拼接 + completed 终态对齐（或保留累积），
      // 重建 projection（重放）与实时追加得到同一结果。
      activeRun.assistant_text = (activeRun.assistant_text ?? "") + delta;
      break;
    }

    case "assistant_message_completed": {
      // 终态对齐：携带全文则以 payload.text 为权威最终值（覆盖累积）；不携带
      // 全文时保留 delta 序列累积的结果。assistant_text 只对「delta 已到、
      // completed 未到」的中间态有意义，completed 到达后即定稿。
      const activeRun = requireActiveRun("assistant_message_completed");
      if (typeof payload.text === "string" && payload.text.length > 0) {
        activeRun.assistant_text = payload.text;
      }
      break;
    }

    case "history_compacted":
    case "checkpoint_linked":
      // 不影响 Session projection（transcript/领域审计类事件）
      break;

    case "journal_recovery_boundary": {
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
      break;
    }

    case "run_completed": {
      const activeRun = requireActiveRun("run_completed");
      // 竞态守卫（Task 6 规格审查）：队列非空时拒绝自然终结——未消费输入不得
      // 滞留跨 Run 边界（runtime 在项目互斥锁内复查队列，此处是 reducer 兜底）。
      if (session.queued_inputs.length > 0) {
        fail(`run_completed 时队列非空（${session.queued_inputs.length} 条输入未消费），拒绝终结`);
      }
      transitionWorkClock(activeRun, "completed", event.at);
      activeRun.status = "completed";
      activeRun.active_input_id = null;
      session.status = "idle";
      break;
    }

    case "run_failed":
    case "run_cancelled":
    case "run_interrupted": {
      const activeRun = requireActiveRun(type);
      const terminalStatus = TERMINAL_EVENT_TO_STATUS[type];
      transitionWorkClock(activeRun, terminalStatus, event.at);
      activeRun.status = terminalStatus;
      activeRun.active_input_id = null;
      session.status = "idle";
      break;
    }

    default:
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

// ---------------------------------------------------------------------------
// createAgentJournal：journal 实例工厂
//
// 单实例硬契约：同一 projectRoot 在同一进程内只允许一个 journal 实例（见文件头）。
// 进程重启（跨进程）恢复通过新实例 load() 完成——旧实例已退出，不存在并发写。
// ---------------------------------------------------------------------------

export function createAgentJournal({
  projectRoot,
  storageRoot = path.join(path.resolve(projectRoot), ".wwriting", "agent"),
  clock = defaultClock,
  idFactory = defaultIdFactory
} = {}) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    fail("projectRoot 必须是项目根目录");
  }
  const root = path.resolve(projectRoot);
  const agentDir = path.resolve(storageRoot);
  const sessionPath = path.join(agentDir, "session.json");
  const migrationPath = path.join(agentDir, "migration.json");
  const checkpointsDir = path.join(agentDir, "checkpoints");
  // 旧单体格式文件只用于一次性 legacy 迁移（导入后改名为 *.legacy.jsonl）
  const legacyEventsPath = path.join(agentDir, "events.jsonl");
  const legacyTranscriptPath = path.join(agentDir, "transcript.jsonl");
  // 物理 I/O 全部委托给 segment store（Task 4）；manifest 为两个 stream 共享
  const manifestPath = path.join(agentDir, "journal-manifest.json");
  const eventsStore = createJournalSegmentStore({
    root: path.join(agentDir, "segments", "events"),
    streamName: "events",
    manifestPath
  });
  const transcriptStore = createJournalSegmentStore({
    root: path.join(agentDir, "segments", "transcript"),
    streamName: "transcript",
    manifestPath
  });
  const mutex = createMutex();

  let loaded = false;
  let state = null; // reduceEvents 的结果：{ session, openToolCalls, ... }
  let projectionWriteError = null; // 最近一次 session.json 写入失败（尽力而为语义）

  // load() 必须惰性创建 agentDir（storageRoot）、checkpoints/ 与 migration.json。
  // 新格式 journal 不再创建单体 events.jsonl/transcript.jsonl（旧文件只出现在
  // legacy 迁移场景，由 migrateLegacy 处理）。
  async function ensureStorage() {
    await ensureDir(agentDir);
    await ensureDir(checkpointsDir);
    if (!(await pathExists(migrationPath))) {
      await writeJsonAtomic(migrationPath, { schema_version: 1, legacy_imported: false, project_agent_imported: false });
    }
  }

  // 旧单体格式一次性迁移：events.jsonl/transcript.jsonl → segments，原文件改名
  // *.legacy.jsonl。只在检测到旧文件时执行；幂等由 store.importLegacy 保证。
  async function migrateLegacy() {
    const [hasEvents, hasTranscript] = await Promise.all([
      pathExists(legacyEventsPath),
      pathExists(legacyTranscriptPath)
    ]);
    if (hasEvents) {
      await eventsStore.importLegacy({ filePath: legacyEventsPath, kind: "events" });
    }
    if (hasTranscript) {
      await transcriptStore.importLegacy({ filePath: legacyTranscriptPath, kind: "transcript" });
    }
  }

  // 读取 session.json 恢复锚点；不可读/形状非法返回 null（走全量重放）。
  async function readSessionAnchor() {
    try {
      if (!(await pathExists(sessionPath))) return null;
      const parsed = JSON.parse(await fs.readFile(sessionPath, "utf8"));
      if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      if (typeof parsed.session_id !== "string" || parsed.session_id.length === 0) return null;
      if (!Number.isInteger(parsed.last_seq) || parsed.last_seq < 0) return null;
      return { projection: parsed, session_id: parsed.session_id, last_seq: parsed.last_seq };
    } catch {
      return null;
    }
  }

  // 锚点有效性：session_id 与日志首事件一致、last_seq 不超过日志末尾、且日志确实
  // 存在 seq == last_seq 的事件（"last_seq 对应事件 id"校验）。
  async function isAnchorValid(anchor) {
    if (!anchor) return false;
    const first = (await eventsStore.readAfter({ afterSeq: 0, limit: 1 })).events[0];
    if (!first || first.session_id !== anchor.session_id) return false;
    if (anchor.last_seq > eventsStore.lastSeq) return false;
    if (anchor.last_seq > 0) {
      const at = (await eventsStore.readAfter({ afterSeq: anchor.last_seq - 1, limit: 1 })).events[0];
      if (!at || at.seq !== anchor.last_seq) return false;
    }
    return true;
  }

  // 空 journal 的第一次锁定 load：在锁内发明 Session id 并追加 session_created。
  // 新建 generation 必须先写 manifest（store.load 已创建）再写第一条 session_created。
  async function createFirstSession(side) {
    const sessionId = idFactory(); // 契约：Session id 先于 event_id 生成（旧测试断言 id-1）
    const first = {
      schema_version: 1,
      seq: 1,
      event_id: idFactory(),
      session_id: sessionId,
      run_id: null,
      project_root: root,
      type: "session_created",
      at: normalizeAt(clock()),
      payload: {}
    };
    await eventsStore.append([first]);
    return reduceEvent(null, first, side);
  }

  // 常规恢复：锚点有效时只重放 last_seq 之后的事件（避免百万事件全量重放）；
  // 否则流式全量重放（单次只保留当前行与 reducer state，不整日志读入内存）。
  async function buildState(anchor) {
    if (anchor && (await isAnchorValid(anchor))) {
      const { events } = await eventsStore.readAfter({ afterSeq: anchor.last_seq, limit: null });
      const session = structuredClone(anchor.projection);
      const side = createSideState();
      for (const event of events) {
        session = reduceEvent(session, event, side);
      }
      return { session, ...side };
    }
    let session = null;
    const side = createSideState();
    for await (const event of eventsStore.streamAll()) {
      session = reduceEvent(session, event, side);
    }
    if (session === null) {
      session = await createFirstSession(side);
    }
    return { session, ...side };
  }

  // 中间坏段（gap）恢复：不能全量重放（reducer 不能猜测跳过缺口）。
  // session.json 有效 → 以它为只读恢复锚点，投影标记 history_degraded，
  // 健康尾部事件仍重放；随后由 appendGapRecovery 追加收敛事件与边界。
  // 锚点也无效 → 只读打开健康历史（标记 needs_history_clear，等 Task 5 清空）。
  async function degradedState(anchor) {
    const side = createSideState();
    if (anchor && (await isAnchorValid(anchor))) {
      const session = structuredClone(anchor.projection);
      session.history_degraded = true;
      const { events } = await eventsStore.readAfter({ afterSeq: anchor.last_seq, limit: null });
      for (const event of events) {
        session = reduceEvent(session, event, side);
      }
      return { session, ...side };
    }
    // 投影也无效：用健康历史首事件的 session_id 保持身份，其余置为确定的空状态，
    // 不在缺失状态上猜测 tool/decision 是否打开。
    const first = (await eventsStore.readAfter({ afterSeq: 0, limit: 1 })).events[0];
    const session = createEmptySession({
      sessionId: first?.session_id ?? idFactory(),
      projectRoot: root,
      at: normalizeAt(clock())
    });
    session.history_degraded = true;
    session.needs_history_clear = true;
    return { session, ...side };
  }

  // gap 恢复事件：先取消活动输入与排队输入（活动输入必须在 run_interrupted 之前
  // 收敛），再标记旧 Run interrupted，最后追加 journal_recovery_boundary
  //（携带 gap 范围与 resume_allowed:false）。
  async function appendGapRecovery(gaps) {
    const batch = [];
    const run = state.session.active_run;
    if (run?.active_input_id != null) {
      batch.push({ type: "input_cancelled", run_id: run.id, payload: { input_id: run.active_input_id } });
    }
    for (const item of state.session.queued_inputs) {
      batch.push({ type: "input_cancelled", run_id: run?.id ?? null, payload: { input_id: item.id } });
    }
    if (run && !TERMINAL_RUN_STATUSES.has(run.status)) {
      batch.push({ type: "run_interrupted", run_id: run.id, payload: { reason: "recovery_history_gap" } });
    }
    const gap = gaps[0];
    batch.push({
      type: "journal_recovery_boundary",
      payload: {
        gap_start: gap?.start_seq ?? null,
        gap_end: gap?.end_seq ?? null,
        reason: gap?.reason ?? "segment_corrupt",
        resume_allowed: false
      }
    });
    if (batch.length > 0) await appendBatchLocked(batch);
  }

  // 必须在 mutex 内调用。首次 load：创建存储布局 → 迁移旧单体格式 → 按恢复策略
  // 建立 projection → 追加恢复事件 → 写出第一份 session.json。
  async function initialize() {
    if (loaded) return;
    await ensureStorage();
    await eventsStore.load();
    await transcriptStore.load();
    await migrateLegacy();
    const gaps = eventsStore.gaps;
    const anchor = await readSessionAnchor();
    if (gaps.length > 0) {
      state = await degradedState(anchor);
      await appendGapRecovery(gaps);
    } else {
      state = await buildState(anchor);
      const dangling = detectDangling(state);
      if (dangling) {
        // 崩溃恢复：dangling assistant 活动的 Run 不能恢复执行（绝不能把这种状态发
        // 给 provider）——先清除其全部不可恢复 grant（计划权限生命周期规则），闭合
        // 崩溃遗留的未解决 decision（保证"每条 decision 收敛"），再把 Run 标记为
        // interrupted。
        const recoveryBatch = [];
        for (const grant of state.session.active_run.active_grants) {
          recoveryBatch.push({
            type: "permission_grant_cleared",
            run_id: state.session.active_run.id,
            payload: { input_id: grant.input_id, grant_key: grant.grant_key, grant_id: grant.id }
          });
        }
        for (const decisionId of state.openDecisions.keys()) {
          recoveryBatch.push({
            type: "decision_resolved",
            run_id: state.session.active_run.id,
            payload: { decision_id: decisionId, choice: "cancelled", reason: "recovery_dangling_decision" }
          });
        }
        recoveryBatch.push({
          type: "run_interrupted",
          run_id: state.session.active_run.id,
          payload: { reason: "recovery_dangling_assistant_activity" }
        });
        await appendBatchLocked(recoveryBatch);
      }
    }
    await writeSessionJson();
    loaded = true;
  }

  // 由 journal 统一盖章：seq/event_id/at/session_id/project_root/schema_version。
  // 调用方传入的 at 同样归一化为 ISO-8601；event_id 唯一性由 reducer 校验
  //（side.eventIds 全量去重，覆盖调用方传入与 idFactory 生成两种来源）。
  function stampEvent(base, seq) {
    if (base == null || typeof base !== "object") fail("事件必须是对象");
    if (typeof base.type !== "string") fail("事件必须携带 type");
    return {
      schema_version: EVENT_SCHEMA_VERSION,
      seq,
      event_id: base.event_id ?? idFactory(),
      session_id: state.session.session_id,
      run_id: base.run_id ?? null,
      project_root: root,
      type: base.type,
      at: normalizeAt(base.at ?? clock()),
      payload: base.payload ?? {}
    };
  }

  function cloneSide(side) {
    return {
      eventIds: new Set(side.eventIds),
      openToolCalls: new Map(side.openToolCalls),
      openModelTurns: new Map(side.openModelTurns),
      legacyOpenTurns: [...side.legacyOpenTurns],
      openDecisions: new Map(side.openDecisions),
      terminalInputs: new Set(side.terminalInputs),
      inputMeta: new Map(side.inputMeta)
    };
  }

  function cloneState(current) {
    return { session: structuredClone(current.session), ...cloneSide(current) };
  }

  // dangling assistant 活动：非终结 Run 上存在未闭合 model turn（v2 按 turn_id、
  // v1 按 legacy 栈）或 tool call。
  function detectDangling(current) {
    const run = current.session.active_run;
    if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return null;
    if (current.openModelTurns.size > 0 || current.legacyOpenTurns.length > 0 || current.openToolCalls.size > 0) {
      return run;
    }
    return null;
  }

  // 尽力而为的投影写入：session.json 可重建（事件日志才是真相源），写入失败
  //（磁盘满/权限）不阻断 append、不抛错——通过 journal.projection_write_error 暴露
  // 给观察者，下一次 load() 会重放修复。append 的 resolve/reject 只与事件日志的
  // 实际落盘绑定，与投影写入成功与否无关。
  async function writeSessionJson() {
    try {
      await writeJsonAtomic(sessionPath, state.session);
      projectionWriteError = null;
    } catch (error) {
      projectionWriteError = {
        at: normalizeAt(clock()),
        message: error?.message ?? String(error),
        code: error?.code ?? null
      };
    }
  }

  // 必须在 mutex 内调用。顺序：分配连续 seq → 对克隆状态严格 dry-run（任何不变量
  // 违规在落盘前拒绝，journal 不被污染）→ 追加完整 JSON 行到 segment store →
  // 提交状态 → 原子重写 session.json。
  async function appendBatchLocked(batch) {
    if (state == null) fail("journal 尚未初始化");
    if (!Array.isArray(batch)) fail("appendBatch 需要事件数组");
    if (batch.length === 0) return state.session;
    const stamped = [];
    let seq = state.session.last_seq;
    for (const base of batch) {
      seq += 1;
      stamped.push(stampEvent(base, seq));
    }
    const nextState = cloneState(state);
    for (const event of stamped) {
      nextState.session = reduceEvent(nextState.session, event, nextState);
    }
    await eventsStore.append(stamped);
    state = nextState;
    await writeSessionJson();
    return state.session;
  }

  // 恢复 journal：创建目录、重放事件、修复 projection、处理 dangling 恢复。
  // 返回当前 Session projection。
  async function load() {
    return mutex.run(async () => {
      await initialize();
      return structuredClone(state.session);
    });
  }

  // migration 标记：一次性迁移状态（migration.json 位于应用私有 agentDir，绝不
  // 落在项目目录）。由更老的 legacy flat-file 导入（legacy-import.mjs）读写；
  // 本模块不自行决定标记值，只提供读写通道。
  async function readMigration() {
    await initialize();
    return readJson(migrationPath, { schema_version: 1, legacy_imported: false, project_agent_imported: false });
  }

  async function writeMigration(value) {
    await writeJsonAtomic(migrationPath, value);
  }

  // 追加单条事件（自动初始化，分配下一个连续 seq，重写 session.json）。
  // 返回 projection 的独立副本：调用方篡改返回值不会污染内部状态。
  async function append(event) {
    return mutex.run(async () => {
      await initialize();
      const session = await appendBatchLocked([event]);
      return structuredClone(session);
    });
  }

  // 追加一批事件：分配连续 seq，同一批次原子生效（如 interrupt_requested +
  // input_promoted 的"立即"操作）。返回 projection 的独立副本。
  async function appendBatch(events) {
    return mutex.run(async () => {
      await initialize();
      const session = await appendBatchLocked(events);
      return structuredClone(session);
    });
  }

  // 返回当前 Session projection（只读副本）。
  async function getSession() {
    return mutex.run(async () => {
      await initialize();
      return structuredClone(state.session);
    });
  }

  // 原始事件读取（seq > afterSeq，最多 limit 条，默认全部）。委托 segment store。
  // 不触发初始化/恢复——那些只由 load() 负责（Task 6 的 open() 会先调用 load()）；
  // 消费者应在首次 read 前调用 load()，否则拿到的可能是未迁移/未修复的原始内容。
  async function read({ afterSeq = 0, limit } = {}) {
    return mutex.run(async () => {
      const { events } = await eventsStore.readAfter({ afterSeq, limit });
      return events;
    });
  }

  // 尾部分页/倒序读取（Task 5 分页 API 的物理基础；Task 4 提供委托）。
  async function readTail({ limit } = {}) {
    return mutex.run(async () => {
      await initialize();
      return eventsStore.readTail({ limit });
    });
  }

  async function readBefore({ beforeSeq, limit } = {}) {
    return mutex.run(async () => {
      await initialize();
      return eventsStore.readBefore({ beforeSeq, limit });
    });
  }

  async function readAfter({ afterSeq = 0, limit } = {}) {
    return mutex.run(async () => {
      await initialize();
      return eventsStore.readAfter({ afterSeq, limit });
    });
  }

  // transcript 与 Session projection 无关：只追加合法模型消息链与历史摘要。
  // 每条新 record 由 Journal 盖 transcript_seq（store 用它排序/分页）。
  async function appendTranscript(record) {
    return mutex.run(async () => {
      if (record == null || typeof record !== "object" || Array.isArray(record)) {
        fail("transcript record 必须是对象");
      }
      await initialize();
      const stamped = { ...record, transcript_seq: transcriptStore.lastSeq + 1 };
      await transcriptStore.append([stamped]);
    });
  }

  async function readTranscript() {
    return mutex.run(async () => {
      await initialize();
      const { events } = await transcriptStore.readAfter({ afterSeq: 0 });
      return events;
    });
  }

  // 分页读取（runtime 后续切换，不再全量读单文件）。
  async function readTranscriptAfter({ afterSeq = 0, limit } = {}) {
    return mutex.run(async () => {
      await initialize();
      const { events } = await transcriptStore.readAfter({ afterSeq, limit });
      return events;
    });
  }

  async function readTranscriptTail({ limit } = {}) {
    return mutex.run(async () => {
      await initialize();
      const { events } = await transcriptStore.readTail({ limit });
      return events;
    });
  }

  const journal = {
    load,
    readMigration,
    writeMigration,
    append,
    appendBatch,
    read,
    readTail,
    readBefore,
    readAfter,
    getSession,
    appendTranscript,
    readTranscript,
    readTranscriptAfter,
    readTranscriptTail
  };
  // 可观察字段：最近一次 session.json 写入失败（尽力而为语义），成功写入后为 null。
  Object.defineProperty(journal, "projection_write_error", {
    enumerable: true,
    get: () => projectionWriteError
  });
  // 可观察字段：journal 恢复发现的中间缺口（只读；Task 5 分页/清理使用）。
  Object.defineProperty(journal, "gaps", {
    enumerable: true,
    get: () => eventsStore.gaps
  });
  return journal;
}
