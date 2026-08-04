import { icon } from "./icons.js";
import { compactObject, isEnvironmentVariableName, resolveModelEndpoint } from "./utils.js";
import { getJson, postJson, sendChatMessage } from "./api-client.js";
import { motion } from "./motion-runtime.js";
import { PERMISSION_TIERS, detectPermissionTier } from "./permission-tiers.mjs";
import { formatConnectionStatus, submitModelConnectionTest } from "./settings-connection.mjs";
import { fillOfficialPricing } from "../shared/official-pricing.mjs";

// Re-export so consumers that already `import { ... } from "./settings-modal.js"`
// continue to work. The pure helpers themselves live in ./settings-connection.mjs
// so they can be tested without DOM-bound modules.
export { formatConnectionStatus, submitModelConnectionTest } from "./settings-connection.mjs";

const PROVIDER_PRESETS = {
  deepseek: { title: "DeepSeek 官方", provider: "openai-compatible", baseUrl: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY", models: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat"] },
  mimo: { title: "小米 MiMo 官方", provider: "openai-compatible", baseUrl: "https://api.xiaomimimo.com/v1", apiKeyEnv: "XIAOMI_MIMO_API_KEY", models: ["mimo-v2.5-pro", "mimo-v2.5", "mimo-v2-pro"] },
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
  { id: "permissions", label: "权限与确认", icon: "help", ready: true },
  { id: "research", label: "联网搜索", icon: "search", ready: true },
  { id: "danger", label: "危险区", icon: "bolt", ready: true }
];


export function createSettingsModal(ctx, options = {}) {
  // ctx provides: refs, getDashboard, getCurrentProjectRoot, showToast, loadDashboard,
  //   getLastFocused, setLastFocused
  const {
    getJsonImpl = getJson,
    postJsonImpl = postJson,
  } = options;

  let settingsProviderId = "deepseek";
  let settingsSection = "model";
  // 模型清单来自全局（~/.wwriting/model-profiles.json），与项目无关。
  // 打开设置时拉一次，保存/删除/选用后刷新。
  let globalModels = { default_model: null, models: [] };
  const settingsFields = {};
  // connection-test state machine: "idle" | "testing" | "success" | "failure" | "aborted" | "saving"
  let connectionState = "idle";
  // Single in-flight AbortController per modal so closing/switching cancels cleanly.
  let connectionAbortController = null;
  // Preserve the API Key the user is currently typing when switching providers,
  // as long as the env name stays the same. Avoids carrying secrets across
  // different providers (different api_key_env).
  let lastTypedApiKey = "";
  let lastTypedApiKeyEnv = "";

  async function fetchModelSecret(envName) {
    try {
      const data = await getJsonImpl(`/api/settings/model-secret?env=${encodeURIComponent(envName ?? "")}`);
      return data.value ?? "";
    } catch {
      return "";
    }
  }

  // 拉取全局模型清单（Task 4 的 GET /api/settings/models）。失败时回到空清单，
  // 表单仍能用预设默认值渲染，不阻塞设置面板打开。
  async function fetchGlobalModels() {
    try {
      const result = await getJsonImpl("/api/settings/models");
      if (result?.ok) {
        globalModels = { default_model: result.default_model ?? null, models: result.models ?? [] };
      }
    } catch {
      globalModels = { default_model: null, models: [] };
    }
    return globalModels;
  }

  async function fetchOutputStyles() {
    try {
      const data = await getJsonImpl("/api/output-styles");
      return Array.isArray(data.styles) ? data.styles : [];
    } catch (error) {
      console.warn("fetchOutputStyles failed:", error);
      return [
        { name: "creative", description: "创作模式", source: "bundled" },
        { name: "review", description: "审稿模式", source: "bundled" }
      ];
    }
  }

  async function openSettingsModal() {
    settingsSection = "model";
    // 模型清单来自全局配置，与项目无关：先拉一次，没打开项目时表单也能显示已配好的模型。
    await fetchGlobalModels();
    const dashboard = ctx.getDashboard();
    // 有项目时以项目当前模型为准；没项目时退回全局默认模型。
    const activeModel = dashboard?.project?.active_model ?? globalModels.default_model;
    if (activeModel) {
      settingsProviderId = detectProviderPreset(activeModel);
    }
    // Cancel any in-flight test from a previous session and clear temporary state.
    resetConnectionState();
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
    if (settingsSection === "permissions") {
      renderPermissionsSection();
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

  function renderPermissionsSection() {
    const dashboard = ctx.getDashboard();
    const project = dashboard?.project ?? {};
    const projectRoot = ctx.getCurrentProjectRoot();
    const isArchived = Boolean(project.archived_at);
    ctx.refs.settingsDetail.replaceChildren();

    const head = document.createElement("header");
    head.className = "spd-head";
    const ic = document.createElement("span");
    ic.className = "spd-av lg";
    ic.append(icon("help", 16));
    const h3 = document.createElement("h3");
    h3.textContent = "权限与确认";
    head.append(ic, h3);
    ctx.refs.settingsDetail.append(head);

    const intro = document.createElement("p");
    intro.className = "spd-hint";
    intro.textContent = "四档单选；切档会立即同步到 composer 底部的权限标签，项目内不再二次确认。";
    ctx.refs.settingsDetail.append(intro);

    if (!projectRoot) {
      const noProj = document.createElement("div");
      noProj.className = "spd-hint";
      noProj.textContent = "请先新建或打开一部小说，再设置权限档。";
      ctx.refs.settingsDetail.append(noProj);
      settingsFields.permissionTier = null;
      return;
    }

    if (isArchived) {
      const archivedNote = document.createElement("div");
      archivedNote.className = "spd-hint";
      archivedNote.textContent = "项目已归档，权限模式不可改（始终为只读）。";
      ctx.refs.settingsDetail.append(archivedNote);
    }

    const radioGroup = document.createElement("div");
    radioGroup.className = "spd-radio-group";
    radioGroup.setAttribute("role", "radiogroup");
    radioGroup.setAttribute("aria-label", "权限模式");
    radioGroup.id = "settings-permission-tiers";

    const initialTier = isArchived ? "read_only" : detectPermissionTier(project.tool_permissions);
    settingsFields.permissionTier = { selected: initialTier, group: radioGroup };

    for (const tier of PERMISSION_TIERS) {
      const option = document.createElement("label");
      option.className = "spd-radio-option" + (tier.id === "yolo" ? " spd-radio-option--yolo" : "");
      option.setAttribute("data-tier-id", tier.id);

      const input = document.createElement("input");
      input.type = "radio";
      input.name = "permission-tier";
      input.value = tier.id;
      input.checked = tier.id === initialTier;
      input.disabled = isArchived;
      input.id = `settings-permission-tier-${tier.id}`;
      input.setAttribute("aria-describedby", `settings-permission-tier-${tier.id}-desc`);
      input.addEventListener("change", () => {
        if (input.checked && settingsFields.permissionTier) {
          settingsFields.permissionTier.selected = tier.id;
        }
        refreshPermissionTierOptions();
      });

      const tx = document.createElement("div");
      tx.className = "spd-radio-tx";
      const label = document.createElement("strong");
      label.textContent = tier.label;
      const desc = document.createElement("small");
      desc.id = `settings-permission-tier-${tier.id}-desc`;
      desc.textContent = tier.desc;
      tx.append(label, desc);
      option.append(input, tx);
      if (tier.id === "yolo" && tier.warn) {
        const warn = document.createElement("div");
        warn.className = "spd-radio-warn";
        warn.textContent = tier.warn;
        option.append(warn);
      }
      radioGroup.append(option);
    }
    ctx.refs.settingsDetail.append(radioGroup);
    refreshPermissionTierOptions();
  }

  function refreshPermissionTierOptions() {
    const group = document.getElementById("settings-permission-tiers");
    if (!group) return;
    const options = [...group.querySelectorAll(".spd-radio-option")];
    for (const opt of options) {
      const input = opt.querySelector('input[type="radio"]');
      opt.classList.toggle("spd-radio-option--on", Boolean(input?.checked));
    }
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
    // Closing the modal aborts any in-flight connection test and clears the
    // temporary key the user typed. Reopening will not prefill the secret.
    resetConnectionState();
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
    // 已存模型清单——比供应商预设优先展示。
    const savedSection = buildSavedModelSection(globalModels.models);
    ctx.refs.settingsProviderList.replaceChildren(savedSection);
  }

  // 私有：左栏清单 = 「已配置」已存模型（可选用/删除）+「新增供应商」模板入口。
  function buildSavedModelSection(models) {
    const frag = document.createDocumentFragment();
    if (models?.length > 0) {
      const heading = document.createElement("div");
      heading.className = "sp-list-heading";
      heading.textContent = "已配置";
      frag.append(heading);
      for (const model of models) {
        const row = document.createElement("div");
        row.className = "sp-saved-item";
        row.dataset.modelId = model.id;
        row.dataset.modelName = model.model_name;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "sp-saved-btn";
        btn.textContent = model.display ?? model.model_name;
        btn.addEventListener("click", () => { void selectSavedModel(model).catch((error) => ctx.showToast(error.message, "error")); });
        const del = document.createElement("button");
        del.type = "button";
        del.className = "sp-saved-del";
        del.setAttribute("aria-label", `删除 ${model.display ?? model.model_name}`);
        del.textContent = "×";
        del.addEventListener("click", (e) => { e.stopPropagation(); void deleteSavedModel(model.id).catch((error) => ctx.showToast(error.message, "error")); });
        row.append(btn, del);
        frag.append(row);
      }
      const divider = document.createElement("div");
      divider.className = "sp-list-heading";
      divider.textContent = "新增供应商";
      frag.append(divider);
    }
    // 原有静态供应商列表（DeepSeek / MiMo / 自定义），现在作为「新增」模板入口
    const q = ctx.refs.settingsSearch.value.trim().toLowerCase();
    const list = SETTINGS_PROVIDERS.filter((p) => p.name.toLowerCase().includes(q));
    for (const provider of list) {
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
      button.addEventListener("click", async () => {
        const previousEnv = settingsFields.apiKeyEnv?.input?.value ?? "";
        const previousKey = settingsFields.apiKey?.input?.value ?? "";
        settingsProviderId = provider.id;
        renderSettingsProviders();
        await renderSettingsDetail();
        // Restore the key the user was typing if the env name did not change.
        // Different env names mean different providers/keys, so we intentionally
        // leave the field empty there.
        if (previousEnv && previousKey && settingsFields.apiKeyEnv?.input?.value === previousEnv) {
          if (settingsFields.apiKey?.input && !settingsFields.apiKey.input.value) {
            settingsFields.apiKey.input.value = previousKey;
          }
        }
      });
      frag.append(button);
    }
    return frag;
  }

  // 选用已存模型：设为全局默认，并把它的字段回填到右侧表单。
  async function selectSavedModel(model) {
    await postJsonImpl("/api/settings/model-select", { model_id: model.id });
    await fetchGlobalModels();
    settingsProviderId = detectProviderPreset(model);
    renderSettingsProviders();
    await renderSettingsDetail();
  }

  // 删除已存模型：从全局清单移除，并同步刷新左栏列表与右侧表单，
  // 避免删除当前展示/默认模型后表单残留已删模型的字段（保存时把模型「复活」回清单）。
  async function deleteSavedModel(modelId) {
    await postJsonImpl("/api/settings/model-remove", { model_id: modelId });
    await fetchGlobalModels();
    renderSettingsProviders();
    await renderSettingsDetail();
  }

  async function renderSettingsDetail() {
    const provider = SETTINGS_PROVIDERS.find((p) => p.id === settingsProviderId) ?? SETTINGS_PROVIDERS[0];
    const preset = PROVIDER_PRESETS[provider.preset];
    const dashboard = ctx.getDashboard();
    // 模型字段优先用全局清单里的默认模型：没有项目时也要能显示已配好的模型。
    const globalDefault = globalModels.default_model;
    // globalDefault 是 buildModelProfile 的输出（app-server），已含本表单要用的
    // provider/model_name/base_url/api_key_env/pricing/temperature，无需再投影一份。
    const active = dashboard?.project?.active_model ?? globalDefault ?? {};
    const profile = dashboard?.model_profile ?? globalDefault ?? {};
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
    settingsFields.modelError = document.createElement("div");
    settingsFields.modelError.className = "spd-field-error";
    settingsFields.modelError.hidden = true;

    settingsFields.baseUrl = settingField("API 地址 · 基础 URL", "text", {
      value: usingThisPreset && active.base_url ? active.base_url : preset.baseUrl
    });
    settingsFields.baseUrlError = document.createElement("div");
    settingsFields.baseUrlError.className = "spd-field-error";
    settingsFields.baseUrlError.hidden = true;
    const endpointHint = document.createElement("div");
    endpointHint.className = "spd-hint";
    settingsFields.endpointHint = endpointHint;

    // 已保存的 key 按「正在编辑的供应商」的 env 回填进输入框：
    // 打开设置即可看到完整 key，可用眼睛按钮查看、复制按钮复制。
    // （本地个人使用，不做遮罩隐藏。）
    const apiKeyEnvValue = usingThisPreset && active.api_key_env ? active.api_key_env : preset.apiKeyEnv;
    const savedForEnv = (globalModels.models ?? []).find((model) => model.api_key_env && model.api_key_env === apiKeyEnvValue);
    const hasSavedKey = savedForEnv?.api_key_saved ?? (usingThisPreset && profile.api_key_saved);
    settingsFields.apiKey = settingField("API Key", "password", {
      placeholder: "粘贴官方 API Key",
      secret: true
    });
    if (hasSavedKey && apiKeyEnvValue) {
      fetchModelSecret(apiKeyEnvValue).then((savedKey) => {
        // 仅当用户还没有手动输入时回填，避免覆盖正在输入的内容。
        if (savedKey && settingsFields.apiKey?.input && !settingsFields.apiKey.input.value) {
          settingsFields.apiKey.input.value = savedKey;
        }
      });
    }
    settingsFields.apiKeyError = document.createElement("div");
    settingsFields.apiKeyError.className = "spd-field-error";
    settingsFields.apiKeyError.hidden = true;

    settingsFields.apiKeyEnv = settingField("密钥环境变量名（不是密钥本身）", "text", {
      value: apiKeyEnvValue,
      placeholder: "XIAOMI_MIMO_API_KEY"
    });
    settingsFields.apiKeyEnvError = document.createElement("div");
    settingsFields.apiKeyEnvError.className = "spd-field-error";
    settingsFields.apiKeyEnvError.hidden = true;

    const keyHint = document.createElement("div");
    keyHint.className = "spd-hint";
    keyHint.textContent = "API Key 只保存在本机应用 secrets，项目文件只记录变量名。";

    // 测试连接 状态行：放在密钥字段之后、密码提示之后。
    const connectionStatus = document.createElement("div");
    connectionStatus.id = "settings-connection-status";
    connectionStatus.className = "spd-connection-status";
    connectionStatus.setAttribute("role", "status");
    connectionStatus.setAttribute("aria-live", "polite");
    connectionStatus.dataset.state = connectionState;
    connectionStatus.textContent = "";
    settingsFields.connectionStatus = connectionStatus;

    // 测试连接 button lives next to the API Key field. We attach the click
    // handler below after the field is fully wired.
    const testRow = document.createElement("div");
    testRow.className = "spd-test-row";
    const testBtn = document.createElement("button");
    testBtn.type = "button";
    testBtn.id = "settings-test-connection";
    testBtn.className = "spd-test-connection";
    testBtn.textContent = "测试连接";
    testBtn.addEventListener("click", () => { void runConnectionTest(); });
    testRow.append(testBtn);
    settingsFields.testConnectionBtn = testBtn;

    settingsFields.maxCalls = settingField("模型调用上限", "number", { value: budgetConfig.max_model_calls ?? "", placeholder: "留空 = 不限" });
    const budgetHeading = document.createElement("h4");
    budgetHeading.className = "spd-section";
    budgetHeading.textContent = "预算上限";
    settingsFields.maxCost = settingField("成本上限（元，需先配置价格）", "number", { value: budgetConfig.max_cost ?? "" });
    settingsFields.maxTokens = settingField("token 总量上限", "number", { value: budgetConfig.max_total_tokens ?? "" });
    const priceHeading = document.createElement("h4");
    priceHeading.className = "spd-section";
    priceHeading.textContent = "价格（用于成本估算）";
    // 价格/温度跟随「表单当前展示的模型」：正在用且属于当前供应商预设 → 用已存值；
    // 否则（切供应商预览）→ 空，由官方价表自动带出，不把上一个模型的价错配过来。
    const pricing = usingThisPreset ? (active.pricing ?? {}) : {};
    settingsFields.priceInput = settingField("输入价（元/百万 token）", "number", { value: pricing.input_per_million ?? "" });
    settingsFields.priceOutput = settingField("输出价（元/百万 token）", "number", { value: pricing.output_per_million ?? "" });
    settingsFields.priceCacheHit = settingField("缓存命中价（元/百万 token，可选）", "number", { value: pricing.cache_hit_per_million ?? "" });
    const priceHint = document.createElement("div");
    priceHint.className = "spd-hint";
    priceHint.textContent = "按供应商定价页填写。不填则成本显示为未配置价格，不会按 0 计算。";
    settingsFields.temperature = settingField("写作温度（0–2，可选，留空用厂商默认）", "number", {
      value: usingThisPreset ? (active.temperature ?? "") : "",
      min: 0, max: 2, step: 0.1
    });
    settingsFields.temperatureError = document.createElement("div");
    settingsFields.temperatureError.className = "spd-field-error";
    settingsFields.temperatureError.hidden = true;
    settingsFields.network = settingToggle("联网搜索/抓取权限", permissions.network_allowed === true);

    const profileHeading = document.createElement("h4");
    profileHeading.className = "spd-section";
    profileHeading.textContent = "写作目标";
    settingsFields.profileTitle = settingField("小说名", "text", { value: dashboard?.project?.title ?? "" });

    ctx.refs.settingsDetail.append(
      settingsFields.model.field, settingsFields.modelError,
      settingsFields.baseUrl.field, settingsFields.baseUrlError, endpointHint,
      settingsFields.apiKey.field, settingsFields.apiKeyError, settingsFields.apiKeyEnv.field, settingsFields.apiKeyEnvError, keyHint,
      testRow, connectionStatus,
      priceHeading, settingsFields.priceInput.field, settingsFields.priceOutput.field, settingsFields.priceCacheHit.field, priceHint,
      settingsFields.temperature.field, settingsFields.temperatureError,
      budgetHeading, settingsFields.maxCost.field, settingsFields.maxTokens.field, settingsFields.maxCalls.field,
      settingsFields.network.field,
      profileHeading, settingsFields.profileTitle.field
    );
    bindEndpointPreview();
    updateEndpointPreview();
    bindOfficialPricingFill();
    applyConnectionButtonState();
  }

  function applyConnectionButtonState() {
    const testBtn = settingsFields.testConnectionBtn;
    const status = settingsFields.connectionStatus;
    const saveBtn = ctx.refs.settingsSave;
    if (!testBtn || !status) return;
    const busy = connectionState === "testing" || connectionState === "saving";
    testBtn.disabled = busy;
    saveBtn.disabled = busy;
    status.dataset.state = connectionState;
    if (connectionState === "testing") {
      testBtn.textContent = "正在连接…";
      status.textContent = "";
    } else if (connectionState === "saving") {
      testBtn.textContent = "测试连接";
      status.textContent = "";
    } else {
      testBtn.textContent = "测试连接";
    }
  }

  function setConnectionStatusFromResult(result) {
    const status = settingsFields.connectionStatus;
    if (!status) return;
    status.textContent = formatConnectionStatus(result);
    status.dataset.state = result?.ok ? "success" : "failure";
  }

  function clearConnectionStatus() {
    const status = settingsFields.connectionStatus;
    if (status) {
      status.textContent = "";
      status.dataset.state = "idle";
    }
  }

  function applyServerFields(errors) {
    const map = {
      model_name: settingsFields.modelError,
      base_url: settingsFields.baseUrlError,
      api_key: settingsFields.apiKeyError,
      api_key_env: settingsFields.apiKeyEnvError,
      temperature: settingsFields.temperatureError,
    };
    for (const key of Object.keys(map)) {
      const node = map[key];
      if (!node) continue;
      if (errors && typeof errors[key] === "string" && errors[key]) {
        node.textContent = errors[key];
        node.hidden = false;
      } else {
        node.textContent = "";
        node.hidden = true;
      }
    }
  }

  function resetConnectionState() {
    if (connectionAbortController) {
      try { connectionAbortController.abort(); } catch { /* ignore */ }
      connectionAbortController = null;
    }
    connectionState = "idle";
    applyConnectionButtonState();
    clearConnectionStatus();
  }

  async function runConnectionTest() {
    if (settingsSection !== "model") return;
    if (connectionState === "testing" || connectionState === "saving") return;
    applyServerFields(null);
    connectionState = "testing";
    applyConnectionButtonState();
    const controller = new AbortController();
    connectionAbortController = controller;
    const candidate = {
      provider: PROVIDER_PRESETS[SETTINGS_PROVIDERS.find((p) => p.id === settingsProviderId)?.preset ?? "custom"]?.provider ?? "openai-compatible",
      model_name: settingsFields.model.input.value.trim(),
      base_url: settingsFields.baseUrl.input.value.trim(),
      api_key_env: settingsFields.apiKeyEnv.input.value.trim(),
    };
    // Empty key field is intentional: when the user leaves it blank we trust
    // the server-side stored secret for the same env. The server re-checks
    // secrets and returns configuration_missing if neither is available.
    const temporaryKey = settingsFields.apiKey.input.value.trim();
    try {
      const result = await submitModelConnectionTest({
        postJsonImpl,
        // 没有项目也能测连接（Task 5 起服务端不再要求项目）；有项目时带上用于审计事件。
        projectRoot: ctx.getCurrentProjectRoot(),
        active_model: candidate,
        apiKey: temporaryKey,
        signal: controller.signal,
      });
      // Late-arriving guard: another call may have aborted us. Drop the
      // success/failure paint so we don't fight the latest user action.
      if (connectionAbortController !== controller) return;
      connectionState = "success";
      setConnectionStatusFromResult(result);
      applyServerFields(null);
      applyConnectionButtonState();
    } catch (error) {
      if (connectionAbortController !== controller) return;
      if (error?.name === "AbortError") {
        connectionState = "aborted";
        clearConnectionStatus();
      } else {
        connectionState = "failure";
        setConnectionStatusFromResult({ ok: false, message: error?.message ?? "连接失败" });
        if (error?.fields && typeof error.fields === "object") {
          applyServerFields(error.fields);
        }
      }
      applyConnectionButtonState();
    } finally {
      if (connectionAbortController === controller) connectionAbortController = null;
    }
  }

  function settingField(labelText, type, { value = "", placeholder = "", options = null, secret = false, min = null, max = null, step = null } = {}) {
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
      if (min !== null) input.min = min;
      if (max !== null) input.max = max;
      if (step !== null) input.step = step;
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

  // 选模型自动带出官方价：统一走 shared 的 fillOfficialPricing（与保存时补缺同一份规则）。
  // 两条触发路径：
  //  - 模型名变更（input / change）：overwrite=true——价格以模型名为准：
  //    匹配则整组重置为官方价，不匹配则清空（对空对象补缺结果就是空），
  //    避免把上一个模型的价错配给新模型保存出去。
  //  - 初始渲染（打开设置 / 切供应商 / 选用已保存模型）：overwrite=false——
  //    只补空缺字段，已保存或用户手填的值绝不覆盖。
  function bindOfficialPricingFill() {
    const input = settingsFields.model?.input;
    if (!input || input.dataset.boundPricingFill === "true") return;
    input.dataset.boundPricingFill = "true";
    const pairs = [
      [settingsFields.priceInput?.input, "input_per_million"],
      [settingsFields.priceOutput?.input, "output_per_million"],
      [settingsFields.priceCacheHit?.input, "cache_hit_per_million"]
    ];
    const applyOfficial = (overwrite) => {
      // 收集当前表单值作补缺基准；overwrite 时基准为空，结果即官方价整组（或未收录时的空）。
      const base = {};
      if (!overwrite) {
        for (const [field, key] of pairs) if (field?.value) base[key] = field.value;
      }
      const filled = fillOfficialPricing(input.value.trim(), "", base);
      for (const [field, key] of pairs) {
        if (!field) continue;
        const value = filled[key];
        if (overwrite || !field.value) field.value = value != null ? String(value) : "";
      }
    };
    input.addEventListener("input", () => applyOfficial(true));
    input.addEventListener("change", () => applyOfficial(true));
    applyOfficial(false);
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
    if (settingsSection === "permissions") {
      await savePermissionsSection();
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
    await runSave(async () => {
      // 第一步：模型配置存全局（~/.wwriting/model-profiles.json），不需要项目。
      // 服务端对 ModelConfigValidationError 一律回 400 + fields，postJson 会抛错携带 error.fields，
      // 因此校验失败在这里捕获：逐项标红后继续抛出，由 runSave 兜底 toast 展示服务端原文错误。
      let modelResult;
      try {
        const activeModelPayload = compactObject({
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
        });
        // 温度：留空不携带（厂商默认），填了才带。
        const tRaw = String(settingsFields.temperature?.input?.value ?? "").trim();
        if (tRaw !== "") activeModelPayload.temperature = Number(tRaw);
        modelResult = await postJsonImpl("/api/settings/model-profile", {
          active_model: activeModelPayload
        });
      } catch (error) {
        if (error?.fields && typeof error.fields === "object") {
          applyServerFields(error.fields);
        }
        throw error;
      }
      await fetchGlobalModels();

      // 第二步：项目专属设置（联网权限、预算、书名）——只在有项目时才发。
      const currentProjectRoot = ctx.getCurrentProjectRoot();
      if (currentProjectRoot) {
        await postJsonImpl("/api/settings/update", {
          tool_permissions: { network_allowed: settingsFields.network.checked },
          budget_config: {
            max_model_calls: settingsFields.maxCalls.input.value,
            max_cost: settingsFields.maxCost.input.value,
            max_total_tokens: settingsFields.maxTokens.input.value
          },
          project_profile: compactObject({
            title: settingsFields.profileTitle?.input?.value?.trim()
          })
        });
      }

      const profile = modelResult.model_profile ?? {};
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
      await postJsonImpl("/api/settings/update", {
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
      await postJsonImpl("/api/settings/update", {
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
      await postJsonImpl("/api/settings/update", {
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

  async function savePermissionsSection() {
    const currentProjectRoot = ctx.getCurrentProjectRoot();
    if (!currentProjectRoot) {
      ctx.showToast("请先新建或打开一部小说，再保存权限设置。", "info");
      return;
    }
    const tierField = settingsFields.permissionTier;
    if (!tierField) {
      ctx.showToast("请先选择权限档。", "info");
      return;
    }
    const tier = PERMISSION_TIERS.find((t) => t.id === tierField.selected) ?? PERMISSION_TIERS[1];
    if (tier.id === "yolo") {
      const confirmYolo = window.confirm(
        "全程自动模式会自动执行所有写与控制操作，包括章节编辑、设定更新和任务控制。\n确定要开启全程自动模式吗？"
      );
      if (!confirmYolo) return;
    }
    await runSave(async () => {
      await postJsonImpl("/api/settings/update", {
        tool_permissions: tier.combo
      });
      closeSettingsModal();
      await ctx.loadDashboard();
      // 与 composer.applyTier 一致：用 mode pill 脉冲代替成功 toast，避免噪音。
      document.getElementById("mode-pill")?.classList.add("cbar-pill--pulse");
      window.setTimeout(() => document.getElementById("mode-pill")?.classList.remove("cbar-pill--pulse"), 400);
    });
  }

  async function runSave(fn) {
    ctx.refs.settingsSave.disabled = true;
    const originalText = ctx.refs.settingsSave.textContent;
    ctx.refs.settingsSave.textContent = "保存中...";
    const previousState = connectionState;
    connectionState = "saving";
    applyConnectionButtonState();
    try {
      await fn();
    } catch (error) {
      ctx.showToast(error.message, "error");
    } finally {
      ctx.refs.settingsSave.disabled = false;
      ctx.refs.settingsSave.textContent = originalText;
      connectionState = previousState === "testing" ? "testing" : "idle";
      applyConnectionButtonState();
    }
  }

  function resetToCustom() {
    settingsProviderId = "custom";
    ctx.refs.settingsSearch.value = "";
    renderSettingsProviders();
    renderSettingsDetail();
  }

  return {
    openSettingsModal, closeSettingsModal, renderSettingsProviders, renderSettingsDetail, saveSettings, resetToCustom,
    // 仅供测试：直接回填模型表单字段（避免测试里模拟 DOM 输入）。
    setModelFieldsForTest(values = {}) {
      if (settingsFields.model) settingsFields.model.input.value = values.model_name ?? "";
      if (settingsFields.baseUrl) settingsFields.baseUrl.input.value = values.base_url ?? "";
      if (settingsFields.apiKey) settingsFields.apiKey.input.value = values.api_key ?? "";
      if (settingsFields.apiKeyEnv) settingsFields.apiKeyEnv.input.value = values.api_key_env ?? "";
    },
    // 仅供测试：直接触发保存（等价于点「保存设置」）。
    saveSettingsForTest() {
      return saveSettings();
    },
    // 仅供测试：读取左栏已配置模型清单（每项带 modelName / modelId 与按钮节点）。
    getSavedModelItems() {
      return [...ctx.refs.settingsProviderList.children]
        .filter((el) => el.className === "sp-saved-item")
        .map((row) => ({
          modelName: row.dataset.modelName ?? row.dataset.modelId ?? "",
          modelId: row.dataset.modelId ?? "",
          btn: [...row.children].find((c) => c.className === "sp-saved-btn") ?? null,
          del: [...row.children].find((c) => c.className === "sp-saved-del") ?? null
        }));
    },
    // 仅供测试：点击某个已保存模型（等异步选用链完成后返回）。
    async clickSavedModel(modelName) {
      const item = this.getSavedModelItems().find((it) => it.modelName === modelName);
      if (!item?.btn) throw new Error(`未找到已保存模型：${modelName}`);
      item.btn.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    // 仅供测试：点击某个已保存模型的删除按钮（等异步删除链完成后返回）。
    async deleteSavedModel(modelName) {
      const item = this.getSavedModelItems().find((it) => it.modelName === modelName);
      if (!item?.del) throw new Error(`未找到已保存模型的删除按钮：${modelName}`);
      item.del.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    // 仅供测试：读取模型表单字段值（model_name / base_url / api_key / api_key_env）。
    getModelFieldValue(fieldName) {
      const byName = {
        model_name: settingsFields.model,
        base_url: settingsFields.baseUrl,
        api_key: settingsFields.apiKey,
        api_key_env: settingsFields.apiKeyEnv
      };
      return byName[fieldName]?.input?.value ?? "";
    }
  };
}
