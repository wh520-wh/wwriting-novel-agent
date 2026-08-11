// src/app-shell/model-settings-page.js
// 模型设置页面：左列表 + 右详情。纯逻辑导出便于 node:test；
// DOM 渲染用最小 document.createElement（真实环境用 document，测试用 mock）。

import { isEnvironmentVariableName } from "./utils.js";

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
    if (!value) return; // 空值不保存（与密钥框守卫一致）
    if (field === "base_url" && !/^https?:\/\/.+/u.test(value)) return;
    apply({ [field]: value }); // saveProviderPatch 内部 catch 并返回布尔，不会产生未处理拒绝
  });
}

const API_BASE = "/api/settings/providers";

// 模块级纯函数：便于单测（页内 setDefaultModel 包装它做 res.ok 检查 + refresh + toast）。
export async function setDefaultModelImpl(fetchImpl, providerId, modelId) {
  return fetchImpl(`${API_BASE}/${providerId}/models/${modelId}/default`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
}

export function createModelSettingsPage(ctx = {}) {
  const { fetchImpl = fetch, documentRef = document, onChanged = () => {}, showToast = () => {}, confirmImpl = globalThis.confirm } = ctx;
  let state = { providers: [], selected: null, default_model: null };

  // 加载失败路径：保留上一次可用状态，只 toast 不抛错——open() 随之正常 resolve，
  // 避免 Task 13-15 挂到本页后遇到未处理拒绝（页面停在旧状态而非空着报错）。
  async function refresh() {
    try {
      const res = await fetchImpl(`${API_BASE}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data?.providers)) throw new Error("响应缺少 providers 数组");
      // default_model（GET 响应顶层字段，{ provider_id, model_id } 对象或 null）
      // 一并入 state：renderDetail 据此给默认模型行渲染「默认」角标。
      state = { ...buildPageState(data.providers, state.selected?.id ?? null), default_model: data.default_model ?? null };
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
      return true;
    } catch (error) {
      // 保存失败：保留当前状态并 toast，不刷新（避免用旧数据覆盖新状态）。
      // 无环境变量名的供应商直接粘贴明文密钥会命中后端 invalid_api_key_env（400）：
      // 此时给出更明确的引导，其余错误保留通用文案。
      if (error?.message?.includes("API 密钥环境变量名")) {
        showToast("请先填写 API 密钥环境变量名（在密钥框输入如 MY_KEY 并回车保存），再粘贴密钥。", "error");
      } else {
        showToast(`保存失败：${error?.message ?? "未知错误"}`, "error");
      }
      return false;
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
      return true;
    } catch (error) {
      // 保存失败：保留当前状态并 toast，不刷新（避免用旧数据覆盖新状态）。
      showToast(`保存失败：${error?.message ?? "未知错误"}`, "error");
      return false;
    }
  }

  // 删除供应商：二次确认后才发 POST .../remove（同时删除其下全部模型）。
  // 成功后 refresh 重拉列表，被删供应商随 buildPageState 从列表移除。
  async function removeProviderWithConfirm(id) {
    const ok = confirmImpl("删除供应商将同时删除其下全部模型，此操作不可撤销");
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

  // 默认模型角标判定：state.default_model 来自 GET 响应顶层字段，为
  // { provider_id, model_id } 对象（v2 存储形态）或历史字符串 "providerId/modelId"。
  function isDefaultModel(providerId, modelId) {
    const dm = state.default_model;
    if (!dm) return false;
    if (typeof dm === "string") return dm === `${providerId}/${modelId}`;
    return dm.provider_id === providerId && dm.model_id === modelId;
  }

  // 设为默认：POST .../default（走模块级 setDefaultModelImpl 便于单测），成功后
  // refresh 重拉列表（default_model 随之更新，角标重渲染）+ onChanged。
  async function setDefaultModel(providerId, modelId) {
    try {
      const res = await setDefaultModelImpl(fetchImpl, providerId, modelId);
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message ?? `HTTP ${res.status}`);
      await refresh();
      onChanged();
      return true;
    } catch (error) {
      showToast(`设置默认模型失败：${error?.message ?? "未知错误"}`, "error");
      return false;
    }
  }

  // 删除模型：二次确认后才发 POST .../remove（后端会把默认指针转移/清空）。
  // 成功后 refresh 重拉列表；被删模型随 renderDetail 从列表移除。
  async function removeModelWithConfirm(providerId, modelId) {
    const ok = confirmImpl("删除后引用它的项目将自动改用默认模型，此操作不可撤销");
    if (!ok) return false;
    try {
      const res = await fetchImpl(`${API_BASE}/${providerId}/models/${modelId}/remove`, {
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

  // 添加模型：POST .../models 建一个可编辑默认名的新模型，创建后 refresh + toast。
  // 模型名留空/拉取由 Task 15 的行内编辑接手，此处先给最小可改的落点。
  async function addModel(providerId) {
    try {
      const res = await fetchImpl(`${API_BASE}/${providerId}/models`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model_name: "new-model", enabled: true })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message ?? `HTTP ${res.status}`);
      await refresh();
      onChanged();
      showToast("已添加模型，可在名称框直接改名后回车保存", "success");
      return true;
    } catch (error) {
      showToast(`添加模型失败：${error?.message ?? "未知错误"}`, "error");
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
    // 响应不含明文）。
    keyInput.addEventListener("change", async () => {
      const value = keyInput.value.trim();
      if (!value) return;
      // 契约：后端仅把密钥写入已有 api_key_env 对应的 bucket；无环境变量名的供应商
      // 直接粘贴明文密钥会 400（toast 提示「请先填写 API 密钥环境变量名。」），
      // 应先保存环境变量名再粘贴密钥。Task 15 的添加供应商表单会把环境变量名作为必填项。
      const isEnvName = isEnvironmentVariableName(value);
      if (isEnvName) {
        saveProviderPatch(provider.id, { api_key_env: value });
        return; // 环境变量名模式保留输入值
      }
      // 明文密钥：保存成功后才清空回显，避免失败时丢失已键入的密钥。
      if (await saveProviderPatch(provider.id, { api_key: value })) keyInput.value = "";
    });
    const eye = el("button", { type: "button", title: "显示/隐藏密钥", text: "👁" });
    eye.addEventListener("click", () => {
      keyInput.type = keyInput.type === "password" ? "text" : "password";
    });
    container.append(keyInput, eye);
    container.append(el("h4", { text: "模型列表" }));
    for (const model of provider.models) {
      const isDefault = isDefaultModel(provider.id, model.id);
      // 模型名：失焦（change）保存，[1m] 标记原样保留（空值守卫在 bindAutosave 内）。
      const nameInput = el("input", { value: model.model_name, "data-field": "model_name" });
      bindAutosave(nameInput, "model_name", (patch) => saveModelPatch(provider.id, model.id, patch));
      // 启停开关：文案即动作，点击保存相反状态，refresh 后文案随新状态翻转。
      const toggle = el("button", {
        type: "button",
        class: "model-status-toggle",
        text: model.enabled === false ? "启用" : "停用"
      });
      toggle.addEventListener("click", () => {
        saveModelPatch(provider.id, model.id, { enabled: !model.enabled });
      });
      // 设为默认：POST .../default；默认模型行显示「默认」角标。
      const setDefaultButton = el("button", { type: "button", class: "model-set-default", text: "设为默认" });
      setDefaultButton.addEventListener("click", () => {
        setDefaultModel(provider.id, model.id);
      });
      // 删除：二次确认后 POST .../remove。
      const deleteButton = el("button", { type: "button", class: "model-delete", text: "删除" });
      deleteButton.addEventListener("click", () => {
        removeModelWithConfirm(provider.id, model.id);
      });
      container.append(el("div", { class: "model-row", "data-model-id": model.id }, [
        nameInput,
        toggle,
        el("span", { text: model.enabled === false ? "已停用" : "已启用" }),
        ...(isDefault ? [el("span", { class: "default-badge", text: "默认" })] : []),
        el("button", { type: "button", disabled: true, title: "Task 15 实现", text: "测试连接" }),
        setDefaultButton,
        deleteButton
      ]));
    }
    // 「+ 添加模型」：Task 14 启用（Task 15 的拉取/行内编辑接手后仍保留此兜底入口）。
    const addModelButton = el("button", { type: "button", class: "add-model", text: "+ 添加模型" });
    addModelButton.addEventListener("click", () => {
      addModel(provider.id);
    });
    container.append(addModelButton);
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
    setDefaultModel,
    removeModelWithConfirm,
    addModel,
    _handlers: { saveProviderPatch, saveModelPatch, refresh, removeProviderWithConfirm, setDefaultModel, removeModelWithConfirm, addModel }
  };
}
