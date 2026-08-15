// src/app-shell/agent/view.js —— AgentSurface 单一视图（Task 8 Step 3-4）。
//
// 原生 DOM（无框架）渲染：对话、当前 Run（停止/重试按钮 + Visible Plan +
// 决策/错误卡）、工作组（reasoning/tool/plan 时间线，工具详情与输出折叠在
// 工作项内）、排队输入、composer。Plan 与 queue 渲染器是本文件的私有函数，
// 不创建额外的公共 UI 模块。
//
// 工作组行为：
//   - 工具项详情字段顺序固定：参数 → 命令 → 目录 → 退出码 → 耗时 → 错误；
//   - 工具输出保留最后 64 KiB，截断后前置「（输出过长已截断）」；
//   - 停止按钮点击立即禁用防连点，仅停止失败或终态事件后恢复；
//   - 私有推理字段永不渲染；
//   - 自动滚动只在用户接近底部时触发；重建 DOM 后把时间线末端重新锚定，
//     但不打断正在阅读更早内容的用户。
import {
  getActiveRun,
  getPendingDecisions,
  getQueuedInputs,
  isRunActive,
  getContextUsage,
  getCompaction,
  getCompactionRows,
  compactionBlocksSend,
  getNeedsHistoryClear,
  TERMINAL_RUN_STATUSES
} from "./state.js";
import { createContextRing } from "./context-ring.js";
import { matchSlashCommands } from "./slash-commands.mjs";
import { renderMarkdown } from "../markdown-lite.mjs";
import { PERMISSION_TIERS } from "../permission-tiers.mjs";
import { icon } from "../icons.js";
import { createReasoningTicker } from "./reasoning-ticker.mjs";
import {
  formatDuration,
  groupStatusText,
  orderedWorkItems,
  visibleLiveTargets
} from "./work-items.mjs";

// 工具输出截断提示（work-items.mjs 在输出超 64 KiB 时保留尾部并置 truncated）。
const WORK_OUTPUT_TRUNCATED_MARK = "（输出过长已截断）\n";
const SCROLL_THRESHOLD = 48;

// Task 11 Step 4：压缩状态行固定文案映射（同一位置单行顶替；完成/失败/取消后
// 状态行仍留在时间线）。完成文案绝不携带 token/模型/耗时等详细数据。
const COMPACTION_ROW_LABELS = {
  started: "开始压缩",
  running: "压缩进行中",
  cancelling: "正在取消",
  completed: "已压缩完成",
  failed: "压缩失败",
  cancelled: "已取消",
  noop: "Not enough messages to compact"
};

// 各状态的动作按钮：failed → 重试+取消；running → 取消；其余无按钮。
const COMPACTION_ROW_BUTTONS = {
  started: [],
  running: ["cancel"],
  cancelling: [],
  completed: [],
  failed: ["retry", "cancel"],
  cancelled: [],
  noop: []
};

// 压缩在途/失败都算「真实活动」：圆环给出轻微活性反馈。
const COMPACTION_ACTIVE_STATES = new Set(["started", "running", "cancelling"]);

const PLAN_MARKS = { completed: "✓", in_progress: "•", pending: "○" };

export function createAgentView({ root, document: doc = globalThis.document, requestFrame = null, scheduler = globalThis }) {
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

  const queueSlot = doc.createElement("div");
  queueSlot.className = "agent-queue";
  queueSlot.dataset.testid = "agent-queue";

  conv.append(emptyState, messages, runSection, queueSlot);

  // 「回到最新」：用户上滚离开底部后浮出的锚点按钮（由 scroll 事件驱动，见自动滚动节）。
  // 初始处于 follow 模式，按钮隐藏；点击后滚到底部并恢复跟随。
  const latestButton = doc.createElement("button");
  latestButton.type = "button";
  latestButton.className = "agent-scroll-latest";
  latestButton.dataset.testid = "agent-scroll-latest";
  latestButton.textContent = "回到最新";
  latestButton.hidden = true;
  latestButton.addEventListener("click", () => {
    followLatest = true;
    latestButton.hidden = true;
    scrollToBottom();
  });

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
  // Task 16（R5-7）：对话历史损坏（needs_history_clear）提示——独立一行显示
  // 「此对话已损坏」并禁发（canSubmit 门禁与发送按钮一致）；不占用输入占位符。
  const historyClearHint = doc.createElement("div");
  historyClearHint.className = "agent-history-clear-hint";
  historyClearHint.dataset.testid = "agent-history-clear-hint";
  historyClearHint.textContent = "此对话已损坏";
  historyClearHint.hidden = true;
  Object.assign(historyClearHint.style, {
    fontSize: "12px",
    lineHeight: "1.5",
    color: "var(--text-muted)",
    padding: "6px 2px 0"
  });
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
  // Task 11：上下文圆环（用量仪表）挂载在 composer 工具栏，项目打开后始终可见。
  const contextRing = createContextRing({ document: doc });
  composerToolbar.append(controls, contextRing.element, send);
  composerShell.append(input, composerToolbar);
  composer.append(historyClearHint, slashMenu, composerShell);

  surface.append(conv, latestButton, composer);
  root.append(surface);

  // ---- 视图内部状态 ----------------------------------------------------------
  let actions = {};            // 最近一次 render 传入的动作回调
  let stopPending = false;     // 停止请求在途（防连点）
  let viewGeneration = 0;      // reset 后旧异步回调不得修改新项目视图
  let composerOptions = null;  // setComposerOptions 注入的控件选项（null = 未加载，控件禁用）
  let controlsSignature = "";  // 选项签名：未变化时不重建菜单（避免打断正在选择的用户）
  let composerEnabled = false; // 最近一次 syncComposer 的项目可用态
  let composerBusy = false;    // Task 8：项目其他会话运行中（setBusy 设置），禁发送保输入
  let slashMatches = [];
  let slashActiveIndex = 0;
  let followLatest = true;     // 显式 follow 状态：仅用户接近底部时跟随（滚动锁，Task 7）
  let currentState = null;     // 最近一次 render 的 state（供异步帧回调读取）
  // ---- Task 11：surface 自持的短暂 toast（撤回失败等；不依赖 app.js 接线） ----
  let toastTimer = null;

  function showToast(message) {
    if (toastTimer != null) {
      scheduler.clearTimeout(toastTimer);
      toastTimer = null;
    }
    let node = surface.querySelector('[data-testid="agent-toast"]');
    if (!node) {
      node = doc.createElement("div");
      node.className = "agent-toast";
      node.dataset.testid = "agent-toast";
      node.setAttribute("role", "status");
      surface.append(node);
    }
    node.textContent = message;
    toastTimer = scheduler.setTimeout(() => {
      node.remove();
      toastTimer = null;
    }, 3000);
  }

  function clearToast() {
    if (toastTimer != null) {
      scheduler.clearTimeout(toastTimer);
      toastTimer = null;
    }
    const node = surface.querySelector('[data-testid="agent-toast"]');
    if (node) node.remove();
  }
  // ---- 增量正文流（Task 步骤7）：累积文本 → Markdown，rAF 合帧节流 ----
  let streamBubble = null;         // 流式 assistant 气泡（delta 期间的临时节点）
  let streamRenderPending = false; // 已有未决帧渲染
  let renderedStreamText = null;   // 最近已渲染的累积文本
  // ---- 工作组（Task 6）：reasoning/tool/plan 时间线 ------------------------------
  const workGroups = new Map();   // runId -> 工作组 DOM 记录
  const timelineSeqs = new Map(); // messages 子节点 -> seq（跨气泡/工作组排序）
  const messageNodes = new Map(); // event_key -> 时间线节点（Task 10：稳定 key，重建/去重）
  const decisionCards = new Map(); // decision_id -> card（diff 更新，保留 extreme 输入）
  const compactionRowNodes = new Map(); // compaction_id -> { wrap, row, label, actions }（Task 11）
  const pendingSubmissions = []; // 仅保留仍在途的即时消息；终态立即移出，避免会话内累积
  // Task 6：提交失败的气泡（含错误文案）暂存于此，重试或消息确认送达（reconcile）
  // 时按文本移除，失败气泡不再永久残留。
  const failedSubmissions = [];
  // ---- 前置分页（Task 10）：滚动到顶加载更早历史，锚点不跳动 ----
  let loadingEarlier = false;      // 与 index.js 双保险的防重复标记
  let earlierAnchor = null;        // { oldHeight, oldTop }：前置插入前记录
  let historyGapErrorNode = null;  // 加载失败的一次性可重试提示
  let historyGapErrorSeq = null;
  const rendered = {
    messages: -1, run: -1, queue: -1, decisions: -1, errors: -1,
    runId: null, runStatus: null, context: -1, notices: -1
  };

  function clearWorkGroupTimers(record) {
    if (record.durationTimer != null) {
      scheduler.clearInterval(record.durationTimer);
      record.durationTimer = null;
    }
    for (const row of record.rows.values()) row.ticker?.finish?.();
  }

  function reset() {
    viewGeneration += 1;
    clearToast();
    for (const record of workGroups.values()) clearWorkGroupTimers(record);
    workGroups.clear();
    // 工作组已插入 messages 统一时间线：整体清空 messages 与 seq/key 映射。
    messages.replaceChildren();
    timelineSeqs.clear();
    messageNodes.clear();
    runHeader.replaceChildren();
    decisionsSlot.replaceChildren();
    errorsSlot.replaceChildren();
    queueSlot.replaceChildren();
    currentState = null;
    if (streamBubble) { streamBubble.remove(); streamBubble = null; }
    streamRenderPending = false;
    renderedStreamText = null;
    for (const card of decisionCards.values()) card.remove();
    decisionCards.clear();
    for (const record of compactionRowNodes.values()) {
      record.wrap.remove();
      if (record.eventKey != null) messageNodes.delete(record.eventKey);
      timelineSeqs.delete(record.wrap);
    }
    compactionRowNodes.clear();
    contextRing.dismiss();
    pendingSubmissions.length = 0;
    failedSubmissions.length = 0;
    input.value = ""; // Task 6：未发送草稿（含占位会话里打的字）不得跨会话/项目泄漏
    composerOptions = null;
    controlsSignature = "";
    closeSlashMenu();
    loadingEarlier = false;
    earlierAnchor = null;
    if (historyGapErrorNode) { historyGapErrorNode.remove(); historyGapErrorNode = null; historyGapErrorSeq = null; }
    rendered.messages = rendered.run = rendered.queue = -1;
    rendered.decisions = rendered.errors = -1;
    rendered.context = -1;
    rendered.runId = null;
    rendered.runStatus = null;
    stopPending = false;
  }

  function destroy() {
    doc.removeEventListener?.("pointerdown", handleComposerOutsidePointer, true);
    doc.removeEventListener?.("focusin", handleComposerOutsideFocus, true);
    clearToast();
    for (const record of workGroups.values()) clearWorkGroupTimers(record);
    workGroups.clear();
    timelineSeqs.clear();
    messageNodes.clear();
    contextRing.destroy();
    surface.remove();
  }

  // ---- 自动滚动：显式 follow 状态（仅用户接近底部时跟随） ----------------------
  // 用户滚动事件是 follow 状态的唯一来源；渲染后不再重新测量 isNearBottom()，
  // 否则内容高度变化会误判并把滚动抢回底部，打断正在阅读更早内容的用户。
  function distanceFromBottom(el) {
    const height = Number(el.scrollHeight ?? 0);
    const client = Number(el.clientHeight ?? 0);
    const top = Number(el.scrollTop ?? 0);
    if (height <= client) return 0;
    return height - top - client;
  }

  function scrollToBottom() {
    const height = Number(conv.scrollHeight ?? 0);
    const client = Number(conv.clientHeight ?? 0);
    conv.scrollTop = Math.max(0, height - client);
  }

  function afterRender() {
    if (followLatest) scrollToBottom();
  }

  // ---- 前置分页（Task 10 Step 4）：距顶部 ≤240px 且有更早历史时加载前置页 ----
  const EARLIER_SCROLL_THRESHOLD = 240;
  function maybeLoadEarlier() {
    if (loadingEarlier) return;
    if (!currentState?.hasEarlier) return;
    const minSeq = currentState.minSeq;
    if (minSeq == null) return;
    if (Number(conv.scrollTop ?? 0) > EARLIER_SCROLL_THRESHOLD) return;
    loadingEarlier = true; // 防重复：请求结束后由 index.js 调 setLoadingEarlier(false) 恢复
    actions.loadEarlier?.(minSeq);
  }

  // 前置插入前记录 oldHeight/oldTop；插入完成后按 newHeight-oldHeight+oldTop
  // 恢复 scrollTop，保证原消息锚点不跳动。
  function prepareEarlierInsert() {
    earlierAnchor = { oldHeight: Number(conv.scrollHeight ?? 0), oldTop: Number(conv.scrollTop ?? 0) };
  }
  function restoreScrollAnchor() {
    if (!earlierAnchor) return;
    const newHeight = Number(conv.scrollHeight ?? 0);
    const added = newHeight - earlierAnchor.oldHeight;
    if (added >= 0) conv.scrollTop = added + earlierAnchor.oldTop;
    earlierAnchor = null;
  }

  // 前置页加载失败：只显示一次可重试的历史缺口提示，不清空当前消息。
  function showHistoryLoadError(beforeSeq) {
    if (historyGapErrorNode) return;
    historyGapErrorSeq = beforeSeq;
    historyGapErrorNode = doc.createElement("div");
    historyGapErrorNode.className = "agent-history-gap agent-history-gap--error";
    historyGapErrorNode.dataset.testid = "agent-history-gap-error";
    const text = doc.createElement("span");
    text.textContent = "此处有一段历史不可读";
    const retry = doc.createElement("button");
    retry.type = "button";
    retry.dataset.testid = "agent-history-gap-retry";
    retry.textContent = "重试";
    retry.addEventListener("click", () => {
      actions.loadEarlier?.(historyGapErrorSeq);
    });
    historyGapErrorNode.append(text, retry);
    insertTimeline(historyGapErrorNode, beforeSeq, null);
  }
  function clearHistoryLoadError() {
    if (!historyGapErrorNode) return;
    historyGapErrorNode.remove();
    timelineSeqs.delete(historyGapErrorNode);
    historyGapErrorNode = null;
    historyGapErrorSeq = null;
  }

  conv.addEventListener("scroll", () => {
    followLatest = distanceFromBottom(conv) <= SCROLL_THRESHOLD;
    latestButton.hidden = followLatest;
    maybeLoadEarlier();
  });

  // ---- 外部链接：交给系统默认浏览器（Task 8 Step 4）---------------------------
  // markdown-lite 只在 http:/https: 时输出 [data-external-link]；这里对
  // [data-external-link] 做事件委托并 preventDefault：Electron 走 preload 暴露的
  // openExternalUrl（main 进程二次校验协议），普通浏览器开发模式回退
  // window.open(url, "_blank", "noopener,noreferrer")。
  function handleExternalLinkClick(event) {
    const anchor = event.target?.closest?.("[data-external-link]");
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute("href");
    if (!href) return;
    const desktop = globalThis.wwritingDesktop;
    if (desktop?.openExternalUrl) {
      Promise.resolve(desktop.openExternalUrl(href)).catch(() => {});
      return;
    }
    globalThis.open?.(href, "_blank", "noopener,noreferrer");
  }

  conv.addEventListener("click", handleExternalLinkClick);

  // ---- 对话 ----------------------------------------------------------------
  function createMessageBubble(role, textValue, { markdown = false, truncated = false } = {}) {
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
    if (truncated) {
      // Task 4：max_tokens 截断提示。独立元素追加在文本区域之后，不修改正文本身。
      const mark = doc.createElement("div");
      mark.className = "agent-message-truncation";
      mark.dataset.testid = "truncation-mark";
      mark.textContent = "ⓘ 输出被截断";
      bubble.append(mark);
    }
    return bubble;
  }

  function reconcilePendingSubmission(entry) {
    let index = pendingSubmissions.findIndex((item) =>
      item.inputId != null && item.inputId === entry.input_id
    );
    if (index < 0) {
      index = pendingSubmissions.findIndex((item) =>
        item.text === String(entry.text ?? "").trim()
      );
    }
    // Task 6：该 user 消息已由快照/SSE 回放确认送达，同文本失败气泡一并移除。
    // 失败登记时其 pending 记录已移出，故移除不能依赖 pending 匹配——送达即撤，
    // 覆盖「客户端 promise 恰好 reject 但后端实际已受理」的回放确认场景。
    removeFailedBubble(entry.text);
    if (index < 0) return;
    pendingSubmissions[index].node.remove();
    pendingSubmissions.splice(index, 1);
  }

  // Task 6：移除文本对应的失败气泡（含错误文案）。幂等——节点已脱离时 remove 为空操作。
  function removeFailedBubble(text) {
    const needle = String(text ?? "").trim();
    if (!needle) return;
    for (let i = failedSubmissions.length - 1; i >= 0; i--) {
      if (failedSubmissions[i].text === needle) {
        failedSubmissions[i].node.remove();
        failedSubmissions.splice(i, 1);
      }
    }
  }

  // 时间线插入：气泡、活动行与工作组共享 messages 容器，按 (seq, event_key)
  // 稳定排序落位（Task 10：同时支持前置与后置；相同 seq 按 event key 字典序）。
  // eventKey 不为 null 时做稳定 key 去重，并给节点打上 data-event-key/data-seq。
  function insertTimeline(node, seq, eventKey = null) {
    if (eventKey != null) {
      if (messageNodes.has(eventKey)) return; // 重建/重复页：不重复插入
      messageNodes.set(eventKey, node);
      node.dataset.eventKey = eventKey;
    }
    if (seq != null) node.dataset.seq = String(seq);
    if (seq == null) {
      messages.append(node);
      timelineSeqs.set(node, seq);
      return;
    }
    const children = messages.children;
    // 无 seq 节点（pending 用户气泡、流式气泡等）固定靠后：先定位最后一个有 seq
    // 节点的位置。有 seq 节点之间仍按 (seq, eventKey) 稳定排序（Task 10）。
    let lastSeqIndex = -1;
    for (let i = children.length - 1; i >= 0; i -= 1) {
      if (timelineSeqs.get(children[i]) != null) { lastSeqIndex = i; break; }
    }
    let index = lastSeqIndex + 1; // 默认：最后一个有 seq 节点之后
    for (let i = lastSeqIndex; i >= 0; i -= 1) {
      const childSeq = timelineSeqs.get(children[i]);
      if (childSeq == null) continue; // 理论不可达（lastSeqIndex 之后全无 seq）
      if (childSeq < seq) {
        index = i + 1;
        break;
      }
      if (childSeq === seq) {
        const childKey = children[i].dataset?.eventKey ?? "";
        if (childKey <= (eventKey ?? "")) {
          index = i + 1;
          break;
        }
      }
      index = i;
    }
    // B1 修复：若新 seq 节点排到有 seq 区的末尾（index === lastSeqIndex+1），其
    // 后还有无 seq 节点（pending 用户气泡 = 用户刚发的消息），则追加到末尾——
    // 工作组不得压到 pending 用户气泡上方（工作组必须跟在 pending 气泡之后）。
    if (index === lastSeqIndex + 1 && lastSeqIndex < children.length - 1) {
      index = children.length; // append：落在无 seq 尾区之后
    }
    if (index >= children.length) {
      messages.append(node);
    } else if (typeof messages.insertBefore === "function") {
      messages.insertBefore(node, children[index]);
    } else {
      // 测试 DOM mock 无 insertBefore：用 replaceChildren 重排（真实 DOM 走上面分支）
      const all = children.slice();
      all.splice(index, 0, node);
      messages.replaceChildren(...all);
    }
    timelineSeqs.set(node, seq);
  }

  function syncMessages(state) {
    if (rendered.messages === state.revisions.messages) return;
    for (const entry of state.conversation) {
      const eventKey = entry.event_key ?? null;
      if (eventKey != null && messageNodes.has(eventKey)) continue; // 已渲染（重建去重）
      if (entry.role === "user") {
        reconcilePendingSubmission(entry);
        insertTimeline(createMessageBubble("user", entry.text), entry.seq, eventKey);
      } else if (typeof entry.text === "string" && entry.text.length > 0) {
        // 助手正文走 Markdown 渲染（与流式气泡同一口径，增量/终态一致）。
        insertTimeline(
          createMessageBubble("assistant", entry.text, { markdown: true, truncated: entry.truncated === true }),
          entry.seq,
          eventKey
        );
      }
    }
    rendered.messages = state.revisions.messages;
    afterRender();
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
      if (streamBubble) { streamBubble.remove(); timelineSeqs.delete(streamBubble); streamBubble = null; }
      renderedStreamText = null;
      return;
    }
    if (!streamBubble) {
      streamBubble = createMessageBubble("assistant", text, { markdown: true });
      streamBubble.dataset.streaming = "true";
      messages.append(streamBubble);
    }
    const textEl = streamBubble.querySelector(".agent-message-text");
    if (textEl) {
      textEl.innerHTML = renderMarkdown(text);
      // AICSS streaming-text：流式实心光标（8px×1.05em，见 agent.css）。定稿
      // （assistant_message_completed）后流式气泡被 syncStream 移除，光标随之
      // 消失——无闪烁态：WWriting 没有"播完未折叠"的中间态（有意为之）。
      const caret = doc.createElement("span");
      caret.className = "agent-stream-caret";
      caret.setAttribute("aria-hidden", "true");
      textEl.append(caret);
    }
    renderedStreamText = text;
    afterRender();
  }

  function syncStream(state) {
    const text = state.assistantStream?.text ?? "";
    if (!text) {
      // 终态/切换：立即移除流式气泡并取消未决帧（帧回调即使执行也只是空转）。
      if (streamBubble) { streamBubble.remove(); timelineSeqs.delete(streamBubble); streamBubble = null; }
      streamRenderPending = false;
      renderedStreamText = null;
      return;
    }
    if (text === renderedStreamText) return;
    scheduleStreamRender();
  }

  // ---- 当前 Run：停止/重试按钮 + Plan + 决策/错误 --------------------------------
  function renderRunHeader(state) {
    runHeader.replaceChildren();
    const run = getActiveRun(state);
    if (!run) return;
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
      // 新 Run：清空决策/错误（工作组的生命周期由 work 投影的 group 管理）
      for (const card of decisionCards.values()) card.remove();
      decisionCards.clear();
      errorsSlot.replaceChildren();
      rendered.decisions = -1;
      rendered.errors = -1;
    }
    rendered.runStatus = run?.status ?? null;
  }

  // ---- 工作组（Task 6）：reasoning/tool/plan 有序时间线，插入对话时间流 ----------
  // 工具详情字段固定顺序（验收契约，沿用旧活动行的顺序）。
  const FIELD_ORDER = ["参数", "命令", "目录", "退出码", "耗时", "错误"];
  const TOOL_STATE_ICONS = { running: "•", completed: "✓", failed: "✗", cancelled: "已停止", waiting: "•" };
  // 计时只在真实文档内运行：脱离文档（测试 mock / 未挂载）的节点不保留 1s/800ms
  // 重复计时器，避免泄漏；details 挂载后计时正常工作。
  const DURATION_ACTIVE_STATUSES = new Set(["running", "interrupting", "stopping"]);

  // 运行中耗时唯一数据源：工作组投影时钟（与终态 Task 15 同源，journal 同算法）。
  // activeSince 是事件 at 的 ISO 字符串；waiting_user/终态时 activeSince 为 null，
  // 返回已累计的 activeMs（冻结）。
  function groupLiveElapsedMs(group, now = Date.now()) {
    const activeMs = Number(group?.activeMs ?? 0);
    const since = group?.activeSince != null ? Date.parse(group.activeSince) : null;
    if (Number.isFinite(since) && Number.isFinite(activeMs)) {
      return Math.max(0, activeMs + Math.max(0, now - since));
    }
    return Number.isFinite(activeMs) ? Math.max(0, activeMs) : 0;
  }

  function reasoningDetailText(item) {
    if (item.availability === "unsupported") return "当前模型不支持查看";
    if (item.availability === "empty" || !(typeof item.text === "string" && item.text.length > 0)) {
      return "本次没有可查看的思考内容";
    }
    return item.text;
  }

  // 工作组的稳定时间线 key：runId + 首次事件 seq（跨重建稳定；firstSeq 前移时重插）。
  function workGroupKey(group) {
    return `work:${group.id}:${group.firstSeq}`;
  }

  function createWorkGroup(group) {
    const details = doc.createElement("details");
    details.className = "agent-work-group";
    details.dataset.groupId = group.id;
    details.open = group.expanded; // 投影给出展开默认值；用户可在 DOM 侧覆盖
    const summary = doc.createElement("summary");
    const status = doc.createElement("span");
    status.className = "agent-work-status";
    const duration = doc.createElement("span");
    duration.className = "agent-work-duration";
    summary.append(status, duration);
    const itemsEl = doc.createElement("div");
    itemsEl.className = "agent-work-items";
    details.append(summary, itemsEl);
    insertTimeline(details, group.firstSeq, workGroupKey(group));
    const record = {
      groupId: group.id,
      details,
      status,
      duration,
      itemsEl,
      rows: new Map(),       // itemId -> row
      userToggled: false,    // 用户手动折叠后，投影的 expanded 不再覆盖
      durationTimer: null,
      groupSeq: group.firstSeq,
      groupKey: workGroupKey(group)
    };
    // toggle 事件只负责立即重应用动效（按当前展开态），不再用它判定「用户手动切换」：
    // Chromium 会在 <details open> 插入文档时异步补发一个 toggle 事件（实测 trusted），
    // 若在此置位 userToggled，会把「完成自动折叠」吞掉（详情折叠被用户手势标记阻塞）。
    // userToggled 只由真实的 summary 交互（点击 / Enter / Space）置位。
    details.addEventListener("toggle", () => {
      const g = currentState?.work?.groups.get(record.groupId);
      if (g) applyLiveTargets(record, g);
    });
    const markUserToggled = () => {
      record.userToggled = true;
    };
    summary.addEventListener("click", markUserToggled);
    summary.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") markUserToggled();
    });
    workGroups.set(group.id, record);
    return record;
  }

  // 统一 item renderer：reasoning / tool / plan 共用同一行结构（label + 按 kind 扩展）。
  function buildWorkItemRow(record, item) {
    const wrap = doc.createElement("div");
    wrap.className = "agent-work-item";
    wrap.dataset.itemId = item.id;
    wrap.dataset.kind = item.kind;
    wrap.dataset.state = item.state;
    const label = doc.createElement("span");
    label.className = "agent-work-item__label";
    wrap.append(label);
    const row = { wrap, label, kind: item.kind, itemId: item.id, prevState: null, lastPushedLen: 0 };
    if (item.kind === "tool") {
      const iconEl = doc.createElement("span");
      iconEl.className = "agent-work-item__icon";
      iconEl.setAttribute("aria-hidden", "true");
      wrap.append(iconEl);
      row.icon = iconEl;
      const path = doc.createElement("span");
      path.className = "agent-tool-path";
      wrap.append(path);
      row.path = path;
      const meta = doc.createElement("span");
      meta.className = "agent-work-item__meta";
      wrap.append(meta);
      row.meta = meta;
      const caret = doc.createElement("span");
      caret.className = "agent-tool-caret";
      caret.setAttribute("aria-hidden", "true");
      wrap.append(caret);
      row.caret = caret;
      // 工具详情：整行点击切换（R1）。类名保留 .agent-tool-details（div），
      // 字段/输出在其中；无内容时整体隐藏（与旧 details 语义一致）。
      const details = doc.createElement("div");
      details.className = "agent-tool-details";
      const detail = doc.createElement("div");
      detail.className = "agent-tool-fields";
      const output = doc.createElement("pre");
      output.className = "agent-tool-output";
      details.append(detail, output);
      wrap.append(details);
      row.details = details;
      row.detail = detail;
      row.fieldEls = new Map();   // 字段名 -> field 容器（内容在 pre 内）
      row.outputEl = output;
      row.fieldsSignature = null;
      row.hasContent = false;
      row.toolOpen = false;
      // 整行切换（a11y：role=button + Enter/Space；点击内容区不触发收起）
      wrap.setAttribute("role", "button");
      wrap.setAttribute("tabindex", "0");
      wrap.setAttribute("aria-expanded", "false");
      const setToolOpen = (open) => {
        row.toolOpen = open;
        wrap.setAttribute("aria-expanded", open ? "true" : "false");
        wrap.classList.toggle("agent-tool-details--open", open);
        row.details.hidden = !row.hasContent || !open;
        // 输出块与详情区同步可见（真实 DOM 中 hidden 由父级级联；测试桩
        // 不级联，需显式设置，且对真实 DOM 是幂等冗余）。
        row.outputEl.hidden = !row.hasContent || !open;
      };
      wrap.addEventListener("click", (event) => {
        const target = event?.target ?? wrap;
        if (target.closest?.(".agent-tool-details")) return; // 内容区点击不切换
        setToolOpen(!row.toolOpen);
      });
      wrap.addEventListener("keydown", (event) => {
        // 真实 DOM 聚焦行自身时 target===wrap；MockElement._fire 不透传 target，
        // 缺省视为行自身（否则测试桩下 Enter/Space 永不触发）。
        if ((event?.target ?? wrap) !== wrap) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault(); // 防 Space 滚动
          setToolOpen(!row.toolOpen);
        }
      });
    } else if (item.kind === "reasoning") {
      const tickerEl = doc.createElement("div");
      tickerEl.className = "agent-reasoning-ticker";
      wrap.append(tickerEl);
      row.tickerEl = tickerEl;
      const detailEl = doc.createElement("div");
      detailEl.className = "agent-reasoning-detail";
      wrap.append(detailEl);
      row.detailEl = detailEl;
      // 第九轮：与工具行（R1）一致的整行折叠交互——终态「已完成思考」默认
      // 折叠为一行（label + caret），整行点击展开全文；运行中（ticker 实时
      // 摘要）不进入折叠态、点击不响应。
      const reasoningCaret = doc.createElement("span");
      reasoningCaret.className = "agent-reasoning-caret";
      reasoningCaret.setAttribute("aria-hidden", "true");
      wrap.append(reasoningCaret);
      row.caret = reasoningCaret;
      wrap.setAttribute("role", "button");
      wrap.setAttribute("tabindex", "0");
      wrap.setAttribute("aria-expanded", "false");
      row.reasoningOpen = false;
      const setReasoningOpen = (open) => {
        row.reasoningOpen = open;
        wrap.setAttribute("aria-expanded", open ? "true" : "false");
        wrap.classList.toggle("agent-reasoning-detail--open", open);
        row.detailEl.hidden = !open;
      };
      wrap.addEventListener("click", (event) => {
        // 仅终态可展开/折叠（dataset.state 由 updateWorkItemRow 同步）
        if (row.wrap.dataset.state === "running") return;
        const target = event?.target ?? wrap;
        if (target.closest?.(".agent-reasoning-detail")) return; // 内容区点击不切换
        setReasoningOpen(!row.reasoningOpen);
      });
      wrap.addEventListener("keydown", (event) => {
        // 真实 DOM 聚焦行自身时 target===wrap；MockElement._fire 不透传 target，
        // 缺省视为行自身（否则测试桩下 Enter/Space 永不触发）。
        if ((event?.target ?? wrap) !== wrap) return;
        if (row.wrap.dataset.state === "running") return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault(); // 防 Space 滚动
          setReasoningOpen(!row.reasoningOpen);
        }
      });
    } else if (item.kind === "plan") {
      label.classList.add("agent-plan__title");
      const countEl = doc.createElement("span");
      countEl.className = "agent-plan__count";
      wrap.append(countEl);
      row.countEl = countEl;
      const listEl = doc.createElement("ol");
      listEl.className = "agent-plan-list";
      wrap.append(listEl);
      row.listEl = listEl;
      row.planSignature = null;
    }
    record.itemsEl.append(wrap);
    return row;
  }

  function tickerSchedulerFor(record) {
    return {
      setTimeout: (fn, ms) => (record.details.isConnected ? scheduler.setTimeout(fn, ms) : null),
      clearTimeout: (id) => { if (id != null) scheduler.clearTimeout(id); }
    };
  }

  function updateWorkItemRow(record, row, item) {
    row.wrap.dataset.state = item.state;
    const wasRunning = row.prevState === "running";
    const isRunning = item.state === "running";
    row.prevState = item.state;

    // label：工具失败时把尾部「失败」拆成独立短状态词，单独应用 --text-danger。
    const labelText = String(item.label ?? "");
    const splitFailed = item.kind === "tool" && item.state === "failed" && labelText.endsWith("失败");
    if (splitFailed) {
      if (!row.stateWord) {
        row.label.replaceChildren();
        row.nameSpan = doc.createElement("span");
        row.stateWord = doc.createElement("span");
        row.stateWord.className = "agent-work-item__state";
        row.label.append(row.nameSpan, row.stateWord);
      }
      if (row.nameSpan.textContent !== labelText.slice(0, -2)) row.nameSpan.textContent = labelText.slice(0, -2);
      if (row.stateWord.textContent !== "失败") row.stateWord.textContent = "失败";
    } else {
      if (row.stateWord) {
        row.label.replaceChildren();
        row.stateWord = null;
        row.nameSpan = null;
      }
      if (row.label.textContent !== labelText) row.label.textContent = labelText;
    }

    if (row.icon) {
      const iconText = TOOL_STATE_ICONS[item.state] ?? "•";
      if (row.icon.textContent !== iconText) row.icon.textContent = iconText;
      row.icon.dataset.state = item.state;
    }
    if (row.path) {
      const pathText = item.detail ?? "";
      if (row.path.textContent !== pathText) row.path.textContent = pathText;
      row.path.hidden = pathText.length === 0;
    }
    if (row.meta) {
      const errorText = item.error ?? "";
      if (row.meta.textContent !== errorText) row.meta.textContent = errorText;
      row.meta.hidden = errorText.length === 0;
    }

    if (row.kind === "tool") {
      updateToolDetails(row, item);
    } else if (row.kind === "reasoning") {
      if (isRunning) {
        // 运行中摘要走 ticker（≤2 行）；详情永远用持久化完整 reasoning。
        if (!row.ticker) {
          row.ticker = createReasoningTicker({
            onDisplay: (text) => {
              if (row.tickerEl.textContent !== text) {
                row.tickerEl.textContent = text;
                // AICSS thinking-reasoning：片段滚动替换动效——重挂 class 重启
                // CSS 动画（旧片段滚出、新片段滚入；真实 DOM 强制 reflow，
                // 测试 mock 无 offsetWidth 时空转不报错）。
                row.tickerEl.classList.remove("agent-ticker-swap");
                void row.tickerEl.offsetWidth;
                row.tickerEl.classList.add("agent-ticker-swap");
              }
            },
            scheduler: tickerSchedulerFor(record)
          });
        }
        const text = item.text ?? "";
        if (text.length > row.lastPushedLen) {
          row.ticker.push(text.slice(row.lastPushedLen));
          row.lastPushedLen = text.length;
        }
        row.tickerEl.hidden = false;
        // 第九轮：运行中强制折叠态（ticker 摘要为唯一展示；caret 隐藏、不可点）
        row.detailEl.hidden = true;
        row.detailEl.textContent = "";
        if (row.caret) row.caret.hidden = true;
      } else {
        row.tickerEl.hidden = true;
        if (wasRunning) {
          row.ticker?.finish?.(); // 立即停止 ticker 计时，不延迟折叠
          row.ticker = null;
          row.lastPushedLen = (item.text ?? "").length;
        }
        // 第九轮：终态默认折叠——详情内容照填（diff 后立即可展开），可见性
        // 由用户展开态（reasoningOpen）控制，不再直接平铺。
        const detailText = reasoningDetailText(item);
        if (row.detailEl.textContent !== detailText) row.detailEl.textContent = detailText;
        row.detailEl.hidden = !row.reasoningOpen;
        if (row.caret) row.caret.hidden = false;
      }
    } else if (row.kind === "plan") {
      updatePlanContent(row, item.plan);
    }
  }

  // 工具详情字段：参数 → 命令 → 目录 → 退出码 → 耗时 → 错误（固定顺序，折叠在
  // .agent-tool-details div 内，R1 后整行点击切换）。输出块在 truncated 时前置
  // 截断提示。字段只在签名变化时写入 DOM（避免每次 update 重建）；输出文本直接
  // 比对避免重复写。全部字段为空且无输出时隐藏整个折叠区（标签 + path 行照常
  // 显示）——空判定从已构建的字段行派生（隐藏字段不算），输出侧与渲染文本共用
  // outputText。可见性 = hasContent 且用户已展开（toolOpen）。
  function updateToolDetails(row, item) {
    const values = {
      "参数": item.args != null && typeof item.args === "object" && Object.keys(item.args).length > 0
        ? JSON.stringify(item.args) : null,
      "命令": typeof item.command === "string" && item.command.length > 0 ? item.command : null,
      "目录": typeof item.cwd === "string" && item.cwd.length > 0 ? item.cwd : null,
      "退出码": item.exit_code != null ? String(item.exit_code) : null,
      "耗时": item.duration_ms != null ? `${item.duration_ms} ms` : null,
      "错误": item.error ?? null
    };
    const outputText = (item.truncated ? WORK_OUTPUT_TRUNCATED_MARK : "") + String(item.output ?? "");
    if (row.outputEl.textContent !== outputText) row.outputEl.textContent = outputText;
    const signature = JSON.stringify(values);
    if (signature !== row.fieldsSignature) {
      row.fieldsSignature = signature;
      for (const name of FIELD_ORDER) {
        const value = values[name];
        if (value == null || value === "") {
          const field = row.fieldEls.get(name);
          if (field) field.hidden = true;
          continue;
        }
        let field = row.fieldEls.get(name);
        let content;
        if (!field) {
          field = doc.createElement("div");
          field.className = "agent-tool-field";
          const key = doc.createElement("strong");
          key.textContent = name;
          content = doc.createElement("pre");
          field.append(key, content);
          row.detail.append(field);
          row.fieldEls.set(name, field);
          // 新字段出现时按固定顺序重排（真实 DOM 中重复 append 会移动节点）。
          const sorted = FIELD_ORDER.map((n) => row.fieldEls.get(n)).filter(Boolean);
          row.detail.replaceChildren(...sorted);
        } else {
          field.hidden = false;
          content = field.children[1] ?? null;
        }
        if (content && content.textContent !== value) content.textContent = value;
      }
    }
    const hasVisibleField = FIELD_ORDER.some((name) => {
      const field = row.fieldEls.get(name);
      return field != null && !field.hidden;
    });
    row.hasContent = hasVisibleField || outputText.length > 0;
    row.details.hidden = !row.hasContent || !row.toolOpen;
    // 输出块与详情区同步可见（真实 DOM 中父级 hidden 级联即可；测试桩不级联，
    // 需显式设置，对真实 DOM 是幂等冗余）。
    row.outputEl.hidden = !row.hasContent || !row.toolOpen;
  }

  function updatePlanContent(row, plan) {
    const items = Array.isArray(plan?.items) ? plan.items : [];
    const signature = JSON.stringify({ explanation: plan?.explanation ?? null, items });
    if (signature === row.planSignature) return;
    row.planSignature = signature;
    const completed = items.filter((item) => item?.status === "completed").length;
    row.countEl.textContent = `${completed}/${items.length}`;
    row.listEl.replaceChildren();
    if (typeof plan?.explanation === "string" && plan.explanation.length > 0) {
      const explanation = doc.createElement("div");
      explanation.className = "agent-plan-explanation";
      explanation.textContent = plan.explanation;
      row.listEl.append(explanation);
    }
    for (const task of items) {
      const li = doc.createElement("li");
      li.className = "agent-plan-item";
      li.dataset.status = task?.status ?? "";
      li.dataset.planId = task?.id ?? task?.step ?? "";
      const iconEl = doc.createElement("span");
      iconEl.className = "agent-plan-item__icon";
      iconEl.setAttribute("aria-hidden", "true");
      iconEl.textContent = PLAN_MARKS[task?.status] ?? "○";
      const step = doc.createElement("span");
      step.className = "agent-plan-item__step";
      step.textContent = String(task?.step ?? "");
      li.append(iconEl, step);
      if (typeof task?.description === "string" && task.description.length > 0) {
        const description = doc.createElement("div");
        description.className = "agent-plan-description";
        description.textContent = task.description;
        li.append(description);
      }
      row.listEl.append(li);
    }
  }

  // 工作组运行中每秒只更新一次 duration 文本；终态/waiting_user/脱离文档即停表。
  function ensureGroupClock(record, group) {
    const active = DURATION_ACTIVE_STATUSES.has(group.status);
    if (!active || !record.details.isConnected) {
      if (record.durationTimer != null) {
        scheduler.clearInterval(record.durationTimer);
        record.durationTimer = null;
      }
      return;
    }
    if (record.durationTimer != null) return;
    record.durationTimer = scheduler.setInterval(() => {
      if (record.durationTimer == null) return;
      const g = currentState?.work?.groups.get(record.groupId);
      if (!g || !DURATION_ACTIVE_STATUSES.has(g.status) || !record.details.isConnected) {
        scheduler.clearInterval(record.durationTimer);
        record.durationTimer = null;
        return;
      }
      record.duration.textContent = formatDuration(groupLiveElapsedMs(g));
    }, 1000);
  }

  // 动效 class 只能由 visibleLiveTargets() 决定，显式切换（不只在创建节点时添加）。
  function applyLiveTargets(record, group) {
    const liveTargets = new Set(visibleLiveTargets(group, { expanded: record.details.open }));
    record.status.classList.toggle("agent-live-text", liveTargets.has(`group:${group.id}`));
    for (const [itemId, row] of record.rows) {
      row.label.classList.toggle("agent-live-text", liveTargets.has(itemId));
    }
  }

  function updateWorkGroup(record, group) {
    // 展开默认值只在用户未手动切换时应用；完成后投影 expanded=false → 自动折叠。
    if (!record.userToggled && record.details.open !== group.expanded) {
      record.details.open = group.expanded;
    }
    if (TERMINAL_RUN_STATUSES.has(group.status)) {
      // 终态耗时取组自身投影的冻结时钟（Task 15 修复）——与运行中分支（L1069 的
      // groupLiveElapsedMs）同源：整个组状态都读工作组投影时钟，不读当前 active run，
      // 第二个 Run 开始后旧组的文案不再被新 Run 覆盖。
      record.status.textContent = groupStatusText(group);
      record.duration.textContent = "";
    } else {
      // 非终态统一走 groupStatusText（单一文案源）：running/interrupting/stopping →
      // "工作中"；waiting_user → "待命"（与 session-sidebar RUN_STATUS_LABELS 口径一致）。
      record.status.textContent = groupStatusText(group);
      record.duration.textContent = formatDuration(groupLiveElapsedMs(group));
    }
    ensureGroupClock(record, group);

    const ordered = orderedWorkItems(group);
    const seen = new Set();
    let changed = false;
    for (const item of ordered) {
      seen.add(item.id);
      let row = record.rows.get(item.id);
      if (!row) {
        row = buildWorkItemRow(record, item);
        record.rows.set(item.id, row);
        changed = true;
      }
      updateWorkItemRow(record, row, item);
    }
    for (const [itemId, row] of record.rows) {
      if (!seen.has(itemId)) {
        row.ticker?.finish?.();
        row.wrap.remove();
        record.rows.delete(itemId);
        changed = true;
      }
    }
    applyLiveTargets(record, group);
    return changed;
  }

  function syncWork(state) {
    const seen = new Set();
    let changed = false;
    for (const group of state.work.groups.values()) {
      if (orderedWorkItems(group).length === 0) continue; // 纯 run 标记的空组不渲染
      seen.add(group.id);
      let record = workGroups.get(group.id);
      if (!record) {
        record = createWorkGroup(group);
        changed = true;
      }
      // 重建后组的 firstSeq 前移（前置页补齐了组的首事件）：重插 details 定位。
      if (record.groupSeq !== group.firstSeq) {
        if (record.groupKey != null) messageNodes.delete(record.groupKey);
        record.details.remove();
        timelineSeqs.delete(record.details);
        record.groupSeq = group.firstSeq;
        record.groupKey = workGroupKey(group);
        insertTimeline(record.details, group.firstSeq, record.groupKey);
        changed = true;
      }
      if (updateWorkGroup(record, group)) changed = true;
    }
    for (const [id, record] of workGroups) {
      if (!seen.has(id)) {
        clearWorkGroupTimers(record);
        record.details.remove();
        if (record.groupKey != null) messageNodes.delete(record.groupKey);
        timelineSeqs.delete(record.details);
        workGroups.delete(id);
      }
    }
    if (changed) afterRender();
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
    if (appended) afterRender();
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
    if (state.errors.length > 0) afterRender();
  }

  // ---- 排队输入（Task 11）：原文 + 排队/下一条 + 立即 + 取消（撤回） ------------
  // 「立即」语义（SPEC 3.3 rule 8）：第一次请求被接受（priority_input_requested
  // 事件或快照 priority_input_id）后全部「立即」禁用，目标项标为下一条；优先输入
  // 真正开始（input_started）后恢复。以 snapshot/event 为准，不做乐观第二请求。
  function syncQueue(state) {
    if (rendered.queue === state.revisions.queue) return;
    rendered.queue = state.revisions.queue;
    queueSlot.replaceChildren();
    const priorityId = state.session?.priority_input_id ?? null;
    const promoteDisabled = priorityId != null;
    for (const item of getQueuedInputs(state)) {
      // 排队行确认送达：即时（pending/失败）气泡收敛为「接下来」排队行
      reconcilePendingSubmission({ input_id: item.id, text: item.text });
      const row = doc.createElement("div");
      row.className = "agent-queue-item";
      row.dataset.testid = "agent-queue-item";
      row.dataset.inputId = item.id;
      const text = doc.createElement("span");
      text.className = "agent-queue-text";
      text.textContent = String(item.text ?? "");
      const badge = doc.createElement("span");
      badge.className = "agent-queue-state";
      const isNext = priorityId != null && String(item.id) === String(priorityId);
      if (isNext) {
        row.classList.add("agent-queue-item--next");
        badge.textContent = "下一条";
      } else {
        badge.textContent = "排队";
      }
      const promote = doc.createElement("button");
      promote.type = "button";
      promote.className = "agent-promote";
      promote.dataset.testid = "agent-promote";
      promote.textContent = "立即";
      promote.disabled = promoteDisabled;
      promote.addEventListener("click", () => {
        // 优先在途（快照/事件为准）时按钮 disabled；真实 DOM 不派发 click，
        // 这里再加一道防御，保证不做乐观第二请求。
        if (promote.disabled) return;
        const generation = viewGeneration;
        // 后端在已有优先在途时返回 409 priority_pending（双击/双窗口竞态）：
        // 失败必须给出可见反馈并吞掉 rejection，不得产生 unhandled rejection；
        // 迟到的失败（已切走项目/会话）不在新视图弹 toast。
        Promise.resolve(actions.requestPriority?.(item.id)).catch((error) => {
          if (generation !== viewGeneration) return;
          showToast(
            error?.code === "priority_pending"
              ? "已在优先处理中"
              : `请求失败：${String(error?.message ?? "请求失败")}`
          );
        });
      });
      const withdraw = doc.createElement("button");
      withdraw.type = "button";
      withdraw.className = "agent-withdraw";
      withdraw.dataset.testid = "agent-withdraw";
      withdraw.textContent = "取消";
      withdraw.addEventListener("click", () => withdrawQueuedInput(item.id));
      row.append(text, badge, promote, withdraw);
      queueSlot.append(row);
    }
    afterRender();
  }

  // 撤回排队输入：成功后以接口返回的权威 draft_text 回填 composer——composer 为
  // 空时直接填入，已有草稿则以换行追加，绝不覆盖（SPEC 3.2 rule 5）；失败保持
  // 原 UI/草稿并 toast（队列行是否移除以 input_withdrawn 事件为准）。
  // 请求在途时切换项目/会话：reset() 递增 viewGeneration，迟到的 resolve/reject
  // 一律丢弃——旧项目的撤回文本不得写进新项目 composer，旧项目的失败也不得在
  // 新视图弹 toast（与 submitFromComposer 的 submissionGeneration 守卫一致）。
  function withdrawQueuedInput(inputId) {
    const generation = viewGeneration;
    Promise.resolve(actions.withdrawInput?.(inputId)).then((result) => {
      if (generation !== viewGeneration) return;
      const draftText = result?.draft_text;
      if (typeof draftText === "string" && draftText.length > 0) {
        appendWithdrawnDraft(draftText);
      }
    }).catch((error) => {
      if (generation !== viewGeneration) return;
      showToast(`撤回失败：${String(error?.message ?? "请求失败")}`);
    });
  }

  function appendWithdrawnDraft(text) {
    const current = String(input.value ?? "");
    input.value = current.length > 0 ? `${current}\n${text}` : text;
    input.focus?.();
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

  // Task 12 Step 2：可关闭顶层按固定优先级只执行第一项 —— slash menu →
  // composer 菜单 → context popover。返回是否消费了 ESC（true=已关闭某一层）。
  function dismissTopLayer() {
    if (!slashMenu.hidden) {
      closeSlashMenu();
      return true;
    }
    if (composerMenus.some((control) => !control.menu.hidden)) {
      closeComposerMenus();
      return true;
    }
    if (contextRing.popover?.dataset?.open === "true") {
      contextRing.dismiss();
      return true;
    }
    return false;
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

  function fillMenu(control, options, currentValue, enabled, onSelect, fireAlwaysWhen = null) {
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
        // 占位项（值匹配当前但必须响应点击，如「未配置」开设置页）经
        // fireAlwaysWhen 判定后照常触发 onSelect。
        if (item.value !== control.trigger.dataset.value || (fireAlwaysWhen && fireAlwaysWhen(item))) {
          onSelect(item.value);
        }
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

    // 模型：选项为 Task 16 派生的选择器选项（value = `${provider_id}/${model_id}`）。
    // 未加载（composerOptions null）→ 空占位并禁用；已加载但无任何可用模型 → 「未
    // 配置」占位可点（点击开新设置页）。清单外字面模型（legacy: 前缀）只读展示。
    const models = Array.isArray(options?.models) ? options.models : [];
    const modelOptions = models.length > 0
      ? models.map((model) => ({
          value: String(model.value ?? ""),
          label: String(model.label ?? model.value ?? ""),
          title: String(model.label ?? model.value ?? "")
        }))
      : [{ value: "", label: "未配置" }];
    fillMenu(
      modelControl,
      modelOptions,
      String(options?.activeModelId ?? ""),
      composerEnabled && options != null && options?.modelSelectionEnabled !== false,
      (modelId) => {
        if (modelId === "") {
          // 「未配置」占位：直接打开新设置页（模型分区）。
          actions.openModelSettings?.();
          return;
        }
        if (String(modelId).startsWith("legacy:")) return; // 清单外只读条目不可切换
        actions.switchModel?.(modelId);
      },
      (item) => item.value === ""
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
    setMenuValue(modelControl, modelValue, "未配置");
    const permissionValue = String(options?.permissionTier ?? "confirm");
    setMenuValue(permissionControl, permissionValue, "确认后修改");
    const effortValue = levels ? String(options?.reasoningEffort ?? "auto") : "auto";
    setMenuValue(effortControl, effortValue, "自动");
  }

  // Task 16（R5-7/R5-9）：composer 发送门禁的集中判定——发送按钮与 Enter 共用同一
  // canSubmit。项目未打开 / busy（其他会话运行中）/ 压缩阻塞（在途或失败）/
  // 对话历史损坏（needs_history_clear）任一即禁发；composerEnabled/composerBusy/
  // currentState 由最近一次 render 写入。
  function canSubmit() {
    if (!composerEnabled) return false;
    if (composerBusy) return false;
    if (!currentState) return false;
    if (compactionBlocksSend(getCompaction(currentState))) return false;
    if (getNeedsHistoryClear(currentState)) return false;
    return true;
  }

  function syncComposer(state) {
    const enabled = Boolean(state.projectRoot);
    // Task 16：先置 composerEnabled 再计算发送门禁（canSubmit 依赖它），
    // 按钮与 Enter 的判定收敛到同一函数。
    composerEnabled = enabled;
    const historyClearBlocked = getNeedsHistoryClear(state);
    input.disabled = !enabled;
    send.disabled = !canSubmit();
    input.placeholder = composerBusy ? "另一个对话正在运行" : "输入消息";
    composer.hidden = !enabled;
    historyClearHint.hidden = !historyClearBlocked;
    surface.classList.toggle("agent-surface--empty", !enabled);
    syncComposerControls();
    // 有项目时隐藏产品起点；项目内的空会话保持干净，不显示欢迎词。
    emptyState.hidden = enabled;
    if (!enabled) {
      closeSlashMenu();
      closeComposerMenus();
    }
  }

  // Task 8：项目其他会话运行中（app.js / Task 9 或 submit 的 project_busy 调用）。
  // 只禁发送、改提示，不锁输入；state 变化时 syncComposer 沿用该标志。
  function setBusy(isBusy) {
    composerBusy = isBusy === true;
    if (currentState) syncComposer(currentState);
  }

  // Task 8：提交因会话竞态被丢弃时回填草稿。view 的失败路径受 viewGeneration
  // 守卫保护（切走后的旧回调不改新视图），此方法由 surface 主动调用；仅当输入
  // 框为空时回填，避免覆盖用户已输入的新内容。
  function restoreComposerText(text) {
    if (String(input.value ?? "").length > 0) return;
    input.value = String(text ?? "");
  }

  function submitFromComposer() {
    const text = String(input.value ?? "").trim();
    if (!text) return;
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

    // Task 6：重试即重发同一文本，旧失败气泡先移除，避免成功后残留。
    removeFailedBubble(text);

    const bubble = createMessageBubble("user", text);
    bubble.dataset.state = "pending";
    messages.append(bubble);
    const pending = { text, node: bubble, inputId: null };
    pendingSubmissions.push(pending);
    input.value = "";
    closeSlashMenu();
    afterRender();
    Promise.resolve(request).then((result) => {
      if (submissionGeneration !== viewGeneration) return;
      pending.inputId = result?.input_id ?? null;
      // Task 6：click 提交后焦点从发送按钮回到输入框，便于连续输入。
      input.focus();
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
      failedSubmissions.push({ text, node: bubble });
      if (String(input.value ?? "").length === 0) input.value = text;
      afterRender();
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
      // Task 16（R5-9）：与发送按钮共用同一 canSubmit 判定——busy/压缩阻塞/
      // 对话损坏任一即禁发，输入保留。
      if (!canSubmit()) return;
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

  // ---- 历史 gap（Task 10 Step 2）：page.gaps 投影为时间线节点，不伪造消息 ----
  function syncGaps(state) {
    for (const gap of state.historyGaps) {
      if (messageNodes.has(gap.event_key)) continue;
      const node = doc.createElement("div");
      node.className = "agent-history-gap";
      node.dataset.testid = "agent-history-gap";
      const text = doc.createElement("span");
      text.className = "agent-history-gap-text";
      text.textContent = "此处有一段历史不可读";
      node.append(text);
      insertTimeline(node, gap.start_seq, gap.event_key);
    }
  }

  // ---- 压缩状态行（Task 11 Step 4）：每个 compaction_id 一行，单行顶替 -------
  // 行结构：外层 .agent-compaction（时间线节点，带 compaction_id）包含
  // .agent-compaction-row（固定文案所在行，textContent 只等于 LABELS 文案）与
  // .agent-compaction-actions（动作按钮）。同一行只更新 label textContent 与
  // 动作按钮，不重建 DOM；完成/取消/noop 移除按钮。
  function buildCompactionRow(entry) {
    const wrap = doc.createElement("div");
    wrap.className = "agent-compaction";
    wrap.dataset.compactionId = entry.compaction_id;
    const row = doc.createElement("div");
    row.className = "agent-compaction-row";
    row.dataset.testid = "agent-compaction-row";
    const label = doc.createElement("span");
    label.className = "agent-compaction-label";
    row.append(label);
    const actions = doc.createElement("div");
    actions.className = "agent-compaction-actions";
    wrap.append(row, actions);
    return { wrap, row, label, actions, seq: null, eventKey: null, buttonsSignature: "" };
  }

  function updateCompactionRow(record, entry) {
    // Task 12：未知压缩状态回退中文文案，不回退为英文 state code。
    const labelText = COMPACTION_ROW_LABELS[entry.state] ?? "处理中";
    if (record.label.textContent !== labelText) record.label.textContent = labelText;
    record.wrap.dataset.state = entry.state;
    // 按钮只按状态签名重建：失败 → 重试+取消；running → 取消；其余无按钮。
    const buttons = COMPACTION_ROW_BUTTONS[entry.state] ?? [];
    const signature = buttons.join(",");
    if (signature === record.buttonsSignature) return;
    record.buttonsSignature = signature;
    record.actions.replaceChildren();
    if (buttons.includes("retry")) {
      const retry = doc.createElement("button");
      retry.type = "button";
      retry.className = "agent-compaction-btn";
      retry.dataset.testid = "agent-compaction-retry";
      retry.textContent = "重试";
      retry.addEventListener("click", () => actions.retryCompaction?.(entry.compaction_id));
      record.actions.append(retry);
    }
    if (buttons.includes("cancel")) {
      const cancel = doc.createElement("button");
      cancel.type = "button";
      cancel.className = "agent-compaction-btn";
      cancel.dataset.testid = "agent-compaction-cancel";
      cancel.textContent = "取消";
      cancel.addEventListener("click", () => actions.cancelCompaction?.(entry.compaction_id));
      record.actions.append(cancel);
    }
  }

  function syncCompactionRows(state) {
    for (const entry of getCompactionRows(state).values()) {
      let record = compactionRowNodes.get(entry.compaction_id);
      if (!record) {
        record = buildCompactionRow(entry);
        compactionRowNodes.set(entry.compaction_id, record);
        record.seq = entry.seq;
        record.eventKey = entry.event_key;
        insertTimeline(record.wrap, entry.seq, entry.event_key);
        updateCompactionRow(record, entry);
        afterRender();
        continue;
      }
      // 重建后锚点前移（前置页补到了 started）：移除并按新锚点重插。
      if (record.seq !== entry.seq || record.eventKey !== entry.event_key) {
        if (record.eventKey != null) messageNodes.delete(record.eventKey);
        record.wrap.remove();
        timelineSeqs.delete(record.wrap);
        record.seq = entry.seq;
        record.eventKey = entry.event_key;
        insertTimeline(record.wrap, entry.seq, entry.event_key);
      }
      updateCompactionRow(record, entry);
    }
    // state 层已移除的 id（重建后不存在）：同步移除对应 DOM 行。
    for (const [id, record] of compactionRowNodes) {
      if (!getCompactionRows(state).has(id)) {
        record.wrap.remove();
        if (record.eventKey != null) messageNodes.delete(record.eventKey);
        timelineSeqs.delete(record.wrap);
        compactionRowNodes.delete(id);
      }
    }
  }

  // ---- 上下文圆环（Task 11）：每次 render 同步 ------------------------------
  // 活性依赖 run 状态与压缩状态，不只随 context 事件变化，因此不被
  // revisions.context 门控；压缩状态行仍由 revisions.context 驱动。
  function syncContext(state) {
    contextRing.setUsage(getContextUsage(state));
    const run = getActiveRun(state);
    const compaction = getCompaction(state);
    const active =
      Boolean(run && isRunActive(run)) ||
      Boolean(compaction && COMPACTION_ACTIVE_STATES.has(compaction.state));
    contextRing.setActive(active);
  }

  // ---- 第九轮：系统通知行（chapter_rolled_back / memory_file_restored） ------
  // 通知行插入对话时间线，按 seq 排序；重渲染先移除旧行再追加（去重）。
  function syncNotices(state) {
    if (rendered.notices === state.revisions.notices) return;
    rendered.notices = state.revisions.notices;
    // 去重：移除此前渲染的通知行。
    messages.querySelectorAll("[data-notice-type]").forEach((n) => n.remove());
    for (const notice of state.systemNotices ?? []) {
      const row = doc.createElement("div");
      row.className = "system-notice";
      row.dataset.noticeType = notice.type;
      row.textContent = notice.type === "chapter_rolled_back"
        ? `已恢复第 ${notice.payload?.chapter_no} 章${notice.payload?.to_version ? `到版本 ${notice.payload.to_version}` : ""}`
        : `已恢复${notice.payload?.file === "worklog" ? "工作日志" : "故事摘要"}到版本 ${notice.payload?.to_version ?? ""}`;
      insertTimeline(row, notice.seq);
    }
    if ((state.systemNotices ?? []).length > 0) afterRender();
  }

  function render(state, actionBag = {}) {
    actions = actionBag;
    currentState = state;
    syncMessages(state);
    syncStream(state);
    syncRun(state);
    syncWork(state);
    syncNotices(state);
    syncDecisions(state);
    syncErrors(state);
    syncGaps(state);
    syncContext(state);
    if (rendered.context !== state.revisions.context) {
      rendered.context = state.revisions.context;
      syncCompactionRows(state);
    }
    syncQueue(state);
    syncComposer(state);
  }

  function setLoadingEarlier(enabled) {
    loadingEarlier = enabled === true;
  }

  return {
    render,
    reset,
    destroy,
    setComposerOptions,
    setBusy,
    restoreComposerText,
    prepareEarlierInsert,
    restoreScrollAnchor,
    showHistoryLoadError,
    clearHistoryLoadError,
    setLoadingEarlier,
    dismissTopLayer,
    // Task 21（spec 4.3 #10）：三控件保存失败的 error toast 由 index.js 经此
    // 出口触发（与撤回失败/优先冲突共用同一个 surface 自持 agent-toast）。
    showToast
  };
}
