import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAppShellServer } from "../src/core/app-server.mjs";
import { createProject, loadProject, saveProject } from "../src/core/project-store.mjs";
import { registerProviderCapabilityResolver } from "../src/core/model/capabilities.mjs";
import { saveProviderStore } from "../src/core/model-provider-store.mjs";
import { createWorkspaceStore } from "../src/core/workspaces/store.mjs";

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

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

// 普通文件夹（无 project.yaml）的模型配置工作区：打开即选中，触发预设供应商种子
//（Task 5 Step 1 测试基建；Task 17 cutover 后模型保存走 v2 providers 端点，
// 不再预存 v1 全局模型）。
async function setupPlainWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-plain-"));
  const projectRoot = path.join(root, "plain-workspace");
  const stateRoot = path.join(root, ".state");
  const secretsRoot = path.join(root, ".secrets");
  await fs.mkdir(projectRoot, { recursive: true });
  const server = createAppShellServer({
    workspaceRoot: root,
    selectedProjectRoot: projectRoot,
    stateRoot,
    secretsRoot,
    port: 0
  });
  const port = await listenOnFetchSafePort(server);
  // 触发预设种子（deepseek/mimo 两级清单落盘 v2 store），model-switch 才有可选项。
  await fetch(`http://127.0.0.1:${port}/api/settings/providers`);
  return { root, projectRoot, stateRoot, secretsRoot, server, port };
}

async function post(port, pathname, body) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, json: await response.json() };
}

// 从 GET /api/settings/providers 取预设供应商的第 index 个模型（Task 16 同款引用）。
async function fetchPresetModel(port, providerId = "deepseek", modelIndex = 0) {
  const res = await fetch(`http://127.0.0.1:${port}/api/settings/providers`);
  const data = await res.json();
  const provider = data.providers.find((p) => p.id === providerId);
  assert.ok(provider?.models?.length > 0, `预设供应商 ${providerId} 应含模型`);
  const model = provider.models[modelIndex];
  return { providerId: provider.id, modelId: model.id, modelName: model.model_name };
}

// 设默认（v2 端点）：POST .../models/:modelId/default。
async function setDefaultViaEndpoint(port, providerId, modelId) {
  const res = await post(
    port,
    `/api/settings/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}/default`
  );
  assert.equal(res.status, 200, "设默认应成功");
  return res.json.store.default_model;
}

// Task 6：轮询 dashboard 直到会话列表满足条件。submit 的注册表写入在提交路径内，
// 但列表可见性用轮询兜底时序（与 probe 的 waitFor 同款模式）。
async function waitForDashboardSessions(port, projectRoot, predicate, { timeout = 15000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const res = await fetch(`http://127.0.0.1:${port}/api/dashboard?projectRoot=${encodeURIComponent(projectRoot)}`);
    const data = await res.json();
    if (predicate(data.sessions)) return data;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for dashboard sessions");
}

// 直写 v2 清单造出「存量模型」：providers 端点已被 C 档校验拦截，只有直写能模拟
// 历史数据（saveProviderStore 不经 normalize，loadProviderStore 读时归一化）。
async function writeStoreProvider(secretsRoot, provider) {
  await saveProviderStore(secretsRoot, {
    schema_version: 2,
    default_model: null,
    providers: [provider]
  });
}

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
    const { status, json } = await post(port, "/api/settings/test-connection", {
      active_model: {
        provider: "openai-compatible",
        model_name: "deepseek-chat",
        base_url: "https://api.deepseek.com",
        api_key_env: "DEEPSEEK_API_KEY",
        api_key: "sk-test-abcd1234"
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

test("改全局供应商配置后：不再写回已有项目的模型快照（v2 providers PATCH）", async () => {
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
    // 在全局清单（v2）里把同一供应商改成新地址 + 新密钥变量名
    const created = await post(port, "/api/settings/providers", {
      name: "旧网关",
      base_url: "https://old.example.com",
      api_format: "openai-chat-completions",
      api_key_env: "OLD_KEY_ENV"
    });
    assert.equal(created.status, 200);
    const providerId = created.json.provider.id;
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/providers/${providerId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ base_url: "https://api.deepseek.com", api_key_env: "DEEPSEEK_API_KEY" })
    });
    assert.equal(res.status, 200);

    // 任务 7：写回同步已删除，项目 active_model 快照不被全局清单改写
    const unsynced = await loadProject(projectRoot);
    assert.equal(unsynced.active_model.base_url, "https://old.example.com");
    assert.equal(unsynced.active_model.api_key_env, "OLD_KEY_ENV");
  } finally {
    await closeServer(server);
  }
});

// Task 11（2026-08-03 修订）：建项目不规定模型——projects/init 直接用全局默认模型
//（v2：写引用形态，运行时按 modelStoreLoader 解析）；写作中随时通过 model-switch
// 换模型（入口是 composer 底部状态栏模型按钮与 /model 命令，无需新增前端代码）。

test("新建项目不指定模型时沿用全局默认模型（v2 引用）", async () => {
  const { root, server, port } = await setupProjectlessServer();
  try {
    // 设 deepseek 预设为全局默认
    const ds = await fetchPresetModel(port, "deepseek");
    const defaultRef = await setDefaultViaEndpoint(port, ds.providerId, ds.modelId);
    assert.deepEqual(defaultRef, { provider_id: ds.providerId, model_id: ds.modelId });

    const target = path.join(root, "novel-default");
    // 建项目不传 model_id：项目直接用全局默认模型（引用形态）
    const { status } = await post(port, "/api/projects/init", {
      projectRoot: target,
      title: "默认模型"
    });
    assert.equal(status, 200);
    const created = await loadProject(target);
    assert.deepEqual(
      created.active_model,
      { provider_id: ds.providerId, model_id: ds.modelId },
      "新项目 active_model 应为全局默认的引用"
    );
    // 运行时解析为完整配置
    const dashboard = await fetch(`http://127.0.0.1:${port}/api/dashboard?projectRoot=${encodeURIComponent(target)}`);
    const data = await dashboard.json();
    assert.equal(data.project.active_model.model_name, ds.modelName);
  } finally {
    await closeServer(server);
  }
});

test("建项目后随时换模型：切换后项目用清单里的另一个模型", async () => {
  const { root, server, port } = await setupProjectlessServer();
  try {
    // 全局默认 = mimo（后设），deepseek 留作切换目标
    const ds = await fetchPresetModel(port, "deepseek");
    const mimo = await fetchPresetModel(port, "mimo");
    await setDefaultViaEndpoint(port, mimo.providerId, mimo.modelId);

    // 建项目不传 model_id：项目先用全局默认模型（mimo 引用）
    const target = path.join(root, "novel-switch");
    const init = await post(port, "/api/projects/init", {
      projectRoot: target,
      title: "随时换模型"
    });
    assert.equal(init.status, 200);
    const created = await loadProject(target);
    assert.deepEqual(created.active_model, { provider_id: mimo.providerId, model_id: mimo.modelId });

    // 写作中换模型：切到 deepseek（引用形态）
    const switched = await post(port, "/api/settings/model-switch", {
      projectRoot: target,
      provider_id: ds.providerId,
      model_id: ds.modelId
    });
    assert.equal(switched.status, 200);
    // 模型写入应用私有 workspace settings；project.yaml 不再双写（保留原值）
    const store = createWorkspaceStore({ stateRoot: path.join(root, ".state") });
    const settings = await store.loadSettings(target);
    assert.deepEqual(settings.active_model, { provider_id: ds.providerId, model_id: ds.modelId });
    const legacy = await loadProject(target);
    assert.deepEqual(
      legacy.active_model,
      { provider_id: mimo.providerId, model_id: mimo.modelId },
      "project.yaml 保留为回滚依据，不被改写"
    );
  } finally {
    await closeServer(server);
  }
});

// I-1 缺陷回归（2026-08-03 审查）：normalizeActiveModel 白名单缺 temperature，切模型时
// 温度同时从 project.yaml 与全局 model-profiles.json 永久消失——用户再打开设置温度框
// 为空（「保存后像没保存过」）。v2 下温度随模型条目落盘，断言切换后解析配置仍保留。

test("切换模型保留温度配置：v2 清单条目与解析配置 temperature 都不丢", async () => {
  const { root, secretsRoot, server, port } = await setupProjectlessServer();
  try {
    // 配两个模型：deepseek-chat 带 temperature 0.7；mimo 设全局默认
    const ds = await fetchPresetModel(port, "deepseek");
    const mimo = await fetchPresetModel(port, "mimo");
    const patchRes = await fetch(
      `http://127.0.0.1:${port}/api/settings/providers/${encodeURIComponent(ds.providerId)}/models/${encodeURIComponent(ds.modelId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ temperature: 0.7 })
      }
    );
    assert.equal(patchRes.status, 200);
    await setDefaultViaEndpoint(port, mimo.providerId, mimo.modelId);

    const target = path.join(root, "novel-temp");
    const init = await post(port, "/api/projects/init", {
      projectRoot: target,
      title: "温度保留"
    });
    assert.equal(init.status, 200);

    // 写作中切到带温度的 deepseek
    const switched = await post(port, "/api/settings/model-switch", {
      projectRoot: target,
      provider_id: ds.providerId,
      model_id: ds.modelId
    });
    assert.equal(switched.status, 200);
    // 应用私有 workspace settings：active_model 为引用
    const store = createWorkspaceStore({ stateRoot: path.join(root, ".state") });
    const settings = await store.loadSettings(target);
    assert.deepEqual(settings.active_model, { provider_id: ds.providerId, model_id: ds.modelId });
    // 运行时解析配置保留温度（I-1：切换不得丢温度）
    const dashboard = await fetch(`http://127.0.0.1:${port}/api/dashboard?projectRoot=${encodeURIComponent(target)}`);
    const data = await dashboard.json();
    assert.equal(data.project.active_model.temperature, 0.7, "切换后解析配置应保留 temperature");
    // v2 清单条目本身保留温度
    const storeData = JSON.parse(await fs.readFile(path.join(secretsRoot, "model-profiles.json"), "utf8"));
    const dsEntry = storeData.providers.find((p) => p.id === ds.providerId).models.find((m) => m.id === ds.modelId);
    assert.equal(dsEntry.temperature, 0.7, "v2 清单条目应保留 temperature");
  } finally {
    await closeServer(server);
  }
});

// Task 3 C 档（2026-08-03）：写作引擎强依赖工具调用与流式，能力缺失（no-tools）的模型
// 保存/选用/切换直接报错阻止。no-tools resolver 的 matcher 只命中 no-tools.example，
// 不影响本文件其它用 deepseek/mimo 的用例；注册表无 unregister，沿用既有注入惯例。

test("切换模型：C 档模型切换被拒", async () => {
  registerProviderCapabilityResolver(
    (c) => String(c.base_url ?? "").includes("no-tools.example"),
    () => ({ supportsTools: false })
  );
  const { projectRoot, secretsRoot, server, port } = await setupServerWithProject();
  try {
    // 直写 v2 清单造出「存量 no-tools 模型」：保存/设默认 API 已被 C 档校验拦截，
    // 只有直写能模拟历史数据
    await writeStoreProvider(secretsRoot, {
      id: "pv_no_tools", name: "no-tools", type: "custom", status: "enabled",
      base_url: "https://no-tools.example", api_format: "openai-chat-completions", api_key_env: "NO_TOOLS_API_KEY",
      models: [{ id: "m_no_tools", model_name: "no-tools", enabled: true }]
    });
    const { status, json } = await post(port, "/api/settings/model-switch", {
      projectRoot,
      provider_id: "pv_no_tools",
      model_id: "m_no_tools"
    });
    assert.equal(status, 400);
    assert.equal(json.code, "model_unsupported");
    assert.match(json.message, /不支持工具调用/);
    // 校验发生在写 settings 之前：项目模型没被切过去
    const project = await loadProject(projectRoot);
    assert.notEqual(project.active_model?.model_name, "no-tools");
  } finally {
    await closeServer(server);
  }
});

// Task 4 B 档（2026-08-03）：切换成功响应带 capabilities 与 conflicts——新模型静默
// 丢弃参数（supportsTemperature=false 且项目已配置 temperature）时，前端 toast 追加
// 能力告知。no-temp resolver 的 matcher 只命中 no-temp.example，与 no-tools.example
// 互不干扰（注册表无 unregister，沿用既有注入惯例）。

test("切换模型响应带 capabilities 与 conflicts", async () => {
  registerProviderCapabilityResolver(
    (c) => String(c.base_url ?? "").includes("no-temp.example"),
    () => ({ supportsTemperature: false })
  );
  const { root, projectRoot, secretsRoot, server, port } = await setupServerWithProject();
  try {
    // 项目 active_model 原配置 temperature：模拟「项目已配置温度」
    const project = await loadProject(projectRoot);
    await saveProject(projectRoot, {
      ...project,
      active_model: { ...project.active_model, temperature: 0.7 }
    });
    // 直写 v2 清单造出 no-temp 模型
    await writeStoreProvider(secretsRoot, {
      id: "pv_no_temp", name: "no-temp", type: "custom", status: "enabled",
      base_url: "https://no-temp.example", api_format: "openai-chat-completions", api_key_env: "NO_TEMP_API_KEY",
      models: [{ id: "m_no_temp", model_name: "no-temp", enabled: true }]
    });
    const { status, json } = await post(port, "/api/settings/model-switch", {
      projectRoot,
      provider_id: "pv_no_temp",
      model_id: "m_no_temp"
    });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.capabilities.supportsTemperature, false);
    // 只缺温度能力，工具/流式仍在：C 档校验不拦这类模型（B 档只告知不阻止）
    assert.equal(json.capabilities.supportsTools, true);
    assert.deepEqual(json.conflicts, ["该模型不支持温度设置，写作温度不会生效。"]);
    // 切换落盘完成：应用私有 workspace settings 已指向 no-temp 模型
    const store = createWorkspaceStore({ stateRoot: path.join(root, ".state") });
    const settings = await store.loadSettings(projectRoot);
    assert.deepEqual(settings.active_model, { provider_id: "pv_no_temp", model_id: "m_no_temp" });
  } finally {
    await closeServer(server);
  }
});

test("切换模型：项目未配置温度时 conflicts 为空数组", async () => {
  registerProviderCapabilityResolver(
    (c) => String(c.base_url ?? "").includes("no-temp.example"),
    () => ({ supportsTemperature: false })
  );
  const { projectRoot, secretsRoot, server, port } = await setupServerWithProject();
  try {
    // 默认项目模型未配置 temperature：切 no-temp 模型不应报冲突
    await writeStoreProvider(secretsRoot, {
      id: "pv_no_temp", name: "no-temp", type: "custom", status: "enabled",
      base_url: "https://no-temp.example", api_format: "openai-chat-completions", api_key_env: "NO_TEMP_API_KEY",
      models: [{ id: "m_no_temp", model_name: "no-temp", enabled: true }]
    });
    const { status, json } = await post(port, "/api/settings/model-switch", {
      projectRoot,
      provider_id: "pv_no_temp",
      model_id: "m_no_temp"
    });
    assert.equal(status, 200);
    assert.equal(json.capabilities.supportsTemperature, false);
    assert.deepEqual(json.conflicts, []);
  } finally {
    await closeServer(server);
  }
});

// 任务 5 Step 1：普通目录（无 project.yaml）的模型配置写入应用私有 workspace
// settings，绝不创建 project.yaml；旧项目的 project.yaml 只作兼容输入。
test("普通目录使用应用私有 active_model，不创建 project.yaml", async () => {
  const { root, projectRoot, stateRoot, server, port } = await setupPlainWorkspace();
  try {
    const ds = await fetchPresetModel(port, "deepseek");
    const switched = await post(port, "/api/settings/model-switch", {
      projectRoot,
      provider_id: ds.providerId,
      model_id: ds.modelId
    });
    assert.equal(switched.status, 200);
    const store = createWorkspaceStore({ stateRoot });
    assert.deepEqual(
      (await store.loadSettings(projectRoot)).active_model,
      { provider_id: ds.providerId, model_id: ds.modelId }
    );
    assert.equal(await pathExists(path.join(projectRoot, "project.yaml")), false);
  } finally {
    await closeServer(server);
  }
});

// 任务 5 Step 5：model-switch 写应用私有 settings，不再双写 project.yaml。
test("普通目录模型切换后 project.yaml 不存在，设置只落应用私有 settings", async () => {
  const { root, projectRoot, stateRoot, server, port } = await setupPlainWorkspace();
  try {
    const ds = await fetchPresetModel(port, "deepseek");
    const switched = await post(port, "/api/settings/model-switch", {
      projectRoot,
      provider_id: ds.providerId,
      model_id: ds.modelId
    });
    assert.equal(switched.status, 200);
    // 项目目录始终干净：无 project.yaml、无 .wwriting
    assert.equal(await pathExists(path.join(projectRoot, "project.yaml")), false);
    assert.equal(await pathExists(path.join(projectRoot, ".wwriting")), false);
    // settings.json 位于应用私有目录
    const store = createWorkspaceStore({ stateRoot });
    const settings = await store.loadSettings(projectRoot);
    assert.deepEqual(settings.active_model, { provider_id: ds.providerId, model_id: ds.modelId });
  } finally {
    await closeServer(server);
  }
});

// Task 16：model-switch 引用形态——{ provider_id, model_id } 校验 v2 清单可用+启用后
// 写项目引用到应用私有 settings；响应带 active_model（引用）且不再返回旧
// available_models/model_profile 字段。
test("model-switch 引用形态：写项目引用，响应去掉旧清单字段", async () => {
  const { root, projectRoot, stateRoot, server, port } = await setupPlainWorkspace();
  try {
    // 触发预设种子（deepseek/mimo 两级清单落盘 v2 store）
    const listRes = await fetch(`http://127.0.0.1:${port}/api/settings/providers`);
    const listJson = await listRes.json();
    const deepseek = listJson.providers.find((p) => p.id === "deepseek");
    assert.ok(deepseek?.models?.length > 0, "预设供应商应含模型");
    const model = deepseek.models[0];

    const switched = await post(port, "/api/settings/model-switch", {
      projectRoot,
      provider_id: deepseek.id,
      model_id: model.id
    });
    assert.equal(switched.status, 200);
    assert.equal(switched.json.ok, true);
    assert.deepEqual(switched.json.active_model, { provider_id: deepseek.id, model_id: model.id });
    assert.equal(switched.json.available_models, undefined, "引用形态响应不再返回旧 available_models");
    assert.equal(switched.json.model_profile, undefined, "引用形态响应不再返回旧 model_profile");
    // 项目引用写入应用私有 settings（运行时按 modelStoreLoader 解析为完整配置）
    const store = createWorkspaceStore({ stateRoot });
    const settings = await store.loadSettings(projectRoot);
    assert.deepEqual(settings.active_model, { provider_id: deepseek.id, model_id: model.id }, "项目 active_model 为引用形态");
  } finally {
    await closeServer(server);
  }
});

test("model-switch 引用形态：悬空引用 404、停用模型 400", async () => {
  const { root, projectRoot, server, port } = await setupPlainWorkspace();
  try {
    const listRes = await fetch(`http://127.0.0.1:${port}/api/settings/providers`);
    const listJson = await listRes.json();
    const deepseek = listJson.providers.find((p) => p.id === "deepseek");
    const model = deepseek.models[0];

    // 悬空供应商引用 → 404 model_profile_not_found
    const ghost = await post(port, "/api/settings/model-switch", {
      projectRoot,
      provider_id: "pv_ghost",
      model_id: model.id
    });
    assert.equal(ghost.status, 404);
    assert.equal(ghost.json.code, "model_profile_not_found");

    // 停用模型 → 400 model_disabled（与「设为默认」的停用门禁一致）。模型 id 可能
    // 含 URL 保留字符（如 v1 迁移条目 deepseek-chat@https://api.deepseek.com），
    // 路径参数须 URL 编码。
    const disable = await fetch(
      `http://127.0.0.1:${port}/api/settings/providers/${encodeURIComponent(deepseek.id)}/models/${encodeURIComponent(model.id)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false })
      }
    );
    assert.equal(disable.status, 200);
    const disabled = await post(port, "/api/settings/model-switch", {
      projectRoot,
      provider_id: deepseek.id,
      model_id: model.id
    });
    assert.equal(disabled.status, 400);
    assert.equal(disabled.json.code, "model_disabled");
  } finally {
    await closeServer(server);
  }
});

// Task 6：/api/dashboard 直接返回当前项目的会话列表（前端左侧栏渲染对话列表，
// 免去先拉 project list 再逐项目拉 sessions）。品牌新项目 → 空列表；submit 一条后
// → sessions 长度 1 且 active_session_id 指向该会话。
test("dashboard 返回会话列表与最近活跃会话", async () => {
  const { projectRoot, server, port } = await setupServerWithProject();
  try {
    const before = await fetch(`http://127.0.0.1:${port}/api/dashboard?projectRoot=${encodeURIComponent(projectRoot)}`);
    const beforeJson = await before.json();
    assert.equal(before.status, 200);
    assert.equal(beforeJson.hasProject, true);
    assert.deepEqual(beforeJson.sessions, []);
    assert.equal(beforeJson.active_session_id, null);

    const input = await post(port, "/api/agent/input", { projectRoot, text: "你好" });
    assert.equal(input.status, 200);
    assert.equal(typeof input.json.session_id, "string", "缺省 input 惰性创建会话");

    const dashboard = await waitForDashboardSessions(port, projectRoot, (sessions) => sessions.length === 1);
    assert.equal(dashboard.sessions[0].session_id, input.json.session_id);
    assert.equal(dashboard.active_session_id, input.json.session_id, "最近活跃会话指向刚提交的会话");
  } finally {
    await closeServer(server);
  }
});
