// tests/model-project-migration.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { migrateProjectActiveModel } from "../src/core/project-model-migration.mjs";

const store = {
  schema_version: 2,
  default_model: { provider_id: "deepseek", model_id: "m1" },
  providers: [{
    id: "deepseek", name: "DeepSeek 官方", type: "custom", status: "enabled",
    base_url: "https://api.deepseek.com", api_format: "openai-chat-completions",
    api_key_env: "DEEPSEEK_API_KEY", created_at: "t", updated_at: "t",
    models: [{ id: "m1", model_name: "deepseek-v4-pro", enabled: true, context_window: 256000 }]
  }]
};

test("mock 快照归零为未配置", async () => {
  const { active_model, changed } = await migrateProjectActiveModel({ provider: "mock", model_name: "mock-writer" }, store);
  assert.equal(active_model, null);
  assert.equal(changed, true);
});

test("匹配清单的快照转引用", async () => {
  const { active_model, changed } = await migrateProjectActiveModel({
    provider: "openai-compatible", model_name: "deepseek-v4-pro",
    base_url: "https://api.deepseek.com", api_key_env: "DEEPSEEK_API_KEY"
  }, store);
  assert.deepEqual(active_model, { provider_id: "deepseek", model_id: "m1" });
  assert.equal(changed, true);
});

test("已是引用形态不动", async () => {
  const { active_model, changed } = await migrateProjectActiveModel({ provider_id: "deepseek", model_id: "m1" }, store);
  assert.deepEqual(active_model, { provider_id: "deepseek", model_id: "m1" });
  assert.equal(changed, false);
});

test("匹配不到的保持字面", async () => {
  const literal = { provider: "openai-compatible", model_name: "legacy", base_url: "https://legacy.test", api_key_env: "L" };
  const { active_model, changed } = await migrateProjectActiveModel(literal, store);
  assert.deepEqual(active_model, literal);
  assert.equal(changed, false);
});

test("null 不动", async () => {
  const { active_model, changed } = await migrateProjectActiveModel(null, store);
  assert.equal(active_model, null);
  assert.equal(changed, false);
});
