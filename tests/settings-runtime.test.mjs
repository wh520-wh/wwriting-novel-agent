import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readEvents } from "../src/core/event-log.mjs";
import { loadConfigLayers } from "../src/core/config-runtime.mjs";
import { createProject, loadProject } from "../src/core/project-store.mjs";
import { createWorkspaceStore } from "../src/core/workspaces/store.mjs";
import {
  normalizeSettingsPatch,
  saveWorkspaceSettings,
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

test("normalizeSettingsPatch 透传 timeout_ms/total_deadline_ms", () => {
  const normalized = normalizeSettingsPatch({
    active_model: {
      provider: "openai-compatible",
      model_name: "x",
      base_url: "https://api.example.com",
      api_key_env: "K",
      timeout_ms: 300000,
      total_deadline_ms: 900000
    }
  });
  assert.equal(normalized.active_model.timeout_ms, 300000);
  assert.equal(normalized.active_model.total_deadline_ms, 900000);
});

test("normalizeSettingsPatch 拒绝非法 timeout_ms/total_deadline_ms（负数/非整数）", () => {
  const base = { provider: "openai-compatible", model_name: "x", base_url: "https://api.example.com", api_key_env: "K" };
  assert.throws(
    () => normalizeSettingsPatch({ active_model: { ...base, timeout_ms: -5 } }),
    (error) => error instanceof SettingsValidationError && error.code === "invalid_timeout_ms"
  );
  assert.throws(
    () => normalizeSettingsPatch({ active_model: { ...base, total_deadline_ms: 1.5 } }),
    (error) => error instanceof SettingsValidationError && error.code === "invalid_total_deadline_ms"
  );
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

// ---------------------------------------------------------------------------
// 任务 5：模型/权限写入应用私有 workspace settings（旧 project.yaml 只读保留）
// ---------------------------------------------------------------------------

test("saveWorkspaceSettings 写应用私有 settings，旧 project.yaml 保留为回滚依据", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-settings-ws-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    active_model: {
      provider: "openai-compatible",
      model_name: "legacy-model",
      base_url: "https://old.example.com/v1",
      api_key_env: "OLD_KEY_ENV"
    },
    network_allowed: true
  });
  const store = createWorkspaceStore({ stateRoot: path.join(root, "state") });

  await saveWorkspaceSettings(projectRoot, {
    workspaceStore: store,
    activeModel: {
      provider: "openai-compatible",
      model_name: "deepseek-chat",
      base_url: "https://api.deepseek.com",
      api_key_env: "DEEPSEEK_API_KEY"
    }
  });

  const settings = await store.loadSettings(projectRoot);
  assert.equal(settings.active_model.model_name, "deepseek-chat");
  // 首次配置写入安全默认权限（应用私有 settings 的 4 布尔字段为准；旧 project.yaml
  // 的 4 布尔权限不迁移——SPEC §9.1「权限默认值写入应用私有 workspace settings」）
  assert.equal(settings.tool_permissions.network_allowed, false);
  // project.yaml 原文件不动
  const project = await loadProject(projectRoot);
  assert.equal(project.active_model.model_name, "legacy-model");
  assert.equal(project.active_model.base_url, "https://old.example.com/v1");
});

test("saveWorkspaceSettings 普通目录不创建 project.yaml", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-settings-ws-plain-"));
  const projectRoot = path.join(root, "plain");
  await fs.mkdir(projectRoot, { recursive: true });
  const store = createWorkspaceStore({ stateRoot: path.join(root, "state") });

  await saveWorkspaceSettings(projectRoot, {
    workspaceStore: store,
    activeModel: { provider: "openai-compatible", model_name: "deepseek-chat" },
    toolPermissions: { network_allowed: true }
  });

  const settings = await store.loadSettings(projectRoot);
  assert.equal(settings.active_model.model_name, "deepseek-chat");
  assert.equal(settings.tool_permissions.network_allowed, true);
  assert.equal(settings.tool_permissions.yolo, false, "未显式配置的权限保持安全默认");
  const exists = await fs
    .access(path.join(projectRoot, "project.yaml"))
    .then(() => true)
    .catch(() => false);
  assert.equal(exists, false, "普通目录绝不能创建 project.yaml");
});

test("saveWorkspaceSettings 缺 workspaceStore 抛 SettingsValidationError", async () => {
  await assert.rejects(
    () => saveWorkspaceSettings("/tmp/project", { activeModel: { provider: "mock", model_name: "x" } }),
    (error) => error instanceof SettingsValidationError && error.code === "invalid_workspace_store"
  );
});
