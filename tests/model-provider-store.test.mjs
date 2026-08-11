// tests/model-provider-store.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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

test("字段级更新不丢失既有模型", async (t) => {
  const root = await tempRoot(t);
  const { provider } = await upsertProvider(root, { name: "P1", base_url: "https://p1.example.com", api_format: "openai-chat-completions", api_key_env: "P1_KEY" });
  const { model } = await upsertModel(root, provider.id, { model_name: "keep-me" });
  // 只改名、不带 models 的字段更新：既有模型必须保留
  const { store } = await upsertProvider(root, { id: provider.id, name: "P1-改名", base_url: "https://p1.example.com", api_format: "openai-chat-completions", api_key_env: "P1_KEY" });
  assert.equal(store.providers.length, 1);
  assert.equal(store.providers[0].name, "P1-改名");
  assert.equal(store.providers[0].models.length, 1);
  assert.equal(store.providers[0].models[0].id, model.id);
  // 显式携带 models 的空快照仍然整体替换（清空）
  const cleared = await upsertProvider(root, { id: provider.id, name: "P1-改名", base_url: "https://p1.example.com", api_format: "openai-chat-completions", api_key_env: "P1_KEY", models: [] });
  assert.equal(cleared.store.providers[0].models.length, 0);
});

test("更新供应商保持原有列表位置", async (t) => {
  const root = await tempRoot(t);
  const a = await upsertProvider(root, { name: "A", base_url: "https://a.example.com", api_format: "openai-chat-completions", api_key_env: "A_KEY" });
  await upsertProvider(root, { name: "B", base_url: "https://b.example.com", api_format: "openai-chat-completions", api_key_env: "B_KEY" });
  assert.deepEqual((await loadProviderStore(root)).providers.map((p) => p.name), ["B", "A"]); // 新供应商放表头
  await upsertProvider(root, { id: a.provider.id, name: "A2", base_url: "https://a.example.com", api_format: "openai-chat-completions", api_key_env: "A_KEY" });
  assert.deepEqual((await loadProviderStore(root)).providers.map((p) => p.name), ["B", "A2"]); // 原位替换，顺序不变
});

test("并发 upsertProvider 无丢失更新", async (t) => {
  const root = await tempRoot(t);
  const N = 8;
  await Promise.all(Array.from({ length: N }, (_, i) =>
    upsertProvider(root, { name: `并发供应商${i}`, base_url: `https://c${i}.example.com`, api_format: "openai-chat-completions", api_key_env: `C${i}_KEY` })
  ));
  const store = await loadProviderStore(root);
  assert.equal(store.providers.length, N);
});

test("重复供应商名称被拒绝", async (t) => {
  const root = await tempRoot(t);
  await upsertProvider(root, { name: "唯一名", base_url: "https://one.example.com", api_format: "openai-chat-completions", api_key_env: "ONE_KEY" });
  await assert.rejects(
    () => upsertProvider(root, { name: "唯一名", base_url: "https://two.example.com", api_format: "openai-chat-completions", api_key_env: "TWO_KEY" }),
    /duplicate_provider_name/u
  );
});

test("删除持有默认指针的 provider 清空 default_model", async (t) => {
  const root = await tempRoot(t);
  const { provider } = await upsertProvider(root, { name: "D1", base_url: "https://d1.example.com", api_format: "openai-chat-completions", api_key_env: "D1_KEY" });
  const { model } = await upsertModel(root, provider.id, { model_name: "def-model" });
  await setDefaultModel(root, provider.id, model.id);
  const { removed } = await removeProvider(root, provider.id);
  assert.equal(removed, true);
  assert.equal((await loadProviderStore(root)).default_model, null);
});

test("findModelByConfig 匹配 base_url+model_name 并跳过禁用项", async (t) => {
  const root = await tempRoot(t);
  const { provider } = await upsertProvider(root, { name: "F1", base_url: "https://f1.example.com", api_format: "openai-chat-completions", api_key_env: "F1_KEY" });
  await upsertModel(root, provider.id, { model_name: "good" });
  await upsertModel(root, provider.id, { model_name: "disabled-model", enabled: false });
  const disabledProvider = await upsertProvider(root, { name: "F2", base_url: "https://f2.example.com", api_format: "openai-chat-completions", api_key_env: "F2_KEY", status: "disabled" });
  await upsertModel(root, disabledProvider.provider.id, { model_name: "good" });

  const hit = await findModelByConfig(root, { base_url: "https://f1.example.com", model_name: "good" });
  assert.equal(hit.provider.id, provider.id);
  assert.equal(hit.model.model_name, "good");
  assert.equal(await findModelByConfig(root, { base_url: "https://f1.example.com", model_name: "disabled-model" }), null); // 禁用模型跳过
  assert.equal(await findModelByConfig(root, { base_url: "https://other.example.com", model_name: "good" }), null); // base_url 不匹配
  assert.equal(await findModelByConfig(root, { base_url: "https://f2.example.com", model_name: "good" }), null); // 禁用供应商跳过
});

test("无 [1m] 标记的模型默认 context_window 为 256000", async (t) => {
  const root = await tempRoot(t);
  const { provider } = await upsertProvider(root, { name: "W1", base_url: "https://w1.example.com", api_format: "openai-chat-completions", api_key_env: "W1_KEY" });
  const { model } = await upsertModel(root, provider.id, { model_name: "plain-model" });
  assert.equal(model.context_window, 256000);
});

test("setDefaultModel 未知模型被拒绝", async (t) => {
  const root = await tempRoot(t);
  const { provider } = await upsertProvider(root, { name: "S1", base_url: "https://s1.example.com", api_format: "openai-chat-completions", api_key_env: "S1_KEY" });
  await assert.rejects(() => setDefaultModel(root, provider.id, "m_0000000000000000"), /model_not_found/u);
});

test("落盘文件不包含 api_key 字段", async (t) => {
  const root = await tempRoot(t);
  await upsertProvider(root, { name: "K1", base_url: "https://k1.example.com", api_format: "openai-chat-completions", api_key_env: "K1_SECRET" });
  const text = await readFile(path.join(root, "model-profiles.json"), "utf8");
  assert.ok(!/"api_key"\s*:/u.test(text), "持久化文件不应包含 api_key 字段（仅 api_key_env）");
});

test("removeModel 只清同 provider 的默认指针", async (t) => {
  const root = await tempRoot(t);
  const pa = await upsertProvider(root, { name: "A", base_url: "https://a.example.com", api_format: "openai-chat-completions", api_key_env: "A_KEY" });
  const pb = await upsertProvider(root, { name: "B", base_url: "https://b.example.com", api_format: "openai-chat-completions", api_key_env: "B_KEY" });
  const ma = await upsertModel(root, pa.provider.id, { id: "m_shared", model_name: "m1" });
  await upsertModel(root, pb.provider.id, { id: "m_shared", model_name: "m1" });
  await setDefaultModel(root, pa.provider.id, ma.model.id);
  // 删除 B 中同 id 模型，不应清掉 A 的默认指针
  await removeModel(root, pb.provider.id, "m_shared");
  const def = await getDefaultModel(root);
  assert.equal(def.provider.id, pa.provider.id);
  assert.equal(def.model.id, "m_shared");
});

test("删除不存在的 id 不落盘", async (t) => {
  const root = await tempRoot(t);
  const { removed, store } = await removeProvider(root, "pv_0000000000000000");
  assert.equal(removed, false);
  assert.equal(store, null);
  await assert.rejects(() => stat(path.join(root, "model-profiles.json")), /ENOENT/u);
});

test("removeModel 删除不存在的模型不落盘", async (t) => {
  const root = await tempRoot(t);
  const { provider } = await upsertProvider(root, { name: "N1", base_url: "https://n1.example.com", api_format: "openai-chat-completions", api_key_env: "N1_KEY" });
  const { removed, store } = await removeModel(root, provider.id, "m_0000000000000000");
  assert.equal(removed, false);
  assert.equal(store, null);
});
