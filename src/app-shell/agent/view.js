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
import { matchSlashCommands } from "./slash-commands.mjs";
import { renderMarkdown } from "../markdown-lite.mjs";
import { PERMISSION_TIERS } from "../permission-tiers.mjs";
import { icon } from "../icons.js";

const MAX_ROWS = 20;
const OUTPUT_TRUNCATED_MARK = "（输出过长已截断）\n";
const SCROLL_THRESHOLD = 48;

// view.js 私有的 11 个工具短活动文案（tool-labels.mjs 在 Task 9 删除，不依赖它）。
const ACTIVITY_LABELS = {
  list_files: () => "查看文件列表",
  search_files: (a) => (a?.query ? `搜索「${a.query}」` : "搜索文件"),
  // 带 path 的工具优先显示项目相对路径（args 已脱敏）；无 path 回退泛化文案。
  read_file: (a) => (a?.path ? `读取文件 ${a.path}` : "读取文件"),
  write_file: (a) => (a?.path ? `写入文件 ${a.path}` : "写入文件"),
  edit_file: (a) => (a?.path ? `修改文件 ${a.path}` : "修改文件"),
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

// 折叠态 3 项选取（步骤5 产品决策 4）：优先包含 in_progress 项，再取相邻步骤
// （前一个/后一个）；没有 in_progress 时取前 3 项。纯函数，供单测直接调用。
export function pickCollapsedPlanItems(items) {
  if (!Array.isArray(items)) return [];
  const list = items.filter(Boolean);
  const index = list.findIndex((item) => item?.status === "in_progress");
  if (index < 0) return list.slice(0, 3);
  return list.slice(Math.max(0, index - 1), Math.min(list.length, index + 2));
}

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

export function createAgentView({ root, document: doc = globalThis.document, requestFrame = null }) {
  // 增量正文渲染的合帧节流：真实 DOM 用 requestAnimationFrame；无 rAF 环境
  // （测试/SSR）回退 setTimeout(0)，行为等价——同一任务内多次变更只渲染一次。
  const scheduleFrame =
    requestFrame ??
    (typeof globalThis.requestAnimationFrame === "function"
      ? (cb) => globalThis.requestAnimationFrame(cb)
      : (cb) => setTimeout(cb, 0));

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

  // 未选择项目时的产品起点。项目动作仍由 app.js 持有，这里只呈现入口，
  // 避免在 AgentSurface 内复制新建/打开项目的业务流程。
  const emptyState = doc.createElement("div");
  emptyState.className = "agent-empty";
  emptyState.dataset.testid = "agent-empty";
  emptyState.setAttribute("aria-labelledby", "agent-empty-title");
  const emptyMark = doc.createElement("div");
  emptyMark.className = "agent-empty-mark";
  emptyMark.setAttribute("aria-hidden", "true");
  const viewIcon = (name, size, className) => icon(name, size, className, doc);
  emptyMark.append(viewIcon("book", 27));
  const emptyTitle = doc.createElement("h1");
  emptyTitle.id = "agent-empty-title";
  emptyTitle.className = "agent-empty-title";
  emptyTitle.textContent = "从一部小说开始";
  const emptyLead = doc.createElement("p");
  emptyLead.className = "agent-empty-lead";
  emptyLead.textContent = "建立新的写作项目，或继续已有作品。";
  const emptyActions = doc.createElement("div");
  emptyActions.className = "agent-empty-actions";

  function createEmptyAction({ testid, iconName, title, description, action }) {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "agent-empty-action";
    button.dataset.testid = testid;
    const actionIcon = doc.createElement("span");
    actionIcon.className = "agent-empty-action-icon";
    actionIcon.setAttribute("aria-hidden", "true");
    actionIcon.append(viewIcon(iconName, 18));
    const copy = doc.createElement("span");
    copy.className = "agent-empty-action-copy";
    const label = doc.createElement("strong");
    label.textContent = title;
    const detail = doc.createElement("span");
    detail.textContent = description;
    copy.append(label, detail);
    button.append(actionIcon, copy, viewIcon("chevR", 16));
    button.addEventListener("click", () => actions[action]?.());
    return button;
  }

  emptyActions.append(
    createEmptyAction({
      testid: "agent-empty-create",
      iconName: "compose",
      title: "新建小说",
      description: "创建一个新的写作项目",
      action: "createProject"
    }),
    createEmptyAction({
      testid: "agent-empty-open",
      iconName: "folder",
      title: "打开本地文件夹",
      description: "继续已有的 WWriting 项目",
      action: "openProjectFolder"
    })
  );
  emptyState.append(emptyMark, emptyTitle, emptyLead, emptyActions);

  const runSection = doc.createElement("div");
  runSection.className = "agent-run";
  runSection.dataset.testid = "agent-run";
  const runHeader = doc.createElement("div");
  runHeader.className = "agent-run-header";
  const decisionsSlot = doc.createElement("div");
  decisionsSlot.className = "agent-decisions";
  const errorsSlot = doc.createElement("div");
  errorsSlot.className = "agent-errors";
  runSection.append(runHeader, decisionsSlot, errorsSlot);

  const activities = doc.createElement("div");
  activities.className = "agent-activities";
  activities.dataset.testid = "agent-activities";

  const queueSlot = doc.createElement("div");
  queueSlot.className = "agent-queue";
  queueSlot.dataset.testid = "agent-queue";

  conv.append(emptyState, messages, runSection, activities, queueSlot);

  const composer = doc.createElement("div");
  composer.className = "agent-composer";
  composer.dataset.testid = "agent-composer";
  const slashMenu = doc.createElement("div");
  slashMenu.id = "agent-slash-menu";
  slashMenu.className = "agent-slash-menu";
  slashMenu.dataset.testid = "agent-slash-menu";
  slashMenu.setAttribute("role", "listbox");
  slashMenu.setAttribute("aria-label", "斜杠命令");
  slashMenu.hidden = true;
  const input = doc.createElement("textarea");
  input.className = "agent-composer-input";
  input.dataset.testid = "agent-composer-input";
  input.placeholder = "输入消息";
  input.rows = 3;
  input.setAttribute("aria-label", "给智能体下达指令");
  input.setAttribute("aria-controls", "agent-slash-menu");
  const composerShell = doc.createElement("div");
  composerShell.className = "agent-composer-shell";
  composerShell.dataset.testid = "agent-composer-shell";
  const composerToolbar = doc.createElement("div");
  composerToolbar.className = "agent-composer-toolbar";
  const send = doc.createElement("button");
  send.type = "button";
  send.className = "agent-send";
  send.dataset.testid = "agent-send";
  send.setAttribute("aria-label", "发送");
  send.title = "发送";
  send.append(viewIcon("arrowUp", 17));
  // 三控件（模型 / 权限模式 / 思考强度）共享同一桌面菜单内核。
  // 菜单是 composer 内的向上浮层，不交给系统原生 select 决定方向和样式。
  const controls = doc.createElement("div");
  controls.className = "agent-composer-controls";
  const composerMenus = [];

  function createComposerMenu({ kind, triggerTestId, menuTestId, label }) {
    const wrap = doc.createElement("div");
    wrap.className = `agent-composer-menu agent-composer-menu--${kind}`;
    const trigger = doc.createElement("button");
    trigger.type = "button";
    trigger.className = "agent-composer-menu-trigger";
    trigger.dataset.testid = triggerTestId;
    trigger.setAttribute("aria-label", label);
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    const value = doc.createElement("span");
    value.className = "agent-composer-menu-value";
    const chevron = viewIcon("chevR", 13, "agent-composer-menu-chevron");
    trigger.append(value, chevron);
    const menu = doc.createElement("div");
    menu.className = "agent-composer-popover";
    menu.dataset.testid = menuTestId;
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", label);
    menu.hidden = true;
    wrap.append(trigger, menu);
    const control = { kind, wrap, trigger, value, menu, items: [] };
    composerMenus.push(control);

    trigger.addEventListener("click", (event) => {
      event?.stopPropagation?.();
      if (trigger.disabled) return;
      const shouldOpen = menu.hidden;
      closeComposerMenus();
      if (shouldOpen) openComposerMenu(control);
    });
    trigger.addEventListener("keydown", (event) => {
      if (trigger.disabled) return;
      if (["Enter", " ", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        closeComposerMenus();
        openComposerMenu(control, event.key === "ArrowUp" ? -1 : 1);
      }
    });
    menu.addEventListener("keydown", (event) => handleComposerMenuKeydown(control, event));
    return control;
  }

  const modelControl = createComposerMenu({
    kind: "model",
    triggerTestId: "agent-model-select",
    menuTestId: "agent-model-menu",
    label: "选择模型"
  });
  const permissionControl = createComposerMenu({
    kind: "permission",
    triggerTestId: "agent-permission-select",
    menuTestId: "agent-permission-menu",
    label: "权限模式"
  });
  const effortControl = createComposerMenu({
    kind: "effort",
    triggerTestId: "agent-effort-select",
    menuTestId: "agent-effort-menu",
    label: "思考强度"
  });
  controls.append(modelControl.wrap, permissionControl.wrap, effortControl.wrap);
  composerToolbar.append(controls, send);
  composerShell.append(input, composerToolbar);
  composer.append(slashMenu, composerShell);

  surface.append(conv, composer);
  root.append(surface);

  // ---- 视图内部状态 ----------------------------------------------------------
  let actions = {};            // 最近一次 render 传入的动作回调
  let stopPending = false;     // 停止请求在途（防连点）
  let viewGeneration = 0;      // reset 后旧异步回调不得修改新项目视图
  let composerOptions = null;  // setComposerOptions 注入的控件选项（null = 未加载，控件禁用）
  let controlsSignature = "";  // 选项签名：未变化时不重建菜单（避免打断正在选择的用户）
  let composerEnabled = false; // 最近一次 syncComposer 的项目可用态
  let slashMatches = [];
  let slashActiveIndex = 0;
  let lastMessageSeq = -1;
  let currentState = null;     // 最近一次 render 的 state（供异步帧回调读取）
  // ---- Plan 悬浮层本地状态（不落 journal；truth 在 journal 的 plan_updated）----
  let planOverlay = null;         // 悬浮层根节点（内容按需重建）
  let planOverlayHidden = false;  // 新输入/新 Run 隐藏旧计划；新计划内容到达恢复显示
  let planMode = "summary";       // minimal / summary / full（本地 UI 态）
  let currentPlan = null;         // 最近渲染的 plan（toggle 重建内容用）
  let renderedPlanSignature = null; // 已处理的计划内容签名（同内容快照替换不打断显隐）
  let renderedPlanContent = null;   // 当前 DOM 中列表内容签名
  // ---- 增量正文流（Task 步骤7）：累积文本 → Markdown，rAF 合帧节流 ----
  let streamBubble = null;         // 流式 assistant 气泡（delta 期间的临时节点）
  let streamRenderPending = false; // 已有未决帧渲染
  let renderedStreamText = null;   // 最近已渲染的累积文本
  const rows = new Map();      // activity_id -> row（合并同活动）
  const trimmedIds = new Set(); // 已按 20 行上限裁剪的活动 id（不再重建）
  const decisionCards = new Map(); // decision_id -> card（diff 更新，保留 extreme 输入）
  const pendingSubmissions = []; // 仅保留仍在途的即时消息；终态立即移出，避免会话内累积
  const rendered = {
    messages: -1, run: -1, plan: -1, queue: -1, decisions: -1, errors: -1,
    runId: null, runStatus: null
  };

  function reset() {
    viewGeneration += 1;
    messages.replaceChildren();
    runHeader.replaceChildren();
    decisionsSlot.replaceChildren();
    errorsSlot.replaceChildren();
    activities.replaceChildren();
    queueSlot.replaceChildren();
    removePlanOverlay();
    planOverlayHidden = false;
    planMode = "summary";
    currentPlan = null;
    renderedPlanSignature = null;
    renderedPlanContent = null;
    currentState = null;
    if (streamBubble) { streamBubble.remove(); streamBubble = null; }
    streamRenderPending = false;
    renderedStreamText = null;
    rows.clear();
    trimmedIds.clear();
    for (const card of decisionCards.values()) card.remove();
    decisionCards.clear();
    pendingSubmissions.length = 0;
    composerOptions = null;
    controlsSignature = "";
    closeSlashMenu();
    lastMessageSeq = -1;
    rendered.messages = rendered.run = rendered.plan = rendered.queue = -1;
    rendered.decisions = rendered.errors = -1;
    rendered.runId = null;
    rendered.runStatus = null;
    stopPending = false;
  }

  function destroy() {
    doc.removeEventListener?.("pointerdown", handleComposerOutsidePointer, true);
    doc.removeEventListener?.("focusin", handleComposerOutsideFocus, true);
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
  function createMessageBubble(role, textValue, { markdown = false } = {}) {
    const bubble = doc.createElement("div");
    bubble.className = `agent-message agent-message--${role}`;
    bubble.dataset.testid = `agent-${role}-message`;
    const text = doc.createElement("div");
    text.className = "agent-message-text" + (markdown ? " agent-markdown" : "");
    if (markdown) {
      // 助手正文按累积文本重渲染 Markdown（renderMarkdown 纯函数，先转义后结构转换）。
      text.innerHTML = renderMarkdown(String(textValue ?? ""));
    } else {
      text.textContent = String(textValue ?? "");
    }
    bubble.append(text);
    return bubble;
  }

  function reconcilePendingSubmission(entry) {
    let index = pendingSubmissions.findIndex((item) =>
      item.inputId != null && item.inputId === entry.input_id
    );
    if (index < 0) {
      index = pendingSubmissions.findIndex((item) =>
        item.text === String(entry.text ?? "")
      );
    }
    if (index < 0) return;
    pendingSubmissions[index].node.remove();
    pendingSubmissions.splice(index, 1);
  }

  function syncMessages(state) {
    if (rendered.messages === state.revisions.messages) return;
    for (const entry of state.conversation) {
      if (entry.seq != null && entry.seq <= lastMessageSeq) continue;
      if (entry.role === "user") {
        reconcilePendingSubmission(entry);
        messages.append(createMessageBubble("user", entry.text));
      } else if (typeof entry.text === "string" && entry.text.length > 0) {
        // 助手正文走 Markdown 渲染（与流式气泡同一口径，增量/终态一致）。
        messages.append(createMessageBubble("assistant", entry.text, { markdown: true }));
      }
      if (entry.seq != null) lastMessageSeq = entry.seq;
    }
    rendered.messages = state.revisions.messages;
    maybeScrollToBottom();
  }

  // ---- 增量正文流：累积文本 → Markdown，rAF 合帧节流 -------------------------
  function scheduleStreamRender() {
    if (streamRenderPending) return;
    streamRenderPending = true;
    scheduleFrame(() => {
      streamRenderPending = false;
      renderStreamNow();
    });
  }

  function renderStreamNow() {
    const text = currentState?.assistantStream?.text ?? "";
    if (!text) {
      if (streamBubble) { streamBubble.remove(); streamBubble = null; }
      renderedStreamText = null;
      return;
    }
    if (!streamBubble) {
      streamBubble = createMessageBubble("assistant", text, { markdown: true });
      streamBubble.dataset.streaming = "true";
      messages.append(streamBubble);
    } else {
      const textEl = streamBubble.querySelector(".agent-message-text");
      if (textEl) textEl.innerHTML = renderMarkdown(text);
    }
    renderedStreamText = text;
    maybeScrollToBottom();
  }

  function syncStream(state) {
    const text = state.assistantStream?.text ?? "";
    if (!text) {
      // 终态/切换：立即移除流式气泡并取消未决帧（帧回调即使执行也只是空转）。
      if (streamBubble) { streamBubble.remove(); streamBubble = null; }
      streamRenderPending = false;
      renderedStreamText = null;
      return;
    }
    if (text === renderedStreamText) return;
    scheduleStreamRender();
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
    // 思考中流动反馈（短促、可降级；prefers-reduced-motion 下 CSS 禁用动画）。
    if (hasOpenModelTurn(state)) {
      const thinking = doc.createElement("span");
      thinking.className = "agent-thinking";
      thinking.dataset.testid = "agent-thinking";
      thinking.setAttribute("aria-hidden", "true");
      for (let i = 0; i < 3; i += 1) {
        const dot = doc.createElement("span");
        dot.className = "agent-thinking-dot";
        thinking.append(dot);
      }
      runHeader.append(thinking);
    }
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
    runSection.hidden = !run;
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
      planMode = "summary";
      // 新 Run：旧计划退出悬浮层（下一条 plan_updated 到达再显示），清空决策/错误
      planOverlayHidden = true;
      removePlanOverlay();
      renderedPlanSignature = null;
      renderedPlanContent = null;
      for (const card of decisionCards.values()) card.remove();
      decisionCards.clear();
      errorsSlot.replaceChildren();
      rendered.plan = -1;
      rendered.decisions = -1;
      rendered.errors = -1;
    }
    rendered.runStatus = run?.status ?? null;
  }

  // ---- Visible Plan 悬浮层（步骤5）：右上覆盖层，只显示与折叠，无编辑入口 ----
  function ensurePlanOverlay() {
    if (planOverlay) return planOverlay;
    planOverlay = doc.createElement("div");
    planOverlay.className = "agent-plan-overlay";
    planOverlay.dataset.testid = "agent-plan-overlay";
    surface.append(planOverlay);
    return planOverlay;
  }

  function removePlanOverlay() {
    if (planOverlay) {
      planOverlay.remove();
      planOverlay = null;
    }
  }

  function buildPlanOverlayContent(plan) {
    const overlay = ensurePlanOverlay();
    currentPlan = plan;
    overlay.replaceChildren();
    overlay.dataset.mode = planMode;
    const items = Array.isArray(plan.items) ? plan.items : [];
    const completed = items.filter((item) => item?.status === "completed").length;
    const progress = `${completed}/${items.length}`;

    if (planMode === "minimal") {
      const restore = doc.createElement("button");
      restore.type = "button";
      restore.className = "agent-plan-restore";
      restore.dataset.testid = "agent-plan-restore";
      restore.setAttribute("aria-label", `展开任务计划，已完成 ${completed} 项，共 ${items.length} 项`);
      restore.title = "展开任务计划";
      restore.append(viewIcon("doc", 15));
      const restoreProgress = doc.createElement("span");
      restoreProgress.textContent = progress;
      restore.append(restoreProgress);
      restore.addEventListener("click", () => {
        planMode = "summary";
        if (planOverlay && currentPlan) buildPlanOverlayContent(currentPlan);
      });
      overlay.append(restore);
      return;
    }

    const header = doc.createElement("div");
    header.className = "agent-plan-overlay-header";
    const heading = doc.createElement("div");
    heading.className = "agent-plan-heading";
    const title = doc.createElement("span");
    title.className = "agent-plan-overlay-title";
    title.textContent = "任务计划";
    const progressLabel = doc.createElement("span");
    progressLabel.className = "agent-plan-progress";
    progressLabel.textContent = progress;
    heading.append(title, progressLabel);
    const headerActions = doc.createElement("div");
    headerActions.className = "agent-plan-actions";
    const minimize = doc.createElement("button");
    minimize.type = "button";
    minimize.className = "agent-plan-icon-btn";
    minimize.dataset.testid = "agent-plan-minimize";
    minimize.setAttribute("aria-label", "最小化任务计划");
    minimize.title = "最小化";
    minimize.textContent = "−";
    minimize.addEventListener("click", () => {
      planMode = "minimal";
      if (planOverlay && currentPlan) buildPlanOverlayContent(currentPlan);
    });
    const toggle = doc.createElement("button");
    toggle.type = "button";
    toggle.className = `agent-plan-icon-btn agent-plan-icon-btn--${planMode}`;
    toggle.dataset.testid = planMode === "full" ? "agent-plan-collapse" : "agent-plan-expand";
    toggle.setAttribute("aria-label", planMode === "full" ? "折叠任务计划" : "展开任务计划");
    toggle.title = planMode === "full" ? "折叠" : "展开";
    toggle.append(viewIcon("chevR", 14));
    toggle.addEventListener("click", () => {
      planMode = planMode === "full" ? "summary" : "full";
      if (planOverlay && currentPlan) buildPlanOverlayContent(currentPlan);
    });
    headerActions.append(minimize, toggle);
    header.append(heading, headerActions);
    overlay.append(header);
    // 摘要态只显示 step；完整态显示 explanation 与 description（如有）。
    if (planMode === "full") {
      if (typeof plan.explanation === "string" && plan.explanation.length > 0) {
        const explanation = doc.createElement("p");
        explanation.className = "agent-plan-explanation";
        explanation.textContent = plan.explanation;
        overlay.append(explanation);
      }
    }
    const list = doc.createElement("ol");
    list.className = "agent-plan-items";
    const shown = planMode === "full" ? items : pickCollapsedPlanItems(items);
    for (const item of shown) {
      const li = doc.createElement("li");
      li.className = "agent-plan-item";
      // 旧格式事件（无 id）以 step 兜底，保证每个计划项可被定位/测试。
      li.dataset.planId = item.id ?? item.step ?? "";
      li.dataset.status = item.status;
      const mark = doc.createElement("span");
      mark.className = "agent-plan-mark";
      mark.textContent = PLAN_MARKS[item.status] ?? "○";
      const step = doc.createElement("span");
      step.className = "agent-plan-step";
      step.textContent = String(item.step ?? "");
      li.append(mark, step);
      if (planMode === "full" && typeof item.description === "string" && item.description.length > 0) {
        const description = doc.createElement("div");
        description.className = "agent-plan-description";
        description.textContent = item.description;
        li.append(description);
      }
      list.append(li);
    }
    overlay.append(list);
  }

  function planSignature(plan) {
    if (!plan) return null;
    return JSON.stringify({
      explanation: plan.explanation ?? null,
      items: plan.items ?? []
    });
  }

  function syncPlan(state) {
    const plan = getVisiblePlan(state);
    const signature = planSignature(plan);
    if (signature !== renderedPlanSignature) {
      // 新计划内容（plan_updated 事件或内容不同的快照）→ 显示并重建。
      renderedPlanSignature = signature;
      rendered.plan = state.revisions.plan;
      if (signature) planOverlayHidden = false;
    } else if (rendered.plan !== state.revisions.plan) {
      // 同内容 revision（快照整体替换等）只吸收，不打断当前显隐/折叠态，
      // 避免提交后快照把旧计划又"复活"出来。
      rendered.plan = state.revisions.plan;
    }
    // 生命周期：无计划不渲染空面板；新输入（submit）隐藏旧计划；Run 终态保留供回看。
    if (!signature || planOverlayHidden) {
      removePlanOverlay();
      return;
    }
    const overlay = ensurePlanOverlay();
    if (renderedPlanContent !== signature) {
      renderedPlanContent = signature;
      buildPlanOverlayContent(plan);
    }
    maybeScrollToBottom();
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
  function closeSlashMenu() {
    slashMatches = [];
    slashActiveIndex = 0;
    slashMenu.hidden = true;
    slashMenu.replaceChildren();
    input.removeAttribute?.("aria-activedescendant");
  }

  function selectSlashCommand(index = slashActiveIndex) {
    const item = slashMatches[index];
    if (!item) return false;
    input.value = item.command;
    closeSlashMenu();
    input.focus?.();
    return true;
  }

  function renderSlashMenu() {
    slashMatches = matchSlashCommands(input.value);
    slashActiveIndex = 0;
    slashMenu.replaceChildren();
    if (slashMatches.length === 0 || input.disabled) {
      closeSlashMenu();
      return;
    }
    slashMenu.hidden = false;
    slashMatches.forEach((item, index) => {
      const option = doc.createElement("button");
      option.id = `agent-slash-option-${index}`;
      option.type = "button";
      option.className = "agent-slash-option";
      option.dataset.testid = "agent-slash-option";
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", index === slashActiveIndex ? "true" : "false");
      const command = doc.createElement("span");
      command.className = "agent-slash-command";
      command.textContent = item.command;
      const label = doc.createElement("span");
      label.className = "agent-slash-label";
      label.textContent = item.label;
      option.append(command, label);
      option.addEventListener("click", () => selectSlashCommand(index));
      slashMenu.append(option);
    });
    input.setAttribute("aria-activedescendant", "agent-slash-option-0");
  }

  function moveSlashSelection(delta) {
    if (slashMenu.hidden || slashMatches.length === 0) return false;
    slashActiveIndex = (slashActiveIndex + delta + slashMatches.length) % slashMatches.length;
    const options = slashMenu.querySelectorAll('[data-testid="agent-slash-option"]');
    options.forEach?.((option, index) => {
      option.setAttribute("aria-selected", index === slashActiveIndex ? "true" : "false");
    });
    input.setAttribute("aria-activedescendant", `agent-slash-option-${slashActiveIndex}`);
    return true;
  }

  // ---- composer 三菜单：模型 / 权限模式 / 思考强度（选项由 setComposerOptions 注入） ----
  const EFFORT_LABELS = { low: "低", medium: "中", high: "高" };

  function closeComposerMenus() {
    for (const control of composerMenus) {
      control.menu.hidden = true;
      control.trigger.setAttribute("aria-expanded", "false");
    }
  }

  function openComposerMenu(control, direction = 1) {
    control.menu.hidden = false;
    control.trigger.setAttribute("aria-expanded", "true");
    const selectedIndex = Math.max(0, control.items.findIndex((item) => item.dataset.selected === "true"));
    const index = direction < 0 ? control.items.length - 1 : selectedIndex;
    control.items[index]?.focus?.();
  }

  function handleComposerMenuKeydown(control, event) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeComposerMenus();
      control.trigger.focus?.();
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const active = control.items.indexOf(doc.activeElement);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next = (Math.max(0, active) + delta + control.items.length) % control.items.length;
    control.items[next]?.focus?.();
  }

  function handleComposerOutsidePointer(event) {
    if (!controls.contains?.(event.target)) closeComposerMenus();
  }

  function handleComposerOutsideFocus(event) {
    if (!controls.contains?.(event.target)) closeComposerMenus();
  }

  doc.addEventListener?.("pointerdown", handleComposerOutsidePointer, true);
  doc.addEventListener?.("focusin", handleComposerOutsideFocus, true);

  function setMenuValue(control, currentValue, fallbackLabel = "") {
    const selected = control.items.find((item) => item.dataset.value === currentValue);
    control.trigger.dataset.value = currentValue;
    control.value.textContent = selected?.dataset.label ?? fallbackLabel;
    for (const item of control.items) {
      const active = item.dataset.value === currentValue;
      item.dataset.selected = active ? "true" : "false";
      item.setAttribute("aria-selected", active ? "true" : "false");
    }
  }

  function fillMenu(control, options, currentValue, enabled, onSelect) {
    control.menu.replaceChildren();
    control.items = options.map((item) => {
      const option = doc.createElement("button");
      option.type = "button";
      option.className = "agent-composer-option";
      option.dataset.testid = `agent-${control.kind}-option`;
      option.dataset.value = item.value;
      option.dataset.label = item.label;
      option.setAttribute("role", "option");
      if (item.title) option.title = item.title;
      const copy = doc.createElement("span");
      copy.className = "agent-composer-option-copy";
      const label = doc.createElement("strong");
      label.textContent = item.label;
      copy.append(label);
      if (item.description) {
        const description = doc.createElement("span");
        description.textContent = item.description;
        copy.append(description);
      }
      const check = viewIcon("check", 15, "agent-composer-option-check");
      option.append(copy, check);
      option.addEventListener("click", (event) => {
        event?.stopPropagation?.();
        closeComposerMenus();
        if (item.value !== control.trigger.dataset.value) onSelect(item.value);
      });
      control.menu.append(option);
      return option;
    });
    control.trigger.disabled = !enabled;
    setMenuValue(control, currentValue, options[0]?.label ?? "");
    if (!enabled) control.menu.hidden = true;
  }

  function syncComposerControls() {
    const options = composerOptions;
    const levels = Array.isArray(options?.reasoningEffortLevels) && options.reasoningEffortLevels.length > 0
      ? options.reasoningEffortLevels
      : null;
    // 签名未变不重建：避免打断用户正在打开的菜单。
    const signature = JSON.stringify({
      enabled: composerEnabled,
      models: options?.models ?? null,
      modelSelectionEnabled: options?.modelSelectionEnabled ?? null,
      activeModelId: options?.activeModelId ?? null,
      permissionTier: options?.permissionTier ?? null,
      effort: options?.reasoningEffort ?? null,
      levels
    });
    if (signature === controlsSignature) {
      // 选项未变也校准当前值：选择只在落盘成功后生效，失败时回退显示旧值。
      syncControlValues(options, levels);
      return;
    }
    controlsSignature = signature;

    // 模型：未加载或无已导入模型时单项占位并禁用。
    const models = Array.isArray(options?.models) ? options.models : [];
    const modelOptions = models.length > 0
      ? models.map((model) => ({
          value: String(model.id ?? model.model_name ?? ""),
          label: String(model.display ?? model.model_name ?? model.id ?? ""),
          title: String(model.display ?? model.model_name ?? "")
        }))
      : [{ value: "", label: "未导入模型" }];
    fillMenu(
      modelControl,
      modelOptions,
      String(options?.activeModelId ?? ""),
      composerEnabled && models.length > 0 && options?.modelSelectionEnabled !== false,
      (modelId) => actions.switchModel?.(modelId)
    );

    // 权限模式：固定四档。
    fillMenu(
      permissionControl,
      PERMISSION_TIERS.map((tier) => ({ value: tier.id, label: tier.label, description: tier.desc })),
      String(options?.permissionTier ?? "confirm"),
      composerEnabled && Boolean(options),
      (tierId) => actions.setPermissionTier?.(tierId)
    );

    // 思考强度：当前模型声明了档位才提供低/中/高；否则只有「自动」且禁用（不伪装可用）。
    const effortOptions = levels
      ? [{ value: "auto", label: "自动" }, ...levels.map((level) => ({ value: level, label: EFFORT_LABELS[level] ?? level }))]
      : [{ value: "auto", label: "自动" }];
    fillMenu(
      effortControl,
      effortOptions,
      levels ? String(options?.reasoningEffort ?? "auto") : "auto",
      composerEnabled && Boolean(levels),
      (effort) => actions.setReasoningEffort?.(effort)
    );
  }

  function syncControlValues(options, levels) {
    const modelValue = String(options?.activeModelId ?? "");
    setMenuValue(modelControl, modelValue, "未导入模型");
    const permissionValue = String(options?.permissionTier ?? "confirm");
    setMenuValue(permissionControl, permissionValue, "确认后修改");
    const effortValue = levels ? String(options?.reasoningEffort ?? "auto") : "auto";
    setMenuValue(effortControl, effortValue, "自动");
  }

  function syncComposer(state) {
    const enabled = Boolean(state.projectRoot);
    input.disabled = !enabled;
    send.disabled = !enabled;
    composer.hidden = !enabled;
    surface.classList.toggle("agent-surface--empty", !enabled);
    composerEnabled = enabled;
    syncComposerControls();
    // 有项目时隐藏产品起点；项目内的空会话保持干净，不显示欢迎词。
    emptyState.hidden = enabled;
    if (!enabled) {
      closeSlashMenu();
      closeComposerMenus();
    }
  }

  function submitFromComposer() {
    const text = String(input.value ?? "").trim();
    if (!text) return;
    // 新输入开始，旧计划立即退出悬浮层（不等待下一次 render；新 plan_updated 再显示）
    planOverlayHidden = true;
    removePlanOverlay();
    const submissionGeneration = viewGeneration;
    let request;
    try {
      request = actions.submit?.(text);
    } catch (error) {
      request = Promise.reject(error);
    }
    if (request?.localOnly === true) {
      input.value = "";
      closeSlashMenu();
      return;
    }

    const bubble = createMessageBubble("user", text);
    bubble.dataset.state = "pending";
    messages.append(bubble);
    const pending = { text, node: bubble, inputId: null };
    pendingSubmissions.push(pending);
    input.value = "";
    closeSlashMenu();
    maybeScrollToBottom();
    Promise.resolve(request).then((result) => {
      if (submissionGeneration !== viewGeneration) return;
      pending.inputId = result?.input_id ?? null;
    }).catch((error) => {
      if (submissionGeneration !== viewGeneration) return;
      const pendingIndex = pendingSubmissions.indexOf(pending);
      if (pendingIndex >= 0) pendingSubmissions.splice(pendingIndex, 1);
      bubble.dataset.state = "failed";
      const failure = doc.createElement("span");
      failure.className = "agent-submit-error";
      failure.dataset.testid = "agent-submit-error";
      failure.textContent = `发送失败：${String(error?.message ?? "请求失败")}`;
      bubble.append(failure);
      if (String(input.value ?? "").length === 0) input.value = text;
      maybeScrollToBottom();
    });
  }

  input.addEventListener("input", () => renderSlashMenu());
  input.addEventListener("focus", () => closeComposerMenus());
  input.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (!slashMenu.hidden) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        moveSlashSelection(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        selectSlashCommand();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeSlashMenu();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitFromComposer();
    }
  });
  send.addEventListener("click", () => submitFromComposer());

  // ---- 对外 ----------------------------------------------------------------
  // 三控件选项不属于 snapshot/SSE state，由 index.js 加载/变更后单独注入。
  function setComposerOptions(options) {
    composerOptions = options ?? null;
    syncComposerControls();
  }

  function render(state, actionBag = {}) {
    actions = actionBag;
    currentState = state;
    syncMessages(state);
    syncStream(state);
    syncRun(state);
    syncPlan(state);
    syncActivities(state);
    syncDecisions(state);
    syncErrors(state);
    syncQueue(state);
    syncComposer(state);
  }

  return { render, reset, destroy, setComposerOptions };
}
