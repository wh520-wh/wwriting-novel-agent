// tests/model-migration.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadProviderStore, migrateV1Store } from "../src/core/model-provider-store.mjs";
import { MODEL_PRESETS } from "../src/core/model-presets.mjs";

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
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(root, "model-profiles.json"), JSON.stringify({
    schema_version: 1,
    default_model_id: "deepseek-v4-flash",
    models: [{ id: "deepseek-v4-flash", provider: "openai-compatible", model_name: "deepseek-v4-flash", base_url: "https://api.deepseek.com", api_key_env: "DEEPSEEK_API_KEY" }]
  }), "utf8");
  const store = await loadProviderStore(root);
  assert.equal(store.schema_version, 2);
  assert.equal(store.providers.find((p) => p.id === "deepseek").models[0].model_name, "deepseek-v4-flash");
  const reread = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(root, "model-profiles.json"), "utf8"));
  assert.equal(reread.schema_version, 2);
});
