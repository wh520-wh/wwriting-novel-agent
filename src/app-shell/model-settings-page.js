// src/app-shell/model-settings-page.js
// 模型设置页面：左列表 + 右详情。纯逻辑导出便于 node:test；
// DOM 渲染用最小 document.createElement（真实环境用 document，测试用 mock）。

export function pickProvider(providers, id) {
  return providers.find((p) => p.id === id) ?? null;
}
export function visibleModels(provider) {
  return provider?.models.filter((m) => m.enabled !== false) ?? [];
}
export function buildPageState(providers, selectedId) {
  const selected = pickProvider(providers, selectedId) ?? providers[0] ?? null;
  return { providers, selected };
}

const API_BASE = "/api/settings/providers";

export function createModelSettingsPage(ctx = {}) {
  const { fetchImpl = fetch, documentRef = document, onChanged = () => {} } = ctx;
  let state = { providers: [], selected: null };

  async function refresh() {
    const res = await fetchImpl(`${API_BASE}`);
    const data = await res.json();
    state = buildPageState(data.providers, state.selected?.id ?? null);
    render();
    return state;
  }

  async function saveProviderPatch(id, patch) {
    await fetchImpl(`${API_BASE}/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch)
    });
    await refresh();
    onChanged();
  }

  async function saveModelPatch(providerId, modelId, patch) {
    await fetchImpl(`${API_BASE}/${providerId}/models/${modelId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch)
    });
    await refresh();
    onChanged();
  }

  function el(tag, props = {}, children = []) {
    const node = documentRef.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "text") node.textContent = value;
      else if (key === "class") node.className = value;
      else node.setAttribute(key, value);
    }
    for (const child of children) {
      if (typeof child === "string") node.append(documentRef.createTextNode(child));
      else if (child) node.append(child);
    }
    return node;
  }

  function renderList(container) {
    container.replaceChildren();
    container.append(el("h3", { text: "我的供应商" }));
    for (const provider of state.providers) {
      const item = el("div", { class: `provider-item ${provider.id === state.selected?.id ? "selected" : ""}`, "data-provider-id": provider.id }, [
        el("span", { text: provider.name }),
        el("span", { class: `status-dot ${provider.status === "enabled" ? "on" : "off"}` })
      ]);
      item.addEventListener("click", () => {
        state = buildPageState(state.providers, provider.id);
        render();
      });
      container.append(item);
    }
    container.append(el("button", { class: "add-provider", text: "+ 添加供应商" }));
  }

  function renderDetail(container) {
    container.replaceChildren();
    const provider = state.selected;
    if (!provider) { container.append(el("p", { text: "还没有供应商，先添加一个。" })); return; }
    container.append(el("h2", { text: provider.name }));
    container.append(el("label", { text: "Base URL" }));
    container.append(el("input", { value: provider.base_url, "data-field": "base_url" }));
    container.append(el("label", { text: "API 接口协议" }));
    const formatSelect = el("select", { "data-field": "api_format" });
    for (const [value, label, disabled] of [
      ["openai-chat-completions", "OpenAI Chat Completions", false],
      ["anthropic-messages", "Anthropic Messages", true],
      ["openai-responses", "OpenAI Responses API", true],
      ["gemini-generate-content", "Gemini Native generateContent", true]
    ]) {
      const option = el("option", { value, text: label });
      if (disabled) option.disabled = true;
      formatSelect.append(option);
    }
    formatSelect.value = provider.api_format;
    container.append(formatSelect);
    container.append(el("label", { text: "API 密钥" }));
    const keyInput = el("input", { type: "password", value: "", "data-field": "api_key", placeholder: "粘贴密钥或填环境变量名" });
    const eye = el("button", { text: "👁" });
    eye.addEventListener("click", () => {
      keyInput.type = keyInput.type === "password" ? "text" : "password";
    });
    container.append(keyInput, eye);
    container.append(el("h4", { text: "模型列表" }));
    for (const model of provider.models) {
      container.append(el("div", { class: "model-row", "data-model-id": model.id }, [
        el("input", { value: model.model_name, "data-field": "model_name" }),
        el("span", { text: model.enabled === false ? "已停用" : "已启用" }),
        el("button", { text: "测试连接" }),
        el("button", { text: "删除" })
      ]));
    }
  }

  function render() {
    const list = documentRef.querySelector?.("[data-provider-list]");
    const detail = documentRef.querySelector?.("[data-provider-detail]");
    if (list) renderList(list);
    if (detail) renderDetail(detail);
  }

  return {
    async open() { await refresh(); },
    close() {},
    refresh,
    getState: () => state,
    renderList,
    renderDetail,
    saveProviderPatch,
    saveModelPatch,
    _handlers: { saveProviderPatch, saveModelPatch, refresh }
  };
}
