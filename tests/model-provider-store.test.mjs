// tests/model-provider-store.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadProviderStore, upsertProvider, upsertModel, removeModel, removeProvider,
  setDefaultModel, getDefaultModel, findModelById, findModelByConfig
} from "../src/core/model-provider-store.mjs";

async function tempRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), "mp-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("空根目录加载为空清单", async (t) => {
  const store = await loadProviderStore(await tempRoot(t));
  assert.equal(store.schema_version, 2);
  assert.deepEqual(store.providers, []);
  assert.equal(store.default_model, null);
});

test("upsertProvider 落盘并生成不可变 id", async (t) => {
  const root = await tempRoot(t);
  const { provider, store } = await upsertProvider(root, {
    name: "我的中转", base_url: "https://relay.example.com",
    api_format: "openai-chat-completions", api_key_env: "MY_RELAY_KEY"
  });
  assert.match(provider.id, /^pv_[0-9a-f]{16}$/u);
  assert.equal(store.providers.length, 1);
  const reloaded = await loadProviderStore(root);
  assert.equal(reloaded.providers[0].id, provider.id);
  assert.equal(reloaded.providers[0].name, "我的中转");
});

test("同 id 重存 = 更新，不新增条目", async (t) => {
  const root = await tempRoot(t);
  const { provider } = await upsertProvider(root, { name: "A", base_url: "https://a.example.com", api_format: "openai-chat-completions", api_key_env: "A_KEY" });
  const { store } = await upsertProvider(root, { id: provider.id, name: "A2", base_url: "https://a.example.com", api_format: "openai-chat-completions", api_key_env: "A_KEY" });
  assert.equal(store.providers.length, 1);
  assert.equal(store.providers[0].name, "A2");
});

test("模型 CRUD 与默认指针", async (t) => {
  const root = await tempRoot(t);
  const { provider } = await upsertProvider(root, { name: "D", base_url: "https://api.deepseek.com", api_format: "openai-chat-completions", api_key_env: "DEEPSEEK_API_KEY" });
  const { model } = await upsertModel(root, provider.id, { model_name: "deepseek-v4-pro[1m]", enabled: true });
  assert.match(model.id, /^m_[0-9a-f]{16}$/u);
  assert.equal(model.context_window, 1000000); // [1m] 标记推导
  await setDefaultModel(root, provider.id, model.id);
  const def = await getDefaultModel(root);
  assert.equal(def.model.provider_id ?? def.provider.id, provider.id);
  const found = await findModelById(root, provider.id, model.id);
  assert.equal(found.model.model_name, "deepseek-v4-pro[1m]");
  await removeModel(root, provider.id, model.id);
  assert.equal((await getDefaultModel(root)), null); // 默认模型被删 → 指针清空
});

test("provider mock 拒绝入清单", async (t) => {
  const root = await tempRoot(t);
  await assert.rejects(
    () => upsertProvider(root, { name: "M", base_url: "https://m.test", api_format: "openai-chat-completions", api_key_env: "M", provider: "mock" }),
    /mock/u
  );
});

test("损坏清单当空清单重建", async (t) => {
  const root = await tempRoot(t);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(root, "model-profiles.json"), "{broken", "utf8");
  const store = await loadProviderStore(root);
  assert.deepEqual(store.providers, []);
});

test("非法 api_format 拒绝保存", async (t) => {
  const root = await tempRoot(t);
  await assert.rejects(
    () => upsertProvider(root, { name: "X", base_url: "https://x.test", api_format: "anthropic-messages", api_key_env: "X" }),
    /api_format/u
  );
});
