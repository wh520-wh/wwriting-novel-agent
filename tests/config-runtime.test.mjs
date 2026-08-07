import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isPermissionAllowed,
  loadConfigLayers,
  resolveConfigLayers,
  resolveRuntimeConfig
} from "../src/core/config-runtime.mjs";

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
