import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readEvents } from "../src/core/event-log.mjs";
import { loadConfigLayers } from "../src/core/config-runtime.mjs";
import { createProject, loadProject } from "../src/core/project-store.mjs";
import {
  normalizeSettingsPatch,
  saveModelSettingsTransaction,
  SettingsValidationError,
  updateProjectSettings
} from "../src/core/settings-runtime.mjs";

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
  // 预算限制只来自有效项目配置（Rule 9：不再同步到任何运行态文件）。
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
  assert.equal(project.budget_config.max_model_calls, undefined);
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

test("normalizeSettingsPatch 为 DeepSeek 模型自动补全官方人民币价", () => {
  const normalized = normalizeSettingsPatch({
    active_model: {
      provider: "openai-compatible",
      model_name: "deepseek-v4-flash",
      base_url: "https://api.deepseek.com",
      pricing: { input_per_million: 1.0, output_per_million: 2.0 }
    }
  });
  assert.equal(normalized.active_model.pricing.cache_hit_per_million, 0.02);
});

test("normalizeSettingsPatch DeepSeek 模型完全不填价格时也补全官方价（保存后即可确认配置）", () => {
  const normalized = normalizeSettingsPatch({
    active_model: {
      provider: "openai-compatible",
      model_name: "deepseek-v4-pro",
      base_url: "https://api.deepseek.com",
      pricing: {}
    }
  });
  assert.equal(normalized.active_model.pricing.input_per_million, 3.0);
  assert.equal(normalized.active_model.pricing.output_per_million, 6.0);
  assert.equal(normalized.active_model.pricing.cache_hit_per_million, 0.025);
});

test("normalizeSettingsPatch 为 mimo-v2.5 与 mimo-v2.5-pro 自动补全官方人民币价", () => {
  const flash = normalizeSettingsPatch({
    active_model: {
      provider: "openai-compatible",
      model_name: "mimo-v2.5",
      base_url: "https://api.xiaomimimo.com/v1",
      pricing: {}
    }
  });
  assert.equal(flash.active_model.pricing.input_per_million, 1.0);
  assert.equal(flash.active_model.pricing.cache_hit_per_million, 0.02);
  const pro = normalizeSettingsPatch({
    active_model: {
      provider: "openai-compatible",
      model_name: "mimo-v2.5-pro",
      base_url: "https://api.xiaomimimo.com/v1",
      pricing: {}
    }
  });
  assert.equal(pro.active_model.pricing.input_per_million, 3.0);
  assert.equal(pro.active_model.pricing.cache_hit_per_million, 0.025);
});

test("normalizeSettingsPatch 用户已填缓存命中价不被覆盖", () => {
  const normalized = normalizeSettingsPatch({
    active_model: {
      provider: "openai-compatible",
      model_name: "deepseek-v4-pro",
      base_url: "https://api.deepseek.com",
      pricing: { input_per_million: 3, output_per_million: 6, cache_hit_per_million: 0.05 }
    }
  });
  assert.equal(normalized.active_model.pricing.cache_hit_per_million, 0.05);
});

test("normalizeSettingsPatch 未收录模型不补填缓存命中价", () => {
  const normalized = normalizeSettingsPatch({
    active_model: {
      provider: "openai-compatible",
      model_name: "custom-model",
      base_url: "https://example.com/v1",
      pricing: { input_per_million: 3, output_per_million: 6 }
    }
  });
  assert.equal(normalized.active_model.pricing.cache_hit_per_million, undefined);
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

const validCandidate = {
  provider: "openai-compatible",
  model_name: "mimo-v2.5-pro",
  base_url: "https://api.xiaomimimo.com/v1",
  api_key_env: "XIAOMI_MIMO_API_KEY",
  api_key: "temporary-test-key",
};

test("project write failure leaves secrets and runtime untouched", async () => {
  const calls = [];
  await assert.rejects(
    () => saveModelSettingsTransaction({
      projectRoot: "project",
      secretsRoot: "secrets",
      activeModel: validCandidate,
      readProject: async () => ({
        active_model: { provider: "mock", model_name: "old" },
      }),
      writeProject: async () => {
        calls.push("writeProject");
        throw new Error("project disk full");
      },
      readSecrets: async () => ({ OLD_KEY: "old-secret" }),
      writeSecrets: async () => calls.push("writeSecrets"),
      applySecrets: () => calls.push("applySecrets"),
    }),
    /project disk full/
  );
  assert.deepEqual(calls, ["writeProject"]);
});

test("secret write failure restores the old project snapshot", async () => {
  const oldProject = {
    active_model: { provider: "mock", model_name: "old" },
  };
  const writes = [];
  await assert.rejects(
    () => saveModelSettingsTransaction({
      projectRoot: "project",
      secretsRoot: "secrets",
      activeModel: validCandidate,
      readProject: async () => oldProject,
      writeProject: async (root, value) => writes.push(value),
      readSecrets: async () => ({ OLD_KEY: "old-secret" }),
      writeSecrets: async () => {
        throw new Error("secret disk full");
      },
      applySecrets: () => assert.fail("must not apply runtime secrets"),
    }),
    (error) => error.code === "settings_save_failed"
  );
  assert.equal(writes.length, 2);
  assert.equal(writes[0].active_model.model_name, "mimo-v2.5-pro");
  assert.deepEqual(writes[1], oldProject);
});

test("runtime apply failure keeps durable new files and requests restart", async () => {
  const writes = [];
  await assert.rejects(
    () => saveModelSettingsTransaction({
      projectRoot: "project",
      secretsRoot: "secrets",
      activeModel: validCandidate,
      readProject: async () => ({
        active_model: { provider: "mock", model_name: "old" },
      }),
      writeProject: async (root, value) =>
        writes.push(["project", value.active_model.model_name]),
      readSecrets: async () => ({}),
      writeSecrets: async (root, value) =>
        writes.push(["secrets", value.XIAOMI_MIMO_API_KEY]),
      applySecrets: () => {
        throw new Error("runtime apply failed");
      },
    }),
    (error) => error.code === "settings_runtime_apply_failed"
  );
  assert.deepEqual(writes, [
    ["project", "mimo-v2.5-pro"],
    ["secrets", "temporary-test-key"],
  ]);
});

test("updateProjectSettings 保存时移除旧 project.yaml 的 enabled_skills 字段", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-settings-strip-"));
  const { projectRoot } = await createProject(root, { slug: "project" });
  // 模拟旧版本 project.yaml 残留 enabled_skills
  const { parseSimpleYaml, serializeSimpleYaml } = await import("../src/core/simple-yaml.mjs");
  const { saveProject } = await import("../src/core/project-store.mjs");
  const legacy = { ...(await loadProject(projectRoot)), enabled_skills: ["suspense-chapter-end"] };
  await saveProject(projectRoot, legacy);
  assert.equal((await loadProject(projectRoot)).enabled_skills, undefined);

  // 经 settings runtime 保存一次后，enabled_skills 不再出现
  await updateProjectSettings(projectRoot, { reasoning_effort: "high" });
  const project = await loadProject(projectRoot);
  assert.equal(project.reasoning_effort, "high");
  assert.equal(project.enabled_skills, undefined, "settings 保存后 enabled_skills 必须被移除");
  const source = await fs.readFile(path.join(projectRoot, "project.yaml"), "utf8");
  assert.ok(!source.includes("enabled_skills"), "project.yaml 文本不得再出现 enabled_skills");
});

test("reasoning_effort 项目级读写：合法档位落盘 project.yaml，非法值拒绝", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-settings-effort-"));
  const { projectRoot } = await createProject(root, { slug: "project" });

  // 未配置的既有项目无该字段，读取方按 auto（不发送 reasoning_effort）处理。
  const before = await loadProject(projectRoot);
  assert.equal(before.reasoning_effort, undefined);

  await updateProjectSettings(projectRoot, { reasoning_effort: "high" });
  assert.equal((await loadProject(projectRoot)).reasoning_effort, "high");

  await updateProjectSettings(projectRoot, { reasoning_effort: "auto" });
  assert.equal((await loadProject(projectRoot)).reasoning_effort, "auto");

  await assert.rejects(
    () => updateProjectSettings(projectRoot, { reasoning_effort: "extreme" }),
    /reasoning_effort/
  );
});
