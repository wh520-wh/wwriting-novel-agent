import { appendEvent } from "./event-log.mjs";
import { loadProject, saveProject } from "./project-store.mjs";
import {
  applyLocalSecretsToEnv,
  loadLocalSecrets,
  saveLocalSecrets
} from "./local-secrets.mjs";
import {
  ModelConfigValidationError,
  validateModelConfig
} from "./model-config-validation.mjs";
import { fillOfficialPricing, normalizePricing } from "./model-pricing.mjs";

const SAFE_NAME = /^[A-Za-z0-9_.-]+$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const STAGES = new Set(["planning", "drafting", "reviewing", "revising", "outline"]);

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

// Transactional model settings save.
//
// Reads the old project + old secrets, validates the candidate, then performs
// the durable writes in project → secrets order. If secrets fail, restores the
// old project snapshot. If runtime apply fails, keeps the durable writes —
// another reader may already have observed them, and the only safe action is
// to surface a restart-required error.
//
// The function NEVER persists `api_key` into the project file, the returned
// project, the response, or any event log. Raw secrets are confined to the
// secrets file and process env (via `applyLocalSecretsToEnv`).
export async function saveModelSettingsTransaction({
  projectRoot,
  secretsRoot,
  activeModel,
  readProject = loadProject,
  writeProject = saveProject,
  readSecrets = loadLocalSecrets,
  writeSecrets = saveLocalSecrets,
  applySecrets = applyLocalSecretsToEnv
} = {}) {
  if (!projectRoot || typeof projectRoot !== "string") {
    throw new SettingsValidationError("invalid_project_root", "projectRoot is required.");
  }
  if (!activeModel || typeof activeModel !== "object" || Array.isArray(activeModel)) {
    throw new SettingsValidationError("invalid_active_model", "active_model is required.");
  }

  // 1. Read old project and old secrets up front — used for rollback and
  //    secret-presence checks. Re-throw raw IO errors; the caller (server)
  //    maps anything not in our known codes to a 500.
  const oldProject = await readProject(projectRoot);
  const oldSecrets = await readSecrets(secretsRoot);

  // 2. Validate the candidate. The `api_key` field is stripped before being
  //    seen by the validator (it never leaves the secrets file / process env).
  const candidate = { ...activeModel };
  const transientApiKey = typeof candidate.api_key === "string" ? candidate.api_key.trim() : "";
  delete candidate.api_key;
  const validated = validateModelConfig(candidate);

  // 3. For openai-compatible, we need either a pre-existing secret for this
  //    env name OR a non-empty transient api_key in the request body.
  if (validated.provider === "openai-compatible") {
    const hasExistingSecret = Boolean(oldSecrets[validated.api_key_env]);
    if (!hasExistingSecret && !transientApiKey) {
      throw new ModelConfigValidationError({
        api_key: "请输入 API Key，或先在 Windows 环境变量中配置。"
      });
    }
  }

  // 4. Compute the next durable state.
  const nextProject = mergeProjectSettings(oldProject, {
    active_model: { ...validated }
  });
  const nextSecrets = transientApiKey
    ? { ...oldSecrets, [validated.api_key_env ?? "API_KEY_ENV"]: transientApiKey }
    : { ...oldSecrets };

  // 5. Write project first. Surface raw IO errors as-is; the server turns
  //    non-HttpError failures into 500.
  await writeProject(projectRoot, nextProject);

  // 6. Write secrets. On failure, attempt to restore the old project. If the
  //    restore also fails, wrap both errors and surface a rollback error so
  //    the operator knows the durable state is in an unknown shape.
  try {
    await writeSecrets(secretsRoot, nextSecrets);
  } catch (writeError) {
    try {
      await writeProject(projectRoot, oldProject);
    } catch (rollbackError) {
      const err = new SettingsValidationError(
        "settings_rollback_failed",
        "设置保存失败且回滚失败：项目文件可能与 secrets 不一致，请人工检查。"
      );
      err.cause = writeError;
      err.rollbackError = rollbackError;
      throw err;
    }
    const err = new SettingsValidationError(
      "settings_save_failed",
      writeError?.message ?? "设置保存失败：无法写入本地密钥。"
    );
    err.cause = writeError;
    throw err;
  }

  // 7. Apply secrets to the running process. Failure here is NOT rolled back
  //    because the durable files have already been observed by other readers
  //    (and our own subsequent reads); the only safe action is to tell the
  //    caller to restart the app for the new env vars to take effect.
  try {
    applySecrets(nextSecrets);
  } catch (applyError) {
    const err = new SettingsValidationError(
      "settings_runtime_apply_failed",
      "密钥已保存到磁盘，但未能应用到当前进程环境。请重启 App Shell 让新配置生效。"
    );
    err.cause = applyError;
    throw err;
  }

  return {
    project: nextProject,
    secrets: nextSecrets,
    secret_saved: Boolean(transientApiKey),
    secret_env: validated.api_key_env ?? null
  };
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
  if (patch.stage_overrides !== undefined) {
    normalized.stage_overrides = normalizeStageOverrides(patch.stage_overrides);
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
  if (patch.output_style !== undefined) {
    normalized.output_style = normalizeOutputStyle(patch.output_style);
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
  if (patch.memory_extraction !== undefined) {
    normalized.memory_extraction = normalizeMemoryExtraction(patch.memory_extraction);
  }
  if (patch.fact_check !== undefined) {
    normalized.fact_check = normalizeFactCheck(patch.fact_check);
  }
  return normalized;
}

function mergeProjectSettings(project, patch) {
  const next = {
    ...project,
    ...copyObjectKey(patch, "stage_overrides"),
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
  if (patch.output_style !== undefined) {
    next.output_style = patch.output_style;
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
    if (
      Number.isInteger(next.max_words_per_chapter) &&
      Number.isInteger(next.min_words_per_chapter) &&
      next.max_words_per_chapter < next.min_words_per_chapter
    ) {
      next.max_words_per_chapter = next.min_words_per_chapter;
    }
  }
  if (patch.memory_extraction !== undefined) {
    next.memory_extraction = mergeNullableSection(project.memory_extraction, patch.memory_extraction);
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
  copyOptionalPositiveInteger(normalized, profile, "max_words_per_chapter");
  return normalized;
}

function normalizeOutputStyle(value) {
  if (value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new SettingsValidationError("invalid_output_style", "output_style must be a string.");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 100) {
    throw new SettingsValidationError("invalid_output_style", "output_style must be 1-100 characters.");
  }
  if (!/^[A-Za-z0-9_.\- ]+$/u.test(trimmed)) {
    throw new SettingsValidationError("invalid_output_style", "output_style contains unsupported characters.");
  }
  return trimmed;
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
  copyOptionalTemperature(normalized, activeModel, "temperature");
  if (activeModel.stream !== undefined) {
    normalized.stream = activeModel.stream === true;
  }
  return normalized;
}

function normalizeStageOverrides(stageOverrides) {
  if (!stageOverrides || typeof stageOverrides !== "object" || Array.isArray(stageOverrides)) {
    throw new SettingsValidationError("invalid_stage_overrides", "stage_overrides must be an object.");
  }
  const normalized = {
    enabled: stageOverrides.enabled === true
  };
  for (const [stage, config] of Object.entries(stageOverrides)) {
    if (stage === "enabled") {
      continue;
    }
    if (!STAGES.has(stage)) {
      throw new SettingsValidationError("invalid_stage_override", `Unsupported stage override: ${stage}`);
    }
    normalized[stage] = {
      ...normalizeActiveModel(config),
      enabled: config.enabled === true
    };
    // normalizeActiveModel does not copy pricing — preserve it explicitly
    if (config.pricing !== undefined) {
      if (config.pricing === null) {
        delete normalized[stage].pricing;
      } else {
        const pricing = normalizePricing(config.pricing);
        if (pricing) normalized[stage].pricing = pricing;
      }
    }
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

function normalizeMemoryExtraction(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new SettingsValidationError("invalid_memory_extraction", "memory_extraction must be an object.");
  }
  const normalized = {};
  if (config.enabled !== undefined) {
    normalized.enabled = config.enabled === true;
  }
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

function copyObjectKey(source, key) {
  return source[key] === undefined ? {} : { [key]: source[key] };
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
