// src/app-shell/model-settings-page.js
// 模型设置页面：左列表 + 右详情。纯逻辑导出便于 node:test；
// DOM 渲染用最小 document.createElement（真实环境用 document，测试用 mock）。

import { isEnvironmentVariableName } from "./utils.js";
import { formatConnectionStatus } from "./settings-connection.mjs";
import { icon } from "./icons.js";

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

// 技术错误 → 中文（Task 20 #15）：后端领域错误消息本身已是中文（data.message
// 透传），只有本地/技术性异常（网络、超时、HTTP 状态、未知类型）才会落到这里
// 兜底翻译。中文消息一律原样保留，绝不改写。
export function translateTechnicalError(error) {
  const raw = String(error?.message ?? "").trim();
  if (!raw) return "未知错误，请稍后重试";
  const compact = raw.replace(/\s+/gu, " ");
  if (/^(failed to fetch|fetch failed|networkerror|network error|network request failed|load failed|typeerror: fetch failed)/iu.test(compact)) {
    return "网络请求失败，请检查网络连接后重试";
  }
  if (/^http \d{3}/iu.test(compact)) {
    return "服务器响应异常，请稍后重试";
  }
  if (/(timeout|timed out|timedout)/iu.test(compact)) {
    return "请求超时，请稍后重试";
  }
  if (/^typeerror/iu.test(compact)) {
    return "请求格式错误，请刷新页面后重试";
  }
  return raw;
}

// 密钥状态文案（Task 20 #3）：只显示「已配置」状态，绝不回显密钥明文；
// 环境变量名不是密钥，可随状态展示帮助识别。
function keyStatusText(provider) {
  if (provider.api_key_saved) {
    return provider.api_key_env ? `已配置（${provider.api_key_env}）` : "已配置";
  }
  return provider.api_key_env ? `已填环境变量名（${provider.api_key_env}）` : "未配置";
}

// 单次渲染的草稿引用：test/pull 的 commitCurrentDraft 从这里读当前表单值
//（含未失焦的输入），保证「先提交并验证当前表单值」而不读陈旧保存值。
function freshDraftRefs() {
  return {
    providerId: null,
    nameInput: null,
    baseUrlInput: null,
    keyInput: null,
    envToggle: null,
    modelInputs: new Map(), // modelId → name input
    errorRefs: new Map() // fieldKey → 错误行 span
  };
}

function showFieldError(refs, fieldKey, message) {
  const span = refs?.errorRefs?.get(fieldKey);
  if (span) span.textContent = message;
}

function clearFieldError(refs, fieldKey) {
  showFieldError(refs, fieldKey, "");
}

// 失焦（change）自动保存（Task 20 draft-first）：空值/非法值不再静默丢弃——
// 保留编辑态（输入值不动）并行内显示中文错误；合法值才提交保存。
// commit 返回 { ok, error }（commitProviderPatch/commitModelPatch 形状），
// 失败时行内回显错误（toast 由 commit 内部弹）。
// Task 22（#11）：onEnter 开启时绑定 Enter——与失焦保存同一提交路径，使
//「名称框回车保存」提示文案与真实行为一致（校验/行内错误行为完全相同）。
// Task 22 审查（Important 1）：run() 内记 lastCommitted（提交前乐观置位，失败
// 复位）——真实 DOM 在输入框被移除时派发挂起的 change（Enter 保存成功后
// refresh 重建详情，被替换的输入框仍是焦点元素且带挂起 change），同值二次
// 触发 run() 会重复 PATCH；同值跳过（含在途竞态与 Enter 连按）不丢新改动
//（值变化后仍正常提交，失败后同值可重试）。
function bindAutosave(input, { refs, fieldKey, validate = null, commit, onEnter = false }) {
  let lastCommitted = null;
  const run = async () => {
    const value = input.value.trim();
    if (value === lastCommitted) return;
    const error = validate ? validate(value) : null;
    if (error) {
      showFieldError(refs, fieldKey, error);
      return;
    }
    lastCommitted = value;
    clearFieldError(refs, fieldKey);
    const result = await commit(value);
    if (result?.ok === false) {
      lastCommitted = null; // 失败复位：同一值可重试
      showFieldError(refs, fieldKey, result.error ?? "保存失败，请重试");
    }
  };
  input.addEventListener("change", run);
  if (onEnter) {
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      void run();
    });
  }
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
  // 当前渲染详情的草稿引用（renderDetail 每次重建；commitCurrentDraft 读取）。
  let activeDraftRefs = freshDraftRefs();
  // 第十三轮（F1）：高级面板展开态按模型 id 记在闭包里——保存触发 refresh()
  // 整块重渲会重建 DOM，展开态若只活在 DOM 上，用户选完上下文就被迫重开一次。
  const advancedOpenModels = new Set();
  // v4 决策：渲染目标注入（attach）——弃用全局 documentRef.querySelector 双路径。
  // render/refresh 只写 attach 进来的目标；未 attach 时安全跳过（弹窗关闭期间 commit
  // 完成时目标已脱离文档，渲染为无害 no-op）。
  let attachedTargets = null; // { list, detail } | null
  // 当前渲染详情的容器引用（renderDetail 记录；renderCandidateList/testConnection 的
  // 挂载节点查找改经此容器，规避 commit 重渲染后旧节点脱 DOM）。
  let currentDetail = null;

  function attach(targets) {
    attachedTargets = targets ?? null; // 传入 null 即解除
  }

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
      showToast(`模型列表加载失败：${translateTechnicalError(error)}`, "error");
    }
    return state;
  }

  // 供应商字段保存（Task 20）：返回 { ok, error, provider }。失败路径保留当前
  // 状态并 toast（不刷新，避免用旧数据覆盖新状态），英文技术错误映射中文。
  async function commitProviderPatch(id, patch) {
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
      return { ok: true, error: null, provider: data?.provider ?? null };
    } catch (error) {
      const message = translateTechnicalError(error);
      // 无环境变量名的供应商直接粘贴明文密钥会命中后端 invalid_api_key_env（400）：
      // 此时给出更明确的引导，其余错误保留通用文案。
      if (error?.message?.includes("请先填写 API 密钥环境变量名")) {
        showToast("请先填写 API 密钥环境变量名（开启「使用环境变量名」后填写如 MY_KEY 并保存），再粘贴密钥。", "error");
      } else {
        showToast(`保存失败：${message}`, "error");
      }
      return { ok: false, error: message, provider: null };
    }
  }

  // 布尔形态（既有调用方/测试契约）：成功 true / 失败 false。
  async function saveProviderPatch(id, patch) {
    return (await commitProviderPatch(id, patch)).ok;
  }

  async function commitModelPatch(providerId, modelId, patch) {
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
      return { ok: true, error: null, model: data?.model ?? null, provider: data?.provider ?? null };
    } catch (error) {
      const message = translateTechnicalError(error);
      showToast(`保存失败：${message}`, "error");
      return { ok: false, error: message, model: null, provider: null };
    }
  }

  async function saveModelPatch(providerId, modelId, patch) {
    return (await commitModelPatch(providerId, modelId, patch)).ok;
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
      showToast(`删除失败：${translateTechnicalError(error)}`, "error");
      return false;
    }
  }

  // 默认模型角标判定：state.default_model 来自 GET 响应顶层字段，为
  // { provider_id, model_id } 对象（v2 存储形态）。
  function isDefaultModel(providerId, modelId) {
    const dm = state.default_model;
    if (!dm) return false;
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
      showToast(`设置默认模型失败：${translateTechnicalError(error)}`, "error");
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
      showToast(`删除失败：${translateTechnicalError(error)}`, "error");
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
      showToast(`添加模型失败：${translateTechnicalError(error)}`, "error");
      return false;
    }
  }

  // 拉取模型（Task 20 #8）：先提交并验证当前表单值（同一 commitCurrentDraft），
  // 成功后使用返回的权威 provider 做前置检查与请求——绝不读取陈旧保存值。
  // 前置检查（供应商存在且已配置密钥环境变量名）→ POST .../pull-models
  // 取候选名列表（后端中转外呼厂商 GET /models，不落盘），渲染到模型区顶部的
  // 可折叠候选容器（默认收起，拉取成功后自动展开），逐条「添加」走 addPulledModel。
  async function pullModels(providerId) {
    const committed = await commitCurrentDraft({
      providerId,
      provider: state.providers.find((p) => p.id === providerId) ?? state.selected ?? null
    });
    if (!committed.ok) return false;
    const provider = committed.provider;
    if (!provider || !provider.api_key_env) {
      showToast("请先填写接口地址和 API 密钥");
      return false;
    }
    try {
      const res = await fetchImpl(`${API_BASE}/${providerId}/pull-models`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message ?? `HTTP ${res.status}`);
      renderCandidateList(providerId, data.models ?? []);
      return true;
    } catch (error) {
      showToast(`拉取失败：${translateTechnicalError(error)}`, "error");
      return false;
    }
  }

  // 逐个添加拉取候选：POST .../models（enabled 默认 true），成功 refresh + onChanged。
  async function addPulledModel(providerId, modelName) {
    try {
      const res = await fetchImpl(`${API_BASE}/${providerId}/models`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model_name: modelName, enabled: true })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message ?? `HTTP ${res.status}`);
      await refresh();
      onChanged();
      return true;
    } catch (error) {
      showToast(`添加模型失败：${translateTechnicalError(error)}`, "error");
      return false;
    }
  }

  // 测试连接（Task 20 #8）：先提交并验证当前表单值（同一 commitCurrentDraft），
  // 成功后使用返回的权威 provider/model——绝不读取陈旧保存值。
  // POST /api/settings/test-connection（Task 11 双形态契约的「供应商+模型」
  // 形态），结果行内渲染到模型行（成功绿勾 / 失败红字错误文案）。请求体不带
  // api_key，依赖已落盘的 secrets；密钥缺失（configuration_missing /
  // missing_api_key）时额外 toast 引导补密钥。失败结果经 formatConnectionStatus
  // 复用既有文案格式。
  async function testConnection(provider, model, resultSlot) {
    const committed = await commitCurrentDraft({
      providerId: provider.id,
      modelId: model?.id ?? null,
      provider,
      model
    });
    // Critical 修复（Task 20 审查）：commit 成功会 refresh → renderDetail 重建整个
    // 详情容器，click 时捕获的 resultSlot 已脱离 DOM——结果写进去用户不可见。
    // 仿照 renderCandidateList 从当前详情容器（currentDetail，attach 的 detail 目标）
    // 重查最新渲染的 slot；找不到（直调/未重渲染）才回退传入节点。
    const slot = model?.id
      ? (currentDetail?.querySelector?.(`[data-model-connection-result="${model.id}"]`) ?? null)
      : null;
    const targetSlot = slot ?? resultSlot ?? null;
    if (!committed.ok || !committed.provider || !committed.model) {
      const message = committed.error ?? "请先修正表单错误";
      if (targetSlot) {
        targetSlot.replaceChildren();
        targetSlot.append(el("span", { class: "connection-result error", text: `✗ ${message}` }));
      }
      return { ok: false, data: { message } };
    }
    const targetProvider = committed.provider;
    const targetModel = committed.model;
    let data = null;
    let ok = false;
    try {
      const res = await fetchImpl("/api/settings/test-connection", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: { base_url: targetProvider.base_url, api_key_env: targetProvider.api_key_env },
          model: { model_name: targetModel.model_name }
        })
      });
      data = await res.json().catch(() => null);
      ok = res.ok === true && data?.ok !== false;
    } catch (error) {
      data = { message: translateTechnicalError(error) };
    }
    const message = formatConnectionStatus(data) || (ok ? "连接成功" : "连接测试失败");
    if (targetSlot) {
      targetSlot.replaceChildren();
      targetSlot.append(el("span", { class: `connection-result ${ok ? "ok" : "error"}`, text: `${ok ? "✓ " : "✗ "}${message}` }));
    }
    if (!ok && (data?.code === "configuration_missing" || data?.code === "missing_api_key")) {
      showToast("请先配置 API 密钥（开启「使用环境变量名」填写环境变量名，或直接粘贴明文密钥保存），再测试连接。", "error");
    }
    return { ok, data };
  }

  // 添加供应商（Task 15 计划缺口补全）：POST 创建（Task 10 契约：创建忽略 api_key），
  // 若表单给了明文密钥再 PATCH 落盘（PATCH 才把密钥写入对应 env bucket）。
  async function addProvider({ name = "", base_url = "", api_format = "openai-chat-completions", api_key_env = "", api_key = "" } = {}) {
    const trimmed = {
      name: name.trim(),
      baseUrl: base_url.trim(),
      envName: api_key_env.trim(),
      apiKey: String(api_key).trim()
    };
    if (!trimmed.name || !trimmed.baseUrl || !trimmed.envName) {
      showToast("名称、Base URL 与密钥环境变量名为必填项", "error");
      return false;
    }
    if (!/^https?:\/\/.+/u.test(trimmed.baseUrl)) {
      showToast("Base URL 需以 http:// 或 https:// 开头", "error");
      return false;
    }
    // 与 PATCH 路由的 API_KEY_ENV_NAME 同款校验：POST 不校验 env 名（normalizeProvider
    // 仅要求非空），非法名会越过创建、到 PATCH 落密钥时才 400——创建成功的供应商
    // 留下无密钥的半成品。这里前置拦截，避免「POST 成功 + PATCH 失败」的中间态。
    if (!isEnvironmentVariableName(trimmed.envName)) {
      showToast("API 密钥环境变量名只能包含字母、数字、下划线且不能以数字开头。", "error");
      return false;
    }
    try {
      const res = await fetchImpl(`${API_BASE}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed.name, base_url: trimmed.baseUrl, api_format, api_key_env: trimmed.envName })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message ?? `HTTP ${res.status}`);
      if (trimmed.apiKey) {
        const keyRes = await fetchImpl(`${API_BASE}/${data.provider.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ api_key: trimmed.apiKey })
        });
        const keyData = await keyRes.json().catch(() => null);
        if (!keyRes.ok) throw new Error(keyData?.message ?? `HTTP ${keyRes.status}`);
      }
      await refresh();
      onChanged();
      showToast("供应商已添加", "success");
      return true;
    } catch (error) {
      showToast(`添加供应商失败：${translateTechnicalError(error)}`, "error");
      return false;
    }
  }

  // Task 20 #8：test/pull 共用的「先提交并验证当前表单值」入口。读取当前渲染
  // 表单的草稿值（含未失焦的输入），逐字段校验（中文错误行内回显、保留编辑态），
  // 脏字段先保存，成功后返回权威 provider/model——绝不读取陈旧保存值。
  // 表单未渲染（无详情行，如直调/页面刚加载）时无草稿可提交，直接返回权威值。
  async function commitCurrentDraft({ providerId, modelId = null, provider: fallbackProvider = null, model: fallbackModel = null } = {}) {
    const refs = activeDraftRefs.providerId === providerId ? activeDraftRefs : null;
    const baseProvider = fallbackProvider ?? state.providers.find((p) => p.id === providerId) ?? state.selected ?? null;
    if (!refs) {
      const model = fallbackModel ?? baseProvider?.models.find((m) => m.id === modelId) ?? null;
      return { ok: true, provider: baseProvider, model };
    }

    // 1) 校验全部表单值（不通过即中止，错误行内回显）
    const name = refs.nameInput.value.trim();
    if (!name) return fieldError(refs, "name", "供应商名称不能为空");
    const baseUrl = refs.baseUrlInput.value.trim();
    if (!baseUrl) return fieldError(refs, "base_url", "Base URL 不能为空");
    if (!/^https?:\/\/.+/u.test(baseUrl)) return fieldError(refs, "base_url", "Base URL 需以 http:// 或 https:// 开头");
    const keyValue = refs.keyInput.value.trim();
    const envMode = refs.envToggle.checked === true;
    if (envMode && keyValue && !isEnvironmentVariableName(keyValue)) {
      return fieldError(refs, "api_key", "API 密钥环境变量名只能包含字母、数字、下划线且不能以数字开头。");
    }
    for (const [mid, input] of refs.modelInputs) {
      if (!input.value.trim()) return fieldError(refs, `model_name:${mid}`, "模型名称不能为空");
    }

    // 2) 提交脏字段：provider 字段合并为一次 PATCH；模型逐个提交。
    // 与权威值逐字段比较，仅保存实际变化（避免无谓 PATCH）。
    // 密钥/环境变量名与直连 change 处理器同语义：非空即提交（密钥不可读无法
    // 比较）、成功后清空输入——不设「未变化跳过」分支，避免两入口行为分叉。
    let provider = baseProvider ?? {};
    let model = fallbackModel ?? baseProvider?.models.find((m) => m.id === modelId) ?? null;
    const providerPatch = {};
    if (name !== String(provider.name ?? "").trim()) providerPatch.name = name;
    if (baseUrl !== String(provider.base_url ?? "").trim()) providerPatch.base_url = baseUrl;
    if (keyValue) providerPatch[envMode ? "api_key_env" : "api_key"] = keyValue;
    if (Object.keys(providerPatch).length > 0) {
      const result = await commitProviderPatch(providerId, providerPatch);
      if (result?.ok === false) return { ok: false, error: result.error ?? "保存失败，请重试" };
      provider = result.provider ?? { ...provider, name, base_url: baseUrl, ...(envMode && keyValue ? { api_key_env: keyValue } : {}) };
      if (keyValue) refs.keyInput.value = ""; // 密钥/环境变量名不回显
    }
    for (const [mid, input] of refs.modelInputs) {
      const value = input.value.trim();
      const currentModel = (provider.models ?? []).find((m) => m.id === mid) ?? { model_name: "" };
      if (value === String(currentModel.model_name ?? "").trim()) continue;
      const result = await commitModelPatch(providerId, mid, { model_name: value });
      if (result?.ok === false) return { ok: false, error: result.error ?? "保存失败，请重试" };
      const next = result.provider ?? { ...provider, models: (provider.models ?? []).map((m) => (m.id === mid ? { ...m, model_name: value } : m)) };
      provider = next;
      if (mid === modelId) model = (next.models ?? []).find((m) => m.id === mid) ?? { ...(model ?? {}), model_name: value };
    }
    if (!model && modelId) model = (provider.models ?? []).find((m) => m.id === modelId) ?? null;

    // 3) 提交成功：清空行内错误（重渲染会重建，直调路径显式清）
    for (const [, span] of refs.errorRefs) span.textContent = "";
    return { ok: true, provider, model };
  }

  // 校验失败出口：行内回显中文错误并保留编辑态，返回 { ok: false } 中止后续动作。
  function fieldError(refs, fieldKey, message) {
    showFieldError(refs, fieldKey, message);
    return { ok: false, error: message };
  }

  // ---------------------------------------------------------------------------
  // v4（A4 实测记录）：模型分区 dirty 关闭保护——未失焦草稿 vs 保存态判定。
  //
  // 实测（代码级分析；本沙盒无法启动打包 Electron 应用，sandbox 内
  // child-process spawn EPERM 阻断真实浏览器 GUI）：模型表单为 draft-first
  // autosave（input 的 change 即 PATCH）。点 ✗/遮罩/切分区时，鼠标移动先触发
  // input 失焦（blur）→ 派发 change → 大概率已保存；**Esc 关闭是主要裸奔路径**
  // ——焦点停留在输入框内，closeSettingsModal 的 Esc 处理器直接 remove 弹窗 DOM，
  // 被移除输入框是否派发挂起的 change 因浏览器而异（真实 Chromium 移除 DOM 时不
  // 保证补发 change）。本函数即为该「输入未失焦」窗口（以及保存请求在途/失败、
  // 行内校验错误但值未落盘）作兜底：任一草稿字段 ≠ 最近一次保存/拉取快照即判脏，
  // settings-modal 据此在关闭前弹「放弃未保存修改」确认层。dirty 判定保留不看浏览
  // 器是否补发 change——guard 恒作为 belt-and-braces 兜底。
  //
  // 保存态语义：state 为 refresh() 拉取/PATCH 成功后的最近快照（= state.selected 供
  // 应商对象及其 models）。字段清单对齐 freshDraftRefs()（providerId / nameInput /
  // baseUrlInput / keyInput / envToggle / modelInputs / errorRefs）。
  // 密钥键（keyInput）特殊：渲染时恒为 ""、保存成功后清空为 ""，从不回显保存值
  // （placeholder 提示+「已配置」状态标签）；其「已保存」在输入框内的表征即空串，
  // 故判脏 = 存在未失焦的非空已键入值（envToggle 单独拨动不落盘、不构成脏）。
  function isDirty() {
    if (!activeDraftRefs) return false;
    const refs = activeDraftRefs;
    const provider = state.selected;
    const savedKey = (s) => String(s ?? "").trim();
    if (refs.nameInput && savedKey(refs.nameInput.value) !== savedKey(provider?.name)) return true;
    if (refs.baseUrlInput && savedKey(refs.baseUrlInput.value) !== savedKey(provider?.base_url)) return true;
    if (refs.keyInput && refs.keyInput.value.trim() !== "") return true; // 密钥不回显，非空即未失焦草稿
    if (refs.modelInputs) {
      for (const [mid, input] of refs.modelInputs) {
        const model = (provider?.models ?? []).find((m) => m.id === mid);
        if (savedKey(input.value) !== savedKey(model?.model_name)) return true;
      }
    }
    return false;
  }

  function el(tag, props = {}, children = []) {
    const node = documentRef.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "text") node.textContent = value;
      else if (key === "class") node.className = value;
      else if (key === "value") node.value = value; // value 走 property 而非 setAttribute：保住用户已键入的值
      else if (key === "disabled") node.disabled = Boolean(value); // 同 value 走 property：真 DOM 与测试 mock 均正确反映禁用态
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
        // buildPageState 只返回 { providers, selected }，须显式保留 default_model，
        // 否则列表点击后「默认」角标即消失（Task 14 回归点）。
        state = { ...buildPageState(state.providers, provider.id), default_model: state.default_model };
        render();
      });
      container.append(item);
    }
    // 「+ 添加供应商」：Task 15 启用，点击在列表底部展开内联表单（默认收起）。
    const addProviderButton = el("button", { class: "add-provider", type: "button", text: "+ 添加供应商" });
    const form = el("div", { class: "add-provider-form", "data-add-provider-form": "true" });
    form.hidden = true;
    // 表单字段：名称（必填）/ Base URL（必填，http(s)）/ API 接口协议（仅
    // openai-chat-completions 可选）/ 密钥环境变量名（必填——后端契约：明文密钥
    // 只能写入已有 env bucket，POST 创建又不落密钥，故 env 名必须随创建提交）/
    // API 密钥（可选，直接粘贴，创建成功后 PATCH 落盘）。
    const nameInput = el("input", { class: "provider-form-name", "data-field": "new-name", placeholder: "供应商名称（必填）" });
    const baseUrlInput = el("input", { class: "provider-form-base-url", "data-field": "new-base_url", placeholder: "https://api.example.com/v1（必填）" });
    const formatSelect = el("select", { "data-field": "new-api_format" });
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
    formatSelect.value = "openai-chat-completions";
    const envInput = el("input", { class: "provider-form-env", "data-field": "new-api_key_env", placeholder: "密钥环境变量名，如 MY_API_KEY（必填）" });
    const keyInput = el("input", { type: "password", class: "provider-form-key", "data-field": "new-api_key", placeholder: "API 密钥（可选，直接粘贴）" });
    const submitButton = el("button", { type: "button", class: "provider-form-submit", text: "添加" });
    submitButton.addEventListener("click", async () => {
      const ok = await addProvider({
        name: nameInput.value,
        base_url: baseUrlInput.value,
        api_format: formatSelect.value,
        api_key_env: envInput.value,
        api_key: keyInput.value
      });
      if (ok) {
        form.hidden = true;
        nameInput.value = "";
        baseUrlInput.value = "";
        envInput.value = "";
        keyInput.value = "";
      }
    });
    const cancelButton = el("button", { type: "button", class: "provider-form-cancel", text: "取消" });
    cancelButton.addEventListener("click", () => { form.hidden = true; });
    form.append(
      el("label", { text: "名称" }), nameInput,
      el("label", { text: "Base URL" }), baseUrlInput,
      el("label", { text: "API 接口协议" }), formatSelect,
      el("label", { text: "密钥环境变量名" }), envInput,
      el("label", { text: "API 密钥" }), keyInput,
      submitButton, cancelButton
    );
    addProviderButton.addEventListener("click", () => { form.hidden = !form.hidden; });
    container.append(addProviderButton, form);
  }

  function renderDetail(container) {
    currentDetail = container; // 记录当前详情容器，供挂载节点查找（renderCandidateList/testConnection）
    container.replaceChildren();
    const provider = state.selected;
    // Task 20：本次渲染的草稿引用（commitCurrentDraft 从这读当前表单值）。
    activeDraftRefs = freshDraftRefs();
    if (!provider) { container.append(el("p", { text: "还没有供应商，先添加一个。" })); return; }
    activeDraftRefs.providerId = provider.id;

    // 供应商名：可编辑输入，失焦（change）自动保存；空值行内中文错误不静默丢弃。
    const nameInput = el("input", { value: provider.name, class: "provider-name", "data-field": "name" });
    activeDraftRefs.nameInput = nameInput;
    bindAutosave(nameInput, {
      refs: activeDraftRefs,
      fieldKey: "name",
      validate: (value) => (value ? null : "供应商名称不能为空"),
      commit: (value) => commitProviderPatch(provider.id, { name: value })
    });
    const nameError = el("span", { class: "field-error", "data-field-error": "name" });
    activeDraftRefs.errorRefs.set("name", nameError);
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
    // 删除（右上角垃圾桶）：二次确认后 POST .../remove。Task 22（#2）：图标
    // 按钮补 aria-label 提供 accessible name；Round10：图标走现有 icon 体系。
    const deleteButton = el("button", { type: "button", class: "provider-delete", title: "删除供应商", "aria-label": "删除供应商" });
    deleteButton.replaceChildren(icon("trash", 14, null, documentRef));
    deleteButton.addEventListener("click", () => {
      removeProviderWithConfirm(provider.id);
    });
    container.append(el("div", { class: "provider-detail-head" }, [nameInput, nameError, statusToggle, deleteButton]));

    container.append(el("label", { text: "Base URL" }));
    const baseUrlInput = el("input", { value: provider.base_url, "data-field": "base_url" });
    activeDraftRefs.baseUrlInput = baseUrlInput;
    bindAutosave(baseUrlInput, {
      refs: activeDraftRefs,
      fieldKey: "base_url",
      validate: (value) => {
        if (!value) return "Base URL 不能为空";
        if (!/^https?:\/\/.+/u.test(value)) return "Base URL 需以 http:// 或 https:// 开头";
        return null;
      },
      commit: (value) => commitProviderPatch(provider.id, { base_url: value })
    });
    const baseUrlError = el("span", { class: "field-error", "data-field-error": "base_url" });
    activeDraftRefs.errorRefs.set("base_url", baseUrlError);
    container.append(baseUrlInput, baseUrlError);

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
    // Task 20 #3/#14：输入框不回显密钥；「使用环境变量名」checkbox 默认关闭，
    // 关闭时一律按明文密钥提交 { api_key: value }（即使形如 MY_API_KEY），
    // 打开后才按环境变量名提交 { api_key_env: value }——语义由开关决定，不猜形状。
    const keyInput = el("input", { type: "password", value: "", "data-field": "api_key", placeholder: "粘贴 API 密钥（默认按明文保存）" });
    activeDraftRefs.keyInput = keyInput;
    const envToggle = el("input", { type: "checkbox", class: "api-key-env-toggle", "data-field": "api_key_env_toggle" });
    envToggle.checked = false;
    activeDraftRefs.envToggle = envToggle;
    envToggle.addEventListener("change", () => {
      clearFieldError(activeDraftRefs, "api_key");
      keyInput.placeholder = envToggle.checked ? "环境变量名，如 MY_API_KEY" : "粘贴 API 密钥（默认按明文保存）";
    });
    keyInput.addEventListener("change", async () => {
      const value = keyInput.value.trim();
      if (!value) { clearFieldError(activeDraftRefs, "api_key"); return; }
      if (envToggle.checked) {
        if (!isEnvironmentVariableName(value)) {
          showFieldError(activeDraftRefs, "api_key", "API 密钥环境变量名只能包含字母、数字、下划线且不能以数字开头。");
          return;
        }
        const result = await commitProviderPatch(provider.id, { api_key_env: value });
        if (result?.ok === false) {
          showFieldError(activeDraftRefs, "api_key", result.error ?? "保存失败，请重试");
          return;
        }
        keyInput.value = ""; // 不回显密钥/环境变量名，状态由「已配置」标签呈现
        return;
      }
      // 明文密钥：保存成功后才清空回显，失败保留已键入值。
      const result = await commitProviderPatch(provider.id, { api_key: value });
      if (result?.ok === false) {
        showFieldError(activeDraftRefs, "api_key", result.error ?? "保存失败，请重试");
        return;
      }
      keyInput.value = "";
    });
    // Round10：eye 用现有图标体系（eye/eyeOff 切换），按钮固定贴在输入框右侧热区。
    const eye = el("button", { type: "button", class: "api-key-eye", title: "显示/隐藏密钥", "aria-label": "显示/隐藏密钥" });
    eye.setAttribute("aria-pressed", "false");
    eye.replaceChildren(icon("eye", 16, null, documentRef));
    eye.addEventListener("click", () => {
      const showing = keyInput.type !== "password";
      keyInput.type = showing ? "password" : "text";
      eye.replaceChildren(icon(showing ? "eye" : "eyeOff", 16, null, documentRef));
      eye.setAttribute("aria-pressed", showing ? "false" : "true");
    });
    const keyField = el("div", { class: "api-key-field" }, [keyInput, eye]);
    const envLabel = el("label", { class: "api-key-env-label" }, [envToggle, el("span", { text: "使用环境变量名" })]);
    const keyStatus = el("span", { class: "api-key-status", "data-api-key-status": "true", text: keyStatusText(provider) });
    const keyError = el("span", { class: "field-error", "data-field-error": "api_key" });
    activeDraftRefs.errorRefs.set("api_key", keyError);
    container.append(keyField, envLabel, keyStatus, keyError);
    renderModelRows(container, provider);
  }

  // 模型区渲染（从 renderDetail 拆出：Task 15 的拉取/测试连接接线落在这里）。
  // 结构：标题行「模型列表 + 拉取模型」→ 可折叠候选容器（默认收起，pullModels
  // 成功自动展开，逐条「添加」）→ 各模型行（改名 / 启停 / 测试连接 / 设默认 / 删除）。
  function renderModelRows(container, provider) {
    container.append(el("h4", { text: "模型列表" }));
    const pullButton = el("button", { type: "button", class: "pull-models", text: "拉取模型" });
    pullButton.addEventListener("click", () => { pullModels(provider.id); });
    container.append(pullButton);

    const candidateHolder = el("div", { class: "candidate-list", "data-candidate-list": "true" });
    candidateHolder.hidden = true;
    const candidateToggle = el("button", { type: "button", class: "candidate-toggle", text: "拉取候选 ▸", "aria-expanded": "false" });
    candidateToggle.addEventListener("click", () => {
      candidateHolder.hidden = !candidateHolder.hidden;
      candidateToggle.textContent = candidateHolder.hidden ? "拉取候选 ▸" : "拉取候选 ▾";
      candidateToggle.setAttribute("aria-expanded", String(!candidateHolder.hidden));
    });
    container.append(candidateToggle, candidateHolder);

    for (const model of provider.models) {
      const isDefault = isDefaultModel(provider.id, model.id);
      // 模型名：失焦（change）保存；空值行内中文错误不静默丢弃（Task 20 #5）。
      const nameInput = el("input", { value: model.model_name, "data-field": "model_name" });
      activeDraftRefs.modelInputs.set(model.id, nameInput);
      bindAutosave(nameInput, {
        refs: activeDraftRefs,
        fieldKey: `model_name:${model.id}`,
        validate: (value) => (value ? null : "模型名称不能为空"),
        commit: (value) => commitModelPatch(provider.id, model.id, { model_name: value }),
        // Task 22（#11）：添加模型的提示文案承诺「名称框改名后回车保存」，
        // 绑定 Enter 与失焦保存同一提交路径。
        onEnter: true
      });
      const nameError = el("span", { class: "field-error", "data-field-error": `model_name:${model.id}` });
      activeDraftRefs.errorRefs.set(`model_name:${model.id}`, nameError);
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
      // 停用即不能用：停用模型按钮置灰并提示（后端同款拒绝，前后端一致）。
      const setDefaultButton = el("button", {
        type: "button",
        class: "model-set-default",
        text: "设为默认",
        ...(model.enabled === false ? { disabled: true, title: "已停用的模型不能设为默认。" } : {})
      });
      setDefaultButton.addEventListener("click", () => {
        setDefaultModel(provider.id, model.id);
      });
      // 删除：二次确认后 POST .../remove；Round10：图标 + 文字，走现有 icon 体系。
      const deleteButton = el("button", { type: "button", class: "model-delete", text: "删除" });
      deleteButton.replaceChildren(icon("trash", 14, null, documentRef), documentRef.createTextNode("删除"));
      deleteButton.addEventListener("click", () => {
        removeModelWithConfirm(provider.id, model.id);
      });
      // 测试连接：结果通栏渲染到条目下方（绿勾 / 红字错误文案）。
      const resultSlot = el("div", { class: "model-connection-result", "data-model-connection-result": model.id });
      resultSlot.setAttribute("role", "status");
      const testButton = el("button", { type: "button", class: "model-test-connection", text: "测试连接" });
      testButton.addEventListener("click", () => {
        testConnection(provider, model, resultSlot);
      });
      // -- 第十三轮（F1）：高级折叠项--上下文/最大输出两个预设下拉，change 即存。 --
      const CONTEXT_PRESETS_K = [128, 256, 400, 512, 1000];
      const OUTPUT_PRESETS_K = [128, 64, 32, 16, 8];
      // Task 5：展开态 Set 改复合键——model id 是供应商局部的（model-provider-store.mjs
      // 契约），两供应商可有同 id 模型；跨供应商引用必须 `${provider.id}/${model.id}`，
      // 否则 A 展开后切到 B，B 的同 id 模型会「继承」展开态。
      const advancedKey = `${provider.id}/${model.id}`;
      const advancedOpen = advancedOpenModels.has(advancedKey);
      // data-model-advanced 保持 model.id（DOM 定位用，非状态键）。
      const advancedHolder = el("div", { class: "model-advanced", "data-model-advanced": model.id });
      advancedHolder.hidden = !advancedOpen;
      // aria-expanded：初始随展开态；点击切换时同步（与折叠箭头同源）。
      const advancedToggle = el("button", { type: "button", class: "model-advanced-toggle", text: advancedOpen ? "高级 ▾" : "高级 ▸", "aria-expanded": String(advancedOpen) });
      advancedToggle.addEventListener("click", () => {
        const opening = advancedHolder.hidden;
        advancedHolder.hidden = !opening;
        advancedToggle.textContent = opening ? "高级 ▾" : "高级 ▸";
        advancedToggle.setAttribute("aria-expanded", String(!opening));
        if (opening) advancedOpenModels.add(advancedKey);
        else advancedOpenModels.delete(advancedKey);
      });
      const presetSelect = ({ field, presetsK, value, defaultK, onChange }) => {
        const currentK = Number.isInteger(value) && value > 0 ? Math.round(value / 1000) : null;
        const optionKs = currentK != null && !presetsK.includes(currentK)
          ? [...presetsK, currentK] // 存量非预设值：追加「当前」项，不静默改写
          : presetsK;
        const select = el("select", { "data-field": field }, optionKs.map((k) => {
          const option = el("option", { value: String(k) });
          option.textContent = presetsK.includes(k) ? `${k}k` : `当前 ${k}k`;
          return option;
        }));
        select.value = String(currentK ?? defaultK);
        select.addEventListener("change", () => {
          // ponytail: 若 defaultK 被移出选项列表，真实 DOM 的 select.value 会回落 ""
          // 导致存 0 token；当前 6 条路径均保证 value ∈ optionKs，无实际触发面。
          onChange(Number(select.value) * 1000);
        });
        return el("label", { class: "model-advanced-field" }, [`${field === "context_window" ? "上下文" : "最大输出"}：`, select]);
      };
      advancedHolder.append(
        presetSelect({
          field: "context_window", presetsK: CONTEXT_PRESETS_K, value: model.context_window, defaultK: 256,
          onChange: (tokens) => { saveModelPatch(provider.id, model.id, { context_window: tokens }); }
        }),
        presetSelect({
          field: "max_output_tokens", presetsK: OUTPUT_PRESETS_K, value: model.max_output_tokens, defaultK: 64,
          onChange: (tokens) => { saveModelPatch(provider.id, model.id, { max_output_tokens: tokens }); }
        })
      );
      // Round10：每行三层稳定结构——主行（名称 + 状态）、操作行（可换行）、
      // 通栏结果行（role=status，长错误 anywhere 换行）。主行恒为两个 grid 子项：
      // 名称组（输入 + 行内错误）与状态组（已启用/停用 + 可选「默认」角标），
      // 与两列 grid 一一对应，空错误不把状态推到新行。handler 全部保留。
      container.append(el("div", { class: "model-row", "data-model-id": model.id }, [
        el("div", { class: "model-row-main" }, [
          el("div", { class: "model-row-name" }, [nameInput, nameError]),
          el("span", { class: "model-row-state" }, [
            model.enabled === false ? "已停用" : "已启用",
            ...(isDefault ? [el("span", { class: "default-badge", text: "默认" })] : [])
          ])
        ]),
        el("div", { class: "model-row-actions" }, [
          testButton,
          toggle,
          setDefaultButton,
          deleteButton,
          advancedToggle
        ]),
        advancedHolder,
        resultSlot
      ]));
    }
    // 「+ 添加模型」：Task 14 启用（Task 15 的拉取/行内编辑接手后仍保留此兜底入口）。
    const addModelButton = el("button", { type: "button", class: "add-model", text: "+ 添加模型" });
    addModelButton.addEventListener("click", () => {
      addModel(provider.id);
    });
    container.append(addModelButton);
  }

  // 拉取候选展开：把候选名渲染进模型区的可折叠容器并展开（行内「添加」按钮逐个
  // 走 addPulledModel）。容器只在实际渲染过的 attach detail 目标中存在；直调/未渲染
  // 时经 currentDetail 查不到即跳过（不影响 fetch 路径的断言）。
  function renderCandidateList(providerId, names) {
    const holder = currentDetail?.querySelector?.("[data-candidate-list]");
    if (!holder) return;
    // 拉取是异步的：期间用户可能已切到别的供应商，当前详情容器已属于新供应商。
    // 过期结果直接丢弃（否则旧供应商候选渲染进新容器，点「添加」会加到旧供应商）。
    if (state.selected?.id !== providerId) return;
    const list = Array.isArray(names) ? names : [];
    holder.replaceChildren();
    // 空候选同样展开容器并显示空态提示——否则消息渲染进隐藏容器，空拉取对用户无感知。
    holder.hidden = false;
    // 自动展开后同步折叠按钮箭头（否则容器已展开、箭头仍为收起态「▸」，状态脱同步）。
    const toggle = currentDetail?.querySelector?.(".candidate-toggle");
    if (toggle) toggle.textContent = "拉取候选 ▾";
    if (list.length === 0) {
      holder.append(el("p", { class: "candidate-empty", text: "没有拉取到可用模型" }));
      return;
    }
    for (const name of list) {
      const addButton = el("button", { type: "button", class: "candidate-add", text: "添加" });
      addButton.addEventListener("click", () => { addPulledModel(providerId, name); });
      holder.append(el("div", { class: "candidate-row", "data-candidate-name": name }, [
        el("span", { text: name }),
        addButton
      ]));
    }
  }

  function render() {
    // v4：只写 attach 进来的目标；未 attach 时安全跳过（no-op）。
    if (!attachedTargets) return;
    if (attachedTargets.list) renderList(attachedTargets.list);
    if (attachedTargets.detail) renderDetail(attachedTargets.detail);
  }

  return {
    async open() { await refresh(); },
    close() {},
    refresh,
    attach,
    getState: () => state,
    renderList,
    renderDetail,
    saveProviderPatch,
    saveModelPatch,
    removeProviderWithConfirm,
    setDefaultModel,
    removeModelWithConfirm,
    addModel,
    pullModels,
    addPulledModel,
    testConnection,
    addProvider,
    commitCurrentDraft,
    isDirty,
    _handlers: { saveProviderPatch, saveModelPatch, refresh, removeProviderWithConfirm, setDefaultModel, removeModelWithConfirm, addModel, pullModels, addPulledModel, testConnection, addProvider, commitCurrentDraft, isDirty }
  };
}
