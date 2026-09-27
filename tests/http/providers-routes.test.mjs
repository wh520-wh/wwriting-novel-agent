// tests/http/providers-routes.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRouter } from "../../src/core/http/router.mjs";
import { startHttpServer, listenOnFetchSafePort, closeServer } from "../helpers/http-test.mjs";
import { createProvidersRoutes } from "../../src/core/http/providers-routes.mjs";
import { saveLocalSecrets } from "../../src/core/local-secrets.mjs";
import { saveProviderStore } from "../../src/core/model-provider-store.mjs";

async function setup(t) {
  const secretsRoot = await mkdtemp(path.join(tmpdir(), "providers-"));
  t.after(() => rm(secretsRoot, { recursive: true, force: true }));
  const router = createRouter();
  const http = await startHttpServer(t, { router, routeModules: [createProvidersRoutes({ secretsRoot })] });
  return { http, secretsRoot };
}

test("GET providers 返回预设并含模型", async (t) => {
  const { http } = await setup(t);
  const { res, data } = await http.get("/api/settings/providers");
  assert.equal(res.status, 200);
  const ids = data.providers.map((p) => p.id);
  assert.deepEqual(ids.sort(), ["deepseek", "mimo"]);
  const deepseek = data.providers.find((p) => p.id === "deepseek");
  // D7：播种只写供应商身份，模型列表为空态（候选不自动入列）
  assert.deepEqual(deepseek.models, []);
  assert.equal(data.default_model, null);
});

test("GET provider-catalog 返回目录 JSON（只读、不含密钥、协议在三协议白名单内）", async (t) => {
  const { http } = await setup(t);
  const { res, data } = await http.get("/api/settings/provider-catalog");
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  const catalog = data.catalog;
  assert.equal(catalog.schemaVersion, 1);
  assert.ok(Array.isArray(catalog.items) && catalog.items.length >= 10, "目录含全部候选厂商");
  const deepseek = catalog.items.find((item) => item.id === "deepseek");
  assert.equal(deepseek.seeded, true, "原预设两条标 seeded");
  const seeded = catalog.items.filter((item) => item.seeded).map((item) => item.id);
  assert.deepEqual(seeded.sort(), ["deepseek", "mimo"]);
  // 目录是身份与连接信息的唯一来源，不得携带任何密钥
  assert.equal(JSON.stringify(catalog).includes("sk-"), false);
});

test("新建供应商 + 加模型 + 设默认 + 删除", async (t) => {
  const { http } = await setup(t);
  // D8：POST 只带名称/Base URL/协议——服务端自动生成密钥存储名 = 供应商编号
  const created = await http.post("/api/settings/providers", {
    name: "我的中转", base_url: "https://relay.example.com",
    api_format: "openai-chat-completions"
  });
  assert.equal(created.res.status, 200);
  const providerId = created.data.provider.id;
  assert.match(providerId, /^pv_/u);
  assert.equal(created.data.provider.api_key_env, providerId, "新供应商密钥存储名应自动等于供应商编号");

  const added = await http.post(`/api/settings/providers/${providerId}/models`, { model_name: "gpt-4o[1m]" });
  assert.equal(added.res.status, 200);
  const modelId = added.data.model.id;

  const def = await http.post(`/api/settings/providers/${providerId}/models/${modelId}/default`);
  assert.equal(def.res.status, 200);
  assert.deepEqual(def.data.store.default_model, { provider_id: providerId, model_id: modelId });

  const dup = await http.post("/api/settings/providers", {
    name: "我的中转", base_url: "https://other.example.com",
    api_format: "openai-chat-completions"
  });
  assert.equal(dup.res.status, 400);
  assert.equal(dup.data.code, "duplicate_provider_name");

  const removed = await http.post(`/api/settings/providers/${providerId}/remove`, {});
  assert.equal(removed.res.status, 200);
  assert.equal(removed.data.store.providers.some((p) => p.id === providerId), false);
});

test("providers model-remove：不存在供应商 404、不存在模型 404、存在则删除成功", async (t) => {
  const { http } = await setup(t);
  const created = await http.post("/api/settings/providers", {
    name: "删除测试", base_url: "https://relay.example.com",
    api_format: "openai-chat-completions", api_key_env: "DEL_KEY"
  });
  const providerId = created.data.provider.id;
  const added = await http.post(`/api/settings/providers/${providerId}/models`, { model_name: "gpt-4o" });
  const modelId = added.data.model.id;

  // 不存在供应商 → 404 provider_not_found（Task 11 预守卫：store 的 removeModel 对
  // 不存在供应商抛 bare 错误会被 wrap 原样上抛落 500，预守卫把它锁成 404）。
  // message 断言（2026-09-28）：该 code 在 SAFE_PUBLIC_ERROR_CODES 白名单内，
  // 固定文案「供应商不存在」必须透传给用户，不得收敛为通用文案。
  const ghost = await http.post("/api/settings/providers/pv_no_such/models/mv_whatever/remove", {});
  assert.equal(ghost.res.status, 404);
  assert.equal(ghost.data.code, "provider_not_found");
  assert.equal(ghost.data.message, "供应商不存在");

  // 供应商存在但模型不存在 → 404 model_not_found
  const missing = await http.post(`/api/settings/providers/${providerId}/models/mv_no_such/remove`, {});
  assert.equal(missing.res.status, 404);
  assert.equal(missing.data.code, "model_not_found");

  // 正常删除 → 200，store 响应中该模型消失
  const removed = await http.post(`/api/settings/providers/${providerId}/models/${modelId}/remove`, {});
  assert.equal(removed.res.status, 200);
  assert.equal(removed.data.ok, true);
  const providerAfter = removed.data.store.providers.find((p) => p.id === providerId);
  assert.equal(providerAfter.models.some((m) => m.id === modelId), false);
  assert.equal(providerAfter.models.length, 0);
});

test("非法 api_format 保存被拒", async (t) => {
  const { http } = await setup(t);
  // round22 D5：anthropic-messages / openai-responses 已入白名单，非法用例改用无实现的 gemini 死选项
  const res = await http.post("/api/settings/providers", {
    name: "X", base_url: "https://x.test", api_format: "gemini-generate-content", api_key_env: "X"
  });
  assert.equal(res.res.status, 400);
});

test("default 设默认：停用模型被拒（400 model_disabled）", async (t) => {
  const { http } = await setup(t);
  const created = await http.post("/api/settings/providers", {
    name: "停用模型", base_url: "https://relay.example.com",
    api_format: "openai-chat-completions", api_key_env: "OFF_KEY"
  });
  const providerId = created.data.provider.id;
  // 直接以 enabled:false 创建停用模型（与前端「先停用再设默认」序列等价）
  const added = await http.post(`/api/settings/providers/${providerId}/models`, { model_name: "gpt-4o", enabled: false });
  assert.equal(added.res.status, 200);
  const modelId = added.data.model.id;

  const def = await http.post(`/api/settings/providers/${providerId}/models/${modelId}/default`);
  assert.equal(def.res.status, 400);
  assert.equal(def.data.code, "model_disabled");
  assert.equal(def.data.ok, false);
});

test("pull-models 未配密钥时 400 且不发请求", async (t) => {
  const { http } = await setup(t);
  const created = await http.post("/api/settings/providers", {
    name: "空密钥", base_url: "https://relay.example.com",
    api_format: "openai-chat-completions", api_key_env: "NO_SUCH_KEY"
  });
  const providerId = created.data.provider.id;
  const pulled = await http.post(`/api/settings/providers/${providerId}/pull-models`, {});
  assert.equal(pulled.res.status, 400);
  assert.equal(pulled.data.code, "missing_api_key");
});

test("PATCH 携带 api_key 时落盘 secrets.json", async (t) => {
  const { http, secretsRoot } = await setup(t);
  const created = await http.post("/api/settings/providers", {
    name: "带密钥", base_url: "https://relay.example.com",
    api_format: "openai-chat-completions", api_key_env: "MY_RELAY_KEY"
  });
  const providerId = created.data.provider.id;
  const res = await fetch(`${http.base}/api/settings/providers/${providerId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: "sk-real-secret" })
  });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.api_key_saved, true, "密钥保存响应只携带 api_key_saved: true");
  const { readFile } = await import("node:fs/promises");
  const secrets = JSON.parse(await readFile(path.join(secretsRoot, "secrets.json"), "utf8"));
  assert.equal(secrets.MY_RELAY_KEY, "sk-real-secret");
  // 响应与持久化配置中不出现密钥明文
  assert.equal(JSON.stringify(data).includes("sk-real-secret"), false);
});

test("pull-models 成功路径：本地 mock /models 返回列表并过滤空 id", async (t) => {
  const { http, secretsRoot } = await setup(t);
  // 本地 mock 模型服务（fetch-safe 端口），仅应答 /v1/models
  const server = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "a" }, { id: "b" }, { id: "" }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const port = await listenOnFetchSafePort(server);
  t.after(() => closeServer(server));

  await saveLocalSecrets(secretsRoot, { MOCK_KEY: "sk-mock" });
  const created = await http.post("/api/settings/providers", {
    name: "mock 中转", base_url: `http://127.0.0.1:${port}/v1`,
    api_format: "openai-chat-completions", api_key_env: "MOCK_KEY"
  });
  const providerId = created.data.provider.id;
  const pulled = await http.post(`/api/settings/providers/${providerId}/pull-models`, {});
  assert.equal(pulled.res.status, 200);
  assert.deepEqual(pulled.data.models, ["a", "b"]);
});

test("GET providers 携带每供应商 api_key_saved 状态（Task 20 #3 已配置状态）", async (t) => {
  const { http, secretsRoot } = await setup(t);
  // 预设未保存密钥 → false
  const initial = await http.get("/api/settings/providers");
  const deepseek = initial.data.providers.find((p) => p.id === "deepseek");
  assert.equal(deepseek.api_key_saved, false, "未保存密钥的供应商 api_key_saved 应为 false");
  assert.equal("api_key" in deepseek, false, "供应商对象不得携带明文密钥字段");
  // 保存密钥后 → true（状态只反映本地 secrets，不回显明文）
  await saveLocalSecrets(secretsRoot, { DEEPSEEK_API_KEY: "sk-deep" });
  const after = await http.get("/api/settings/providers");
  const configured = after.data.providers.find((p) => p.id === "deepseek");
  assert.equal(configured.api_key_saved, true, "保存密钥后 api_key_saved 应为 true");
  assert.equal(JSON.stringify(after.data).includes("sk-deep"), false, "响应不得回显密钥明文");
});

test("PATCH 密钥契约：api_key 一律按明文、api_key_env 只存名称、不猜形状（Task 20 #14）", async (t) => {
  const { http, secretsRoot } = await setup(t);
  const created = await http.post("/api/settings/providers", {
    name: "开关测试", base_url: "https://relay.example.com",
    api_format: "openai-chat-completions", api_key_env: "SWITCH_KEY"
  });
  const providerId = created.data.provider.id;

  // 1) api_key_env 更新：只写供应商字段、不写 secrets、响应 api_key_saved: false
  const envRes = await fetch(`${http.base}/api/settings/providers/${providerId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key_env: "RENAMED_KEY" })
  });
  const envData = await envRes.json();
  assert.equal(envRes.status, 200);
  assert.equal(envData.api_key_saved, false, "仅更新环境变量名不应标记密钥已保存");
  assert.equal(envData.provider.api_key_env, "RENAMED_KEY");
  const { readFile } = await import("node:fs/promises");
  let secrets;
  try {
    secrets = JSON.parse(await readFile(path.join(secretsRoot, "secrets.json"), "utf8"));
  } catch {
    secrets = {};
  }
  assert.equal(secrets.RENAMED_KEY, undefined, "环境变量名更新不得写入密钥 bucket");

  // 2) 形如环境变量名的 api_key 仍按明文写入（后端不猜字符串形状）
  const keyRes = await fetch(`${http.base}/api/settings/providers/${providerId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: "MY_API_KEY" })
  });
  const keyData = await keyRes.json();
  assert.equal(keyRes.status, 200);
  assert.equal(keyData.api_key_saved, true, "明文密钥写入应标记 api_key_saved: true");
  secrets = JSON.parse(await readFile(path.join(secretsRoot, "secrets.json"), "utf8"));
  assert.equal(secrets.RENAMED_KEY, "MY_API_KEY", "MY_API_KEY 应作为明文密钥存进现有 bucket");
  assert.equal(JSON.stringify(keyData).includes("MY_API_KEY"), false, "响应不得回显密钥");

  // 3) 内部既有非法 env 名的记录：写密钥仍拒绝（saveLocalSecrets 会静默丢弃非法
  //    环境变量名——防御路径保留，不能静默丢密钥）。UI 已无 env 名输入，此记录
  //    只能来自内部/损坏数据，经直接落盘构造。
  const corruptedRoot = secretsRoot;
  await saveProviderStore(corruptedRoot, {
    schema_version: 2, default_model: null,
    providers: [{ id: "pv_corrupt", name: "损坏记录", type: "custom", status: "enabled",
      base_url: "https://corrupt.example.com", api_format: "openai-chat-completions",
      api_key_env: "1BAD", models: [], created_at: "2026-01-01", updated_at: "2026-01-01" }]
  });
  const bad = await fetch(`${http.base}/api/settings/providers/pv_corrupt`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: "sk-x" })
  });
  const badData = await bad.json();
  assert.equal(bad.status, 400);
  assert.equal(badData.code, "invalid_api_key_env");

  // 4) D8：旧空 env 记录（历史数据）PATCH {api_key} → 以供应商编号为桶写盘并回填字段
  await saveProviderStore(corruptedRoot, {
    schema_version: 2, default_model: null,
    providers: [{ id: "pv_legacy", name: "旧记录", type: "custom", status: "enabled",
      base_url: "https://legacy.example.com", api_format: "openai-chat-completions",
      api_key_env: "", models: [], created_at: "2026-01-01", updated_at: "2026-01-01" }]
  });
  const legacy = await fetch(`${http.base}/api/settings/providers/pv_legacy`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: "test-secret" })
  });
  const legacyData = await legacy.json();
  assert.equal(legacy.status, 200);
  assert.equal(legacyData.api_key_saved, true);
  assert.equal(legacyData.provider.api_key_env, "pv_legacy", "旧空 env 记录应回填供应商编号为存储名");
  secrets = JSON.parse(await readFile(path.join(secretsRoot, "secrets.json"), "utf8"));
  assert.equal(secrets.pv_legacy, "test-secret", "secrets.json 应以供应商编号为键");
  // 读路径：GET 显示已配置；store JSON 不含明文
  const after = await http.get("/api/settings/providers");
  const legacyAfter = after.data.providers.find((p) => p.id === "pv_legacy");
  assert.equal(legacyAfter.api_key_saved, true);
  assert.equal(JSON.stringify(after.data).includes("test-secret"), false, "store 响应不得含明文");
});

test("PATCH 保存密钥后立即注入 process.env，无需重启（whfind-bugs #2）", async (t) => {
  const { http } = await setup(t);
  const envName = "WW_TEST_BUG2_KEY";
  const created = await http.post("/api/settings/providers", {
    name: "env 注入测试", base_url: "https://relay.example.com",
    api_format: "openai-chat-completions", api_key_env: envName
  });
  const providerId = created.data.provider.id;
  try {
    const res = await fetch(`${http.base}/api/settings/providers/${providerId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: "sk-bug2-fix" })
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.api_key_saved, true);
    // 核心断言：PATCH 返回时 process.env 就必须就位（连接测试直读 secrets.json
    // 通过、正式模型调用只查 process.env 失败 = 首次配置必须重启才能用）。
    assert.equal(process.env[envName], "sk-bug2-fix");
  } finally {
    delete process.env[envName];
  }
});

test("PATCH models/:modelId：旧迁移形态 id（含斜杠冒号）编码后可达，裸拼 404（2026-09-27 保存失败根因）", async (t) => {
  const { http, secretsRoot } = await setup(t);
  const slashedId = "deepseek-v4-flash@https://api.deepseek.com/v1";
  await saveProviderStore(secretsRoot, {
    schema_version: 2, default_model: null,
    providers: [{ id: "deepseek", name: "DeepSeek 官方", type: "custom", status: "enabled",
      base_url: "https://api.deepseek.test", api_format: "openai-chat-completions",
      api_key_env: "DEEPSEEK_API_KEY",
      models: [{ id: slashedId, model_name: "deepseek-v4-flash", enabled: true }],
      created_at: "2026-01-01", updated_at: "2026-01-01" }]
  });

  // 修复前前端行为：id 裸拼进路径 → 路径多出段 → 路由不匹配 → 404（非白名单 code
  // 收敛为通用文案「操作未完成…」，用户无从行动）。
  const raw = await http.patch(`/api/settings/providers/deepseek/models/${slashedId}`, { model_name: "renamed" });
  assert.equal(raw.res.status, 404);

  // 修复后：encodeURIComponent 单段可达，:modelId 解码回原 id 命中存储。
  const encoded = await http.patch(`/api/settings/providers/deepseek/models/${encodeURIComponent(slashedId)}`, { model_name: "renamed" });
  assert.equal(encoded.res.status, 200);
  assert.equal(encoded.data.model.id, slashedId, "解码后的 id 必须命中存储记录");
  assert.equal(encoded.data.model.model_name, "renamed");
});
