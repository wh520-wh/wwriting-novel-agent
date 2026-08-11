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

// 失焦（change）自动保存：文本类输入统一走这里。base_url 带 http(s) 前缀校验，
// 不合法直接放弃保存（保持编辑态，不 toast 打断）。
function bindAutosave(input, field, apply) {
  input.addEventListener("change", () => {
    const value = input.value.trim();
    if (field === "base_url" && !/^https?:\/\/.+/u.test(value)) return;
    apply({ [field]: value }).catch(() => {});
  });
}

const API_BASE = "/api/settings/providers";

export function createModelSettingsPage(ctx = {}) {
  const { fetchImpl = fetch, documentRef = document, onChanged = () => {}, showToast = () => {}, confirmImpl = globalThis.confirm } = ctx;
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

  // 删除供应商：二次确认后才发 POST .../remove（同时删除其下全部模型）。
  // 成功后 refresh 重拉列表，被删供应商随 buildPageState 从列表移除。
  async function removeProviderWithConfirm(id) {
    const ok = (ctx.confirmImpl ?? globalThis.confirm)("删除供应商将同时删除其下全部模型，此操作不可撤销");
    if (!ok) return false;
    try {
      const res = await fetchImpl(`${API_BASE}/${id}/remove`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message ?? `HTTP ${res.status}`);
      await refresh();
      onChanged();
      return true;
    } catch (error) {
      showToast(`删除失败：${error?.message ?? "未知错误"}`, "error");
      return false;
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

    // 供应商名：h2 改为可编辑输入，失焦（change）自动保存。
    const nameInput = el("input", { value: provider.name, class: "provider-name", "data-field": "name" });
    bindAutosave(nameInput, "name", (patch) => saveProviderPatch(provider.id, patch));
    // 状态切换：文案即动作（enabled →「禁用」，disabled →「启用」），
    // 点击保存相反状态，refresh 重渲染后文案随新状态翻转。
    const statusToggle = el("button", {
      type: "button",
      class: "provider-status-toggle",
      text: provider.status === "enabled" ? "禁用" : "启用"
    });
    statusToggle.addEventListener("click", () => {
      saveProviderPatch(provider.id, {
        status: provider.status === "enabled" ? "disabled" : "enabled"
      });
    });
    // 删除（右上角垃圾桶）：二次确认后 POST .../remove。
    const deleteButton = el("button", { type: "button", class: "provider-delete", title: "删除供应商", text: "🗑" });
    deleteButton.addEventListener("click", () => {
      removeProviderWithConfirm(provider.id);
    });
    container.append(el("div", { class: "provider-detail-head" }, [nameInput, statusToggle, deleteButton]));

    container.append(el("label", { text: "Base URL" }));
    const baseUrlInput = el("input", { value: provider.base_url, "data-field": "base_url" });
    bindAutosave(baseUrlInput, "base_url", (patch) => saveProviderPatch(provider.id, patch));
    container.append(baseUrlInput);

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
    // 当前只支持 openai-chat-completions 落盘：值非法时回退到当前值并提示，
    // 不发无效 PATCH（其余选项渲染为 disabled 占位，此处是第二道防线）。
    formatSelect.addEventListener("change", () => {
      if (formatSelect.value !== "openai-chat-completions") {
        formatSelect.value = provider.api_format;
        showToast("当前仅支持 OpenAI Chat Completions 协议", "error");
        return;
      }
      saveProviderPatch(provider.id, { api_format: formatSelect.value });
    });
    container.append(formatSelect);

    container.append(el("label", { text: "API 密钥" }));
    const keyInput = el("input", { type: "password", value: "", "data-field": "api_key", placeholder: "粘贴密钥或填环境变量名" });
    // 双模式：形如环境变量名（字母/数字/下划线且非数字开头，与后端校验一致）→
    // 保存 api_key_env；否则视为粘贴的明文密钥 → api_key（后端落 secrets.json，
    // 响应不含明文）。明文保存后清空输入框，避免密钥滞留 DOM。
    keyInput.addEventListener("change", () => {
      const value = keyInput.value.trim();
      if (!value) return;
      const isEnvName = /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value);
      saveProviderPatch(provider.id, isEnvName ? { api_key_env: value } : { api_key: value });
      if (!isEnvName) keyInput.value = "";
    });
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
    removeProviderWithConfirm,
    _handlers: { saveProviderPatch, saveModelPatch, refresh, removeProviderWithConfirm }
  };
}
