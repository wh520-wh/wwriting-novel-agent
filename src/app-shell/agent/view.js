// src/app-shell/agent/view.js —— AgentSurface 单一视图（Task 8 Step 3-4）。
//
// 原生 DOM（无框架）渲染：对话、当前 Run（状态行 + Visible Plan + 决策/错误卡）、
// 单条活动流、排队输入、composer。Plan 与 queue 渲染器是本文件的私有函数，
// 不创建额外的公共 UI 模块。
//
// 活动行为（从 chat-activity-view.js 移植的验收行为）：
//   - 同一 activity_id 合并到同一行，增量输出只更新文本不重建 DOM；
//   - 最多 20 行：只移除最早的终态行，运行中的行永不丢弃；
//   - 单行输出保留最后 64 KiB，截断后前置「（输出过长已截断）」；
//   - 详情字段顺序固定：参数 → 命令 → 目录 → 退出码 → 耗时 → 错误；
//   - 停止按钮点击立即禁用防连点，仅停止失败或终态事件后恢复；
//   - 终态（complete/failed/cancelled）每活动只渲染一次标记；
//   - 思考/活动标签可见，私有推理字段永不渲染；
//   - 自动滚动只在用户接近底部时触发；重建 DOM 后把活动流末端重新锚定，
//     但不打断正在阅读更早内容的用户。
import {
  getActiveRun,
  getVisiblePlan,
  getPendingDecisions,
  getQueuedInputs,
  isRunActive,
  hasOpenModelTurn,
  ACTIVITY_TERMINAL_STATUSES,
  TERMINAL_RUN_STATUSES
} from "./state.js";

const MAX_ROWS = 20;
const OUTPUT_TRUNCATED_MARK = "（输出过长已截断）\n";
const SCROLL_THRESHOLD = 48;

// view.js 私有的 11 个工具短活动文案（tool-labels.mjs 在 Task 9 删除，不依赖它）。
const ACTIVITY_LABELS = {
  list_files: () => "查看文件列表",
  search_files: (a) => (a?.query ? `搜索「${a.query}」` : "搜索文件"),
  read_file: () => "读取文件",
  write_file: () => "写入文件",
  edit_file: () => "修改文件",
  shell: () => "运行命令",
  update_plan: () => "更新任务计划",
  enter_workflow: () => "切换工作流",
  append_chapter_segment: () => "写入章节内容",
  commit_chapter: () => "提交章节",
  commit_blueprint: () => "提交蓝图"
};

const RUN_STATUS_TEXT = {
  waiting_user: "等待确认",
  interrupting: "正在打断",
  stopping: "正在停止",
  cancelled: "已停止",
  failed: "操作失败",
  interrupted: "已中断",
  completed: "已完成"
};

const PLAN_MARKS = { completed: "✓", in_progress: "•", pending: "○" };

// 详情字段固定顺序（验收契约）。
const FIELD_ORDER = ["参数", "命令", "目录", "退出码", "耗时", "错误"];

// 活动 args 可能是对象或字符串化 JSON（旧工具摘要格式）；统一解析为对象。
function parseArgs(args) {
  if (args == null) return {};
  if (typeof args === "object") return args;
  try {
    const parsed = JSON.parse(String(args));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function activityLabel(activity) {
  const fn = ACTIVITY_LABELS[activity?.name];
  if (fn) return fn(parseArgs(activity?.args));
  return activity?.name ? `工具 ${activity.name}` : "调用工具中";
}

export function markFor(status) {
  if (status === "completed") return "✓";
  if (status === "failed") return "✗";
  if (status === "cancelled") return "已停止";
  return "•";
}

export function createAgentView({ root, document: doc = globalThis.document }) {
  // ---- 静态骨架 ------------------------------------------------------------
  const surface = doc.createElement("div");
  surface.className = "agent-surface";
  surface.dataset.testid = "agent-surface";

  const conv = doc.createElement("div");
  conv.className = "agent-conversation";
  conv.dataset.testid = "agent-conversation";
  conv.setAttribute("role", "log");
  conv.setAttribute("aria-live", "polite");

  const messages = doc.createElement("div");
  messages.className = "agent-messages";

  const runSection = doc.createElement("div");
  runSection.className = "agent-run";
  runSection.dataset.testid = "agent-run";
  const runHeader = doc.createElement("div");
  runHeader.className = "agent-run-header";
  const planSlot = doc.createElement("div");
  planSlot.className = "agent-plan-slot";
  const decisionsSlot = doc.createElement("div");
  decisionsSlot.className = "agent-decisions";
  const errorsSlot = doc.createElement("div");
  errorsSlot.className = "agent-errors";
  runSection.append(runHeader, planSlot, decisionsSlot, errorsSlot);

  const activities = doc.createElement("div");
  activities.className = "agent-activities";
  activities.dataset.testid = "agent-activities";

  const queueSlot = doc.createElement("div");
  queueSlot.className = "agent-queue";
  queueSlot.dataset.testid = "agent-queue";

  conv.append(messages, runSection, activities, queueSlot);

  const composer = doc.createElement("div");
  composer.className = "agent-composer";
  const input = doc.createElement("textarea");
  input.className = "agent-composer-input";
  input.dataset.testid = "agent-composer-input";
  input.placeholder = "输入消息";
  input.rows = 1;
  input.setAttribute("aria-label", "给智能体下达指令");
  const send = doc.createElement("button");
  send.type = "button";
  send.className = "agent-send";
  send.dataset.testid = "agent-send";
  send.textContent = "发送";
  composer.append(input, send);

  surface.append(conv, composer);
  root.append(surface);

  // ---- 视图内部状态 ----------------------------------------------------------
  let actions = {};            // 最近一次 render 传入的动作回调
  let stopPending = false;     // 停止请求在途（防连点）
  let lastMessageSeq = -1;
  let planNode = null;         // 已渲染的 Plan <details>（终态折叠只切换 open，不重建节点）
  const rows = new Map();      // activity_id -> row（合并同活动）
  const trimmedIds = new Set(); // 已按 20 行上限裁剪的活动 id（不再重建）
  const decisionCards = new Map(); // decision_id -> card（diff 更新，保留 extreme 输入）
  const rendered = {
    messages: -1, run: -1, plan: -1, queue: -1, decisions: -1, errors: -1,
    runId: null, runStatus: null
  };

  function reset() {
    messages.replaceChildren();
    runHeader.replaceChildren();
    planSlot.replaceChildren();
    decisionsSlot.replaceChildren();
    errorsSlot.replaceChildren();
    activities.replaceChildren();
    queueSlot.replaceChildren();
    planNode = null;
    rows.clear();
    trimmedIds.clear();
    for (const card of decisionCards.values()) card.remove();
    decisionCards.clear();
    lastMessageSeq = -1;
    rendered.messages = rendered.run = rendered.plan = rendered.queue = -1;
    rendered.decisions = rendered.errors = -1;
    rendered.runId = null;
    rendered.runStatus = null;
    stopPending = false;
  }

  function destroy() {
    surface.remove();
  }

  // ---- 自动滚动：仅用户接近底部时跟随 ----------------------------------------
  function isNearBottom() {
    const height = Number(conv.scrollHeight ?? 0);
    const client = Number(conv.clientHeight ?? 0);
    const top = Number(conv.scrollTop ?? 0);
    if (height <= client) return true;
    return height - top - client < SCROLL_THRESHOLD;
  }

  function scrollToBottom() {
    const height = Number(conv.scrollHeight ?? 0);
    const client = Number(conv.clientHeight ?? 0);
    conv.scrollTop = Math.max(0, height - client);
  }

  function maybeScrollToBottom() {
    if (isNearBottom()) scrollToBottom();
  }

  // ---- 对话 ----------------------------------------------------------------
  function syncMessages(state) {
    if (rendered.messages === state.revisions.messages) return;
    for (const entry of state.conversation) {
      if (entry.seq != null && entry.seq <= lastMessageSeq) continue;
      if (entry.role === "user") {
        const bubble = doc.createElement("div");
        bubble.className = "agent-message agent-message--user";
        bubble.dataset.testid = "agent-user-message";
        const text = doc.createElement("div");
        text.className = "agent-message-text";
        text.textContent = String(entry.text ?? "");
        bubble.append(text);
        messages.append(bubble);
      } else if (typeof entry.text === "string" && entry.text.length > 0) {
        const bubble = doc.createElement("div");
        bubble.className = "agent-message agent-message--assistant";
        bubble.dataset.testid = "agent-assistant-message";
        const text = doc.createElement("div");
        text.className = "agent-message-text";
        text.textContent = entry.text;
        bubble.append(text);
        messages.append(bubble);
      }
      if (entry.seq != null) lastMessageSeq = entry.seq;
    }
    rendered.messages = state.revisions.messages;
    maybeScrollToBottom();
  }

  // ---- 当前 Run：状态行（停止/重试）+ Plan + 决策/错误 ------------------------
  function runStatusText(run, state) {
    if (RUN_STATUS_TEXT[run.status]) return RUN_STATUS_TEXT[run.status];
    if (run.status === "running") return hasOpenModelTurn(state) ? "思考中" : "运行中";
    return String(run.status);
  }

  function renderRunHeader(state) {
    runHeader.replaceChildren();
    const run = getActiveRun(state);
    if (!run) return;
    const status = doc.createElement("span");
    status.className = "agent-run-status";
    status.dataset.testid = "agent-run-status";
    status.textContent = runStatusText(run, state);
    runHeader.append(status);
    if (isRunActive(run)) {
      const stop = doc.createElement("button");
      stop.type = "button";
      stop.className = "agent-stop-btn";
      stop.dataset.testid = "agent-stop";
      stop.textContent = "停止";
      stop.disabled = stopPending;
      stop.addEventListener("click", () => {
        if (stop.disabled) return;
        stop.disabled = true;
        stopPending = true;
        try {
          Promise.resolve(actions.stop?.(run.id)).catch(() => {
            stop.disabled = false;
            stopPending = false;
          });
        } catch {
          stop.disabled = false;
          stopPending = false;
        }
      });
      runHeader.append(stop);
    } else if (run.status === "failed" || run.status === "interrupted") {
      const retry = doc.createElement("button");
      retry.type = "button";
      retry.className = "agent-retry-btn";
      retry.dataset.testid = "agent-retry";
      retry.textContent = "重试";
      // 防连点：点击即禁用；请求失败才恢复（成功路径由 run_started 重建头部，
      // 重试按钮自然消失，无需显式恢复）。
      retry.addEventListener("click", () => {
        if (retry.disabled) return;
        retry.disabled = true;
        try {
          Promise.resolve(actions.retry?.(run.id)).catch(() => {
            retry.disabled = false;
          });
        } catch {
          retry.disabled = false;
        }
      });
      runHeader.append(retry);
    }
  }

  function syncRun(state) {
    const run = getActiveRun(state);
    const runId = run?.id ?? null;
    const runChanged = rendered.runId !== runId;
    // retry：同 run id 从终态重新进入 running（run_failed/run_interrupted 后重试恢复）。
    // 停止请求若仍在途（stopPending），此时必须恢复，否则重试后的 Run 永远无法停止。
    const resumedAfterTerminal =
      rendered.runStatus != null &&
      TERMINAL_RUN_STATUSES.has(rendered.runStatus) &&
      run &&
      !TERMINAL_RUN_STATUSES.has(run.status);
    if (resumedAfterTerminal) stopPending = false;
    if (rendered.run !== state.revisions.run) {
      rendered.run = state.revisions.run;
      renderRunHeader(state);
    }
    if (runChanged) {
      rendered.runId = runId;
      stopPending = false;
      // 新 Run：清空上一轮的 Plan/决策/错误槽位并强制重建
      planSlot.replaceChildren();
      planNode = null;
      for (const card of decisionCards.values()) card.remove();
      decisionCards.clear();
      errorsSlot.replaceChildren();
      rendered.plan = -1;
      rendered.decisions = -1;
      rendered.errors = -1;
    }
    rendered.runStatus = run?.status ?? null;
  }

  function buildPlanNode(plan) {
    const details = doc.createElement("details");
    details.className = "agent-plan";
    details.dataset.testid = "agent-plan";
    const summary = doc.createElement("summary");
    summary.textContent = "任务计划";
    details.append(summary);
    if (typeof plan.explanation === "string" && plan.explanation.length > 0) {
      const explanation = doc.createElement("p");
      explanation.className = "agent-plan-explanation";
      explanation.textContent = plan.explanation;
      details.append(explanation);
    }
    const list = doc.createElement("ol");
    list.className = "agent-plan-items";
    for (const item of plan.items) {
      const li = doc.createElement("li");
      li.className = "agent-plan-item";
      li.dataset.status = item.status;
      const mark = doc.createElement("span");
      mark.className = "agent-plan-mark";
      mark.textContent = PLAN_MARKS[item.status] ?? "○";
      const step = doc.createElement("span");
      step.className = "agent-plan-step";
      step.textContent = String(item.step ?? "");
      li.append(mark, step);
      list.append(li);
    }
    details.append(list);
    return details;
  }

  function syncPlan(state) {
    const run = getActiveRun(state);
    if (rendered.plan !== state.revisions.plan) {
      rendered.plan = state.revisions.plan;
      planSlot.replaceChildren();
      planNode = null;
      const plan = getVisiblePlan(state);
      if (plan && Array.isArray(plan.items) && plan.items.length > 0) {
        planNode = buildPlanNode(plan);
        planSlot.append(planNode);
      }
    }
    // 活动 Run 展开；Run 终态后折叠（同一节点切换 open，只读，无编辑入口）。
    if (planNode) planNode.open = isRunActive(run);
    if (planNode) maybeScrollToBottom();
  }

  // ---- 决策卡：普通确认 + 红色 extreme 精确文字确认 ---------------------------
  function buildDecisionCard(decision) {
    const card = doc.createElement("div");
    card.className = "agent-decision" + (decision.kind === "extreme" ? " agent-decision--extreme" : "");
    card.dataset.testid = "agent-decision-card";
    card.dataset.decisionId = decision.decision_id;
    const title = doc.createElement("strong");
    title.className = "agent-decision-title";
    title.textContent = decision.title ?? "确认操作";
    card.append(title);
    if (typeof decision.description === "string" && decision.description.length > 0) {
      const description = doc.createElement("p");
      description.className = "agent-decision-description";
      description.textContent = decision.description;
      card.append(description);
    }
    const actionRow = doc.createElement("div");
    actionRow.className = "agent-decision-actions";
    if (decision.kind === "extreme") {
      const hint = doc.createElement("p");
      hint.className = "agent-decision-confirm";
      hint.textContent = `输入确认文字以执行：${decision.confirmation_text ?? ""}`;
      card.append(hint);
      const input = doc.createElement("input");
      input.type = "text";
      input.className = "agent-decision-input";
      input.dataset.testid = "agent-decision-input";
      input.setAttribute("aria-label", "输入确认文字");
      const execute = doc.createElement("button");
      execute.type = "button";
      execute.className = "agent-decision-execute";
      execute.dataset.testid = "agent-decision-execute";
      execute.textContent = "执行";
      execute.disabled = true; // 精确文字输入前不可执行
      input.addEventListener("input", () => {
        execute.disabled = String(input.value ?? "") !== decision.confirmation_text;
      });
      execute.addEventListener("click", () => {
        if (execute.disabled) return;
        actions.decide?.(decision.decision_id, decision.confirmation_text);
      });
      const deny = doc.createElement("button");
      deny.type = "button";
      deny.className = "agent-decision-deny";
      deny.dataset.testid = "agent-decision-deny";
      deny.textContent = "拒绝";
      deny.addEventListener("click", () => actions.decide?.(decision.decision_id, "deny"));
      actionRow.append(execute, deny);
      card.append(input, actionRow);
    } else {
      const choices = [
        ["allow", "一次允许"],
        ["allow_input", "本条输入允许同类操作"],
        ["deny", "拒绝"]
      ];
      for (const [choice, label] of choices) {
        const button = doc.createElement("button");
        button.type = "button";
        button.dataset.choice = choice;
        button.dataset.testid = "agent-decision-choice";
        button.textContent = label;
        button.addEventListener("click", () => actions.decide?.(decision.decision_id, choice));
        actionRow.append(button);
      }
      card.append(actionRow);
    }
    return card;
  }

  function syncDecisions(state) {
    if (rendered.decisions === state.revisions.decisions) return;
    rendered.decisions = state.revisions.decisions;
    const run = getActiveRun(state);
    if (!run || !isRunActive(run)) {
      // 待决决策只属于活动 Run；终态一律锁定，全部下架。
      for (const card of decisionCards.values()) card.remove();
      decisionCards.clear();
      return;
    }
    const pending = getPendingDecisions(state).filter((d) => d.run_id === run.id);
    const pendingIds = new Set(pending.map((d) => d.decision_id));
    // 只移除已终结/不再展示的卡；不重建仍在展示的卡（保留 extreme 确认输入文字）。
    for (const [id, card] of decisionCards) {
      if (!pendingIds.has(id)) {
        card.remove();
        decisionCards.delete(id);
      }
    }
    let appended = false;
    for (const decision of pending) {
      if (!decisionCards.has(decision.decision_id)) {
        const card = buildDecisionCard(decision);
        decisionCards.set(decision.decision_id, card);
        decisionsSlot.append(card);
        appended = true;
      }
    }
    if (appended) maybeScrollToBottom();
  }

  // ---- 错误卡（简洁事实） ------------------------------------------------------
  function syncErrors(state) {
    if (rendered.errors === state.revisions.errors) return;
    rendered.errors = state.revisions.errors;
    errorsSlot.replaceChildren();
    for (const error of state.errors) {
      const card = doc.createElement("div");
      card.className = "agent-error";
      card.dataset.testid = "agent-error";
      const title = doc.createElement("strong");
      title.className = "agent-error-title";
      title.textContent = "操作失败";
      const message = doc.createElement("p");
      message.className = "agent-error-message";
      message.textContent = String(error.message ?? "");
      card.append(title, message);
      errorsSlot.append(card);
    }
    if (state.errors.length > 0) maybeScrollToBottom();
  }

  // ---- 活动流（单条流，同 activity_id 合并；20 行保留；64 KiB 输出尾） ---------
  function buildActivityRow(activity) {
    const wrap = doc.createElement("div");
    wrap.className = "agent-activity-item";
    wrap.dataset.activityId = activity.activity_id;
    wrap.dataset.state = activity.status;
    const details = doc.createElement("details");
    const summary = doc.createElement("summary");
    const mark = doc.createElement("span");
    mark.className = "agent-activity-mark";
    const label = doc.createElement("span");
    label.className = "agent-activity-label";
    summary.append(mark, label);
    const detail = doc.createElement("div");
    detail.className = "agent-activity-fields";
    const output = doc.createElement("pre");
    output.className = "agent-activity-output";
    details.append(summary, detail, output);
    wrap.append(details);
    return {
      wrap, mark, label, detail, output,
      fields: new Map(), fieldEls: new Map(), outputText: null
    };
  }

  // 详情字段：参数 → 命令 → 目录 → 退出码 → 耗时 → 错误（固定顺序，折叠在 details 内）。
  function syncActivityFields(row, activity) {
    const values = {
      "参数": activity.args == null ? null : JSON.stringify(activity.args),
      "命令": activity.command,
      "目录": activity.cwd,
      "退出码": activity.exit_code != null ? String(activity.exit_code) : null,
      "耗时": activity.duration_ms != null ? `${activity.duration_ms} ms` : null,
      "错误": activity.error
    };
    let created = false;
    for (const name of FIELD_ORDER) {
      const value = values[name];
      if (value == null || value === "") continue;
      let content = row.fields.get(name);
      if (!content) {
        const field = doc.createElement("div");
        field.className = "agent-activity-field";
        const key = doc.createElement("strong");
        key.textContent = name;
        content = doc.createElement("pre");
        field.append(key, content);
        row.detail.append(field);
        row.fields.set(name, content);
        row.fieldEls.set(name, field);
        created = true;
      }
      if (content.textContent !== value) content.textContent = value;
    }
    if (created) {
      // 新字段出现时按固定顺序重排（真实 DOM 中重复 append 会移动节点）。
      const sorted = FIELD_ORDER.map((name) => row.fieldEls.get(name)).filter(Boolean);
      row.detail.replaceChildren(...sorted);
    }
    return created;
  }

  function updateActivityRow(row, activity) {
    let changed = false;
    const labelText = activityLabel(activity);
    if (row.label.textContent !== labelText) {
      row.label.textContent = labelText;
      changed = true;
    }
    const markText = markFor(activity.status);
    if (row.mark.textContent !== markText) {
      row.mark.textContent = markText;
      changed = true;
    }
    row.wrap.dataset.state = activity.status;
    if (activity.text !== row.outputText) {
      row.output.textContent = (activity.truncated ? OUTPUT_TRUNCATED_MARK : "") + activity.text;
      row.outputText = activity.text;
      changed = true;
    }
    if (syncActivityFields(row, activity)) changed = true;
    return changed;
  }

  function trimRows() {
    if (rows.size <= MAX_ROWS) return;
    // 只移除最早的终态行；全部运行中时不裁剪（允许短暂超限）。
    for (const [id, row] of rows) {
      if (ACTIVITY_TERMINAL_STATUSES.has(row.wrap.dataset.state)) {
        row.wrap.remove();
        rows.delete(id);
        trimmedIds.add(id);
        return;
      }
    }
  }

  function syncActivities(state) {
    if (rendered.activities === state.revisions.activities) return;
    rendered.activities = state.revisions.activities;
    // state 层已按上限丢弃的活动：同步移除对应 DOM 行（不依赖历史扫描）。
    for (const [id, row] of rows) {
      if (!state.activities.has(id)) {
        row.wrap.remove();
        rows.delete(id);
      }
    }
    for (const activity of state.activities.values()) {
      if (trimmedIds.has(activity.activity_id)) continue;
      let row = rows.get(activity.activity_id);
      if (!row) {
        row = buildActivityRow(activity);
        rows.set(activity.activity_id, row);
        activities.append(row.wrap);
        trimRows();
        updateActivityRow(row, activity);
        maybeScrollToBottom();
        continue;
      }
      if (updateActivityRow(row, activity)) maybeScrollToBottom();
    }
  }

  // ---- 排队输入：原文 + 排队 + 立即 --------------------------------------------
  function syncQueue(state) {
    if (rendered.queue === state.revisions.queue) return;
    rendered.queue = state.revisions.queue;
    queueSlot.replaceChildren();
    for (const item of getQueuedInputs(state)) {
      const row = doc.createElement("div");
      row.className = "agent-queue-item";
      row.dataset.testid = "agent-queue-item";
      row.dataset.inputId = item.id;
      const text = doc.createElement("span");
      text.className = "agent-queue-text";
      text.textContent = String(item.text ?? "");
      const badge = doc.createElement("span");
      badge.className = "agent-queue-state";
      badge.textContent = "排队";
      const promote = doc.createElement("button");
      promote.type = "button";
      promote.className = "agent-promote";
      promote.dataset.testid = "agent-promote";
      promote.textContent = "立即";
      promote.addEventListener("click", () => actions.promote?.(item.id));
      row.append(text, badge, promote);
      queueSlot.append(row);
    }
    maybeScrollToBottom();
  }

  // ---- composer：项目打开即可用（运行中保持可用，普通发送进入队列） ------------
  function syncComposer(state) {
    const enabled = Boolean(state.projectRoot);
    input.disabled = !enabled;
    send.disabled = !enabled;
  }

  function submitFromComposer() {
    const text = String(input.value ?? "").trim();
    if (!text) return;
    try {
      Promise.resolve(actions.submit?.(text)).catch(() => {});
    } catch {
      // 提交失败静默：状态一致性由 SSE/快照恢复
    }
    input.value = "";
  }

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitFromComposer();
    }
  });
  send.addEventListener("click", () => submitFromComposer());

  // ---- 对外 ----------------------------------------------------------------
  function render(state, actionBag = {}) {
    actions = actionBag;
    syncMessages(state);
    syncRun(state);
    syncPlan(state);
    syncActivities(state);
    syncDecisions(state);
    syncErrors(state);
    syncQueue(state);
    syncComposer(state);
  }

  return { render, reset, destroy };
}
