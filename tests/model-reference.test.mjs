// tests/model-reference.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { resolveActiveModel, toRequestConfig } from "../src/core/model-reference.mjs";

function storeWith(providers, defaultModel = null) {
  return { schema_version: 2, default_model: defaultModel, providers };
}
const deepseek = {
  id: "deepseek", name: "DeepSeek 官方", type: "custom", status: "enabled",
  base_url: "https://api.deepseek.com", api_format: "openai-chat-completions",
  api_key_env: "DEEPSEEK_API_KEY", created_at: "t", updated_at: "t",
  models: [{ id: "m1", model_name: "deepseek-v4-pro", enabled: true, context_window: 256000, temperature: 1.0 }]
};
const fallbackModel = { id: "m0", model_name: "deepseek-v4-flash", enabled: true, context_window: 256000 };
const store = storeWith([deepseek, { ...deepseek, id: "p2", base_url: "https://relay.test", api_key_env: "K", models: [fallbackModel] }], { provider_id: "p2", model_id: "m0" });

test("引用解析为完整配置", () => {
  const { model, note } = resolveActiveModel({ provider_id: "deepseek", model_id: "m1" }, store);
  assert.equal(model.model_name, "deepseek-v4-pro");
  assert.equal(model.base_url, "https://api.deepseek.com");
  assert.equal(model.api_key_env, "DEEPSEEK_API_KEY");
  assert.equal(model.provider, "openai-compatible");
  assert.equal(note, null);
});

test("悬空引用 → 默认模型 + note", () => {
  const { model, note } = resolveActiveModel({ provider_id: "deepseek", model_id: "ghost" }, store);
  assert.equal(model.model_name, "deepseek-v4-flash");
  assert.match(note, /已换成默认模型 deepseek-v4-flash/u);
});

test("引用被停用 → 默认模型 + note", () => {
  const disabled = { ...deepseek, status: "disabled" };
  const { model, note } = resolveActiveModel({ provider_id: "deepseek", model_id: "m1" }, storeWith([disabled]));
  assert.equal(model, null); // 无默认可退
  assert.match(note, /未配置/u);
});

test("模型级停用同样按悬空处理", () => {
  const disabledModel = { ...deepseek, models: [{ ...deepseek.models[0], enabled: false }] };
  const { model, note } = resolveActiveModel({ provider_id: "deepseek", model_id: "m1" }, storeWith([disabledModel, { ...deepseek, id: "p2", base_url: "https://relay.test", api_key_env: "K", models: [fallbackModel] }], { provider_id: "p2", model_id: "m0" }));
  assert.equal(model.model_name, "deepseek-v4-flash");
  assert.match(note, /已换成默认模型/u);
});

test("字面配置（非 mock）原样通过", () => {
  const literal = { provider: "openai-compatible", model_name: "legacy-model", base_url: "https://legacy.test", api_key_env: "L" };
  const { model, note } = resolveActiveModel(literal, store);
  assert.deepEqual(model, literal);
  assert.equal(note, null);
});

test("mock 字面配置归零为未配置", () => {
  const { model, note } = resolveActiveModel({ provider: "mock", model_name: "mock-writer" }, store);
  assert.equal(model, null);
  assert.match(note, /未配置/u);
});

test("toRequestConfig 输出运行时形状", () => {
  const config = toRequestConfig(deepseek, deepseek.models[0]);
  assert.equal(config.provider, "openai-compatible");
  assert.equal(config.model_name, "deepseek-v4-pro");
  assert.equal(config.base_url, "https://api.deepseek.com");
  assert.equal(config.api_key_env, "DEEPSEEK_API_KEY");
  assert.equal(config.api_format, "openai-chat-completions");
  assert.equal(config.temperature, 1.0);
  assert.equal(config.context_window, 256000);
});
