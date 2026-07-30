import { readJson, safeJoin } from "./fs-utils.mjs";

export const DEFAULT_CONFIG = {
  active_model: {
    provider: "mock",
    model_name: "mock-writer"
  },
  stage_overrides: {
    enabled: false
  },
  tool_permissions: {
    read_only: false,
    safe_edit: true,
    test_allowed: false,
    network_allowed: false,
    dangerous: false
  },
  budget_config: {},
  cache_config: {},
  research_config: {},
  enabled_skills: [],
  chat_max_tool_rounds: 32,
  auto_resume_on_start: false
};

export async function loadConfigLayers(projectRoot, project = {}, options = {}) {
  const [globalConfig, localConfig, policyConfig] = await Promise.all([
    options.globalConfig ?? readJson(safeJoin(projectRoot, "config", "global_config.json"), {}),
    options.localConfig ?? readJson(safeJoin(projectRoot, "config", "local_config.json"), {}),
    options.policyConfig ?? readJson(safeJoin(projectRoot, "config", "policy_config.json"), {})
  ]);
  return resolveConfigLayers({
    globalConfig,
    projectConfig: options.projectConfig ?? project,
    localConfig,
    policyConfig
  });
}

export function resolveConfigLayers({ globalConfig = {}, projectConfig = {}, localConfig = {}, policyConfig = {} } = {}) {
  const normalizedGlobal = normalizeConfigLayer(globalConfig);
  const normalizedProject = normalizeConfigLayer(projectConfig);
  const normalizedLocal = normalizeConfigLayer(localConfig);
  const normalizedPolicy = normalizeConfigLayer(policyConfig, { policy: true });
  const effective = deepMerge(DEFAULT_CONFIG, normalizedGlobal, normalizedProject, normalizedLocal, normalizedPolicy);
  if (normalizedPolicy.forbid_network === true) {
    effective.tool_permissions.network_allowed = false;
  }
  if (normalizedPolicy.read_only === true || normalizedPolicy.tool_permissions?.read_only === true) {
    effective.tool_permissions.read_only = true;
    effective.tool_permissions.safe_edit = false;
  }
  if (normalizedPolicy.forbid_dangerous === true) {
    effective.tool_permissions.dangerous = false;
  }
  return {
    effective,
    layers: {
      global: normalizedGlobal,
      project: normalizedProject,
      local: normalizedLocal,
      policy: normalizedPolicy
    }
  };
}

export function resolveRuntimeConfig(project = {}, options = {}) {
  if (options.effectiveConfig) {
    return options.effectiveConfig;
  }
  if (project.effective_config) {
    return project.effective_config;
  }

  const optionPermissionLayer = {};
  if (options.networkAllowed !== undefined) {
    optionPermissionLayer.tool_permissions = {
      network_allowed: options.networkAllowed === true
    };
  }

  return resolveConfigLayers({
    globalConfig: options.globalConfig ?? {},
    projectConfig: deepMerge(project, project.config ?? {}, options.config ?? {}),
    localConfig: deepMerge(project.local_config ?? {}, options.localConfig ?? {}, optionPermissionLayer),
    policyConfig: deepMerge(project.policy_config ?? {}, options.policyConfig ?? {})
  }).effective;
}

export function normalizeConfigLayer(layer = {}, options = {}) {
  const source = layer ?? {};
  const config = {};
  if (source.global_config) {
    mergeInto(config, normalizeConfigLayer(source.global_config));
  }
  if (source.project_config) {
    mergeInto(config, normalizeConfigLayer(source.project_config));
  }
  if (source.local_config) {
    mergeInto(config, normalizeConfigLayer(source.local_config));
  }
  if (source.policy_config) {
    mergeInto(config, normalizeConfigLayer(source.policy_config, { policy: true }));
  }

  copyIfDefined(config, source, "active_model");
  copyIfDefined(config, source, "stage_overrides");
  copyIfDefined(config, source, "tool_permissions");
  copyIfDefined(config, source, "budget_config");
  copyIfDefined(config, source, "cache_config");
  copyIfDefined(config, source, "research_config");
  copyIfDefined(config, source, "enabled_skills");
  copyIfDefined(config, source, "default_writer_model");
  copyIfDefined(config, source, "default_reviewer_model");
  copyIfDefined(config, source, "chat_max_tool_rounds");
  copyIfDefined(config, source, "auto_resume_on_start");

  if (source.network_allowed !== undefined) {
    config.tool_permissions ??= {};
    config.tool_permissions.network_allowed = source.network_allowed;
  }
  if (source.safe_edit !== undefined) {
    config.tool_permissions ??= {};
    config.tool_permissions.safe_edit = source.safe_edit;
  }
  if (source.read_only !== undefined) {
    config.tool_permissions ??= {};
    config.tool_permissions.read_only = source.read_only;
  }
  if (source.dangerous !== undefined) {
    config.tool_permissions ??= {};
    config.tool_permissions.dangerous = source.dangerous;
  }
  if (source.test_allowed !== undefined) {
    config.tool_permissions ??= {};
    config.tool_permissions.test_allowed = source.test_allowed;
  }
  if (source.max_model_calls !== undefined || source.max_revision_rounds_per_chapter !== undefined) {
    config.budget_config ??= {};
    copyIfDefined(config.budget_config, source, "max_model_calls");
    copyIfDefined(config.budget_config, source, "max_revision_rounds_per_chapter");
  }
  if (source.default_writer_model && !source.active_model) {
    config.active_model ??= {};
    config.active_model.model_name = source.default_writer_model;
  }
  if (options.policy) {
    copyIfDefined(config, source, "forbid_network");
    copyIfDefined(config, source, "forbid_dangerous");
    copyIfDefined(config, source, "read_only");
  }
  return config;
}

export function deepMerge(...values) {
  const result = {};
  for (const value of values) {
    if (!isPlainObject(value)) {
      continue;
    }
    mergeInto(result, value);
  }
  return result;
}

export function isPermissionAllowed(effectiveConfig, permissionName) {
  return effectiveConfig?.tool_permissions?.[permissionName] === true;
}

function mergeInto(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(target[key])) {
      mergeInto(target[key], value);
    } else if (Array.isArray(value)) {
      target[key] = [...value];
    } else if (isPlainObject(value)) {
      target[key] = deepMerge(value);
    } else {
      target[key] = value;
    }
  }
}

function copyIfDefined(target, source, key) {
  if (source[key] !== undefined) {
    target[key] = source[key];
  }
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}
