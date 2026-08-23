// src/app-shell/agent/view.js —— AgentSurface 单一视图（Task 8 Step 3-4）。
//
// 原生 DOM（无框架）渲染：对话、当前 Run（停止/重试按钮 + Visible Plan +
// 决策/错误卡）、工作组（reasoning/tool/plan 时间线，工具详情与输出折叠在
// 工作项内）、排队输入、composer。本壳只保留：静态骨架、分区组装（共享引用
// 接线）、通知行渲染与上下文圆环同步；各职责随第十五轮分区拆 view/ 下模块。
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
// 第十五轮（Task 17）：决策/错误/排队输入卡片分区拆至 view/cards.mjs。
// 第十五轮（Task 18）：composer（三控件菜单/斜杠命令/发送门禁/提交与失败气泡/
// 暂停与草稿回填）拆至 view/composer.mjs，DOM 骨架仍由本壳创建。
import {
  getActiveRun,
  isRunActive,
  getContextUsage,
  getCompaction
} from "./state.js";
import { createContextRing } from "./context-ring.js";
import { bindExternalLinks } from "../markdown-lite.mjs";
import { icon } from "../icons.js";
import { createToaster } from "../dom-kit.js";
import { createTimelineView } from "./view/timeline.mjs";
import { createWorkGroupView } from "./view/work-group.mjs";
import { createCardsView } from "./view/cards.mjs";
import { createComposerView } from "./view/composer.mjs";

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
  // 三控件（模型 / 权限模式 / 思考强度）的菜单构建已随 Task 18 迁 view/composer.mjs
  // 分区（菜单是 composer 内的向上浮层，不交给系统原生 select 决定方向和样式）。
  const controls = doc.createElement("div");
  controls.className = "agent-composer-controls";
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
  let followLatest = true;     // 显式 follow 状态：仅用户接近底部时跟随（滚动锁，Task 7）
  let currentState = null;     // 最近一次 render 的 state（供异步帧回调读取）
  // composer 分区状态（composerOptions/controlsSignature/composerEnabled/composerBusy/
  // slashMatches/slashActiveIndex）已随 Task 18 迁 view/composer.mjs 分区私有。
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
    // composer 分区清理：在途 busy/草稿/菜单选项签名/斜杠菜单（Task 18 起归 composerView.reset）。
    composerView.reset();
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
    clearToast();
    composerView.destroy();
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
  // Task 18（第十五轮）：composer 分区接线。同上——DOM 骨架由壳创建（composer/
  // slashMenu/input/composerShell/send/controls 等），三控件菜单构建、composer
  // 状态（选项/签名/busy/斜杠）与发送逻辑收编分区；共享状态经引用传入，活绑定
  // actions/currentState/viewGeneration 以 getter 接通；pending 与失败气泡数组
  // 与时间线分区共享，提交气泡的插入/移除/落底经 ctx.timeline。
  const composerView = createComposerView({
    doc,
    composer,
    slashMenu,
    input,
    composerShell,
    historyClearHint,
    composerToolbar,
    send,
    controls,
    contextRing,
    surface,
    emptyState,
    viewIcon,
    timeline,
    messages,
    pendingSubmissions,
    failedSubmissions,
    showToast,
    get actions() { return actions; },
    get currentState() { return currentState; },
    get viewGeneration() { return viewGeneration; }
  });

  // ---- composer（三控件菜单/斜杠/门禁/提交已迁 view/composer.mjs，Task 18）------
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
    composerView.syncComposer(state);
  }

  function setLoadingEarlier(enabled) {
    timeline.setLoadingEarlier(enabled);
  }

  return {
    render,
    reset,
    destroy,
    setComposerOptions: composerView.setComposerOptions,
    setBusy: composerView.setBusy,
    restoreComposerText: composerView.restoreComposerText,
    // 前置分页/历史缺口入口由时间线分区实现，壳保持同名转发（index.js 调用点零改动）。
    prepareEarlierInsert: () => timeline.prepareEarlierInsert(),
    restoreScrollAnchor: () => timeline.restoreScrollAnchor(),
    showHistoryLoadError: (beforeSeq) => timeline.showHistoryLoadError(beforeSeq),
    clearHistoryLoadError: () => timeline.clearHistoryLoadError(),
    setLoadingEarlier,
    dismissTopLayer: composerView.dismissTopLayer,
    // Task 21（spec 4.3 #10）：三控件保存失败的 error toast 由 index.js 经此
    // 出口触发（与撤回失败/优先冲突共用同一个 surface 自持 agent-toast）。
    showToast
  };
}
