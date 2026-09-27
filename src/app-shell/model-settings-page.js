// src/app-shell/model-settings-page.js
// 模型设置页面：左列表 + 右详情。纯逻辑导出便于 node:test；
// DOM 渲染用最小 document.createElement（真实环境用 document，测试用 mock）。

import { isEnvironmentVariableName } from "./utils.js";
import { formatConnectionStatus } from "./settings-connection.mjs";
import { icon } from "./icons.js";
import { el as domEl, bindAutosave, fieldError, showFieldError, clearFieldError } from "./dom-kit.js";
import { renderModelRows } from "./model-rows.mjs";
import { VENDOR_LOGOS } from "./vendor-logos.js";

const CATALOG_API = "/api/settings/provider-catalog";

// 目录协议显示名（只读行与候选池共用）。
const FORMAT_LABELS = {
  "openai-chat-completions": "OpenAI Chat Completions",
  "anthropic-messages": "Anthropic Messages",
  "openai-responses": "OpenAI Responses"
};

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

// 密钥状态文案（Task 20 #3；round22 D8：ENV 变体删除）——只区分「已配置/未配置」，
// 绝不回显密钥明文。
function keyStatusText(provider) {
  return provider.api_key_saved ? "已配置" : "未配置";
}

// 单次渲染的草稿引用：test/pull 的 commitCurrentDraft 从这里读当前表单值
//（含未失焦的输入），保证「先提交并验证当前表单值」而不读陈旧保存值。
function freshDraftRefs() {
  return {
    providerId: null,
    nameInput: null,
    baseUrlInput: null,
    keyInput: null,
    modelInputs: new Map(), // modelId → name input
    errorRefs: new Map() // fieldKey → 错误行 span
  };
}

const API_BASE = "/api/settings/providers";

// 模块级纯函数：便于单测（页内 setDefaultModel 包装它做 res.ok 检查 + refresh + toast）。
export async function setDefaultModelImpl(fetchImpl, providerId, modelId) {
  return fetchImpl(`${API_BASE}/${providerId}/models/${encodeURIComponent(modelId)}/default`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
}

export function createModelSettingsPage(ctx = {}) {
  const { fetchImpl = fetch, documentRef = document, onChanged = () => {}, showToast = () => {}, confirmImpl = globalThis.confirm } = ctx;
  // Task 11（F6）：el 迁入 dom-kit 共享层；documentRef 为 ctx 注入（测试注 mock），
  // 在此一行桥接，页面渲染调用点零改动。
  const el = (tag, props, children) => domEl(tag, props, children, documentRef);
// D23：厂商 logo 渲染——填充字形（fill:currentColor; stroke:none），不得走 icon()
// 的描边路径；无 logo 的厂商用大写首字母中性标（同规格圆角方块）。
function vendorLogoEl(logoKey, name) {
  // 固定尺寸容器：真实 logo（填充字形）与大写首字母中性标同规格圆角方块。
  const box = el("span", { class: "vendor-logo" });
  const path = logoKey ? VENDOR_LOGOS[logoKey] : null;
  if (path) {
    const svg = documentRef.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "currentColor");
    const p = documentRef.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", path);
    svg.append(p);
    box.append(svg);
    return box;
  }
  box.append(el("span", { class: "vendor-logo-fallback", text: String(name ?? "?").charAt(0).toUpperCase() }));
  return box;
}

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
  // D11（round22）：草稿按 providerId / "new"（添加供应商表单）记在实例闭包——
  // 切分区/切供应商不丢未提交内容；密钥只在内存，performCloseSettingsModal 经
  // clearDrafts() 清空（不落 localStorage）。
  const drafts = new Map();
  // D7：内置厂商目录（GET /api/settings/provider-catalog）——open 时取一次；
  // 目录厂商只读判定（D9）与「添加模型」候选池都从这里来。
  let catalogItems = [];
  let catalogLoaded = null;
  async function ensureCatalog() {
    if (!catalogLoaded) {
      catalogLoaded = fetchImpl(CATALOG_API)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => { catalogItems = Array.isArray(data?.catalog?.items) ? data.catalog.items : []; })
        .catch(() => { catalogItems = []; });
    }
    await catalogLoaded;
    return catalogItems;
  }
  // D9：目录厂商判定——base_url + api_format 与目录条目一致（seeded 与经候选池
  // 添加的厂商都命中）；自建服务（任意手填 URL）不命中，连接字段可编辑。
  function catalogVendorOf(provider) {
    if (!provider) return null;
    const base = String(provider.base_url ?? "").replace(/\/+$/u, "");
    return catalogItems.find((item) => String(item.api?.baseUrl ?? "").replace(/\/+$/u, "") === base && item.api?.type === provider.api_format) ?? null;
  }
  // D11：弹窗关闭后清空全部内存草稿（含密钥）。
  function clearDrafts() {
    drafts.clear();
  }

  function attach(targets) {
    attachedTargets = targets ?? null; // 传入 null 即解除
  }

  // 加载失败路径：保留上一次可用状态，只 toast 不抛错——open() 随之正常 resolve，
  // 避免 Task 13-15 挂到本页后遇到未处理拒绝（页面停在旧状态而非空着报错）。
  async function refresh() {
    try {
      // D7：目录取一次（失败静默为空——候选池与只读判定降级，不阻塞主流程）
      await ensureCatalog();
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
      showToast(`保存失败：${message}`, "error");
      return { ok: false, error: message, provider: null };
    }
  }

  // 布尔形态（既有调用方/测试契约）：成功 true / 失败 false。
  async function saveProviderPatch(id, patch) {
    return (await commitProviderPatch(id, patch)).ok;
  }

  async function commitModelPatch(providerId, modelId, patch) {
    try {
      // model id 存在旧迁移形态（deepseek-v4-flash@https://…，含斜杠冒号），必须
      // 编码进路径——裸拼会多出路径段致路由 404 → 保存失败（2026-09-27 实测根因）。
      const res = await fetchImpl(`${API_BASE}/${providerId}/models/${encodeURIComponent(modelId)}`, {
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
      const res = await fetchImpl(`${API_BASE}/${providerId}/models/${encodeURIComponent(modelId)}/remove`, {
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

  // 添加模型（D10）：必须携带明确的非空模型 ID（目录候选点选或手填提交），
  // 只有明确选择/提交才 POST——不再有 new-model 占位写法。
  async function addModel(providerId, modelId) {
    const id = String(modelId ?? "").trim();
    if (!id) {
      showToast("请先填写模型 ID", "error");
      return false;
    }
    try {
      const res = await fetchImpl(`${API_BASE}/${providerId}/models`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model_name: id, enabled: true })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message ?? `HTTP ${res.status}`);
      await refresh();
      onChanged();
      showToast(`已添加模型 ${id}`, "success");
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
          // D5：api_format 随候选透传——Anthropic/Responses 供应商不能退回 OpenAI 探测
          provider: { base_url: targetProvider.base_url, api_format: targetProvider.api_format, api_key_env: targetProvider.api_key_env },
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
      showToast("请先配置 API 密钥，再测试连接。", "error");
    }
    return { ok, data };
  }

  // 添加供应商（round22 D8/D10）：POST 只带名称/Base URL/协议——密钥存储名由
  // 服务端按供应商编号生成；若表单给了明文密钥，创建成功后再 PATCH { api_key }
  // 落盘。失败时保留草稿与密钥（不清表单），可重试。
  async function addProvider({ name = "", base_url = "", api_format = "openai-chat-completions", api_key = "" } = {}) {
    const trimmed = {
      name: name.trim(),
      baseUrl: base_url.trim(),
      apiKey: String(api_key).trim()
    };
    if (!trimmed.name || !trimmed.baseUrl) {
      showToast("名称与 Base URL 为必填项", "error");
      return false;
    }
    if (!/^https?:\/\/.+/u.test(trimmed.baseUrl)) {
      showToast("Base URL 需以 http:// 或 https:// 开头", "error");
      return false;
    }
    try {
      const res = await fetchImpl(`${API_BASE}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed.name, base_url: trimmed.baseUrl, api_format })
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
      drafts.delete("new");
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
    for (const [mid, input] of refs.modelInputs) {
      if (!input.value.trim()) return fieldError(refs, `model_name:${mid}`, "模型名称不能为空");
    }

    // 2) 提交脏字段：provider 字段合并为一次 PATCH；模型逐个提交。
    // 与权威值逐字段比较，仅保存实际变化（避免无谓 PATCH）。
    // 密钥与直连 change 处理器同语义：非空即提交（D8：一律按明文密钥
    // { api_key }，ENV 模式已删除）、成功后清空输入——不设「未变化跳过」分支。
    let provider = baseProvider ?? {};
    let model = fallbackModel ?? baseProvider?.models.find((m) => m.id === modelId) ?? null;
    const providerPatch = {};
    if (name !== String(provider.name ?? "").trim()) providerPatch.name = name;
    if (baseUrl !== String(provider.base_url ?? "").trim()) providerPatch.base_url = baseUrl;
    if (keyValue) providerPatch.api_key = keyValue;
    if (Object.keys(providerPatch).length > 0) {
      const result = await commitProviderPatch(providerId, providerPatch);
      if (result?.ok === false) return { ok: false, error: result.error ?? "保存失败，请重试" };
      provider = result.provider ?? { ...provider, name, base_url: baseUrl };
      if (keyValue) {
        refs.keyInput.value = ""; // 密钥不回显
        const draft = drafts.get(providerId);
        if (draft) draft.api_key = ""; // 内存草稿中的密钥一并清空
      }
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
    // D11：「添加供应商」表单纳入 dirty——任一字段有未提交内容即判脏
    //（密钥不回显，非空即未提交）。drafts 只在内存。
    const newDraft = drafts.get("new");
    if (newDraft && [newDraft.name, newDraft.base_url, newDraft.api_key, newDraft.manualModelId].some((v) => String(v ?? "").trim() !== "")) return true;
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

  // 关闭/切分区前的冲刷（2026-09-27 用户拍板：模型分区改了什么就生效什么，不再
  // 弹「未提交的内容会丢失」）：未失焦编辑与残留密钥草稿直接提交。返回
  // "ok"（无可冲刷或已提交成功）｜"pending"（已有一次冲刷在途，调用方忽略本次）
  // ｜"blocked"（提交失败，行内错误/toast 已提示，调用方回退确认层）｜
  // "confirm"（存在「添加供应商」半成品草稿——创建动作不自动提交，D11）。
  let flushInFlight = false;
  async function flushPendingEdits() {
    if (flushInFlight) return "pending";
    flushInFlight = true;
    try {
      // 1) 当前详情表单的未失焦编辑（名称/Base URL/密钥/模型名）：复用
      // commitCurrentDraft 的校验与逐字段提交，无差异时零 PATCH。
      if (activeDraftRefs && state.selected) {
        const committed = await commitCurrentDraft({ providerId: state.selected.id, provider: state.selected });
        if (!committed.ok) return "blocked";
      }
      // 2) 切走供应商时未失焦提交、残留在 drafts 里的密钥（isDirty 不覆盖，原先
      // 关闭即静默丢弃）——一并提交；空草稿条目顺手清掉。
      for (const [pid, draft] of drafts) {
        if (pid === "new") continue;
        const apiKey = String(draft?.api_key ?? "").trim();
        if (!apiKey) { drafts.delete(pid); continue; }
        const ok = await saveProviderPatch(pid, { api_key: apiKey });
        if (!ok) return "blocked";
        drafts.delete(pid);
      }
      const newDraft = drafts.get("new");
      if (newDraft && [newDraft.name, newDraft.base_url, newDraft.api_key, newDraft.manualModelId].some((v) => String(v ?? "").trim() !== "")) return "confirm";
      return "ok";
    } finally {
      flushInFlight = false;
    }
  }

  function renderList(container) {
    container.replaceChildren();
    container.append(el("h3", { text: "我的供应商" }));
    for (const provider of state.providers) {
      const vendor = catalogVendorOf(provider);
      const item = el("div", { class: `provider-item ${provider.id === state.selected?.id ? "selected" : ""}`, "data-provider-id": provider.id }, [
        vendorLogoEl(vendor?.logoKey ?? null, provider.name),
        el("span", { class: "provider-item-name", text: provider.name }),
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
    // D7/D10：「+ 添加供应商」= 可搜索目录候选池（不默认十家全铺）+「中转站 /
    // 自建服务」手填表单。目录候选一经点选即 POST 进入已添加列表（连接字段随后
    // 只读，D9）；自建服务走三字段表单（D8：无密钥存储名）。
    const addProviderButton = el("button", { class: "add-provider", type: "button", text: "+ 添加供应商" });
    const form = el("div", { class: "add-provider-form", "data-add-provider-form": "true" });
    form.hidden = true;

    // —— 目录候选池：搜索后才展开结果（默认不铺开）——
    const searchInput = el("input", { class: "catalog-search", "data-field": "catalog-search", placeholder: "搜索厂商目录…" });
    const catalogResults = el("div", { class: "catalog-results", "data-catalog-results": "true" });
    const addedKeys = () => new Set(state.providers.map((p) => `${String(p.base_url ?? "").replace(/\/+$/u, "")}|${p.api_format}`));
    const renderCatalogResults = () => {
      const query = searchInput.value.trim().toLowerCase();
      if (!query) {
        catalogResults.replaceChildren();
        catalogResults.hidden = true; // 不铺开：空搜索无结果区
        return;
      }
      const added = addedKeys();
      const hits = catalogItems.filter((item) => {
        const label = item.nameMap?.["zh-CN"] ?? item.id;
        if (added.has(`${String(item.api?.baseUrl ?? "").replace(/\/+$/u, "")}|${item.api?.type}`)) return false;
        return label.toLowerCase().includes(query) || String(item.id).toLowerCase().includes(query);
      });
      catalogResults.replaceChildren();
      catalogResults.hidden = false;
      if (hits.length === 0) {
        catalogResults.append(el("p", { class: "catalog-empty", text: "目录中没有匹配的厂商，可用下方自建服务接入" }));
        return;
      }
      for (const item of hits) {
        const label = item.nameMap?.["zh-CN"] ?? item.id;
        const row = el("button", { type: "button", class: "catalog-row", "data-catalog-id": item.id }, [
          vendorLogoEl(item.logoKey ?? null, label),
          el("span", { text: label }),
          el("span", { class: "catalog-row-format", text: FORMAT_LABELS[item.api?.type] ?? "" })
        ]);
        row.addEventListener("click", async () => {
          // 明确点选 = 进入已添加列表（POST 三字段，密钥随后在详情里补）
          const ok = await addProvider({ name: label, base_url: item.api?.baseUrl, api_format: item.api?.type });
          if (ok) {
            form.hidden = true;
            searchInput.value = "";
            catalogResults.replaceChildren();
            catalogResults.hidden = true;
          }
        });
        catalogResults.append(row);
      }
    };
    searchInput.addEventListener("input", renderCatalogResults);
    catalogResults.hidden = true;

    // —— 中转站 / 自建服务：三字段手填（D8：名称 + Base URL + 协议，密钥可选）——
    const manualToggle = el("button", { type: "button", class: "catalog-manual-toggle", text: "中转站 / 自建服务…" });
    const manualForm = el("div", { class: "provider-manual-form" });
    manualForm.hidden = true;
    const newDraft = () => drafts.get("new") ?? {};
    const track = (input, field) => input.addEventListener("input", () => {
      drafts.set("new", { ...(drafts.get("new") ?? {}), [field]: input.value });
    });
    const nameInput = el("input", { class: "provider-form-name", "data-field": "new-name", value: newDraft().name ?? "", placeholder: "供应商名称（必填）" });
    const baseUrlInput = el("input", { class: "provider-form-base-url", "data-field": "new-base_url", value: newDraft().base_url ?? "", placeholder: "https://api.example.com/v1（必填）" });
    const formatSelect = el("select", { "data-field": "new-api_format" });
    for (const [value, label] of Object.entries(FORMAT_LABELS)) {
      formatSelect.append(el("option", { value, text: label }));
    }
    formatSelect.value = newDraft().api_format ?? "openai-chat-completions";
    const keyInput = el("input", { type: "password", class: "provider-form-key", "data-field": "new-api_key", value: newDraft().api_key ?? "", placeholder: "API 密钥（可选，直接粘贴）" });
    track(nameInput, "name");
    track(baseUrlInput, "base_url");
    formatSelect.addEventListener("change", () => {
      drafts.set("new", { ...(drafts.get("new") ?? {}), api_format: formatSelect.value });
    });
    track(keyInput, "api_key");
    const submitButton = el("button", { type: "button", class: "provider-form-submit", text: "添加" });
    submitButton.addEventListener("click", async () => {
      const ok = await addProvider({
        name: nameInput.value,
        base_url: baseUrlInput.value,
        api_format: formatSelect.value,
        api_key: keyInput.value
      });
      // D11：失败时保留草稿和密钥，不清表单；成功 addProvider 内部已清 "new" 草稿
      if (ok) {
        form.hidden = true;
        manualForm.hidden = true;
        nameInput.value = "";
        baseUrlInput.value = "";
        keyInput.value = "";
      }
    });
    const cancelButton = el("button", { type: "button", class: "provider-form-cancel", text: "取消" });
    cancelButton.addEventListener("click", () => { form.hidden = true; });
    manualForm.append(
      el("label", { text: "名称" }), nameInput,
      el("label", { text: "Base URL" }), baseUrlInput,
      el("label", { text: "API 接口协议" }), formatSelect,
      el("label", { text: "API 密钥" }), keyInput,
      submitButton, cancelButton
    );
    manualToggle.addEventListener("click", () => { manualForm.hidden = !manualForm.hidden; });

    form.append(searchInput, catalogResults, manualToggle, manualForm);
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
    // D11：草稿回填——切走再回来时未提交值仍在（切走前已由 input 监听写入 drafts）。
    const draft = drafts.get(provider.id) ?? {};
    // D9：目录厂商判定——连接字段只读（带锁），只有密钥可编辑。
    const catalogVendor = catalogVendorOf(provider);

    // 供应商名：可编辑输入，失焦（change）自动保存；空值行内中文错误不静默丢弃。
    const nameInput = el("input", { value: draft.name ?? provider.name, class: "provider-name", "data-field": "name" });
    // D11：输入即时同步内存草稿（切供应商/切分区前不必依赖失焦）。
    nameInput.addEventListener("input", () => {
      drafts.set(provider.id, { ...(drafts.get(provider.id) ?? {}), name: nameInput.value });
    });
    activeDraftRefs.nameInput = nameInput;
    bindAutosave(nameInput, {
      refs: activeDraftRefs,
      fieldKey: "name",
      validate: (value) => (value ? null : "供应商名称不能为空"),
      commit: (value) => commitProviderPatch(provider.id, { name: value })
    });
    const nameError = el("span", { class: "spd-field-error", "data-field-error": "name" });
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
    // D15：供应商名包进 .dfield（input 100% 列宽），与右侧状态/删除按钮同排；
    // 行内错误随 dfield 第二行贴在输入框下。
    container.append(el("div", { class: "provider-detail-head" }, [
      el("div", { class: "dfield" }, [nameInput, nameError]),
      statusToggle,
      deleteButton
    ]));

    // D9：连接信息区——目录厂商只读（Base URL 与协议带锁展示），自建服务可编辑。
    if (catalogVendor) {
      const baseUrlRow = el("div", { class: "provider-readonly-row", "data-field": "base_url" }, [
        el("span", { class: "provider-readonly-value", text: provider.base_url })
      ]);
      const formatRow = el("div", { class: "provider-readonly-row", "data-field": "api_format" }, [
        el("span", { class: "provider-readonly-value", text: FORMAT_LABELS[provider.api_format] ?? provider.api_format })
      ]);
      const lock = (row) => {
        row.prepend(icon("lock", 14, "provider-readonly-lock", documentRef));
        row.setAttribute("data-readonly", "true");
        row.title = "目录厂商的连接信息不可修改";
      };
      lock(baseUrlRow);
      lock(formatRow);
      container.append(
        el("div", { class: "dfield" }, [el("span", { text: "Base URL" }), baseUrlRow]),
        el("div", { class: "dfield" }, [el("span", { text: "API 接口协议" }), formatRow])
      );
    } else {
      const baseUrlInput = el("input", { value: draft.base_url ?? provider.base_url, "data-field": "base_url" });
      baseUrlInput.addEventListener("input", () => {
        drafts.set(provider.id, { ...(drafts.get(provider.id) ?? {}), base_url: baseUrlInput.value });
      });
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
      const baseUrlError = el("span", { class: "spd-field-error", "data-field-error": "base_url" });
      activeDraftRefs.errorRefs.set("base_url", baseUrlError);
      container.append(
        el("div", { class: "dfield" }, [el("span", { text: "Base URL" }), baseUrlInput, baseUrlError])
      );

      // D5：三协议可选（gemini 死选项已删）；自建服务可切换协议并即时保存。
      const formatSelect = el("select", { "data-field": "api_format" });
      for (const [value, label] of Object.entries(FORMAT_LABELS)) {
        formatSelect.append(el("option", { value, text: label }));
      }
      formatSelect.value = provider.api_format;
      formatSelect.addEventListener("change", () => {
        saveProviderPatch(provider.id, { api_format: formatSelect.value });
      });
      container.append(
        el("div", { class: "dfield" }, [el("span", { text: "API 接口协议" }), formatSelect])
      );
    }

    container.append(
      el("div", { class: "dfield" }, [el("span", { text: "API 密钥" })])
    );
    // Task 20 #3/#14；round22 D8：输入框不回显密钥，「使用环境变量名」开关删除，
    // 一律按明文密钥提交 { api_key: value }。密钥只在内存草稿（切走不丢），保存
    // 成功后清空，关闭弹窗随 clearDrafts() 丢弃。
    const keyInput = el("input", { type: "password", value: draft.api_key ?? "", "data-field": "api_key", placeholder: "粘贴 API 密钥" });
    activeDraftRefs.keyInput = keyInput;
    keyInput.addEventListener("input", () => {
      drafts.set(provider.id, { ...(drafts.get(provider.id) ?? {}), api_key: keyInput.value });
    });
    keyInput.addEventListener("change", async () => {
      const value = keyInput.value.trim();
      if (!value) { clearFieldError(activeDraftRefs, "api_key"); return; }
      // 明文密钥：保存成功后才清空回显，失败保留已键入值。
      const result = await commitProviderPatch(provider.id, { api_key: value });
      if (result?.ok === false) {
        showFieldError(activeDraftRefs, "api_key", result.error ?? "保存失败，请重试");
        return;
      }
      keyInput.value = "";
      const d = drafts.get(provider.id);
      if (d) d.api_key = "";
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
    const keyStatus = el("span", { class: "api-key-status", "data-api-key-status": "true", text: keyStatusText(provider) });
    const keyError = el("span", { class: "spd-field-error", "data-field-error": "api_key" });
    activeDraftRefs.errorRefs.set("api_key", keyError);
    container.append(keyField, keyStatus, keyError);
    // D13：模型区灰底撑满详情面板，空态（无模型）在区内居中——容器由本页建，
    // 内容由 model-rows 渲染；空态只给「添加模型」一个动作（D10，见 model-rows）。
    const modelArea = el("div", { class: `model-area${(provider.models ?? []).length === 0 ? " is-empty" : ""}` });
    container.append(modelArea);
    // 模型区渲染：已拆至 model-rows.mjs（round22 D22/R1——字节余量不足以承载本轮
    // B 链改动；唯一调用方在此，state 与网络回调仍由本模块持有，经 deps 注入）。
    // D10：catalogCandidates 供「添加模型」候选池（目录中本厂商协议匹配的候选），
    // addModel(id) 只在明确选择/提交非空 ID 时 POST。
    renderModelRows(modelArea, provider, {
      el, icon, documentRef,
      draftRefs: activeDraftRefs,
      advancedOpenModels,
      isDefaultModel, commitModelPatch, saveModelPatch, setDefaultModel,
      removeModelWithConfirm, testConnection, pullModels, addModel,
      catalogCandidates: catalogCandidatesFor(provider)
    });
  }

  // D10：「添加模型」候选池——目录里与本厂商同协议的条目的 candidateModelIds
  //（去除已添加的 model_name）。目录不匹配（自建服务）→ 空列表，仅手填。
  function catalogCandidatesFor(provider) {
    const vendor = catalogVendorOf(provider);
    if (!vendor) return [];
    const existing = new Set((provider.models ?? []).map((m) => m.model_name));
    return (vendor.candidateModelIds ?? []).filter((id) => !existing.has(id));
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
    if (toggle) toggle.setAttribute("aria-expanded", "true");
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
    clearDrafts,
    isCatalogVendor: (provider) => Boolean(catalogVendorOf(provider)),
    catalogReady: ensureCatalog,
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
    flushPendingEdits,
    _handlers: { saveProviderPatch, saveModelPatch, refresh, removeProviderWithConfirm, setDefaultModel, removeModelWithConfirm, addModel, pullModels, addPulledModel, testConnection, addProvider, commitCurrentDraft, isDirty, flushPendingEdits }
  };
}
