import { icon } from "./icons.js";
import { compactObject, isEnvironmentVariableName, resolveModelEndpoint } from "./utils.js";
import { getJson, postJson } from "./api-client.js";
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

export function createSettingsModal(ctx) {
  // ctx provides: refs, getDashboard, getCurrentProjectRoot, showToast, loadDashboard,
  //   getLastFocused, setLastFocused

  let settingsProviderId = "deepseek";
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
    ctx.refs.settingsSearch.value = "";
    renderSettingsProviders();
    renderSettingsDetail();
    ctx.setLastFocused(document.activeElement);
    ctx.refs.settingsScrim.removeAttribute("inert");
    ctx.refs.settingsScrim.classList.add("show");
    ctx.refs.settingsSearch.focus();
    motion.openModal(ctx.refs.settingsScrim, document.querySelector("#settings-modal"));
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
      settingsFields.maxCalls.field, settingsFields.network.field,
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
    ctx.refs.settingsSave.disabled = true;
    const originalText = ctx.refs.settingsSave.textContent;
    ctx.refs.settingsSave.textContent = "保存中...";
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
