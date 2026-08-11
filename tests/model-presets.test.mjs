// tests/model-presets.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensurePresetProviders, MODEL_PRESETS } from "../src/core/model-presets.mjs";
import { loadProviderStore, upsertProvider, removeProvider } from "../src/core/model-provider-store.mjs";

async function tempRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), "mp-preset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("预设目录含 deepseek/mimo 固定 id 与官方模型", () => {
  const ids = MODEL_PRESETS.map((p) => p.id);
  assert.deepEqual(ids, ["deepseek", "mimo"]);
  const deepseek = MODEL_PRESETS.find((p) => p.id === "deepseek");
  assert.deepEqual(deepseek.models.map((m) => m.model_name), ["deepseek-v4-pro", "deepseek-v4-flash"]);
  assert.equal(deepseek.base_url, "https://api.deepseek.com");
  assert.equal(deepseek.api_key_env, "DEEPSEEK_API_KEY");
  const mimo = MODEL_PRESETS.find((p) => p.id === "mimo");
  assert.deepEqual(mimo.models.map((m) => m.model_name), ["mimo-v2.5-pro", "mimo-v2.5"]);
  assert.equal(mimo.base_url, "https://api.xiaomimimo.com/v1");
  assert.equal(mimo.api_key_env, "XIAOMI_MIMO_API_KEY");
});

test("空清单种子写入两个预设；模型带官方价", async (t) => {
  const root = await tempRoot(t);
  const { store, seeded } = await ensurePresetProviders(root);
  assert.equal(seeded, 2);
  assert.deepEqual(store.providers.map((p) => p.id).sort(), ["deepseek", "mimo"]);
  const deepseek = store.providers.find((p) => p.id === "deepseek");
  const pro = deepseek.models.find((m) => m.model_name === "deepseek-v4-pro");
  assert.deepEqual(pro.pricing, { input_per_million: 3.0, output_per_million: 6.0, cache_hit_per_million: 0.025, currency: "CNY" });
});

test("已存在清单且无预设 id 时补种；重复调用幂等", async (t) => {
  const root = await tempRoot(t);
  await ensurePresetProviders(root);
  const { seeded } = await ensurePresetProviders(root);
  assert.equal(seeded, 0);
  const store = await loadProviderStore(root);
  assert.equal(store.providers.length, 2);
});

test("用户删除预设后不复活", async (t) => {
  const root = await tempRoot(t);
  await ensurePresetProviders(root);
  await removeProvider(root, "deepseek");
  const { seeded } = await ensurePresetProviders(root);
  assert.equal(seeded, 0); // 清单里已无 deepseek id → 不会重新种
  const store = await loadProviderStore(root);
  assert.equal(store.providers.some((p) => p.id === "deepseek"), false);
});

test("自定义供应商存在时补种不影响它", async (t) => {
  const root = await tempRoot(t);
  await upsertProvider(root, { name: "我的中转", base_url: "https://relay.example.com", api_format: "openai-chat-completions", api_key_env: "MY_KEY" });
  const { seeded } = await ensurePresetProviders(root);
  assert.equal(seeded, 2);
  const store = await loadProviderStore(root);
  assert.equal(store.providers.length, 3);
});
