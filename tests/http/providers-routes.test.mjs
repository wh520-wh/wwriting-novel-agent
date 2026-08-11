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
  assert.deepEqual(deepseek.models.map((m) => m.model_name), ["deepseek-v4-pro", "deepseek-v4-flash"]);
  assert.equal(data.default_model, null);
});

test("新建供应商 + 加模型 + 设默认 + 删除", async (t) => {
  const { http } = await setup(t);
  const created = await http.post("/api/settings/providers", {
    name: "我的中转", base_url: "https://relay.example.com",
    api_format: "openai-chat-completions", api_key_env: "MY_KEY"
  });
  assert.equal(created.res.status, 200);
  const providerId = created.data.provider.id;
  assert.match(providerId, /^pv_/u);

  const added = await http.post(`/api/settings/providers/${providerId}/models`, { model_name: "gpt-4o[1m]" });
  assert.equal(added.res.status, 200);
  const modelId = added.data.model.id;

  const def = await http.post(`/api/settings/providers/${providerId}/models/${modelId}/default`);
  assert.equal(def.res.status, 200);
  assert.deepEqual(def.data.store.default_model, { provider_id: providerId, model_id: modelId });

  const dup = await http.post("/api/settings/providers", {
    name: "我的中转", base_url: "https://other.example.com",
    api_format: "openai-chat-completions", api_key_env: "K2"
  });
  assert.equal(dup.res.status, 400);
  assert.equal(dup.data.code, "duplicate_provider_name");

  const removed = await http.post(`/api/settings/providers/${providerId}/remove`, {});
  assert.equal(removed.res.status, 200);
  assert.equal(removed.data.store.providers.some((p) => p.id === providerId), false);
});

test("非法 api_format 保存被拒", async (t) => {
  const { http } = await setup(t);
  const res = await http.post("/api/settings/providers", {
    name: "X", base_url: "https://x.test", api_format: "anthropic-messages", api_key_env: "X"
  });
  assert.equal(res.res.status, 400);
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
  assert.equal(data.secret_saved, true);
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
