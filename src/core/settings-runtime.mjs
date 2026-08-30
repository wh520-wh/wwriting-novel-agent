// src/core/settings-runtime.mjs —— 设置运行时域模块（统一 Agent 内核计划
// Task 5 起承担应用私有 settings 写入真相源）。
//
// 三块职责：① 设置补丁归一化/校验与 project.yaml 兼容写入（Task 5/8）；
// ② 模型档案展示与引用形态模型切换（providerDisplayName/modelDisplayName/
// buildModelProfile/switchModelByReference，Task 21 自 http/settings-routes.mjs
// 下沉）；③ 归档门禁 assertNotArchived 在此消费（实现在 project-listing.mjs，单源）。
import { HttpError } from "./http-error.mjs";
import { appendEvent } from "./event-log.mjs";
import { loadProject, saveProject } from "./project-store.mjs";
import { loadEffectiveWorkspaceConfig } from "./config-runtime.mjs";
import { fillOfficialPricing, normalizePricing } from "./model-pricing.mjs";
import { loadLocalSecretsSync } from "./local-secrets.mjs";
import { loadProviderStore } from "./model-provider-store.mjs";
import { toRequestConfig } from "./model-reference.mjs";
import { resolveModelLimits } from "./model/model-identity.mjs";
import { resolveModelCapabilities, writingRequiredCapabilitiesOk } from "./model/capabilities.mjs";
// Task 21：switchModelByReference 的归档校验调用 assertNotArchived（project-listing
// 单源）；project-listing 反向 import 本模块的 modelDisplayName——该环两端都只在
// 函数体内使用对方导出、模块顶层零求值，ESM live bindings 下运行时安全；
// 新增顶层求值引用前需重新评估。
import { assertNotArchived } from "./project-listing.mjs";

const SAFE_NAME = /^[A-Za-z0-9_.-]+$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export class SettingsValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SettingsValidationError";
    this.code = code;
  }
}

export async function updateProjectSettings(projectRoot, patch = {}) {
  const project = await loadProject(projectRoot);
  const normalized = normalizeSettingsPatch(patch);
  const next = mergeProjectSettings(project, normalized);
  await saveProject(projectRoot, next);
  await appendEvent(projectRoot, {
    type: "project_settings_updated",
    project_id: project.project_id,
    message: "project settings updated through controlled settings runtime",
    data: {
      changed_keys: Object.keys(normalized)
    }
  });
  return next;
}

// 任务 5：模型/权限写入应用私有 workspace settings 的统一入口。
//
// 先读当前有效配置（旧 project.yaml 只读兼容输入 + 应用私有 settings，合并契约见
// config-runtime.loadEffectiveWorkspaceConfig），再把模型与权限成对写入
// workspaceStore.saveSettings——绝不写回 project.yaml（旧文件保留为回滚依据，旧项目
// 首次打开即完成只读导入，之后不双写）。任何一次写入都同时携带 active_model 与
// tool_permissions，避免 store 归一化（4 布尔白名单）把另一侧字段重置成安全默认。
export async function saveWorkspaceSettings(projectRoot, {
  workspaceStore = null,
  activeModel = null,
  toolPermissions = null,
  effectiveConfig = null
} = {}) {
  if (!workspaceStore || typeof workspaceStore.saveSettings !== "function") {
    throw new SettingsValidationError("invalid_workspace_store", "workspaceStore is required.");
  }
  const before = effectiveConfig ?? await loadEffectiveWorkspaceConfig(projectRoot, { workspaceStore });
  return workspaceStore.saveSettings(projectRoot, {
    active_model: activeModel ?? before.active_model,
    tool_permissions: toolPermissions ?? before.tool_permissions
  });
}

// 预算限制只来自有效项目配置（project.yaml.budget_config）；不再同步到任何
// agent_state 运行态文件（统一 Agent 内核计划 Rule 9：本次 Run 的调用量在
// journal，跨 Run 成本累计由 cost.json 负责）。

export function normalizeSettingsPatch(patch = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new SettingsValidationError("invalid_settings_patch", "Settings patch must be an object.");
  }
  if (patch.api_key || patch.active_model?.api_key || patch.research_config?.search_api_key) {
    throw new SettingsValidationError("raw_secret_rejected", "不能把真实 API key 保存到项目设置；请先保存到 Windows 环境变量，然后这里只填 api_key_env 变量名。");
  }
  const normalized = {};
  if (patch.active_model !== undefined) {
    normalized.active_model = normalizeActiveModel(patch.active_model);
  }
  if (patch.active_model?.pricing !== undefined) {
    if (patch.active_model.pricing === null) {
      // 允许清除价格
    } else {
      // DeepSeek / MiMo 预设补缺：用户未填的输入/输出/命中价按官方人民币价自动补，已填则保留用户的数值。
      const activeModel = normalized.active_model ?? patch.active_model;
      const filled = fillOfficialPricing(activeModel.model_name, activeModel.base_url, patch.active_model.pricing);
      const pricing = normalizePricing(filled);
      if (!pricing) {
        throw new SettingsValidationError("invalid_pricing", "价格必须是正数：每百万 token 的输入价和输出价必填，缓存命中价可选。");
      }
      normalized.active_model = { ...activeModel, pricing };
    }
  }
  if (patch.tool_permissions !== undefined) {
    normalized.tool_permissions = normalizeToolPermissions(patch.tool_permissions);
  }
  if (patch.budget_config !== undefined) {
    normalized.budget_config = normalizeBudgetConfig(patch.budget_config);
  }
  if (patch.research_config !== undefined) {
    normalized.research_config = normalizeResearchConfig(patch.research_config);
  }
  if (patch.reasoning_effort !== undefined) {
    normalized.reasoning_effort = normalizeReasoningEffort(patch.reasoning_effort);
  }
  if (patch.archived_at !== undefined) {
    if (patch.archived_at === null) {
      normalized.archived_at = null;
    } else {
      const ts = Date.parse(patch.archived_at);
      if (!Number.isFinite(ts)) {
        throw new SettingsValidationError("invalid_archived_at", "archived_at must be null or an ISO timestamp.");
      }
      normalized.archived_at = new Date(ts).toISOString();
    }
  }
  if (patch.project_profile !== undefined) {
    normalized.project_profile = normalizeProjectProfile(patch.project_profile);
  }
  if (patch.fact_check !== undefined) {
    normalized.fact_check = normalizeFactCheck(patch.fact_check);
  }
  return normalized;
}

function mergeProjectSettings(project, patch) {
  const next = {
    ...project,
    tool_permissions: {
      ...(project.tool_permissions ?? {}),
      ...(patch.tool_permissions ?? {})
    }
  };
  if (patch.active_model !== undefined) {
    next.active_model = pruneNullFields(patch.active_model);
  }
  if (patch.budget_config !== undefined) {
    next.budget_config = mergeNullableSection(project.budget_config, patch.budget_config);
  }
  if (patch.research_config !== undefined) {
    next.research_config = mergeNullableSection(project.research_config, patch.research_config);
  }
  if (patch.reasoning_effort !== undefined) {
    next.reasoning_effort = patch.reasoning_effort;
  }
  if (patch.archived_at !== undefined) {
    next.archived_at = patch.archived_at;
  }
  if (patch.project_profile !== undefined) {
    for (const [key, value] of Object.entries(patch.project_profile)) {
      if (value !== null && value !== undefined) {
        next[key] = value;
      }
    }
    if (
      Number.isInteger(next.min_words_per_chapter) &&
      Number.isInteger(next.target_words_per_chapter) &&
      next.target_words_per_chapter < next.min_words_per_chapter
    ) {
      next.target_words_per_chapter = next.min_words_per_chapter;
    }
  }
  if (patch.fact_check !== undefined) {
    next.fact_check = mergeNullableSection(project.fact_check, patch.fact_check);
  }
  return next;
}

const REASONING_EFFORT_LEVELS = new Set(["auto", "low", "medium", "high"]);

// 项目级思考强度：auto（默认，不发送 reasoning_effort）/low/medium/high。
// 未配置的既有项目读取时视为 auto（请求构造层只认 low/medium/high）。
function normalizeReasoningEffort(value) {
  if (value === null || value === "") {
    return "auto";
  }
  if (typeof value !== "string" || !REASONING_EFFORT_LEVELS.has(value.trim())) {
    throw new SettingsValidationError("invalid_reasoning_effort", "reasoning_effort must be one of auto/low/medium/high.");
  }
  return value.trim();
}

function normalizeProjectProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new SettingsValidationError("invalid_project_profile", "project_profile must be an object.");
  }
  const normalized = {};
  if (profile.title !== undefined && profile.title !== null && profile.title !== "") {
    normalized.title = safeNonEmptyString(profile.title, "title");
  }
  copyOptionalPositiveInteger(normalized, profile, "target_chapters");
  copyOptionalPositiveInteger(normalized, profile, "min_words_per_chapter");
  copyOptionalPositiveInteger(normalized, profile, "target_words_per_chapter");
  return normalized;
}

function normalizeActiveModel(activeModel) {
  if (!activeModel || typeof activeModel !== "object" || Array.isArray(activeModel)) {
    throw new SettingsValidationError("invalid_active_model", "active_model must be an object.");
  }
  const provider = safeProvider(activeModel.provider);
  const modelName = safeNonEmptyString(activeModel.model_name, "model_name");
  const normalized = {
    provider,
    model_name: modelName
  };
  copyOptionalUrl(normalized, activeModel, "base_url");
  copyOptionalEnv(normalized, activeModel, "api_key_env");
  copyOptionalString(normalized, activeModel, "cache_mode");
  copyOptionalPositiveInteger(normalized, activeModel, "max_context_tokens");
  copyOptionalPositiveInteger(normalized, activeModel, "max_output_tokens");
  copyOptionalPositiveInteger(normalized, activeModel, "timeout_ms");
  copyOptionalPositiveInteger(normalized, activeModel, "total_deadline_ms");
  copyOptionalTemperature(normalized, activeModel, "temperature");
  if (activeModel.stream !== undefined) {
    normalized.stream = activeModel.stream === true;
  }
  return normalized;
}

function normalizeToolPermissions(permissions) {
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) {
    throw new SettingsValidationError("invalid_tool_permissions", "tool_permissions must be an object.");
  }
  if (permissions.dangerous === true) {
    throw new SettingsValidationError("dangerous_permission_rejected", "Dangerous permissions cannot be enabled from the standard settings panel.");
  }
  const normalized = {};
  for (const key of ["network_allowed", "safe_edit", "test_allowed", "read_only"]) {
    if (permissions[key] !== undefined) {
      normalized[key] = permissions[key] === true;
    }
  }
  if (permissions.dangerous !== undefined) {
    normalized.dangerous = false;
  }
  if (permissions.auto_edit !== undefined) {
    normalized.auto_edit = permissions.auto_edit === true;
  }
  if (permissions.yolo !== undefined) {
    normalized.yolo = permissions.yolo === true;
  }
  if (normalized.read_only === true) {
    normalized.safe_edit = false;
  }
  return normalized;
}

function normalizeBudgetConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new SettingsValidationError("invalid_budget_config", "budget_config must be an object.");
  }
  const normalized = {};
  copyOptionalPositiveInteger(normalized, config, "max_model_calls");
  copyOptionalPositiveInteger(normalized, config, "max_revision_rounds_per_chapter");
  copyOptionalPositiveNumber(normalized, config, "max_cost");
  copyOptionalPositiveInteger(normalized, config, "max_total_tokens");
  return normalized;
}

function normalizeResearchConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new SettingsValidationError("invalid_research_config", "research_config must be an object.");
  }
  const normalized = {};
  copyOptionalUrl(normalized, config, "search_endpoint");
  copyOptionalEnv(normalized, config, "search_api_key_env");
  copyOptionalString(normalized, config, "search_query_param");
  copyOptionalString(normalized, config, "search_limit_param");
  copyOptionalString(normalized, config, "search_results_path");
  if (config.search_result_map !== undefined) {
    if (!config.search_result_map || typeof config.search_result_map !== "object" || Array.isArray(config.search_result_map)) {
      throw new SettingsValidationError("invalid_search_result_map", "search_result_map must be an object.");
    }
    normalized.search_result_map = {};
    for (const key of ["title", "url", "snippet"]) {
      if (config.search_result_map[key] !== undefined) {
        normalized.search_result_map[key] = safeNonEmptyString(config.search_result_map[key], `search_result_map.${key}`);
      }
    }
  }
  copyOptionalPositiveInteger(normalized, config, "max_fetch_chars");
  return normalized;
}

function normalizeFactCheck(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new SettingsValidationError("invalid_fact_check", "fact_check must be an object.");
  }
  const normalized = {};
  if (config.enabled !== undefined) {
    normalized.enabled = config.enabled === true;
  }
  if (config.hard !== undefined) {
    normalized.hard = config.hard === true;
  }
  return normalized;
}

function safeProvider(value) {
  const provider = safeNonEmptyString(value, "provider");
  if (!SAFE_NAME.test(provider)) {
    throw new SettingsValidationError("invalid_provider", "provider contains unsupported characters.");
  }
  return provider;
}

function safeNonEmptyString(value, key) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 500) {
    throw new SettingsValidationError(`invalid_${key.replace(/\W+/gu, "_")}`, `${key} must be a non-empty string.`);
  }
  return value.trim();
}

function copyOptionalString(target, source, key) {
  if (source[key] === undefined) {
    return;
  }
  if (source[key] === "" || source[key] === null) {
    target[key] = null;
    return;
  }
  target[key] = safeNonEmptyString(source[key], key);
}

function copyOptionalEnv(target, source, key) {
  if (source[key] === undefined) {
    return;
  }
  if (source[key] === "" || source[key] === null) {
    target[key] = null;
    return;
  }
  const value = safeNonEmptyString(source[key], key);
  if (!ENV_NAME.test(value)) {
    throw new SettingsValidationError(`invalid_${key}`, `${key} 必须是环境变量名，例如 XIAOMI_MIMO_API_KEY；不要填写 sk- 开头的真实密钥。`);
  }
  target[key] = value;
}

function copyOptionalUrl(target, source, key) {
  if (source[key] === undefined) {
    return;
  }
  if (source[key] === "" || source[key] === null) {
    target[key] = null;
    return;
  }
  const value = safeNonEmptyString(source[key], key);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new SettingsValidationError(`invalid_${key}`, `${key} must be a valid URL.`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new SettingsValidationError(`invalid_${key}`, `${key} must use http or https.`);
  }
  target[key] = value;
}

function copyOptionalPositiveInteger(target, source, key) {
  if (source[key] === undefined) {
    return;
  }
  if (source[key] === "" || source[key] === null) {
    target[key] = null;
    return;
  }
  const value = Number(source[key]);
  if (!Number.isInteger(value) || value < 1) {
    throw new SettingsValidationError(`invalid_${key}`, `${key} must be a positive integer.`);
  }
  target[key] = value;
}

function copyOptionalPositiveNumber(target, source, key) {
  if (source[key] === undefined) {
    return;
  }
  if (source[key] === "" || source[key] === null) {
    target[key] = null;
    return;
  }
  const value = Number(source[key]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new SettingsValidationError(`invalid_${key}`, `${key} must be a positive number.`);
  }
  target[key] = value;
}

// 温度 0-2 校验：undefined / null / "" 表示「未配置不携带」；合法数值原样保留；非法数值直接报错。
// 注：validateModelConfig（model-config-validation.mjs）把 "" 视为 0（Number("")===0），
// 与这里「空串不携带」语义不同；面板层已先剥离空串，两条 API 路径暂不会互相踩到。
function copyOptionalTemperature(target, source, key) {
  if (source[key] === undefined || source[key] === null || source[key] === "") {
    return;
  }
  const value = Number(source[key]);
  if (!Number.isFinite(value) || value < 0 || value > 2) {
    throw new SettingsValidationError(`invalid_${key}`, `${key} must be a number between 0 and 2.`);
  }
  target[key] = value;
}

function mergeNullableSection(base = {}, patch = {}) {
  const next = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === null) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  return next;
}

function pruneNullFields(value = {}) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null));
}

// ---------------------------------------------------------------------------
// 模型档案展示与模型切换（第十五轮 F10 Task 21：自 http/settings-routes.mjs
// 函数体逐字下沉；路由壳只留参数解构、错误映射与响应序列化）。
// ---------------------------------------------------------------------------

export function providerDisplayName(activeModel = {}) {
  const provider = activeModel?.provider ?? "openai-compatible";
  const baseUrl = String(activeModel?.base_url ?? "").toLowerCase();
  const envName = activeModel?.api_key_env ?? "";
  // 用户声明的厂商显示名（provider_label）优先——这是「已配置」列表里模型身份
  // 的权威来源（2026-08-11 新增，借鉴 WHnovel 自由 name 但结构化：展示名 =
  // 厂商名 + 模型 ID）。未声明时才回落到按真实地址推断。
  const declaredLabel = typeof activeModel?.provider_label === "string" ? activeModel.provider_label.trim() : "";
  if (declaredLabel) {
    return declaredLabel;
  }
  // 官方端点判定只看真实地址（包含匹配，兼容 /v1、端口与大小写变体），不凭
  // model_name 前缀猜——第三方中转（如 opencode.ai）上挂 deepseek-/mimo- 名号的
  // 模型不是官方，必须和官方条目在「已配置」列表里区分开（2026-08-11 修复）。
  if (baseUrl.includes("api.deepseek.com") || envName === "DEEPSEEK_API_KEY") {
    return "DeepSeek 官方";
  }
  if (baseUrl.includes("xiaomimimo.com") || envName === "XIAOMI_MIMO_API_KEY") {
    return "小米 MiMo 官方";
  }
  // 自定义兼容端点：显示厂商名 + 主机，与官方条目可区分。
  if (provider === "openai-compatible") {
    const host = baseUrlHost(baseUrl);
    return host ? `OpenAI 兼容 · ${host}` : provider;
  }
  return provider;
}

function baseUrlHost(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "";
  }
}

export function modelDisplayName(activeModel = {}) {
  const label = providerDisplayName(activeModel);
  const modelName = activeModel?.model_name ?? "";
  return modelName ? `${label} / ${modelName}` : label;
}

export function modelEndpoint(baseUrl) {
  if (!baseUrl) {
    return "";
  }
  try {
    return new URL("chat/completions", String(baseUrl).endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
  } catch {
    return "";
  }
}

export function buildModelProfile(activeModel = {}, secretsRoot, options = {}) {
  // Task 8：未配置模型 = active_model null（用户面不再以 mock 兜底）。
  // 显式 provider/model_name 之外的形状（空对象/null）一律按未配置展示，
  // 绝不出现 "Mock" 字样。
  const isConfigured = Boolean(
    activeModel &&
    typeof activeModel === "object" &&
    !Array.isArray(activeModel) &&
    (activeModel.model_name || activeModel.provider)
  );
  if (!isConfigured) {
    return {
      provider: null,
      provider_label: null,
      model_name: null,
      base_url: "",
      endpoint: "",
      api_key_env: null,
      api_key_saved: false,
      api_key_masked: "",
      is_mock: false,
      display: "未配置",
      model_label: "未配置",
      id: options.id ?? null,
      saved_to: options.saved_to ?? "project.yaml",
      capabilities: null,
      pricing: null,
      temperature: null,
      context_window: null,
      max_output_tokens: null
    };
  }
  const provider = activeModel?.provider ?? "openai-compatible";
  const modelName = activeModel?.model_name ?? null;
  const apiKeyEnv = activeModel?.api_key_env ?? null;
  const secretValue = apiKeyEnv ? loadLocalSecretsSync(secretsRoot)[apiKeyEnv] ?? process.env[apiKeyEnv] ?? "" : "";
  const limits = resolveModelLimits(activeModel);
  return {
    provider,
    provider_label: providerDisplayName(activeModel),
    model_name: modelName,
    base_url: activeModel?.base_url ?? "",
    endpoint: provider === "openai-compatible" ? modelEndpoint(activeModel?.base_url) : "",
    api_key_env: apiKeyEnv,
    api_key_saved: Boolean(secretValue),
    api_key_masked: secretValue ? `••••${secretValue.slice(-4)}` : "",
    is_mock: provider === "mock",
    display: modelDisplayName(activeModel),
    model_label: modelDisplayName(activeModel),
    id: options.id ?? modelName,
    saved_to: options.saved_to ?? "project.yaml",
    capabilities: resolveModelCapabilities(activeModel),
    // 价格与温度一并带回：设置面板无项目时用全局默认模型渲染表单，
    // 缺这两个字段会显示成空白（价格已保存却看不见）。
    pricing: activeModel?.pricing ?? null,
    temperature: activeModel?.temperature ?? null,
    // 第十三轮（F6）：高级项参数可见，缺省口径与运行时同一解析函数。
    context_window: limits.effective_context_window,
    max_output_tokens: limits.effective_max_output_tokens
  };
}

// Task 16：模型切换（引用形态）——校验 { provider_id, model_id } 在 v2 清单中
// 存在且供应商/模型均启用 + 写作能力 C 档，然后写项目引用到应用私有 settings。
// 响应为引用契约（active_model = 引用），不再返回旧 available_models/model_profile。
// secretsRoot/workspaceStore 由路由壳注入（原 createSettingsRoutes 工厂闭包依赖
// 显式化）。
export async function switchModelByReference({ body, projectRoot, secretsRoot, workspaceStore }) {
  const providerId = String(body?.provider_id ?? "").trim();
  const modelId = String(body?.model_id ?? "").trim();
  if (!providerId || !modelId) {
    throw new HttpError(400, "invalid_model_reference", "provider_id 与 model_id 均必填。");
  }
  const store = await loadProviderStore(secretsRoot);
  const provider = store.providers.find((p) => p.id === providerId);
  const model = provider?.models.find((m) => m.id === modelId);
  if (!provider || !model) {
    throw new HttpError(404, "model_profile_not_found", `未找到已配置模型：${providerId}/${modelId}`);
  }
  if (provider.status === "disabled") {
    throw new HttpError(400, "provider_disabled", "该供应商已停用，无法切换。");
  }
  if (model.enabled === false) {
    throw new HttpError(400, "model_disabled", "该模型已停用，无法切换。");
  }
  const literal = toRequestConfig(provider, model);
  if (!writingRequiredCapabilitiesOk(literal)) {
    throw new HttpError(400, "model_unsupported", "该模型不支持工具调用，无法用于小说写作。");
  }
  const reference = { provider_id: provider.id, model_id: model.id };
  const before = await assertNotArchived(projectRoot, { workspaceStore });
  const caps = resolveModelCapabilities(literal);
  const conflicts = [];
  if (caps.supportsTemperature === false && before.active_model?.temperature !== undefined) {
    conflicts.push("该模型不支持温度设置，写作温度不会生效。");
  }
  // 任务 5 Step 5：统一走 saveWorkspaceSettings——成对携带 active_model（引用）
  // 与 tool_permissions（保留当前有效权限）；运行时按 modelStoreLoader 解析。
  await saveWorkspaceSettings(projectRoot, { workspaceStore, activeModel: reference, effectiveConfig: before });
  const effective = await loadEffectiveWorkspaceConfig(projectRoot, {
    workspaceStore,
    modelStoreLoader: () => store
  });
  return {
    ok: true,
    projectRoot,
    active_model: reference,
    capabilities: caps,
    conflicts,
    project: {
      project_id: effective.project_id ?? null,
      active_model: effective.active_model,
      tool_permissions: effective.tool_permissions ?? {}
    },
    effective_config: effective
  };
}
