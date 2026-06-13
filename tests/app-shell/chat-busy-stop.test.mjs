// tests/app-shell/chat-busy-stop.test.mjs
// busy 字段 / 并发 send 409 / stop 中断 / 空闲 stop 409。
// 关键约束：/api/chat/stop 绝不进项目锁（send 正持锁，入锁即死锁）。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAppShellServer } from "../../src/core/app-server.mjs";
import { createProject } from "../../src/core/project-store.mjs";

function slowChatClient(delayMs = 1200) {
  return {
    generate: ({ signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ text: "慢速回复完成。", usageReport: {}, costSummary: { estimatedCost: 0 } }), delayMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    }),
    costTracker: { writeProjectReport: async () => {} }
  };
}

async function setupServer(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-busy-"));
  const { projectRoot } = await createProject(root, {
    slug: "busy", title: "忙态测试", story_seed: "种子",
    target_chapters: 3, min_words_per_chapter: 10, target_words_per_chapter: 12
  });
  const server = createAppShellServer({
    workspaceRoot: root,
    selectedProjectRoot: projectRoot,
    stateRoot: path.join(root, ".state"),
    secretsRoot: path.join(root, ".secrets"),
    port: 0,
    ...options
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, projectRoot };
}

function closeServer(server) { return new Promise((resolve) => server.close(resolve)); }

async function postJson(port, route, body) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {})
  });
  return { res, data: await res.json() };
}

async function getJson(port, route) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`);
  return { res, data: await res.json() };
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

test("send 进行中 history.busy=true；结束后 false", async () => {
  const ctx = await setupServer({ testModel: { chatClient: () => slowChatClient(900) } });
  try {
    const sending = postJson(ctx.port, "/api/chat/send", { message: "慢问题" });
    await delay(250);
    const during = await getJson(ctx.port, "/api/chat/history");
    assert.equal(during.data.busy, true);
    assert.ok(during.data.busySince, "busySince 应为 ISO 时间串");
    await sending;
    const after = await getJson(ctx.port, "/api/chat/history");
    assert.equal(after.data.busy, false);
    assert.equal(after.data.busySince, null);
  } finally { await closeServer(ctx.server); }
});

test("忙时并发 send 返回 409，不排队", async () => {
  const ctx = await setupServer({ testModel: { chatClient: () => slowChatClient(900) } });
  try {
    const first = postJson(ctx.port, "/api/chat/send", { message: "第一条" });
    await delay(200);
    const second = await postJson(ctx.port, "/api/chat/send", { message: "第二条" });
    assert.equal(second.res.status, 409);
    assert.equal(second.data.ok, false);
    await first;
  } finally { await closeServer(ctx.server); }
});

test("stop 中断进行中的 send：响应 cancelled=true，历史落「（已停止。）」", async () => {
  const ctx = await setupServer({ testModel: { chatClient: () => slowChatClient(5000) } });
  try {
    const sending = postJson(ctx.port, "/api/chat/send", { message: "很慢的问题" });
    await delay(250);
    const stop = await postJson(ctx.port, "/api/chat/stop", {});
    assert.equal(stop.res.status, 200);
    const sent = await sending;
    assert.equal(sent.res.status, 200);
    assert.equal(sent.data.cancelled, true);
    const hist = await getJson(ctx.port, "/api/chat/history");
    assert.equal(hist.data.messages.at(-1).content, "（已停止。）");
    assert.equal(hist.data.busy, false);
  } finally { await closeServer(ctx.server); }
});

test("空闲时 stop 返回 409", async () => {
  const ctx = await setupServer();
  try {
    const stop = await postJson(ctx.port, "/api/chat/stop", {});
    assert.equal(stop.res.status, 409);
  } finally { await closeServer(ctx.server); }
});