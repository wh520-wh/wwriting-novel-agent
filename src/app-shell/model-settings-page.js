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
  const { fetchImpl = fetch, documentRef = document, onChanged = () => {}, showToast = () => {} } = ctx;
  let state = { providers: [], selected: null };

  // 加载失败路径：保留上一次可用状态，只 toast 不抛错——open() 随之正常 resolve，
  // 避免 Task 13-15 挂到本页后遇到未处理拒绝（页面停在旧状态而非空着报错）。
  async function refresh() {
    try {
      const res = await fetchImpl(`${API_BASE}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data?.providers)) throw new Error("响应缺少 providers 数组");
      state = buildPageState(data.providers, state.selected?.id ?? null);
      render();
    } catch (error) {
      showToast(`模型列表加载失败：${error?.message ?? "未知错误"}`, "error");
    }
    return state;
  }

  async function saveProviderPatch(id, patch) {
    try {
      const res = await fetchImpl(`${API_BASE}/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch)
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message ?? `HTTP ${res.status}`);
      await refresh();
      onChanged();
    } catch (error) {
      // 保存失败：保留当前状态并 toast，不刷新（避免用旧数据覆盖新状态）。
      showToast(`保存失败：${error?.message ?? "未知错误"}`, "error");
    }
  }

  async function saveModelPatch(providerId, modelId, patch) {
    try {
      const res = await fetchImpl(`${API_BASE}/${providerId}/models/${modelId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch)
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message ?? `HTTP ${res.status}`);
      await refresh();
      onChanged();
    } catch (error) {
      // 保存失败：保留当前状态并 toast，不刷新（避免用旧数据覆盖新状态）。
      showToast(`保存失败：${error?.message ?? "未知错误"}`, "error");
    }
  }

  function el(tag, props = {}, children = []) {
    const node = documentRef.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "text") node.textContent = value;
      else if (key === "class") node.className = value;
      else if (key === "value") node.value = value; // value 走 property 而非 setAttribute：保住用户已键入的值
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
    container.append(el("button", { class: "add-provider", type: "button", disabled: true, title: "Task 13-15 实现", text: "+ 添加供应商" }));
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
    const eye = el("button", { type: "button", title: "显示/隐藏密钥", text: "👁" });
    eye.addEventListener("click", () => {
      keyInput.type = keyInput.type === "password" ? "text" : "password";
    });
    container.append(keyInput, eye);
    container.append(el("h4", { text: "模型列表" }));
    for (const model of provider.models) {
      container.append(el("div", { class: "model-row", "data-model-id": model.id }, [
        el("input", { value: model.model_name, "data-field": "model_name" }),
        el("span", { text: model.enabled === false ? "已停用" : "已启用" }),
        el("button", { type: "button", disabled: true, title: "Task 13-15 实现", text: "测试连接" }),
        el("button", { type: "button", disabled: true, title: "Task 13-15 实现", text: "删除" })
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
