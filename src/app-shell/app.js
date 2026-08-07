// WWriting · 统一 Agent 对话控制面（统一 Agent 内核计划 Task 9）。
//
// 页面组合根：创建 AgentSurface（src/app-shell/agent/index.js，唯一对话 seam）并
// 传递项目变更/设置/章节回调；其余只保留导航、项目列表、设置、章节阅读与确定性
// 工具（导出）。不再 import 或维护 thread renderer / composer / agent truth /
// run presentation / write readiness / activity strip / suggestions / command
// registry 的状态（Rule 4/5：UI 不做业务决策，Agent 状态由 AgentSurface 消费
// snapshot/event）。
import { renderQuickRail, bindQuickRailKeys } from "./components/quick-rail.js";
import { motion } from "./motion-runtime.js";
import { getJson, postJson, withProjectScope } from "./api-client.js";
import { formatNumber, pathBaseName, pathEquals, translateStage } from "./utils.js";
import { icon } from "./icons.js";
import { createDrawerPanels } from "./drawer-panels.js";
import { createSettingsModal } from "./settings-modal.js";
import { createProjectScope } from "./project-scope.mjs";
import { createAgentSurface } from "./agent/index.js";
import { loadDefaultTier } from "./permission-defaults.mjs";
import { getTierById } from "./permission-tiers.mjs";

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
  topbarSub: document.querySelector("#topbar-sub"),
  privacyToggle: document.querySelector("#privacy-toggle"),
  privacyLabel: document.querySelector("#privacy-label"),
  themeToggle: document.querySelector("#theme-toggle"),
  themeLabel: document.querySelector("#theme-label"),
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
  toastStack: document.querySelector("#toast-stack"),
  quickRail: document.querySelector("#quick-rail")
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
let archivedExpanded = false;

// ---- AgentSurface：唯一对话 seam ----
const agentSurface = createAgentSurface({
  root: refs.agentSurface,
  api: null, // 默认 transport：agent/api.js（复用 api-client 通用 helper）
  onOpenSettings: (section) => openSettingsModal(section),
  onOpenChapter: (chapterNo) => openReader(chapterNo),
  onCreateProject: () => openCreateModal(),
  onOpenProjectFolder: () => openFromFolder()
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
});

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
// 新建弹窗：只通过右上角 X 或 Esc 关闭，避免点击遮罩误触丢失已填内容。
refs.createBrowse.addEventListener("click", () => browseForCreatePath());
refs.createSubmit.addEventListener("click", () => initProject(refs.createPath.value.trim()));

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
        return row;
      }));
    }
  }
  refs.projectList.replaceChildren(
    ...(parts.length > 0
      ? parts
      : [renderProjectEmpty(query ? "没有匹配的小说。" : "还没有小说")])
  );
}

async function loadDashboard() {
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
  } catch (error) {
    if (requestId !== dashboardRequestId) return;
    if (!projectScope.isCurrent(token)) return;
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

function commitProjectSwitch(projectRoot) {
  projectScope.activate(projectRoot);
  currentProjectRoot = projectRoot;
  clearTransientState();
  agentSurface.openProject(projectRoot);
}

function renderProjectNav(project, selectedProjectRoot) {
  const isSelected = pathEquals(project.projectRoot, selectedProjectRoot);
  const row = document.createElement("div");
  row.className = `proj-row${isSelected ? " active" : ""}`;
  const button = document.createElement("button");
  button.type = "button";
  button.className = `proj${isSelected ? " active" : ""}`;
  if (isSelected) button.setAttribute("aria-current", "page");
  button.title = project.title ?? "未命名小说";
  button.addEventListener("click", () => openProject(project.projectRoot));
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

function renderDashboard(data) {
  lastDashboard = data;
  if (!data.hasProject) {
    currentProjectRoot = null;
    refs.title.textContent = "开始创作";
    refs.topbarSub.textContent = "新建或打开一部小说，开始你的创作。";
    renderQuickRailIfPresent();
    refreshDrawerIfOpen();
    return;
  }

  const firstLoad = currentProjectRoot !== data.projectRoot;
  if (firstLoad) {
    // 切换/首次打开项目：把 AgentSurface 指向该项目（内部重连 SSE）。
    currentProjectRoot = data.projectRoot;
    agentSurface.openProject(data.projectRoot);
  }

  const summary = data.summary;
  const project = data.project;
  const modelProfile = data.model_profile ?? {};
  refs.title.textContent = project.title ?? "未命名小说";
  const progressCopy = `已写 ${summary.completedChapters}/${summary.targetChapters} 章`;
  refs.topbarSub.textContent = modelProfile.is_mock
    ? `模型未配置 · 请在设置里选一个 · ${progressCopy}`
    : progressCopy;

  renderQuickRailIfPresent();
  refreshDrawerIfOpen();
}

function renderQuickRailIfPresent() {
  if (refs.quickRail) {
    renderQuickRail(refs.quickRail, {
      onOpenTab: openDrawerTab,
      onOpenSettings: (section) => openSettingsModal(section)
    });
  }
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

// Quick Rail 初始化：纯导航。
if (refs.quickRail) {
  bindQuickRailKeys(refs.quickRail, openDrawerTab, (section) => openSettingsModal(section));
  renderQuickRail(refs.quickRail, {
    onOpenTab: openDrawerTab,
    // 技能槽位打开设置弹窗的「Agent 技能」分区（Task 13）。
    onOpenSettings: (section) => openSettingsModal(section)
  });
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
