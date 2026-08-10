import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_CONFIG,
  FALLBACK_WORKSPACE_CONFIG,
  isPermissionAllowed,
  loadConfigLayers,
  loadEffectiveWorkspaceConfig,
  normalizeConfigLayer,
  resolveConfigLayers,
  resolveRuntimeConfig
} from "../src/core/config-runtime.mjs";
import { createProject } from "../src/core/project-store.mjs";
import { createWorkspaceStore, workspaceIdForPath } from "../src/core/workspaces/store.mjs";

test("config layers merge global, project, local, then policy", () => {
  const { effective } = resolveConfigLayers({
    globalConfig: {
      active_model: { provider: "global", model_name: "global-writer" },
      tool_permissions: { test_allowed: false }
    },
    projectConfig: {
      active_model: { provider: "project", model_name: "project-writer" },
      tool_permissions: { network_allowed: true, safe_edit: true, dangerous: true }
    },
    localConfig: {
      active_model: { provider: "local", model_name: "local-writer" },
      tool_permissions: { test_allowed: true }
    },
    policyConfig: {
      forbid_network: true,
      forbid_dangerous: true,
      read_only: true
    }
  });

  assert.deepEqual(effective.active_model, { provider: "local", model_name: "local-writer" });
  assert.equal(effective.tool_permissions.network_allowed, false);
  assert.equal(effective.tool_permissions.dangerous, false);
  assert.equal(effective.tool_permissions.read_only, true);
  assert.equal(effective.tool_permissions.safe_edit, false);
  assert.equal(effective.tool_permissions.test_allowed, true);
});

test("legacy permission fields normalize into tool_permissions", () => {
  const { effective } = resolveConfigLayers({
    projectConfig: {
      network_allowed: true,
      safe_edit: false,
      max_model_calls: 7
    }
  });
  assert.equal(isPermissionAllowed(effective, "network_allowed"), true);
  assert.equal(effective.tool_permissions.safe_edit, false);
  assert.equal(effective.budget_config.max_model_calls, 7);
});

test("Task 8：死配置字段已删除——DEFAULT_CONFIG 与 normalizeConfigLayer 不再透传 chat_max_tool_rounds/auto_resume_on_start", () => {
  assert.equal(DEFAULT_CONFIG.chat_max_tool_rounds, undefined, "DEFAULT_CONFIG 不得再含 chat_max_tool_rounds");
  assert.equal(DEFAULT_CONFIG.auto_resume_on_start, undefined, "DEFAULT_CONFIG 不得再含 auto_resume_on_start");

  // normalizeConfigLayer 不再透传这两个遗留字段：旧配置层即使携带也不进入有效配置。
  const normalized = normalizeConfigLayer({
    chat_max_tool_rounds: 8,
    auto_resume_on_start: true
  });
  assert.equal(normalized.chat_max_tool_rounds, undefined, "normalizeConfigLayer 不得透传 chat_max_tool_rounds");
  assert.equal(normalized.auto_resume_on_start, undefined, "normalizeConfigLayer 不得透传 auto_resume_on_start");

  const { effective } = resolveConfigLayers({
    projectConfig: { chat_max_tool_rounds: 8, auto_resume_on_start: true }
  });
  assert.equal(effective.chat_max_tool_rounds, undefined, "有效配置不得含 chat_max_tool_rounds");
  assert.equal(effective.auto_resume_on_start, undefined, "有效配置不得含 auto_resume_on_start");
  // 合规字段不受影响（回归守卫）
  assert.equal(effective.budget_config.max_model_calls, undefined);
  assert.equal(typeof effective.budget_config, "object", "budget_config 默认结构保留");
});

test("runtime config option permissions cannot override policy", () => {
  const effective = resolveRuntimeConfig(
    {
      tool_permissions: { network_allowed: false },
      policy_config: { forbid_network: true }
    },
    {
      networkAllowed: true
    }
  );
  assert.equal(effective.tool_permissions.network_allowed, false);
});

test("loadConfigLayers reads project config files", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-config-"));
  await fs.mkdir(path.join(projectRoot, "config"));
  await fs.writeFile(
    path.join(projectRoot, "config", "global_config.json"),
    JSON.stringify({ active_model: { provider: "global", model_name: "global-writer" } })
  );
  await fs.writeFile(
    path.join(projectRoot, "config", "local_config.json"),
    JSON.stringify({ active_model: { provider: "local", model_name: "local-writer" } })
  );
  await fs.writeFile(path.join(projectRoot, "config", "policy_config.json"), JSON.stringify({ forbid_network: true }));

  const { effective, layers } = await loadConfigLayers(projectRoot, {
    active_model: { provider: "project", model_name: "project-writer" },
    tool_permissions: { network_allowed: true }
  });

  assert.deepEqual(effective.active_model, { provider: "local", model_name: "local-writer" });
  assert.equal(effective.tool_permissions.network_allowed, false);
  assert.equal(layers.project.tool_permissions.network_allowed, true);
  assert.equal(layers.policy.forbid_network, true);
});

// ---------------------------------------------------------------------------
// 任务 5：工作区有效配置合并（应用私有 settings 优先，旧 project.yaml 只读兼容输入）
// ---------------------------------------------------------------------------

test("FALLBACK_WORKSPACE_CONFIG 保留安全默认：无 YOLO、无自动编辑、网络关闭、无归档、md", () => {
  assert.equal(FALLBACK_WORKSPACE_CONFIG.tool_permissions.yolo, false);
  assert.equal(FALLBACK_WORKSPACE_CONFIG.tool_permissions.auto_edit, false);
  assert.equal(FALLBACK_WORKSPACE_CONFIG.tool_permissions.network_allowed, false);
  assert.equal(FALLBACK_WORKSPACE_CONFIG.tool_permissions.read_only, false);
  assert.equal(FALLBACK_WORKSPACE_CONFIG.archived_at, null);
  assert.equal(FALLBACK_WORKSPACE_CONFIG.output_format, "md");
  assert.equal(FALLBACK_WORKSPACE_CONFIG.active_model, null);
});

test("普通目录 loadEffectiveWorkspaceConfig 用应用私有 settings 与安全默认", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-eff-plain-"));
  const projectRoot = path.join(root, "plain");
  await fs.mkdir(projectRoot, { recursive: true });
  const store = createWorkspaceStore({ stateRoot: path.join(root, "state") });
  await store.saveSettings(projectRoot, {
    active_model: { provider: "openai-compatible", model_name: "deepseek-chat" },
    tool_permissions: { network_allowed: true }
  });

  const effective = await loadEffectiveWorkspaceConfig(projectRoot, { workspaceStore: store });
  assert.equal(effective.active_model.model_name, "deepseek-chat");
  assert.equal(effective.tool_permissions.network_allowed, true);
  assert.equal(effective.tool_permissions.yolo, false, "未显式配置的权限保持安全默认");
  assert.equal(effective.tool_permissions.auto_edit, false);
  assert.equal(effective.tool_permissions.read_only, false);
  assert.equal(effective.output_format, "md");
  assert.equal(effective.archived_at, null);
  assert.equal(effective.projectRoot, path.resolve(projectRoot));
  assert.equal(effective.workspace_id, workspaceIdForPath(projectRoot));
});

test("旧 project.yaml 只作兼容输入，应用私有 settings 的模型与权限优先", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-eff-legacy-"));
  const { projectRoot, project } = await createProject(root, {
    slug: "legacy",
    active_model: {
      provider: "openai-compatible",
      model_name: "mimo-v1",
      base_url: "https://api.xiaomimimo.com/v1",
      api_key_env: "XIAOMI_MIMO_API_KEY"
    },
    network_allowed: true
  });
  const store = createWorkspaceStore({ stateRoot: path.join(root, "state") });
  // 应用私有 settings 只覆盖模型
  await store.saveSettings(projectRoot, {
    active_model: { provider: "openai-compatible", model_name: "deepseek-chat", base_url: "https://api.deepseek.com", api_key_env: "DEEPSEEK_API_KEY" }
  });

  const effective = await loadEffectiveWorkspaceConfig(projectRoot, { workspaceStore: store });
  assert.equal(effective.active_model.model_name, "deepseek-chat", "应用私有 settings 优先");
  // 冻结合并契约：4 布尔权限字段以应用私有 settings 为准（首次未配置即安全默认，
  // 旧 project.yaml 的 4 布尔值不迁移）；legacy-only 字段（safe_edit 等）保留。
  assert.equal(effective.tool_permissions.network_allowed, false, "4 布尔权限字段由应用私有 settings 决定");
  assert.equal(effective.tool_permissions.safe_edit, true, "旧 project.yaml 的 legacy-only 权限字段作为兼容输入保留");
  assert.equal(effective.tool_permissions.yolo, false, "安全默认不因旧文件缺失字段而放开");
  assert.equal(effective.project_id, project.project_id, "旧 project.yaml 的 project_id 作为兼容输入保留");
});

test("无任何配置的普通目录回落安全默认：active_model null", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-eff-empty-"));
  const projectRoot = path.join(root, "empty");
  await fs.mkdir(projectRoot, { recursive: true });
  const store = createWorkspaceStore({ stateRoot: path.join(root, "state") });
  const effective = await loadEffectiveWorkspaceConfig(projectRoot, { workspaceStore: store });
  assert.equal(effective.active_model, null);
  assert.equal(effective.tool_permissions.network_allowed, false);
});
