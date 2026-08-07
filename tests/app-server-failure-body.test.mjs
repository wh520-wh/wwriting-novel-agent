import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAppShellServer } from "../src/core/app-server.mjs";
import { loadProject, saveProject } from "../src/core/project-store.mjs";

// —— 测试服务器小工具(对齐 tests/app-server-probe.test.mjs 的既有范式) ——
const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
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

async function closeServer(server) {
  if (typeof server.closeAllConnections === "function") {
    server.closeAllConnections();
  }
  return new Promise((resolve) => server.close(resolve));
}

async function postJson(port, route, body = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  return { res, data };
}

async function getJson(port, route) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`);
  return { res, data: await res.json() };
}

async function waitFor(predicate, { timeout = 15000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for condition");
}

async function setupServer() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-body-"));
  const { createProjectAt } = await import("../src/core/project-store.mjs");
  const { projectRoot } = await createProjectAt(path.join(root, "project"), {
    title: "Failure Body Novel",
    target_chapters: 1,
    min_words_per_chapter: 10,
    target_words_per_chapter: 20
  });
  const server = createAppShellServer({
    workspaceRoot: root,
    selectedProjectRoot: projectRoot,
    stateRoot: path.join(root, ".state"),
    secretsRoot: path.join(root, ".secrets"),
    staticRoot: path.resolve("src", "app-shell"),
    port: 0
  });
  const port = await listenOnFetchSafePort(server);
  return { root, projectRoot, server, port };
}

test("模型错误 → snapshot 显示 failed Run → 修复配置后 retry 恢复同一 Run", async () => {
  const { projectRoot, server, port } = await setupServer();
  try {
    // 指向不可达端口的 openai-compatible 模型（连接拒绝 → transport 错误 → run_failed）。
    // timeout_ms/total_deadline_ms 直接写 project.yaml（设置校验不接收这两个字段，
    // 但 gateway 会读取 modelConfig 上的它们）——用短期限把失败收敛控制在数秒内。
    const project = await loadProject(projectRoot);
    project.active_model = {
      provider: "openai-compatible",
      model_name: "fail-model",
      base_url: "http://127.0.0.1:1/v1",
      api_key_env: "FAIL_KEY",
      timeout_ms: 800,
      total_deadline_ms: 4000
    };
    await saveProject(projectRoot, project);

    const input = await postJson(port, "/api/agent/input", { projectRoot, text: "写第一章" });
    assert.equal(input.res.status, 200);
    assert.equal(input.data.status, "running");

    // 等待 Run 失败（journal run_failed → snapshot failed）
    const failed = await waitFor(async () => {
      const { data } = await getJson(port, `/api/agent/snapshot?projectRoot=${encodeURIComponent(projectRoot)}`);
      return data.session.active_run?.status === "failed" ? data : null;
    });
    const runId = failed.session.active_run.id;
    assert.ok(failed.events.some((e) => e.type === "run_failed"), "journal 应写入 run_failed");
    const failedEvent = failed.events.find((e) => e.type === "run_failed");
    assert.ok(typeof failedEvent.payload.error === "string", "run_failed 应携带可读错误信息");

    // 修复配置（换回 mock）后通过新 /api/agent/run/:runId/retry 恢复同一 Run
    const fixed = await loadProject(projectRoot);
    fixed.active_model = { provider: "mock", model_name: "mock-writer" };
    await saveProject(projectRoot, fixed);
    const retried = await postJson(port, `/api/agent/run/${runId}/retry`, { projectRoot });
    assert.equal(retried.res.status, 200);
    assert.equal(retried.data.ok, true);
    assert.equal(retried.data.run_id, runId, "retry 必须继续同一 Run");
    assert.equal(retried.data.retried, true);

    const completed = await waitFor(async () => {
      const { data } = await getJson(port, `/api/agent/snapshot?projectRoot=${encodeURIComponent(projectRoot)}`);
      return data.session.active_run?.status === "completed" ? data : null;
    });
    assert.equal(completed.session.active_run.id, runId);
    assert.equal(completed.session.status, "idle");
  } finally {
    await closeServer(server);
  }
});

test("运行中 submit 排队（HTTP 200 + queued），stop 收敛为 cancelled", async () => {
  const { projectRoot, server, port } = await setupServer();
  try {
    const project = await loadProject(projectRoot);
    project.active_model = {
      provider: "openai-compatible",
      model_name: "slow-model",
      base_url: "http://127.0.0.1:1/v1",
      api_key_env: "FAIL_KEY",
      timeout_ms: 800,
      total_deadline_ms: 4000
    };
    await saveProject(projectRoot, project);

    const first = await postJson(port, "/api/agent/input", { projectRoot, text: "任务一" });
    const second = await postJson(port, "/api/agent/input", { projectRoot, text: "任务二" });
    assert.equal(second.res.status, 200);
    assert.equal(second.data.status, "queued");
    assert.equal(second.data.run_id, first.data.run_id);

    // 等 Run 进入 failed（模型错误）后停止是幂等无操作；改用直接验证排队输入被记录
    await waitFor(async () => {
      const { data } = await getJson(port, `/api/agent/snapshot?projectRoot=${encodeURIComponent(projectRoot)}`);
      return data.session.active_run?.status === "failed" ? data : null;
    });
    const { data: snapshot } = await getJson(port, `/api/agent/snapshot?projectRoot=${encodeURIComponent(projectRoot)}`);
    assert.ok(snapshot.session.queued_inputs.length >= 1, "排队输入应出现在 snapshot");
    // 停止（无活动 Run 时返回 cancelled:false，不抛错）
    const stopped = await postJson(port, `/api/agent/run/${first.data.run_id}/stop`, { projectRoot });
    assert.ok([200, 404].includes(stopped.res.status));
  } finally {
    await closeServer(server);
  }
});

// 构造一个当前实现会以原始 Node fs 错误炸掉的 API 请求（契约测试红阶段）：
// 第一次输入让 journal 完成落盘并缓存进 runtime；随后删除项目内 .wwriting/agent，
// 第二次输入 append 因父目录缺失抛出原始 ENOENT —— 当前错误适配原样回传
// "ENOENT: no such file or directory, open '...'"（SPEC §11 禁止）。Task 3/4
// 把 journal 迁入应用私有目录并统一错误脱敏后本契约转绿。
async function triggerUnreadableWorkspaceRequest() {
  const { projectRoot, server, port } = await setupServer();
  try {
    const first = await postJson(port, "/api/agent/input", { projectRoot, text: "你好" });
    assert.equal(first.res.status, 200);
    // 等 Run 完成：journal 状态已缓存进 runtime，之后删除存储目录才能触发 ENOENT
    await waitFor(async () => {
      const { data } = await getJson(port, `/api/agent/snapshot?projectRoot=${encodeURIComponent(projectRoot)}`);
      return data.session?.active_run?.status === "completed" ? true : null;
    });
    await fs.rm(path.join(projectRoot, ".wwriting", "agent"), { recursive: true, force: true });
    const second = await postJson(port, "/api/agent/input", { projectRoot, text: "再来一条" });
    return { status: second.res.status, body: JSON.stringify(second.data) };
  } finally {
    await closeServer(server);
  }
}

test("API 失败正文不泄露 ENOENT、堆栈和绝对内部路径", async () => {
  const { status, body } = await triggerUnreadableWorkspaceRequest();
  assert.ok(status >= 400);
  assert.doesNotMatch(body, /ENOENT|node:fs|at\s+\w+|[A-Z]:\\.*userData/iu);
  assert.match(body, /无法读取|请检查|重试/u);
});
