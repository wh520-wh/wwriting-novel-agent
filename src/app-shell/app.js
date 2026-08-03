import { computeAgentTruth, deriveActivity, deriveBadges, agentPhaseLabel } from "./agent-truth.mjs";
import { renderActivityStrip } from "./components/activity-strip.js";
import { renderQuickRail, bindQuickRailKeys } from "./components/quick-rail.js";
import { getLastSeen, watchLastSeen } from "./components/last-seen.js";
import { motion, summarizeBadgesForMotion, diffBadgeKeys } from "./motion-runtime.js";
import { getJson, postJson, fetchChatHistory, withProjectScope } from "./api-client.js";
import { formatNumber, pathEquals, pathBaseName, statusClass, translateStage } from "./utils.js";
import { icon } from "./icons.js";
import { createThreadRenderer } from "./thread-renderer.js";
import { createDrawerPanels } from "./drawer-panels.js";
import { createSettingsModal } from "./settings-modal.js";
import { createComposer } from "./composer.js";
import { createProjectScope } from "./project-scope.mjs";
import { deriveWriteReadiness } from "./write-readiness.mjs";
import { deriveProjectIdentity } from "./project-identity.mjs";
import { deriveWorkbenchView, deriveChapterCompletion } from "./workbench-presentation.mjs";
import { loadDefaultTier } from "./permission-defaults.mjs";
import { getTierById } from "./permission-tiers.mjs";

// WWriting · Codex 风格对话式前端
// 后端无消息/SSE 端点，对话流由前端用 /api/dashboard 的 events[] + chapters[] + summary 聚合而成。
const refs = {
  app: document.querySelector("#app"),
  refresh: document.querySelector("#refresh"),
  newNovel: document.querySelector("#new-novel"),
  projectCount: document.querySelector("#project-count"),
  projectFilter: document.querySelector("#project-filter"),
  projectList: document.querySelector("#project-list"),
  projectOpenStatus: document.querySelector("#project-open-status"),
  openFolder: document.querySelector("#open-folder"),
  openSettings: document.querySelector("#open-settings"),
  title: document.querySelector("#project-title"),
  status: document.querySelector("#project-status"),
  topbarSub: document.querySelector("#topbar-sub"),
  topbarProgress: document.querySelector("#topbar-progress"),
  topbarProgressLabel: document.querySelector("#topbar-progress-label"),
  topbarProgressBar: document.querySelector("#topbar-progress-bar"),
  privacyToggle: document.querySelector("#privacy-toggle"),
  privacyLabel: document.querySelector("#privacy-label"),
  themeToggle: document.querySelector("#theme-toggle"),
  themeLabel: document.querySelector("#theme-label"),
  threadWrap: document.querySelector("#thread-wrap"),
  thread: document.querySelector("#thread"),
  composer: document.querySelector("#composer"),
  slashMenu: document.querySelector("#slash-menu"),
  composerInput: document.querySelector("#composer-input"),
  composerHint: document.querySelector("#composer-hint"),
  composerSubmit: document.querySelector("#composer-submit"),
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
  settingsSearch: document.querySelector("#settings-search"),
  settingsProviderList: document.querySelector("#settings-provider-list"),
  settingsAdd: document.querySelector("#settings-add"),
  settingsDetail: document.querySelector("#settings-detail"),
  settingsCancel: document.querySelector("#settings-cancel"),
  settingsSave: document.querySelector("#settings-save"),
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
  cbarKeys: document.querySelector("#cbar-keys"),
  toastStack: document.querySelector("#toast-stack"),
  threadStatus: document.querySelector("#thread-status"),
  topbar: document.querySelector(".topbar"),
  quickRail: document.querySelector("#quick-rail"),
  topbarStop: document.querySelector("#topbar-stop"),
  activityStrip: document.getElementById("activity-strip"),
  projectWorkbench: document.querySelector("#project-workbench"),
  workbenchCover: document.querySelector("#workbench-cover"),
  workbenchMonogram: document.querySelector("#workbench-monogram"),
  workbenchTitle: document.querySelector("#workbench-title"),
  workbenchSeed: document.querySelector("#workbench-seed"),
  workbenchProgress: document.querySelector("#workbench-progress"),
  workbenchProgressLabel: document.querySelector("#workbench-progress-label"),
  workbenchWordCount: document.querySelector("#workbench-word-count"),
  workbenchProgressFill: document.querySelector("#workbench-progress-fill"),
  workbenchStatus: document.querySelector("#workbench-status"),
  workbenchPrimary: document.querySelector("#workbench-primary"),
  workbenchReadLatest: document.querySelector("#workbench-read-latest"),
  workbenchOpenChapters: document.querySelector("#workbench-open-chapters"),
  workbenchActivity: document.querySelector("#workbench-activity"),
  workbenchFoldToggle: document.querySelector("#workbench-fold-toggle"),
  workbenchBody: document.querySelector("#workbench-body"),
  writeReadiness: document.querySelector("#write-readiness"),
  writeReadinessTitle: document.querySelector("#write-readiness-title"),
  writeReadinessDetail: document.querySelector("#write-readiness-detail"),
  writeReadinessMeta: document.querySelector("#write-readiness-meta"),
  writeReadinessPrimary: document.querySelector("#write-readiness-primary"),
  writeReadinessSecondary: document.querySelector("#write-readiness-secondary"),
  writeReadinessTertiary: document.querySelector("#write-readiness-tertiary"),
  writeReadinessFoldToggle: document.querySelector("#write-readiness-fold-toggle"),
  writeReadinessBody: document.querySelector("#write-readiness-body"),
  chapterSuccess: document.querySelector("#chapter-success"),
  chapterSuccessTitle: document.querySelector("#chapter-success-title"),
  chapterSuccessMeta: document.querySelector("#chapter-success-meta"),
  chapterSuccessReview: document.querySelector("#chapter-success-review"),
  chapterSuccessRead: document.querySelector("#chapter-success-read"),
  chapterSuccessContinue: document.querySelector("#chapter-success-continue"),
  chapterSuccessFoldHeader: document.querySelector("#chapter-success-fold"),
  chapterSuccessBody: document.querySelector("#chapter-success-body"),
  chapterSuccessFoldSummary: document.querySelector("#chapter-success-fold-summary"),
};

const desktop = window.wwritingDesktop;
document.documentElement.dataset.desktopShell = desktop?.shell ?? "browser";
document.documentElement.dataset.desktopPlatform = desktop?.platform ?? "browser";

let currentProjectRoot = null;
let dashboardRequestId = 0;
let refreshTimer = null;
let drawerTab = "chapters";
let lastDashboard = null;
// 唯一的 project generation 门禁：旧项目响应到达时不会污染当前 DOM。
const projectScope = createProjectScope();
// 已渲染进对话流的事件指纹，避免轮询重复追加同一条气泡。
const renderedKeys = new Set();
// 本地内存里的旁路问答待确认条目（刷新即丢，与后端 side_questions.md 解耦）。
const askEntries = new Map();
let liveBlock = null;
let lastFocused = null;
let createModalMode = "new";
let previousActivity = null;
let previousBadgeSummary = null;
let readerChapterNo = null;
let readerQuoteBtn = null;
// 已发布给屏幕阅读器（aria-live）的最后一条状态：切换项目时清空。
let lastAnnounce = "";
let lastWriteReadinessView = null;
let lastWorkbenchView = null;
let lastCommittedChapter = null;

// --- extracted module instances (created before event bindings that reference their methods) ---
let composer; // forward ref: thread-renderer's promote button calls composer.promoteAskEntry (assigned in Task 7)
let projectListData = null; // hoisted to top so click handlers never trip TDZ if a probe fires before later declarations run
let archivedExpanded = false;

const threadRenderer = createThreadRenderer({
  refs,
  renderedKeys,
  askEntries,
  getLiveBlock: () => liveBlock,
  setLiveBlock: (block) => { liveBlock = block; },
  getCurrentProjectRoot: () => currentProjectRoot,
  getDashboard: () => lastDashboard,
  loadDashboard,
  handleRetry,
  handleStop,
  handleQuick,
  openReader,
  showToast,
  showActionError,
  announce,
  openDrawer,
  openSettingsModal: (...args) => settingsModal.openSettingsModal(...args),
  prefillComposer: (text) => {
    refs.composerInput.value = text;
    refs.composerInput.focus();
    composer.autoGrowComposer();
    composer.updateSubmitState();
  },
  promoteAskEntry: (entry) => composer.promoteAskEntry(entry),
  submitText: (text) => composer.submitText(text),
  isChatBusy: () => composer?.isChatBusy?.() === true,
});

const settingsModal = createSettingsModal({
  refs,
  getDashboard: () => lastDashboard,
  getCurrentProjectRoot: () => currentProjectRoot,
  showToast,
  loadDashboard,
  getLastFocused: () => lastFocused,
  setLastFocused: (el) => { lastFocused = el; },
});
const { openSettingsModal, closeSettingsModal, renderSettingsProviders, renderSettingsDetail, saveSettings } = settingsModal;

const { renderDrawerBody } = createDrawerPanels({
  refs,
  getDrawerTab: () => drawerTab,
  getDashboard: () => lastDashboard,
  loadDashboard,
  openReader,
  openSettingsModal,
  showToast,
  showActionError,
  closeDrawer,
  sendChatMessageWithUX: (msg) => composer?.sendChatMessageWithUX?.(msg),
});

composer = createComposer({
  refs,
  getCurrentProjectRoot: () => currentProjectRoot,
  getDashboard: () => lastDashboard,
  loadDashboard,
  openCreateModal,
  openSettingsModal,
  openDrawer,
  showToast,
  showActionError,
  ensureRefreshLoop,
  threadRenderer,
  getAskEntries: () => askEntries,
  projectScope,
});
const { submitComposer, autoGrowComposer, updateSlashMenu, onComposerKeydown, updateSubmitState, promoteAskEntry, persistDraft, flushDraft, restoreDraftIfAny, resetComposerInputUi } = composer;

function openDrawer(tab) {
  if (tab) drawerTab = tab;
  setDrawerTabActive();
  lastFocused = document.activeElement;
  refs.drawer.removeAttribute("inert");
  refs.drawer.classList.add("show");
  refs.drawer.setAttribute("aria-hidden", "false");
  refs.drawerScrim.classList.add("show");
  refs.drawerClose.focus();
  renderDrawerBody();
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
  refs.drawer.dataset.closing = "true";
  refs.drawerScrim.dataset.closing = "true";
  motion.closeDrawer(refs.drawer, refs.drawerScrim, {
    onComplete: () => {
      delete refs.drawer.dataset.closing;
      delete refs.drawerScrim.dataset.closing;
      if (lastFocused && lastFocused.isConnected) lastFocused.focus();
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
  }
}

// ---------- 事件绑定 ----------
refs.refresh.addEventListener("click", () => loadAll());
refs.newNovel.addEventListener("click", () => openCreateModal());
refs.openFolder.addEventListener("click", () => openFromFolder());
refs.openSettings.addEventListener("click", () => openSettingsModal());
refs.projectFilter?.addEventListener("input", () => renderProjectListFiltered());
refs.drawerClose.addEventListener("click", () => closeDrawer());
refs.drawerScrim.addEventListener("click", () => closeDrawer());
refs.drawerTabs.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-dtab]");
  if (tab) setDrawerTab(tab.dataset.dtab);
});

refs.composerSubmit.addEventListener("click", () => submitComposer());
refs.composerInput.addEventListener("keydown", onComposerKeydown);
refs.composerInput.addEventListener("input", () => {
  autoGrowComposer();
  updateSubmitState();
  updateSlashMenu();
  persistDraft();
});
window.addEventListener("pagehide", flushDraft);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushDraft();
});
setTimeout(() => composer.initModePill(), 0);

refs.readerClose.addEventListener("click", closeReader);
refs.readerScrim.addEventListener("click", (event) => {
  if (event.target === refs.readerScrim) closeReader();
});

function removeReaderQuoteBtn() {
  readerQuoteBtn?.remove();
  readerQuoteBtn = null;
}

refs.readerBody.addEventListener("mouseup", () => {
  removeReaderQuoteBtn();
  const selection = window.getSelection();
  const text = String(selection?.toString() ?? "").trim();
  if (!text || !refs.readerScrim.classList.contains("show")) return;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  readerQuoteBtn = document.createElement("button");
  readerQuoteBtn.type = "button";
  readerQuoteBtn.id = "reader-quote-btn";
  readerQuoteBtn.textContent = "问智能体";
  readerQuoteBtn.style.left = `${Math.round(rect.left + rect.width / 2)}px`;
  readerQuoteBtn.style.top = `${Math.round(rect.bottom + 8)}px`;
  readerQuoteBtn.addEventListener("click", () => {
    const snippet = text.slice(0, 500);
    const chapter = readerChapterNo;
    closeReader();
    refs.composerInput.value = `关于第 ${chapter} 章这段：\n> ${snippet}\n`;
    refs.composerInput.focus();
    composer.autoGrowComposer();
    composer.updateSubmitState();
  });
  document.body.append(readerQuoteBtn);
});
refs.readerBody.addEventListener("scroll", removeReaderQuoteBtn);
refs.settingsX.addEventListener("click", closeSettingsModal);
refs.settingsCancel.addEventListener("click", closeSettingsModal);
refs.settingsScrim.addEventListener("click", (event) => {
  if (event.target === refs.settingsScrim) closeSettingsModal();
});
refs.settingsSave.addEventListener("click", () => saveSettings());
refs.settingsSearch.addEventListener("input", () => renderSettingsProviders());
refs.settingsAdd.addEventListener("click", () => settingsModal.resetToCustom());
refs.createX.addEventListener("click", closeCreateModal);
// 新建弹窗：只通过右上角 X 或 Esc 关闭，避免点击遮罩误触丢失已填内容。
refs.createBrowse.addEventListener("click", () => browseForCreatePath());
refs.createSubmit.addEventListener("click", () => initProject(refs.createPath.value.trim()));

refs.cbarKeys.addEventListener("click", () => openShortcuts());
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
    if (refs.shortcutsScrim.classList.contains("show")) return closeShortcuts();
    if (refs.readerScrim.classList.contains("show")) return closeReader();
    if (refs.settingsScrim.classList.contains("show")) return closeSettingsModal();
    if (refs.createScrim.classList.contains("show")) return closeCreateModal();
    if (refs.drawer.classList.contains("show")) return closeDrawer();
  }
  if (event.key === "?" && !isEditableTarget(event.target)) {
    event.preventDefault();
    openShortcuts();
  }
  if (refs.shortcutsScrim.classList.contains("show")) trapTab(refs.shortcutsScrim, event);
  else if (refs.readerScrim.classList.contains("show")) trapTab(refs.readerScrim, event);
  else if (refs.settingsScrim.classList.contains("show")) trapTab(refs.settingsScrim, event);
  else if (refs.createScrim.classList.contains("show")) trapTab(refs.createScrim, event);
  else if (refs.drawer.classList.contains("show")) trapTab(refs.drawer, event);
});
window.addEventListener("blur", () => { refs.app.dataset.away = "true"; });
window.addEventListener("focus", () => { refs.app.dataset.away = "false"; });
refs.privacyToggle.addEventListener("click", () => setPrivacyMode(refs.app.dataset.privacy !== "on"));

// Writing readiness buttons
if (refs.writeReadinessPrimary) {
  refs.writeReadinessPrimary.addEventListener("click", () => {
    if (lastWriteReadinessView) handleReadinessAction(lastWriteReadinessView);
  });
}
if (refs.writeReadinessSecondary) {
  refs.writeReadinessSecondary.addEventListener("click", () => openFromFolder());
}
if (refs.workbenchPrimary) {
  refs.workbenchPrimary.addEventListener("click", () => {
    if (lastWorkbenchView) handleReadinessAction(lastWorkbenchView.readiness);
  });
}
if (refs.workbenchReadLatest) {
  refs.workbenchReadLatest.addEventListener("click", () => {
    if (lastWorkbenchView?.latestChapter?.canOpen) {
      openReader(lastWorkbenchView.latestChapter.chapterNo);
    }
  });
}
if (refs.workbenchOpenChapters) {
  refs.workbenchOpenChapters.addEventListener("click", () => openDrawerTab("chapters"));
}

// Chapter success buttons
if (refs.chapterSuccessRead) {
  refs.chapterSuccessRead.addEventListener("click", () => {
    if (lastCommittedChapter) openReader(lastCommittedChapter.chapter_no);
  });
}
if (refs.chapterSuccessContinue) {
  refs.chapterSuccessContinue.addEventListener("click", () => {
    void composer.startCurrentChapter();
  });
}

// Initialize chapter-success fold
(function initChapterSuccessFold() {
  const header = refs.chapterSuccessFoldHeader;
  const body = refs.chapterSuccessBody;
  if (!header || !body) return;
  const foldKey = "wwriting.card.fold.chapter-success";
  const val = localStorage.getItem(foldKey);
  const folded = val === null ? false : val === "true"; // completed → folded by default
  body.hidden = folded;
  header.classList.toggle("folded", folded);
  header.addEventListener("click", () => {
    const nowFolded = !body.hidden;
    body.hidden = nowFolded;
    header.classList.toggle("folded", nowFolded);
    localStorage.setItem(foldKey, String(nowFolded));
  });
})();

// 可折叠主卡片：标题行常驻，body 用 grid-template-rows 平滑动画。
// 默认展开；折叠状态存 localStorage，刷新后保持。
function initCardFold({ toggle, body, foldKey, defaultFolded = false, root = null }) {
  if (!toggle || !body) return;
  const val = localStorage.getItem(foldKey);
  const folded = val === null ? defaultFolded : val === "true";
  toggle.classList.toggle("folded", folded);
  body.classList.toggle("folded", folded);
  root?.classList.toggle("folded", folded);
  toggle.setAttribute("aria-expanded", String(!folded));
  toggle.addEventListener("click", () => {
    const nowFolded = !toggle.classList.contains("folded");
    toggle.classList.toggle("folded", nowFolded);
    body.classList.toggle("folded", nowFolded);
    root?.classList.toggle("folded", nowFolded);
    toggle.setAttribute("aria-expanded", String(!nowFolded));
    localStorage.setItem(foldKey, String(nowFolded));
  });
}

initCardFold({
  toggle: refs.workbenchFoldToggle,
  body: refs.workbenchBody,
  root: refs.projectWorkbench,
  foldKey: "wwriting.card.fold.project-workbench",
});
initCardFold({
  toggle: refs.writeReadinessFoldToggle,
  body: refs.writeReadinessBody,
  foldKey: "wwriting.card.fold.write-readiness",
});

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

function renderProjectListFiltered() {
  if (!projectListData) return;
  const query = (refs.projectFilter?.value ?? "").trim().toLowerCase();
  const filtered = query
    ? projectListData.projects.filter((project) =>
        [project.title, project.story_seed, project.model_label].some((text) =>
          String(text ?? "").toLowerCase().includes(query)
        )
      )
    : projectListData.projects;
  const active = filtered.filter((p) => !p.archived_at);
  const archived = filtered.filter((p) => p.archived_at);
  refs.projectCount.textContent = formatNumber(filtered.length);
  const parts = [];
  if (active.length > 0) {
    parts.push(...active.map((project) => renderProjectNav(project, projectListData.selectedProjectRoot)));
  }
  if (archived.length > 0) {
    const toggle = document.createElement("div");
    toggle.className = "rail-group-label rail-archived-toggle";
    toggle.setAttribute("role", "button");
    toggle.setAttribute("tabindex", "0");
    const labelSpan = document.createElement("span");
    labelSpan.textContent = "已归档";
    const countSpan = document.createElement("span");
    countSpan.className = "count";
    countSpan.textContent = String(archived.length);
    toggle.append(labelSpan, countSpan);
    const toggleArchived = () => { archivedExpanded = !archivedExpanded; renderProjectListFiltered(); };
    toggle.addEventListener("click", toggleArchived);
    toggle.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleArchived(); } });
    parts.push(toggle);
    if (archivedExpanded) {
      parts.push(...archived.map((project) => {
        const row = renderProjectNav(project, projectListData.selectedProjectRoot);
        row.classList.add("proj-archived");
        // prepend archive emoji to title
        const titleEl = row.querySelector(".proj-title");
        if (titleEl && !titleEl.textContent.startsWith("\u{1F4E6}")) {
          titleEl.textContent = "\u{1F4E6} " + titleEl.textContent;
        }
        return row;
      }));
    }
  }
  refs.projectList.replaceChildren(
    ...(parts.length > 0
      ? parts
      : [renderProjectEmpty(query ? "没有匹配的小说。" : "还没有小说，点上方「新建小说」开始")])
  );
}

async function loadDashboard(options = {}) {
  const requestId = ++dashboardRequestId;
  const activeProjectRoot = currentProjectRoot;
  let token = projectScope.capture(activeProjectRoot);
  if (options.silent !== true) {
    setStatus("loading");
  }
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
    if (data.hasProject) {
      const queueUrl = withProjectScope("/api/queue/state", activeProjectRoot);
      const [queue, chatHistory] = await Promise.all([
        getJson(queueUrl).catch(() => ({ ok: false, tasks: [] })),
        fetchChatHistory({ projectRoot: activeProjectRoot }).catch(() => null)
      ]);
      data.queue = queue;
      data.chatHistory = chatHistory;
      if (requestId !== dashboardRequestId) return;
      if (!projectScope.isCurrent(token)) return;
    }
    renderDashboard(data);
  } catch (error) {
    if (requestId !== dashboardRequestId) return;
    if (!projectScope.isCurrent(token)) return;
    renderError(error);
  }
}

// Switch Cleanup Matrix：每次切换项目/无项目时重置所有项目级临时 UI 状态。
// 旧项目的渲染、toast、对话流不能混入新项目的首屏。
function clearTransientState() {
  // 任何在途请求的 token 都会因 generation 自增而失效。
  dashboardRequestId += 1;
  // 对话流指纹与旁路问答是项目级内存缓存。
  renderedKeys.clear();
  askEntries.clear();
  liveBlock = null;
  lastAnnounce = "";
  // 顶部活动状态：renderer / motion 会在下次 renderDashboard 重画。
  previousActivity = null;
  previousBadgeSummary = null;
  if (refs.thread) refs.thread.replaceChildren();
  if (refs.threadStatus) refs.threadStatus.textContent = "";
  if (refs.toastStack) {
    for (const toast of [...refs.toastStack.children]) toast.remove();
  }
  if (refs.readerScrim?.classList.contains("show")) {
    refs.readerScrim.classList.remove("show");
    refs.readerScrim.setAttribute("inert", "");
  }
  readerChapterNo = null;
  if (refs.composerInput && "value" in refs.composerInput) resetComposerInputUi();
  if (refs.composerInput?.dataset) {
    delete refs.composerInput.dataset.error;
  }
}

// 在每次成功的项目选择（open / init / forget / no-project 兜底）后，
// 都提升 generation + 清空临时状态，确保任何旧项目的延迟响应被丢弃。
// 同步把 currentProjectRoot 指向新根，避免后续 loadDashboard 捕获到旧值。
function commitProjectSwitch(projectRoot) {
  // 切走前：把当前输入框内容存到旧项目草稿（currentProjectRoot 仍指向旧值）。
  flushDraft();
  projectScope.activate(projectRoot);
  currentProjectRoot = projectRoot;
  clearTransientState();
  // 切到新项目后：从新项目草稿恢复输入框。
  restoreDraftIfAny(currentProjectRoot);
}

function renderProjectNav(project, selectedProjectRoot) {
  const row = document.createElement("div");
  row.className = `proj-row${pathEquals(project.projectRoot, selectedProjectRoot) ? " active" : ""}`;
  const button = document.createElement("button");
  button.type = "button";
  button.className = `proj${pathEquals(project.projectRoot, selectedProjectRoot) ? " active" : ""}`;
  const identity = deriveProjectIdentity({ project, projectRoot: project.projectRoot });
  const cover = document.createElement("span");
  cover.className = "proj-cover";
  cover.dataset.projectTheme = identity.theme;
  cover.setAttribute("aria-hidden", "true");
  cover.textContent = identity.monogram;
  button.addEventListener("click", () => openProject(project.projectRoot));
  const dot = document.createElement("span");
  dot.className = "proj-dot";
  const main = document.createElement("span");
  main.className = "proj-main";
  const title = document.createElement("span");
  title.className = "proj-title";
  title.textContent = project.title ?? "未命名小说";
  const sub = document.createElement("span");
  sub.className = "proj-sub";
  sub.textContent = project.model_label ?? project.story_seed ?? project.projectRoot;
  main.append(title, sub);
  button.append(cover, dot, main);
  const menu = document.createElement("div");
  menu.className = "proj-menu";
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
  menu.append(remove);
  row.append(button, menu);
  return row;
}

function renderProjectEmpty(text) {
  const empty = document.createElement("div");
  empty.className = "proj-empty";
  empty.textContent = text;
  return empty;
}

function handleReadinessAction(view) {
  const action = view.primaryAction;
  switch (action) {
    case "create_project":
      openCreateModal();
      break;
    case "open_project":
      openFromFolder();
      break;
    case "open_settings":
    case "test_connection":
    case "increase_target":
      openSettingsModal();
      break;
    case "start_chapter":
      void composer.startCurrentChapter();
      break;
    case "view_progress":
    case "view_project_status":
      openDrawerTab("run");
      break;
    case "view_issue":
      openDrawerTab("run");
      break;
    default:
      break;
  }
}

function workbenchStatusText(view) {
  const key = view.readiness.key;
  if (key === "running") return "故事正在落笔";
  if (key === "blocked") return "故事线需要你的判断";
  if (key === "completed") return "本轮章节目标已完成";
  if (key === "project_read_only") return "这部作品当前以只读方式打开";
  if (key === "missing_model" || key === "invalid_model") return "完成模型准备后即可继续";
  return `下一步：第 ${view.readiness.chapterNo} 章`;
}

function renderWorkbenchActivity(entries) {
  if (!refs.workbenchActivity) return;
  const rows = entries.map((entry) => {
    const row = document.createElement("div");
    row.className = `workbench-activity-row tone-${entry.tone}`;
    row.dataset.activityKey = entry.key;
    const dot = document.createElement("span");
    dot.className = "workbench-activity-dot";
    dot.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "workbench-activity-label";
    label.textContent = entry.label;
    row.append(dot, label);
    return row;
  });
  refs.workbenchActivity.replaceChildren(...rows);
  refs.workbenchActivity.hidden = rows.length === 0;
}

function renderProjectWorkbench(data) {
  const view = deriveWorkbenchView(data);
  lastWorkbenchView = view.visible ? view : null;
  if (!refs.projectWorkbench) return;
  refs.projectWorkbench.hidden = !view.visible;
  if (!view.visible) return;

  const identity = view.identity;
  refs.projectWorkbench.dataset.projectTheme = identity.theme;
  refs.workbenchCover.dataset.projectTheme = identity.theme;
  refs.workbenchCover.setAttribute("aria-label", identity.ariaLabel);
  refs.workbenchMonogram.textContent = identity.monogram;
  refs.workbenchTitle.textContent = view.title;
  refs.workbenchSeed.textContent = view.storySeed || "这部小说还没有故事种子。";
  refs.workbenchProgress.setAttribute("aria-valuenow", String(view.progress.percent));
  refs.workbenchProgress.setAttribute("aria-valuetext", `${view.progress.completed} / ${view.progress.target} 章`);
  refs.workbenchProgressLabel.textContent = `${view.progress.completed} / ${view.progress.target} 章`;
  refs.workbenchWordCount.textContent = `${formatNumber(view.progress.totalWords)} 字`;
  refs.workbenchProgressFill.style.width = `${view.progress.percent}%`;
  refs.workbenchStatus.textContent = workbenchStatusText(view);
  refs.workbenchPrimary.textContent = view.readiness.primaryLabel;
  refs.workbenchPrimary.disabled = view.readiness.key === "running";

  refs.workbenchReadLatest.hidden = !view.latestChapter?.canOpen;
  if (view.latestChapter?.canOpen) {
    refs.workbenchReadLatest.textContent = `阅读第 ${view.latestChapter.chapterNo} 章`;
  }
  renderWorkbenchActivity(view.activity);
}

function renderWriteReadiness(data) {
  const view = deriveWriteReadiness(data);
  lastWriteReadinessView = view;
  const section = refs.writeReadiness;
  if (!section) return;
  const isNoProject = view.key === "no_project";
  const hasCommittedChapter = data?.chapters?.some(
    (chapter) => chapter.artifact?.state === "committed"
  ) === true;
  const show = isNoProject || (
    data?.hasProject
    && view.key !== "running"
    && !hasCommittedChapter
  );
  section.hidden = !show;
  if (!show) return;
  refs.writeReadinessTitle.textContent = view.label;
  refs.writeReadinessDetail.textContent = view.detail;
  if (refs.writeReadinessMeta) {
    const parts = [];
    if (view.modelLabel) parts.push(view.modelLabel);
    if (view.chapterNo && !isNoProject) parts.push(`第 ${view.chapterNo} 章`);
    refs.writeReadinessMeta.textContent = parts.join(" · ");
  }
  refs.writeReadinessPrimary.textContent = view.primaryLabel;
  if (isNoProject) {
    refs.writeReadinessSecondary.hidden = false;
    refs.writeReadinessSecondary.textContent = "打开本地文件夹";
  } else {
    refs.writeReadinessSecondary.hidden = true;
  }
  refs.writeReadinessTertiary.hidden = true;
}

function renderChapterSuccess(data) {
  const section = refs.chapterSuccess;
  if (!section) return;
  const completion = deriveChapterCompletion(data);
  if (!completion) {
    section.hidden = true;
    lastCommittedChapter = null;
    return;
  }

  lastCommittedChapter = { chapter_no: completion.chapterNo };
  section.hidden = false;
  refs.chapterSuccessTitle.textContent = `第 ${completion.chapterNo} 章已完成 · ${completion.title}`;
  refs.chapterSuccessMeta.textContent = `${formatNumber(completion.words)} 字 · ${completion.format} · 已保存到本地`;
  refs.chapterSuccessReview.textContent = completion.reviewLabel;
  refs.chapterSuccessContinue.hidden = !completion.continueVisible;
  if (completion.continueVisible) {
    refs.chapterSuccessContinue.textContent = `继续写第 ${completion.nextChapterNo} 章`;
  }
  if (refs.chapterSuccessFoldSummary) {
    refs.chapterSuccessFoldSummary.textContent = `第 ${completion.chapterNo} 章已完成 · ${formatNumber(completion.words)} 字`;
  }
}

function renderDashboard(data) {
  lastDashboard = data;
  if (!data.hasProject) {
    currentProjectRoot = null;
    previousActivity = null;
    previousBadgeSummary = null;
    refs.title.textContent = "开始创作";
    refs.topbarSub.textContent = "新建或打开一部小说，开始你的创作。";
    setStatus("idle");
    ensureRefreshLoop(false);
    threadRenderer.renderEmptyThread();
    composer.updateModePill();
    composer.updateStatusPills(data);
    composer.syncChatBusy(data);
    renderProjectWorkbench(data);
    renderWriteReadiness(data);
    refreshDrawerIfOpen();
    return;
  }

  const firstLoad = currentProjectRoot !== data.projectRoot;
  if (firstLoad) {
    // 切换/首次打开项目：重置对话流，按事件重建历史。
    renderedKeys.clear();
    askEntries.clear();
    liveBlock = null;
    refs.thread.replaceChildren();
  }
  currentProjectRoot = data.projectRoot;
  if (firstLoad) {
    restoreDraftIfAny(currentProjectRoot, { focus: true });
  }

  const summary = data.summary;
  const project = data.project;
  const modelProfile = data.model_profile ?? {};
  refs.title.textContent = project.title ?? "未命名小说";
  const progressCopy = `已写 ${summary.completedChapters}/${summary.targetChapters} 章`;
  refs.topbarSub.textContent = modelProfile.is_mock
    ? `模型未配置 · 请在设置里选一个 · ${progressCopy}`
    : progressCopy;

  // 归档态 UI
  const isArchived = Boolean(project.archived_at);
  refs.composerInput.placeholder = isArchived
    ? "项目已归档（只读）。对话查询可用；解除归档后才能修改。"
    : "跟我说：开始写作、写下一章、调整方向…  输入 / 唤起命令";

  const truth = computeAgentTruth(data);
  renderTruthIndicator(truth);
  // 归档态覆盖 status pill
  if (isArchived) {
    refs.status.className = "pill ghost";
    const adot = document.createElement("span");
    adot.className = "pdot";
    refs.status.replaceChildren(adot, document.createTextNode("已归档"));
    if (refs.topbar) refs.topbar.classList.remove("is-busy");
  }
  renderTopbarProgress(truth, Number(data.summary?.activityProgressPercent ?? 0));
  ensureRefreshLoop(
    truth.refresh
    || summary.projectStatus === "running"
    || Boolean(liveBlock && !liveBlock.done)
    || data.chatHistory?.busy === true
  );

  renderProjectWorkbench(data);
  renderRecoveryBanner(data);
  threadRenderer.syncThread(data, firstLoad);
  threadRenderer.syncFailureCards(data);

  // 同步 chat 对话历史（含 pendingAction 确认卡片）
  if (data.chatHistory && data.chatHistory.ok !== false) {
    threadRenderer.syncChatThread(data.chatHistory);
  }
  // S4 Task 11: 空状态建议卡（有项目但无聊天消息时显示）
  if (firstLoad && (data.chatHistory?.messages?.length ?? 0) === 0) {
    threadRenderer.appendSuggestionCards(data);
  }

  if (refs.activityStrip) {
    const activity = deriveActivity(data);
    renderActivityStrip(refs.activityStrip, activity, {
      privacy: refs.privacyToggle?.checked,
      onClickCost: () => openDrawerTab('cost'),
      onClickChapter: () => openDrawerTab('chapters')
    });
    motion.updateActivityStrip(refs.activityStrip, previousActivity, activity);
    previousActivity = activity;
  }

  if (refs.quickRail) {
    const lastSeen = {
      research: getLastSeen(currentProjectRoot, 'research'),
      reviewer: getLastSeen(currentProjectRoot, 'reviewer')
    };
    const badges = deriveBadges(data, currentProjectRoot, lastSeen);
    const nextBadgeSummary = summarizeBadgesForMotion(badges);
    const changedBadgeKeys = diffBadgeKeys(previousBadgeSummary, nextBadgeSummary);
    renderQuickRail(refs.quickRail, badges, { onOpenTab: openDrawerTab, projectRoot: currentProjectRoot });
    for (const key of changedBadgeKeys) {
      motion.bumpQuickRailBadge(refs.quickRail.querySelector(`[data-key="${key}"]`));
    }
    previousBadgeSummary = nextBadgeSummary;
  }

  composer.updateModePill();
  composer.updateStatusPills(data);
  composer.syncChatBusy(data);
  renderWriteReadiness(data);
  renderChapterSuccess(data);
  refreshDrawerIfOpen();
}

// §4.1: 启动恢复横幅 — 上次崩溃/断电残留检测标记在 recovery_pending 中。
function renderRecoveryBanner(data) {
  if (!data.recovery_pending || !refs.thread) return;
  if (refs.thread.querySelector(".recovery-startup-banner")) return;
  const banner = document.createElement("div");
  banner.className = "recovery-startup-banner";
  const iconSpan = document.createElement("span");
  iconSpan.className = "recovery-banner-icon";
  iconSpan.append(icon("bolt", 16));
  const text = document.createElement("div");
  text.className = "recovery-banner-text";
  const strong = document.createElement("strong");
  strong.textContent = "上次写作被中断";
  const desc = document.createElement("span");
  const chapterNo = data.summary?.currentChapterNo ?? "-";
  const stage = data.summary?.currentStage ?? "-";
  const stageLabel = translateStage(stage);
  desc.textContent = stageLabel && stageLabel !== "-"
    ? `从第 ${chapterNo} 章 · ${stageLabel} 继续？`
    : `从第 ${chapterNo} 章继续写作？`;
  text.append(strong, desc);
  const actions = document.createElement("div");
  actions.className = "recovery-banner-actions";
  const retryBtn = document.createElement("button");
  retryBtn.className = "small-button";
  retryBtn.textContent = "继续写作";
  retryBtn.addEventListener("click", () => handleRetry());
  const statusBtn = document.createElement("button");
  statusBtn.className = "small-button";
  statusBtn.textContent = "查看状态";
  statusBtn.addEventListener("click", () => openDrawerTab("run"));
  actions.append(retryBtn, statusBtn);
  banner.append(iconSpan, text, actions);
  refs.thread.prepend(banner);
}

// 抽屉打开时重渲并保留滚动位置；renderDashboard 在 hasProject 和 noProject 两条分支都需要。
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
  setStatus("blocked");
  ensureRefreshLoop(true);
}

function handleQuick(label) {
  if (label === "新建小说") return openCreateModal();
  if (label.includes("查看") && label.includes("正文")) {
    if (liveBlock?.chapter) return openReader(liveBlock.chapter);
    const last = [...(lastDashboard?.chapters ?? [])].reverse().find((c) => (c.actual_words ?? 0) > 0);
    if (last) return openReader(last.chapter_no);
    return showToast("还没有可阅读的章节。", "info");
  }
  if (label.includes("运行面板")) return openDrawer("run");
  // 其余快捷项作为指令直接发送。
  refs.composerInput.value = label;
  void submitComposer();
}

async function forgetProject(projectRoot) {
  if (!projectRoot) return;
  try {
    const result = await postJson("/api/projects/forget", { projectRoot });
    showToast("已从列表移除。", "success");
    // 切换/取消选择：commitProjectSwitch 已经处理 generation + currentProjectRoot + 清空。
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
    // 切换项目：提升 generation、清空临时状态；让 loadDashboard 决定 currentProjectRoot。
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
    // 切换项目：提升 generation、清空临时状态。
    commitProjectSwitch(projectRoot);
    closeCreateModal();
    resetCreateForm();
    showToast("小说已创建并打开。", "success");
    // 套用上次的权限模式（含 YOLO）—— 在 loadAll 前做，mode pill 首次渲染即反映。
    await applyDefaultTierForNewProject(projectRoot);
    await loadAll();
  } catch (error) {
    setCreateStatus(error.message, "error");
    showToast(error.message, "error");
  } finally {
    setCreateSubmitLoading(false);
  }
}

// 新建项目后套用全局记住的权限档位；默认档（confirm）无需套用。
// 套用失败不阻塞创建流程，用户可在命令栏手动切换。
async function applyDefaultTierForNewProject(projectRoot) {
  const tierId = loadDefaultTier();
  if (!tierId || tierId === "confirm") return;
  const tier = getTierById(tierId);
  if (!tier) return;
  try {
    await postJson("/api/settings/update", {
      projectRoot,
      tool_permissions: tier.combo
    });
  } catch {
    // 套用失败不阻塞
  }
}

function setStatus(status, stage = null) {
  const phase = agentPhaseLabel(status, stage);
  refs.status.className = `pill ${statusClass(status)}`;
  refs.status.replaceChildren();
  const dot = document.createElement("span");
  dot.className = "pdot";
  refs.status.append(dot, document.createTextNode(phase));
  if (refs.topbar) refs.topbar.classList.toggle("is-busy", status === "running" || status === "loading");
}

globalThis.__WWritingTest = { ...(globalThis.__WWritingTest ?? {}), computeAgentTruth };

function renderTruthIndicator(truth) {
  refs.status.className = `pill ${truth.className}`;
  const dot = document.createElement("span");
  dot.className = "pdot";
  refs.status.replaceChildren(dot, document.createTextNode(truth.display));
  refs.status.title = truth.reason ?? "";
  if (refs.topbar) refs.topbar.classList.toggle("is-busy", truth.className === "running" || truth.className === "cancelling");
  renderTopbarAction(refs.topbarStop, "停止", false, handleStop, truth.reason);
}

function renderTopbarAction(button, label, visible, handler, title = "") {
  if (!button) return;
  if (button.dataset.bound !== "true") {
    button.addEventListener("click", () => handler());
    button.dataset.bound = "true";
  }
  button.textContent = label;
  button.title = title ?? "";
  button.hidden = !visible;
}

function renderTopbarProgress(truth, pct) {
  if (!refs.topbarProgress || !refs.topbarProgressBar) return;
  if (pct > 0 && ["running", "slow", "stale"].includes(truth.className)) {
    refs.topbarProgress.hidden = false;
    refs.topbarProgressBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    refs.topbarProgress.setAttribute("aria-valuenow", String(Math.round(pct)));
    refs.topbarProgressLabel.textContent = `本章流程 ${Math.round(pct)}%`;
  } else {
    refs.topbarProgress.hidden = true;
  }
}

async function handleRetry(taskId = null) {
  const resolvedTaskId = taskId ?? lastDashboard?.retry_task_id ?? null;
  try {
    const result = await postJson("/api/run/retry", resolvedTaskId ? { taskId: resolvedTaskId } : {});
    showToast(result.message ?? "已从中断处继续。", "success");
    ensureRefreshLoop(true);
    await loadDashboard();
  } catch (error) {
    showToast(error.message, "error");
    await loadDashboard();
  }
}

async function handleStop() {
  if (refs.topbarStop) refs.topbarStop.disabled = true;
  try {
    const result = await postJson("/api/run/stop", {});
    showToast(result.message ?? "已请求停止。", "success");
    ensureRefreshLoop(true);
    await loadDashboard();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    if (refs.topbarStop) refs.topbarStop.disabled = false;
  }
}


function setCreateStatus(text, kind) {
  refs.createStatus.textContent = text;
  refs.createStatus.className = `create-status${kind ? ` ${kind}` : ""}`;
}

// 阅读器字号四档（行高随档位），持久化 localStorage。
const READER_FONT_STEPS = [
  { size: 14, lh: 1.9 },
  { size: 15.5, lh: 1.95 },
  { size: 17, lh: 2.0 },
  { size: 19, lh: 2.0 }
];
let readerFontIndex = 1;
try {
  const stored = Number(window.localStorage.getItem("ww:reader:fontsize"));
  if (Number.isInteger(stored) && stored >= 0 && stored < READER_FONT_STEPS.length) readerFontIndex = stored;
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
  readerChapterNo = chapterNo;
  refs.readerTitle.textContent = `第 ${chapterNo} 章`;
  refs.readerMeta.textContent = "正在读取本章正文...";
  refs.readerBody.replaceChildren(readerEmpty("读取中..."));
  openOverlay(refs.readerScrim, refs.readerClose);
  applyReaderFont();
  updateReaderNav();
  try {
    const data = await getJson(`/api/chapters/read?chapter=${encodeURIComponent(chapterNo)}`);
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
  removeReaderQuoteBtn();
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
  // 未手动选过时跟随系统偏好
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
    // 首次开启才弹说明；按钮态与模糊效果本身即时可见。
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

function ensureRefreshLoop(active) {
  if (active && !refreshTimer) {
    refreshTimer = window.setInterval(() => void loadDashboard({ silent: true }), 1800);
    return;
  }
  if (!active && refreshTimer) {
    window.clearInterval(refreshTimer);
    refreshTimer = null;
  }
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
  toast.append(icon(type === "error" ? "help" : "check", 15));
  toast.append(document.createTextNode(message));
  refs.toastStack.append(toast);
  const remove = () => {
    toast.classList.add("leaving");
    window.setTimeout(() => toast.remove(), 220);
  };
  window.setTimeout(remove, type === "error" ? 5200 : 3200);
}

// lastAnnounce 已在文件顶部声明；切换项目时由 clearTransientState 清空。
function announce(msg) {
  if (refs.threadStatus && msg && msg !== lastAnnounce) {
    lastAnnounce = msg;
    refs.threadStatus.textContent = msg;
  }
}


// 模块体执行完毕（所有 const/let 已离开 TDZ）后再启动；防止首屏渲染触达后置声明导致静默 ReferenceError。
initThemeMode();
initPrivacyMode();
autoGrowComposer();
updateSubmitState();

// Quick Rail 初始化
if (refs.quickRail) {
  bindQuickRailKeys(refs.quickRail, openDrawerTab);
  watchLastSeen(() => { if (lastDashboard) renderDashboard(lastDashboard); });
}

// 窄屏折叠逻辑：<1100px 隐藏 Quick Rail，显示折叠按钮
function updateQuickRailLayout() {
  const narrow = window.innerWidth < 1100;
  if (refs.quickRail) refs.quickRail.hidden = narrow;
  const collapsed = document.getElementById('qr-collapsed');
  if (collapsed) collapsed.hidden = !narrow;
}
window.addEventListener('resize', updateQuickRailLayout);
updateQuickRailLayout();

document.getElementById('qr-collapsed')?.addEventListener('click', () => {
  openDrawerTab('chapters');
});

motion.setupMotion();
window.__wwritingMotionReady = true;

await loadAll();
