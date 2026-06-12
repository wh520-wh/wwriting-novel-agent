import { icon } from "./icons.js";
import { compactObject, isEnvironmentVariableName, resolveModelEndpoint } from "./utils.js";
import { getJson, postJson, sendChatMessage } from "./api-client.js";
import { motion } from "./motion-runtime.js";

const PROVIDER_PRESETS = {
  deepseek: { title: "DeepSeek 官方", provider: "openai-compatible", baseUrl: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY", models: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat"] },
  mimo: { title: "小米 MiMo 官方", provider: "openai-compatible", baseUrl: "https://api.xiaomimimo.com/v1", apiKeyEnv: "XIAOMI_MIMO_API_KEY", models: ["mimo-v2.5-pro", "mimo-v2-pro"] },
  custom: { title: "自定义", provider: "openai-compatible", baseUrl: "", apiKeyEnv: "WWRITING_PROVIDER_API_KEY", models: ["custom-model"] }
};

const SETTINGS_PROVIDERS = [
  { id: "deepseek", name: "DeepSeek · 深度求索", short: "DS", color: "#4d6bfe", preset: "deepseek" },
  { id: "mimo", name: "小米 MiMo 官方", short: "Mi", color: "#ff6a00", preset: "mimo" },
  { id: "custom", name: "OpenAI 兼容 · 自定义", short: "AI", color: "#10a37f", preset: "custom" }
];

const SETTINGS_SECTIONS = [
  { id: "model", label: "模型与密钥", icon: "settings", ready: true },
  { id: "writing", label: "写作参数", icon: "compose", ready: true },
  { id: "gates", label: "质量门禁", icon: "check", ready: true },
  { id: "permissions", label: "权限与确认", icon: "help", ready: false, milestone: "Task 8" },
  { id: "research", label: "联网搜索", icon: "search", ready: true },
  { id: "danger", label: "危险区", icon: "bolt", ready: true }
];

export function createSettingsModal(ctx) {
  // ctx provides: refs, getDashboard, getCurrentProjectRoot, showToast, loadDashboard,
  //   getLastFocused, setLastFocused

  let settingsProviderId = "deepseek";
  let settingsSection = "model";
  const settingsFields = {};

  async function fetchModelSecret() {
    try {
      const data = await getJson("/api/settings/model-secret");
      return data.value ?? "";
    } catch {
      return "";
    }
  }

  async function fetchOutputStyles() {
    try {
      const data = await getJson("/api/output-styles");
      return Array.isArray(data.styles) ? data.styles : [];
    } catch (error) {
      console.warn("fetchOutputStyles failed:", error);
      return [
        { name: "creative", description: "创作模式", source: "bundled" },
        { name: "review", description: "审稿模式", source: "bundled" }
      ];
    }
  }

  function openSettingsModal() {
    const dashboard = ctx.getDashboard();
    if (dashboard?.project?.active_model) {
      settingsProviderId = detectProviderPreset(dashboard.project.active_model);
    }
    settingsSection = "model";
    ctx.refs.settingsSearch.value = "";
    renderSectionNav();
    renderSectionBody();
    ctx.setLastFocused(document.activeElement);
    ctx.refs.settingsScrim.removeAttribute("inert");
    ctx.refs.settingsScrim.classList.add("show");
    motion.openModal(ctx.refs.settingsScrim, document.querySelector("#settings-modal"));
    if (settingsSection === "model") ctx.refs.settingsSearch.focus();
  }

  function setSettingsSection(next) {
    if (!SETTINGS_SECTIONS.some((s) => s.id === next)) return;
    if (next === settingsSection) return;
    settingsSection = next;
    renderSectionNav();
    renderSectionBody();
  }

  function renderSectionNav() {
    const nav = document.getElementById("settings-section-nav");
    if (!nav) return;
    nav.replaceChildren(...SETTINGS_SECTIONS.map((section) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `sp-section-item${section.id === settingsSection ? " on" : ""}`;
      button.dataset.section = section.id;
      button.setAttribute("aria-current", section.id === settingsSection ? "true" : "false");
      button.setAttribute("aria-label", section.label);
      const ic = document.createElement("span");
      ic.className = "sp-section-ic";
      ic.append(icon(section.icon, 14));
      const label = document.createElement("span");
      label.textContent = section.label;
      button.append(ic, label);
      if (!section.ready) {
        const badge = document.createElement("span");
        badge.className = "sp-section-soon";
        badge.textContent = section.milestone ?? "稍后";
        button.append(badge);
      }
      button.addEventListener("click", () => setSettingsSection(section.id));
      return button;
    }));
    // Sync the data-section on the side container so CSS can hide provider list
    // for non-model sections.
    const side = nav.closest(".sp-side");
    if (side) side.dataset.section = settingsSection;
  }

  function renderSectionBody() {
    if (settingsSection === "model") {
      renderModelSection();
      ctx.refs.settingsSave.disabled = false;
      ctx.refs.settingsSave.textContent = "保存设置";
      return;
    }
    if (settingsSection === "writing") {
      renderWritingSection();
      ctx.refs.settingsSave.disabled = false;
      ctx.refs.settingsSave.textContent = "保存设置";
      return;
    }
    if (settingsSection === "gates") {
      renderGatesSection();
      ctx.refs.settingsSave.disabled = false;
      ctx.refs.settingsSave.textContent = "保存设置";
      return;
    }
    if (settingsSection === "research") {
      renderResearchSection();
      ctx.refs.settingsSave.disabled = false;
      ctx.refs.settingsSave.textContent = "保存设置";
      return;
    }
    if (settingsSection === "danger") {
      renderDangerSection();
      ctx.refs.settingsSave.disabled = false;
      ctx.refs.settingsSave.textContent = "保存设置";
      return;
    }
    renderStubSection(settingsSection);
    ctx.refs.settingsSave.disabled = true;
    ctx.refs.settingsSave.textContent = "保存设置";
  }

  function renderModelSection() {
    renderSettingsProviders();
    renderSettingsDetail();
  }

  async function renderWritingSection() {
    const dashboard = ctx.getDashboard();
    const project = dashboard?.project ?? {};
    ctx.refs.settingsDetail.replaceChildren();

    const head = document.createElement("header");
    head.className = "spd-head";
    const ic = document.createElement("span");
    ic.className = "spd-av lg";
    ic.append(icon("compose", 16));
    const h3 = document.createElement("h3");
    h3.textContent = "写作参数";
    head.append(ic, h3);
    ctx.refs.settingsDetail.append(head);

    const intro = document.createElement("p");
    intro.className = "spd-hint";
    intro.textContent = "控制每章的篇幅、目标章节数和输出风格。这些字段会直接进入 prompt 上下文。";
    ctx.refs.settingsDetail.append(intro);

    settingsFields.targetChapters = settingField("目标章节数（提高它可以继续已完成的小说）", "number", {
      value: project.target_chapters ?? ""
    });
    settingsFields.minWords = settingField("每章最低字数", "number", { value: project.min_words_per_chapter ?? "" });
    settingsFields.targetWords = settingField("每章目标字数", "number", { value: project.target_words_per_chapter ?? "" });
    settingsFields.maxWords = settingField("每章字数上限（留空 = 不限，按 target × 1.5 估算）", "number", {
      value: project.max_words_per_chapter ?? ""
    });

    // 输出风格下拉（从模型区平移）
    const currentOutputStyle = project.output_style ?? "creative";
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

    ctx.refs.settingsDetail.append(
      settingsFields.targetChapters.field,
      settingsFields.minWords.field,
      settingsFields.targetWords.field,
      settingsFields.maxWords.field,
      settingsFields.outputStyle.field
    );
  }

  function renderGatesSection() {
    const dashboard = ctx.getDashboard();
    const project = dashboard?.project ?? {};
    const memoryExtraction = project.memory_extraction ?? {};
    const factCheck = project.fact_check ?? {};
    ctx.refs.settingsDetail.replaceChildren();

    const head = document.createElement("header");
    head.className = "spd-head";
    const ic = document.createElement("span");
    ic.className = "spd-av lg";
    ic.append(icon("check", 16));
    const h3 = document.createElement("h3");
    h3.textContent = "质量门禁";
    head.append(ic, h3);
    ctx.refs.settingsDetail.append(head);

    const intro = document.createElement("p");
    intro.className = "spd-hint";
    intro.textContent = "本地门禁默认全开；这里可以关掉 memory extraction / fact-check，或让 fact-check 变成硬门禁。";
    ctx.refs.settingsDetail.append(intro);

    settingsFields.memoryExtractionEnabled = settingToggle("启用章节记忆抽取（每章自动落 facts / timeline）", memoryExtraction.enabled !== false);

    settingsFields.factCheckEnabled = settingToggle("启用 fact-check（基于既有 facts 比对新章节）", factCheck.enabled !== false);
    settingsFields.factCheckHard = settingToggle("fact-check 硬模式：发现设定矛盾直接打回修订", factCheck.hard === true);
    const factCheckHint = document.createElement("div");
    factCheckHint.className = "spd-hint";
    factCheckHint.textContent = "硬模式：发现设定矛盾直接打回修订。";
    factCheckHint.id = "settings-fact-check-hard-hint";

    // 内建只读门禁占位
    const titleGateRow = document.createElement("div");
    titleGateRow.className = "spd-field spd-toggle";
    const titleGateLabel = document.createElement("div");
    titleGateLabel.className = "spd-label";
    const titleGateSpan = document.createElement("span");
    titleGateSpan.textContent = "章节标题校验 · 内建始终开启";
    titleGateLabel.append(titleGateSpan);
    const titleGatePill = document.createElement("span");
    titleGatePill.className = "spd-hint mono";
    titleGatePill.textContent = "always-on";
    titleGateLabel.append(titleGatePill);
    titleGateRow.append(titleGateLabel);

    ctx.refs.settingsDetail.append(
      settingsFields.memoryExtractionEnabled.field,
      settingsFields.factCheckEnabled.field,
      settingsFields.factCheckHard.field,
      factCheckHint,
      titleGateRow
    );
  }

  function renderResearchSection() {
    const dashboard = ctx.getDashboard();
    const research = dashboard?.config?.effective?.research_config ?? dashboard?.project?.research_config ?? {};
    ctx.refs.settingsDetail.replaceChildren();

    const head = document.createElement("header");
    head.className = "spd-head";
    const ic = document.createElement("span");
    ic.className = "spd-av lg";
    ic.append(icon("search", 16));
    const h3 = document.createElement("h3");
    h3.textContent = "联网搜索";
    head.append(ic, h3);
    ctx.refs.settingsDetail.append(head);

    const intro = document.createElement("p");
    intro.className = "spd-hint";
    intro.textContent = "联网搜索走环境变量；只在这里登记 endpoint 和 key 变量名。";
    ctx.refs.settingsDetail.append(intro);

    settingsFields.searchEndpoint = settingField("联网搜索接口地址", "text", {
      value: research.search_endpoint ?? "",
      placeholder: "https://api.example.com/search"
    });
    settingsFields.searchKeyEnv = settingField("搜索密钥环境变量名", "text", {
      value: research.search_api_key_env ?? "",
      placeholder: "SEARCH_API_KEY"
    });

    ctx.refs.settingsDetail.append(
      settingsFields.searchEndpoint.field,
      settingsFields.searchKeyEnv.field
    );
  }

  function renderDangerSection() {
    const dashboard = ctx.getDashboard();
    const project = dashboard?.project ?? {};
    const projectRoot = ctx.getCurrentProjectRoot();
    const isArchived = Boolean(project.archived_at);
    ctx.refs.settingsDetail.replaceChildren();

    const head = document.createElement("header");
    head.className = "spd-head";
    const ic = document.createElement("span");
    ic.className = "spd-av lg";
    ic.append(icon("bolt", 16));
    const h3 = document.createElement("h3");
    h3.textContent = "危险区";
    head.append(ic, h3);
    ctx.refs.settingsDetail.append(head);

    const intro = document.createElement("p");
    intro.className = "spd-hint";
    intro.textContent = "高风险操作都在这里：归档/解除归档会进入对话确认链；打开项目文件夹走桌面桥。";
    ctx.refs.settingsDetail.append(intro);

    // 归档/解除归档
    const archiveHeading = document.createElement("h4");
    archiveHeading.className = "spd-section";
    archiveHeading.textContent = "项目归档";
    ctx.refs.settingsDetail.append(archiveHeading);

    const archiveField = document.createElement("div");
    archiveField.className = "spd-field spd-toggle";
    const archiveLabel = document.createElement("div");
    archiveLabel.className = "spd-label";
    const archiveSpan = document.createElement("span");
    archiveSpan.textContent = isArchived ? "项目已归档" : "项目状态：活跃";
    archiveLabel.append(archiveSpan);
    const archiveBtn = document.createElement("button");
    archiveBtn.type = "button";
    archiveBtn.className = "sp-btn";
    archiveBtn.id = isArchived ? "settings-unarchive-trigger" : "settings-archive-trigger";
    archiveBtn.textContent = isArchived ? "解除归档" : "归档此项目";
    archiveBtn.addEventListener("click", () => {
      closeSettingsModal();
      const message = isArchived ? "解除归档" : "归档这个项目";
      void sendChatMessage(message).catch((error) => ctx.showToast(error.message, "error"));
    });
    archiveField.append(archiveLabel, archiveBtn);
    settingsFields.archiveButton = { field: archiveField, input: archiveBtn };
    ctx.refs.settingsDetail.append(archiveField);

    const archiveHint = document.createElement("div");
    archiveHint.className = "spd-hint";
    archiveHint.textContent = isArchived
      ? "归档后只读；解除归档会走对话确认链，恢复 active 状态。"
      : "归档后项目进入只读态；通过对话链确认后写入 archived_at。";
    ctx.refs.settingsDetail.append(archiveHint);

    // 打开项目文件夹
    const folderHeading = document.createElement("h4");
    folderHeading.className = "spd-section";
    folderHeading.textContent = "项目文件夹";
    ctx.refs.settingsDetail.append(folderHeading);

    const folderField = document.createElement("div");
    folderField.className = "spd-field spd-toggle";
    const folderLabel = document.createElement("div");
    folderLabel.className = "spd-label";
    const folderSpan = document.createElement("span");
    folderSpan.textContent = projectRoot ?? "未选择项目";
    folderLabel.append(folderSpan);
    const folderBtn = document.createElement("button");
    folderBtn.type = "button";
    folderBtn.className = "sp-btn";
    folderBtn.id = "settings-open-folder";
    folderBtn.textContent = "打开项目文件夹";
    folderBtn.addEventListener("click", () => {
      if (!projectRoot) {
        ctx.showToast("请先新建或打开一部小说。", "info");
        return;
      }
      const reveal = window.wwritingDesktop?.revealPath;
      if (typeof reveal === "function") {
        void reveal(projectRoot).catch(() => ctx.showToast("打开项目文件夹失败。", "error"));
        return;
      }
      ctx.showToast("当前环境不支持打开文件夹（需要 Electron 桥）。", "info");
    });
    folderField.append(folderLabel, folderBtn);
    settingsFields.folderButton = { field: folderField, input: folderBtn };
    ctx.refs.settingsDetail.append(folderField);

    const folderHint = document.createElement("div");
    folderHint.className = "spd-hint";
    folderHint.textContent = "桌面端会调用 shell.openPath；预览环境会提示「需要 Electron 桥」。";
    ctx.refs.settingsDetail.append(folderHint);
  }

  function renderStubSection(sectionId) {
    const def = SETTINGS_SECTIONS.find((s) => s.id === sectionId);
    if (!def) return;
    // Clear any previously rendered detail
    ctx.refs.settingsDetail.replaceChildren();
    const stub = document.createElement("div");
    stub.className = "sp-stub";
    const tag = document.createElement("span");
    tag.className = "sp-stub-tag";
    tag.textContent = def.milestone ? `${def.milestone} 提供` : "稍后提供";
    const h3 = document.createElement("h3");
    h3.textContent = def.label;
    const p = document.createElement("p");
    p.textContent = `「${def.label}」分区的设置将在后续任务中提供。本任务先搭好 6 分区导航骨架。`;
    stub.append(tag, h3, p);
    ctx.refs.settingsDetail.append(stub);
  }

  function closeSettingsModal() {
    ctx.refs.settingsScrim.dataset.closing = "true";
    ctx.refs.settingsScrim.classList.remove("show");
    ctx.refs.settingsScrim.setAttribute("inert", "");
    motion.closeModal(ctx.refs.settingsScrim, document.querySelector("#settings-modal"), {
      onComplete: () => {
        delete ctx.refs.settingsScrim.dataset.closing;
        const lastFocused = ctx.getLastFocused();
        if (lastFocused && lastFocused.isConnected) lastFocused.focus();
        ctx.setLastFocused(null);
      }
    });
  }

  function renderSettingsProviders() {
    const q = ctx.refs.settingsSearch.value.trim().toLowerCase();
    const list = SETTINGS_PROVIDERS.filter((p) => p.name.toLowerCase().includes(q));
    ctx.refs.settingsProviderList.replaceChildren(...list.map((provider) => {
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
        renderSettingsDetail();
      });
      return button;
    }));
  }

  async function renderSettingsDetail() {
    const provider = SETTINGS_PROVIDERS.find((p) => p.id === settingsProviderId) ?? SETTINGS_PROVIDERS[0];
    const preset = PROVIDER_PRESETS[provider.preset];
    const dashboard = ctx.getDashboard();
    const active = dashboard?.project?.active_model ?? {};
    const profile = dashboard?.model_profile ?? {};
    const budgetConfig = dashboard?.config?.effective?.budget_config ?? dashboard?.project?.budget_config ?? {};
    const permissions = dashboard?.config?.effective?.tool_permissions ?? dashboard?.project?.tool_permissions ?? {};
    const usingThisPreset = detectProviderPreset(active) === provider.id;

    ctx.refs.settingsDetail.replaceChildren();
    const head = document.createElement("header");
    head.className = "spd-head";
    const av = document.createElement("span");
    av.className = "sp-av lg";
    av.style.background = provider.color;
    av.textContent = provider.short;
    const h3 = document.createElement("h3");
    h3.textContent = provider.name;
    head.append(av, h3);
    ctx.refs.settingsDetail.append(head);

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
    settingsFields.apiKey = settingField("API Key", "password", { placeholder: "粘贴官方 API Key", value: "", secret: true });
    settingsFields.apiKeyEnv = settingField("密钥环境变量名（不是密钥本身）", "text", {
      value: usingThisPreset && active.api_key_env ? active.api_key_env : preset.apiKeyEnv,
      placeholder: "XIAOMI_MIMO_API_KEY"
    });
    const keyHint = document.createElement("div");
    keyHint.className = "spd-hint";
    keyHint.textContent = "API Key 只保存在本机应用 secrets，项目文件只记录变量名。";
    settingsFields.maxCalls = settingField("模型调用上限", "number", { value: budgetConfig.max_model_calls ?? "" });
    const budgetHeading = document.createElement("h4");
    budgetHeading.className = "spd-section";
    budgetHeading.textContent = "预算上限";
    settingsFields.maxCost = settingField("成本上限（元，需先配置价格）", "number", { value: budgetConfig.max_cost ?? "" });
    settingsFields.maxTokens = settingField("token 总量上限", "number", { value: budgetConfig.max_total_tokens ?? "" });
    const priceHeading = document.createElement("h4");
    priceHeading.className = "spd-section";
    priceHeading.textContent = "价格（用于成本估算）";
    const pricing = active.pricing ?? {};
    settingsFields.priceInput = settingField("输入价（元/百万 token）", "number", { value: pricing.input_per_million ?? "" });
    settingsFields.priceOutput = settingField("输出价（元/百万 token）", "number", { value: pricing.output_per_million ?? "" });
    settingsFields.priceCacheHit = settingField("缓存命中价（元/百万 token，可选）", "number", { value: pricing.cache_hit_per_million ?? "" });
    const priceHint = document.createElement("div");
    priceHint.className = "spd-hint";
    priceHint.textContent = "按供应商定价页填写。不填则成本显示为未配置价格，不会按 0 计算。";
    settingsFields.network = settingToggle("联网搜索/抓取权限", permissions.network_allowed === true);
    const research = dashboard?.config?.effective?.research_config ?? dashboard?.project?.research_config ?? {};
    settingsFields.searchEndpoint = settingField("联网搜索接口地址", "text", { value: research.search_endpoint ?? "", placeholder: "https://api.example.com/search" });
    settingsFields.searchKeyEnv = settingField("搜索密钥环境变量名", "text", { value: research.search_api_key_env ?? "", placeholder: "SEARCH_API_KEY" });

    // 输出风格下拉(bundled + user + project)
    const currentOutputStyle = dashboard?.project?.output_style ?? "creative";
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

    const profileHeading = document.createElement("h4");
    profileHeading.className = "spd-section";
    profileHeading.textContent = "写作目标";
    settingsFields.profileTitle = settingField("小说名", "text", { value: dashboard?.project?.title ?? "" });
    settingsFields.targetChapters = settingField("目标章节数（提高它可以继续已完成的小说）", "number", { value: dashboard?.project?.target_chapters ?? "" });
    settingsFields.minWords = settingField("每章最低字数", "number", { value: dashboard?.project?.min_words_per_chapter ?? "" });

    ctx.refs.settingsDetail.append(
      settingsFields.model.field, settingsFields.baseUrl.field, endpointHint,
      settingsFields.apiKey.field, settingsFields.apiKeyEnv.field, keyHint,
      priceHeading, settingsFields.priceInput.field, settingsFields.priceOutput.field, settingsFields.priceCacheHit.field, priceHint,
      budgetHeading, settingsFields.maxCost.field, settingsFields.maxTokens.field, settingsFields.maxCalls.field,
      settingsFields.network.field,
      settingsFields.searchEndpoint.field, settingsFields.searchKeyEnv.field,
      settingsFields.outputStyle.field,
      profileHeading, settingsFields.profileTitle.field, settingsFields.targetChapters.field, settingsFields.minWords.field
    );
    bindEndpointPreview();
    updateEndpointPreview();

    if (usingThisPreset && profile.api_key_saved) {
      void fetchModelSecret().then((value) => {
        if (value && settingsFields.apiKey.input.isConnected && !settingsFields.apiKey.input.value) {
          settingsFields.apiKey.input.value = value;
        }
      });
    }
  }

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
        ctx.showToast("API Key 为空，没有可复制的内容。", "error");
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
        ctx.showToast("已复制 API Key 到剪贴板。", "success");
      } catch {
        ctx.showToast("复制失败：未授权访问剪贴板。", "error");
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

  function bindEndpointPreview() {
    if (settingsFields.baseUrl.input.dataset.boundPreview === "true") return;
    settingsFields.baseUrl.input.addEventListener("input", updateEndpointPreview);
    settingsFields.baseUrl.input.dataset.boundPreview = "true";
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
    if (settingsSection === "writing") {
      await saveWritingSection();
      return;
    }
    if (settingsSection === "gates") {
      await saveGatesSection();
      return;
    }
    if (settingsSection === "research") {
      await saveResearchSection();
      return;
    }
    if (settingsSection === "danger") {
      // 危险区不通过 settings/update 写：归档按钮已自行 close+sendChatMessage；此处兜底 toast 提示。
      ctx.showToast("危险区操作直接走对话链，请用上面的按钮。", "info");
      return;
    }
    await saveModelSection();
  }

  async function saveModelSection() {
    const provider = SETTINGS_PROVIDERS.find((p) => p.id === settingsProviderId) ?? SETTINGS_PROVIDERS[0];
    const apiKeyEnv = settingsFields.apiKeyEnv.input.value.trim();
    if (apiKeyEnv && !isEnvironmentVariableName(apiKeyEnv)) {
      ctx.showToast("密钥环境变量名只能用字母、数字、下划线，且不能以数字开头，例如 XIAOMI_MIMO_API_KEY。", "error");
      return;
    }
    const currentProjectRoot = ctx.getCurrentProjectRoot();
    if (!currentProjectRoot) {
      ctx.showToast("请先新建或打开一部小说，再保存模型设置。", "info");
      return;
    }
    await runSave(async () => {
      const result = await postJson("/api/settings/update", {
        active_model: compactObject({
          provider: PROVIDER_PRESETS[provider.preset].provider,
          model_name: settingsFields.model.input.value.trim(),
          base_url: settingsFields.baseUrl.input.value.trim(),
          api_key: settingsFields.apiKey.input.value.trim(),
          api_key_env: apiKeyEnv,
          pricing: settingsFields.priceInput.input.value && settingsFields.priceOutput.input.value
            ? compactObject({
                input_per_million: Number(settingsFields.priceInput.input.value),
                output_per_million: Number(settingsFields.priceOutput.input.value),
                cache_hit_per_million: settingsFields.priceCacheHit.input.value ? Number(settingsFields.priceCacheHit.input.value) : undefined
              })
            : undefined
        }),
        tool_permissions: { network_allowed: settingsFields.network.checked },
        budget_config: {
          max_model_calls: settingsFields.maxCalls.input.value,
          max_cost: settingsFields.maxCost.input.value,
          max_total_tokens: settingsFields.maxTokens.input.value
        },
        research_config: compactObject({
          search_endpoint: settingsFields.searchEndpoint.input.value.trim(),
          search_api_key_env: settingsFields.searchKeyEnv.input.value.trim()
        }),
        output_style: settingsFields.outputStyle?.input?.value ?? "creative",
        project_profile: compactObject({
          title: settingsFields.profileTitle.input.value.trim(),
          target_chapters: settingsFields.targetChapters.input.value,
          min_words_per_chapter: settingsFields.minWords.input.value
        }),
      });
      const profile = result.model_profile ?? {};
      ctx.showToast(`模型设置已保存：${profile.display ?? provider.name}`, "success");
      closeSettingsModal();
      await ctx.loadDashboard();
    });
  }

  async function saveWritingSection() {
    const currentProjectRoot = ctx.getCurrentProjectRoot();
    if (!currentProjectRoot) {
      ctx.showToast("请先新建或打开一部小说，再保存写作参数。", "info");
      return;
    }
    await runSave(async () => {
      await postJson("/api/settings/update", {
        project_profile: compactObject({
          target_chapters: settingsFields.targetChapters.input.value,
          min_words_per_chapter: settingsFields.minWords.input.value,
          target_words_per_chapter: settingsFields.targetWords.input.value,
          max_words_per_chapter: settingsFields.maxWords.input.value
        }),
        output_style: settingsFields.outputStyle?.input?.value ?? "creative"
      });
      ctx.showToast("写作参数已保存。", "success");
      closeSettingsModal();
      await ctx.loadDashboard();
    });
  }

  async function saveGatesSection() {
    const currentProjectRoot = ctx.getCurrentProjectRoot();
    if (!currentProjectRoot) {
      ctx.showToast("请先新建或打开一部小说，再保存质量门禁。", "info");
      return;
    }
    await runSave(async () => {
      await postJson("/api/settings/update", {
        memory_extraction: { enabled: settingsFields.memoryExtractionEnabled.checked },
        fact_check: {
          enabled: settingsFields.factCheckEnabled.checked,
          hard: settingsFields.factCheckHard.checked
        }
      });
      ctx.showToast("质量门禁已保存。", "success");
      closeSettingsModal();
      await ctx.loadDashboard();
    });
  }

  async function saveResearchSection() {
    const currentProjectRoot = ctx.getCurrentProjectRoot();
    if (!currentProjectRoot) {
      ctx.showToast("请先新建或打开一部小说，再保存联网搜索配置。", "info");
      return;
    }
    await runSave(async () => {
      await postJson("/api/settings/update", {
        research_config: compactObject({
          search_endpoint: settingsFields.searchEndpoint.input.value.trim(),
          search_api_key_env: settingsFields.searchKeyEnv.input.value.trim()
        })
      });
      ctx.showToast("联网搜索配置已保存。", "success");
      closeSettingsModal();
      await ctx.loadDashboard();
    });
  }

  async function runSave(fn) {
    ctx.refs.settingsSave.disabled = true;
    const originalText = ctx.refs.settingsSave.textContent;
    ctx.refs.settingsSave.textContent = "保存中...";
    try {
      await fn();
    } catch (error) {
      ctx.showToast(error.message, "error");
    } finally {
      ctx.refs.settingsSave.disabled = false;
      ctx.refs.settingsSave.textContent = originalText;
    }
  }

  function resetToCustom() {
    settingsProviderId = "custom";
    ctx.refs.settingsSearch.value = "";
    renderSettingsProviders();
    renderSettingsDetail();
  }

  return { openSettingsModal, closeSettingsModal, renderSettingsProviders, renderSettingsDetail, saveSettings, resetToCustom };
}
