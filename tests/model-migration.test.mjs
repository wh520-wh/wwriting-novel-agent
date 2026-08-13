// tests/model-migration.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadProviderStore, migrateV1Store, normalizeProviderStore, removeProvider } from "../src/core/model-provider-store.mjs";
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

// Task 19（spec 4.3 #12）：确定性 ID——相同 v1 输入跨运行生成相同 provider/model
// IDs（独立分支 ID 从规范化 base_url/model_name 派生，而非随机 UUID）。
const DETERMINISTIC_V1 = {
  schema_version: 1,
  default_model_id: null,
  models: [
    { id: "deepseek-v4-flash", provider: "openai-compatible", provider_label: "DeepSeek 官方", model_name: "deepseek-v4-flash", base_url: "https://api.deepseek.com", api_key_env: "DEEPSEEK_API_KEY" },
    { id: "x1", provider: "openai-compatible", provider_label: "我的中转", model_name: "relay-model", base_url: "https://relay.example.com", api_key_env: "K" },
    { id: "x2", provider: "openai-compatible", provider_label: "另一个中转", model_name: "other-model", base_url: "https://other.example.com", api_key_env: "K2" }
  ]
};

test("相同 v1 输入调用 migrateV1Store 两次：provider/model IDs 完全一致", () => {
  const first = migrateV1Store(DETERMINISTIC_V1, MODEL_PRESETS);
  const second = migrateV1Store(DETERMINISTIC_V1, MODEL_PRESETS);
  assert.deepEqual(
    first.providers.map((p) => p.id),
    second.providers.map((p) => p.id),
    "provider IDs 跨运行稳定"
  );
  for (const [i, p] of first.providers.entries()) {
    assert.deepEqual(
      p.models.map((m) => m.id),
      second.providers[i].models.map((m) => m.id),
      `provider ${p.id} 的 model IDs 跨运行稳定`
    );
  }
  // 独立供应商/模型 ID 为确定性派生形态（非随机 UUID）
  const relay = first.providers.find((p) => p.base_url === "https://relay.example.com");
  assert.match(relay.id, /^pv_[0-9a-f]{16}$/u);
  assert.match(relay.models[0].id, /^m_[0-9a-f]{16}$/u);
});

test("相同 v1 文件在不同根目录 load/migrate：provider/model IDs 完全一致", async (t) => {
  const roots = [];
  for (let i = 0; i < 2; i += 1) {
    const root = await mkdtemp(path.join(tmpdir(), "mp-mig-det-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, "model-profiles.json"), JSON.stringify(DETERMINISTIC_V1), "utf8");
    roots.push(root);
  }
  const [sa, sb] = await Promise.all(roots.map((root) => loadProviderStore(root)));
  assert.deepEqual(
    sa.providers.map((p) => [p.id, p.models.map((m) => m.id)]),
    sb.providers.map((p) => [p.id, p.models.map((m) => m.id)]),
    "两个独立迁移运行产出相同 IDs（跨运行确定性契约）"
  );
  assert.deepEqual(sa.default_model, sb.default_model, "默认指针指向同一 provider/model");
  // 内容等价（忽略 created_at/updated_at：跨运行仅要求 ID 稳定，字节等价是
  // 同根并发契约——并发两方读到的是同一份已持久化时间戳）
  const stripTime = (s) => JSON.parse(JSON.stringify(s, (key, value) =>
    key === "created_at" || key === "updated_at" ? "" : value));
  assert.deepEqual(stripTime(sa), stripTime(sb), "忽略运行时刻戳后内容等价");
});

// Task 19 审查（Minor 3）：standalone 合并键与 ID 派生键必须同源——仅差尾斜杠
// 的 base_url 变体在迁移期合并为同一供应商，两个模型完整保留（旧实现两个桶
// 派生同一 ID，被归一化去重静默丢弃第二个供应商及其 models）。
test("尾斜杠变体的同 base_url 旧条目合并，模型完整保留", () => {
  const v1 = {
    schema_version: 1,
    default_model_id: null,
    models: [
      { id: "a1", provider: "openai-compatible", provider_label: "我的中转", model_name: "a1", base_url: "https://relay.example.com", api_key_env: "K" },
      { id: "a2", provider: "openai-compatible", provider_label: "我的中转", model_name: "a2", base_url: "https://relay.example.com/", api_key_env: "K" }
    ]
  };
  const store = migrateV1Store(v1, MODEL_PRESETS);
  const relay = store.providers.filter((p) => p.base_url.replace(/\/+$/u, "") === "https://relay.example.com");
  assert.equal(relay.length, 1, "尾斜杠变体合并为一个供应商");
  assert.deepEqual(
    relay[0].models.map((m) => m.model_name).sort(),
    ["a1", "a2"],
    "两个模型都不丢失"
  );
  // 落盘重读后依旧单供应商（归一化不再静默丢模型）
  const normalized = normalizeProviderStore(store);
  const onDisk = normalizeProviderStore(JSON.parse(JSON.stringify(store)));
  assert.equal(onDisk.providers.filter((p) => p.id === relay[0].id).length, 1);
  assert.equal(normalized.providers.find((p) => p.id === relay[0].id).models.length, 2);
});
