// tests/model-migration.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadProviderStore, migrateV1Store, removeProvider } from "../src/core/model-provider-store.mjs";
import { ensurePresetProviders, MODEL_PRESETS } from "../src/core/model-presets.mjs";

test("官方地址旧条目并入预设，参数保留", () => {
  const v1 = {
    schema_version: 1,
    default_model_id: "deepseek-v4-pro",
    models: [
      { id: "deepseek-v4-pro", provider: "openai-compatible", provider_label: "DeepSeek 官方", model_name: "deepseek-v4-pro", base_url: "https://api.deepseek.com", api_key_env: "DEEPSEEK_API_KEY", temperature: 0.7 },
      { id: "my-model", provider: "openai-compatible", provider_label: "我的中转", model_name: "gpt-4o[1m]", base_url: "https://relay.example.com", api_key_env: "MY_KEY" }
    ]
  };
  const store = migrateV1Store(v1, MODEL_PRESETS);
  const deepseek = store.providers.find((p) => p.id === "deepseek");
  assert.ok(deepseek, "旧 deepseek 条目并入预设");
  const merged = deepseek.models.find((m) => m.model_name === "deepseek-v4-pro");
  assert.equal(merged.temperature, 0.7, "用户参数保留");
  assert.equal(deepseek.models.length, 2, "预设两个模型都在");
  const relay = store.providers.find((p) => p.base_url === "https://relay.example.com");
  assert.equal(relay.name, "我的中转");
  assert.equal(relay.models[0].model_name, "gpt-4o[1m]");
  assert.equal(relay.models[0].context_window, 1000000, "[1m] 推导");
  assert.deepEqual(store.default_model, { provider_id: "deepseek", model_id: "deepseek-v4-pro" });
});

test("同 base_url 旧条目合并进同一供应商；重名独立供应商加后缀", () => {
  const v1 = {
    schema_version: 1,
    default_model_id: null,
    models: [
      { id: "a", provider: "openai-compatible", provider_label: "我的中转", model_name: "a1", base_url: "https://relay.example.com", api_key_env: "K" },
      { id: "b", provider: "openai-compatible", provider_label: "我的中转", model_name: "b1", base_url: "https://relay.example.com", api_key_env: "K" }
    ]
  };
  const store = migrateV1Store(v1, MODEL_PRESETS);
  const relay = store.providers.find((p) => p.base_url === "https://relay.example.com");
  assert.ok(relay, "同 base_url 合并");
  assert.deepEqual(relay.models.map((m) => m.model_name), ["a1", "b1"]);
  assert.equal(store.providers.filter((p) => p.name === "我的中转").length, 1);
});

test("v1 清单自动迁移落盘", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "mp-mig-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "model-profiles.json"), JSON.stringify({
    schema_version: 1,
    default_model_id: "deepseek-v4-flash",
    models: [{ id: "deepseek-v4-flash", provider: "openai-compatible", model_name: "deepseek-v4-flash", base_url: "https://api.deepseek.com", api_key_env: "DEEPSEEK_API_KEY" }]
  }), "utf8");
  const store = await loadProviderStore(root);
  assert.equal(store.schema_version, 2);
  assert.equal(store.providers.find((p) => p.id === "deepseek").models[0].model_name, "deepseek-v4-flash");
  const reread = JSON.parse(await readFile(path.join(root, "model-profiles.json"), "utf8"));
  assert.equal(reread.schema_version, 2);
});

test("独立分支重复 base_url + model_name 合并运行时字段，以最后一次为准", () => {
  const v1 = {
    schema_version: 1,
    default_model_id: null,
    models: [
      { id: "m1", provider: "openai-compatible", provider_label: "我的中转", model_name: "gpt-4o", base_url: "https://relay.example.com", api_key_env: "K", temperature: 0.2 },
      { id: "m2", provider: "openai-compatible", provider_label: "我的中转", model_name: "gpt-4o", base_url: "https://relay.example.com", api_key_env: "K", temperature: 1.5, max_output_tokens: 4096 }
    ]
  };
  const store = migrateV1Store(v1, MODEL_PRESETS);
  const relay = store.providers.find((p) => p.base_url === "https://relay.example.com");
  const merged = relay.models.find((m) => m.model_name === "gpt-4o");
  assert.equal(relay.models.length, 1, "同 model_name 只建一个模型");
  assert.equal(merged.temperature, 1.5, "第二条目 temperature 覆盖第一条");
  assert.equal(merged.max_output_tokens, 4096);
});

test("v1 max_context_tokens 映射到 v2 context_window（官方与独立分支）", () => {
  const v1 = {
    schema_version: 1,
    default_model_id: null,
    models: [
      { id: "deepseek-v4-flash", provider: "openai-compatible", provider_label: "DeepSeek 官方", model_name: "deepseek-v4-flash", base_url: "https://api.deepseek.com", api_key_env: "DEEPSEEK_API_KEY", max_context_tokens: 32768 },
      { id: "m1", provider: "openai-compatible", provider_label: "我的中转", model_name: "gpt-4o", base_url: "https://relay.example.com", api_key_env: "K", max_context_tokens: 8192 }
    ]
  };
  const store = migrateV1Store(v1, MODEL_PRESETS);
  const deepseek = store.providers.find((p) => p.id === "deepseek");
  assert.equal(deepseek.models.find((m) => m.model_name === "deepseek-v4-flash").context_window, 32768, "官方分支映射 max_context_tokens");
  const relay = store.providers.find((p) => p.base_url === "https://relay.example.com");
  assert.equal(relay.models[0].context_window, 8192, "独立分支映射 max_context_tokens");
});

test("同 provider_label 不同 base_url 独立供应商加（2）后缀", () => {
  const v1 = {
    schema_version: 1,
    default_model_id: null,
    models: [
      { id: "a", provider: "openai-compatible", provider_label: "我的中转", model_name: "a1", base_url: "https://relay-a.example.com", api_key_env: "K" },
      { id: "b", provider: "openai-compatible", provider_label: "我的中转", model_name: "b1", base_url: "https://relay-b.example.com", api_key_env: "K" }
    ]
  };
  const store = migrateV1Store(v1, MODEL_PRESETS);
  const names = store.providers.map((p) => p.name).sort();
  assert.deepEqual(names, ["我的中转", "我的中转（2）"]);
});

test("迁移记录 seeded_preset_ids，删除已迁移预设后不复活", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "mp-mig-seed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "model-profiles.json"), JSON.stringify({
    schema_version: 1,
    default_model_id: "deepseek-v4-pro",
    models: [{ id: "deepseek-v4-pro", provider: "openai-compatible", model_name: "deepseek-v4-pro", base_url: "https://api.deepseek.com", api_key_env: "DEEPSEEK_API_KEY" }]
  }), "utf8");
  const migrated = await loadProviderStore(root);
  assert.deepEqual(migrated.seeded_preset_ids, MODEL_PRESETS.map((p) => p.id), "迁移记录全部预设 id");
  await removeProvider(root, "deepseek");
  const { seeded } = await ensurePresetProviders(root);
  assert.equal(seeded, 0, "删除已迁移预设后不重新种");
  const store = await loadProviderStore(root);
  assert.equal(store.providers.some((p) => p.id === "deepseek"), false);
});
