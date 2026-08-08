import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAppShellServer } from "../src/core/app-server.mjs";
import { loadProject, saveProject } from "../src/core/project-store.mjs";
import { workspaceIdForPath } from "../src/core/workspaces/store.mjs";
import { publicErrorMessage, safePublicErrorCode } from "../src/core/http-error.mjs";

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

// SSE 累积读取直到 predicate 命中（镜像 app-server-events-stream.test.mjs 的范式）。
async function readChunkUntil(reader, decoder, predicate) {
  let buffer = "";
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    if (predicate(buffer)) return buffer;
  }
  throw new Error("Timed out waiting for SSE condition");
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
  const stateRoot = path.join(root, ".state");
  const server = createAppShellServer({
    workspaceRoot: root,
    selectedProjectRoot: projectRoot,
    stateRoot,
    secretsRoot: path.join(root, ".secrets"),
    staticRoot: path.resolve("src", "app-shell"),
    port: 0
  });
  const port = await listenOnFetchSafePort(server);
  return { root, projectRoot, server, port, stateRoot };
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
      // 计划修复（整支审阅）：submit 前的惰性 open 使第二条 submit 的到达时间晚于
      // 原先；若 api_key 缺失，resolveApiKey 在首次模型轮同步抛配置错误，第一条
      // Run 毫秒级终结，排队断言退化为竞态。显式给 api_key → 连接拒绝成为可重试
      // 的 transport 错误（指数退避），Run 在排队窗口内保持非终结，断言确定。
      api_key: "sk-test-refused",
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
// 第一次输入让 journal 完成落盘并缓存进 runtime；随后破坏应用私有 agent 目录
//（Task 3/4 起 journal 位于 <stateRoot>/workspaces/<ws_id>/agent，不再是项目内
// .wwriting/agent），第二次输入 append 因存储不可写抛出原始错误 —— 统一错误
// 脱敏后响应正文不得泄露 ENOENT/绝对路径/堆栈（SPEC §11）。
//
// 计划修复（整支审阅）：submit 前的惰性 open 会经 runLegacyImport 的
// writeMigration 重建被整体删除的私有目录（writeJsonAtomic → ensureDir），纯删除
// 不再触发 ENOENT。改用同名文件占位：open 的 ensureDir 对已存在文件抛 EEXIST（被
// open 兜底吞掉），随后 submit 的 append 对"父路径是文件"抛 ENOTDIR → 错误路径
// 确定性触发且存储不可重建。
async function triggerUnreadableWorkspaceRequest() {
  const { projectRoot, server, port, stateRoot } = await setupServer();
  try {
    const first = await postJson(port, "/api/agent/input", { projectRoot, text: "你好" });
    assert.equal(first.res.status, 200);
    // 等 Run 完成：journal 状态已缓存进 runtime，之后破坏存储目录才能触发 fs 错误
    await waitFor(async () => {
      const { data } = await getJson(port, `/api/agent/snapshot?projectRoot=${encodeURIComponent(projectRoot)}`);
      return data.session?.active_run?.status === "completed" ? true : null;
    });
    const privateAgentDir = path.join(stateRoot, "workspaces", workspaceIdForPath(projectRoot), "agent");
    await fs.rm(privateAgentDir, { recursive: true, force: true });
    await fs.writeFile(privateAgentDir, "storage-blocked", "utf8");
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

test("SSE 错误事件 data 行同样脱敏：不泄露原始 fs 错误与内部路径", async () => {
  // 评审 Critical：GET /api/project/events 的快照轮询失败路径原样写
  // `error?.message`/`error?.code` 进 data 行，原始 Node fs 错误（绝对内部路径）
  // 会随 data: 离开服务器。这里把 events segment 替换成同名目录 → journal.read 的
  // segment 读取抛原始 EISDIR（syscall=read），验证 data 行只含脱敏后的 message/code。
  const { projectRoot, server, port, stateRoot } = await setupServer();
  const controller = new AbortController();
  try {
    const first = await postJson(port, "/api/agent/input", { projectRoot, text: "你好" });
    assert.equal(first.res.status, 200);
    await waitFor(async () => {
      const { data } = await getJson(port, `/api/agent/snapshot?projectRoot=${encodeURIComponent(projectRoot)}`);
      return data.session?.active_run?.status === "completed" ? true : null;
    });
    const eventsPath = path.join(
      stateRoot,
      "workspaces",
      workspaceIdForPath(projectRoot),
      "agent",
      "segments",
      "events",
      "00000001.jsonl"
    );
    await fs.access(eventsPath); // journal 已落盘

    // 让工作区私有存储变为不可读：events segment → 同名目录（跨平台确定性触发
    // EISDIR）。分段 store 只在真正读取 segment 时才触碰文件（空闲轮询返回空页
    // 不读盘），因此先破坏存储、再以 afterSeq=0 打开 SSE——首次轮询必然读取坏段。
    await fs.rm(eventsPath, { force: true });
    await fs.mkdir(eventsPath);

    const res = await fetch(`http://127.0.0.1:${port}/api/project/events?projectRoot=${encodeURIComponent(projectRoot)}`, {
      signal: controller.signal
    });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    await readChunkUntil(reader, decoder, (chunk) => chunk.includes("connected"));

    const block = await readChunkUntil(reader, decoder, (chunk) => chunk.includes("event: error"));

    // 流里只应有 connected + error；event: error 后的最后一条 data: 才是错误事件。
    const dataLines = block.split("\n").filter((line) => line.startsWith("data:"));
    assert.ok(dataLines.length >= 1, "应至少推送一条 data: 行");
    const dataLine = dataLines[dataLines.length - 1];
    const payload = JSON.parse(dataLine.slice(5).trim());
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "INTERNAL_ERROR", "EISDIR 属 Node 系统码，必须收敛为 INTERNAL_ERROR");
    assert.match(payload.message, /操作未完成|重试/u, "message 应使用 publicErrorMessage 的脱敏文案");
    assert.doesNotMatch(
      dataLine,
      /EISDIR|ENOENT|EACCES|EPERM|ENOTDIR|node:fs|at\s+\w+|userData|workspaces/iu,
      "SSE data 行不得含原始 fs 错误文本或内部绝对路径"
    );
  } finally {
    controller.abort();
    await closeServer(server);
  }
});

test("带数字的 errno 码（如 E2BIG）同样收敛为 INTERNAL_ERROR", () => {
  // 评审 Minor：NODE_ERROR_CODE_RE 的 E[A-Z]+ 漏掉 E2BIG 这类带数字的 errno 码，
  // 会以 "code":"E2BIG" 暴露。修复后任何 E<digit>… 系统码都收敛。
  const e2big = new Error("E2BIG: argument list too long");
  e2big.code = "E2BIG";
  assert.equal(safePublicErrorCode(e2big), "INTERNAL_ERROR");
  assert.equal(publicErrorMessage(e2big), "操作未完成，请重试；若问题持续，请打开诊断信息。");
});
