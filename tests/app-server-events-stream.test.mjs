import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAppShellServer } from "../src/core/app-server.mjs";
import { createProject } from "../src/core/project-store.mjs";

// 与既有 app-server 测试（tests/app-server-global-model.test.mjs）同一套启动 helper：
// 端口 0 + fetch 安全端口兜底，避免 Node 内置 fetch 拒绝特权端口导致测试挂起。

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

function closeServer(server) {
  if (typeof server.closeAllConnections === "function") {
    server.closeAllConnections();
  }
  return new Promise((resolve) => server.close(resolve));
}

async function setupServer() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-events-"));
  const { projectRoot } = await createProject(root, { slug: "project" });
  const server = createAppShellServer({
    workspaceRoot: root,
    selectedProjectRoot: null,
    stateRoot: path.join(root, ".state"),
    secretsRoot: path.join(root, ".secrets"),
    port: 0
  });
  const port = await listenOnFetchSafePort(server);
  return { server, port, projectRoot };
}

function eventsUrl(port, projectRoot) {
  return `http://127.0.0.1:${port}/api/project/events?projectRoot=${encodeURIComponent(projectRoot)}`;
}

// 增量累积读取直到谓词满足：流空闲时 read() 会一直挂起，必须用定时器竞速才能
// 可靠超时（跨 chunk 匹配也依赖累积，事件可能分多个 SSE 块到达）。
async function readChunkUntil(reader, decoder, predicate) {
  const deadline = Date.now() + 8000;
  let accumulated = "";
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`等待 SSE 事件超时（已累积: ${accumulated.slice(0, 120)}）`);
    }
    const result = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), remaining))
    ]);
    if (result?.done) {
      break;
    }
    if (result?.value) {
      accumulated += decoder.decode(result.value, { stream: true });
      if (predicate(accumulated)) {
        return accumulated;
      }
    }
  }
  throw new Error("SSE 流提前结束，未收到目标事件");
}

async function postJson(port, route, body) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { res, data: await res.json() };
}

test("SSE 端点推送 journal 事件（唯一 Agent 实时流）", async () => {
  const { server, port, projectRoot } = await setupServer();
  const controller = new AbortController();
  const res = await fetch(eventsUrl(port, projectRoot), { signal: controller.signal });
  try {
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    await readChunkUntil(reader, decoder, (chunk) => chunk.includes("connected"));
    // 触发一次 Agent 活动：journal 事件应出现在流上
    const { res: inputRes, data } = await postJson(port, "/api/agent/input", { projectRoot, text: "你好" });
    assert.equal(inputRes.status, 200);
    const text = await readChunkUntil(reader, decoder, (chunk) =>
      chunk.includes('"type":"input_queued"') && chunk.includes('"type":"run_started"')
    );
    assert.match(text, /"type":"input_queued"/);
    assert.match(text, /"type":"run_started"/);
    assert.ok(data.ok, "agent input should be accepted");
  } finally {
    controller.abort();
    await closeServer(server);
  }
});

test("缺少 projectRoot 参数返回 400", async () => {
  const { server, port } = await setupServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/project/events`);
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.ok, false);
    assert.match(json.message, /projectRoot/);
  } finally {
    await closeServer(server);
  }
});

test("连接关闭后重连仍可收到事件", async () => {
  const { server, port, projectRoot } = await setupServer();
  try {
    // 第一条连接：读到连接注释后断开
    const first = new AbortController();
    const res1 = await fetch(eventsUrl(port, projectRoot), { signal: first.signal });
    const reader1 = res1.body.getReader();
    const decoder1 = new TextDecoder();
    await readChunkUntil(reader1, decoder1, (chunk) => chunk.includes("connected"));
    first.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 第二条连接（同 projectRoot）：仍能收到新事件
    const second = new AbortController();
    const res2 = await fetch(eventsUrl(port, projectRoot), { signal: second.signal });
    const reader2 = res2.body.getReader();
    const decoder2 = new TextDecoder();
    await readChunkUntil(reader2, decoder2, (chunk) => chunk.includes("connected"));
    await postJson(port, "/api/agent/input", { projectRoot, text: "第二条连接的消息" });
    const text = await readChunkUntil(reader2, decoder2, (chunk) => chunk.includes("input_queued"));
    assert.match(text, /"type":"input_queued"/);
    second.abort();
  } finally {
    await closeServer(server);
  }
});
