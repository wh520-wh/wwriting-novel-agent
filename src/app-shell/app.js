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
let settingsProviderId = "deepseek";
// 已渲染进对话流的事件指纹，避免轮询重复追加同一条气泡。
const renderedKeys = new Set();
// 本地内存里的旁路问答待确认条目（刷新即丢，与后端 side_questions.md 解耦）。
const askEntries = new Map();
let threadGreeted = false;
let liveBlock = null;
let sessionHeadEl = null;
let previousActivity = null;
let previousBadgeSummary = null;

// 旁路询问命令前缀（与后端 side-question.mjs 保持一致；禁止使用 /btw）。
const SIDE_QUESTION_PREFIXES = ["/ask", "/side", "/q"];
const REVIEW_PREFIXES = ["/review", "/审稿"];
const WRITE_PREFIXES = ["/write", "/写作"];
// 命中则说明旁路询问其实包含修改主线设定/正文的诉求，需要确认后才转正式任务。
const MAIN_TASK_IMPACT_PATTERN = /(改成|改为|改掉|改写|写成|换成|替换|删除|删掉|去掉|移除|重写|改编|不要写|不再写|别写|不写|推翻|重新设定|改设定|改人设|改世界观|改大纲|改结局|改剧情|黑化|洗白|复活|写死|赐死|领便当|降智|崩坏|让.{0,6}死|让.{0,6}活|让.{0,8}(在一起|分手|退场|出局|登场|加入|离开|背叛|反水))/u;

// 斜杠命令面板（输入 / 唤起）。type 决定提交后走写作还是旁路询问。
const SLASH_COMMANDS = [
  { key: "/write", title: "开始/续写", desc: "把指令作为正式写作任务交给智能体", icon: "compose" },
  { key: "/review", title: "审稿修订", desc: "检查节奏、连贯性、设定一致性", icon: "check" },
  { key: "/ask", title: "旁路询问", desc: "临时提问，不修改正文、不打断写作", icon: "help" },
  { key: "/chapters", title: "打开章节", desc: "在右侧面板查看本地章节文件", icon: "book" },
  { key: "/settings", title: "模型设置", desc: "配置供应商、API Key、预算与联网", icon: "settings" }
];

const STAGE_ORDER = ["queued", "planning", "planned", "drafting", "reviewing", "needs_revision", "revising", "finalizing", "summarizing"];

const PROVIDER_PRESETS = {
  deepseek: { title: "DeepSeek 官方", provider: "openai-compatible", baseUrl: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY", models: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat"] },
  mimo: { title: "小米 MiMo 官方", provider: "openai-compatible", baseUrl: "https://api.xiaomimimo.com/v1", apiKeyEnv: "XIAOMI_MIMO_API_KEY", models: ["mimo-v2.5-pro", "mimo-v2-pro"] },
  custom: { title: "自定义", provider: "openai-compatible", baseUrl: "", apiKeyEnv: "WWRITING_PROVIDER_API_KEY", models: ["custom-model"] }
};

const ICON_PATHS = {
  compose: "M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6 M18.4 3.6a1.7 1.7 0 0 1 2.4 2.4L12.5 16.3l-3.4.9.9-3.4z",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M20.5 20.5 16 16",
  skill: "M12 3l7.5 4.3v8.6L12 20.2 4.5 15.9V7.3z M12 8.2v3.6 M12 11.8 9 13.5 M12 11.8 15 13.5",
  plugin: "M5 5h5v5H5z M14 5h5v5h-5z M5 14h5v5H5z M14 14h5v5h-5z",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 7.5v5l3.2 1.8",
  check: "M5 12.5l4.2 4.2L19 7",
  help: "M9 9a3 3 0 1 1 4 2.8c-.9.5-1.5 1-1.5 2.2M12 17.5h.01 M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z",
  book: "M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2zM5 17.5h13",
  settings: "M4 6.5h9M17 6.5h3M4 12h3M11 12h9M4 17.5h7M15 17.5h5",
  doc: "M7 3h7l4 4v14H7zM14 3v4h4",
  chevR: "M9 6l6 6-6 6",
  bolt: "M13 3 4 14h6l-1 7 9-11h-6z",
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18",
  eye: "M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z",
  eyeOff: "M3.5 4l17 16 M2.5 12s3.5-6.5 9.5-6.5c1.9 0 3.6.6 5 1.5 M9 6.2C10 5.8 11 5.5 12 5.5c6 0 9.5 6.5 9.5 6.5s-1.4 2.6-3.9 4.6 M14.5 14.6A2.8 2.8 0 0 1 9.5 9.5",
  copy: "M9 9h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z M6 15H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"
};
// PLACEHOLDER_AFTER_CONST

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
refs.settingsAdd.addEventListener("click", () => {
  settingsProviderId = "custom";
  refs.settingsSearch.value = "";
  renderSettingsProviders();
  void renderSettingsDetail();
});
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
    renderEmptyThread();
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

  syncThread(data, firstLoad);
  syncFailureCards(data);

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

function renderEmptyThread() {
  renderedKeys.clear();
  askEntries.clear();
  threadGreeted = false;
  liveBlock = null;
  refs.thread.replaceChildren(buildSessionHead(null), buildGreeting());
}

// 把后端事件流增量聚合成对话气泡。已渲染的事件用指纹去重，轮询时只追加新增气泡。
function syncThread(data, firstLoad) {
  const wrap = refs.threadWrap;
  const stick = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80;
  if (firstLoad) {
    refs.thread.append(buildSessionHead(data));
  } else {
    refreshSessionHead(data);
  }
  if (!threadGreeted && (data.events ?? []).length === 0) {
    refs.thread.append(buildGreeting());
    threadGreeted = true;
  }

  const events = [...(data.events ?? [])].sort((a, b) => timeValue(a.timestamp) - timeValue(b.timestamp));
  for (const event of events) {
    const key = eventKey(event);
    if (event.type === "user_instruction_received") {
      if (!renderedKeys.has(key)) {
        renderedKeys.add(key);
        refs.thread.append(buildUserBubble(event));
        announce("已发送指令");
      }
      continue;
    }
    if (event.type === "project_run_started") {
      if (!renderedKeys.has(key)) {
        renderedKeys.add(key);
        liveBlock = buildAgentBlock(event, data);
        refs.thread.append(liveBlock.root);
        announce("智能体开始写作");
      }
      continue;
    }
    // 运行内的阶段/章节/收尾事件，折叠进当前（持久于轮询之间的）运行气泡。
    appendRunDetail(liveBlock, event, data, key);
  }
  // 运行中：把最新阶段/章节进度同步进当前运行气泡。
  updateLiveAgentBlock(data);
  renderQueueCards(data.queue?.tasks ?? [], data);
  if (stick) scrollThreadToBottom();
}

function timeValue(value) {
  const ms = Date.parse(value ?? "");
  return Number.isNaN(ms) ? 0 : ms;
}

function eventKey(event) {
  return `${event.type}|${event.timestamp ?? ""}|${event.stage ?? ""}|${event.chapter_no ?? ""}|${event.message ?? ""}`;
}
// PLACEHOLDER_THREAD2

function icon(name, size = 16, cls) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  if (cls) svg.setAttribute("class", cls);
  for (const seg of (ICON_PATHS[name] ?? "").split(" M")) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", seg.startsWith("M") ? seg : `M${seg}`.replace(/^MM/, "M"));
    svg.append(path);
  }
  return svg;
}

function scrollThreadToBottom() {
  requestAnimationFrame(() => { refs.threadWrap.scrollTop = refs.threadWrap.scrollHeight; });
}
// PLACEHOLDER_THREAD3

function buildSessionHead(data) {
  const wrap = document.createElement("div");
  wrap.className = "session-head";
  sessionHeadEl = wrap;
  if (!data) {
    const meta = document.createElement("div");
    meta.className = "session-meta";
    const h2 = document.createElement("h2");
    h2.textContent = "开始创作";
    const seed = document.createElement("p");
    seed.className = "session-seed";
    seed.textContent = "新建或打开一部小说，开始与智能体对话。";
    meta.append(h2, seed);
    wrap.append(meta);
    return wrap;
  }
  wrap.append(buildSessionHeadInner(data));
  return wrap;
}

function buildSessionHeadInner(data) {
  const frag = document.createDocumentFragment();
  const summary = data.summary;
  const project = data.project;
  const titleRow = document.createElement("div");
  titleRow.className = "session-title";
  const cover = document.createElement("div");
  cover.className = "session-cover";
  const meta = document.createElement("div");
  meta.className = "session-meta";
  const h2 = document.createElement("h2");
  h2.textContent = project.title ?? "未命名小说";
  const seed = document.createElement("p");
  seed.className = "session-seed peek";
  seed.textContent = project.story_seed ?? data.projectRoot;
  meta.append(h2, seed);
  titleRow.append(cover, meta);
  frag.append(titleRow);

  const stats = document.createElement("div");
  stats.className = "session-stats";
  const pct = summary.progressPercent ?? 0;
  stats.append(
    statCell("章节进度", `${summary.completedChapters}/${summary.targetChapters}`),
    statCell("累计字数", formatCompact(summary.totalWords)),
    statCell("完成度", `${pct}%`, "accent"),
    statCell("模型调用", formatNumber(summary.modelCalls)),
    statCell("审查器", translateReviewStatus(data.review?.status), "green")
  );
  frag.append(stats);
  if (["interrupted", "cancelled", "running"].includes(summary.projectStatus)) {
    const recovery = document.createElement("div");
    recovery.className = `recovery-card ${statusClass(summary.projectStatus)}`;
    const text = document.createElement("span");
    const stage = translateStage(summary.currentStage ?? data.state?.current_stage);
    text.textContent = summary.projectStatus === "running"
      ? `上次进展：第 ${summary.currentChapterNo ?? "-"} 章 · ${stage}`
      : `${summary.projectStatus === "cancelled" ? "已停止" : "已中断"}：第 ${summary.currentChapterNo ?? "-"} 章 · ${stage}`;
    recovery.append(text);
    if (summary.projectStatus === "interrupted" || summary.projectStatus === "cancelled") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "task-action retry";
      retry.textContent = "继续";
      retry.addEventListener("click", () => handleRetry());
      recovery.append(retry);
    }
    frag.append(recovery);
  }
  return frag;
}
// PLACEHOLDER_THREAD4

function statCell(label, value, valueClass) {
  const stat = document.createElement("div");
  stat.className = "stat";
  const k = document.createElement("span");
  k.className = "k";
  k.textContent = label;
  const v = document.createElement("span");
  v.className = `v${valueClass ? ` ${valueClass}` : ""}`;
  v.textContent = value;
  stat.append(k, v);
  return stat;
}

function refreshSessionHead(data) {
  if (sessionHeadEl && sessionHeadEl.isConnected) sessionHeadEl.replaceChildren(buildSessionHeadInner(data));
}

function buildGreeting() {
  const wrap = document.createElement("div");
  wrap.className = "msg-agent rise";
  const avatar = document.createElement("div");
  avatar.className = "agent-avatar";
  avatar.textContent = "W";
  const body = document.createElement("div");
  body.className = "agent-body";
  const name = document.createElement("div");
  name.className = "agent-name";
  const strong = document.createElement("strong");
  strong.textContent = "WWriting 智能体";
  name.append(strong);
  const say = document.createElement("p");
  say.className = "agent-say";
  say.textContent = currentProjectRoot
    ? "我已就绪。你可以输入 /write 续写章节、/review 审稿修订，或 /ask 临时询问当前进度。"
    : "你好，我是 WWriting 智能体。新建或从左侧打开一部小说后，告诉我故事的设定，我会规划、起草、审稿、定稿，并把每一章保存为本地文件。";
  const quick = buildQuickRow(currentProjectRoot ? ["开始写作", "续写下一章", "/ask 现在写到第几章了"] : ["新建小说"]);
  body.append(name, say);
  if (quick) body.append(quick);
  wrap.append(avatar, body);
  return wrap;
}

function buildUserBubble(event) {
  const wrap = document.createElement("div");
  wrap.className = "msg-user rise";
  const bubble = document.createElement("div");
  bubble.className = "bubble-user";
  const mode = event.data?.mode;
  if (mode === "review") {
    const tag = document.createElement("span");
    tag.className = "cmd-tag";
    tag.textContent = "/review";
    bubble.append(tag);
  }
  bubble.append(document.createTextNode(event.message ?? ""));
  wrap.append(bubble);
  return wrap;
}
// PLACEHOLDER_THREAD5

function renderQueueCards(tasks, data) {
  for (const task of tasks) {
    const key = `task:${task.id}`;
    let existing = refs.thread.querySelector(`[data-task-card-id="${cssEscape(task.id)}"]`);
    const card = buildTaskCard(task, data);
    if (existing) {
      existing.replaceWith(card);
    } else if (!renderedKeys.has(key)) {
      renderedKeys.add(key);
      refs.thread.append(card);
    }
  }
}

function buildTaskCard(task, data) {
  const card = document.createElement("div");
  card.className = `task-card task-${statusClass(task.status)}`;
  card.dataset.taskCardId = task.id;
  const header = document.createElement("div");
  header.className = "task-header";
  const num = document.createElement("span");
  num.className = "task-num";
  num.textContent = `任务 #${task.index ?? ""}`;
  const badge = document.createElement("span");
  badge.className = `task-badge ${statusClass(task.status)}`;
  badge.textContent = translateTaskStatus(task.status);
  header.append(num, badge);

  const instruction = document.createElement("div");
  instruction.className = "task-instruction";
  instruction.textContent = task.instruction ?? "";
  card.append(header, instruction);

  if (task.status === "running") {
    card.append(buildInlineProgress(task, data));
    const stopBtn = document.createElement("button");
    stopBtn.className = "task-action danger";
    stopBtn.type = "button";
    stopBtn.textContent = "停止";
    stopBtn.addEventListener("click", () => handleStop());
    card.append(stopBtn);
  } else if (task.status === "queued") {
    const meta = document.createElement("div");
    meta.className = "task-meta";
    const queued = (data.queue?.tasks ?? []).filter((item) => item.status === "queued");
    const ahead = Math.max(0, queued.findIndex((item) => item.id === task.id));
    meta.textContent = ahead > 0 ? `前面还有 ${ahead} 个任务` : "下一个执行";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "task-action";
    cancelBtn.type = "button";
    cancelBtn.textContent = "取消";
    cancelBtn.addEventListener("click", () => cancelQueuedTask(task.id));
    card.append(meta, cancelBtn);
  } else if (task.status === "completed") {
    card.append(taskSummary(task, data));
  } else if (task.status === "blocked") {
    const reason = document.createElement("div");
    reason.className = "task-error";
    reason.textContent = task.error ?? "blocked";
    card.append(reason);
  } else if (task.status === "interrupted" || task.status === "cancelled") {
    const reason = document.createElement("div");
    reason.className = "task-error";
    reason.textContent = task.error ?? (task.status === "cancelled" ? "用户停止" : "任务中断");
    const retryBtn = document.createElement("button");
    retryBtn.className = "task-action retry";
    retryBtn.type = "button";
    retryBtn.textContent = "从中断处继续";
    retryBtn.addEventListener("click", () => handleRetry(task.id));
    card.append(reason, retryBtn);
  }
  return card;
}

function buildInlineProgress(task, data) {
  const wrap = document.createElement("div");
  wrap.className = "task-progress-wrap";
  const line = document.createElement("div");
  line.className = "task-progress-inline";
  const fill = document.createElement("div");
  fill.className = "task-progress-fill";
  const stageNames = ["queued", "planning", "planned", "drafting", "reviewing", "needs_revision", "revising", "finalizing", "summarizing"];
  const current = task.currentStage ?? data.summary?.currentStage ?? "queued";
  const idx = Math.max(0, stageNames.indexOf(current));
  fill.style.width = `${Math.round(((idx + 1) / stageNames.length) * 100)}%`;
  line.append(fill);
  const label = document.createElement("span");
  label.className = "task-progress-label";
  label.textContent = translateStage(current);
  wrap.append(line, label);
  return wrap;
}

function taskSummary(task, data) {
  const meta = document.createElement("div");
  meta.className = "task-meta";
  const words = data.summary?.totalWords ? `${formatNumber(data.summary.totalWords)} 字` : "已完成";
  const cost = data.summary?.estimatedCost ? ` · 约 ${data.summary.estimatedCost}` : "";
  meta.textContent = `${words}${cost}${task.completedAt ? ` · ${formatTime(task.completedAt)}` : ""}`;
  return meta;
}

async function cancelQueuedTask(taskId) {
  try {
    await postJson("/api/queue/cancel", { taskId });
    showToast("任务已取消。", "success");
    await loadDashboard();
  } catch (error) {
    showToast(error.message, "error");
  }
}

function translateTaskStatus(status) {
  if (status === "blocked") return "阻塞";
  return {
    queued: "排队中",
    running: "运行中",
    completed: "已完成",
    interrupted: "已中断",
    cancelled: "已停止"
  }[status] ?? status;
}


function buildQuickRow(items) {
  if (!items || items.length === 0) return null;
  const row = document.createElement("div");
  row.className = "quick-row";
  for (const label of items) {
    const chip = document.createElement("button");
    chip.className = "quick-chip";
    chip.type = "button";
    chip.append(icon("bolt", 13));
    chip.append(document.createTextNode(label));
    chip.addEventListener("click", () => handleQuick(label));
    row.append(chip);
  }
  return row;
}

// 一次运行 = 一个智能体气泡：含步骤时间线 + 完成后的章节卡 + 汇报文字。
function buildAgentBlock(startEvent, data) {
  const wrap = document.createElement("div");
  wrap.className = "msg-agent rise";
  const avatar = document.createElement("div");
  avatar.className = "agent-avatar";
  avatar.textContent = "W";
  const body = document.createElement("div");
  body.className = "agent-body";
  const name = document.createElement("div");
  name.className = "agent-name";
  const strong = document.createElement("strong");
  strong.textContent = "WWriting 智能体";
  const time = document.createElement("span");
  time.className = "t";
  time.textContent = "工作中";
  name.append(strong, time);
  const steps = document.createElement("div");
  steps.className = "steps";
  const say = document.createElement("p");
  say.className = "agent-say";
  say.hidden = true;
  body.append(name, steps, say);
  wrap.append(avatar, body);
  const block = { root: wrap, body, time, steps, say, chapter: null, quick: null, done: false };
  renderSteps(block, data);
  return block;
}

function appendRunDetail(block, event, data, key) {
  if (!block) return;
  if (event.type === "chapter_completed" || event.type === "chapter_finalized") {
    if (!renderedKeys.has(key)) {
      renderedKeys.add(key);
      attachChapterCard(block, event.chapter_no, data);
    }
  }
  if (event.type === "project_run_finished" || event.type === "project_run_failed" || event.type === "project_blocked") {
    if (!renderedKeys.has(key)) {
      renderedKeys.add(key);
      finishAgentBlock(block, event, data);
    }
  }
}
// PLACEHOLDER_THREAD6

// 步骤时间线：基于当前 summary 阶段把 9 阶段折叠成 4 个对话级步骤。
function renderSteps(block, data) {
  const steps = computeSteps(data);
  block.steps.replaceChildren(...steps.map((step) => {
    const row = document.createElement("div");
    row.className = `step ${step.status}`;
    const ic = document.createElement("span");
    ic.className = "step-ic";
    if (step.status === "done") ic.append(icon("check", 13));
    else if (step.status === "running") { const s = document.createElement("span"); s.className = "spin"; ic.append(s); }
    else if (step.status === "blocked") ic.append(icon("help", 12));
    else { const n = document.createElement("span"); n.className = "mono"; n.style.fontSize = "10px"; n.textContent = String(step.index); ic.append(n); }
    const txt = document.createElement("span");
    txt.className = "step-txt";
    const strong = document.createElement("strong");
    strong.textContent = step.name;
    const small = document.createElement("small");
    small.textContent = step.detail;
    txt.append(strong, small);
    const meta = document.createElement("span");
    meta.className = `step-meta${step.metaKind ? ` ${step.metaKind}` : ""}`;
    meta.textContent = step.meta;
    if (step.metaKind === "writing") {
      meta.setAttribute("aria-label", "Writing...");
    }
    row.append(ic, txt, meta);
    return row;
  }));
}

const STEP_GROUPS = [
  { id: "planning", name: "规划", detail: "拆解本章 · 悬念点", stages: ["queued", "planning", "planned"] },
  { id: "drafting", name: "写入章节", detail: "生成新章节文件", stages: ["drafting"] },
  { id: "reviewing", name: "审稿", detail: "质量门禁 · 结尾钩子", stages: ["reviewing", "needs_revision", "revising"] },
  { id: "finalizing", name: "定稿", detail: "checksum · 索引", stages: ["finalizing", "summarizing"] }
];

function writingStepLabel(data, group, isActive) {
  if (group.id !== "drafting" || !isActive) {
    return group.name;
  }
  const chapterNo = Number(data.summary?.currentChapterNo ?? 0);
  if (!Number.isInteger(chapterNo) || chapterNo < 1) {
    return "写入章节中";
  }
  return `写入第 ${chapterNo} 章中`;
}

function computeSteps(data) {
  const summary = data.summary;
  const activeStage = summary.currentStage === "blocked" ? data.state?.blocked_at_stage : summary.currentStage;
  const activeIndex = STAGE_ORDER.indexOf(activeStage);
  const completed = summary.projectStatus === "completed";
  const blocked = summary.projectStatus === "blocked";
  return STEP_GROUPS.map((group, i) => {
    const groupMax = Math.max(...group.stages.map((s) => STAGE_ORDER.indexOf(s)));
    const isActive = group.stages.includes(activeStage);
    let status = "todo";
    let meta = "排队";
    let metaKind = null;
    if (completed || (activeIndex >= 0 && activeIndex > groupMax)) {
      status = "done";
      meta = "完成";
    } else if (isActive) {
      status = blocked ? "blocked" : "running";
      meta = blocked ? "受阻" : "进行中";
      if (!blocked && group.id === "drafting") {
        meta = "Writing";
        metaKind = "writing";
      }
    }
    return {
      name: writingStepLabel(data, group, isActive && !blocked),
      detail: group.detail,
      status,
      meta,
      metaKind,
      index: i + 1
    };
  });
}
// PLACEHOLDER_THREAD7

function attachChapterCard(block, chapterNo, data) {
  if (!chapterNo) return;
  if (block.body.querySelector(`[data-chapter-card="${chapterNo}"]`)) return;
  const chapter = (data.chapters ?? []).find((item) => item.chapter_no === chapterNo);
  const card = document.createElement("button");
  card.className = "filecard";
  card.dataset.chapterCard = String(chapterNo);
  card.type = "button";
  card.addEventListener("click", () => openReader(chapterNo));

  const top = document.createElement("span");
  top.className = "filecard-top";
  const fic = document.createElement("span");
  fic.className = "file-ic";
  fic.append(icon("doc", 16));
  const fid = document.createElement("span");
  fid.className = "file-id";
  const path = document.createElement("span");
  path.className = "path";
  path.textContent = `chapters/${String(chapterNo).padStart(3, "0")}.md`;
  const nm = document.createElement("span");
  nm.className = "name";
  nm.textContent = `第 ${chapterNo} 章已写入本地文件`;
  fid.append(path, nm);
  const badge = document.createElement("span");
  badge.className = "file-badge";
  badge.textContent = translateStage(chapter?.status ?? "completed");
  top.append(fic, fid, badge);

  const foot = document.createElement("span");
  foot.className = "filecard-foot";
  const words = document.createElement("span");
  words.className = "mono";
  words.textContent = `${formatNumber(chapter?.actual_words ?? 0)} 字`;
  const hint = document.createElement("span");
  hint.className = "open-hint";
  hint.append(document.createTextNode("打开阅读 "));
  hint.append(icon("chevR", 13));
  foot.append(words, document.createTextNode(" · 本地已保存 "), hint);

  card.append(top, foot);
  // 插在汇报文字之前。
  block.body.insertBefore(card, block.say);
  block.chapter = chapterNo;
}

function finishAgentBlock(block, event, data) {
  block.done = true;
  block.time.textContent = "刚刚";
  renderSteps(block, data);
  if (event.type === "project_run_failed" || event.type === "project_blocked") {
    block.say.hidden = false;
    block.say.textContent = event.message ?? "运行已停止，请在右侧「运行」面板查看错误。";
    block.body.append(buildQuickRow(["打开运行面板"]));
    return;
  }
  block.say.hidden = false;
  block.say.textContent = block.chapter
    ? `第 ${block.chapter} 章已写入本地文件并通过校验。点上方文件卡可阅读正文。`
    : (event.message ?? "本轮任务已完成。");
  announce(block.say.textContent);
  block.body.append(buildQuickRow(block.chapter ? ["续写下一章", "查看章节正文"] : ["续写下一章"]));
}
// PLACEHOLDER_THREAD8

function insertByTs(container, node, ts) {
  const target = ts ? new Date(ts).getTime() : Date.now();
  const children = Array.from(container.children);
  for (const child of children) {
    const childTs = child.dataset.ts ? new Date(child.dataset.ts).getTime() : 0;
    if (childTs > target) {
      container.insertBefore(node, child);
      return;
    }
  }
  container.appendChild(node);
}

async function submitFailureAction(card, action) {
  try {
    const res = await fetch('/api/failures/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        command: action.command,
        args: action.args,
        failureId: card.id
      })
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      console.error('提交失败:', json.error ?? res.status);
      return;
    }
    loadDashboard();
  } catch (err) {
    console.error('提交失败:', err.message);
  }
}

function syncFailureCards(data) {
  const failures = deriveFailures(data);
  for (const card of failures) {
    const existing = document.querySelector(`[data-failure-id="${cssEscape(card.id)}"]`);
    if (existing) {
      const next = renderFailureCard(card, { onAction: submitFailureAction });
      if (card.resolution && !existing.querySelector(".failure-resolved")) {
        if (existing.dataset.motionResolving === "true") continue;
        existing.dataset.motionResolving = "true";
        motion.resolveFailureCard(existing, next, {
          commit: () => {
            delete existing.dataset.motionResolving;
            existing.replaceWith(next);
          }
        });
      } else {
        existing.replaceWith(next);
      }
      continue;
    }
    const node = renderFailureCard(card, { onAction: submitFailureAction });
    insertByTs(refs.thread, node, card.ts);
    motion.insertFailureCard(node);
  }
}

// 轮询期间把最新阶段同步进运行气泡；运行结束则松开引用，等收尾事件定稿。
function updateLiveAgentBlock(data) {
  if (!liveBlock || liveBlock.done || !liveBlock.root.isConnected) {
    liveBlock = null;
    return;
  }
  if (data.summary.projectStatus === "running") {
    renderSteps(liveBlock, data);
    const ch = data.summary.currentChapterNo;
    liveBlock.time.textContent = ch ? `第 ${ch} 章 · 工作中` : "工作中";
    announce(ch ? `正在写第 ${ch} 章` : "工作中");
  }
}

function buildSideBubble(entry) {
  const wrap = document.createElement("div");
  wrap.className = "msg-agent rise";
  const avatar = document.createElement("div");
  avatar.className = "agent-avatar side";
  avatar.textContent = "?";
  const body = document.createElement("div");
  body.className = "agent-body";
  const card = document.createElement("div");
  card.className = `sidecard${entry.mainTaskAffecting ? " impact" : ""}`;
  const tag = document.createElement("span");
  tag.className = "side-tag";
  tag.append(icon("help", 13));
  tag.append(document.createTextNode(entry.mainTaskAffecting ? " 旁路问答 · 待确认变更" : " 旁路问答 · 临时提问"));
  const q = document.createElement("div");
  q.className = "side-q peek";
  q.textContent = entry.question;
  const a = document.createElement("div");
  a.className = "side-a peek";
  a.textContent = entry.answer || "（无回答）";
  const note = document.createElement("div");
  note.className = "side-note";
  note.textContent = "side_questions.md · 不影响正文 / task_plan.md / progress.md";
  card.append(tag, q, a, note);
  if (entry.mainTaskAffecting && !entry.promoted) {
    card.append(buildAskConfirm(entry));
  }
  body.append(card);
  wrap.append(avatar, body);
  return wrap;
}
// PLACEHOLDER_THREAD9

function buildAskConfirm(entry) {
  const confirm = document.createElement("div");
  confirm.className = "ask-confirm";
  const text = document.createElement("span");
  text.className = "ask-confirm-text";
  text.textContent = entry.suggestion ?? "这是会影响主线设定的修改建议。是否要将它加入正式写作任务？";
  const actions = document.createElement("div");
  actions.className = "ask-confirm-actions";
  const promote = document.createElement("button");
  promote.className = "small-button promote";
  promote.type = "button";
  promote.textContent = "加入正式写作任务";
  promote.addEventListener("click", async () => {
    promote.disabled = true;
    try {
      await promoteAskEntry(entry);
    } catch (error) {
      promote.disabled = false;
      showActionError(error);
    }
  });
  const dismiss = document.createElement("button");
  dismiss.className = "small-button";
  dismiss.type = "button";
  dismiss.textContent = "仅作参考";
  dismiss.addEventListener("click", () => {
    entry.promoted = true;
    confirm.remove();
  });
  actions.append(promote, dismiss);
  confirm.append(text, actions);
  return confirm;
}

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

// 前端命令解析镜像（后端 side-question.mjs 为权威实现）。
function parseUserCommand(input, mode) {
  const raw = String(input ?? "");
  const trimmed = raw.trim();
  if (!trimmed) {
    return { type: "empty", content: "", raw, shouldAffectMainTask: false };
  }
  const ask = matchCommandPrefix(trimmed, SIDE_QUESTION_PREFIXES);
  if (ask !== null) {
    return { type: "side_question", content: ask, raw, shouldAffectMainTask: detectMainTaskImpact(ask) };
  }
  const review = matchCommandPrefix(trimmed, REVIEW_PREFIXES);
  if (review !== null) {
    return { type: "review", content: review, raw, shouldAffectMainTask: true };
  }
  const write = matchCommandPrefix(trimmed, WRITE_PREFIXES);
  if (write !== null) {
    return { type: "main", content: write, raw, shouldAffectMainTask: true };
  }
  if (mode === "side_question") {
    return { type: "side_question", content: trimmed, raw, shouldAffectMainTask: detectMainTaskImpact(trimmed) };
  }
  if (mode === "review") {
    return { type: "review", content: trimmed, raw, shouldAffectMainTask: true };
  }
  return { type: "main", content: trimmed, raw, shouldAffectMainTask: true };
}

function matchCommandPrefix(trimmed, prefixes) {
  const lower = trimmed.toLowerCase();
  for (const prefix of prefixes) {
    const lowerPrefix = prefix.toLowerCase();
    if (lower === lowerPrefix) {
      return "";
    }
    if (lower.startsWith(`${lowerPrefix} `) || trimmed.startsWith(`${prefix}\n`)) {
      return trimmed.slice(prefix.length).trim();
    }
  }
  return null;
}

function detectMainTaskImpact(text) {
  return MAIN_TASK_IMPACT_PATTERN.test(String(text ?? ""));
}
// PLACEHOLDER_COMPOSER2

function onComposerKeydown(event) {
  if (!refs.slashMenu.hidden) {
    const items = [...refs.slashMenu.querySelectorAll(".slash-item")];
    if (event.key === "ArrowDown") { event.preventDefault(); setSlashActive(slashActiveIndex + 1); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); setSlashActive(slashActiveIndex - 1); return; }
    if ((event.key === "Enter" || event.key === "Tab") && items[slashActiveIndex]) { event.preventDefault(); items[slashActiveIndex].click(); return; }
    if (event.key === "Escape") {
      hideSlashMenu();
      return;
    }
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void submitComposer();
  }
}

function autoGrowComposer() {
  const input = refs.composerInput;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
}

function updateSubmitState() {
  refs.composerSubmit.disabled = refs.composerInput.value.trim().length === 0;
}

function updateSlashMenu() {
  const value = refs.composerInput.value;
  if (!value.startsWith("/") || value.includes(" ") || value.includes("\n")) {
    hideSlashMenu();
    return;
  }
  const q = value.toLowerCase();
  const matches = SLASH_COMMANDS.filter((cmd) => cmd.key.startsWith(q));
  if (matches.length === 0) {
    hideSlashMenu();
    return;
  }
  refs.slashMenu.replaceChildren(buildSlashLabel(), ...matches.map(buildSlashItem));
  refs.slashMenu.hidden = false;
  refs.composerInput.setAttribute("aria-expanded", "true");
  setSlashActive(0);
}

function buildSlashLabel() {
  const label = document.createElement("div");
  label.className = "slash-label";
  label.textContent = "斜杠命令";
  return label;
}
// PLACEHOLDER_COMPOSER3

let slashActiveIndex = 0;
function setSlashActive(i) {
  const items = [...refs.slashMenu.querySelectorAll(".slash-item")];
  if (!items.length) return;
  slashActiveIndex = (i + items.length) % items.length;
  items.forEach((el, idx) => {
    const on = idx === slashActiveIndex;
    el.classList.toggle("active", on);
    el.setAttribute("aria-selected", on ? "true" : "false");
    if (on) refs.composerInput.setAttribute("aria-activedescendant", el.id);
  });
}

function buildSlashItem(cmd) {
  const button = document.createElement("button");
  button.className = "slash-item";
  button.type = "button";
  const ic = document.createElement("span");
  ic.className = "slash-ic";
  ic.append(icon(cmd.icon, 15));
  const tx = document.createElement("span");
  tx.className = "slash-tx";
  const strong = document.createElement("strong");
  strong.textContent = cmd.title;
  const small = document.createElement("small");
  small.textContent = cmd.desc;
  tx.append(strong, small);
  const key = document.createElement("span");
  key.className = "slash-key";
  key.textContent = cmd.key;
  button.id = "slash-opt-" + cmd.key.slice(1);
  button.setAttribute("role", "option");
  button.setAttribute("aria-selected", "false");
  button.append(ic, tx, key);
  button.addEventListener("click", () => pickSlash(cmd));
  return button;
}

function pickSlash(cmd) {
  hideSlashMenu();
  if (cmd.key === "/chapters") { refs.composerInput.value = ""; updateSubmitState(); return openDrawer("chapters"); }
  if (cmd.key === "/settings") { refs.composerInput.value = ""; updateSubmitState(); return openSettingsModal(); }
  refs.composerInput.value = `${cmd.key} `;
  refs.composerInput.focus();
  autoGrowComposer();
  updateSubmitState();
}

function hideSlashMenu() {
  refs.slashMenu.hidden = true;
  refs.slashMenu.replaceChildren();
  refs.composerInput.setAttribute("aria-expanded", "false");
  refs.composerInput.removeAttribute("aria-activedescendant");
  slashActiveIndex = 0;
}

async function submitComposer() {
  const parsed = parseUserCommand(refs.composerInput.value, "main");
  if (parsed.type === "empty") {
    showToast("请输入要提交的内容。", "info");
    return;
  }
  // 纯斜杠的导航命令在输入阶段已处理；这里若残留则当作普通文本。
  if (!currentProjectRoot) {
    showToast("请先新建或打开一部小说。", "info");
    openCreateModal();
    return;
  }
  hideSlashMenu();
  if (parsed.type === "side_question") {
    if (!parsed.content) { showToast("请补充要提问的内容。", "info"); return; }
    await submitSideQuestion(parsed.content);
    return;
  }
  await submitWritingCommand(parsed.content, parsed.type === "review" ? "review" : "write");
}
// PLACEHOLDER_COMPOSER4

async function submitWritingCommand(message, mode, { fromSideQuestion = false } = {}) {
  refs.composerSubmit.disabled = true;
  refs.composerSubmit.setAttribute("aria-busy", "true");
  try {
    const result = await postJson("/api/commands/submit", { message, mode, fromSideQuestion });
    refs.composerInput.value = "";
    autoGrowComposer();
    updateSubmitState();
    showToast(resultMessageForCommand(result), result.blocked ? "error" : "success");
    ensureRefreshLoop(true);
    await loadDashboard();
  } catch (error) {
    showActionError(error);
  } finally {
    refs.composerSubmit.removeAttribute("aria-busy");
    updateSubmitState();
  }
}

async function submitSideQuestion(question) {
  refs.composerSubmit.disabled = true;
  refs.composerSubmit.setAttribute("aria-busy", "true");
  try {
    const result = await postJson("/api/commands/ask", { question });
    refs.composerInput.value = "";
    autoGrowComposer();
    updateSubmitState();
    // /api/commands/ask 返回 {askedAt, question, answer, ...}，没有 eventKey 期待的 type/timestamp 字段；
    // 直接拼 eventKey 会让每条记录都得到相同 id，覆盖 askEntries。这里用 askedAt + map.size 兜底。
    const entry = {
      id: `ask-${result.askedAt ?? Date.now()}-${askEntries.size}`,
      question: result.question ?? question,
      answer: result.answer ?? "",
      mainTaskAffecting: result.mainTaskAffecting === true,
      suggestion: result.suggestion ?? null,
      promoted: false
    };
    askEntries.set(entry.id, entry);
    refs.thread.append(buildSideBubble(entry));
    scrollThreadToBottom();
    showToast(
      result.mainTaskAffecting
        ? "旁路询问已回复：检测到会影响主线的修改建议，请在对话内确认是否转正式任务。"
        : "旁路询问已回复（未修改正文，也未打断写作）。",
      result.mainTaskAffecting ? "info" : "success"
    );
  } catch (error) {
    showActionError(error);
  } finally {
    refs.composerSubmit.removeAttribute("aria-busy");
    updateSubmitState();
  }
}

async function promoteAskEntry(entry) {
  if (!currentProjectRoot) { showToast("请先打开一部小说。", "info"); return; }
  await submitWritingCommand(entry.question, "write", { fromSideQuestion: true });
  entry.promoted = true;
  showToast("已将该修改建议转为正式写作任务。", "success");
}

function resultMessageForCommand(result) {
  if (result.alreadyRunning) return "指令已记录；写作任务正在运行中。";
  if (result.completed) return "项目已完成；如需继续写，请先增加目标章节数。";
  if (result.blocked) return "项目已阻塞；请在右侧「运行」面板处理错误。";
  if (result.started) return "写作任务已开始。";
  return result.message ?? "指令已记录。";
}
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

async function fetchOutputStyles() {
  try {
    const data = await getJson("/api/output-styles");
    return Array.isArray(data.styles) ? data.styles : [];
  } catch (error) {
    console.warn("fetchOutputStyles failed:", error);
    // Fallback to bundled names only
    return [
      { name: "creative", description: "创作模式", source: "bundled" },
      { name: "review", description: "审稿模式", source: "bundled" }
    ];
  }
}

// PLACEHOLDER_DRAWER

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

function renderDrawerBody() {
  if (!lastDashboard || !lastDashboard.hasProject) {
    refs.drawerBody.replaceChildren(drawerEmpty("打开或新建一部小说后显示。"));
    return;
  }
  if (drawerTab === "chapters") renderChapterPanel(lastDashboard);
  else if (drawerTab === "model") renderModelPanel(lastDashboard);
  else if (drawerTab === "skills") renderSkillsPanel(lastDashboard);
  else if (drawerTab === "research") renderResearchPanel(lastDashboard);
  else if (drawerTab === "cost") renderCostPanel(lastDashboard);
  else if (drawerTab === "reviewer") renderReviewerPanel(lastDashboard);
  else renderRunPanel(lastDashboard);
}

function drawerEmpty(text) {
  const empty = document.createElement("div");
  empty.className = "dpanel-empty";
  empty.textContent = text;
  return empty;
}

function dpanel(titleText, pillText) {
  const panel = document.createElement("div");
  panel.className = "dpanel";
  const head = document.createElement("div");
  head.className = "dpanel-head";
  const h4 = document.createElement("h4");
  h4.textContent = titleText;
  head.append(h4);
  if (pillText != null) {
    const pill = document.createElement("span");
    pill.className = "pill mono";
    pill.textContent = pillText;
    head.append(pill);
  }
  const body = document.createElement("div");
  body.className = "dpanel-body";
  panel.append(head, body);
  return { panel, body };
}
// PLACEHOLDER_DRAWER2

function renderChapterPanel(data) {
  const summary = data.summary;
  const { panel, body } = dpanel("章节目录", `${summary.completedChapters}/${summary.targetChapters}`);
  body.style.padding = "6px";
  const list = document.createElement("div");
  list.className = "chrow-list";
  const chapters = data.chapters ?? [];
  if (chapters.length === 0) {
    list.append(drawerEmpty("尚无章节，发送指令后开始生成。"));
  } else {
    for (const chapter of chapters) {
      list.append(buildChapterRow(chapter));
    }
  }
  body.append(list);
  refs.drawerBody.replaceChildren(panel);
}

function buildChapterRow(chapter) {
  // 与后端 app-dashboard 的完成口径一致：status === "completed" 才算定稿。
  const done = chapter.status === "completed";
  const running = !done && chapter.status && !["queued", "planned"].includes(chapter.status);
  const row = document.createElement("button");
  row.className = `chrow ${done ? "completed" : running ? "running" : "todo"}`;
  row.type = "button";
  row.disabled = !done;
  const n = document.createElement("span");
  n.className = "ch-n mono";
  n.textContent = String(chapter.chapter_no).padStart(2, "0");
  const name = document.createElement("span");
  name.className = "ch-name peek";
  name.textContent = chapter.title || (done ? "已定稿章节" : translateStage(chapter.status ?? "queued"));
  row.append(n, name);
  if (done) {
    const meta = document.createElement("span");
    meta.className = "ch-meta mono";
    meta.textContent = `${formatNumber(chapter.actual_words)} 字`;
    row.append(meta, icon("chevR", 14, "ch-go"));
    row.addEventListener("click", () => openReader(chapter.chapter_no));
  } else if (running) {
    const state = document.createElement("span");
    state.className = "ch-state run";
    const spin = document.createElement("span");
    spin.className = "spin";
    state.append(spin, document.createTextNode("生成中"));
    row.append(state);
  } else {
    const state = document.createElement("span");
    state.className = "ch-state todo";
    state.textContent = "待生成";
    row.append(state);
  }
  return row;
}
// PLACEHOLDER_DRAWER3

function renderModelPanel(data) {
  const summary = data.summary;
  const profile = data.model_profile ?? {};
  const permissions = data.config?.effective?.tool_permissions ?? data.project.tool_permissions ?? {};
  const model = dpanel("模型配置", profile.is_mock ? "未配置" : (profile.display ?? "未配置"));
  const open = document.createElement("button");
  open.className = "save-btn";
  open.type = "button";
  open.textContent = "打开模型设置";
  open.addEventListener("click", () => openSettingsModal());
  const summaryLine = document.createElement("p");
  summaryLine.className = "spd-hint";
  summaryLine.textContent = profile.is_mock
    ? "尚未配置模型。点上方按钮选 DeepSeek / MiMo 或自定义供应商，并粘贴 API Key。"
    : `${profile.display}${profile.endpoint ? ` · ${profile.endpoint}` : ""}；${profile.api_key_saved ? "API Key 已保存在本机。" : "尚未保存 API Key。"}`;
  model.body.append(summaryLine, open);

  const budget = dpanel("预算与权限");
  const kv = document.createElement("dl");
  kv.className = "kv";
  appendKv(kv, "模型调用", `${formatNumber(summary.modelCalls)} / ${summary.maxModelCalls ?? "∞"}`);
  appendKv(kv, "估算成本", formatMoney(summary.estimatedCost));
  appendKv(kv, "缓存", cacheSummaryText(data));
  appendKv(kv, "联网权限", permissions.network_allowed ? "已开启" : "关闭", permissions.network_allowed ? "accent" : "");
  appendKv(kv, "审查器", translateReviewStatus(data.review?.status), "green");
  budget.body.append(kv);
  refs.drawerBody.replaceChildren(model.panel, budget.panel);
}

function cacheSummaryText(data) {
  if (!data.cacheSummary) return "缓存待生成";
  return data.cacheSummary.explanation ?? "缓存待生成";
}

function appendKv(dl, key, value, valueClass) {
  const dt = document.createElement("dt");
  dt.textContent = key;
  const dd = document.createElement("dd");
  dd.className = valueClass ?? "";
  dd.textContent = value;
  dl.append(dt, dd);
}
// PLACEHOLDER_DRAWER4

function renderRunPanel(data) {
  const summary = data.summary;
  const progress = dpanel("进度", `${summary.progressPercent ?? 0}%`);
  const kv = document.createElement("dl");
  kv.className = "kv";
  appendKv(kv, "完成章节", `${summary.completedChapters} / ${summary.targetChapters}`);
  appendKv(kv, "累计字数", formatNumber(summary.totalWords));
  appendKv(kv, "当前阶段", translateStage(summary.currentStage ?? "-"));
  appendKv(kv, "最近检查点", summary.latestCheckpoint ?? "-");
  progress.body.append(kv);

  const events = dpanel("运行事件");
  events.body.style.padding = "4px 0";
  const list = data.events ?? [];
  if (list.length === 0) {
    events.body.append(drawerEmpty("暂无事件。"));
  } else {
    for (const event of [...list].slice(-40).reverse()) {
      events.body.append(buildEventRow(event));
    }
  }

  const skillItems = data.skills?.items ?? [];
  const enabledCount = skillItems.filter((s) => s.enabled_in_project).length;
  const skills = dpanel("技能", `${enabledCount} 启用`);
  if (skillItems.length === 0) {
    skills.body.append(drawerEmpty("未发现技能。"));
  } else {
    for (const skill of skillItems) skills.body.append(buildSkillRow(skill));
  }

  const sources = data.sources?.latest ?? [];
  const research = dpanel("资料来源", formatNumber(data.sources?.count ?? 0));
  const form = document.createElement("div");
  form.className = "research-form";
  const q = document.createElement("input");
  q.type = "text"; q.placeholder = "搜索关键词"; q.className = "research-input";
  const sBtn = document.createElement("button");
  sBtn.type = "button"; sBtn.className = "small-button"; sBtn.textContent = "搜索";
  sBtn.addEventListener("click", () => runResearch("search", { query: q.value.trim(), limit: 5 }, sBtn));
  const u = document.createElement("input");
  u.type = "url"; u.placeholder = "https://example.com"; u.className = "research-input";
  const fBtn = document.createElement("button");
  fBtn.type = "button"; fBtn.className = "small-button"; fBtn.textContent = "抓取";
  fBtn.addEventListener("click", () => runResearch("fetch", { url: u.value.trim() }, fBtn));
  form.append(q, sBtn, u, fBtn);
  research.body.append(form);
  if (sources.length === 0) {
    research.body.append(drawerEmpty("暂无来源快照。"));
  } else {
    for (const source of sources) {
      const row = document.createElement("div");
      row.className = "evt";
      const et = document.createElement("span");
      et.className = "et";
      et.textContent = translateSourceKind(source.kind);
      const em = document.createElement("span");
      em.className = "em peek";
      em.textContent = source.title ?? source.file;
      const ex = document.createElement("span");
      ex.className = "ex";
      ex.textContent = source.untrusted ? "不可信" : "资料";
      row.append(et, em, ex);
      research.body.append(row);
    }
  }
  refs.drawerBody.replaceChildren(progress.panel, events.panel, skills.panel, research.panel);
}

function renderSkillsPanel(data) {
  const skillItems = data.skills?.items ?? [];
  const enabledCount = skillItems.filter((s) => s.enabled_in_project).length;
  const skills = dpanel("技能", `${enabledCount} 启用`);
  if (skillItems.length === 0) {
    skills.body.append(drawerEmpty("未发现技能。"));
  } else {
    for (const skill of skillItems) skills.body.append(buildSkillRow(skill));
  }
  refs.drawerBody.replaceChildren(skills.panel);
}

function renderResearchPanel(data) {
  const sources = data.sources?.latest ?? [];
  const research = dpanel("资料来源", formatNumber(data.sources?.count ?? 0));
  const form = document.createElement("div");
  form.className = "research-form";
  const q = document.createElement("input");
  q.type = "text"; q.placeholder = "搜索关键词"; q.className = "research-input";
  const sBtn = document.createElement("button");
  sBtn.type = "button"; sBtn.className = "small-button"; sBtn.textContent = "搜索";
  sBtn.addEventListener("click", () => runResearch("search", { query: q.value.trim(), limit: 5 }, sBtn));
  const u = document.createElement("input");
  u.type = "url"; u.placeholder = "https://example.com"; u.className = "research-input";
  const fBtn = document.createElement("button");
  fBtn.type = "button"; fBtn.className = "small-button"; fBtn.textContent = "抓取";
  fBtn.addEventListener("click", () => runResearch("fetch", { url: u.value.trim() }, fBtn));
  form.append(q, sBtn, u, fBtn);
  research.body.append(form);
  if (sources.length === 0) {
    research.body.append(drawerEmpty("暂无来源快照。"));
  } else {
    for (const source of sources) {
      const row = document.createElement("div");
      row.className = "evt";
      const et = document.createElement("span");
      et.className = "et";
      et.textContent = translateSourceKind(source.kind);
      const em = document.createElement("span");
      em.className = "em peek";
      em.textContent = source.title ?? source.file;
      const ex = document.createElement("span");
      ex.className = "ex";
      ex.textContent = source.untrusted ? "不可信" : "资料";
      row.append(et, em, ex);
      research.body.append(row);
    }
  }
  refs.drawerBody.replaceChildren(research.panel);
}

function renderCostPanel(data) {
  const summary = data.summary;
  const budget = dpanel("预算与用量");
  const kv = document.createElement("dl");
  kv.className = "kv";
  appendKv(kv, "模型调用", `${formatNumber(summary.modelCalls)} / ${summary.maxModelCalls ?? "∞"}`);
  appendKv(kv, "估算成本", formatMoney(summary.estimatedCost));
  appendKv(kv, "累计字数", formatNumber(summary.totalWords));
  appendKv(kv, "完成章节", `${summary.completedChapters} / ${summary.targetChapters}`);
  budget.body.append(kv);
  refs.drawerBody.replaceChildren(budget.panel);
}

function renderReviewerPanel(data) {
  const review = data.review ?? {};
  const panel = dpanel("审查报告");
  if (!review.generated_at) {
    panel.body.append(drawerEmpty("暂无审查报告。运行 /review 命令后生成。"));
  } else {
    const kv = document.createElement("dl");
    kv.className = "kv";
    appendKv(kv, "状态", translateReviewStatus(review.status));
    appendKv(kv, "生成时间", formatTime(review.generated_at));
    panel.body.append(kv);
    if (review.summary) {
      const p = document.createElement("p");
      p.className = "agent-say";
      p.textContent = review.summary;
      panel.body.append(p);
    }
  }
  refs.drawerBody.replaceChildren(panel.panel);
}
// PLACEHOLDER_DRAWER5

async function runResearch(action, body, btn) {
  if ((action === "search" && !body.query) || (action === "fetch" && !body.url)) {
    return showToast(action === "search" ? "请输入搜索关键词。" : "请输入要抓取的网址。", "info");
  }
  btn.disabled = true;
  try {
    await postJson(`/api/research/${action}`, body);
    showToast(action === "search" ? "搜索完成，结果已保存为来源快照。" : "抓取完成，正文已保存为来源快照。", "success");
    await loadDashboard();
  } catch (error) {
    showToast(error?.message ?? "资料检索失败。", "error");
  } finally {
    btn.disabled = false;
  }
}

function buildEventRow(event) {
  const row = document.createElement("div");
  row.className = `evt ${event.severity === "error" ? "err" : event.severity === "warning" ? "warn" : ""}`;
  const et = document.createElement("span");
  et.className = "et";
  et.textContent = formatTime(event.timestamp);
  const em = document.createElement("span");
  em.className = "em peek";
  em.textContent = `${translateEventType(event.type ?? "event")} · ${event.message ?? translateStage(event.stage ?? "-")}`;
  const ex = document.createElement("span");
  ex.className = "ex";
  ex.textContent = translateStage(event.stage ?? "-");
  row.append(et, em, ex);
  return row;
}

function buildSkillRow(skill) {
  const row = document.createElement("div");
  row.className = "evt";
  const et = document.createElement("span");
  et.className = "et";
  et.textContent = skill.name;
  const em = document.createElement("span");
  em.className = "em";
  em.textContent = `${translateSkillType(skill.type)} · 优先级 ${skill.priority}`;
  const action = document.createElement("button");
  action.className = "small-button";
  action.type = "button";
  action.textContent = skill.enabled_in_project ? "禁用" : "启用";
  action.addEventListener("click", async () => {
    action.disabled = true;
    try {
      await postJson(skill.enabled_in_project ? "/api/skills/disable" : "/api/skills/enable", { name: skill.name });
      showToast(`技能已${skill.enabled_in_project ? "禁用" : "启用"}：${skill.name}`, "success");
      await loadDashboard();
    } catch (error) {
      showActionError(error);
      action.disabled = false;
    }
  });
  row.append(et, em, action);
  return row;
}
// PLACEHOLDER_SETTINGS

const SETTINGS_PROVIDERS = [
  { id: "deepseek", name: "DeepSeek · 深度求索", short: "DS", color: "#4d6bfe", preset: "deepseek" },
  { id: "mimo", name: "小米 MiMo 官方", short: "Mi", color: "#ff6a00", preset: "mimo" },
  { id: "custom", name: "OpenAI 兼容 · 自定义", short: "AI", color: "#10a37f", preset: "custom" }
];
const settingsFields = {};

function openSettingsModal() {
  if (lastDashboard?.project?.active_model) {
    settingsProviderId = detectProviderPreset(lastDashboard.project.active_model);
  }
  refs.settingsSearch.value = "";
  renderSettingsProviders();
  void renderSettingsDetail();
  openOverlay(refs.settingsScrim, refs.settingsSearch);
  motion.openModal(refs.settingsScrim, document.querySelector("#settings-modal"));
}

function closeSettingsModal() {
  refs.settingsScrim.dataset.closing = "true";
  refs.settingsScrim.classList.remove("show");
  refs.settingsScrim.setAttribute("inert", "");
  motion.closeModal(refs.settingsScrim, document.querySelector("#settings-modal"), {
    onComplete: () => {
      delete refs.settingsScrim.dataset.closing;
      if (lastFocused && lastFocused.isConnected) lastFocused.focus();
      lastFocused = null;
    }
  });
}

function renderSettingsProviders() {
  const q = refs.settingsSearch.value.trim().toLowerCase();
  const list = SETTINGS_PROVIDERS.filter((p) => p.name.toLowerCase().includes(q));
  refs.settingsProviderList.replaceChildren(...list.map((provider) => {
    const button = document.createElement("button");
    button.className = `sp-item${provider.id === settingsProviderId ? " on" : ""}`;
    button.type = "button";
    const av = document.createElement("span");
    av.className = "sp-av";
    av.style.background = provider.color;
    av.textContent = provider.short;
    const name = document.createElement("span");
    name.className = "sp-name";
    name.textContent = provider.name;
    button.append(av, name);
    button.addEventListener("click", () => {
      settingsProviderId = provider.id;
      renderSettingsProviders();
      void renderSettingsDetail();
    });
    return button;
  }));
}
// PLACEHOLDER_SETTINGS2

async function renderSettingsDetail() {
  const provider = SETTINGS_PROVIDERS.find((p) => p.id === settingsProviderId) ?? SETTINGS_PROVIDERS[0];
  const preset = PROVIDER_PRESETS[provider.preset];
  const active = lastDashboard?.project?.active_model ?? {};
  const profile = lastDashboard?.model_profile ?? {};
  const budgetConfig = lastDashboard?.config?.effective?.budget_config ?? lastDashboard?.project?.budget_config ?? {};
  const permissions = lastDashboard?.config?.effective?.tool_permissions ?? lastDashboard?.project?.tool_permissions ?? {};
  const usingThisPreset = detectProviderPreset(active) === provider.id;

  refs.settingsDetail.replaceChildren();
  const head = document.createElement("header");
  head.className = "spd-head";
  const av = document.createElement("span");
  av.className = "sp-av lg";
  av.style.background = provider.color;
  av.textContent = provider.short;
  const h3 = document.createElement("h3");
  h3.textContent = provider.name;
  head.append(av, h3);
  refs.settingsDetail.append(head);

  settingsFields.model = settingField("模型", "model-id", {
    options: preset.models.includes(active.model_name) ? preset.models : (usingThisPreset && active.model_name ? [active.model_name, ...preset.models] : preset.models),
    value: usingThisPreset ? active.model_name : preset.models[0],
    placeholder: "输入模型 ID，例如 deepseek-chat"
  });
  settingsFields.baseUrl = settingField("API 地址 · 基础 URL", "text", {
    value: usingThisPreset && active.base_url ? active.base_url : preset.baseUrl
  });
  const endpointHint = document.createElement("div");
  endpointHint.className = "spd-hint";
  settingsFields.endpointHint = endpointHint;
  settingsFields.apiKey = settingField("API Key", "password", { placeholder: "粘贴官方 API Key", value: profile.api_key_value ?? "", secret: true });
  settingsFields.apiKeyEnv = settingField("密钥环境变量名（不是密钥本身）", "text", {
    value: usingThisPreset && active.api_key_env ? active.api_key_env : preset.apiKeyEnv,
    placeholder: "XIAOMI_MIMO_API_KEY"
  });
  const keyHint = document.createElement("div");
  keyHint.className = "spd-hint";
  keyHint.textContent = "API Key 只保存在本机应用 secrets，项目文件只记录变量名。";
  settingsFields.maxCalls = settingField("模型调用上限", "number", { value: budgetConfig.max_model_calls ?? "" });
  settingsFields.network = settingToggle("联网搜索/抓取权限", permissions.network_allowed === true);
  const research = lastDashboard?.config?.effective?.research_config ?? lastDashboard?.project?.research_config ?? {};
  settingsFields.searchEndpoint = settingField("联网搜索接口地址", "text", { value: research.search_endpoint ?? "", placeholder: "https://api.example.com/search" });
  settingsFields.searchKeyEnv = settingField("搜索密钥环境变量名", "text", { value: research.search_api_key_env ?? "", placeholder: "SEARCH_API_KEY" });

  // 输出风格下拉(bundled + user + project)
  const currentOutputStyle = lastDashboard?.project?.output_style ?? "creative";
  const outputStyles = await fetchOutputStyles();
  const outputStyleField = document.createElement("div");
  outputStyleField.className = "spd-field";
  const outputStyleLabel = document.createElement("div");
  outputStyleLabel.className = "spd-label";
  const outputStyleSpan = document.createElement("span");
  outputStyleSpan.textContent = "输出风格";
  outputStyleLabel.append(outputStyleSpan);
  const outputStyleSelect = document.createElement("select");
  outputStyleSelect.className = "spd-input";
  outputStyleSelect.id = "settings-output-style";
  outputStyleSelect.setAttribute("aria-label", "输出风格");
  for (const style of outputStyles) {
    const opt = document.createElement("option");
    opt.value = style.name;
    opt.textContent = `${style.name} — ${style.description}`;
    outputStyleSelect.append(opt);
  }
  outputStyleSelect.value = currentOutputStyle;
  outputStyleField.append(outputStyleLabel, outputStyleSelect);
  settingsFields.outputStyle = { field: outputStyleField, input: outputStyleSelect };

  refs.settingsDetail.append(
    settingsFields.model.field, settingsFields.baseUrl.field, endpointHint,
    settingsFields.apiKey.field, settingsFields.apiKeyEnv.field, keyHint,
    settingsFields.maxCalls.field, settingsFields.network.field,
    settingsFields.searchEndpoint.field, settingsFields.searchKeyEnv.field,
    settingsFields.outputStyle.field
  );
  bindEndpointPreview();
  updateEndpointPreview();
}
// PLACEHOLDER_SETTINGS3

function settingField(labelText, type, { value = "", placeholder = "", options = null, secret = false } = {}) {
  const field = document.createElement("div");
  field.className = "spd-field";
  const label = document.createElement("div");
  label.className = "spd-label";
  const span = document.createElement("span");
  span.textContent = labelText;
  label.append(span);
  field.append(label);
  let input;
  if (type === "select") {
    input = document.createElement("select");
    input.className = "spd-input";
    input.replaceChildren(...(options ?? []).map((opt) => {
      const option = document.createElement("option");
      option.value = opt;
      option.textContent = opt;
      return option;
    }));
    input.value = value ?? "";
  } else if (type === "model-id") {
    input = document.createElement("input");
    input.className = "spd-input";
    input.type = "text";
    input.value = value ?? "";
    input.setAttribute("list", "settings-model-suggestions");
    if (placeholder) input.placeholder = placeholder;
    const suggestions = document.createElement("datalist");
    suggestions.id = "settings-model-suggestions";
    suggestions.replaceChildren(...(options ?? []).map((opt) => {
      const option = document.createElement("option");
      option.value = opt;
      return option;
    }));
    field.append(suggestions);
  } else {
    input = document.createElement("input");
    input.className = "spd-input";
    input.type = type;
    input.value = value ?? "";
    if (placeholder) input.placeholder = placeholder;
  }
  input.setAttribute("aria-label", labelText);
  if (secret) {
    input.setAttribute("autocomplete", "off");
    input.setAttribute("spellcheck", "false");
    const wrap = document.createElement("div");
    wrap.className = "spd-input-wrap";
    wrap.append(input, buildSecretReveal(input), buildSecretCopy(input));
    field.append(wrap);
  } else {
    field.append(input);
  }
  return { field, input };
}

function buildSecretReveal(input) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "spd-affix spd-affix-eye";
  btn.setAttribute("aria-pressed", "false");
  btn.setAttribute("aria-label", "显示 API Key");
  btn.title = "显示 / 隐藏";
  btn.append(icon("eye", 15));
  btn.addEventListener("click", () => {
    const reveal = input.type === "password";
    input.type = reveal ? "text" : "password";
    btn.setAttribute("aria-pressed", reveal ? "true" : "false");
    btn.setAttribute("aria-label", reveal ? "隐藏 API Key" : "显示 API Key");
    btn.replaceChildren(icon(reveal ? "eyeOff" : "eye", 15));
  });
  return btn;
}

function buildSecretCopy(input) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "spd-affix spd-affix-copy";
  btn.setAttribute("aria-label", "复制 API Key");
  btn.title = "复制到剪贴板";
  btn.append(icon("copy", 15));
  btn.addEventListener("click", async () => {
    const value = input.value;
    if (!value) {
      showToast("API Key 为空，没有可复制的内容。", "error");
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      btn.classList.add("copied");
      btn.replaceChildren(icon("check", 15));
      window.setTimeout(() => {
        btn.classList.remove("copied");
        btn.replaceChildren(icon("copy", 15));
      }, 1300);
      showToast("已复制 API Key 到剪贴板。", "success");
    } catch {
      showToast("复制失败：未授权访问剪贴板。", "error");
    }
  });
  return btn;
}

function settingToggle(labelText, on) {
  const field = document.createElement("div");
  field.className = "spd-field spd-toggle";
  const label = document.createElement("div");
  label.className = "spd-label";
  const span = document.createElement("span");
  span.textContent = labelText;
  label.append(span);
  const button = document.createElement("button");
  button.type = "button";
  button.className = `sw${on ? " on" : ""}`;
  button.setAttribute("aria-pressed", on ? "true" : "false");
  button.setAttribute("aria-label", labelText);
  const dot = document.createElement("span");
  dot.className = "sw-dot";
  button.append(dot);
  button.addEventListener("click", () => {
    const next = button.getAttribute("aria-pressed") !== "true";
    button.classList.toggle("on", next);
    button.setAttribute("aria-pressed", next ? "true" : "false");
  });
  field.append(label, button);
  return { field, input: button, get checked() { return button.getAttribute("aria-pressed") === "true"; } };
}
// PLACEHOLDER_SETTINGS4

function bindEndpointPreview() {
  settingsFields.baseUrl.input.addEventListener("input", updateEndpointPreview);
}

function updateEndpointPreview() {
  const baseUrl = settingsFields.baseUrl.input.value.trim();
  settingsFields.endpointHint.textContent = baseUrl
    ? `完整请求地址：${resolveModelEndpoint(baseUrl)}`
    : "完整请求地址：未填写基础 URL";
}

function detectProviderPreset(activeModel = {}) {
  const baseUrl = activeModel.base_url ?? "";
  const envName = activeModel.api_key_env ?? "";
  const modelName = activeModel.model_name ?? "";
  if (baseUrl === PROVIDER_PRESETS.deepseek.baseUrl || envName === PROVIDER_PRESETS.deepseek.apiKeyEnv || modelName.startsWith("deepseek-")) {
    return "deepseek";
  }
  if (baseUrl === PROVIDER_PRESETS.mimo.baseUrl || envName === PROVIDER_PRESETS.mimo.apiKeyEnv || modelName.startsWith("mimo-")) {
    return "mimo";
  }
  return "custom";
}

async function saveSettings() {
  const provider = SETTINGS_PROVIDERS.find((p) => p.id === settingsProviderId) ?? SETTINGS_PROVIDERS[0];
  const apiKeyEnv = settingsFields.apiKeyEnv.input.value.trim();
  if (apiKeyEnv && !isEnvironmentVariableName(apiKeyEnv)) {
    showToast("密钥环境变量名只能用字母、数字、下划线，且不能以数字开头，例如 XIAOMI_MIMO_API_KEY。", "error");
    return;
  }
  if (!currentProjectRoot) {
    showToast("请先新建或打开一部小说，再保存模型设置。", "info");
    return;
  }
  refs.settingsSave.disabled = true;
  const originalText = refs.settingsSave.textContent;
  refs.settingsSave.textContent = "保存中...";
  try {
    const result = await postJson("/api/settings/update", {
      active_model: compactObject({
        provider: PROVIDER_PRESETS[provider.preset].provider,
        model_name: settingsFields.model.input.value.trim(),
        base_url: settingsFields.baseUrl.input.value.trim(),
        api_key: settingsFields.apiKey.input.value.trim(),
        api_key_env: apiKeyEnv
      }),
      tool_permissions: { network_allowed: settingsFields.network.checked },
      budget_config: { max_model_calls: settingsFields.maxCalls.input.value },
      research_config: compactObject({
        search_endpoint: settingsFields.searchEndpoint.input.value.trim(),
        search_api_key_env: settingsFields.searchKeyEnv.input.value.trim()
      }),
      output_style: settingsFields.outputStyle?.input?.value ?? "creative"
    });
    const profile = result.model_profile ?? {};
    showToast(`模型设置已保存：${profile.display ?? provider.name}`, "success");
    closeSettingsModal();
    await loadDashboard();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    refs.settingsSave.disabled = false;
    refs.settingsSave.textContent = originalText;
  }
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

let lastFocused = null;
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
