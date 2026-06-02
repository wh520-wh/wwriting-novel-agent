import { computeAgentTruth, deriveFailures, deriveActivity, deriveBadges } from "./agent-truth.mjs";
import { renderFailureCard } from "./components/failure-card.js";
import { renderActivityStrip } from "./components/activity-strip.js";
import { renderQuickRail, bindQuickRailKeys } from "./components/quick-rail.js";
import { getLastSeen, watchLastSeen } from "./components/last-seen.js";
import { motion, summarizeBadgesForMotion, diffBadgeKeys } from "./motion-runtime.js";
import { getJson, postJson } from "./api-client.js";
import {
  compactObject, formatNumber, formatCompact, formatMoney, formatTime,
  statusClass, pathEquals, pathBaseName, resolveModelEndpoint, ensureTrailingSlash,
  isEnvironmentVariableName, cssEscape, translateStage, translateReviewStatus,
  translateSkillType, translateSourceKind, translateEventType
} from "./utils.js";
import { icon } from "./icons.js";
import { createThreadRenderer } from "./thread-renderer.js";
import { createDrawerPanels } from "./drawer-panels.js";
import { createSettingsModal } from "./settings-modal.js";
import { createComposer } from "./composer.js";

// WWriting · Codex 风格对话式前端
// 后端无消息/SSE 端点，对话流由前端用 /api/dashboard 的 events[] + chapters[] + summary 聚合而成。
const refs = {
  app: document.querySelector("#app"),
  refresh: document.querySelector("#refresh"),
  railNav: document.querySelector("#rail-nav"),
  newNovel: document.querySelector("#new-novel"),
  projectCount: document.querySelector("#project-count"),
  projectList: document.querySelector("#project-list"),
  projectOpenStatus: document.querySelector("#project-open-status"),
  openFolder: document.querySelector("#open-folder"),
  openSettings: document.querySelector("#open-settings"),
  title: document.querySelector("#project-title"),
  status: document.querySelector("#project-status"),
  topbarSub: document.querySelector("#topbar-sub"),
  topbarProgress: document.querySelector("#topbar-progress"),
  topbarProgressBar: document.querySelector("#topbar-progress-bar"),
  privacyToggle: document.querySelector("#privacy-toggle"),
  privacyLabel: document.querySelector("#privacy-label"),
  threadWrap: document.querySelector("#thread-wrap"),
  thread: document.querySelector("#thread"),
  composer: document.querySelector("#composer"),
  slashMenu: document.querySelector("#slash-menu"),
  composerInput: document.querySelector("#composer-input"),
  cbarSlash: document.querySelector("#cbar-slash"),
  composerHint: document.querySelector("#composer-hint"),
  composerSubmit: document.querySelector("#composer-submit"),
  drawerScrim: document.querySelector("#drawer-scrim"),
  drawer: document.querySelector("#drawer"),
  drawerClose: document.querySelector("#drawer-close"),
  drawerTabs: document.querySelector("#drawer-tabs"),
  drawerBody: document.querySelector("#drawer-body"),
  readerScrim: document.querySelector("#reader-scrim"),
  readerPath: document.querySelector("#reader-path"),
  readerTitle: document.querySelector("#reader-title"),
  readerMeta: document.querySelector("#reader-meta"),
  readerClose: document.querySelector("#reader-close"),
  readerBody: document.querySelector("#reader-body"),
  settingsScrim: document.querySelector("#settings-scrim"),
  settingsSearch: document.querySelector("#settings-search"),
  settingsProviderList: document.querySelector("#settings-provider-list"),
  settingsAdd: document.querySelector("#settings-add"),
  settingsDetail: document.querySelector("#settings-detail"),
  settingsCancel: document.querySelector("#settings-cancel"),
  settingsSave: document.querySelector("#settings-save"),
  settingsX: document.querySelector("#settings-x"),
  createScrim: document.querySelector("#create-scrim"),
  createTitle: document.querySelector("#create-title"),
  createSeed: document.querySelector("#create-seed"),
  createChapters: document.querySelector("#create-chapters"),
  createMinWords: document.querySelector("#create-min-words"),
  createPath: document.querySelector("#create-path"),
  createBrowse: document.querySelector("#create-browse"),
  createSubmit: document.querySelector("#create-submit"),
  createStatus: document.querySelector("#create-status"),
  createX: document.querySelector("#create-x"),
  toastStack: document.querySelector("#toast-stack"),
  threadStatus: document.querySelector("#thread-status"),
  topbar: document.querySelector(".topbar"),
  quickRail: document.querySelector("#quick-rail")
};

let currentProjectRoot = null;
let dashboardRequestId = 0;
let refreshTimer = null;
let drawerTab = "chapters";
let lastDashboard = null;
// 已渲染进对话流的事件指纹，避免轮询重复追加同一条气泡。
const renderedKeys = new Set();
// 本地内存里的旁路问答待确认条目（刷新即丢，与后端 side_questions.md 解耦）。
const askEntries = new Map();
let threadGreeted = false;
let liveBlock = null;
let lastFocused = null;
let sessionHeadEl = null;
let previousActivity = null;
let previousBadgeSummary = null;

const STAGE_ORDER = ["queued", "planning", "planned", "drafting", "reviewing", "needs_revision", "revising", "finalizing", "summarizing"];

const PROVIDER_PRESETS = {
  deepseek: { title: "DeepSeek 官方", provider: "openai-compatible", baseUrl: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY", models: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat"] },
  mimo: { title: "小米 MiMo 官方", provider: "openai-compatible", baseUrl: "https://api.xiaomimimo.com/v1", apiKeyEnv: "XIAOMI_MIMO_API_KEY", models: ["mimo-v2.5-pro", "mimo-v2-pro"] },
  custom: { title: "自定义", provider: "openai-compatible", baseUrl: "", apiKeyEnv: "WWRITING_PROVIDER_API_KEY", models: ["custom-model"] }
};

// PLACEHOLDER_AFTER_CONST

// --- extracted module instances (created before event bindings that reference their methods) ---
let composer; // forward ref: thread-renderer's promote button calls composer.promoteAskEntry (assigned in Task 7)

const threadRenderer = createThreadRenderer({
  refs,
  renderedKeys,
  askEntries,
  getLiveBlock: () => liveBlock,
  setLiveBlock: (block) => { liveBlock = block; },
  getCurrentProjectRoot: () => currentProjectRoot,
  loadDashboard,
  handleRetry,
  handleStop,
  handleQuick,
  openReader,
  showToast,
  showActionError,
  announce,
  promoteAskEntry: (entry) => composer.promoteAskEntry(entry),
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
});

composer = createComposer({
  refs,
  getCurrentProjectRoot: () => currentProjectRoot,
  loadDashboard,
  openCreateModal,
  openSettingsModal,
  openDrawer,
  showToast,
  showActionError,
  ensureRefreshLoop,
  threadRenderer,
  getAskEntries: () => askEntries,
});
const { submitComposer, autoGrowComposer, updateSlashMenu, onComposerKeydown, updateSubmitState, promoteAskEntry } = composer;

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
  const drawer = document.getElementById('drawer');
  if (drawer?.getAttribute('aria-hidden') !== 'false') toggleDrawer();
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
refs.drawerClose.addEventListener("click", () => closeDrawer());
refs.drawerScrim.addEventListener("click", () => closeDrawer());
refs.drawerTabs.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-dtab]");
  if (tab) setDrawerTab(tab.dataset.dtab);
});

refs.composerSubmit.addEventListener("click", () => submitComposer());
refs.cbarSlash.addEventListener("click", () => {
  refs.composerInput.value = "/";
  refs.composerInput.focus();
  autoGrowComposer();
  updateSlashMenu();
});
refs.composerInput.addEventListener("keydown", onComposerKeydown);
refs.composerInput.addEventListener("input", () => {
  autoGrowComposer();
  updateSubmitState();
  updateSlashMenu();
});

refs.readerClose.addEventListener("click", closeReader);
refs.readerScrim.addEventListener("click", (event) => {
  if (event.target === refs.readerScrim) closeReader();
});
refs.settingsX.addEventListener("click", closeSettingsModal);
refs.settingsCancel.addEventListener("click", closeSettingsModal);
refs.settingsScrim.addEventListener("click", (event) => {
  if (event.target === refs.settingsScrim) closeSettingsModal();
});
refs.settingsSave.addEventListener("click", () => saveSettings());
refs.settingsSearch.addEventListener("input", () => renderSettingsProviders());
refs.settingsAdd.addEventListener("click", () => settingsModal.resetToCustom());
refs.createX.addEventListener("click", closeCreateModal);
refs.createScrim.addEventListener("click", (event) => {
  if (event.target === refs.createScrim) closeCreateModal();
});
refs.createBrowse.addEventListener("click", () => browseForCreatePath());
refs.createSubmit.addEventListener("click", () => initProject(refs.createPath.value.trim()));
// PLACEHOLDER_BOOTSTRAP

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === ".") {
    event.preventDefault();
    setPrivacyMode(refs.app.dataset.privacy !== "on");
  }
  if (event.key === "Escape") {
    if (refs.readerScrim.classList.contains("show")) return closeReader();
    if (refs.settingsScrim.classList.contains("show")) return closeSettingsModal();
    if (refs.createScrim.classList.contains("show")) return closeCreateModal();
    if (refs.drawer.classList.contains("show")) return closeDrawer();
  }
  if (refs.readerScrim.classList.contains("show")) trapTab(refs.readerScrim, event);
  else if (refs.settingsScrim.classList.contains("show")) trapTab(refs.settingsScrim, event);
  else if (refs.createScrim.classList.contains("show")) trapTab(refs.createScrim, event);
  else if (refs.drawer.classList.contains("show")) trapTab(refs.drawer, event);
});
window.addEventListener("blur", () => { refs.app.dataset.away = "true"; });
window.addEventListener("focus", () => { refs.app.dataset.away = "false"; });
refs.privacyToggle.addEventListener("click", () => setPrivacyMode(refs.app.dataset.privacy !== "on"));

function renderRailNav() {
  const items = [
    { key: "new", icon: "compose", label: "新对话" },
    { key: "search", icon: "search", label: "搜索" },
    { key: "skill", icon: "skill", label: "技能" },
    { key: "plugin", icon: "plugin", label: "插件", disabled: true },
    { key: "auto", icon: "clock", label: "自动化" }
  ];
  refs.railNav.replaceChildren(...items.map((item) => {
    const button = document.createElement("button");
    button.className = `nav-item${item.disabled ? " disabled" : ""}`;
    button.type = "button";
    button.disabled = Boolean(item.disabled);
    button.append(icon(item.icon, 16));
    const span = document.createElement("span");
    span.textContent = item.label;
    button.append(span);
    if (item.disabled) {
      const soon = document.createElement("span");
      soon.className = "nav-soon";
      soon.textContent = "即将上线";
      button.append(soon);
    } else {
      button.addEventListener("click", () => handleNav(item.key));
    }
    return button;
  }));
}
// PLACEHOLDER_LOAD

async function loadAll() {
  await Promise.all([loadProjectList(), loadDashboard()]);
}

async function loadProjectList() {
  try {
    const data = await getJson("/api/projects/list");
    refs.projectCount.textContent = formatNumber(data.projects.length);
    refs.projectList.replaceChildren(
      ...(data.projects.length > 0
        ? data.projects.map((project) => renderProjectNav(project, data.selectedProjectRoot))
        : [renderProjectEmpty("还没有小说，点上方「新建小说」开始")])
    );
  } catch (error) {
    refs.projectList.replaceChildren(renderProjectEmpty(error.message));
  }
}

async function loadDashboard() {
  const requestId = ++dashboardRequestId;
  setStatus("loading");
  try {
    const data = await getJson("/api/dashboard");
    if (requestId !== dashboardRequestId) return;
    if (!data.ok) throw new Error(data.message ?? "仪表盘请求失败");
    if (data.hasProject) {
      data.queue = await getJson("/api/queue/state").catch(() => ({ ok: false, tasks: [] }));
      if (requestId !== dashboardRequestId) return;
    }
    renderDashboard(data);
  } catch (error) {
    if (requestId !== dashboardRequestId) return;
    renderError(error);
  }
}

function renderProjectNav(project, selectedProjectRoot) {
  const row = document.createElement("div");
  row.className = `proj-row${pathEquals(project.projectRoot, selectedProjectRoot) ? " active" : ""}`;
  const button = document.createElement("button");
  button.type = "button";
  button.className = `proj${pathEquals(project.projectRoot, selectedProjectRoot) ? " active" : ""}`;
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
  button.append(dot, main);
  const menu = document.createElement("div");
  menu.className = "proj-menu";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "proj-remove";
  remove.textContent = "移除";
  remove.setAttribute("aria-label", `从列表移除 ${project.title ?? "未命名小说"}`);
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
// PLACEHOLDER_RENDER_DASHBOARD

function renderDashboard(data) {
  lastDashboard = data;
  if (!data.hasProject) {
    currentProjectRoot = null;
    previousActivity = null;
    previousBadgeSummary = null;
    refs.title.textContent = "开始创作";
    refs.topbarSub.textContent = "新建或打开一部小说后，这里会显示模型与进度。";
    setStatus("idle");
    ensureRefreshLoop(false);
    threadRenderer.renderEmptyThread();
    refreshDrawerIfOpen();
    return;
  }

  const firstLoad = currentProjectRoot !== data.projectRoot;
  if (firstLoad) {
    // 切换/首次打开项目：重置对话流，按事件重建历史。
    renderedKeys.clear();
    askEntries.clear();
    threadGreeted = false;
    liveBlock = null;
    refs.thread.replaceChildren();
  }
  currentProjectRoot = data.projectRoot;

  const summary = data.summary;
  const project = data.project;
  const modelProfile = data.model_profile ?? {};
  refs.title.textContent = project.title ?? "未命名小说";
  const callsText = `${formatNumber(summary.modelCalls)}/${summary.maxModelCalls ?? "∞"} 调用`;
  const modelLabel = modelProfile.is_mock ? "模型未配置 · 请在设置里选一个" : (modelProfile.display ?? "模型未配置");
  refs.topbarSub.textContent = `${modelLabel} · ${summary.completedChapters}/${summary.targetChapters} 章 · ${callsText}`;
  setStatus(summary.projectStatus ?? "idle", summary.currentStage);
  const truth = computeAgentTruth(data);
  renderTruthIndicator(truth);
  renderTopbarProgress(data);
  ensureRefreshLoop(truth.refresh || summary.projectStatus === "running" || Boolean(liveBlock && !liveBlock.done));

  threadRenderer.syncThread(data, firstLoad);
  threadRenderer.syncFailureCards(data);

  const stripEl = document.getElementById('activity-strip');
  if (stripEl) {
    const activity = deriveActivity(data);
    renderActivityStrip(stripEl, activity, {
      privacy: refs.privacyToggle?.checked,
      onClickCost: () => openDrawerTab('cost'),
      onClickChapter: () => openDrawerTab('chapters')
    });
    motion.updateActivityStrip(stripEl, previousActivity, activity);
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

  refreshDrawerIfOpen();
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
// PLACEHOLDER_THREAD

function handleNav(key) {
  if (key === "new") return openCreateModal();
  if (key === "search") return showToast("搜索：跨小说 / 章节检索即将上线。", "info");
  if (key === "skill") return openDrawer("run");
  if (key === "auto") return showToast("自动化：长跑连续生成 / 定时任务即将上线。", "info");
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
// PLACEHOLDER_COMPOSER
// PLACEHOLDER_PROJECT

async function forgetProject(projectRoot) {
  if (!projectRoot) return;
  try {
    const result = await postJson("/api/projects/forget", { projectRoot });
    showToast("已从列表移除。", "success");
    currentProjectRoot = result.selectedProjectRoot ?? null;
    previousActivity = null;
    previousBadgeSummary = null;
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
    // 不在这里写 currentProjectRoot：renderDashboard 用旧值与新 data.projectRoot 比对来判定切换并清空对话流。
    refs.projectOpenStatus.style.display = "none";
    refs.projectOpenStatus.textContent = "";
    showToast("小说已打开。", "success");
    previousActivity = null;
    previousBadgeSummary = null;
    await loadAll();
  } catch (error) {
    refs.projectOpenStatus.style.display = "none";
    if (error.code === "project_open_failed" && error.message.includes("不是有效的 WWriting 项目文件夹")) {
      openCreateModal(projectRoot);
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
    openCreateModal();
    showToast("预览环境请在弹窗中手动输入文件夹路径。", "info");
  }
}

async function browseForCreatePath() {
  const picked = await window.wwritingDesktop?.selectProjectFolder?.();
  if (picked) refs.createPath.value = picked;
  else if (!window.wwritingDesktop?.selectProjectFolder) showToast("预览环境请手动输入文件夹路径。", "info");
}

async function initProject(projectRoot) {
  if (!projectRoot) {
    setCreateStatus("请填写要保存到的本地文件夹路径。", "error");
    return;
  }
  refs.createSubmit.disabled = true;
  setCreateStatus("正在初始化项目...", "");
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
    // 不在这里写 currentProjectRoot：renderDashboard 用旧值与新 data.projectRoot 比对来判定切换并清空对话流。
    closeCreateModal();
    showToast("小说已创建并打开。", "success");
    previousActivity = null;
    previousBadgeSummary = null;
    await loadAll();
  } catch (error) {
    setCreateStatus(error.message, "error");
    showToast(error.message, "error");
  } finally {
    refs.createSubmit.disabled = false;
  }
}
// PLACEHOLDER_STATUS

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
  if (refs.topbar) refs.topbar.classList.toggle("is-busy", truth.className === "running" || truth.className === "slow" || truth.className === "stale");
  renderTopbarAction("topbar-stop", "停止", truth.showStop, handleStop, truth.reason);
  renderTopbarAction("topbar-retry", "重试", truth.showRetry, handleRetry, truth.reason);
}

function renderTopbarAction(id, label, visible, handler, title = "") {
  const button = document.querySelector(`#${id}`);
  if (!button) return;
  if (button.dataset.bound !== "true") {
    button.addEventListener("click", () => handler());
    button.dataset.bound = "true";
  }
  button.textContent = label;
  button.title = title ?? "";
  button.hidden = !visible;
}

function renderTopbarProgress(data) {
  if (!refs.topbarProgress || !refs.topbarProgressBar) return;
  const pct = Number(data.summary?.activityProgressPercent ?? 0);
  const truth = computeAgentTruth(data);
  if (pct > 0 && ["running", "slow", "stale"].includes(truth.className)) {
    refs.topbarProgress.hidden = false;
    refs.topbarProgressBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  } else {
    refs.topbarProgress.hidden = true;
  }
}

async function handleRetry(taskId = null) {
  const retry = document.querySelector("#topbar-retry");
  if (retry) retry.disabled = true;
  const resolvedTaskId = taskId ?? lastDashboard?.retry_task_id ?? null;
  try {
    const result = await postJson("/api/run/retry", resolvedTaskId ? { taskId: resolvedTaskId } : {});
    showToast(result.message ?? "已从中断处继续。", "success");
    ensureRefreshLoop(true);
    await loadDashboard();
  } catch (error) {
    showToast(error.message, "error");
    await loadDashboard();
  } finally {
    if (retry) retry.disabled = false;
  }
}

async function handleStop() {
  const stop = document.querySelector("#topbar-stop");
  if (stop) stop.disabled = true;
  try {
    const result = await postJson("/api/run/stop", {});
    showToast(result.message ?? "已请求停止。", "success");
    ensureRefreshLoop(true);
    await loadDashboard();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    if (stop) stop.disabled = false;
  }
}

// 顶栏 Agent 状态：待命 / 规划中 / 写作中 / 审稿中 / 保存中 / 已完成 / 需处理。
function agentPhaseLabel(status, stage) {
  if (status === "completed") return "已完成";
  if (status === "blocked") return "需处理";
  if (status === "loading") return "读取中";
  if (status !== "running") return "待命";
  switch (stage) {
    case "queued":
    case "planning":
    case "planned":
      return "规划中";
    case "drafting":
    case "needs_revision":
    case "revising":
      return "写作中";
    case "reviewing":
      return "审稿中";
    case "finalizing":
    case "summarizing":
      return "保存中";
    default:
      return "运行中";
  }
}

function setCreateStatus(text, kind) {
  refs.createStatus.textContent = text;
  refs.createStatus.className = `spd-hint${kind ? ` ${kind}` : ""}`;
}

// PLACEHOLDER_READER

async function openReader(chapterNo) {
  refs.readerPath.textContent = `chapters/${String(chapterNo).padStart(3, "0")}.md`;
  refs.readerTitle.textContent = `第 ${String(chapterNo).padStart(3, "0")} 章`;
  refs.readerMeta.textContent = "正在读取本章正文...";
  refs.readerBody.replaceChildren(readerEmpty("读取中..."));
  openOverlay(refs.readerScrim, refs.readerClose);
  try {
    const data = await getJson(`/api/chapters/read?chapter=${encodeURIComponent(chapterNo)}`);
    refs.readerTitle.textContent = data.title ?? `第 ${String(chapterNo).padStart(3, "0")} 章`;
    refs.readerMeta.textContent = `${data.is_draft ? "草稿" : "正式章节"} · ${translateStage(data.status)} · ${formatNumber(data.actual_words)} 字 · ${String(data.format ?? "md").toUpperCase()}`;
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
  closeOverlay(refs.readerScrim);
}

function openCreateModal(prefillPath) {
  setCreateStatus("", "");
  if (prefillPath) refs.createPath.value = prefillPath;
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
// PLACEHOLDER_PRIVACY

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
  } catch {
    // localStorage 不可用时忽略持久化。
  }
  showToast(on ? "隐私模式已开启：正文已模糊，鼠标悬停可临时查看。" : "隐私模式已关闭。", "info");
}

function applyPrivacyState(on) {
  refs.app.dataset.privacy = on ? "on" : "off";
  refs.privacyToggle.setAttribute("aria-pressed", on ? "true" : "false");
  refs.privacyToggle.classList.toggle("active", on);
  refs.privacyLabel.textContent = on ? "隐私 · 开" : "隐私";
}

function ensureRefreshLoop(active) {
  if (active && !refreshTimer) {
    refreshTimer = window.setInterval(() => void loadDashboard(), 1800);
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
// PLACEHOLDER_UTILS

let lastAnnounce = "";
function announce(msg) {
  if (refs.threadStatus && msg && msg !== lastAnnounce) {
    lastAnnounce = msg;
    refs.threadStatus.textContent = msg;
  }
}


// 模块体执行完毕（所有 const/let 已离开 TDZ）后再启动；防止首屏渲染触达后置声明导致静默 ReferenceError。
renderRailNav();
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
  const rail = document.getElementById('quick-rail');
  const collapsed = document.getElementById('qr-collapsed');
  if (rail) rail.hidden = narrow;
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
