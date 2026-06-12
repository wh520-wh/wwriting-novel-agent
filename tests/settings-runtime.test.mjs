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

test("tool_permissions 接受 auto_edit/yolo，拒绝 dangerous，保留未知字段丢弃", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-settings-autoedit-"));
  const { projectRoot } = await createProject(root, { slug: "autoedit" });

  await updateProjectSettings(projectRoot, { tool_permissions: { auto_edit: true, yolo: true } });
  const project = await loadProject(projectRoot);
  assert.equal(project.tool_permissions.auto_edit, true);
  assert.equal(project.tool_permissions.yolo, true);

  await assert.rejects(
    () => updateProjectSettings(projectRoot, { tool_permissions: { dangerous: true } }),
    /dangerous/iu
  );
});

test("archived_at 接受 null 与合法 ISO，拒绝垃圾", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-settings-archive-"));
  const { projectRoot } = await createProject(root, { slug: "archive" });

  const iso = new Date().toISOString();
  await updateProjectSettings(projectRoot, { archived_at: iso });
  assert.equal((await loadProject(projectRoot)).archived_at, iso);

  await updateProjectSettings(projectRoot, { archived_at: null });
  assert.equal((await loadProject(projectRoot)).archived_at, null);

  await assert.rejects(
    () => updateProjectSettings(projectRoot, { archived_at: "昨天" }),
    /archived_at/u
  );
});

test("createProject 默认 auto_edit=false yolo=false archived_at=null", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-settings-defaults-"));
  const { projectRoot } = await createProject(root, { slug: "defaults" });

  const project = await loadProject(projectRoot);
  assert.equal(project.tool_permissions.auto_edit, false);
  assert.equal(project.tool_permissions.yolo, false);
  assert.equal(project.archived_at, null);
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

test("memory_extraction 接受布尔 enabled，丢弃其它键", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-settings-mem-"));
  const { projectRoot } = await createProject(root, { slug: "mem" });

  await updateProjectSettings(projectRoot, { memory_extraction: { enabled: false } });
  const project = await loadProject(projectRoot);
  assert.equal(project.memory_extraction.enabled, false);

  await updateProjectSettings(projectRoot, { memory_extraction: { enabled: true } });
  const project2 = await loadProject(projectRoot);
  assert.equal(project2.memory_extraction.enabled, true);
});

test("fact_check 接受布尔 enabled/hard，丢弃其它键", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-settings-fc-"));
  const { projectRoot } = await createProject(root, { slug: "fc" });

  await updateProjectSettings(projectRoot, {
    fact_check: { enabled: true, hard: true, ignored: "garbage" }
  });
  const project = await loadProject(projectRoot);
  assert.equal(project.fact_check.enabled, true);
  assert.equal(project.fact_check.hard, true);
  assert.equal(project.fact_check.ignored, undefined);

  await updateProjectSettings(projectRoot, { fact_check: { hard: false } });
  const project2 = await loadProject(projectRoot);
  assert.equal(project2.fact_check.hard, false);
  assert.equal(project2.fact_check.enabled, true, "previous enabled must persist");
});

test("memory_extraction/fact_check 拒绝非对象", () => {
  assert.throws(
    () => normalizeSettingsPatch({ memory_extraction: "no" }),
    (error) => error instanceof SettingsValidationError && error.code === "invalid_memory_extraction"
  );
  assert.throws(
    () => normalizeSettingsPatch({ fact_check: [true] }),
    (error) => error instanceof SettingsValidationError && error.code === "invalid_fact_check"
  );
});

test("project_profile 接受 max_words_per_chapter，且 max < min 时自动提升", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-settings-max-"));
  const { projectRoot } = await createProject(root, { slug: "max" });

  await updateProjectSettings(projectRoot, {
    project_profile: {
      min_words_per_chapter: 3000,
      target_words_per_chapter: 3300,
      max_words_per_chapter: 4000
    }
  });
  let project = await loadProject(projectRoot);
  assert.equal(project.max_words_per_chapter, 4000);

  // max < min: 应被抬到 min
  await updateProjectSettings(projectRoot, {
    project_profile: { max_words_per_chapter: 2000 }
  });
  project = await loadProject(projectRoot);
  assert.equal(project.max_words_per_chapter, 3000, "max below min must be raised to min");

  // 拒绝非正整数
  await assert.rejects(
    () => updateProjectSettings(projectRoot, { project_profile: { max_words_per_chapter: -1 } }),
    /max_words_per_chapter/u
  );
  await assert.rejects(
    () => updateProjectSettings(projectRoot, { project_profile: { max_words_per_chapter: "abc" } }),
    /max_words_per_chapter/u
  );
});
