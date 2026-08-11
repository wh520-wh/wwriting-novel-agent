import { readJson, safeJoin } from "./fs-utils.mjs";
import { loadProject } from "./project-store.mjs";
import { workspaceIdForPath } from "./workspaces/store.mjs";
import { resolveActiveModel } from "./model-reference.mjs";

export const DEFAULT_CONFIG = {
  // 未配置模型 = active_model: null（用户面不再以 mock 作为兜底）
  active_model: null,
  stage_overrides: {
    enabled: false
    // 各 stage 覆盖示例：
    // drafting:   { enabled: true, model_name: "deepseek-chat", total_deadline_ms: 600000 },
    // chat:       { enabled: true, model_name: "deepseek-chat", total_deadline_ms: 120000 },
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
};

// 任务 5：普通工作区（无 project.yaml / 无应用私有 settings）的有效配置安全默认。
// 与既有 per-project 兜底对齐：无 YOLO、无自动编辑、网络关闭、无归档、输出格式 md；
// tool_permissions 形状对齐 DEFAULT_CONFIG（safe_edit 默认 true，与 createProject 一致）。
export const FALLBACK_WORKSPACE_CONFIG = Object.freeze({
  project_id: null,
  output_format: "md",
  archived_at: null,
  active_model: null,
  tool_permissions: Object.freeze({
    read_only: false,
    safe_edit: true,
    test_allowed: false,
    network_allowed: false,
    dangerous: false,
    auto_edit: false,
    yolo: false
  })
});

// 任务 5：统一工作区有效配置合并（冻结契约，见任务 5 简报 Step 2 / 计划 §2.3）。
// 合并顺序：FALLBACK → 旧 project.yaml（只读兼容输入）→ 应用私有 workspace settings
// （优先）。active_model 与 tool_permissions 按字段优先；projectRoot/workspace_id
// 由调用方路径稳定派生。旧 project.yaml 只作兼容输入，绝不在此写入。
//
// 任务 5 接入引用解析：modelStoreLoader 提供全局供应商→模型两级清单（缺省 null 时
// 保持旧行为——active_model 原样透传）；提供时 active_model 若为引用则实时解析为
// 完整配置，悬空/停用降级全局默认模型并附 resolution_note（未解析时为 null）。
export async function loadEffectiveWorkspaceConfig(projectRoot, { workspaceStore, modelStoreLoader = null } = {}) {
  const legacyProject = await loadProject(projectRoot).catch(() => ({}));
  const privateSettings = await workspaceStore.loadSettings(projectRoot);
  let resolutionNote = null;
  let activeModel = privateSettings.active_model ?? legacyProject.active_model ?? null;
  if (modelStoreLoader) {
    const store = await modelStoreLoader();
    const resolved = resolveActiveModel(activeModel, store);
    activeModel = resolved.model;
    resolutionNote = resolved.note;
  }
  return {
    ...FALLBACK_WORKSPACE_CONFIG,
    ...legacyProject,
    ...privateSettings,
    active_model: activeModel,
    resolution_note: resolutionNote,
    tool_permissions: {
      ...FALLBACK_WORKSPACE_CONFIG.tool_permissions,
      ...(legacyProject.tool_permissions ?? {}),
      ...(privateSettings.tool_permissions ?? {})
    },
    projectRoot,
    workspace_id: workspaceIdForPath(projectRoot)
  };
}

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
  copyIfDefined(config, source, "default_writer_model");
  copyIfDefined(config, source, "default_reviewer_model");

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
