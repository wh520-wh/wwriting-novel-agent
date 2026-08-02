import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAppShellServer } from "../src/core/app-server.mjs";
import { loadLocalSecrets } from "../src/core/local-secrets.mjs";
import { loadLocalModelProfiles } from "../src/core/local-model-profiles.mjs";

const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6697, 10080
]);

async function listenOnFetchSafePort(server) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    if (!FETCH_BLOCKED_PORTS.has(port)) {
      return port;
    }
    await closeServer(server);
  }
  throw new Error("Could not allocate a fetch-safe test port");
}

function closeServer(server) {
  // Forcefully drop lingering keep-alive connections so the server closes
  // deterministically. Relying on server.close(cb) alone waits for idle
  // keep-alive sockets, which under load can push a test past node:test's
  // default timeout and produce intermittent "server close" flakes.
  if (typeof server.closeAllConnections === "function") {
    server.closeAllConnections();
  }
  return new Promise((resolve) => server.close(resolve));
}

// 关键点：不建任何项目，selectedProjectRoot 传 null——复刻用户「还没有小说」的场景。
async function setupProjectlessServer() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-globalroute-"));
  const secretsRoot = path.join(root, ".secrets");
  const server = createAppShellServer({
    workspaceRoot: root,
    selectedProjectRoot: null,
    stateRoot: path.join(root, ".state"),
    secretsRoot,
    port: 0
  });
  const port = await listenOnFetchSafePort(server);
  return { root, secretsRoot, server, port };
}

async function post(port, pathname, body) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, json: await response.json() };
}

const SAMPLE_MODEL = {
  provider: "openai-compatible",
  model_name: "deepseek-chat",
  base_url: "https://api.deepseek.com",
  api_key_env: "DEEPSEEK_API_KEY",
  api_key: "sk-test-abcd1234"
};

test("无项目也能保存模型：不再要求先新建小说", async () => {
  const { secretsRoot, server, port } = await setupProjectlessServer();
  try {
    const { status, json } = await post(port, "/api/settings/model-profile", {
      active_model: SAMPLE_MODEL
    });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.model_profile.model_name, "deepseek-chat");
    // 用户要求：保存后能确认密钥真的存下来了
    assert.equal(json.model_profile.api_key_saved, true);
    const secrets = await loadLocalSecrets(secretsRoot);
    assert.equal(secrets.DEEPSEEK_API_KEY, "sk-test-abcd1234");
    const store = await loadLocalModelProfiles(secretsRoot);
    assert.equal(store.default_model_id, "deepseek-chat");
  } finally {
    await closeServer(server);
  }
});

test("无项目保存模型：字段缺失时返回逐字段错误，供界面标红", async () => {
  const { server, port } = await setupProjectlessServer();
  try {
    const { status, json } = await post(port, "/api/settings/model-profile", {
      active_model: { provider: "openai-compatible", model_name: "", base_url: "", api_key_env: "" }
    });
    assert.equal(status, 400);
    assert.equal(typeof json.fields, "object");
    assert.equal(typeof json.fields.model_name, "string");
  } finally {
    await closeServer(server);
  }
});

test("无项目也能列出、选用、删除模型", async () => {
  const { server, port } = await setupProjectlessServer();
  try {
    await post(port, "/api/settings/model-profile", { active_model: SAMPLE_MODEL });
    await post(port, "/api/settings/model-profile", {
      active_model: { ...SAMPLE_MODEL, model_name: "mimo-v1", api_key_env: "XIAOMI_MIMO_API_KEY", api_key: "sk-mimo" }
    });

    const listed = await fetch(`http://127.0.0.1:${port}/api/settings/models`);
    const listJson = await listed.json();
    assert.equal(listed.status, 200);
    assert.equal(listJson.models.length, 2);

    const selected = await post(port, "/api/settings/model-select", { model_id: "deepseek-chat" });
    assert.equal(selected.status, 200);
    assert.equal(selected.json.default_model.model_name, "deepseek-chat");

    const removed = await post(port, "/api/settings/model-remove", { model_id: "mimo-v1" });
    assert.equal(removed.status, 200);
    assert.equal(removed.json.models.length, 1);
    assert.equal(removed.json.models[0].model_name, "deepseek-chat");
  } finally {
    await closeServer(server);
  }
});

test("选用/删除不存在的模型：400 且带可读原因", async () => {
  const { server, port } = await setupProjectlessServer();
  try {
    const selected = await post(port, "/api/settings/model-select", { model_id: "ghost" });
    assert.equal(selected.status, 400);
    assert.match(selected.json.message, /未找到已配置模型/);
    const removed = await post(port, "/api/settings/model-remove", { model_id: "ghost" });
    assert.equal(removed.status, 400);
  } finally {
    await closeServer(server);
  }
});
