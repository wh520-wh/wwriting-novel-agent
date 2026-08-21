// src/app-shell/agent/state.js —— AgentSurface 状态纯 reducer（Task 8 Step 2）。
//
// 只从 ProjectAgent 的 snapshot({ session, events }) 与增量 journal 事件派生 UI 状态：
// 连续对话（user/assistant 消息）、活动 Run、Visible Plan、队列、工作组、决策与错误。
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
import { createWorkState, reduceWorkEvent } from "./work-items.mjs";

export const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

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
    // Task 11：排队输入文本索引 input_id -> text。queued 不进入对话历史
    //（input_queued 只出现在「接下来」区域），input_started 是用户文本进入
    // transcript/对话的唯一边界——开始事件只携带 input_id，文本从本索引取回；
    // input_withdrawn/input_started 后移除。重建（rebuild）时随事件重放重建。
    queuedTexts: new Map(),
    work: createWorkState(), // 有序工作项投影（Task 5：reasoning/tool/plan 时间线）
    decisions: new Map(),   // decision_id -> decision
    errors: [],             // run_failed 事实（新 Run 启动时清空）
    assistantStream: null,  // { runId, text } —— 增量正文累积（流式气泡），completed 后清空
    plan: null,             // 第九轮：顶层计划投影（plan_updated → { explanation, items }），供 plan-panel chip 消费
    // 第九轮：系统通知行投影（chapter_rolled_back / memory_file_restored → timeline）。
    systemNotices: [],      // [{ seq, type, payload }]
    revisions: { messages: 0, run: 0, queue: 0, decisions: 0, errors: 0, context: 0, notices: 0, plan: 0 }
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

// 返回 true 表示会话/项目已更换，view 需要重建 DOM（重新锚定时间线）。
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
      // 事件负责重建对话/工作项等派生状态；会话 projection 在回放结束后覆盖，
      // 防止首批历史事件把服务端已完成的 Run 回放成 running。
      state.session = null;
      mergeEventsIntoStore(state, list);
      rebuildDerivedState(state);
      state.session = authoritativeSession;
      sessionChanged = true;
    } else {
      state.session = authoritativeSession;
      // 同会话的新快照（断线补齐等）：投影被整体替换，全部派生视图需要重新同步。
      bump(state, ["messages", "run", "queue", "decisions", "errors"]);
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

// 第十二轮 F1：Run 终态/waiting_user 时把未定稿的流式正文收敛为正式消息
// （interrupted 标记，区别于 assistant_message_completed 的正常定稿）。
// 只在事件路径调用；重建重放同一算法，确定性一致。
function finalizeAssistantStream(state, seq) {
  const stream = state.assistantStream;
  // null-seq 退化事件不定稿：event_key 会退化为 `finalize:null`，去重失效，
  // 每次重建都重复插入气泡；正常路径（实录日志/恢复重放）seq 恒有值。
  if (seq == null || !stream || stream.text.length === 0) return;
  state.conversation.push({
    role: "assistant",
    text: stream.text,
    input_id: null,
    seq,
    // 审核修订（P1-8）：event_key 用稳定键 `finalize:${seq}`——syncMessages 以
    // event_key 去重（view.js:631），null-key 消息会在每次 messages 重建
    // （rebuildDerivedState / 任何 messages revision 变化）时重复插入气泡。
    event_key: `finalize:${seq}`,
    truncated: false,
    interrupted: true
  });
  state.assistantStream = null;
  bump(state, ["messages"]);
}

// 单条事件的派生应用：增量 fast path 与 rebuildDerivedState 共用同一实现。
function applyEventToState(state, event) {
  const type = event.type;
  const payload = event.payload ?? {};
  const rawSeq = Number(event.seq);
  const seq = Number.isFinite(rawSeq) ? rawSeq : null;
  const key = eventKey(event);
  // 审核修订（F5）：任何非连接类事件到达即代表流已恢复（SSE 事件只从流来），
  // 撤掉连接类错误卡。rebuildDerivedState 重放共用同一函数，天然幂等。
  if (type !== "connection_error") {
    state.errors = state.errors.filter(
      (e) => e.code !== "event_stream_error" && e.code !== "event_stream_fatal"
    );
  }
  switch (type) {
    case "session_created": {
      state.sessionId = event.session_id ?? state.sessionId;
      break;
    }
    case "input_queued": {
      // Task 11：queued 只出现在「接下来」区域，不提前渲染为正式对话气泡；
      // input_started 才是用户文本进入对话/transcript 的唯一边界。
      const inputId = payload.input_id ?? null;
      const text = String(payload.text ?? "");
      if (inputId != null) state.queuedTexts.set(inputId, text);
      if (state.session && inputId != null) {
        if (!Array.isArray(state.session.queued_inputs)) state.session.queued_inputs = [];
        const queue = state.session.queued_inputs;
        if (!queue.some((item) => item.id === inputId)) {
          const item = { id: inputId, text, status: "queued", queued_at: payload.queued_at ?? event.at ?? null };
          if (payload.kind === "compact") item.kind = "compact";
          queue.push(item);
        }
      }
      bump(state, ["queue"]);
      break;
    }
    case "input_started": {
      // 输入离开队列成为活动输入：此时才进入用户可见对话历史（文本取自
      // input_queued 建立的 queuedTexts 索引；重建回放时同样由它取回）。
      // 设计局限：正文只从已加载窗口（loadedEvents）的 input_queued 取回；若
      // 该 input_queued 落在窗口之外（前置分页尚未加载的更早历史），started
      // 事件到达时取不到文本，本分支不产生空气泡（text.length > 0 守卫）——
      // 与「queued 只在窗口内可见」的投影口径一致，真实窗口内成对事件不受影响。
      const inputId = payload.input_id ?? null;
      const text = inputId != null ? (state.queuedTexts.get(inputId) ?? "") : "";
      if (state.session && inputId != null) {
        if (Array.isArray(state.session.queued_inputs)) {
          state.session.queued_inputs = state.session.queued_inputs.filter((item) => item.id !== inputId);
        }
        // 匹配 priority 的 input_started 清除优先标记（SPEC 3.3：真正开始后恢复优先）
        if (state.session.priority_input_id === inputId) state.session.priority_input_id = null;
        const run = state.session.active_run;
        if (run) run.active_input_id = inputId;
      }
      if (inputId != null) state.queuedTexts.delete(inputId);
      if (text.length > 0) {
        state.conversation.push({
          role: "user",
          text,
          input_id: inputId,
          seq,
          event_key: key
        });
      }
      bump(state, ["messages", "queue"]);
      break;
    }
    case "input_completed":
    case "input_interrupted": {
      // 活动输入的终态：只清空 active_input_id（Run 继续；queue 由 input_started
      // 已移除）。input_interrupted 是被优先输入截断，不等同于 Run 终结。
      const run = state.session?.active_run;
      const inputId = payload.input_id ?? null;
      if (run && inputId != null && run.active_input_id === inputId) {
        run.active_input_id = null;
      }
      bump(state, ["run"]);
      break;
    }
    case "input_withdrawn":
    case "input_cancelled": {
      // 撤回或由 Run 级取消终结的输入都从「接下来」移除，并清理优先标记。
      const inputId = payload.input_id ?? null;
      if (state.session && inputId != null) {
        if (Array.isArray(state.session.queued_inputs)) {
          state.session.queued_inputs = state.session.queued_inputs.filter((item) => item.id !== inputId);
        }
        if (state.session.priority_input_id === inputId) state.session.priority_input_id = null;
      }
      if (inputId != null) state.queuedTexts.delete(inputId);
      bump(state, ["queue"]);
      break;
    }
    case "priority_input_requested": {
      // 「立即」被接受：只设置 priority_input_id（不立即改写 active_input_id，
      // 切换由安全点批次完成）。前端据此禁用其余「立即」并标出下一条目标。
      const inputId = payload.input_id ?? null;
      if (state.session && inputId != null) {
        state.session.priority_input_id = inputId;
      }
      bump(state, ["queue"]);
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
          event_key: key,
          // Task 4：completed 携带 truncated 标记（核心按 finish_reason=length 判定），
          // 投影到消息记录供 view 渲染截断提示；缺省视为完整输出。
          truncated: payload.truncated === true
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
        // retry：恢复同一可恢复 Run（保留 started_at/visible_plan）
        existing.status = "running";
        state.session.status = "running";
      } else {
        state.session.active_run = {
          id: event.run_id ?? null,
          status: "running",
          active_input_id: payload.input_id ?? null,
          visible_plan: null,
          active_grants: [],
          started_at: event.at ?? null
        };
        state.session.status = "running";
      }
      activateInput(state, payload.input_id ?? null);
      state.errors = [];
      // 新 Run（或重试恢复）从零累积正文增量：先定稿上一轮残留的流式正文
      // （retry 不再静默删除半截输出）。
      finalizeAssistantStream(state, seq);
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
      // F1：等待用户决策或终态时正文已停——定稿残留流式文本（终态防御：
      // targetTerminal 分支允许 run_status_changed 携带终态 status，历史日志/
      // 恢复重放若走此路径同样收敛，不违反「终态无残留流式」不变量）。
      if (run.status === "waiting_user" || TERMINAL_RUN_STATUSES.has(run.status)) {
        finalizeAssistantStream(state, seq);
      }
      bump(state, ["run"]);
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
        // 第九轮：顶层 plan 投影供 plan-panel chip 消费（与 visible_plan 并存）。
        const planItems = Array.isArray(payload.items) ? structuredClone(payload.items) : [];
        state.plan = planItems.length === 0
          ? null
          : { explanation: typeof payload.explanation === "string" ? payload.explanation : null, items: planItems };
        bump(state, ["plan"]);
      }
      break;
    }
    case "model_turn_started": {
      // 未闭合 model turn 的追踪已由 thinking 计数迁移到 work 投影（Task 5）：
      // legacy 开放 turn 由 reduceWorkEvent 在 work 组的 legacyOpenTurns 计数。
      // 此处仅清槽、不定稿：turn 边界即新回合开始，残留 delta（若有）属于上一
      // 回合，已由上一回合的终态/waiting_user 定稿或随后的 run_started 处理；
      // 正常序列里本事件之前不会有未闭合 delta，故清空即可，不重复定稿。
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
      // F1：失败也是终态——先把流式正文定稿为 interrupted 气泡，再清空流槽。
      finalizeAssistantStream(state, seq);
      const run = state.session?.active_run;
      if (run) {
        run.status = "failed";
        run.active_input_id = null;
        state.session.status = "idle";
      }
      bump(state, ["run", "errors"]);
      break;
    }
    case "connection_error": {
      // 连续 error 帧不再叠加多张卡，同 code 只留一张可更新的卡（F5 清卡语义的
      // 一半：去重；另一半=非连接事件到达即清，见入口过滤）。
      const code = payload.code ?? "event_stream_error";
      const err = {
        seq,
        run_id: null,
        message: typeof payload.message === "string" ? payload.message : "事件流连接失败。",
        code
      };
      const idx = state.errors.findIndex((e) => e.code === code);
      if (idx >= 0) state.errors[idx] = err;
      else state.errors.push(err);
      bump(state, ["errors"]);
      break;
    }
    case "run_completed": {
      // F1：终态定稿——即使没收到 assistant_message_completed，流式正文也不残留。
      finalizeAssistantStream(state, seq);
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
      // F1：取消同样定稿残留正文（interrupted 标记，非静默删除）。
      finalizeAssistantStream(state, seq);
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
      // F1：中断即终态——把半截正文定稿为 interrupted 气泡。
      finalizeAssistantStream(state, seq);
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
    // 第九轮：系统通知行（chapter_rolled_back / memory_file_restored → timeline）。
    case "chapter_rolled_back":
    case "memory_file_restored": {
      if (!Array.isArray(state.systemNotices)) state.systemNotices = [];
      state.systemNotices.push({ seq, type, payload: structuredClone(payload) });
      bump(state, ["notices"]);
      break;
    }
    default:
      break;
  }
  // 每个 journal 事件先进入现有会话 reducer，再进入 work 投影（Task 5 Step 6）。
  // reduceWorkEvent 只读事件字段（run_id/seq/project_root/payload），不读 DOM。
  reduceWorkEvent(state.work, event);
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
// 按 (seq, event_key) 排序 loadedEvents，从空的 conversation/work/
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
  // Task 11：队列镜像重建。镜像承载在 session.queued_inputs 上，但乱序事件触发
  // 的全集重建必须以事件重放为准（顺序确定）：先保留「窗口外」的排队项（快照
  // 权威、尚未见到其 input_queued 事件），再让 input_queued 按 seq 顺序补入。
  // priority_input_id 不在此重置——窗口内事件的重放会按序覆盖/清除，窗口外
  //（快照权威）的值保留，避免重建后「立即」按钮态倒退。
  if (state.session) {
    const queuedIdsInEvents = new Set();
    for (const event of events) {
      if (event.type === "input_queued" && event.payload?.input_id != null) {
        queuedIdsInEvents.add(String(event.payload.input_id));
      }
    }
    const baseQueue = Array.isArray(state.session.queued_inputs) ? state.session.queued_inputs : [];
    state.session.queued_inputs = baseQueue.filter((item) => !queuedIdsInEvents.has(String(item.id)));
  }
  state.conversation = [];
  // Task 11：排队文本索引同样由事件重放重建（input_started 的正文依赖它）。
  state.queuedTexts = new Map();
  state.work = createWorkState();
  state.decisions = new Map();
  state.errors = [];
  state.assistantStream = null;
  // 第九轮：顶层计划投影同样由事件重放重建。
  state.plan = null;
  // Task 11：上下文用量/压缩投影同样由事件重放重建（确定性与增量路径一致）。
  state.contextUsage = null;
  state.compaction = null;
  state.compactionRows = new Map();
  // 第九轮：系统通知行同样由事件重放重建。
  state.systemNotices = [];
  for (const event of events) applyEventToState(state, event);
  bump(state, ["messages", "run", "queue", "decisions", "errors", "context", "notices", "plan"]);
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

// 压缩阻塞普通发送的状态（镜像核心 COMPACTION_SEND_BLOCKED_STATES 的视图口径）：
// 在途（started/running/cancelling）与失败（等待用户 重试/取消 决策）禁用发送；
// completed/cancelled/noop 均恢复正常发送（取消完成把文本留在 draft，send 恢复）。
export const COMPACTION_BLOCKED_STATES = new Set(["started", "running", "cancelling", "failed"]);

export function compactionBlocksSend(compaction) {
  return Boolean(compaction) && COMPACTION_BLOCKED_STATES.has(compaction.state);
}

export function isRunActive(run) {
  return Boolean(run) && !TERMINAL_RUN_STATUSES.has(run.status);
}

// Task 16（R5-7）：会话 projection 的 needs_history_clear（journal 退化投影标记，
// 后端 snapshot 原样透出）——前端据此显示「此对话已损坏」并禁发（view 的
// canSubmit 门禁读取本 getter）。
export function getNeedsHistoryClear(state) {
  return state.session?.needs_history_clear === true;
}
