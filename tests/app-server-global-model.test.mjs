import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAppShellServer } from "../src/core/app-server.mjs";
import { loadLocalSecrets } from "../src/core/local-secrets.mjs";
import { loadLocalModelProfiles } from "../src/core/local-model-profiles.mjs";
import { createProject, loadProject, saveProject } from "../src/core/project-store.mjs";

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
async function setupProjectlessServer(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-globalroute-"));
  const secretsRoot = path.join(root, ".secrets");
  const { connectionTester, ...rest } = options;
  const server = createAppShellServer({
    workspaceRoot: root,
    selectedProjectRoot: null,
    stateRoot: path.join(root, ".state"),
    secretsRoot,
    port: 0,
    ...rest,
    // 注入点参数名是 testModelConnection；测试统一用 connectionTester 透传假探测函数，避免真实网络。
    ...(connectionTester ? { testModelConnection: connectionTester } : {})
  });
  const port = await listenOnFetchSafePort(server);
  return { root, secretsRoot, server, port };
}

async function setupServerWithProject(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-globalsync-"));
  const { projectRoot } = await createProject(root, { slug: "project", target_chapters: 3 });
  const secretsRoot = path.join(root, ".secrets");
  const server = createAppShellServer({
    workspaceRoot: root,
    selectedProjectRoot: projectRoot,
    stateRoot: path.join(root, ".state"),
    secretsRoot,
    port: 0,
    ...options
  });
  const port = await listenOnFetchSafePort(server);
  return { root, projectRoot, secretsRoot, server, port };
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

test("无项目也能测试连接：不再要求先新建小说", async () => {
  const calls = [];
  const { server, port } = await setupProjectlessServer({
    // 与 app-server-probe 同款写法：注入函数收到 { config, secrets, signal } 信封对象。
    connectionTester: async (input) => {
      calls.push(input.config.model_name);
      return { ok: true, message: "连接正常", model_name: input.config.model_name };
    }
  });
  try {
    await post(port, "/api/settings/model-profile", { active_model: SAMPLE_MODEL });
    const { status, json } = await post(port, "/api/settings/test-connection", {
      active_model: {
        provider: "openai-compatible",
        model_name: "deepseek-chat",
        base_url: "https://api.deepseek.com",
        api_key_env: "DEEPSEEK_API_KEY"
      }
    });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.deepEqual(calls, ["deepseek-chat"]);
  } finally {
    await closeServer(server);
  }
});

test("无项目测试连接：字段缺失仍返回逐字段错误", async () => {
  const { server, port } = await setupProjectlessServer({
    connectionTester: async () => ({ ok: true, message: "连接正常" })
  });
  try {
    const { status, json } = await post(port, "/api/settings/test-connection", {
      active_model: { provider: "openai-compatible", model_name: "x", base_url: "", api_key_env: "" }
    });
    assert.equal(status, 400);
    assert.equal(typeof json.fields, "object");
  } finally {
    await closeServer(server);
  }
});

test("改全局模型后打开界面：已有项目的模型配置跟着变", async () => {
  const { projectRoot, server, port } = await setupServerWithProject();
  try {
    // 项目先指向旧地址
    const project = await loadProject(projectRoot);
    await saveProject(projectRoot, {
      ...project,
      active_model: {
        provider: "openai-compatible",
        model_name: "deepseek-chat",
        base_url: "https://old.example.com",
        api_key_env: "OLD_KEY_ENV"
      }
    });
    // 在设置里把同名模型改成新地址 + 新密钥变量名
    await post(port, "/api/settings/model-profile", {
      active_model: {
        provider: "openai-compatible",
        model_name: "deepseek-chat",
        base_url: "https://api.deepseek.com",
        api_key_env: "DEEPSEEK_API_KEY",
        api_key: "sk-new"
      }
    });

    const dashboard = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(dashboard.status, 200);
    await dashboard.text();

    const synced = await loadProject(projectRoot);
    assert.equal(synced.active_model.base_url, "https://api.deepseek.com");
    assert.equal(synced.active_model.api_key_env, "DEEPSEEK_API_KEY");
  } finally {
    await closeServer(server);
  }
});

// Task 11（2026-08-03 修订）：建项目不规定模型——projects/init 不带 model_id，
// 直接用全局默认模型；写作中随时通过 model-switch 换模型（入口是 composer 底部
// 状态栏模型按钮与 /model 命令，无需新增前端代码）。

test("新建项目不指定模型时沿用全局默认模型", async () => {
  const { root, server, port } = await setupProjectlessServer();
  try {
    // 只配一个模型（deepseek-chat），保存后它就是全局默认
    await post(port, "/api/settings/model-profile", { active_model: SAMPLE_MODEL });
    const target = path.join(root, "novel-default");
    // 建项目不传 model_id：项目直接用全局默认模型
    const { status } = await post(port, "/api/projects/init", {
      projectRoot: target,
      title: "默认模型"
    });
    assert.equal(status, 200);
    const created = await loadProject(target);
    assert.equal(created.active_model.model_name, "deepseek-chat");
    assert.equal(created.active_model.base_url, "https://api.deepseek.com");
  } finally {
    await closeServer(server);
  }
});

test("建项目后随时换模型：切换后项目用清单里的另一个模型", async () => {
  const { root, server, port } = await setupProjectlessServer();
  try {
    // 配两个模型：deepseek-chat、mimo-v1；mimo-v1 最后保存，所以是全局默认
    await post(port, "/api/settings/model-profile", { active_model: SAMPLE_MODEL });
    await post(port, "/api/settings/model-profile", {
      active_model: {
        ...SAMPLE_MODEL,
        model_name: "mimo-v1",
        base_url: "https://api.mimo.example",
        api_key_env: "XIAOMI_MIMO_API_KEY",
        api_key: "sk-mimo"
      }
    });
    // 建项目不传 model_id：项目先用全局默认模型 mimo-v1
    const target = path.join(root, "novel-switch");
    const init = await post(port, "/api/projects/init", {
      projectRoot: target,
      title: "随时换模型"
    });
    assert.equal(init.status, 200);
    const created = await loadProject(target);
    assert.equal(created.active_model.model_name, "mimo-v1");

    // 写作中换模型：切到清单里的 deepseek-chat
    const switched = await post(port, "/api/settings/model-switch", {
      projectRoot: target,
      model_id: "deepseek-chat"
    });
    assert.equal(switched.status, 200);
    const after = await loadProject(target);
    assert.equal(after.active_model.model_name, "deepseek-chat");
    assert.equal(after.active_model.base_url, "https://api.deepseek.com");
    // 响应里的清单完整：两个模型都在
    assert.equal(switched.json.available_models.length, 2);
  } finally {
    await closeServer(server);
  }
});
