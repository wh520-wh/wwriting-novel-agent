import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAppShellServer } from "../src/core/app-server.mjs";
import { readEvents } from "../src/core/event-log.mjs";
import { createProject } from "../src/core/project-store.mjs";
import { ProviderTransportError } from "../src/core/provider-adapters.mjs";

// —— 测试服务器小工具(对齐 tests/app-server-probe.test.mjs 的既有范式) ——
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

async function waitFor(predicate, { timeout = 3000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}

async function setupServer() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-body-"));
  const { projectRoot } = await createProject(root, {
    slug: "project", target_chapters: 1, min_words_per_chapter: 300, target_words_per_chapter: 360
  });
  async function testRunProject() {
    // 模拟 DeepSeek 400:client-fatal ProviderTransportError(body 保留)
    throw new ProviderTransportError("OpenAI-compatible provider returned HTTP 400.", {
      status: 400,
      body: '{"error":{"message":"Invalid tool_calls","type":"invalid_request_error"}}',
      reason: "client-fatal"
    });
  }
  const server = createAppShellServer({
    workspaceRoot: root,
    selectedProjectRoot: projectRoot,
    stateRoot: path.join(root, ".state"),
    secretsRoot: path.join(root, ".secrets"),
    staticRoot: path.resolve("src", "app-shell"),
    port: 0,
    testRunProject
  });
  const port = await listenOnFetchSafePort(server);
  return { root, projectRoot, server, port };
}

test("project_run_failed 事件持久化 error.body/status/reason", async () => {
  const { projectRoot, server, port } = await setupServer();
  try {
    await postJson(port, "/api/commands/submit", { message: "写第1章" });
    // 事件由 startProjectRun 的 promise .catch 链异步写入,轮询等待
    const failed = await waitFor(async () => {
      const events = await readEvents(projectRoot);
      return events.find((e) => e.type === "project_run_failed") ?? null;
    });
    assert.equal(failed.data.status, 400, "data.status 应持久化");
    assert.equal(failed.data.reason, "client-fatal", "data.reason 应持久化");
    assert.ok(failed.data.body && failed.data.body.includes("Invalid tool_calls"),
      `data.body 应持久化 DeepSeek 错误正文,实际: ${failed.data.body}`);
  } finally {
    await closeServer(server);
  }
});
