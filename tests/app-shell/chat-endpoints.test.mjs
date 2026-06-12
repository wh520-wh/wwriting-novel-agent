// /api/chat/send + /api/chat/confirm + /api/chat/history 端到端
// 验收点：
//   - POST /api/chat/send 接受 { message }，返回完整 JSON（非 SSE）
//   - GET  /api/chat/history 返回历史 + pendingAction
//   - POST /api/chat/confirm 接受 { approve }，处理 pending action
//   - 每个 turn 结束后 cost.json 写入
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAppShellServer } from "../../src/core/app-server.mjs";
import { createProject } from "../../src/core/project-store.mjs";
import { savePendingAction } from "../../src/core/chat/chat-store.mjs";

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
    await new Promise((resolve) => server.close(resolve));
  }
  throw new Error("Could not allocate a fetch-safe test port");
}

async function setupServer() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-chat-endpoints-"));
  const { projectRoot } = await createProject(root, {
    slug: "chat-ep",
    target_chapters: 3,
    min_words_per_chapter: 300,
    target_words_per_chapter: 360
  });
  const stateRoot = path.join(root, ".state");
  const secretsRoot = path.join(root, ".secrets");
  const server = createAppShellServer({
    workspaceRoot: root,
    selectedProjectRoot: projectRoot,
    stateRoot,
    secretsRoot,
    port: 0
  });
  const port = await listenOnFetchSafePort(server);
  return { root, projectRoot, stateRoot, secretsRoot, server, port };
}

function closeServer(server) {
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
  const data = await res.json();
  return { res, data };
}

test("POST /api/chat/send 缺 message 返回 400", async () => {
  const ctx = await setupServer();
  try {
    const { res, data } = await postJson(ctx.port, "/api/chat/send", {});
    assert.equal(res.status, 400);
    assert.equal(data.ok, false);
    assert.match(data.message ?? "", /消息/);
  } finally {
    await closeServer(ctx.server);
  }
});

test("POST /api/chat/send 与 GET /api/chat/history 端到端：mock 模型返回文本，cost 入账", async () => {
  const ctx = await setupServer();
  try {
    const post = await postJson(ctx.port, "/api/chat/send", { message: "进度如何？" });
    assert.equal(post.res.status, 200);
    assert.equal(post.data.ok, true);
    assert.equal(typeof post.data.reply, "string");
    assert.ok(post.data.reply.length > 0, "reply 应为非空字符串");
    // usage 字段由 chat-agent 给出
    assert.ok(post.data.usage, "应返回 usage 摘要");
    assert.equal(typeof post.data.usage.calls, "number");

    // cost.json 已落账
    const costPath = path.join(ctx.projectRoot, "cost.json");
    const costStat = await fs.stat(costPath);
    assert.ok(costStat.isFile(), "cost.json 应在 send 后存在");
    const costData = JSON.parse(await fs.readFile(costPath, "utf8"));
    assert.ok(costData.calls >= 1, "应至少有一次模型调用入账");
    assert.ok(costData.byStage?.chat, "byStage 应包含 chat 阶段");

    // GET /api/chat/history
    const hist = await getJson(ctx.port, "/api/chat/history");
    assert.equal(hist.res.status, 200);
    assert.equal(hist.data.ok, true);
    // 至少 user 消息 + assistant 回复 = 2 条
    assert.ok(hist.data.messages.length >= 2, `历史应至少 2 条，实际 ${hist.data.messages.length}`);
    const roles = hist.data.messages.map((m) => m.role);
    assert.ok(roles.includes("user"), "应包含 user 消息");
    assert.ok(roles.includes("assistant"), "应包含 assistant 消息");
    // pendingAction 无写/控制类工具时为 null
    assert.equal(hist.data.pendingAction ?? null, null);
  } finally {
    await closeServer(ctx.server);
  }
});

test("GET /api/chat/history 支持 after / limit 参数", async () => {
  const ctx = await setupServer();
  try {
    await postJson(ctx.port, "/api/chat/send", { message: "第一条" });
    await postJson(ctx.port, "/api/chat/send", { message: "第二条" });

    const hist = await getJson(ctx.port, "/api/chat/history?limit=2");
    assert.equal(hist.res.status, 200);
    assert.equal(hist.data.ok, true);
    assert.ok(hist.data.messages.length <= 2, "limit=2 限制返回条数");

    // after 过滤：拿最后一条的 id 作为 after，应返回 0 条
    const allHist = await getJson(ctx.port, "/api/chat/history");
    const lastId = allHist.data.messages.at(-1)?.id;
    const afterHist = await getJson(ctx.port, `/api/chat/history?after=${encodeURIComponent(lastId)}`);
    assert.equal(afterHist.data.messages.length, 0, "after=最后一条 id 应返回 0 条");
  } finally {
    await closeServer(ctx.server);
  }
});

test("POST /api/chat/send 无项目时返回 400", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-chat-noproject-"));
  const stateRoot = path.join(root, ".state");
  const secretsRoot = path.join(root, ".secrets");
  const server = createAppShellServer({
    workspaceRoot: root,
    selectedProjectRoot: null,
    stateRoot,
    secretsRoot,
    port: 0
  });
  const port = await listenOnFetchSafePort(server);
  try {
    const { res, data } = await postJson(port, "/api/chat/send", { message: "hi" });
    assert.equal(res.status, 400);
    assert.equal(data.ok, false);
  } finally {
    await closeServer(server);
  }
});

test("并发两条 chat send 串行执行，历史不交错", async () => {
  const ctx = await setupServer();
  try {
    const [r1, r2] = await Promise.all([
      postJson(ctx.port, "/api/chat/send", { message: "并发一" }),
      postJson(ctx.port, "/api/chat/send", { message: "并发二" })
    ]);
    assert.equal(r1.res.status, 200);
    assert.equal(r2.res.status, 200);
    const hist = await getJson(ctx.port, "/api/chat/history");
    const roles = hist.data.messages.map((m) => m.role);
    // 串行证据：必须是 user,assistant,user,assistant（交错则为 user,user,assistant,assistant 等）
    assert.deepEqual(roles, ["user", "assistant", "user", "assistant"]);
  } finally {
    await closeServer(ctx.server);
  }
});

test("POST /api/chat/confirm approve=false：清 pending 并回填 user_rejected", async () => {
  const ctx = await setupServer();
  try {
    await savePendingAction(ctx.projectRoot, {
      tool: "edit_chapter",
      args: { chapter_no: 1, find: "六楼", replace: "十二楼", reason: "test" },
      preview: { ok: true, chapter_no: 1, before: "六楼", after: "十二楼" }
    });
    const { res, data } = await postJson(ctx.port, "/api/chat/confirm", { approve: false });
    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.pendingAction, null);
    const hist = await getJson(ctx.port, "/api/chat/history");
    const toolMsg = hist.data.messages.find((m) => m.role === "tool" && m.tool === "edit_chapter");
    assert.ok(toolMsg, "应有 tool 回填消息");
    assert.equal(toolMsg.ok, false);
    assert.match(toolMsg.result_summary ?? "", /user_rejected/u);
    assert.equal(hist.data.pendingAction ?? null, null, "pending 应被清除");
  } finally {
    await closeServer(ctx.server);
  }
});

test("POST /api/chat/confirm 无 pending 时友好返回", async () => {
  const ctx = await setupServer();
  try {
    const { res, data } = await postJson(ctx.port, "/api/chat/confirm", { approve: true });
    assert.equal(res.status, 200);
    assert.match(data.reply ?? "", /没有待确认/u);
  } finally {
    await closeServer(ctx.server);
  }
});

test("dashboard 透出 tool_permissions 与 archived_at", async () => {
  const ctx = await setupServer();
  try {
    const { data } = await getJson(ctx.port, "/api/dashboard");
    assert.equal(data.project.archived_at, null);
    assert.equal(typeof data.project.tool_permissions, "object");
    assert.equal(data.project.tool_permissions.read_only, false);
  } finally { await closeServer(ctx.server); }
});
