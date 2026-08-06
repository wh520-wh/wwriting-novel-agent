// src/app-shell/agent/state.js —— AgentSurface 状态纯 reducer（Task 8 Step 2）。
//
// 只从 ProjectAgent 的 snapshot({ session, events }) 与增量 journal 事件派生 UI 状态：
// 连续对话（user/assistant 消息）、活动 Run、Visible Plan、队列、活动流、决策与错误。
// 本模块不读 dashboard 队列，也不写任何独立状态文件（Rule 5：UI 不做业务决策）。
//
// 两条输入路径：
//   - reduceSnapshot(state, { session, events })：session 是服务端权威 projection；
//     新 session_id 时先重置派生状态（rebuild=true，view 重建 DOM），随后按 seq 去重
//     应用 events。session_id 不变时按增量合并（SSE 断线补齐路径）。
//   - reduceEvent(state, event)：单条增量事件（SSE 推送）。除了派生 conversation/
//     activities/decisions/errors，还会把投影相关的可观察字段（Run 状态、队列、
//     active_input_id、visible_plan）从事件镜像到本地 session 副本，保证增量路径
//     UI 不滞后于服务端；下次 snapshot 到达时以投影为准整体替换。
//
// 事件 payload 里出现的私有推理字段（reasoning / chain-of-thought 等）一律不进入
// 派生状态；view 只拿到 label 与脱敏文本。

export const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
export const ACTIVITY_TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

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
    lastSeq: 0,
    conversation: [],       // { role, text, input_id, seq }
    activities: new Map(),  // activity_id -> activity
    thinking: 0,            // 未闭合 model turn 计数（>0 显示「思考中」标签）
    decisions: new Map(),   // decision_id -> decision
    errors: [],             // run_failed 事实（新 Run 启动时清空）
    revisions: { messages: 0, run: 0, plan: 0, queue: 0, activities: 0, decisions: 0, errors: 0 }
  };
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
  const { session, events } = snapshot;
  const list = Array.isArray(events) ? events : [];
  if (session && typeof session === "object") {
    if (state.sessionId !== session.session_id) {
      resetState(state);
      state.sessionId = session.session_id ?? null;
      state.session = session;
      for (const event of list) reduceEvent(state, event);
      return true;
    }
    state.session = session;
    // 同会话的新快照（断线补齐等）：投影被整体替换，全部派生视图需要重新同步。
    bump(state, ["messages", "run", "plan", "queue", "activities", "decisions", "errors"]);
  }
  for (const event of list) reduceEvent(state, event);
  return false;
}

// ---------------------------------------------------------------------------
// 事件归约（纯派生 + 投影字段镜像）
// ---------------------------------------------------------------------------

export function reduceEvent(state, event) {
  if (!event || typeof event !== "object") return;
  const type = event.type;
  const payload = event.payload ?? {};
  // seq 归一化：非法/缺失 seq 置 null（不做去重、不推进 lastSeq，也不污染游标）。
  const rawSeq = Number(event.seq);
  const seq = Number.isFinite(rawSeq) ? rawSeq : null;
  if (seq != null) {
    if (seq <= state.lastSeq) return; // 去重（快照与 SSE 可能重复送达）
    state.lastSeq = seq;
  }
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
        seq
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
    case "assistant_message_completed": {
      // journal 事件只携带 input_id；若未来附带 text 则渲染助手气泡，否则只是轮次标记。
      if (typeof payload.text === "string" && payload.text.length > 0) {
        state.conversation.push({
          role: "assistant",
          text: payload.text,
          input_id: payload.input_id ?? null,
          seq
        });
        bump(state, ["messages"]);
      }
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
      bump(state, ["run", "plan", "queue", "decisions", "errors"]);
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
          items: payload.items.map((item) => ({ step: item.step, status: item.status }))
        };
        bump(state, ["plan"]);
      }
      break;
    }
    case "model_turn_started": {
      state.thinking += 1;
      bump(state, ["run"]);
      break;
    }
    case "model_turn_completed": {
      if (state.thinking > 0) state.thinking -= 1;
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
        seq
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
      const activity = state.activities.get(payload.activity_id ?? null);
      if (!activity) break;
      activity.status = "completed";
      if (payload.exit_code != null) activity.exit_code = payload.exit_code;
      if (payload.duration_ms != null) activity.duration_ms = payload.duration_ms;
      bump(state, ["activities"]);
      break;
    }
    case "tool_call_failed": {
      const activity = state.activities.get(payload.activity_id ?? null);
      if (!activity) break;
      activity.status = payload.error === "tool_cancelled" ? "cancelled" : "failed";
      activity.error = typeof payload.message === "string" ? payload.message
        : typeof payload.error === "string" ? payload.error : null;
      if (payload.duration_ms != null) activity.duration_ms = payload.duration_ms;
      if (typeof payload.stdout === "string" && payload.stdout.length > 0) appendActivityText(activity, payload.stdout);
      if (typeof payload.stderr === "string" && payload.stderr.length > 0) appendActivityText(activity, payload.stderr);
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
    // 不进入派生 UI 状态的事件（许可/审计/领域类）
    default:
      break;
  }
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

export function isRunActive(run) {
  return Boolean(run) && !TERMINAL_RUN_STATUSES.has(run.status);
}

export function hasOpenModelTurn(state) {
  return state.thinking > 0;
}
