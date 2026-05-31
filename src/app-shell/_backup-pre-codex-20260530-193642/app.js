const refs = {
  app: document.querySelector(".app"),
  viewButtons: [...document.querySelectorAll("[data-view-button]")],
  providerCards: [...document.querySelectorAll("[data-provider-preset]")],
  refresh: document.querySelector("#refresh"),
  privacyToggle: document.querySelector("#privacy-toggle"),
  privacyLabel: document.querySelector("#privacy-label"),
  newNovel: document.querySelector("#new-novel"),
  projectOpen: document.querySelector("#project-open"),
  projectOpenStatus: document.querySelector("#project-open-status"),
  projectCount: document.querySelector("#project-count"),
  projectList: document.querySelector("#project-list"),
  sideStatus: document.querySelector("#side-status"),
  statusDot: document.querySelector("#status-dot"),
  title: document.querySelector("#project-title"),
  seed: document.querySelector("#project-seed"),
  status: document.querySelector("#project-status"),
  metricChapters: document.querySelector("#metric-chapters"),
  metricWords: document.querySelector("#metric-words"),
  percent: document.querySelector("#progress-percent"),
  progressBar: document.querySelector("#progress-bar"),
  runActivity: document.querySelector("#run-activity"),
  activityTitle: document.querySelector("#activity-title"),
  activityStage: document.querySelector("#activity-stage"),
  activityProgressBar: document.querySelector("#activity-progress-bar"),
  activityDetail: document.querySelector("#activity-detail"),
  activitySteps: document.querySelector("#activity-steps"),
  feedList: document.querySelector("#feed-list"),
  chapterList: document.querySelector("#chapter-list"),
  chaptersHint: document.querySelector("#chapters-hint"),
  modelName: document.querySelector("#model-name"),
  budget: document.querySelector("#budget"),
  cost: document.querySelector("#cost"),
  cache: document.querySelector("#cache"),
  tokenSplit: document.querySelector("#dashboard-token-split"),
  checkpoint: document.querySelector("#checkpoint"),
  currentModelPill: document.querySelector("#current-model-pill"),
  networkPermission: document.querySelector("#network-permission"),
  safeEditPermission: document.querySelector("#safe-edit-permission"),
  sourceCount: document.querySelector("#source-count"),
  sourceWarnings: document.querySelector("#source-warnings"),
  reviewStatus: document.querySelector("#review-status"),
  dashboardHealth: document.querySelector("#dashboard-health"),
  dashboardFlow: document.querySelector("#dashboard-flow"),
  skillList: document.querySelector("#skill-list"),
  researchQuery: document.querySelector("#research-query"),
  researchSearch: document.querySelector("#research-search"),
  researchUrl: document.querySelector("#research-url"),
  researchFetch: document.querySelector("#research-fetch"),
  sourceList: document.querySelector("#source-list"),
  eventList: document.querySelector("#event-list"),
  settingsScope: document.querySelector("#settings-scope"),
  settingProvider: document.querySelector("#setting-provider"),
  settingModel: document.querySelector("#setting-model"),
  settingBaseUrl: document.querySelector("#setting-base-url"),
  settingEndpointPreview: document.querySelector("#setting-endpoint-preview"),
  settingApiKey: document.querySelector("#setting-api-key"),
  settingApiKeyToggle: document.querySelector("#setting-api-key-toggle"),
  settingKeyHelp: document.querySelector("#setting-key-help"),
  settingApiKeyEnv: document.querySelector("#setting-api-key-env"),
  settingMaxOutput: document.querySelector("#setting-max-output"),
  settingMaxCalls: document.querySelector("#setting-max-calls"),
  settingNetwork: document.querySelector("#setting-network"),
  settingSearchEndpoint: document.querySelector("#setting-search-endpoint"),
  settingSearchKeyEnv: document.querySelector("#setting-search-key-env"),
  settingsSave: document.querySelector("#settings-save"),
  settingsStatus: document.querySelector("#settings-status"),
  modelProfileSummary: document.querySelector("#model-profile-summary"),
  createTitle: document.querySelector("#create-title"),
  createSeed: document.querySelector("#create-seed"),
  createChapters: document.querySelector("#create-chapters"),
  createMinWords: document.querySelector("#create-min-words"),
  createPath: document.querySelector("#create-path"),
  createBrowse: document.querySelector("#create-browse"),
  createSubmit: document.querySelector("#create-submit"),
  createStatus: document.querySelector("#create-status"),
  composerInput: document.querySelector("#composer-input"),
  composerSubmit: document.querySelector("#composer-submit"),
  composerModes: [...document.querySelectorAll("[data-composer-mode]")],
  composerStatusDot: document.querySelector("#composer-status-dot"),
  composerStatusText: document.querySelector("#composer-status-text"),
  composerModeNote: document.querySelector("#composer-mode-note"),
  askThread: document.querySelector("#ask-thread"),
  askQuick: document.querySelector("#ask-quick"),
  chapterReader: document.querySelector("#chapter-reader"),
  readerTitle: document.querySelector("#reader-title"),
  readerMeta: document.querySelector("#reader-meta"),
  readerBody: document.querySelector("#reader-body"),
  readerClose: document.querySelector("#reader-close"),
  toastStack: document.querySelector("#toast-stack")
};

let currentProjectRoot = null;
let currentView = "create";
let dashboardRequestId = 0;
let selectedProviderPreset = "deepseek";
let refreshTimer = null;
let composerMode = "main";
let lastAgentStatusLabel = "待命";
const askHistory = [];

const COMPOSER_MODES = {
  main: {
    label: "写作指令",
    placeholder: "给智能体下达指令：开始写作、续写下一章、调整方向……",
    note: ""
  },
  side_question: {
    label: "旁路询问",
    placeholder: "向智能体临时提问，不会打断写作或修改正文……",
    note: "旁路询问 · 只做分析解释，不会修改正文或打断当前任务"
  },
  review: {
    label: "审稿指令",
    placeholder: "下达审稿/修订指令：检查节奏、补足冲突、修订设定一致性……",
    note: "审稿指令 · 会作为正式任务交给智能体"
  }
};

// 旁路询问命令前缀（与后端 side-question.mjs 保持一致；禁止使用 /btw）。
const SIDE_QUESTION_PREFIXES = ["/ask", "/side", "/q"];
const REVIEW_PREFIXES = ["/review", "/审稿"];
const WRITE_PREFIXES = ["/write", "/写作"];
// 命中则说明旁路询问其实包含修改主线设定/正文的诉求，需要确认后才转正式任务。
const MAIN_TASK_IMPACT_PATTERN = /(改成|改为|改掉|改写|写成|换成|替换|删除|删掉|去掉|移除|重写|改编|不要写|不再写|别写|不写|推翻|重新设定|改设定|改人设|改世界观|改大纲|改结局|改剧情|黑化|洗白|复活|写死|赐死|领便当|降智|崩坏|让.{0,6}死|让.{0,6}活|让.{0,8}(在一起|分手|退场|出局|登场|加入|离开|背叛|反水))/u;

const PROVIDER_PRESETS = {
  deepseek: {
    title: "DeepSeek 官方",
    provider: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    models: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat"]
  },
  mimo: {
    title: "小米 MiMo 官方",
    provider: "openai-compatible",
    baseUrl: "https://api.xiaomimimo.com/v1",
    apiKeyEnv: "XIAOMI_MIMO_API_KEY",
    models: ["mimo-v2.5-pro", "mimo-v2-pro"]
  },
  custom: {
    title: "自定义",
    provider: "openai-compatible",
    baseUrl: "",
    apiKeyEnv: "WWRITING_PROVIDER_API_KEY",
    models: ["custom-model"]
  }
};

const STAGE_ORDER = ["queued", "planning", "planned", "drafting", "reviewing", "needs_revision", "revising", "finalizing", "summarizing"];

refs.viewButtons.forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.viewButton));
});

refs.providerCards.forEach((button) => {
  button.addEventListener("click", () => applyProviderPreset(button.dataset.providerPreset, { force: true }));
});

refs.refresh.addEventListener("click", () => loadAll());
refs.newNovel.addEventListener("click", () => startNewNovelFlow());
refs.projectOpen.addEventListener("click", () => openFromButton());
refs.createBrowse.addEventListener("click", () => browseForCreatePath());
refs.createSubmit.addEventListener("click", () => initProject(refs.createPath.value.trim()));
refs.researchSearch.addEventListener("click", () => runResearchAction("search"));
refs.researchFetch.addEventListener("click", () => runResearchAction("fetch"));
refs.settingsSave.addEventListener("click", () => saveSettings());
refs.composerSubmit.addEventListener("click", () => submitComposer());

refs.composerInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void submitComposer();
  }
});
refs.composerInput.addEventListener("input", () => {
  autoGrowComposer();
  updateComposerModeHint();
});

refs.composerModes.forEach((button) => {
  button.addEventListener("click", () => setComposerMode(button.dataset.composerMode));
});
refs.askQuick?.addEventListener("click", () => {
  setComposerMode("side_question");
  refs.composerInput.focus();
});

setComposerMode("main");
renderAskThread();

refs.settingProvider.addEventListener("input", () => {
  selectedProviderPreset = "custom";
  setProviderPresetActive("custom");
  updateEndpointPreview();
});
refs.settingBaseUrl.addEventListener("input", () => {
  selectedProviderPreset = "custom";
  setProviderPresetActive("custom");
  updateEndpointPreview();
});
refs.settingModel.addEventListener("change", updateEndpointPreview);
refs.settingApiKeyToggle.addEventListener("click", () => {
  const revealing = refs.settingApiKey.type === "password";
  refs.settingApiKey.type = revealing ? "text" : "password";
  refs.settingApiKeyToggle.setAttribute("aria-pressed", revealing ? "true" : "false");
  refs.settingApiKeyToggle.title = revealing ? "隐藏 API Key" : "显示 API Key";
  refs.settingApiKeyToggle.querySelector("span").textContent = revealing ? "隐藏" : "显示";
});

initPrivacyMode();
refs.privacyToggle.addEventListener("click", () => setPrivacyMode(refs.app.dataset.privacy !== "on"));
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === ".") {
    event.preventDefault();
    setPrivacyMode(refs.app.dataset.privacy !== "on");
  }
});
window.addEventListener("blur", () => {
  refs.app.dataset.away = "true";
});
window.addEventListener("focus", () => {
  refs.app.dataset.away = "false";
});

refs.readerClose.addEventListener("click", closeChapterReader);
refs.chapterReader.addEventListener("click", (event) => {
  if (event.target === refs.chapterReader) {
    closeChapterReader();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !refs.chapterReader.hidden) {
    closeChapterReader();
  }
});

await loadAll();

async function loadAll() {
  await Promise.all([loadProjectList(), loadDashboard()]);
}

function setView(view) {
  currentView = view;
  refs.app.dataset.view = view;
  refs.viewButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.viewButton === view);
  });
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

function startNewNovelFlow() {
  refs.createStatus.textContent = "";
  refs.createStatus.className = "form-status";
  setView("create");
  refs.createTitle.focus();
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
    if (requestId !== dashboardRequestId) {
      return;
    }
    if (!data.ok) {
      throw new Error(data.message ?? "仪表盘请求失败");
    }
    renderDashboard(data);
  } catch (error) {
    if (requestId !== dashboardRequestId) {
      return;
    }
    renderError(error);
  }
}

function renderDashboard(data) {
  if (!data.hasProject) {
    currentProjectRoot = null;
    refs.title.textContent = "开始创作";
    refs.seed.textContent = "用一句话描述你的故事，应用会持续生成章节并保存到本地。";
    refs.settingsScope.textContent = "无项目";
    setStatus("idle");
    ensureRefreshLoop(false);
    clearProjectData();
    renderSettingsForm({ activeModel: {}, permissions: {}, budgetConfig: {}, researchConfig: {} });
    if (currentView !== "settings") {
      setView("create");
    }
    return;
  }

  currentProjectRoot = data.projectRoot;
  refs.settingsScope.textContent = data.projectRoot === data.workspaceRoot ? "工作区" : "项目";
  if (currentView === "create") {
    setView("studio");
  }

  const summary = data.summary;
  const project = data.project;
  refs.title.textContent = project.title ?? "未命名小说";
  refs.seed.textContent = project.story_seed ?? data.projectRoot;
  setStatus(summary.projectStatus ?? "idle", summary.currentStage);
  ensureRefreshLoop(summary.projectStatus === "running");

  refs.metricChapters.textContent = `${summary.completedChapters}/${summary.targetChapters}`;
  refs.metricWords.textContent = formatNumber(summary.totalWords);
  refs.percent.textContent = `${summary.progressPercent}%`;
  refs.progressBar.style.width = `${summary.progressPercent}%`;

  const activeModel = project.active_model ?? {};
  const modelProfile = data.model_profile ?? modelProfileFromActiveModel(activeModel);
  refs.modelName.textContent = modelProfile.display;
  refs.currentModelPill.textContent = modelProfile.display;
  refs.currentModelPill.title = modelProfileTitle(modelProfile);
  refs.budget.textContent = `${formatNumber(summary.modelCalls)} / ${summary.maxModelCalls ?? "∞"}`;
  refs.cost.textContent = formatMoney(summary.estimatedCost);
  refs.cache.textContent = summary.cacheMetricsAvailable ? `${Math.round(Number(summary.cacheHitRate ?? 0) * 100)}%` : "供应商未返回";
  const cost = data.cost ?? {};
  refs.tokenSplit.textContent = `入 ${formatCompact(cost.inputTokens ?? 0)} / 出 ${formatCompact(cost.outputTokens ?? 0)}`;
  refs.checkpoint.textContent = summary.latestCheckpoint ?? "-";
  refs.dashboardHealth.textContent = healthText(summary.projectStatus);

  const permissions = data.config?.effective?.tool_permissions ?? project.tool_permissions ?? {};
  const budgetConfig = data.config?.effective?.budget_config ?? project.budget_config ?? {};
  const researchConfig = data.config?.effective?.research_config ?? project.research_config ?? {};
  renderSettingsForm({ activeModel, permissions, budgetConfig, researchConfig, modelProfile });
  refs.networkPermission.textContent = permissions.network_allowed ? "允许" : "关闭";
  refs.safeEditPermission.textContent = permissions.safe_edit ? "允许" : "关闭";
  refs.sourceCount.textContent = formatNumber(data.sources?.count ?? 0);
  refs.sourceWarnings.textContent = formatNumber(data.sources?.promptInjectionWarnings ?? 0);
  refs.reviewStatus.textContent = translateReviewStatus(data.review?.status);

  const chapters = data.chapters ?? [];
  refs.chapterList.replaceChildren(
    ...(chapters.length > 0 ? chapters.map(renderChapter) : [renderListEmpty("尚无章节，发送指令后开始生成")])
  );
  renderRunActivity(data);
  renderFeed(data);
  refs.dashboardFlow.replaceChildren(...buildFlowSteps(data).map(renderFlowItem));

  const skills = data.skills?.items ?? [];
  refs.skillList.replaceChildren(...(skills.length > 0 ? skills.map(renderSkill) : [renderListEmpty("未启用技能")]));
  const sources = data.sources?.latest ?? [];
  refs.sourceList.replaceChildren(...(sources.length > 0 ? sources.map(renderSource) : [renderListEmpty("暂无来源快照")]));
  refs.eventList.replaceChildren(...(data.events ?? []).slice(-30).reverse().map(renderEvent));
}

function renderFeed(data) {
  const events = (data.events ?? []).slice(-6).reverse();
  refs.feedList.replaceChildren(
    ...(events.length > 0 ? events.map(renderFeedItem) : [renderListEmpty("暂无动态")])
  );
}

function renderFeedItem(event) {
  const item = document.createElement("li");
  item.className = `feed-item ${event.severity ?? "info"}`;
  const type = document.createElement("span");
  type.className = "feed-type";
  type.textContent = translateEventType(event.type ?? "event");
  const message = document.createElement("span");
  message.className = "feed-msg peek";
  message.textContent = event.message ?? translateStage(event.stage ?? "-");
  const time = document.createElement("span");
  time.className = "feed-time";
  time.textContent = formatTime(event.timestamp);
  item.append(type, message, time);
  return item;
}

function renderRunActivity(data) {
  const summary = data.summary;
  const running = summary.projectStatus === "running";
  const blocked = summary.projectStatus === "blocked";
  const completed = summary.projectStatus === "completed";
  const activityPercent = running
    ? Math.max(8, summary.activityProgressPercent ?? summary.progressPercent ?? 0)
    : summary.activityProgressPercent ?? summary.progressPercent ?? 0;
  refs.runActivity.className = `panel run-activity ${running ? "running" : blocked ? "blocked" : completed ? "completed" : "idle"}`;
  refs.runActivity.setAttribute("aria-busy", running ? "true" : "false");
  refs.activityTitle.textContent = running ? "智能体正在工作" : completed ? "项目已完成" : blocked ? "需要处理" : "等待指令";
  refs.activityStage.textContent = translateStage(summary.currentStage ?? "-");
  refs.activityProgressBar.style.width = `${activityPercent}%`;
  refs.activityDetail.textContent = running
    ? `正在推进第 ${String(summary.currentChapterNo ?? 1).padStart(3, "0")} 章：${translateStage(summary.currentStage)}。章节正文会通过工具写入本地文件。`
    : completed
      ? "所有目标章节已完成。点「章节」标签阅读正文。"
      : blocked
        ? "工作流已阻塞，请到「运行」标签查看错误。"
        : "在下方输入框写下你的故事或续写要求，智能体会开始工作。";
  refs.activitySteps.replaceChildren(...buildFlowSteps(data).map(renderActivityStep));
}

function renderActivityStep(step) {
  const item = document.createElement("li");
  item.className = `activity-step ${step.state}`;
  const mark = document.createElement("span");
  mark.className = "step-mark";
  mark.textContent = step.state === "completed" ? "✓" : step.state === "running" ? "…" : step.state === "blocked" ? "!" : "";
  const body = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = step.title;
  const detail = document.createElement("small");
  detail.textContent = step.detail;
  body.append(title, detail);
  item.append(mark, body);
  return item;
}

function buildFlowSteps(data) {
  const summary = data.summary;
  const activeStage = summary.currentStage === "blocked" ? data.state?.blocked_at_stage : summary.currentStage;
  const activeIndex = STAGE_ORDER.indexOf(activeStage);
  return STAGE_ORDER.map((stage, index) => {
    let state = "pending";
    if (summary.projectStatus === "completed" || (activeIndex >= 0 && index < activeIndex)) {
      state = "completed";
    } else if (stage === activeStage) {
      state = summary.projectStatus === "blocked" ? "blocked" : "running";
    }
    return { title: translateStage(stage), state, detail: flowDetail(data, stage) };
  });
}

function flowDetail(data, stage) {
  const event = [...(data.events ?? [])].reverse().find((item) => item.stage === stage);
  if (event?.message) {
    return event.message;
  }
  if (stage === data.summary.currentStage && data.summary.currentChapterNo) {
    return `第 ${String(data.summary.currentChapterNo).padStart(3, "0")} 章`;
  }
  return "等待调度器推进";
}

function renderFlowItem(step) {
  const item = document.createElement("li");
  item.className = `flow-item ${step.state}`;
  const title = document.createElement("strong");
  title.textContent = `${translateFlowState(step.state)} · ${step.title}`;
  const detail = document.createElement("span");
  detail.textContent = step.detail;
  item.append(title, detail);
  return item;
}

function renderProjectNav(project, selectedProjectRoot) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.className = pathEquals(project.projectRoot, selectedProjectRoot) ? "project-card active" : "project-card";
  button.type = "button";
  button.addEventListener("click", () => openProject(project.projectRoot));
  const title = document.createElement("strong");
  title.textContent = project.title ?? "未命名小说";
  const seed = document.createElement("span");
  seed.textContent = project.story_seed || project.projectRoot;
  const model = document.createElement("small");
  model.className = "project-model";
  model.textContent = project.model_label ?? modelProfileFromActiveModel(project.active_model).display;
  button.append(title, seed, model);
  item.append(button);
  return item;
}

function renderProjectEmpty(text) {
  const item = document.createElement("li");
  item.className = "project-card empty";
  item.textContent = text;
  return item;
}

function renderSettingsForm({ activeModel, permissions, budgetConfig, researchConfig, modelProfile = null }) {
  if (document.activeElement && document.activeElement.closest(".settings-form")) {
    return;
  }
  const profile = modelProfile ?? modelProfileFromActiveModel(activeModel);
  const presetName = detectProviderPreset(activeModel);
  selectedProviderPreset = presetName;
  setProviderPresetActive(presetName);
  refs.settingProvider.value = activeModel.provider ?? PROVIDER_PRESETS[presetName].provider;
  setModelOptions(presetName, activeModel.model_name ?? PROVIDER_PRESETS[presetName].models[0]);
  refs.settingBaseUrl.value = activeModel.base_url ?? PROVIDER_PRESETS[presetName].baseUrl;
  refs.settingApiKey.value = profile.api_key_value ?? "";
  refs.settingApiKey.type = "password";
  refs.settingApiKeyToggle.setAttribute("aria-pressed", "false");
  refs.settingApiKeyToggle.title = "显示 API Key";
  refs.settingApiKeyToggle.querySelector("span").textContent = "显示";
  refs.settingApiKeyEnv.value = activeModel.api_key_env ?? PROVIDER_PRESETS[presetName].apiKeyEnv;
  refs.settingKeyHelp.textContent = keyHelpText(presetName, refs.settingApiKeyEnv.value);
  refs.settingMaxOutput.value = activeModel.max_output_tokens ?? "";
  refs.settingMaxCalls.value = budgetConfig.max_model_calls ?? "";
  refs.settingNetwork.checked = permissions.network_allowed === true;
  refs.settingSearchEndpoint.value = researchConfig.search_endpoint ?? "";
  refs.settingSearchKeyEnv.value = researchConfig.search_api_key_env ?? "";
  renderModelProfileSummary(profile);
  updateEndpointPreview();
}

function applyProviderPreset(presetName, { force = false } = {}) {
  const preset = PROVIDER_PRESETS[presetName] ?? PROVIDER_PRESETS.custom;
  selectedProviderPreset = presetName;
  setProviderPresetActive(presetName);
  refs.settingProvider.value = preset.provider;
  refs.settingBaseUrl.value = preset.baseUrl;
  refs.settingApiKeyEnv.value = preset.apiKeyEnv;
  setModelOptions(presetName, preset.models[0]);
  refs.settingKeyHelp.textContent = keyHelpText(presetName, preset.apiKeyEnv);
  if (force) {
    refs.settingApiKey.focus();
  }
  updateEndpointPreview();
}

function setProviderPresetActive(presetName) {
  refs.providerCards.forEach((button) => {
    button.classList.toggle("active", button.dataset.providerPreset === presetName);
  });
}

function setModelOptions(presetName, selectedModel) {
  const preset = PROVIDER_PRESETS[presetName] ?? PROVIDER_PRESETS.custom;
  const models = preset.models.includes(selectedModel) ? preset.models : [selectedModel, ...preset.models];
  refs.settingModel.replaceChildren(
    ...models.map((model) => {
      const option = document.createElement("option");
      option.value = model;
      option.textContent = model;
      return option;
    })
  );
  refs.settingModel.value = selectedModel;
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

function keyHelpText(presetName, envName) {
  if (presetName === "deepseek") {
    return `粘贴 DeepSeek 官方 API Key；本机保存为 ${envName}，项目文件只记录变量名。`;
  }
  if (presetName === "mimo") {
    return `粘贴小米 MiMo 官方 API Key；本机保存为 ${envName}，项目文件只记录变量名。`;
  }
  return `粘贴兼容接口 API Key；本机保存为 ${envName}，项目文件只记录变量名。`;
}

function modelProfileFromActiveModel(activeModel = {}) {
  const provider = activeModel?.provider ?? "mock";
  const modelName = activeModel?.model_name ?? "mock-writer";
  const presetName = detectProviderPreset(activeModel);
  const providerLabel = provider === "mock" ? "Mock" : PROVIDER_PRESETS[presetName]?.title ?? provider;
  return {
    provider,
    provider_label: providerLabel,
    model_name: modelName,
    base_url: activeModel?.base_url ?? "",
    endpoint: provider === "openai-compatible" ? resolveModelEndpoint(activeModel?.base_url ?? "") : "",
    api_key_env: activeModel?.api_key_env ?? "",
    api_key_saved: false,
    api_key_value: "",
    is_mock: provider === "mock",
    display: `${providerLabel} / ${modelName}`,
    saved_to: "project.yaml"
  };
}

function modelProfileTitle(profile) {
  const lines = [`当前模型：${profile.display}`];
  if (profile.endpoint) {
    lines.push(`请求地址：${profile.endpoint}`);
  }
  if (profile.api_key_env) {
    lines.push(`密钥变量：${profile.api_key_env}${profile.api_key_saved ? "（已保存）" : "（未保存）"}`);
  }
  return lines.join("\n");
}

function renderModelProfileSummary(profile) {
  refs.modelProfileSummary.replaceChildren();
  const title = document.createElement("strong");
  title.textContent = profile.display;
  const detail = document.createElement("span");
  detail.textContent = profile.is_mock
    ? "当前项目仍在使用 Mock 离线模型。"
    : `保存于 ${profile.saved_to ?? "project.yaml"}；${profile.api_key_saved ? "API Key 已在本机保存。" : "尚未保存 API Key。"}${profile.endpoint ? ` 请求：${profile.endpoint}` : ""}`;
  refs.modelProfileSummary.append(title, detail);
}

function renderChapter(chapter) {
  const item = document.createElement("li");
  item.className = `chapter ${statusClass(chapter.status)}`;
  item.tabIndex = 0;
  item.setAttribute("role", "button");
  item.setAttribute("aria-label", `第 ${String(chapter.chapter_no).padStart(3, "0")} 章，${translateStage(chapter.status ?? "queued")}，点击阅读`);
  item.title = "点击阅读本章正文";
  const title = document.createElement("strong");
  title.textContent = String(chapter.chapter_no).padStart(3, "0");
  const status = document.createElement("span");
  status.textContent = translateStage(chapter.status ?? "queued");
  const words = document.createElement("span");
  words.textContent = `${formatNumber(chapter.actual_words ?? 0)} 字`;
  item.append(title, status, words);
  const open = () => openChapterReader(chapter.chapter_no);
  item.addEventListener("click", open);
  item.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  });
  return item;
}

async function openChapterReader(chapterNo) {
  refs.readerTitle.textContent = `第 ${String(chapterNo).padStart(3, "0")} 章`;
  refs.readerMeta.textContent = "正在读取本章正文...";
  refs.readerBody.replaceChildren(renderReaderEmpty("读取中..."));
  refs.chapterReader.hidden = false;
  try {
    const data = await getJson(`/api/chapters/read?chapter=${encodeURIComponent(chapterNo)}`);
    refs.readerTitle.textContent = data.title ?? `第 ${String(chapterNo).padStart(3, "0")} 章`;
    refs.readerMeta.textContent = `${data.is_draft ? "草稿" : "正式章节"} · ${translateStage(data.status)} · ${formatNumber(data.actual_words)} 字 · ${String(data.format ?? "md").toUpperCase()}`;
    const paragraphs = String(data.content ?? "")
      .split(/\n{2,}/u)
      .map((block) => block.trim())
      .filter(Boolean);
    if (paragraphs.length === 0) {
      refs.readerBody.replaceChildren(renderReaderEmpty("本章正文为空。"));
      return;
    }
    refs.readerBody.replaceChildren(
      ...paragraphs.map((text) => {
        const paragraph = document.createElement("p");
        paragraph.textContent = text;
        return paragraph;
      })
    );
    refs.readerBody.scrollTop = 0;
  } catch (error) {
    refs.readerBody.replaceChildren(renderReaderEmpty(error.message));
    refs.readerMeta.textContent = "读取失败";
  }
}

function renderReaderEmpty(text) {
  const paragraph = document.createElement("p");
  paragraph.className = "reader-empty";
  paragraph.textContent = text;
  return paragraph;
}

function closeChapterReader() {
  refs.chapterReader.hidden = true;
}

function renderSkill(skill) {
  const item = document.createElement("li");
  item.className = "compact-item";
  const title = document.createElement("strong");
  title.textContent = skill.name;
  const meta = document.createElement("span");
  meta.textContent = `${skill.enabled_in_project ? "已启用" : "可启用"} · ${translateSkillType(skill.type)} · 优先级 ${skill.priority}`;
  const hooks = document.createElement("small");
  hooks.textContent = skill.hooks.map((hook) => `${translateStage(hook.stage)}:${translateHookAction(hook.action)}`).join(" / ") || "无钩子";
  const action = document.createElement("button");
  action.className = "small-button";
  action.type = "button";
  action.textContent = skill.enabled_in_project ? "禁用" : "启用";
  action.addEventListener("click", async () => {
    action.disabled = true;
    try {
      await postJson(skill.enabled_in_project ? "/api/skills/disable" : "/api/skills/enable", { name: skill.name });
      showToast(`技能已${skill.enabled_in_project ? "禁用" : "启用"}：${skill.name}`, "success");
      await loadAll();
    } catch (error) {
      showActionError(error);
    } finally {
      action.disabled = false;
    }
  });
  item.append(title, meta, hooks, action);
  return item;
}

function renderSource(source) {
  const item = document.createElement("li");
  item.className = "compact-item";
  const title = document.createElement("strong");
  title.textContent = source.title ?? source.file;
  const meta = document.createElement("span");
  meta.textContent = `${translateSourceKind(source.kind)} · ${source.untrusted ? "不可信资料" : "可信资料"} · ${source.warnings?.length ?? 0} 个警告`;
  item.append(title, meta);
  return item;
}

function renderListEmpty(text) {
  const item = document.createElement("li");
  item.className = "compact-item empty";
  item.textContent = text;
  return item;
}

function renderEvent(event) {
  const item = document.createElement("li");
  item.className = `event ${event.severity ?? "info"}`;
  const title = document.createElement("strong");
  title.textContent = translateEventType(event.type ?? "event");
  const meta = document.createElement("span");
  meta.className = "peek";
  meta.textContent = `${formatTime(event.timestamp)} · ${translateStage(event.stage ?? "-")} · ${event.message ?? ""}`;
  item.append(title, meta);
  return item;
}

function renderError(error) {
  refs.title.textContent = "读取失败";
  refs.seed.textContent = error.message;
  refs.projectOpenStatus.textContent = error.message;
  setStatus("blocked");
  ensureRefreshLoop(false);
  clearProjectData();
}

function clearProjectData() {
  refs.metricChapters.textContent = "0/0";
  refs.metricWords.textContent = "0";
  refs.percent.textContent = "0%";
  refs.progressBar.style.width = "0%";
  refs.modelName.textContent = "-";
  refs.currentModelPill.textContent = "模型未保存";
  refs.currentModelPill.title = "";
  refs.modelProfileSummary.replaceChildren();
  refs.budget.textContent = "-";
  refs.cost.textContent = "-";
  refs.cache.textContent = "-";
  refs.tokenSplit.textContent = "-";
  refs.checkpoint.textContent = "-";
  refs.dashboardHealth.textContent = "-";
  refs.networkPermission.textContent = "-";
  refs.safeEditPermission.textContent = "-";
  refs.sourceCount.textContent = "-";
  refs.sourceWarnings.textContent = "-";
  refs.reviewStatus.textContent = "-";
  refs.chapterList.replaceChildren();
  refs.dashboardFlow.replaceChildren();
  refs.feedList.replaceChildren(renderListEmpty("打开或新建项目后显示动态"));
  refs.activityTitle.textContent = "等待项目";
  refs.activityStage.textContent = "无项目";
  refs.activityProgressBar.style.width = "0%";
  refs.activityDetail.textContent = "新建或打开一部小说后，这里会显示工作流进度。";
  refs.activitySteps.replaceChildren();
  refs.eventList.replaceChildren();
  refs.skillList.replaceChildren();
  refs.sourceList.replaceChildren();
}

async function browseForCreatePath() {
  const picked = await window.wwritingDesktop?.selectProjectFolder?.();
  if (picked) {
    refs.createPath.value = picked;
  } else if (!window.wwritingDesktop?.selectProjectFolder) {
    showToast("预览环境请手动输入文件夹路径。", "info");
  }
}

async function openFromButton() {
  const picked = await window.wwritingDesktop?.selectProjectFolder?.();
  const target = picked || refs.createPath.value.trim();
  if (!target) {
    showToast("请选择一个本地项目文件夹，或从左侧列表选择小说。", "info");
    setView("create");
    refs.createPath.focus();
    return;
  }
  await openProject(target);
}

async function openProject(projectRoot) {
  if (!projectRoot) {
    return;
  }
  refs.projectOpen.disabled = true;
  refs.projectOpenStatus.textContent = "正在打开...";
  try {
    const result = await postJson("/api/projects/open", { projectRoot });
    currentProjectRoot = result.projectRoot;
    refs.projectOpenStatus.textContent = "";
    showToast("小说已打开。", "success");
    setView("studio");
    await loadAll();
  } catch (error) {
    refs.projectOpenStatus.textContent = "";
    if (error.code === "project_open_failed" && error.message.includes("不是有效的 WWriting 项目文件夹")) {
      refs.createPath.value = projectRoot;
      refs.createStatus.textContent = "该文件夹还不是 WWriting 项目，可在此初始化为新小说。";
      refs.createStatus.className = "form-status";
      setView("create");
      showToast("该文件夹不是项目，可初始化为新小说。", "info");
    } else {
      showActionError(error);
    }
  } finally {
    refs.projectOpen.disabled = false;
  }
}

async function initProject(projectRoot) {
  if (!projectRoot) {
    refs.createStatus.textContent = "请填写要保存到的本地文件夹路径。";
    refs.createStatus.className = "form-status error";
    return;
  }
  refs.createSubmit.disabled = true;
  refs.createStatus.textContent = "正在初始化项目...";
  refs.createStatus.className = "form-status";
  try {
    const minWords = Number(refs.createMinWords.value || 3000);
    const result = await postJson("/api/projects/init", {
      projectRoot,
      title: refs.createTitle.value.trim() || pathBaseName(projectRoot),
      story_seed: refs.createSeed.value.trim(),
      target_chapters: refs.createChapters.value,
      min_words_per_chapter: minWords,
      target_words_per_chapter: Math.max(minWords, 3300),
      output_format: "md"
    });
    currentProjectRoot = result.projectRoot;
    refs.createStatus.textContent = "项目已创建。可在下方命令栏发送指令开始写作。";
    refs.createStatus.className = "form-status success";
    showToast("小说已创建并打开。", "success");
    setView("studio");
    await loadAll();
  } catch (error) {
    refs.createStatus.textContent = error.message;
    refs.createStatus.className = "form-status error";
    showToast(error.message, "error");
  } finally {
    refs.createSubmit.disabled = false;
  }
}

function setStatus(status, stage = null) {
  const phase = agentPhaseLabel(status, stage);
  lastAgentStatusLabel = phase;
  refs.status.textContent = phase;
  refs.status.className = `status ${statusClass(status)}`;
  refs.sideStatus.textContent = phase;
  refs.statusDot.className = `dot ${statusClass(status)}`;
  updateComposerStatus(status, phase);
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

function updateComposerStatus(status, phase) {
  if (refs.composerStatusDot) {
    refs.composerStatusDot.className = `dot ${statusClass(status)}`;
  }
  if (refs.composerStatusText) {
    const tail = status === "running" ? "智能体正在工作" : currentProjectRoot ? "等待指令" : "新建或打开一部小说后开始";
    refs.composerStatusText.textContent = `${phase} · ${tail}`;
  }
}

async function getJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(data.message ?? "请求失败");
  }
  return data;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    const error = new Error(data.message ?? "请求失败");
    error.code = data.code;
    error.status = response.status;
    throw error;
  }
  return data;
}

async function runResearchAction(action) {
  const button = action === "search" ? refs.researchSearch : refs.researchFetch;
  button.disabled = true;
  try {
    if (action === "search") {
      await postJson("/api/research/search", { query: refs.researchQuery.value.trim(), limit: 5 });
      showToast("搜索完成，结果已保存为来源快照。", "success");
    } else {
      await postJson("/api/research/fetch", { url: refs.researchUrl.value.trim() });
      showToast("抓取完成，正文已保存为来源快照。", "success");
    }
    await loadDashboard();
  } catch (error) {
    showActionError(error);
  } finally {
    button.disabled = false;
  }
}

async function saveSettings() {
  const validationError = validateSettingsInputs();
  if (validationError) {
    refs.settingsStatus.textContent = validationError;
    refs.settingsStatus.className = "form-status error";
    return;
  }
  refs.settingsSave.disabled = true;
  const originalText = refs.settingsSave.textContent;
  refs.settingsSave.textContent = "保存中...";
  refs.settingsStatus.textContent = "正在写入当前项目的 project.yaml。";
  refs.settingsStatus.className = "form-status";
  try {
    const result = await postJson("/api/settings/update", {
      active_model: compactObject({
        provider: refs.settingProvider.value.trim(),
        model_name: refs.settingModel.value.trim(),
        base_url: refs.settingBaseUrl.value.trim(),
        api_key: refs.settingApiKey.value.trim(),
        api_key_env: refs.settingApiKeyEnv.value.trim(),
        max_output_tokens: refs.settingMaxOutput.value
      }),
      tool_permissions: { network_allowed: refs.settingNetwork.checked },
      budget_config: { max_model_calls: refs.settingMaxCalls.value },
      research_config: {
        search_endpoint: refs.settingSearchEndpoint.value.trim(),
        search_api_key_env: refs.settingSearchKeyEnv.value.trim()
      }
    });
    const profile = result.model_profile ?? modelProfileFromActiveModel(result.project?.active_model ?? {});
    renderModelProfileSummary(profile);
    refs.currentModelPill.textContent = profile.display;
    refs.currentModelPill.title = modelProfileTitle(profile);
    refs.settingsStatus.textContent = `已保存模型档案：${profile.display}；${profile.api_key_saved ? "API Key 已写入本机 secrets，可点小眼睛查看。" : "尚未保存 API Key。"} 项目文件只记录模型配置和变量名。`;
    refs.settingsStatus.className = "form-status success";
    showToast(`模型档案已保存：${profile.display}`, "success");
    updateEndpointPreview();
    await loadDashboard();
  } catch (error) {
    refs.settingsStatus.textContent = error.message;
    refs.settingsStatus.className = "form-status error";
    showToast(error.message, "error");
  } finally {
    refs.settingsSave.disabled = false;
    refs.settingsSave.textContent = originalText;
  }
}

function validateSettingsInputs() {
  const provider = refs.settingProvider.value.trim();
  const model = refs.settingModel.value.trim();
  const apiKeyEnv = refs.settingApiKeyEnv.value.trim();
  const searchKeyEnv = refs.settingSearchKeyEnv.value.trim();
  if (provider && model && provider === model && provider !== "mock") {
    return "供应商看起来填成了模型名。小米/DeepSeek 这类 OpenAI 兼容接口，供应商请填 openai-compatible，模型填右侧模型名。";
  }
  if (apiKeyEnv && !isEnvironmentVariableName(apiKeyEnv)) {
    return "密钥环境变量名只能使用字母、数字和下划线，并且不能以数字开头，例如 XIAOMI_MIMO_API_KEY。";
  }
  if (searchKeyEnv && !isEnvironmentVariableName(searchKeyEnv)) {
    return "搜索密钥环境变量名只能使用字母、数字和下划线，并且不能以数字开头。";
  }
  return "";
}

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

function setComposerMode(mode) {
  composerMode = COMPOSER_MODES[mode] ? mode : "main";
  refs.composerModes.forEach((button) => {
    button.classList.toggle("active", button.dataset.composerMode === composerMode);
  });
  refs.composerInput.placeholder = COMPOSER_MODES[composerMode].placeholder;
  updateComposerModeHint();
}

// 根据当前输入实时识别意图（如输入 /ask 自动提示按旁路询问发送）。
function updateComposerModeHint() {
  if (!refs.composerModeNote) {
    return;
  }
  const parsed = parseUserCommand(refs.composerInput.value, composerMode);
  let note = COMPOSER_MODES[composerMode].note;
  if (parsed.type === "side_question" && composerMode !== "side_question") {
    note = "已识别为旁路询问 · 不会修改正文或打断当前任务";
  } else if (parsed.type === "review" && composerMode !== "review") {
    note = "已识别为审稿指令";
  } else if (parsed.type === "side_question" && parsed.shouldAffectMainTask) {
    note = "旁路询问 · 检测到改设定诉求，回答后可确认是否转正式任务";
  }
  refs.composerModeNote.textContent = note;
  refs.composerModeNote.classList.toggle("is-side", parsed.type === "side_question");
}

async function submitComposer() {
  const parsed = parseUserCommand(refs.composerInput.value, composerMode);
  if (parsed.type === "empty") {
    showToast("请输入要提交的内容。", "info");
    return;
  }
  if (!currentProjectRoot) {
    showToast("请先新建或打开一部小说。", "info");
    setView("create");
    return;
  }
  if (parsed.type === "side_question") {
    if (!parsed.content) {
      showToast("请补充要提问的内容。", "info");
      return;
    }
    await submitSideQuestion(parsed.content);
    return;
  }
  await submitWritingCommand(parsed.content, parsed.type === "review" ? "review" : "write");
}

async function submitWritingCommand(message, mode, { fromSideQuestion = false } = {}) {
  refs.composerSubmit.disabled = true;
  try {
    const result = await postJson("/api/commands/submit", { message, mode, fromSideQuestion });
    refs.composerInput.value = "";
    autoGrowComposer();
    updateComposerModeHint();
    const commandMessage = resultMessageForCommand(result);
    showToast(commandMessage, result.blocked ? "error" : "success");
    setView("studio");
    ensureRefreshLoop(true);
    await loadDashboard();
  } catch (error) {
    showActionError(error);
  } finally {
    refs.composerSubmit.disabled = false;
  }
}

async function submitSideQuestion(question) {
  refs.composerSubmit.disabled = true;
  try {
    const result = await postJson("/api/commands/ask", { question });
    refs.composerInput.value = "";
    autoGrowComposer();
    updateComposerModeHint();
    pushAskEntry({
      question: result.question ?? question,
      answer: result.answer ?? "",
      mainTaskAffecting: result.mainTaskAffecting === true,
      suggestion: result.suggestion ?? null,
      answerMode: result.answerMode ?? "offline",
      askedAt: result.askedAt ?? new Date().toISOString(),
      promoted: false
    });
    setView("studio");
    showToast(
      result.mainTaskAffecting
        ? "旁路询问已回复：检测到会影响主线的修改建议，请在「旁路问答」确认是否转正式任务。"
        : "旁路询问已回复（未修改正文，也未打断写作）。",
      result.mainTaskAffecting ? "info" : "success"
    );
  } catch (error) {
    showActionError(error);
  } finally {
    refs.composerSubmit.disabled = false;
  }
}

function pushAskEntry(entry) {
  askHistory.unshift({ id: `ask-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ...entry });
  if (askHistory.length > 20) {
    askHistory.length = 20;
  }
  renderAskThread();
}

async function promoteAskEntry(entry) {
  if (!currentProjectRoot) {
    showToast("请先打开一部小说。", "info");
    return;
  }
  await submitWritingCommand(entry.question, "write", { fromSideQuestion: true });
  entry.promoted = true;
  renderAskThread();
  showToast("已将该修改建议转为正式写作任务。", "success");
}

function renderAskThread() {
  if (!refs.askThread) {
    return;
  }
  if (askHistory.length === 0) {
    refs.askThread.replaceChildren(renderListEmpty("还没有旁路询问。用底部「旁路询问」模式或 /ask 临时提问。"));
    return;
  }
  refs.askThread.replaceChildren(...askHistory.map(renderAskItem));
}

function renderAskItem(entry) {
  const item = document.createElement("li");
  item.className = `ask-item${entry.mainTaskAffecting ? " impact" : ""}`;

  const qRow = document.createElement("div");
  qRow.className = "ask-q-row";
  const tag = document.createElement("span");
  tag.className = "ask-tag";
  tag.textContent = entry.mainTaskAffecting ? "待确认变更" : "临时提问";
  const question = document.createElement("span");
  question.className = "ask-q peek";
  question.textContent = entry.question;
  const time = document.createElement("span");
  time.className = "ask-time";
  time.textContent = formatTime(entry.askedAt);
  qRow.append(tag, question, time);

  const answerWrap = document.createElement("div");
  answerWrap.className = "ask-a";
  const answerLabel = document.createElement("span");
  answerLabel.className = "ask-a-label";
  answerLabel.textContent = "临时提问回复";
  const answerBody = document.createElement("p");
  answerBody.className = "ask-a-body peek";
  answerBody.textContent = entry.answer || "（无回答）";
  answerWrap.append(answerLabel, answerBody);

  item.append(qRow, answerWrap);

  if (entry.mainTaskAffecting && !entry.promoted) {
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
      renderAskThread();
    });
    actions.append(promote, dismiss);
    confirm.append(text, actions);
    item.append(confirm);
  } else if (entry.promoted && entry.mainTaskAffecting) {
    const done = document.createElement("span");
    done.className = "ask-promoted";
    done.textContent = "已处理（已转为正式写作任务或标记为仅参考）";
    item.append(done);
  }
  return item;
}

function resultMessageForCommand(result) {
  if (result.alreadyRunning) {
    return "指令已记录；写作任务正在运行中。";
  }
  if (result.completed) {
    return "项目已完成；如需继续写，请先增加目标章节数。";
  }
  if (result.blocked) {
    return "项目已阻塞；请先到「运行」标签处理错误。";
  }
  if (result.started) {
    return "写作任务已开始。";
  }
  return result.message ?? "指令已记录。";
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

function autoGrowComposer() {
  const input = refs.composerInput;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 176)}px`;
}

function showActionError(error) {
  refs.projectOpenStatus.textContent = error.message;
  showToast(error.message, "error");
}

function showToast(message, type = "info") {
  if (!message || !refs.toastStack) {
    return;
  }
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  refs.toastStack.append(toast);
  const remove = () => {
    toast.classList.add("leaving");
    window.setTimeout(() => toast.remove(), 220);
  };
  window.setTimeout(remove, type === "error" ? 5200 : 3200);
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== "" && item !== undefined));
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value ?? 0));
}

function formatCompact(value) {
  const number = Number(value ?? 0);
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}K`;
  return formatNumber(number);
}

function formatMoney(value) {
  return `$${Number(value ?? 0).toFixed(6)}`;
}

function formatTime(value) {
  if (!value) {
    return "-";
  }
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function statusClass(value) {
  return String(value ?? "idle").replace(/[^a-z0-9_-]/giu, "-");
}

function pathEquals(a, b) {
  return String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
}

function pathBaseName(value) {
  return String(value ?? "").replace(/[\\/]+$/u, "").split(/[\\/]/u).pop();
}

function updateEndpointPreview() {
  const provider = refs.settingProvider.value.trim();
  const baseUrl = refs.settingBaseUrl.value.trim();
  if (provider === "mock") {
    refs.settingEndpointPreview.textContent = "完整请求地址：mock 供应商不需要基础 URL";
    return;
  }
  if (!baseUrl) {
    refs.settingEndpointPreview.textContent = "完整请求地址：未填写基础 URL";
    return;
  }
  refs.settingEndpointPreview.textContent = `完整请求地址：${resolveModelEndpoint(baseUrl)}`;
}

function resolveModelEndpoint(baseUrl) {
  try {
    return new URL("chat/completions", ensureTrailingSlash(baseUrl)).toString();
  } catch {
    return `${baseUrl.replace(/\/+$/u, "")}/chat/completions`;
  }
}

function ensureTrailingSlash(value) {
  return String(value).endsWith("/") ? String(value) : `${value}/`;
}

function isEnvironmentVariableName(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value);
}

function healthText(status) {
  return { loading: "读取中", idle: "待命", running: "运行中", completed: "健康", blocked: "需处理" }[status] ?? "待命";
}

function translateStatus(status) {
  return { loading: "读取中", idle: "待命", running: "运行中", completed: "已完成", blocked: "已阻塞" }[status] ?? status ?? "-";
}

function translateStage(stage) {
  return {
    "-": "-",
    queued: "排队",
    planned: "已规划",
    planning: "规划",
    drafting: "起草",
    reviewing: "审稿",
    revising: "修订",
    needs_revision: "需修订",
    finalizing: "定稿",
    summarizing: "摘要",
    completed: "完成",
    blocked: "阻塞",
    post_process: "后处理"
  }[stage] ?? stage;
}

function translateFlowState(state) {
  return { pending: "等待", running: "进行中", completed: "完成", blocked: "阻塞" }[state] ?? state;
}

function translateReviewStatus(status) {
  return { passed: "通过", failed: "失败" }[status] ?? status ?? "未运行";
}

function translateSkillType(type) {
  return { style: "风格", "flow-control": "流程", "quality-gate": "质检", "post-process": "后处理" }[type] ?? type;
}

function translateHookAction(action) {
  return { append_prompt: "追加提示", check: "检查", post_process: "后处理" }[action] ?? action;
}

function translateSourceKind(kind) {
  return { search: "搜索", fetch: "抓取", page: "网页", source: "资料" }[kind] ?? "资料";
}

function translateEventType(type) {
  return {
    project_created: "项目创建",
    project_run_started: "运行开始",
    project_run_finished: "运行结束",
    project_run_failed: "运行失败",
    project_run_skipped: "运行跳过",
    project_started: "开始运行",
    project_completed: "项目完成",
    project_blocked: "项目阻塞",
    checkpoint_written: "检查点",
    model_call_started: "模型调用开始",
    model_call_completed: "模型调用完成",
    model_usage_recorded: "用量记录",
    cache_report_updated: "缓存更新",
    chapter_queued: "章节排队",
    stage_started: "阶段开始",
    chapter_finalized: "章节定稿",
    chapter_completed: "章节完成",
    quality_gate_failed: "质检失败",
    tool_call_rejected: "工具调用拒绝",
    skill_configuration_changed: "技能配置",
    project_settings_updated: "设置更新",
    web_search_completed: "搜索完成",
    web_fetch_completed: "抓取完成",
    user_instruction_received: "用户指令"
  }[type] ?? type;
}
