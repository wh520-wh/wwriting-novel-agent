// src/app-shell/agent/state.js —— AgentSurface 状态纯 reducer（Task 8 Step 2）。
//
// 只从 ProjectAgent 的 snapshot({ session, events }) 与增量 journal 事件派生 UI 状态：
// 连续对话（user/assistant 消息）、活动 Run、Visible Plan、队列、活动流、决策与错误。
// 本模块不读 dashboard 队列，也不写任何独立状态文件（Rule 5：UI 不做业务决策）。
//
// 两条输入路径（Task 10 起改为「稳定 event store + 按已加载全集重建」）：
//   - reduceSnapshot(state, { session, events, gaps, has_more })：session 是服务端
//     权威 projection。新 session_id 时先重置派生状态（rebuild=true，view 重建 DOM），
//     随后按 event_key 去重并入 loadedEvents 并做一次全集重建；同会话新快照（断线
//     补齐）同样 merge 去重后重建。前置页（session 为 null，beforeSeq 语义）只 merge
//     events 并重建，不清空当前消息。page 的 gaps 投影为 history_gap 条目。
//   - reduceEvent(state, event)：单条增量事件（SSE 推送）。seq 严格递增时走增量
//     fast path（逐事件派生）；任何 seq < lastSeq 的乱序事件（前置页补齐、SSE 重排）
//     触发按 (seq, event_key) 排序的已加载全集重建。lastSeq 只是 SSE 增量游标，
//     不用于拒绝较小 seq。
//
// 事件 payload 里出现的私有推理字段（reasoning / chain-of-thought 等）一律不进入
// 派生状态；view 只拿到 label 与脱敏文本。
import { createWorkState, orderedWorkItems, reduceWorkEvent } from "./work-items.mjs";

export const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
export const ACTIVITY_TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
// 取消类工具错误码：这些错误表示活动被停止/作废（用户停止、决策取消、信号中止），
// 不是执行失败，终态标记为 cancelled（"已停止"）而不是 failed（"✗"）。
// 与 tools.mjs 的 emitToolCancelled 路径（tool_cancelled / shell_cancelled）保持一致。
export const ACTIVITY_CANCELLED_ERROR_CODES = new Set(["tool_cancelled", "shell_cancelled"]);

// run_status_changed 的 session.status 镜像（与 journal.mjs RUN_STATUS_TO_SESSION 一致）。
const RUN_STATUS_TO_SESSION = {
  running: "running",
  waiting_user: "waiting_user",
  interrupting: "interrupting",
  stopping: "stopping",
  completed: "idle",
  failed: "idle",
  cancelled: "idle",
  interrupted: "idle"
};

// 单活动输出保留尾部窗口（与 view 展示上限一致：64 KiB）
export const MAX_ACTIVITY_OUTPUT_CHARS = 64 * 1024;

// I-2 有界性（reducer 层封顶）：最多保留 20 个终态活动 + 全部运行中活动。
// 同一 activity 的 delta 必先于其终态事件（seq 严格递增），终态活动被丢弃后
// 不会再收到该活动的增量，因此可以直接删除而非占位。DOM 层「只裁最早终态、
// 运行中不删」的 20 行契约保持不变（view 仍有自己的行裁剪兜底）。
export const MAX_TERMINAL_ACTIVITIES = 20;

// 状态轮廓。所有派生字段只由 reducer 修改，view 只读。
export function createState() {
  return {
    projectRoot: null,
    sessionId: null,
    session: null,          // 最新 session projection（本地镜像，服务端为权威）
    lastSeq: 0,             // 仅 SSE 增量游标：已见最大 seq，不用于拒绝较小 seq
    loadedEvents: new Map(), // event_key -> event（snapshot/SSE/前置页共用的稳定 event store）
    minSeq: null,           // 已加载事件的最小 seq（前置分页游标，null=尚未加载事件）
    hasEarlier: false,      // page.has_more：更早历史是否仍存在（滚动到顶触发 loadEarlier）
    historyGaps: [],        // { kind:"history_gap", event_key, start_seq, end_seq, reason }
    // Task 11：上下文用量与压缩投影（镜像核心 CompactionProjection 语义）。
    // contextUsage 为最新 ContextUsage（null=尚无 context_usage_updated 事件，
    // UI 显示「计算中」，绝不用假 0 冒充）；compaction 为最近一次压缩的单槽投影；
    // compactionRows 按 compaction_id 保留每次压缩的状态行（终态行仍留在时间线）。
    contextUsage: null,
    compaction: null,
    compactionRows: new Map(), // compaction_id -> { compaction_id, seq, event_key, state, trigger, error_code }
    conversation: [],       // { role, text, input_id, seq, event_key }
    activities: new Map(),  // activity_id -> activity（含 start_seq/terminal_seq/事件 key）
    work: createWorkState(), // 有序工作项投影（Task 5：reasoning/tool/plan 时间线）
    decisions: new Map(),   // decision_id -> decision
    errors: [],             // run_failed 事实（新 Run 启动时清空）
    assistantStream: null,  // { runId, text } —— 增量正文累积（流式气泡），completed 后清空
    revisions: { messages: 0, run: 0, queue: 0, activities: 0, decisions: 0, errors: 0, context: 0 }
  };
}

// 稳定时间线 key（Task 10 Step 2）：session_id + ":" + seq + ":" + type。
// 非法/缺失 seq 的事件无 key（不做去重、不入 loadedEvents）。
export function eventKey(event) {
  if (!event || typeof event !== "object") return null;
  const rawSeq = Number(event.seq);
  if (!Number.isFinite(rawSeq)) return null;
  return `${String(event.session_id ?? "")}:${rawSeq}:${String(event.type ?? "")}`;
}

function bump(state, keys) {
  for (const key of keys) state.revisions[key] += 1;
}

export function resetState(state, { projectRoot = state.projectRoot } = {}) {
  const fresh = createState();
  fresh.projectRoot = projectRoot;
  for (const key of Object.keys(fresh)) state[key] = fresh[key];
  return state;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

// 返回 true 表示会话/项目已更换，view 需要重建 DOM（重新锚定活动流）。
export function reduceSnapshot(state, snapshot) {
  if (!snapshot || typeof snapshot !== "object") return false;
  const { session, events, gaps, has_more } = snapshot;
  const list = Array.isArray(events) ? events : [];
  let sessionChanged = false;
  if (session && typeof session === "object") {
    const authoritativeSession = structuredClone(session);
    if (state.sessionId !== session.session_id) {
      resetState(state);
      state.sessionId = session.session_id ?? null;
      // 事件负责重建对话/活动等派生状态；会话 projection 在回放结束后覆盖，
      // 防止首批历史事件把服务端已完成的 Run 回放成 running。
      state.session = null;
      mergeEventsIntoStore(state, list);
      rebuildDerivedState(state);
      state.session = authoritativeSession;
      sessionChanged = true;
    } else {
      state.session = authoritativeSession;
      // 同会话的新快照（断线补齐等）：投影被整体替换，全部派生视图需要重新同步。
      bump(state, ["messages", "run", "queue", "activities", "decisions", "errors"]);
      if (mergeEventsIntoStore(state, list)) rebuildDerivedState(state);
      state.session = authoritativeSession;
    }
  } else if (mergeEventsIntoStore(state, list)) {
    // 前置页 / 无 session 的分页：只 merge 去重并入 store，不清空当前消息。
    rebuildDerivedState(state);
  }
  // page 元数据在 resetState（新 session 分支）之后应用，避免被重置：
  // has_more 决定是否还有更早历史（滚动到顶可继续前置分页）；gaps 投影为
  // history_gap（不伪造消息内容）。
  if (has_more !== undefined) state.hasEarlier = has_more === true;
  if (Array.isArray(gaps)) mergeGaps(state, gaps);
  return sessionChanged;
}

// 把 page 的 gaps 投影为稳定 history_gap 条目（event_key: gap:<start>-<end>）。
function mergeGaps(state, gaps) {
  for (const gap of gaps) {
    if (!gap || typeof gap !== "object") continue;
    const start = Number(gap.start_seq);
    const end = Number(gap.end_seq);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const key = `gap:${start}-${end}`;
    if (!state.historyGaps.some((entry) => entry.event_key === key)) {
      state.historyGaps.push({
        kind: "history_gap",
        event_key: key,
        start_seq: start,
        end_seq: end,
        reason: typeof gap.reason === "string" ? gap.reason : null
      });
    }
  }
}

// 事件并入稳定 store（按 event_key 去重），并维护已加载最小/最大 seq：
// minSeq 是前置分页游标；lastSeq 随快照/前置页一并推进（snapshot 里的事件同样
// 是「已见」事件），保证首屏 tail 后 connectEvents 从已加载最大 seq 续流，而不是
// afterSeq=0 把整本 Journal 在 SSE 上重放（brief Step 2「lastSeq 只取已见最大
// seq」+ Step 4「保留 state.lastSeq 作为 SSE 增量游标」）。
function mergeEventsIntoStore(state, list) {
  let added = false;
  let min = state.minSeq;
  let max = state.lastSeq;
  for (const event of list) {
    const key = eventKey(event);
    if (key == null) continue;
    if (!state.loadedEvents.has(key)) {
      state.loadedEvents.set(key, event);
      added = true;
    }
    const seq = Number(event.seq);
    if (Number.isFinite(seq)) {
      min = min == null ? seq : Math.min(min, seq);
      if (seq > max) max = seq;
    }
  }
  state.minSeq = min;
  state.lastSeq = max;
  return added;
}

// ---------------------------------------------------------------------------
// 事件归约（纯派生 + 投影字段镜像）
// ---------------------------------------------------------------------------

export function reduceEvent(state, event) {
  if (!event || typeof event !== "object") return;
  const type = event.type;
  const payload = event.payload ?? {};
  // seq 归一化：非法/缺失 seq 置 null（不入 store、不推进 lastSeq，也不污染游标）。
  const rawSeq = Number(event.seq);
  const seq = Number.isFinite(rawSeq) ? rawSeq : null;
  const key = eventKey(event);
  if (key != null) {
    if (state.loadedEvents.has(key)) return; // 同 key 重复送达（SSE/前置页）：不重复处理
    state.loadedEvents.set(key, event);
    if (seq != null && (state.minSeq == null || seq < state.minSeq)) state.minSeq = seq;
    if (seq != null && state.lastSeq > 0 && seq < state.lastSeq) {
      // 乱序（前置页补齐或 SSE 重排）：按已加载全集重建，保证终态不倒退为 running。
      rebuildDerivedState(state);
      return;
    }
    if (seq != null && seq > state.lastSeq) state.lastSeq = seq;
  } else if (seq != null && seq > state.lastSeq) {
    state.lastSeq = seq;
  }
  applyEventToState(state, event);
}

// 单条事件的派生应用：增量 fast path 与 rebuildDerivedState 共用同一实现。
function applyEventToState(state, event) {
  const type = event.type;
  const payload = event.payload ?? {};
  const rawSeq = Number(event.seq);
  const seq = Number.isFinite(rawSeq) ? rawSeq : null;
  const key = eventKey(event);
  switch (type) {
    case "session_created": {
      state.sessionId = event.session_id ?? state.sessionId;
      break;
    }
    case "input_queued": {
      const inputId = payload.input_id ?? null;
      state.conversation.push({
        role: "user",
        text: String(payload.text ?? ""),
        input_id: inputId,
        seq,
        event_key: key
      });
      if (state.session && inputId != null) {
        if (!Array.isArray(state.session.queued_inputs)) state.session.queued_inputs = [];
        const queue = state.session.queued_inputs;
        if (!queue.some((item) => item.id === inputId)) {
          queue.push({ id: inputId, text: String(payload.text ?? ""), status: "queued", queued_at: event.at ?? null });
        }
      }
      bump(state, ["messages", "queue"]);
      break;
    }
    case "assistant_message_delta": {
      // 增量正文累积（按 run 维度单槽，不产生新 message 对象）：delta 到达即追加，
      // 直到 assistant_message_completed 定稿。累积字段独立于服务端投影（快照会整体
      // 替换 session.active_run），重连回放按 seq 去重追加，不与投影中的累积重复相加。
      const delta = typeof payload.text === "string" ? payload.text : "";
      if (delta.length === 0) break;
      const runId = event.run_id ?? null;
      if (!state.assistantStream || state.assistantStream.runId !== runId) {
        state.assistantStream = { runId, text: "" };
      }
      state.assistantStream.text += delta;
      bump(state, ["messages"]);
      break;
    }
    case "assistant_message_completed": {
      // 终态对齐：completed 携带全文则以之为权威最终值，否则以 delta 累积值为准；
      // 两者皆空（纯轮次标记）不产生气泡。
      const accumulated = state.assistantStream?.text ?? "";
      const finalText =
        typeof payload.text === "string" && payload.text.length > 0
          ? payload.text
          : accumulated;
      if (finalText.length > 0) {
        state.conversation.push({
          role: "assistant",
          text: finalText,
          input_id: payload.input_id ?? null,
          seq,
          event_key: key
        });
        bump(state, ["messages"]);
      }
      state.assistantStream = null;
      break;
    }
    case "run_started": {
      if (!state.session) {
        state.session = {
          schema_version: 1,
          session_id: state.sessionId,
          project_root: state.projectRoot,
          status: "running",
          active_run: null,
          queued_inputs: [],
          last_seq: 0,
          updated_at: event.at ?? null
        };
      }
      const existing = state.session.active_run;
      if (existing && existing.id === event.run_id) {
        // retry：恢复同一可恢复 Run（保留 workflow/visible_plan）
        existing.status = "running";
        state.session.status = "running";
      } else {
        state.session.active_run = {
          id: event.run_id ?? null,
          status: "running",
          workflow: payload.workflow ?? "general",
          active_input_id: payload.input_id ?? null,
          visible_plan: null,
          active_grants: [],
          started_at: event.at ?? null
        };
        state.session.status = "running";
      }
      activateInput(state, payload.input_id ?? null);
      state.errors = [];
      // 新 Run（或重试恢复）从零累积正文增量，旧流式气泡立即退出。
      state.assistantStream = null;
      bump(state, ["run", "queue", "decisions", "errors"]);
      break;
    }
    case "run_status_changed": {
      const run = state.session?.active_run;
      if (!run) break;
      run.status = payload.status ?? run.status;
      // 与 journal 的 RUN_STATUS_TO_SESSION 一致：终态镜像为 idle，中间态原样。
      state.session.status = RUN_STATUS_TO_SESSION[run.status] ?? "running";
      if (TERMINAL_RUN_STATUSES.has(run.status)) run.active_input_id = null;
      bump(state, ["run"]);
      break;
    }
    case "input_consumed": {
      const run = state.session?.active_run;
      if (!state.session) break;
      if (!Array.isArray(state.session.queued_inputs)) state.session.queued_inputs = [];
      const inputId = payload.input_id ?? null;
      if (run && run.active_input_id === inputId) {
        run.active_input_id = null;
      } else {
        const index = state.session.queued_inputs.findIndex((item) => item.id === inputId);
        if (index >= 0) state.session.queued_inputs.splice(index, 1);
        if (run) run.active_input_id = inputId;
      }
      bump(state, ["run", "queue"]);
      break;
    }
    case "input_cancelled": {
      if (!state.session) break;
      if (!Array.isArray(state.session.queued_inputs)) state.session.queued_inputs = [];
      const inputId = payload.input_id ?? null;
      if (state.session.active_run?.active_input_id === inputId) {
        state.session.active_run.active_input_id = null;
      } else {
        const index = state.session.queued_inputs.findIndex((item) => item.id === inputId);
        if (index >= 0) state.session.queued_inputs.splice(index, 1);
      }
      bump(state, ["queue"]);
      break;
    }
    case "input_promoted": {
      const run = state.session?.active_run;
      if (!state.session || !run) break;
      if (!Array.isArray(state.session.queued_inputs)) state.session.queued_inputs = [];
      const inputId = payload.input_id ?? null;
      const index = state.session.queued_inputs.findIndex((item) => item.id === inputId);
      if (index >= 0) state.session.queued_inputs.splice(index, 1);
      const previousId = run.active_input_id;
      if (previousId != null && previousId !== inputId) {
        const meta = state.conversation.find((m) => m.role === "user" && m.input_id === previousId);
        if (meta) {
          state.session.queued_inputs.unshift({
            id: previousId,
            text: meta.text,
            status: "queued",
            queued_at: null
          });
        }
      }
      run.active_input_id = inputId;
      bump(state, ["run", "queue"]);
      break;
    }
    case "interrupt_requested": {
      const run = state.session?.active_run;
      if (run) {
        run.status = "interrupting";
        state.session.status = "interrupting";
        bump(state, ["run"]);
      }
      break;
    }
    case "interrupt_safe_point_reached": {
      const run = state.session?.active_run;
      if (run && run.status === "interrupting") {
        run.status = "running";
        state.session.status = "running";
        bump(state, ["run"]);
      }
      break;
    }
    case "workflow_changed": {
      const run = state.session?.active_run;
      if (run) {
        run.workflow = payload.workflow ?? run.workflow;
        bump(state, ["run"]);
      }
      break;
    }
    case "plan_updated": {
      const run = state.session?.active_run;
      if (run && Array.isArray(payload.items)) {
        run.visible_plan = {
          explanation: typeof payload.explanation === "string" ? payload.explanation : null,
          items: payload.items.map((item) => {
            // 步骤6：保留稳定 id 与可选 description（旧事件无这些字段则省略，
            // 前端显示用 step 兜底）。
            const entry = { step: item.step, status: item.status };
            if (item.id !== undefined) entry.id = item.id;
            if (item.description !== undefined) entry.description = item.description;
            return entry;
          })
        };
        // 计划自身的 revision 计数已删除：计划的时序由 work 投影的 plan 工作项
        // sortSeq 承担（Task 5 Step 6），旧 view 的 overlay 靠 syncPlan 的
        // 内容签名驱动渲染。
      }
      break;
    }
    case "model_turn_started": {
      // 未闭合 model turn 的判断已由 thinking 计数迁移到 work 投影（Task 5）：
      // hasOpenModelTurn 派生自 work 组的 reasoning 工作项 / legacy 开放 turn。
      state.assistantStream = null;
      if (state.session?.active_run) state.session.active_run.assistant_text = null;
      bump(state, ["run", "messages"]);
      break;
    }
    case "model_turn_completed": {
      // thinking 计数已删除；v1 legacy turn 的闭合由 reduceWorkEvent 处理。
      bump(state, ["run"]);
      break;
    }
    case "tool_call_started": {
      const activityId = payload.activity_id ?? null;
      if (activityId == null) break;
      const action = payload.action ?? null;
      state.activities.set(activityId, {
        activity_id: activityId,
        tool_call_id: payload.tool_call_id ?? null,
        run_id: event.run_id ?? null,
        name: payload.name ?? null,
        args: payload.args ?? null,
        action,
        command: action?.command ?? payload.args?.command ?? null,
        cwd: action?.cwd ?? payload.args?.cwd ?? null,
        status: "running",
        text: "",
        truncated: false,
        exit_code: null,
        duration_ms: null,
        error: null,
        seq,
        start_seq: seq,
        terminal_seq: null,
        start_event_key: key,
        terminal_event_key: null
      });
      trimActivityState(state);
      bump(state, ["activities"]);
      break;
    }
    case "tool_output_delta": {
      const activity = state.activities.get(payload.activity_id ?? null);
      if (!activity) break;
      const delta = typeof payload.text === "string" ? payload.text : "";
      if (delta.length === 0) break;
      activity.text = activity.text + delta;
      if (activity.text.length > MAX_ACTIVITY_OUTPUT_CHARS) {
        activity.text = activity.text.slice(activity.text.length - MAX_ACTIVITY_OUTPUT_CHARS);
        activity.truncated = true;
      }
      trimActivityState(state);
      bump(state, ["activities"]);
      break;
    }
    case "tool_call_completed": {
      const activityId = payload.activity_id ?? null;
      const activity = state.activities.get(activityId);
      if (activity) {
        activity.status = "completed";
        if (payload.exit_code != null) activity.exit_code = payload.exit_code;
        if (payload.duration_ms != null) activity.duration_ms = payload.duration_ms;
        activity.terminal_seq = seq;
        activity.terminal_event_key = key;
      } else if (activityId != null) {
        // 尾页/裁剪后缺少 started：先建最小 tombstone（started 到达后由重建
        // 补全参数并定位到 started seq，终态保持 completed，不倒退为 running）。
        createActivityTombstone(state, activityId, {
          event,
          payload,
          seq,
          key,
          status: "completed",
          exit_code: payload.exit_code ?? null
        });
      }
      trimActivityState(state);
      bump(state, ["activities"]);
      break;
    }
    case "tool_call_failed": {
      const activityId = payload.activity_id ?? null;
      const activity = state.activities.get(activityId);
      if (activity) {
        activity.status = ACTIVITY_CANCELLED_ERROR_CODES.has(payload.error) ? "cancelled" : "failed";
        activity.error = typeof payload.message === "string" ? payload.message
          : typeof payload.error === "string" ? payload.error : null;
        if (payload.duration_ms != null) activity.duration_ms = payload.duration_ms;
        if (typeof payload.stdout === "string" && payload.stdout.length > 0) appendActivityText(activity, payload.stdout);
        if (typeof payload.stderr === "string" && payload.stderr.length > 0) appendActivityText(activity, payload.stderr);
        activity.terminal_seq = seq;
        activity.terminal_event_key = key;
      } else if (activityId != null) {
        const status = ACTIVITY_CANCELLED_ERROR_CODES.has(payload.error) ? "cancelled" : "failed";
        createActivityTombstone(state, activityId, {
          event,
          payload,
          seq,
          key,
          status,
          exit_code: null,
          error: typeof payload.message === "string" ? payload.message
            : typeof payload.error === "string" ? payload.error : null
        });
      }
      trimActivityState(state);
      bump(state, ["activities"]);
      break;
    }
    case "decision_requested": {
      const decisionId = payload.decision_id ?? null;
      if (decisionId == null) break;
      state.decisions.set(decisionId, {
        decision_id: decisionId,
        activity_id: payload.activity_id ?? null,
        input_id: payload.input_id ?? null,
        run_id: event.run_id ?? null,
        name: payload.name ?? null,
        kind: payload.kind === "extreme" ? "extreme" : "normal",
        title: payload.title ?? payload.name ?? "确认操作",
        description: payload.description ?? null,
        confirmation_text: payload.confirmation_text ?? null,
        status: "pending",
        choice: null,
        seq
      });
      bump(state, ["decisions"]);
      break;
    }
    case "decision_resolved": {
      const decision = state.decisions.get(payload.decision_id ?? null);
      if (!decision) break;
      decision.status = "settled";
      decision.choice = payload.choice ?? null;
      bump(state, ["decisions"]);
      break;
    }
    case "run_failed": {
      state.errors.push({
        seq,
        run_id: event.run_id ?? null,
        message: typeof payload.error === "string" ? payload.error : "操作失败。",
        code: payload.code ?? "model_error"
      });
      const run = state.session?.active_run;
      if (run) {
        run.status = "failed";
        run.active_input_id = null;
        state.session.status = "idle";
      }
      bump(state, ["run", "errors"]);
      break;
    }
    case "run_completed": {
      const run = state.session?.active_run;
      if (run) {
        run.status = "completed";
        run.active_input_id = null;
        state.session.status = "idle";
      }
      bump(state, ["run"]);
      break;
    }
    case "run_cancelled": {
      const run = state.session?.active_run;
      if (run) {
        run.status = "cancelled";
        run.active_input_id = null;
        state.session.status = "idle";
      }
      bump(state, ["run"]);
      break;
    }
    case "run_interrupted": {
      const run = state.session?.active_run;
      if (run) {
        run.status = "interrupted";
        run.active_input_id = null;
        state.session.status = "idle";
      }
      bump(state, ["run"]);
      break;
    }
    // ---- 上下文用量与压缩投影（Task 11 Step 3，镜像核心语义） --------------
    // context_usage_updated 只更新 contextUsage 并 bump context revision；
    // 7 个压缩事件更新 compaction 单槽投影并 upsert 对应 compaction_id 的状态行
    //（保留 seq 与 compaction_id；终态后状态行仍留在时间线，由 compactionRows 承载）。
    case "context_usage_updated": {
      const usage = payload.usage;
      if (usage !== null && typeof usage === "object" && !Array.isArray(usage)) {
        state.contextUsage = structuredClone(usage);
        bump(state, ["context"]);
      }
      break;
    }
    case "context_compaction_started": {
      const compactionId = payload.compaction_id ?? null;
      if (compactionId == null) break;
      state.compaction = {
        id: compactionId,
        trigger: payload.trigger === "manual" ? "manual" : "automatic",
        state: "started",
        attempt: payload.attempt ?? 1,
        source_checkpoint_id: payload.source_checkpoint_id ?? null,
        checkpoint_id: payload.checkpoint_id ?? null,
        pending_input_id: payload.pending_input_id ?? null,
        error_code: null,
        started_at: payload.started_at ?? event.at ?? null,
        updated_at: event.at ?? null
      };
      upsertCompactionRow(state, compactionId, seq, key, "started", state.compaction);
      bump(state, ["context"]);
      break;
    }
    case "context_compaction_running":
    case "context_compaction_cancel_requested": {
      const compactionId = payload.compaction_id ?? null;
      if (compactionId == null) break;
      const nextState = type === "context_compaction_running" ? "running" : "cancelling";
      if (state.compaction && state.compaction.id === compactionId) {
        state.compaction.state = nextState;
        state.compaction.error_code = null;
        state.compaction.updated_at = event.at ?? null;
      } else {
        // 防御：running/cancelling 前缺 started（如手工构造日志）——从 payload
        // 补投影，避免投影形状缺失（与核心 journal reducer 行为一致）。
        state.compaction = {
          id: compactionId,
          trigger: payload.trigger === "manual" ? "manual" : "automatic",
          state: nextState,
          attempt: payload.attempt ?? 1,
          source_checkpoint_id: payload.source_checkpoint_id ?? null,
          checkpoint_id: payload.checkpoint_id ?? null,
          pending_input_id: payload.pending_input_id ?? null,
          error_code: null,
          started_at: payload.started_at ?? event.at ?? null,
          updated_at: event.at ?? null
        };
      }
      upsertCompactionRow(state, compactionId, seq, key, nextState, state.compaction);
      bump(state, ["context"]);
      break;
    }
    case "context_compaction_completed": {
      const compactionId = payload.compaction_id ?? null;
      if (compactionId == null) break;
      const prev = state.compaction && state.compaction.id === compactionId ? state.compaction : null;
      state.compaction = {
        id: compactionId,
        trigger: prev?.trigger ?? (payload.trigger === "manual" ? "manual" : "automatic"),
        state: "completed",
        attempt: payload.attempt ?? prev?.attempt ?? 1,
        source_checkpoint_id: prev?.source_checkpoint_id ?? payload.source_checkpoint_id ?? null,
        checkpoint_id: payload.checkpoint_id ?? null,
        pending_input_id: prev?.pending_input_id ?? payload.pending_input_id ?? null,
        error_code: null,
        started_at: prev?.started_at ?? payload.started_at ?? event.at ?? null,
        updated_at: event.at ?? null
      };
      upsertCompactionRow(state, compactionId, seq, key, "completed", state.compaction);
      bump(state, ["context"]);
      break;
    }
    case "context_compaction_failed":
    case "context_compaction_cancelled": {
      const compactionId = payload.compaction_id ?? null;
      if (compactionId == null) break;
      const prev = state.compaction && state.compaction.id === compactionId ? state.compaction : null;
      const nextState = type === "context_compaction_failed" ? "failed" : "cancelled";
      state.compaction = {
        id: compactionId,
        trigger: prev?.trigger ?? (payload.trigger === "manual" ? "manual" : "automatic"),
        state: nextState,
        attempt: payload.attempt ?? prev?.attempt ?? 1,
        source_checkpoint_id: prev?.source_checkpoint_id ?? payload.source_checkpoint_id ?? null,
        checkpoint_id: prev?.checkpoint_id ?? payload.checkpoint_id ?? null,
        pending_input_id: prev?.pending_input_id ?? payload.pending_input_id ?? null,
        error_code: payload.error_code ?? null,
        started_at: prev?.started_at ?? payload.started_at ?? event.at ?? null,
        updated_at: event.at ?? null
      };
      upsertCompactionRow(state, compactionId, seq, key, nextState, state.compaction);
      bump(state, ["context"]);
      break;
    }
    case "context_compaction_noop": {
      const compactionId = payload.compaction_id ?? null;
      if (compactionId == null) break;
      state.compaction = {
        id: compactionId,
        trigger: payload.trigger === "manual" ? "manual" : "automatic",
        state: "noop",
        attempt: payload.attempt ?? 1,
        source_checkpoint_id: null,
        checkpoint_id: null,
        pending_input_id: null,
        error_code: null,
        started_at: event.at ?? null,
        updated_at: event.at ?? null
      };
      upsertCompactionRow(state, compactionId, seq, key, "noop", state.compaction);
      bump(state, ["context"]);
      break;
    }
    // 不进入派生 UI 状态的事件（许可/审计/领域类）
    default:
      break;
  }
  // 每个 journal 事件先进入现有会话 reducer，再进入 work 投影（Task 5 Step 6）。
  // reduceWorkEvent 只读事件字段（run_id/seq/project_root/payload），不读 DOM。
  reduceWorkEvent(state.work, event);
}

// 在已加载事件里查找某活动最早的 started 事件（活动被 trim 或尾页缺失时，仍能
// 用 started seq 定位占位行；未找到则 start_seq 保持 null，先按 terminal_seq 落位）。
function findStartedEvent(state, activityId) {
  for (const event of state.loadedEvents.values()) {
    if (event.type !== "tool_call_started") continue;
    const id = event.payload?.activity_id ?? event.payload?.id ?? null;
    if (id === activityId) return event;
  }
  return null;
}

// 最小终态 tombstone：tool_call_completed/failed 先于 started 到达（前置页未加载、
// 活动被 trim 丢弃）时占位；后续重建找到 started 后补全参数并定位到 started seq。
function createActivityTombstone(state, activityId, { event, payload, seq, key, status, exit_code, error }) {
  const started = findStartedEvent(state, activityId);
  const startSeq = started != null ? Number(started.seq) : null;
  state.activities.set(activityId, {
    activity_id: activityId,
    tool_call_id: payload.tool_call_id ?? null,
    run_id: event.run_id ?? null,
    name: payload.name ?? null,
    args: payload.args ?? null,
    action: null,
    command: typeof payload.command === "string" ? payload.command : (payload.args?.command ?? null),
    cwd: typeof payload.cwd === "string" ? payload.cwd : (payload.args?.cwd ?? null),
    status,
    text: "",
    truncated: false,
    exit_code,
    duration_ms: payload.duration_ms ?? null,
    error: error ?? null,
    seq: startSeq ?? seq,
    start_seq: startSeq,
    terminal_seq: seq,
    start_event_key: started != null ? eventKey(started) : null,
    terminal_event_key: key
  });
}

// 压缩状态行的 per-id upsert：首次见到某 compaction_id 时以该事件 seq/key 为
// 时间线锚点（started 优先；started 缺失时回退首个已见事件），之后只更新
// state/trigger/error_code。重建（rebuildDerivedState）按 seq 重放时首见事件
// 稳定，锚点与 event_key 跨重建保持一致。
function upsertCompactionRow(state, compactionId, seq, key, stateText, projection) {
  let entry = state.compactionRows.get(compactionId);
  if (!entry) {
    state.compactionRows.set(compactionId, {
      compaction_id: compactionId,
      seq,
      event_key: key,
      state: stateText,
      trigger: projection.trigger,
      error_code: projection.error_code
    });
    return;
  }
  entry.state = stateText;
  entry.trigger = projection.trigger ?? entry.trigger;
  entry.error_code = projection.error_code ?? entry.error_code;
}

// 按已加载全集重建派生投影（Task 10 Step 2）：前置页或任何乱序事件到达后，
// 按 (seq, event_key) 排序 loadedEvents，从空的 conversation/activity/work/
// decisions/errors/assistantStream 重放。一次重建只处理当前已加载页（数百到数千
// 事件），不读磁盘全量 Journal。lastSeq 只作为 SSE 增量游标，不参与重建。
function rebuildDerivedState(state) {
  const events = [...state.loadedEvents.values()].sort((a, b) => {
    const as = Number(a.seq);
    const bs = Number(b.seq);
    const aFinite = Number.isFinite(as);
    const bFinite = Number.isFinite(bs);
    if (aFinite !== bFinite) return aFinite ? -1 : 1; // 有 seq 的事件在前
    if (aFinite && as !== bs) return as - bs;
    return String(eventKey(a) ?? "").localeCompare(String(eventKey(b) ?? ""));
  });
  state.conversation = [];
  state.activities = new Map();
  state.work = createWorkState();
  state.decisions = new Map();
  state.errors = [];
  state.assistantStream = null;
  // Task 11：上下文用量/压缩投影同样由事件重放重建（确定性与增量路径一致）。
  state.contextUsage = null;
  state.compaction = null;
  state.compactionRows = new Map();
  for (const event of events) applyEventToState(state, event);
  bump(state, ["messages", "run", "queue", "activities", "decisions", "errors", "context"]);
}

function appendActivityText(activity, delta) {
  activity.text = activity.text + delta;
  if (activity.text.length > MAX_ACTIVITY_OUTPUT_CHARS) {
    activity.text = activity.text.slice(activity.text.length - MAX_ACTIVITY_OUTPUT_CHARS);
    activity.truncated = true;
  }
}

// I-2 封顶：活动数超过上限时，按插入顺序移除最早的终态活动（运行中永不丢弃）。
function trimActivityState(state) {
  if (state.activities.size <= MAX_TERMINAL_ACTIVITIES) return;
  const terminalIds = [];
  for (const [id, activity] of state.activities) {
    if (activity.status !== "running") terminalIds.push(id);
  }
  const excess = state.activities.size - MAX_TERMINAL_ACTIVITIES;
  if (excess <= 0) return;
  for (let i = 0; i < excess && i < terminalIds.length; i += 1) {
    state.activities.delete(terminalIds[i]);
  }
}

// 新 Run（或恢复的 Run）认领活动输入：从队列移除（镜像 journal activateInput）。
function activateInput(state, inputId) {
  if (!state.session || inputId == null) return;
  state.session.queued_inputs = state.session.queued_inputs.filter((item) => item.id !== inputId);
}

// ---------------------------------------------------------------------------
// 派生 getter（view 只通过这些读取）
// ---------------------------------------------------------------------------

export function getActiveRun(state) {
  return state.session?.active_run ?? null;
}

export function getQueuedInputs(state) {
  return state.session?.queued_inputs ?? [];
}

export function getVisiblePlan(state) {
  return state.session?.active_run?.visible_plan ?? null;
}

export function getPendingDecisions(state) {
  const out = [];
  for (const decision of state.decisions.values()) {
    if (decision.status === "pending") out.push(decision);
  }
  return out;
}

// ---- Task 11：上下文用量 / 压缩投影 getter（view 只通过这些读取）------------

export function getContextUsage(state) {
  return state.contextUsage ?? null;
}

export function getCompaction(state) {
  return state.compaction ?? null;
}

// 按 compaction_id 的状态行（Map 顺序 = 首见顺序，view 逐行渲染/更新）。
export function getCompactionRows(state) {
  return state.compactionRows;
}

// 压缩阻塞普通发送的状态（镜像核心 COMPACTION_BLOCKED_STATES 的视图口径）：
// 在途（started/running/cancelling）与失败（等待用户 重试/取消 决策）禁用发送；
// completed/cancelled/noop 均恢复正常发送（取消完成把文本留在 draft，send 恢复）。
export const COMPACTION_BLOCKED_STATES = new Set(["started", "running", "cancelling", "failed"]);

export function compactionBlocksSend(compaction) {
  return Boolean(compaction) && COMPACTION_BLOCKED_STATES.has(compaction.state);
}

export function isRunActive(run) {
  return Boolean(run) && !TERMINAL_RUN_STATUSES.has(run.status);
}

// 思考中判断（Task 5 起由 work 投影派生，不再维护独立 thinking 计数）：
// 活动 Run 的 work 组里存在 running 的 reasoning 工作项，或有未闭合的
// v1 legacy model turn（无 turn_id 的旧事件，journal 的 legacyOpenTurns 语义）。
export function hasOpenModelTurn(state) {
  const run = state.session?.active_run;
  if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return false;
  const group = state.work?.groups.get(run.id);
  if (!group) return false;
  if (group.legacyOpenTurns > 0) return true;
  return orderedWorkItems(group).some((item) => item.kind === "reasoning" && item.state === "running");
}
