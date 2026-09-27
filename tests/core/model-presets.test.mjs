// tests/model-presets.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensurePresetProviders, MODEL_PRESETS } from "../../src/core/model-presets.mjs";
import { loadProviderStore, upsertProvider, removeProvider } from "../../src/core/model-provider-store.mjs";

async function tempRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), "mp-preset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("预设目录含 deepseek/mimo 固定 id 与官方模型（从目录 seeded 条目派生）", () => {
  const ids = MODEL_PRESETS.map((p) => p.id);
  assert.deepEqual(ids, ["deepseek", "mimo"]);
  // D7：预设定义从目录 seeded 条目派生，模型 = 候选 ∩ 官方价目表（供 v1 迁移
  // 匹配/补全/价格用，语义与旧硬编码一致）
  const deepseek = MODEL_PRESETS.find((p) => p.id === "deepseek");
  assert.deepEqual(deepseek.models.map((m) => m.model_name), ["deepseek-v4-pro", "deepseek-v4-flash"]);
  assert.equal(deepseek.base_url, "https://api.deepseek.com");
  assert.equal(deepseek.api_key_env, "DEEPSEEK_API_KEY");
  const mimo = MODEL_PRESETS.find((p) => p.id === "mimo");
  assert.deepEqual(mimo.models.map((m) => m.model_name), ["mimo-v2.5-pro", "mimo-v2.5"]);
  assert.equal(mimo.base_url, "https://api.xiaomimimo.com/v1");
  assert.equal(mimo.api_key_env, "XIAOMI_MIMO_API_KEY");
});

test("空清单种子写入两个预设供应商，模型列表为空态（D7：候选不自动入列）", async (t) => {
  const root = await tempRoot(t);
  const { store, seeded } = await ensurePresetProviders(root);
  assert.equal(seeded, 2);
  assert.deepEqual(store.providers.map((p) => p.id).sort(), ["deepseek", "mimo"]);
  const deepseek = store.providers.find((p) => p.id === "deepseek");
  assert.deepEqual(deepseek.models, [], "播种不写模型——模型列表从空态开始");
  assert.equal(deepseek.api_key_env, "DEEPSEEK_API_KEY", "密钥存储名沿用目录 seeded 条目");
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

// Task 19 复审回归钉：无缺种时必须零写盘——ensurePresetProviders 在每个
// GET /api/settings/providers 与 providerOf 前置调用，若 withStoreLock 在
// changed:false 时仍落盘，只读清单路径会退化为完整原子写（目录不可写时列表
// 接口从照常返回退化为失败）。mtime 断言：无缺种调用前后文件时间戳不变。
test("无缺种不写盘（锁内路径 mtime 不变）", async (t) => {
  const root = await tempRoot(t);
  await ensurePresetProviders(root); // 首次播种（写盘）
  const file = path.join(root, "model-profiles.json");
  const before = (await stat(file)).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 10)); // 拉开时间戳粒度窗口
  const { seeded } = await ensurePresetProviders(root);
  assert.equal(seeded, 0);
  const after = (await stat(file)).mtimeMs;
  assert.equal(after, before, "无缺种调用不得重写清单文件");
});

test("无缺种不写盘（注入 seam：save 不被调用）", async (t) => {
  const root = await tempRoot(t);
  await ensurePresetProviders(root); // 播种
  let saves = 0;
  const { seeded } = await ensurePresetProviders(root, {
    load: async () => loadProviderStore(root),
    save: async () => { saves += 1; }
  });
  assert.equal(seeded, 0);
  assert.equal(saves, 0, "无缺种时注入 save 不得被调用");
});
