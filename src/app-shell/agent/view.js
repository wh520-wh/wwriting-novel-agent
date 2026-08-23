// src/app-shell/agent/view.js —— AgentSurface 单一视图（Task 8 Step 3-4）。
//
// 原生 DOM（无框架）渲染：对话、当前 Run（停止/重试按钮 + Visible Plan +
// 决策/错误卡）、工作组（reasoning/tool/plan 时间线，工具详情与输出折叠在
// 工作项内）、排队输入、composer。Plan 与 queue 渲染器是本文件的私有函数，
// 不创建额外的公共 UI 模块。
//
// 第十五轮（Task 15）：消息时间线分区拆至 view/timeline.mjs（气泡/流式正文/
// 前置分页与滚动锚定/上下文 gap/压缩状态行）；共享状态经引用传入，活绑定
// currentState/actions/viewGeneration/followLatest 以 getter 接通。
//
// 第十五轮（Task 16）：当前 Run 过程展示分区拆至 view/work-group.mjs（run header
// 停止/重试按钮、reasoning/tool/plan 工作组时间线、工具详情与搜索/计划渲染、
// 工作组生命周期与时钟）；共享引用 + currentState/actions getter 接通，跨分区
// 调用经 ctx.timeline（工作组与消息共享 messages 统一时间线）。
//
// 工作组行为（已随分区迁 view/work-group.mjs）：
//   - 工具项详情字段顺序固定：参数 → 命令 → 目录 → 退出码 → 耗时 → 错误；
//   - 工具输出保留最后 64 KiB，截断后前置「（输出过长已截断）」；
//   - 停止按钮点击立即禁用防连点，仅停止失败或终态事件后恢复；
//   - 私有推理字段永不渲染。
import {
  getActiveRun,
  isRunActive,
  getContextUsage,
  getCompaction,
  compactionBlocksSend,
  getNeedsHistoryClear
} from "./state.js";
import { createContextRing } from "./context-ring.js";
import { matchSlashCommands } from "./slash-commands.mjs";
import { bindExternalLinks } from "../markdown-lite.mjs";
import { PERMISSION_TIERS } from "../permission-tiers.mjs";
import { icon } from "../icons.js";
import { createToaster } from "../dom-kit.js";
import { createTimelineView } from "./view/timeline.mjs";
import { createWorkGroupView } from "./view/work-group.mjs";
import { createCardsView } from "./view/cards.mjs";

const SCROLL_THRESHOLD = 48;

// 压缩在途/失败都算「真实活动」：圆环给出轻微活性反馈。
//（压缩行文案/按钮映射已随时间线分区迁 view/timeline.mjs。）
const COMPACTION_ACTIVE_STATES = new Set(["started", "running", "cancelling"]);

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
  emptyMark.append(viewIcon("book", 36)); // Round10：64px 同源品牌标记（容器见 CSS）
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
    timeline.scrollToBottom();
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
  // stopPending（停止请求在途，防连点）已随 Task 16 迁 view/work-group.mjs 分区私有。
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
  // Task 13（F6）：收编 dom-kit createToaster 单源——单例复用 surface 内唯一
  // 节点、固定 status 角色、3s 后移除；reset/destroy 的清理经 clearToast()。
  const { showToast, clearToast } = createToaster(() => surface, {
    doc,
    scheduler,
    single: true,
    selector: '[data-testid="agent-toast"]',
    className: "agent-toast",
    testId: "agent-toast",
    timeoutFor: () => 3000
  });
  // ---- 共享容器（时间线/工作组/决策卡分区与壳经引用共用） -----------------------
  const workGroups = new Map();   // runId -> 工作组 DOM 记录（Task 16 起归 work-group 分区）
  const timelineSeqs = new Map(); // messages 子节点 -> seq（跨气泡/工作组排序，时间线分区用）
  const messageNodes = new Map(); // event_key -> 时间线节点（Task 10：稳定 key，重建/去重）
  const decisionCards = new Map(); // decision_id -> card（diff 更新，保留 extreme 输入）
  const compactionRowNodes = new Map(); // compaction_id -> { wrap, row, label, actions }（Task 11）
  const pendingSubmissions = []; // 仅保留仍在途的即时消息；终态立即移出，避免会话内累积
  // Task 6：提交失败的气泡（含错误文案）暂存于此，重试或消息确认送达（reconcile）
  // 时按文本移除，失败气泡不再永久残留。
  const failedSubmissions = [];
  //（流式气泡/前置分页锚点等时间线私有状态已随分区迁 view/timeline.mjs。）
  const rendered = {
    messages: -1, run: -1, queue: -1, decisions: -1, errors: -1,
    runId: null, runStatus: null, context: -1, notices: -1
  };

  // Task 15（第十五轮）：时间线分区接线。共享状态经引用传入（同一对象双方便携读写），
  // 活绑定（currentState/actions/viewGeneration/followLatest）以 getter 接通——
  // 分区内读取与壳内 let 变量语义一致。
  const timeline = createTimelineView({
    doc,
    messages,
    conv,
    scheduleFrame,
    showToast,
    timelineSeqs,
    messageNodes,
    pendingSubmissions,
    failedSubmissions,
    compactionRowNodes,
    rendered,
    get currentState() { return currentState; },
    get actions() { return actions; },
    get viewGeneration() { return viewGeneration; },
    get followLatest() { return followLatest; }
  });

  // Task 16（第十五轮）：当前 Run 过程展示分区接线。同上——共享状态经引用传入，
  // 活绑定 currentState/actions 以 getter 接通；timeline 分区接口经 ctx 注入
  //（工作组与消息共享 messages 统一时间线：插入/移除/落底经 ctx.timeline）。
  const workgroup = createWorkGroupView({
    doc,
    runSection,
    runHeader,
    errorsSlot,
    workGroups,
    decisionCards,
    rendered,
    timeline,
    scheduler,
    viewIcon,
    get currentState() { return currentState; },
    get actions() { return actions; }
  });

  function reset() {
    viewGeneration += 1;
    clearToast();
    // 工作组分区清理：计时器 + workGroups 映射 + stopPending 复位（Task 16 起归 workgroup.reset）。
    workgroup.reset();
    // 时间线分区清理：messages/seq-key 映射/流式气泡/压缩行/在途与失败气泡/
    // 前置分页锚点/历史缺口提示（Task 15 起归 timeline.reset）。
    timeline.reset();
    runHeader.replaceChildren();
    decisionsSlot.replaceChildren();
    errorsSlot.replaceChildren();
    queueSlot.replaceChildren();
    currentState = null;
    for (const card of decisionCards.values()) card.remove();
    decisionCards.clear();
    contextRing.dismiss();
    // AICSS composer：切换项目时清掉在途 busy（陈旧 promise 的守卫会跳过清理）
    delete send.dataset.busy;
    delete composerShell.dataset.busy;
    input.value = ""; // Task 6：未发送草稿（含占位会话里打的字）不得跨会话/项目泄漏
    composerOptions = null;
    controlsSignature = "";
    closeSlashMenu();
    rendered.messages = rendered.run = rendered.queue = -1;
    rendered.decisions = rendered.errors = -1;
    rendered.context = -1;
    // F8：跨会话切换时 rendered.notices 复用会导致 revision 恰相等的死区
    //（A/B 各 1 条通知时 gate 相等、不重渲染）——reset 必须强制重渲染。
    rendered.notices = -1;
    rendered.runId = null;
    rendered.runStatus = null;
  }

  function destroy() {
    doc.removeEventListener?.("pointerdown", handleComposerOutsidePointer, true);
    doc.removeEventListener?.("focusin", handleComposerOutsideFocus, true);
    clearToast();
    workgroup.destroy();
    timeline.destroy();
    contextRing.destroy();
    surface.remove();
  }

  // ---- 自动滚动：显式 follow 状态（仅用户接近底部时跟随） ----------------------
  // 用户滚动事件是 follow 状态的唯一来源；渲染后不再重新测量 isNearBottom()，
  // 否则内容高度变化会误判并把滚动抢回底部，打断正在阅读更早内容的用户。
  //（距离测量/落底/前置分页/锚点恢复/历史缺口提示已迁 view/timeline.mjs。）
  conv.addEventListener("scroll", () => {
    followLatest = timeline.distanceFromBottom(conv) <= SCROLL_THRESHOLD;
    latestButton.hidden = followLatest;
    timeline.maybeLoadEarlier();
  });

  // ---- 外部链接：交给系统默认浏览器（markdown-lite 公共委托，对话与抽屉共用）---
  // markdown-lite 只在 http:/https: 时输出 [data-external-link]。
  bindExternalLinks(conv);

  // Task 17（第十五轮）：决策/错误/排队输入卡片分区接线。同上——共享状态经引用
  // 传入，活绑定 actions/viewGeneration 以 getter 接通；input（composer 文本域）
  // 经引用共享（撤回成功回填草稿），timeline 经 ctx 注入（滚动锚定/送达收敛）。
  const cards = createCardsView({
    doc,
    decisionsSlot,
    errorsSlot,
    queueSlot,
    decisionCards,
    rendered,
    timeline,
    showToast,
    input,
    get actions() { return actions; },
    get viewGeneration() { return viewGeneration; }
  });
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
    // Round10：模型未配置（空值）→ 触发按钮 amber warning 态（不修改选择逻辑）。
    control.trigger.classList.toggle("is-warning", control.kind === "model" && currentValue === "");
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
    // AICSS composer：在途 busy 态（外壳扫描边框 + 按钮图标慢旋；落定/失败后移除）
    send.dataset.busy = "true";
    composerShell.dataset.busy = "true";
    let request;
    try {
      request = actions.submit?.(text);
    } catch (error) {
      request = Promise.reject(error);
    }
    if (request?.localOnly === true) {
      // AICSS composer：localOnly 即时落定（/settings、/model 等导航命令）也要清 busy
      delete send.dataset.busy;
      delete composerShell.dataset.busy;
      input.value = "";
      closeSlashMenu();
      return;
    }

    // Task 6：重试即重发同一文本，旧失败气泡先移除，避免成功后残留。
    timeline.removeFailedBubble(text);

    const bubble = timeline.createMessageBubble("user", text);
    bubble.dataset.state = "pending";
    messages.append(bubble);
    const pending = { text, node: bubble, inputId: null };
    pendingSubmissions.push(pending);
    input.value = "";
    closeSlashMenu();
    timeline.afterRender();
    Promise.resolve(request).then((result) => {
      if (submissionGeneration !== viewGeneration) return;
      delete send.dataset.busy;
      delete composerShell.dataset.busy;
      pending.inputId = result?.input_id ?? null;
      // Task 6：click 提交后焦点从发送按钮回到输入框，便于连续输入。
      input.focus();
    }).catch((error) => {
      if (submissionGeneration !== viewGeneration) return;
      delete send.dataset.busy;
      delete composerShell.dataset.busy;
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
      timeline.afterRender();
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

  // ---- 上下文圆环（Task 11）：每次 render 同步 ------------------------------
  //（历史 gap 与压缩状态行已随时间线分区迁 view/timeline.mjs。）
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
    // 去重：移除此前渲染的通知行（F17：统一走 removeNode 清 seq 索引，防泄漏）。
    messages.querySelectorAll("[data-notice-type]").forEach((n) => timeline.removeNode(n));
    for (const notice of state.systemNotices ?? []) {
      const row = doc.createElement("div");
      row.className = "system-notice";
      row.dataset.noticeType = notice.type;
      row.textContent = notice.type === "chapter_rolled_back"
        ? `已恢复第 ${notice.payload?.chapter_no} 章${notice.payload?.to_version ? `到版本 ${notice.payload.to_version}` : ""}`
        : `已恢复${notice.payload?.file === "worklog" ? "工作日志" : "故事摘要"}到版本 ${notice.payload?.to_version ?? ""}`;
      timeline.insertTimeline(row, notice.seq);
    }
    if ((state.systemNotices ?? []).length > 0) timeline.afterRender();
  }

  function render(state, actionBag = {}) {
    actions = actionBag;
    currentState = state;
    timeline.syncMessages(state);
    timeline.syncStream(state);
    workgroup.syncRun(state);
    workgroup.syncWork(state);
    syncNotices(state);
    cards.syncDecisions(state);
    cards.syncErrors(state);
    timeline.syncGaps(state);
    syncContext(state);
    if (rendered.context !== state.revisions.context) {
      rendered.context = state.revisions.context;
      timeline.syncCompactionRows(state);
    }
    cards.syncQueue(state);
    syncComposer(state);
  }

  function setLoadingEarlier(enabled) {
    timeline.setLoadingEarlier(enabled);
  }

  return {
    render,
    reset,
    destroy,
    setComposerOptions,
    setBusy,
    restoreComposerText,
    // 前置分页/历史缺口入口由时间线分区实现，壳保持同名转发（index.js 调用点零改动）。
    prepareEarlierInsert: () => timeline.prepareEarlierInsert(),
    restoreScrollAnchor: () => timeline.restoreScrollAnchor(),
    showHistoryLoadError: (beforeSeq) => timeline.showHistoryLoadError(beforeSeq),
    clearHistoryLoadError: () => timeline.clearHistoryLoadError(),
    setLoadingEarlier,
    dismissTopLayer,
    // Task 21（spec 4.3 #10）：三控件保存失败的 error toast 由 index.js 经此
    // 出口触发（与撤回失败/优先冲突共用同一个 surface 自持 agent-toast）。
    showToast
  };
}
