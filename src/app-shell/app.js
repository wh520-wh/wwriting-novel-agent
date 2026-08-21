// WWriting · 统一 Agent 对话控制面（统一 Agent 内核计划 Task 9）。
//
// 页面组合根：创建 AgentSurface（src/app-shell/agent/index.js，唯一对话 seam）并
// 传递项目变更/设置/章节回调；其余只保留导航、项目列表、设置、章节阅读与确定性
// 工具（导出）。不再 import 或维护 thread renderer / composer / agent truth /
// run presentation / write readiness / activity strip / suggestions / command
// registry 的状态（Rule 4/5：UI 不做业务决策，Agent 状态由 AgentSurface 消费
// snapshot/event）。
import { motion } from "./motion-runtime.js";
import { getJson, postJson, withProjectScope } from "./api-client.js";
import { formatNumber, pathBaseName, pathEquals, translateStage } from "./utils.js";
import { icon } from "./icons.js";
import { createDrawerPanels } from "./drawer-panels.js";
import { createSettingsModal } from "./settings-modal.js";
import { createModelSettingsPage } from "./model-settings-page.js";
import { handleDashboardMigrationNotice } from "./settings-connection.mjs";
import { createProjectScope } from "./project-scope.mjs";
import { createSessionSidebar, createSessionRemovalResolver } from "./session-sidebar.mjs";
import { createAgentSurface } from "./agent/index.js";
import { createVersionPanel } from "./components/version-panel.js";
import { createPlanPanel } from "./components/plan-panel.js";

const refs = {
  app: document.querySelector("#app"),
  rail: document.querySelector(".rail"),
  railToggle: document.querySelector("#rail-toggle"),
  railScrim: document.querySelector("#rail-scrim"),
  refresh: document.querySelector("#refresh"),
  newNovel: document.querySelector("#new-novel"),
  projectCount: document.querySelector("#project-count"),
  projectFilter: document.querySelector("#project-filter"),
  projectList: document.querySelector("#project-list"),
  projectOpenStatus: document.querySelector("#project-open-status"),
  railScroll: document.querySelector(".rail-scroll"),
  openFolder: document.querySelector("#open-folder"),
  openSettings: document.querySelector("#open-settings"),
  title: document.querySelector("#project-title"),
  topbarSub: document.querySelector("#topbar-sub"),
  privacyToggle: document.querySelector("#privacy-toggle"),
  privacyLabel: document.querySelector("#privacy-label"),
  themeToggle: document.querySelector("#theme-toggle"),
  themeLabel: document.querySelector("#theme-label"),
  openDrawer: document.querySelector("#open-drawer"),
  topbarMore: document.querySelector("#topbar-more"),
  topbarSecondary: document.querySelector("#topbar-secondary"),
  agentSurface: document.querySelector("#agent-surface"),
  drawerScrim: document.querySelector("#drawer-scrim"),
  drawer: document.querySelector("#drawer"),
  drawerClose: document.querySelector("#drawer-close"),
  drawerTabs: document.querySelector("#drawer-tabs"),
  drawerBody: document.querySelector("#drawer-body"),
  readerScrim: document.querySelector("#reader-scrim"),
  readerTitle: document.querySelector("#reader-title"),
  readerMeta: document.querySelector("#reader-meta"),
  readerClose: document.querySelector("#reader-close"),
  readerBody: document.querySelector("#reader-body"),
  readerFontMinus: document.querySelector("#reader-font-minus"),
  readerFontPlus: document.querySelector("#reader-font-plus"),
  readerPrev: document.querySelector("#reader-prev"),
  readerNext: document.querySelector("#reader-next"),
  readerWide: document.querySelector("#reader-wide"),
  settingsScrim: document.querySelector("#settings-scrim"),
  settingsDetail: document.querySelector("#settings-detail"),
  settingsCancel: document.querySelector("#settings-cancel"),
  settingsSave: document.querySelector("#settings-save"),
  settingsSaveStatus: document.querySelector("#settings-save-status"),
  settingsX: document.querySelector("#settings-x"),
  createScrim: document.querySelector("#create-scrim"),
  createHeading: document.querySelector("#create-heading"),
  createLead: document.querySelector("#create-card .lead"),
  createTitle: document.querySelector("#create-title"),
  createSeed: document.querySelector("#create-seed"),
  createChapters: document.querySelector("#create-chapters"),
  createMinWords: document.querySelector("#create-min-words"),
  createPath: document.querySelector("#create-path"),
  createBrowse: document.querySelector("#create-browse"),
  createSubmit: document.querySelector("#create-submit"),
  createStatus: document.querySelector("#create-status"),
  createX: document.querySelector("#create-x"),
  shortcutsScrim: document.querySelector("#shortcuts-scrim"),
  shortcutsX: document.querySelector("#shortcuts-x"),
  toastStack: document.querySelector("#toast-stack")
};

const desktop = window.wwritingDesktop;
document.documentElement.dataset.desktopShell = desktop?.shell ?? "browser";
document.documentElement.dataset.desktopPlatform = desktop?.platform ?? "browser";

let currentProjectRoot = null;
let dashboardRequestId = 0;
let drawerTab = "chapters";
let lastDashboard = null;
// 唯一的 project generation 门禁：旧项目响应到达时不会污染当前 DOM。
const projectScope = createProjectScope();
let lastFocused = null;
let createModalMode = "new";
let readerChapterNo = null;
let projectListData = null;

// 第九轮：任务计划面板——常驻顶栏 chip，绝对定位折叠下拉。
const planPanel = createPlanPanel({ doc: document });

// ---- AgentSurface：唯一对话 seam ----
const agentSurface = createAgentSurface({
  root: refs.agentSurface,
  api: null, // 默认 transport：agent/api.js（复用 api-client 通用 helper）
  onOpenSettings: (section) => openSettingsOrModelPage(section),
  onOpenChapter: (chapterNo) => openReader(chapterNo),
  onCreateProject: () => openCreateModal(),
  onOpenProjectFolder: () => openFromFolder(),
  // Task 9：会话列表刷新 → 左侧栏两级树（只重渲当前项目组 + busy 复位）。Task 3：
  // draft 占位不进入会话列表（发送首条消息前左侧不显示新项），只经 activeSessionId
  // 透出活跃指针；侧边栏渲染层按 status === "draft" 过滤兜底（双保险）。活跃会话
  // id 由 sidebar 自持（sessionCache 的 activeSessionId），app.js 需要时经
  // sessionSidebar.getSessions() 读取。
  onSessionsChanged: (sessions, activeSessionId) => {
    sessionSidebar.handleSessionsChanged(currentProjectRoot, sessions, activeSessionId);
  },
  // Task 9：SSE run 终态 → 重拉会话列表并复位 busy。app.js 不消费 SSE（surface 是
  // 唯一消费者），这里经 surface 的 onRunTerminal 钩子转发；busy 复位由
  // onSessionsChanged → handleSessionsChanged 内的检查承担（有非终态 → true，
  // 全部非终态集外 → false，第十二轮 E 起按 BUSY_RUN_STATUSES）。终态事件按当前
  // 会话流到达；跨会话运行结束的复位缺口见 session-sidebar.mjs 的 syncBusy 注释
  //（openProject/switchSession 刷新兜底）。
  onPlanUpdated: (plan) => {
    planPanel.sync(plan?.items ?? []);
  },
  // 第十一轮（审计 A）：composer 三控件保存成功 -> 后台刷新 dashboard（抽屉模型
  // 面板/顶栏/项目列表与 composer 同屏一致；background 模式失败只 toast 不打断）。
  onDashboardRefresh: () => {
    void loadDashboard({ background: true });
  },
  // 第十二轮 E：run 状态变化（含 waiting_user 等非终态）事件驱动侧边栏
  // 轻量刷新（读时失效模式，重拉会话列表 + 状态点更新；不重渲面板）。
  onRunStatusChanged: () => {
    agentSurface.refreshSessions();
  },
  onRunTerminal: () => {
    // Task 16（R5-12）：Run 终态统一刷新——会话列表（busy 复位）与 dashboard
    //（顶栏进度/章节抽屉/成本面板）。Agent snapshot 权威刷新在 surface 内部
    //（maybeRefreshAfterTerminal 补拉快照）；后台刷新失败只 toast，旧 scope 数据
    // 由 loadDashboard 的 requestId/projectScope 守卫丢弃，绝不灌入新项目。
    agentSurface.refreshSessions();
    void loadDashboard({ background: true });
  }
});

// 第九轮：任务计划面板挂载——chip 插入顶栏 actions，位于更多按钮之前。
const topbarActions = document.querySelector(".topbar-actions");
topbarActions?.insertBefore(planPanel.chip, refs.topbarMore ?? topbarActions.firstChild);
document.addEventListener("click", (event) => planPanel.handleOutsideClick(event));
document.addEventListener("keydown", (event) => planPanel.handleKeydown(event));

// Task 9：左侧栏两级树（项目折叠组 → 对话列表）。渲染、折叠状态、懒加载缓存与
// 会话操作都在 session-sidebar.mjs；app.js 只提供数据源与 surface 接线。
const sessionSidebar = createSessionSidebar({
  listEl: refs.projectList,
  countEl: refs.projectCount,
  filterEl: refs.projectFilter,
  scrollEl: refs.railScroll,
  getProjectListData: () => projectListData,
  getCurrentProjectRoot: () => currentProjectRoot,
  fetchSessions: async (projectRoot) => getJson(withProjectScope("/api/agent/sessions", projectRoot)),
  renderProjectRow: (project) => renderProjectNav(project),
  surface: agentSurface,
  onArchiveSession: (session) => archiveSessionAndResolveActive(session),
  showToast,
  openProjectAndSession
});

// Task 12：新「模型设置」页面（左供应商列表 + 右详情），在弹窗内作为「模型设置」
// 分区注入渲染（A3：modelSettings.attach({ list, detail }) 的渲染目标由
// settings-modal 的 renderSectionBody 构建）。声明上移至 createSettingsModal 之前，
// 作为其只读依赖；onChanged 保留（模型变更后刷新对话模型选择器）。
const modelSettings = createModelSettingsPage({
  showToast,
  onChanged: () => {
    // 触发对话模型选择器刷新（Task 16）：模型选择器选项来自全局供应商清单，
    // 设置页增删/启停/设默认后重拉，选择器即时反映最新清单。
    agentSurface.refreshComposerOptions();
  }
});

const settingsModal = createSettingsModal({
  refs,
  getDashboard: () => lastDashboard,
  getCurrentProjectRoot: () => currentProjectRoot,
  showToast,
  loadDashboard,
  getLastFocused: () => lastFocused,
  setLastFocused: (el) => { lastFocused = el; },
  // Task A3：model 分区渲染依赖（注入渲染目标 + open 拉取列表）。
  modelSettings,
  // Task 13：对话导出/清空即时动作。clearHistory 必须转发 options
  // （confirm_irreversible:true），surface 内部负责清空后的重置与重开当前项目。
  exportAgentHistory: () => agentSurface.exportHistory(),
  clearAgentHistory: (options) => agentSurface.clearHistory(options),
  // Task 10：设置页「已归档对话」分类的会话操作。恢复直接走 surface；永久删除走
  // deleteSessionAndResolveActive——删的恰好是当前活跃会话时切到最近活跃会话
  // （归档会话正常不会是活跃会话，但 active_session_id 可能残留指向它，走它最安全）。
  restoreSession: (sessionId) => agentSurface.restoreSession(sessionId),
  deleteSession: (sessionId) => deleteSessionAndResolveActive(sessionId),
});
const { openSettingsModal, closeSettingsModal, saveSettings } = settingsModal;

// Task A1：统一设置入口——所有设置入口（齿轮/抽屉模型配置/斜杠命令）统一打开设置
// 弹窗；model/settings/缺省 → 「模型设置」分区（A3 起生效，此前回落第一个分区），
// writing/skills/danger → 对应分区。
async function openSettingsOrModelPage(section) {
  if (!section || section === "model" || section === "settings") section = "model";
  await openSettingsModal(section);
}

const { renderDrawerBody } = createDrawerPanels({
  refs,
  getDrawerTab: () => drawerTab,
  getDashboard: () => lastDashboard,
  loadDashboard,
  openReader,
  // Task 12：抽屉「模型配置」面板的打开按钮无分区参数 → 路由到新「模型设置」页。
  openSettingsModal: (section) => openSettingsOrModelPage(section),
  showToast,
  showActionError,
  closeDrawer,
  // 第十一轮（审计 C）：抽屉章节/记忆分区版本面板的恢复门禁（与后端 409 同口径）。
  isAgentRunning: () => agentSurface.isAgentRunning()
});

// ---- Round10：rail 覆盖态与 drawer 模态语义归 app shell 所有 ----
const railMedia = window.matchMedia("(max-width: 1279px)");
const drawerModalMedia = window.matchMedia("(max-width: 1279px)");

function openRail() {
  if (!railMedia.matches) return;
  refs.rail.classList.add("show");
  refs.railScrim.hidden = false;
  refs.railToggle.setAttribute("aria-expanded", "true");
}

function closeRail({ restoreFocus = true } = {}) {
  refs.rail.classList.remove("show");
  refs.railScrim.hidden = true;
  refs.railToggle.setAttribute("aria-expanded", "false");
  if (restoreFocus) refs.railToggle.focus();
}

function isDrawerModal() {
  return drawerModalMedia.matches;
}

function syncDrawerMode() {
  const modal = isDrawerModal();
  refs.drawer.setAttribute("role", modal ? "dialog" : "complementary");
  if (modal) refs.drawer.setAttribute("aria-modal", "true");
  else refs.drawer.removeAttribute("aria-modal");
  refs.drawerScrim.hidden = !modal || !refs.drawer.classList.contains("show");
}

const onViewportModeChange = () => {
  // 已打开的 drawer 因窗口变窄升级为模态：焦点移入抽屉，避免停留在背景。
  // media change 事件到达时 .matches 已是新值，旧态从 drawer 当前语义（role）判断。
  const openWide = refs.drawer.classList.contains("show") &&
    refs.drawer.getAttribute("role") === "complementary";
  syncDrawerMode();
  if (openWide && isDrawerModal()) refs.drawerClose.focus();
  // 窄屏 → 宽屏：收起 rail 覆盖态；drawer 不强制关闭（宽屏非模态可继续停留）。
  if (!railMedia.matches && refs.rail.classList.contains("show")) closeRail({ restoreFocus: false });
};
railMedia.addEventListener?.("change", onViewportModeChange);
drawerModalMedia.addEventListener?.("change", onViewportModeChange);
syncDrawerMode();

function openDrawer(tab) {
  if (tab) drawerTab = tab;
  setDrawerTabActive();
  refs.drawer.removeAttribute("inert");
  refs.drawer.classList.add("show");
  refs.drawer.setAttribute("aria-hidden", "false");
  // 在 .show 之后同步模态语义：scrim 的 hidden 依据当前显示态计算
  //（先于 .show 调用会把模态 scrim 留在 hidden，[hidden] 会压过 .scrim.show）。
  syncDrawerMode();
  lastFocused = document.activeElement; // 记录触发焦点（宽屏不移动焦点，仅记录）
  if (isDrawerModal()) {
    // 模态：显示 scrim、焦点移入抽屉关闭按钮。
    refs.drawerScrim.classList.add("show");
    refs.drawerClose.focus();
  } else {
    // 宽屏非模态：scrim 保持隐藏，不抢正在输入 Composer 的焦点。
    refs.drawerScrim.classList.remove("show");
  }
  renderDrawerBody();
  // 第十一轮（审计 D 简化）：抽屉打开即后台刷新一次 dashboard（lastDashboard 是
  // 快照缓存，Run 中的章节/成本/模型数据在打开时可能已旧）。失败只 toast；
  // 到达后经 renderDashboard -> refreshDrawerIfOpen 重渲抽屉。
  void loadDashboard({ background: true });
  motion.openDrawer(refs.drawer, refs.drawerScrim, {
    body: refs.drawerBody,
    tabs: refs.drawerTabs
  });
}

function toggleDrawer() {
  if (refs.drawer.classList.contains("show")) closeDrawer();
  else openDrawer();
}

function openDrawerTab(tab) {
  if (refs.drawer.getAttribute('aria-hidden') !== 'false') toggleDrawer();
  setDrawerTab(tab);
}

function closeDrawer() {
  // 只有焦点当前位于 drawer 内，或模态打开时，才把焦点还给触发器。
  const restoreFocus = isDrawerModal() || refs.drawer.contains(document.activeElement);
  refs.drawer.dataset.closing = "true";
  refs.drawerScrim.dataset.closing = "true";
  motion.closeDrawer(refs.drawer, refs.drawerScrim, {
    onComplete: () => {
      delete refs.drawer.dataset.closing;
      delete refs.drawerScrim.dataset.closing;
      if (restoreFocus) {
        // lastFocused 是共享槽：drawer 内再开 settings/reader 会覆盖它。
        // 兜底：指向 drawer 内部或已断开时，退回 drawer 触发器。
        // ponytail: 多浮层焦点栈改造超出本任务范围；兜底保证焦点不丢失。
        const target = lastFocused && lastFocused.isConnected && !refs.drawer.contains(lastFocused)
          ? lastFocused
          : refs.openDrawer;
        if (target) target.focus();
      }
      lastFocused = null;
    }
  });
  refs.drawer.classList.remove("show");
  refs.drawer.setAttribute("aria-hidden", "true");
  refs.drawer.setAttribute("inert", "");
  refs.drawerScrim.classList.remove("show");
}

function setDrawerTab(tab) {
  drawerTab = tab;
  setDrawerTabActive();
  renderDrawerBody();
}

function setDrawerTabActive() {
  for (const button of refs.drawerTabs.querySelectorAll(".dtab")) {
    const on = button.dataset.dtab === drawerTab;
    button.classList.toggle("on", on);
    button.setAttribute("aria-selected", on ? "true" : "false");
    button.tabIndex = on ? 0 : -1;
  }
}

// Round10：drawer Tab 完整键盘语义——ArrowLeft/Right/Home/End 在五个分区间轮换，
// 只切换现有 tab，不改变数据加载接口。
refs.drawerTabs.addEventListener("keydown", (event) => {
  const tabs = [...refs.drawerTabs.querySelectorAll(".dtab")];
  const index = tabs.indexOf(document.activeElement);
  if (index < 0) return;
  let next = -1;
  if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
  else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = tabs.length - 1;
  if (next < 0) return;
  event.preventDefault();
  setDrawerTab(tabs[next].dataset.dtab);
  tabs[next].focus();
});

// ---------- 事件绑定 ----------
refs.refresh.addEventListener("click", () => loadAll());
refs.newNovel.addEventListener("click", () => openCreateModal());
refs.openFolder.addEventListener("click", () => openFromFolder());
// Task 12：设置入口缺省分区为 model → 打开新「模型设置」页（模型分区已迁移）。
refs.openSettings.addEventListener("click", () => openSettingsOrModelPage());
refs.projectFilter?.addEventListener("input", () => renderProjectListFiltered());
if (!refs.drawerClose.title) refs.drawerClose.title = "关闭抽屉";
refs.drawerClose.addEventListener("click", () => closeDrawer());
refs.drawerScrim.addEventListener("click", () => closeDrawer());
refs.drawerTabs.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-dtab]");
  if (tab) setDrawerTab(tab.dataset.dtab);
});
// Task 12：右侧 quick rail 已删除，章节/资料/成本入口统一经顶部「面板」按钮进入 drawer。
// Round10：面板已是抽屉 menuitem，点它顺手收起更多二级菜单，避免两个浮层并存。
refs.openDrawer?.addEventListener("click", () => {
  closeTopbarSecondary();
  openDrawerTab("chapters");
});

// Round10：rail 覆盖态入口（窄屏 rail 不再 display:none）。
refs.railToggle?.addEventListener("click", () => {
  if (refs.rail.classList.contains("show")) closeRail();
  else openRail();
});
refs.railScrim?.addEventListener("click", () => closeRail());

// Round10：topbar 更多菜单——点击只切换 .show；outside click 关闭但不抢焦点；
// Escape 关闭（全局 keydown 处理）并把焦点还给 more。统一关闭走 closeTopbarSecondary
//（drawer menuitem / 外点 / Escape 三处复用，避免手写两份 class+aria 更新漂移）。
function closeTopbarSecondary({ restoreFocus = false } = {}) {
  if (!refs.topbarSecondary?.classList.contains("show")) return;
  refs.topbarSecondary.classList.remove("show");
  refs.topbarMore?.setAttribute("aria-expanded", "false");
  if (restoreFocus) refs.topbarMore?.focus();
}
refs.topbarMore?.addEventListener("click", () => {
  const show = refs.topbarSecondary.classList.toggle("show");
  refs.topbarMore.setAttribute("aria-expanded", show ? "true" : "false");
});
document.addEventListener("click", (event) => {
  if (!refs.topbarSecondary?.classList.contains("show")) return;
  if (refs.topbarSecondary.contains(event.target) || refs.topbarMore.contains(event.target)) return;
  closeTopbarSecondary();
});
// Round10：菜单语义配套键盘——menuitem 聚焦时 ArrowDown/ArrowUp/Home/End 轮换。
// 桌面行内常驻时同样生效（两枚按钮，行为无害且语义一致）。
refs.topbarSecondary?.addEventListener("keydown", (event) => {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = [...refs.topbarSecondary.querySelectorAll('[role="menuitem"]')];
  const index = items.indexOf(document.activeElement);
  if (index < 0) return;
  event.preventDefault();
  let next = -1;
  if (event.key === "ArrowDown") next = (index + 1) % items.length;
  else if (event.key === "ArrowUp") next = (index - 1 + items.length) % items.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = items.length - 1;
  items[next].focus();
});

// Task 12 Step 3：app 顶层（快捷键/阅读器/设置/新建/抽屉）的 ESC 关闭保持原有
// 优先级，返回是否已关闭某层；未关闭的 ESC 再交给 AgentSurface（压缩取消/停止）。
function closeAppTopLayer() {
  if (refs.shortcutsScrim.classList.contains("show")) { closeShortcuts(); return true; }
  if (refs.readerScrim.classList.contains("show")) { closeReader(); return true; }
  if (refs.settingsScrim.classList.contains("show")) { closeSettingsModal(); return true; }
  if (refs.createScrim.classList.contains("show")) { closeCreateModal(); return true; }
  if (refs.drawer.classList.contains("show")) { closeDrawer(); return true; }
  // rail 覆盖态优先级最低：顶层 modal/drawer 都未处理时才关闭。
  if (refs.rail.classList.contains("show")) { closeRail(); return true; }
  return false;
}

if (!refs.readerClose.title) refs.readerClose.title = "关闭";
refs.readerClose.addEventListener("click", closeReader);
refs.readerScrim.addEventListener("click", (event) => {
  if (event.target === refs.readerScrim) closeReader();
});
if (!refs.settingsX.title) refs.settingsX.title = "关闭设置";
refs.settingsX.addEventListener("click", closeSettingsModal);
refs.settingsCancel.addEventListener("click", closeSettingsModal);
refs.settingsScrim.addEventListener("click", (event) => {
  if (event.target === refs.settingsScrim) closeSettingsModal();
});
refs.settingsSave.addEventListener("click", () => saveSettings());
if (!refs.createX.title) refs.createX.title = "关闭";
refs.createX.addEventListener("click", closeCreateModal);
// 新建弹窗：只通过右上角 X 或 Esc 关闭，避免点击遮罩误触丢失已填内容。
refs.createBrowse.addEventListener("click", () => browseForCreatePath());
refs.createSubmit.addEventListener("click", () => initProject(refs.createPath.value.trim()));

if (!refs.shortcutsX.title) refs.shortcutsX.title = "关闭";
refs.shortcutsX.addEventListener("click", () => closeShortcuts());
refs.shortcutsScrim.addEventListener("click", (event) => {
  if (event.target === refs.shortcutsScrim) closeShortcuts();
});

refs.readerFontMinus.addEventListener("click", () => nudgeReaderFont(-1));
refs.readerFontPlus.addEventListener("click", () => nudgeReaderFont(1));
refs.readerPrev.addEventListener("click", () => openAdjacentChapter(-1));
refs.readerNext.addEventListener("click", () => openAdjacentChapter(1));
refs.readerWide.addEventListener("click", () => {
  const on = !document.querySelector("#reader").classList.contains("reader--wide");
  document.querySelector("#reader").classList.toggle("reader--wide", on);
  refs.readerWide.setAttribute("aria-pressed", on ? "true" : "false");
});
const readerHistory = document.getElementById("reader-history");
if (readerHistory && !readerHistory.__bound) {
  readerHistory.__bound = true;
  let versionPanel = null; // 单例：只创建一次，复用 panel.open()
  readerHistory.addEventListener("click", async () => {
    if (!versionPanel) {
      versionPanel = createVersionPanel({ doc: document });
      document.getElementById("reader")?.append(versionPanel);
    }
    const chapterNo = readerChapterNo;
    versionPanel.open({
      title: `第 ${chapterNo} 章`,
      getVersions: async () => getJson(`/api/chapters/versions?chapter_no=${chapterNo}`),
      getContent: async (version) => getJson(`/api/chapters/versions/content?chapter_no=${chapterNo}&version=${version}`),
      onRestore: async (version) => {
        // 第十二轮 F9：点击时按最新 Run 状态复查（面板存续期间旧求值会过期）。
        // 行为门禁与后端 409 同口径（非终态集），被拦时 toast 提示且不执行。
        if (agentSurface.isAgentRunning()) {
          showToast("写作进行中，暂停后恢复。");
          return;
        }
        const result = await postJson("/api/chapters/rollback", { chapter_no: chapterNo, version });
        if (result?.ok) {
          versionPanel.close();
          await openReader(chapterNo); // 恢复后刷新到最新内容
        }
      },
      // 第十一轮（审计 C）：Run 进行中禁用恢复（与后端 409 agent_running 同口径）。
      agentRunning: agentSurface.isAgentRunning()
    });
  });
}

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === ".") {
    event.preventDefault();
    setPrivacyMode(refs.app.dataset.privacy !== "on");
  }
  if (refs.readerScrim.classList.contains("show")) {
    if (event.key === "ArrowLeft") { event.preventDefault(); openAdjacentChapter(-1); return; }
    if (event.key === "ArrowRight") { event.preventDefault(); openAdjacentChapter(1); return; }
  }
  if (event.key === "Escape") {
    // Task 12：内层（textarea 关闭 slash menu、composer 菜单 ESC 等）已消费的
    // ESC 不得再进入全局路由，保证一次键只执行第一项。
    if (event.defaultPrevented) return;
    // Round10：topbar 更多菜单优先于顶层 overlay 关闭；关闭后焦点还给 more。
    if (refs.topbarSecondary.classList.contains("show")) {
      closeTopbarSecondary({ restoreFocus: true });
      event.preventDefault();
      return;
    }
    if (closeAppTopLayer()) { event.preventDefault(); return; }
    const handled = agentSurface.handleEscape();
    if (handled) event.preventDefault();
  }
  if (event.key === "?" && !isEditableTarget(event.target)) {
    event.preventDefault();
    openShortcuts();
  }
  if (refs.shortcutsScrim.classList.contains("show")) trapTab(refs.shortcutsScrim, event);
  else if (refs.readerScrim.classList.contains("show")) trapTab(refs.readerScrim, event);
  else if (refs.settingsScrim.classList.contains("show")) trapTab(refs.settingsScrim, event);
  else if (refs.createScrim.classList.contains("show")) trapTab(refs.createScrim, event);
  else if (refs.drawer.classList.contains("show") && isDrawerModal()) trapTab(refs.drawer, event);
});
window.addEventListener("blur", () => { refs.app.dataset.away = "true"; });
window.addEventListener("focus", () => { refs.app.dataset.away = "false"; });
refs.privacyToggle.addEventListener("click", () => setPrivacyMode(refs.app.dataset.privacy !== "on"));

async function loadAll() {
  await Promise.all([loadProjectList(), loadDashboard()]);
}

async function loadProjectList() {
  try {
    const data = await getJson("/api/projects/list");
    projectListData = data;
    renderProjectListFiltered();
  } catch (error) {
    projectListData = null;
    refs.projectList.replaceChildren(renderProjectEmpty(error.message));
  }
}

// Task 9：项目列表（含两级树渲染）整体委托 session-sidebar.mjs——项目行仍由
// renderProjectNav 提供（回调注入），折叠箭头/会话组/已归档折叠组/空态由模块渲染。
function renderProjectListFiltered() {
  sessionSidebar.render();
}

async function loadDashboard(options = {}) {
  const requestId = ++dashboardRequestId;
  const activeProjectRoot = currentProjectRoot;
  let token = projectScope.capture(activeProjectRoot);

  try {
    const dashboardUrl = withProjectScope("/api/dashboard", activeProjectRoot);
    const data = await getJson(dashboardUrl);
    if (requestId !== dashboardRequestId) return;
    if (!projectScope.isCurrent(token)) return;
    if (!activeProjectRoot && data.hasProject && data.projectRoot) {
      projectScope.activate(data.projectRoot);
      token = projectScope.capture(data.projectRoot);
    }
    if (!data.ok) throw new Error(data.message ?? "仪表盘请求失败");
    renderDashboard(data);
    // Task 16：迁移提示 toast——本次响应实际发生快照→引用迁移时提示一次（模块级
    // 一次性标志，页面加载内只弹一次）。
    handleDashboardMigrationNotice(data, showToast);
  } catch (error) {
    if (requestId !== dashboardRequestId) return;
    if (!projectScope.isCurrent(token)) return;
    // Task 16（R5-12）：后台刷新（Run 终态）失败只 toast——不渲染错误页，避免
    // 终态刷新把顶栏/抽屉替换成「读取失败」；旧 scope 数据由上面的守卫丢弃。
    if (options?.background === true) {
      showToast(error?.message ?? "刷新失败。", "error");
      return;
    }
    // Task 9：dashboard 失败时当前项目会话组降级为可重试失败行
    //（否则「加载中…」永不消失）。
    sessionSidebar.markSessionsFailed(activeProjectRoot);
    renderError(error);
  }
}

// Switch Cleanup Matrix：每次切换项目/无项目时重置项目级临时 UI 状态。
// AgentSurface 由 commitProjectSwitch 显式 openProject（重置其内部状态）。
function clearTransientState() {
  dashboardRequestId += 1;
  if (refs.toastStack) {
    for (const toast of [...refs.toastStack.children]) toast.remove();
  }
  if (refs.readerScrim?.classList.contains("show")) {
    refs.readerScrim.classList.remove("show");
    refs.readerScrim.setAttribute("inert", "");
  }
  readerChapterNo = null;
}

function commitProjectSwitch(projectRoot, activeSessionId = null) {
  projectScope.activate(projectRoot);
  currentProjectRoot = projectRoot;
  clearTransientState();
  // Task 9：会话级代次推进——在途会话切换的续作一律丢弃；openProject 完成后拉一次
  // 会话列表（Task 8 契约：surface 不自动拉）更新活跃高亮 + busy 复位。
  sessionSidebar.invalidateProject();
  Promise.resolve(agentSurface.openProject(projectRoot, activeSessionId)).then(() => {
    agentSurface.refreshSessions();
  });
}

// 「切走 + 占位兜底」（归档与删除共用）：依赖接线——会话缓存与会话切换绑定
// sessionSidebar，列表重拉与占位绑定 agentSurface。真实行为：切走推进会话代次，
// 操作方（surface.sessionAction）在切走前发起的列表刷新被代次守卫丢弃（index.js
// isCurrentProjectScope），解析器内部按切走后的新代次重拉一次并等待落盘再判定
// 占位（细节见 session-sidebar.mjs createSessionRemovalResolver）。
const resolveActiveAfterSessionRemoval = createSessionRemovalResolver({
  getSessions: () => sessionSidebar.getSessions(currentProjectRoot),
  switchSession: (sessionId) => sessionSidebar.switchSession(sessionId),
  refreshSessions: () => agentSurface.refreshSessions(),
  newSessionPlaceholder: () => agentSurface.newSessionPlaceholder()
});

// Task 8 契约：删除会话后若删的是当前活跃会话 → 切到该项目的最近活跃会话
//（surface.switchSession(null) 由后端 last-active 解析），无其他会话则进入占位新对话。
// Task 9 侧边栏无删除入口（会话操作仅改名/归档）；Task 10 设置页「已归档对话」
// 删除时调用本函数。
async function deleteSessionAndResolveActive(sessionId) {
  await agentSurface.deleteSession(sessionId);
  await resolveActiveAfterSessionRemoval(sessionId);
}

// Task 5 缺陷 B：归档当前活跃会话后 surface 仍指向已归档会话 → 侧边栏无高亮行
//（被过滤），继续发送会把消息写进隐藏的归档会话。归档成功后若被归档 id 仍是当前
// 活跃指针 → 切到最近活跃会话（后端 last-active 解析）；无其他可用会话则进入占位。
// 切走编排与删除共用 resolveActiveAfterSessionRemoval（createSessionRemovalResolver
// 工厂实例，依赖注入便于行为级测试），经 onArchiveSession 注入侧边栏（单一权威
// 位置，避免 sidebar 与 surface 双插导致双刷）。
async function archiveSessionAndResolveActive(session) {
  await agentSurface.archiveSession(session.session_id);
  await resolveActiveAfterSessionRemoval(session.session_id);
}

// R3/B1：项目行不可选中（无 active/aria-current），.proj 主体点击只折叠/展开
//（由 session-sidebar 的 decorateRow 绑定）；切换项目唯一入口 = 点击其他项目的
// 会话行（session-sidebar 委托 openProjectAndSession）。
function renderProjectNav(project) {
  const row = document.createElement("div");
  row.className = "proj-row";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "proj";
  button.title = project.title ?? "未命名小说";
  const projectIcon = document.createElement("span");
  projectIcon.className = "proj-icon";
  projectIcon.setAttribute("aria-hidden", "true");
  projectIcon.append(icon("folder", 16));
  const main = document.createElement("span");
  main.className = "proj-main";
  const title = document.createElement("span");
  title.className = "proj-title";
  title.textContent = project.title ?? "未命名小说";
  main.append(title);
  button.append(projectIcon, main);
  const menu = document.createElement("div");
  menu.className = "proj-menu";
  // R4：新对话加号移入项目行（垃圾桶左侧）
  const add = document.createElement("button");
  add.type = "button";
  add.className = "proj-add";
  add.replaceChildren(icon("plus", 14));
  add.setAttribute("aria-label", `在 ${project.title ?? "未命名小说"} 新建对话`);
  add.title = "新对话";
  add.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (!pathEquals(project.projectRoot, currentProjectRoot)) {
      await openProjectAndSession(project.projectRoot); // 全流程切项目（POST + commit + loadAll）
    }
    agentSurface.newSessionPlaceholder();
  });
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "proj-remove";
  remove.replaceChildren(icon("trash", 14));
  remove.setAttribute("aria-label", `从列表移除 ${project.title ?? "未命名小说"}`);
  remove.title = "从列表移除";
  remove.addEventListener("click", (event) => {
    event.stopPropagation();
    forgetProject(project.projectRoot);
  });
  menu.append(add, remove);
  row.append(button, menu);
  return row;
}

function renderProjectEmpty(text) {
  const empty = document.createElement("div");
  empty.className = "proj-empty";
  empty.textContent = text;
  return empty;
}

function renderDashboard(data) {
  lastDashboard = data;
  if (!data.hasProject) {
    currentProjectRoot = null;
    refs.title.textContent = "开始创作";
    refs.topbarSub.textContent = "新建或打开一部小说，开始你的创作。";
    sessionSidebar.syncBusy(); // 无项目：busy 复位
    refreshDrawerIfOpen();
    return;
  }

  const firstLoad = currentProjectRoot !== data.projectRoot;
  if (firstLoad) {
    // 切换/首次打开项目：把 AgentSurface 指向该项目（内部重连 SSE）。
    currentProjectRoot = data.projectRoot;
    agentSurface.openProject(data.projectRoot);
  }

  // Task 9：dashboard 会话数据 seed 当前项目（两级树当前项目组数据源，含 run_status
  // 状态点与 busy 复位依据）；懒加载缓存以最新 dashboard 为准。
  sessionSidebar.seedSessions(data.projectRoot, data.sessions ?? [], data.active_session_id ?? null);

  const summary = data.summary;
  const project = data.project;
  const modelProfile = data.model_profile ?? {};
  refs.title.textContent = project.title ?? "未命名小说";
  const progressCopy = `已写 ${summary.completedChapters}/${summary.targetChapters} 章`;
  // Task 8：未配置模型 = 无 model_name（is_mock 语义已废弃，用户面不再有 mock）。
  refs.topbarSub.textContent = !modelProfile || !modelProfile.model_name
    ? `模型未配置 · 请在设置里选一个 · ${progressCopy}`
    : progressCopy;

  refreshDrawerIfOpen();
}

// 抽屉打开时重渲并保留滚动位置。
function refreshDrawerIfOpen() {
  if (!refs.drawer.classList.contains("show")) return;
  const top = refs.drawerBody.scrollTop;
  renderDrawerBody();
  refs.drawerBody.scrollTop = top;
}

function renderError(error) {
  refs.title.textContent = "读取失败";
  refs.topbarSub.textContent = error.message;
  refs.projectOpenStatus.style.display = "block";
  refs.projectOpenStatus.textContent = error.message;
}

async function forgetProject(projectRoot) {
  if (!projectRoot) return;
  try {
    const result = await postJson("/api/projects/forget", { projectRoot });
    showToast("已从列表移除。", "success");
    // Task 16（B13）：移除项目后清理 sidebar 的缓存/DOM 引用/折叠记录，并封存
    // 该项目（迟到的 seed/会话变更不再重建缓存）。
    sessionSidebar.removeProject(projectRoot);
    const nextRoot = result.selectedProjectRoot ?? null;
    commitProjectSwitch(nextRoot);
    await loadAll();
  } catch (error) {
    showToast(error.message, "error");
    await loadProjectList();
  }
}

async function openProject(projectRoot) {
  if (!projectRoot) return;
  refs.projectOpenStatus.style.display = "block";
  refs.projectOpenStatus.textContent = "正在打开...";
  try {
    await postJson("/api/projects/open", { projectRoot });
    commitProjectSwitch(projectRoot);
    refs.projectOpenStatus.style.display = "none";
    refs.projectOpenStatus.textContent = "";
    await loadAll();
  } catch (error) {
    refs.projectOpenStatus.style.display = "none";
    if (error.code === "project_open_failed" && error.message.includes("不是有效的 WWriting 项目文件夹")) {
      openCreateModal(projectRoot, { mode: "init-folder" });
      showToast("该文件夹不是项目，可初始化为新小说。", "info");
    } else {
      showActionError(error);
    }
  }
}

// Task 2：跨项目会话切换的委托入口（点击其他项目会话行 / 其行内「+」新建）。
// 镜像 openProject 骨架，但可带 sessionId 直达目标会话；已选中项目 + 未指定会话
// 时为 no-op（同一项目内的会话切换不经过这里）。
async function openProjectAndSession(projectRoot, sessionId = null) {
  if (!projectRoot) return;
  if (pathEquals(projectRoot, currentProjectRoot) && sessionId == null) return; // 已选中项目 + 不指定会话：no-op
  refs.projectOpenStatus.style.display = "block";
  refs.projectOpenStatus.textContent = "正在打开...";
  try {
    await postJson("/api/projects/open", { projectRoot });
    commitProjectSwitch(projectRoot, sessionId);
    refs.projectOpenStatus.style.display = "none";
    refs.projectOpenStatus.textContent = "";
    await loadAll();
  } catch (error) {
    refs.projectOpenStatus.style.display = "none";
    refs.projectOpenStatus.textContent = "";
    if (error.code === "project_open_failed" && error.message.includes("不是有效的 WWriting 项目文件夹")) {
      openCreateModal(projectRoot, { mode: "init-folder" });
      showToast("该文件夹不是项目，可初始化为新小说。", "info");
    } else {
      showActionError(error);
    }
  }
}

async function openFromFolder() {
  const picked = await window.wwritingDesktop?.selectProjectFolder?.();
  if (picked) {
    await openProject(picked);
    return;
  }
  if (!window.wwritingDesktop?.selectProjectFolder) {
    openCreateModal("", { mode: "preview" });
    showToast("预览环境请在弹窗中手动输入文件夹路径。", "info");
  }
}

async function browseForCreatePath() {
  setCreateStatus("", "");
  const picked = await window.wwritingDesktop?.selectProjectFolder?.();
  if (picked) {
    refs.createPath.value = picked;
    setCreateStatus(`已选择：${picked}`, "info");
    refs.createTitle.focus();
  } else if (!window.wwritingDesktop?.selectProjectFolder) {
    showToast("预览环境请手动输入文件夹路径。", "info");
  }
}

function normalizeProjectPath(raw) {
  return raw?.trim()?.replace(/[\s]+$/g, "").replace(/\/$/g, "").replace(/\\$/g, "") ?? "";
}

function resetCreateForm() {
  refs.createTitle.value = "";
  refs.createSeed.value = "";
  refs.createChapters.value = "100";
  refs.createMinWords.value = "3000";
  refs.createPath.value = "";
  setCreateStatus("", "");
  const spinner = refs.createSubmit.querySelector(".btn-spinner");
  const label = refs.createSubmit.querySelector(".btn-label");
  if (spinner) spinner.hidden = true;
  if (label) label.hidden = false;
}

function setCreateSubmitLoading(loading) {
  refs.createSubmit.disabled = loading;
  const spinner = refs.createSubmit.querySelector(".btn-spinner");
  const label = refs.createSubmit.querySelector(".btn-label");
  if (spinner) spinner.hidden = !loading;
  if (label) label.hidden = loading;
}

async function initProject(rawPath) {
  const projectRoot = normalizeProjectPath(rawPath);
  if (!projectRoot) {
    setCreateStatus("请填写要保存到的本地文件夹路径。", "error");
    refs.createPath.focus();
    return;
  }
  if (/^(\\|\/|\\\\|[a-zA-Z]:\\?)$/.test(projectRoot) || projectRoot.length < 3) {
    setCreateStatus("请填写一个具体文件夹路径，不要只写盘符或根目录。", "error");
    refs.createPath.focus();
    return;
  }
  setCreateSubmitLoading(true);
  setCreateStatus("正在初始化项目...", "info");
  try {
    const minWords = Number(refs.createMinWords.value || 3000);
    await postJson("/api/projects/init", {
      projectRoot,
      title: refs.createTitle.value.trim() || pathBaseName(projectRoot),
      story_seed: refs.createSeed.value.trim(),
      target_chapters: refs.createChapters.value,
      min_words_per_chapter: minWords,
      target_words_per_chapter: Math.max(minWords, 3300),
      output_format: "md"
    });
    commitProjectSwitch(projectRoot);
    closeCreateModal();
    resetCreateForm();
    showToast("小说已创建并打开。", "success");
    await loadAll();
  } catch (error) {
    setCreateStatus(error.message, "error");
    showToast(error.message, "error");
  } finally {
    setCreateSubmitLoading(false);
  }
}

function setCreateStatus(text, kind) {
  refs.createStatus.textContent = text;
  refs.createStatus.className = `create-status${kind ? ` ${kind}` : ""}`;
}

// 阅读器字号四档（行高随档位），持久化 localStorage。
// Round10：默认档 = 17px/1.95（正文神圣基线），全档整数像素（去掉 15.5px 非整档）。
const READER_FONT_STEPS = [
  { size: 14, lh: 1.9 },
  { size: 17, lh: 1.95 },
  { size: 19, lh: 2.0 },
  { size: 21, lh: 2.0 }
];
let readerFontIndex = 1;
try {
  const stored = window.localStorage.getItem("ww:reader:fontsize");
  // 首次使用无存储值（null）：保持默认档，不能 Number(null)→0 落到最小档。
  if (stored != null) {
    const value = Number(stored);
    if (Number.isInteger(value) && value >= 0 && value < READER_FONT_STEPS.length) readerFontIndex = value;
  }
} catch { /* localStorage 不可用则用默认档 */ }

function applyReaderFont() {
  const step = READER_FONT_STEPS[readerFontIndex];
  refs.readerBody.style.fontSize = `${step.size}px`;
  refs.readerBody.style.lineHeight = String(step.lh);
  refs.readerFontMinus.disabled = readerFontIndex === 0;
  refs.readerFontPlus.disabled = readerFontIndex === READER_FONT_STEPS.length - 1;
}

function nudgeReaderFont(delta) {
  readerFontIndex = Math.max(0, Math.min(READER_FONT_STEPS.length - 1, readerFontIndex + delta));
  try { window.localStorage.setItem("ww:reader:fontsize", String(readerFontIndex)); } catch { /* 忽略 */ }
  applyReaderFont();
}

function readableChapters() {
  return [...(lastDashboard?.chapters ?? [])]
    .filter((c) => Number(c.actual_words ?? 0) > 0)
    .sort((a, b) => a.chapter_no - b.chapter_no);
}

function updateReaderNav() {
  const list = readableChapters();
  const idx = list.findIndex((c) => c.chapter_no === readerChapterNo);
  refs.readerPrev.disabled = idx <= 0;
  refs.readerNext.disabled = idx < 0 || idx >= list.length - 1;
}

function openAdjacentChapter(delta) {
  const list = readableChapters();
  const idx = list.findIndex((c) => c.chapter_no === readerChapterNo);
  const next = list[idx + delta];
  if (next) void openReader(next.chapter_no);
}

async function openReader(chapterNo) {
  // B7：捕获 {projectScope, chapterNo}，await 后校验——慢旧章节响应不得覆盖
  // 新章（readerChapterNo 已推进）或新项目（scope 已切换）。
  const token = projectScope.capture();
  readerChapterNo = chapterNo;
  refs.readerTitle.textContent = `第 ${chapterNo} 章`;
  refs.readerMeta.textContent = "正在读取本章正文...";
  refs.readerBody.replaceChildren(readerEmpty("读取中..."));
  openOverlay(refs.readerScrim, refs.readerClose);
  applyReaderFont();
  updateReaderNav();
  try {
    const data = await getJson(`/api/chapters/read?chapter=${encodeURIComponent(chapterNo)}`);
    if (!projectScope.isCurrent(token)) return;
    if (readerChapterNo !== chapterNo) return;
    refs.readerTitle.textContent = data.title ?? `第 ${chapterNo} 章`;
    refs.readerMeta.textContent = `${data.is_draft ? "草稿" : "正式章节"} · ${translateStage(data.status)} · ${formatNumber(data.actual_words)} 字`;
    const paragraphs = String(data.content ?? "").split(/\n{2,}/u).map((block) => block.trim()).filter(Boolean);
    if (paragraphs.length === 0) {
      refs.readerBody.replaceChildren(readerEmpty("本章正文为空。"));
      return;
    }
    refs.readerBody.replaceChildren(...paragraphs.map((text) => {
      const p = document.createElement("p");
      p.textContent = text;
      return p;
    }));
    refs.readerBody.scrollTop = 0;
  } catch (error) {
    if (!projectScope.isCurrent(token)) return;
    if (readerChapterNo !== chapterNo) return;
    refs.readerBody.replaceChildren(readerEmpty(error.message));
    refs.readerMeta.textContent = "读取失败";
  }
}

function readerEmpty(text) {
  const p = document.createElement("p");
  p.className = "reader-empty";
  p.textContent = text;
  return p;
}

function closeReader() {
  closeOverlay(refs.readerScrim);
}

function renderCreateModalCopy() {
  const copy = {
    new: {
      heading: "开始一部新小说",
      lead: "告诉我故事的种子，应用会规划、起草、审稿、定稿，并把每一章保存为本地文件。",
      submit: "创建并打开"
    },
    preview: {
      heading: "手动填写本地文件夹",
      lead: "当前环境不能打开系统文件夹选择器，请手动输入一个空文件夹路径来创建新小说。",
      submit: "初始化文件夹"
    },
    "init-folder": {
      heading: "初始化这个文件夹",
      lead: "这个文件夹还不是 WWriting 项目。确认后会在其中创建小说配置和章节目录。",
      submit: "初始化并打开"
    }
  }[createModalMode] ?? {
    heading: "开始一部新小说",
    lead: "告诉我故事的种子，应用会规划、起草、审稿、定稿，并把每一章保存为本地文件。",
    submit: "创建并打开"
  };
  if (refs.createHeading) refs.createHeading.textContent = copy.heading;
  if (refs.createLead) refs.createLead.textContent = copy.lead;
  const submitLabel = refs.createSubmit?.querySelector(".btn-label");
  if (submitLabel) submitLabel.textContent = copy.submit;
  else if (refs.createSubmit) refs.createSubmit.textContent = copy.submit;
}

function openCreateModal(prefillPath, options = {}) {
  createModalMode = options.mode ?? "new";
  setCreateStatus("", "");
  setCreateSubmitLoading(false);
  if (prefillPath) refs.createPath.value = prefillPath;
  renderCreateModalCopy();
  openOverlay(refs.createScrim, refs.createTitle);
  motion.openModal(refs.createScrim, document.querySelector("#create-card"));
}

function closeCreateModal() {
  refs.createScrim.dataset.closing = "true";
  refs.createScrim.classList.remove("show");
  refs.createScrim.setAttribute("inert", "");
  motion.closeModal(refs.createScrim, document.querySelector("#create-card"), {
    onComplete: () => {
      delete refs.createScrim.dataset.closing;
      if (lastFocused && lastFocused.isConnected) lastFocused.focus();
      lastFocused = null;
    }
  });
}

function getFocusable(container) {
  return [...container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && el.offsetParent !== null);
}
function trapTab(container, event) {
  if (event.key !== "Tab") return;
  const f = getFocusable(container);
  if (!f.length) { event.preventDefault(); return; }
  const first = f[0], last = f[f.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
function openOverlay(scrim, firstEl) {
  lastFocused = document.activeElement;
  scrim.removeAttribute("inert");
  scrim.classList.add("show");
  firstEl?.focus?.();
}
function closeOverlay(scrim) {
  scrim.classList.remove("show");
  scrim.setAttribute("inert", "");
  if (lastFocused && lastFocused.isConnected) lastFocused.focus();
  lastFocused = null;
}

function openShortcuts() { openOverlay(refs.shortcutsScrim, refs.shortcutsX); }
function closeShortcuts() { closeOverlay(refs.shortcutsScrim); }

function isEditableTarget(target) {
  const tag = target?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable === true;
}

function initThemeMode() {
  let stored = null;
  try {
    stored = window.localStorage.getItem("ww:theme");
  } catch {
    stored = null;
  }
  const dark = stored === "dark" || (stored !== "light" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  applyThemeState(dark);
  refs.themeToggle?.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme !== "dark";
    setThemeMode(next);
  });
}

function setThemeMode(dark) {
  applyThemeState(dark);
  try {
    window.localStorage.setItem("ww:theme", dark ? "dark" : "light");
  } catch {
    // localStorage 不可用时忽略持久化。
  }
}

function applyThemeState(dark) {
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  refs.themeToggle?.setAttribute("aria-pressed", dark ? "true" : "false");
  refs.themeToggle?.classList.toggle("active", dark);
  if (refs.themeLabel) refs.themeLabel.textContent = dark ? "日间" : "夜间";
  try {
    window.wwritingDesktop?.setTitleBarTheme?.(dark);
  } catch {
    // 非 Electron 环境或旧版本忽略。
  }
}

function initPrivacyMode() {
  let stored = "off";
  try {
    stored = window.localStorage.getItem("ww:privacy") ?? "off";
  } catch {
    stored = "off";
  }
  applyPrivacyState(stored === "on");
}

function setPrivacyMode(on) {
  applyPrivacyState(on);
  try {
    window.localStorage.setItem("ww:privacy", on ? "on" : "off");
    if (on && window.localStorage.getItem("ww:privacy:hinted") !== "1") {
      window.localStorage.setItem("ww:privacy:hinted", "1");
      showToast("隐私模式已开启：正文已模糊，鼠标悬停可临时查看。", "info");
    }
  } catch {
    // localStorage 不可用时忽略持久化。
  }
}

function applyPrivacyState(on) {
  refs.app.dataset.privacy = on ? "on" : "off";
  refs.privacyToggle.setAttribute("aria-pressed", on ? "true" : "false");
  refs.privacyToggle.classList.toggle("active", on);
  refs.privacyLabel.textContent = on ? "隐私 · 开" : "隐私";
}

function showActionError(error) {
  refs.projectOpenStatus.style.display = "block";
  refs.projectOpenStatus.textContent = error.message;
  showToast(error.message, "error");
}

function showToast(message, type = "info") {
  if (!message || !refs.toastStack) return;
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  // Round10：error 是 alert（打断性），其余 status（stack 本身 aria-live=polite）。
  toast.setAttribute("role", type === "error" ? "alert" : "status");
  toast.append(icon(type === "error" ? "help" : "check", 15));
  toast.append(document.createTextNode(message));
  refs.toastStack.append(toast);
  const remove = () => {
    toast.classList.add("leaving");
    window.setTimeout(() => toast.remove(), 220);
  };
  window.setTimeout(remove, type === "error" ? 5200 : 3200);
}

// 模块体执行完毕（所有 const/let 已离开 TDZ）后再启动。
initThemeMode();
initPrivacyMode();

motion.setupMotion();
window.__wwritingMotionReady = true;

await loadAll();
