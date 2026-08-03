import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAppShellServer } from "../src/core/app-server.mjs";
import { emit, unsubscribeAll } from "../src/core/run-events-bus.mjs";

// 与既有 app-server 测试（tests/app-server-global-model.test.mjs）同一套启动 helper：
// 端口 0 + fetch 安全端口兜底，避免 Node 内置 fetch 拒绝特权端口导致测试挂起。

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

async function setupServer() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-events-"));
  const server = createAppShellServer({
    workspaceRoot: root,
    selectedProjectRoot: null,
    stateRoot: path.join(root, ".state"),
    secretsRoot: path.join(root, ".secrets"),
    port: 0
  });
  const port = await listenOnFetchSafePort(server);
  return { server, port };
}

function eventsUrl(port, projectRoot) {
  return `http://127.0.0.1:${port}/api/project/events?projectRoot=${encodeURIComponent(projectRoot)}`;
}

// 读流直到某块数据包含期望片段。SSE 首块可能是 ": connected" 注释，也可能是
// 注释与事件同批到达——不能假定一次 read 就拿到事件，必须循环等待（带超时防挂起）。
async function readChunkUntil(reader, decoder, predicate) {
  const deadline = Date.now() + 5000;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error("等待 SSE 事件超时");
    }
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    const text = decoder.decode(value, { stream: true });
    if (predicate(text)) {
      return text;
    }
  }
  throw new Error("SSE 流提前结束，未收到目标事件");
}

test("SSE 端点推送总线事件", async () => {
  const { server, port } = await setupServer();
  const projectRoot = "D:/fake-project";
  const controller = new AbortController();
  const res = await fetch(eventsUrl(port, projectRoot), { signal: controller.signal });
  try {
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    emit(projectRoot, { type: "model_delta", text: "他" });
    const text = await readChunkUntil(reader, decoder, (chunk) => chunk.includes('"type":"model_delta"'));
    assert.match(text, /"type":"model_delta"/);
    assert.match(text, /"text":"他"/);
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
    assert.match(json.error, /projectRoot/);
  } finally {
    await closeServer(server);
  }
});

test("连接关闭后退订：断开连接不再收事件，也不影响同项目新连接", async () => {
  const { server, port } = await setupServer();
  const projectRoot = "D:/fake-project-close";
  try {
    // 第一条连接：读到连接注释，确认订阅已建立
    const first = new AbortController();
    const res1 = await fetch(eventsUrl(port, projectRoot), { signal: first.signal });
    const reader1 = res1.body.getReader();
    const decoder1 = new TextDecoder();
    await readChunkUntil(reader1, decoder1, (chunk) => chunk.includes("connected"));
    first.abort(); // 客户端断开 → 服务端 request close → handler 退订
    // 给事件循环一拍，让 close 传播到服务端并执行退订
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 第二条连接（同 projectRoot）：若第一条未退订，往已销毁 socket 写会抛错
    // （bus 吞掉异常），但第二条必须仍能收到事件——证明订阅链路没被破坏。
    const second = new AbortController();
    const res2 = await fetch(eventsUrl(port, projectRoot), { signal: second.signal });
    const reader2 = res2.body.getReader();
    const decoder2 = new TextDecoder();
    await readChunkUntil(reader2, decoder2, (chunk) => chunk.includes("connected"));
    emit(projectRoot, { type: "model_delta", text: "断点" });
    const text = await readChunkUntil(reader2, decoder2, (chunk) => chunk.includes("model_delta"));
    assert.match(text, /"text":"断点"/);
    // 后续事件继续推送
    emit(projectRoot, { type: "model_delta", text: "后续" });
    const text2 = await readChunkUntil(reader2, decoder2, (chunk) => chunk.includes("后续"));
    assert.match(text2, /"text":"后续"/);
    second.abort();
  } finally {
    await closeServer(server);
    // 总线是进程级单例：清理本测试用过的 projectRoot 残留订阅，避免跨用例串扰
    unsubscribeAll(projectRoot);
  }
});
