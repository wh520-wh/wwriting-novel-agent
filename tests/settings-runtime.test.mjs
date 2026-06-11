import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readEvents } from "../src/core/event-log.mjs";
import { loadConfigLayers } from "../src/core/config-runtime.mjs";
import { createProject, loadProject, loadState } from "../src/core/project-store.mjs";
import { normalizeSettingsPatch, SettingsValidationError, updateProjectSettings } from "../src/core/settings-runtime.mjs";

test("updateProjectSettings writes model, permissions, budget, and research config", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-settings-"));
  const { projectRoot } = await createProject(root, { slug: "project" });

  await updateProjectSettings(projectRoot, {
    active_model: {
      provider: "openai-compatible",
      model_name: "writer-large",
      base_url: "https://api.example.test/v1",
      api_key_env: "WRITER_API_KEY",
      max_output_tokens: 4096,
      stream: true
    },
    tool_permissions: {
      network_allowed: true
    },
    budget_config: {
      max_model_calls: 99
    },
    research_config: {
      search_endpoint: "https://search.example.test/api",
      search_api_key_env: "SEARCH_API_KEY",
      search_results_path: "data.items"
    }
  });

  const project = await loadProject(projectRoot);
  assert.equal(project.active_model.provider, "openai-compatible");
  assert.equal(project.active_model.api_key_env, "WRITER_API_KEY");
  assert.equal(project.active_model.stream, true);
  assert.equal(project.tool_permissions.network_allowed, true);
  assert.equal(project.budget_config.max_model_calls, 99);
  const state = await loadState(projectRoot);
  assert.equal(state.active_budget.max_model_calls, 99);
  assert.equal(state.active_budget.model_calls, 0);
  assert.equal(project.research_config.search_endpoint, "https://search.example.test/api");
  const config = await loadConfigLayers(projectRoot, project);
  assert.equal(config.effective.active_model.model_name, "writer-large");
  assert.equal(config.effective.research_config.search_results_path, "data.items");
  const events = await readEvents(projectRoot);
  assert.ok(events.some((event) => event.type === "project_settings_updated"));
});

test("settings runtime clears optional budget and research fields when inputs are empty", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-settings-clear-"));
  const { projectRoot } = await createProject(root, { slug: "project" });

  await updateProjectSettings(projectRoot, {
    budget_config: {
      max_model_calls: 42
    },
    research_config: {
      search_endpoint: "https://search.example.test/api",
      search_api_key_env: "SEARCH_API_KEY"
    }
  });
  await updateProjectSettings(projectRoot, {
    budget_config: {
      max_model_calls: ""
    },
    research_config: {
      search_endpoint: "",
      search_api_key_env: ""
    }
  });

  const project = await loadProject(projectRoot);
  const state = await loadState(projectRoot);
  assert.equal(project.budget_config.max_model_calls, undefined);
  assert.equal(state.active_budget.max_model_calls, undefined);
  assert.equal(state.active_budget.model_calls, 0);
  assert.equal(project.research_config.search_endpoint, undefined);
  assert.equal(project.research_config.search_api_key_env, undefined);
});

test("settings runtime rejects raw secrets and dangerous permission escalation", () => {
  assert.throws(
    () => normalizeSettingsPatch({ active_model: { provider: "openai", model_name: "x", api_key: "secret" } }),
    (error) => error instanceof SettingsValidationError && error.code === "raw_secret_rejected"
  );
  assert.throws(
    () => normalizeSettingsPatch({ active_model: { provider: "openai-compatible", model_name: "x", api_key_env: "sk-not-an-env-name" } }),
    (error) => error instanceof SettingsValidationError && error.code === "invalid_api_key_env" && error.message.includes("不要填写 sk-")
  );
  assert.throws(
    () => normalizeSettingsPatch({ tool_permissions: { dangerous: true } }),
    (error) => error instanceof SettingsValidationError && error.code === "dangerous_permission_rejected"
  );
});

test("settings runtime rejects non-http base URLs", () => {
  assert.throws(
    () => normalizeSettingsPatch({ active_model: { provider: "openai", model_name: "x", base_url: "file:///secret" } }),
    (error) => error instanceof SettingsValidationError && error.code === "invalid_base_url"
  );
});

test("normalizeStageOverrides preserves pricing field", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-override-pricing-"));
  try {
    const { projectRoot } = await createProject(workspace, {
      title: "override pricing", story_seed: "t", target_chapters: 1, min_words_per_chapter: 300
    });
    await updateProjectSettings(projectRoot, {
      active_model: {
        provider: "openai-compatible",
        model_name: "mimo-v2.5-pro",
        base_url: "https://api.xiaomimimo.com/v1",
        api_key_env: "XIAOMI_MIMO_API_KEY",
        pricing: { input_per_million: 1, output_per_million: 4 }
      },
      stage_overrides: {
        enabled: true,
        outline: {
          enabled: true,
          provider: "openai-compatible",
          model_name: "deepseek-chat",
          base_url: "https://api.deepseek.com",
          api_key_env: "DEEPSEEK_API_KEY",
          pricing: { input_per_million: 2, output_per_million: 8 }
        }
      }
    });
    const project = await loadProject(projectRoot);
    assert.deepEqual(project.stage_overrides.outline.pricing, {
      input_per_million: 2, output_per_million: 8, currency: "CNY"
    });
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
