import { appendEvent } from "./event-log.mjs";
import { loadProject, loadState, saveProject, saveState } from "./project-store.mjs";

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
  await syncBudgetConfigToState(projectRoot, normalized.budget_config);
  await maybeReopenCompletedProject(projectRoot, next, normalized.project_profile);
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

async function syncBudgetConfigToState(projectRoot, budgetConfig) {
  if (budgetConfig === undefined) {
    return;
  }
  const state = await loadState(projectRoot);
  const budget = {
    model_calls: 0,
    revision_rounds_by_chapter: {},
    ...(state.active_budget ?? {})
  };
  for (const key of ["max_model_calls", "max_revision_rounds_per_chapter"]) {
    if (budgetConfig[key] === undefined) {
      continue;
    }
    if (budgetConfig[key] === null) {
      delete budget[key];
    } else {
      budget[key] = budgetConfig[key];
    }
  }
  state.active_budget = budget;
  await saveState(projectRoot, state);
}

async function maybeReopenCompletedProject(projectRoot, project, profile) {
  if (!profile?.target_chapters) {
    return;
  }
  const state = await loadState(projectRoot);
  if (state.project_status !== "completed") {
    return;
  }
  if ((state.current_chapter_no ?? 1) > project.target_chapters) {
    return;
  }
  await saveState(projectRoot, {
    ...state,
    project_status: "idle",
    current_stage: "queued",
    stage_entered_at: new Date().toISOString()
  });
  await appendEvent(projectRoot, {
    type: "project_reopened",
    project_id: project.project_id,
    chapter_no: state.current_chapter_no,
    stage: "queued",
    message: `目标章节数提高到 ${project.target_chapters}，项目可以继续写作。`
  });
}

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
  if (patch.project_profile !== undefined) {
    normalized.project_profile = normalizeProjectProfile(patch.project_profile);
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
  return next;
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
