// tests/http/agent-sessions-http.test.mjs —— Task 5：会话 CRUD 路由 + sessionId 贯通。
//
// 复用 Task 1 的 harness（真实 HTTP server + mock gateway），只经 router.mjs +
// agent-routes.mjs 访问 Agent 公共 seam。覆盖：
//   - sessions CRUD 全链路：缺省 input 惰性创建 → 列表 → POST 新建 → PATCH 改名/
//     归档/恢复 → DELETE 永久删除
//   - input 携带 sessionId 定向会话；缺省 input 惰性创建并返回 session_id
//   - GET /api/agent/snapshot?sessionId= 只读该会话事件流（互不串流）
//   - SSE ?sessionId= 只推送该会话事件（不混入其他会话事件）
//   - 错误映射：project_busy / session_busy → 409（code 可区分，前端分支依据）、
//     session_not_found → 404、invalid_session_id / invalid_session_title → 400
import assert from "node:assert/strict";
import test from "node:test";
import { createRouter } from "../../src/core/http/router.mjs";
import { createAgentRoutes } from "../../src/core/http/agent-routes.mjs";
import { startHttpServer } from "../helpers/http-test.mjs";
import {
  createProjectAgentHarness,
  sleep,
  waitForIdle
} from "../helpers/project-agent-harness.mjs";

// 组装 router + agent-routes，返回真实 HTTP server（与 agent-routes.test.mjs 同款）。
async function setupServer(t, options = {}) {
  const h = await createProjectAgentHarness(options);
  const router = createRouter();
  const server = await startHttpServer(t, {
    router,
    routeModules: [createAgentRoutes({ agent: h.agent })],
    afterClose: () => h.cleanup()
  });
  return { h, ...server };
}

// harness 只有 post/get；PATCH/DELETE 用原生 fetch。
async function patch(s, route, body = {}) {
  const res = await fetch(`${s.base}${route}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => null);
  return { res, data };
}

async function del(s, route) {
  const res = await fetch(`${s.base}${route}`, { method: "DELETE" });
  const data = await res.json().catch(() => null);
  return { res, data };
}

function sessionsUrl(root) {
  return `/api/agent/sessions?projectRoot=${encodeURIComponent(root)}`;
}

// ---------------------------------------------------------------------------
// sessions CRUD 全链路
// ---------------------------------------------------------------------------

test("sessions CRUD 全链路：惰性创建 → 列表 → 新建 → 改名 → 归档/恢复 → 删除", async (t) => {
  const s = await setupServer(t, { gatewayScript: [{ reply: { text: "好。" } }] });
  const root = s.h.projectRoot;

  // 品牌新项目：无会话、无最近活跃（惰性）
  const empty = await s.get(sessionsUrl(root));
  assert.equal(empty.res.status, 200);
  assert.equal(empty.data.ok, true);
  assert.deepEqual(empty.data.sessions, []);
  assert.equal(empty.data.active_session_id, null);

  // 缺省 input 惰性创建：响应必须返回 session_id
  const input = await s.post("/api/agent/input", { projectRoot: root, text: "你好" });
  assert.equal(input.res.status, 200);
  assert.equal(typeof input.data.session_id, "string", "缺省 input 返回 session_id（惰性创建）");
  const aId = input.data.session_id;
  await waitForIdle(s.h.agent, root);

  // 列表含 A 且 A 为最近活跃
  const list = await s.get(sessionsUrl(root));
  assert.equal(list.res.status, 200);
  assert.equal(list.data.ok, true);
  assert.equal(list.data.sessions.length, 1);
  assert.equal(list.data.sessions[0].session_id, aId);
  assert.equal(list.data.active_session_id, aId);

  // POST 新建 B（只写注册表条目）
  const created = await s.post("/api/agent/sessions", { projectRoot: root, title: "对话 B" });
  assert.equal(created.res.status, 200);
  assert.equal(created.data.ok, true);
  const b = created.data.session;
  assert.ok(b.session_id);
  assert.notEqual(b.session_id, aId);
  assert.equal(b.title, "对话 B");
  assert.equal(b.archived_at, null);

  // PATCH 改名
  const renamed = await patch(s, `/api/agent/sessions/${b.session_id}`, { projectRoot: root, title: "B 改名" });
  assert.equal(renamed.res.status, 200);
  assert.equal(renamed.data.ok, true);
  assert.equal(renamed.data.session.title, "B 改名");
  assert.equal(renamed.data.session.session_id, b.session_id);

  // PATCH 归档（archived:true）
  const archived = await patch(s, `/api/agent/sessions/${b.session_id}`, { projectRoot: root, archived: true });
  assert.equal(archived.res.status, 200);
  assert.ok(archived.data.session.archived_at, "归档写入 archived_at");
  assert.equal(archived.data.session.title, "B 改名", "归档不动 title");

  // 归档后列表仍含 B，但最近活跃回退到未归档的 A
  const afterArchive = await s.get(sessionsUrl(root));
  assert.equal(afterArchive.data.sessions.length, 2, "归档会话仍列出（调用方按需过滤）");
  assert.equal(afterArchive.data.active_session_id, aId, "唯一未归档的 A 成为最近活跃");

  // PATCH 恢复（archived:false）
  const restored = await patch(s, `/api/agent/sessions/${b.session_id}`, { projectRoot: root, archived: false });
  assert.equal(restored.res.status, 200);
  assert.equal(restored.data.session.archived_at, null, "恢复清空 archived_at");

  // DELETE 永久删除
  const deleted = await del(s, `/api/agent/sessions/${b.session_id}?projectRoot=${encodeURIComponent(root)}`);
  assert.equal(deleted.res.status, 200);
  assert.equal(deleted.data.ok, true);
  const afterDelete = await s.get(sessionsUrl(root));
  assert.equal(afterDelete.data.sessions.length, 1);
  assert.ok(
    !afterDelete.data.sessions.some((item) => item.session_id === b.session_id),
    "删除后列表不再含 B"
  );
});

// ---------------------------------------------------------------------------
// input 携带 sessionId 定向；snapshot?sessionId= 只读该会话
// ---------------------------------------------------------------------------

test("input 携带 sessionId 定向会话；snapshot?sessionId= 事件流互不串流", async (t) => {
  const s = await setupServer(t, {
    gatewayScript: [{ reply: { text: "A 答复" } }, { reply: { text: "B 答复" } }]
  });
  const root = s.h.projectRoot;

  const first = await s.post("/api/agent/input", { projectRoot: root, text: "给 A 的消息" });
  assert.equal(typeof first.data.session_id, "string", "缺省 input 惰性创建返回 session_id");
  const aId = first.data.session_id;
  await waitForIdle(s.h.agent, root);

  const created = await s.post("/api/agent/sessions", { projectRoot: root, title: "B" });
  const bId = created.data.session.session_id;

  const toB = await s.post("/api/agent/input", { projectRoot: root, text: "给 B 的消息", sessionId: bId });
  assert.equal(toB.res.status, 200);
  assert.equal(toB.data.session_id, bId, "显式 sessionId 提交返回该会话 id");
  await waitForIdle(s.h.agent, root);

  const snapA = await s.get(
    `/api/agent/snapshot?projectRoot=${encodeURIComponent(root)}&sessionId=${aId}&afterSeq=0&limit=10000`
  );
  assert.equal(snapA.res.status, 200);
  assert.equal(snapA.data.session.session_id, aId);
  const textsA = snapA.data.events.filter((e) => e.type === "input_queued").map((e) => e.payload.text);
  assert.deepEqual(textsA, ["给 A 的消息"], "A 的事件流不含 B 的输入");

  const snapB = await s.get(
    `/api/agent/snapshot?projectRoot=${encodeURIComponent(root)}&sessionId=${bId}&afterSeq=0&limit=10000`
  );
  const textsB = snapB.data.events.filter((e) => e.type === "input_queued").map((e) => e.payload.text);
  assert.deepEqual(textsB, ["给 B 的消息"], "B 的事件流不含 A 的输入");

  // 缺省 snapshot（不带 sessionId）= 最近活跃 = B
  const snapDefault = await s.get(`/api/agent/snapshot?projectRoot=${encodeURIComponent(root)}&afterSeq=0&limit=10000`);
  assert.equal(snapDefault.data.session.session_id, bId, "缺省快照切到最近活跃 B");
});

// ---------------------------------------------------------------------------
// SSE 按会话推送
// ---------------------------------------------------------------------------

test("SSE ?sessionId= 只推送该会话事件，不混入其他会话", async (t) => {
  const s = await setupServer(t, {
    gatewayScript: [
      { reply: { text: "A 首条答复" } },
      { reply: { text: "B 首条答复" } },
      { reply: { text: "A 新消息答复" } }
    ]
  });
  const root = s.h.projectRoot;

  const a = await s.post("/api/agent/input", { projectRoot: root, text: "A 首条" });
  const aId = a.data.session_id;
  await waitForIdle(s.h.agent, root);
  const b = await s.post("/api/agent/sessions", { projectRoot: root, title: "B" });
  const bId = b.data.session.session_id;
  await s.post("/api/agent/input", { projectRoot: root, text: "B 首条", sessionId: bId });
  await waitForIdle(s.h.agent, root);
  assert.notEqual(aId, bId);

  // 连会话 A 的流（afterSeq=0：先把 A 的历史全量推上来）
  const controller = new AbortController();
  const res = await fetch(
    `${s.base}/api/project/events?projectRoot=${encodeURIComponent(root)}&sessionId=${aId}&afterSeq=0`,
    { signal: controller.signal }
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/u);

  await s.post("/api/agent/input", { projectRoot: root, text: "推给 A 的新消息", sessionId: aId });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    if (buffer.includes("推给 A 的新消息")) break;
  }
  controller.abort();
  await reader.cancel().catch(() => {});
  await waitForIdle(s.h.agent, root);

  assert.match(buffer, /推给 A 的新消息/u, "SSE 应推送 A 的新事件");
  const dataLines = buffer
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)));
  assert.ok(dataLines.length > 0, "收到至少一条 data 帧");
  for (const event of dataLines) {
    assert.equal(event.session_id, aId, `SSE 只推送会话 A 的事件（收到 ${event.type} #${event.seq}）`);
  }
});

// ---------------------------------------------------------------------------
// 错误映射：busy/not_found/校验
// ---------------------------------------------------------------------------

test("错误映射：project_busy / session_busy → 409 且 code 可区分；session_not_found → 404", async (t) => {
  const s = await setupServer(t, {
    gatewayScript: [
      async () => {
        await sleep(700);
        return { text: "A 慢任务完成" };
      }
    ],
    gatewayDelayMs: 0
  });
  const root = s.h.projectRoot;

  const running = await s.post("/api/agent/input", { projectRoot: root, text: "A 慢任务" });
  const aId = running.data.session_id;
  assert.equal(running.data.status, "running");

  const created = await s.post("/api/agent/sessions", { projectRoot: root, title: "B" });
  const bId = created.data.session.session_id;

  // 会话 B 提交而其他会话（A）运行中 → 409 project_busy（前端据此禁用发送键）
  const busy = await s.post("/api/agent/input", { projectRoot: root, text: "B 任务", sessionId: bId });
  assert.equal(busy.res.status, 409);
  assert.equal(busy.data.ok, false);
  assert.equal(busy.data.code, "project_busy", "project_busy = 其他会话运行中");

  // 删除运行中的会话 A → 409 session_busy（前端据此提示归档/删除冲突）
  const delRunning = await del(s, `/api/agent/sessions/${aId}?projectRoot=${encodeURIComponent(root)}`);
  assert.equal(delRunning.res.status, 409);
  assert.equal(delRunning.data.ok, false);
  assert.equal(delRunning.data.code, "session_busy", "session_busy = 该会话自身运行中");

  await waitForIdle(s.h.agent, root);

  // 不存在的会话：PATCH → 404 session_not_found
  const missing = await patch(s, "/api/agent/sessions/ghost-session", { projectRoot: root, title: "x" });
  assert.equal(missing.res.status, 404);
  assert.equal(missing.data.ok, false);
  assert.equal(missing.data.code, "session_not_found");

  // 删除不存在的会话：幂等 200（deleteSession 的 removePermanently 不抛错）
  const delGhost = await del(s, `/api/agent/sessions/ghost-session?projectRoot=${encodeURIComponent(root)}`);
  assert.equal(delGhost.res.status, 200);
  assert.equal(delGhost.data.ok, true);

  // 空 sessionId → 400 invalid_session_id
  const badSession = await s.post("/api/agent/input", { projectRoot: root, text: "x", sessionId: "" });
  assert.equal(badSession.res.status, 400);
  assert.equal(badSession.data.ok, false);
  assert.equal(badSession.data.code, "invalid_session_id");

  // 空白标题 → 400 invalid_session_title
  const badTitle = await patch(s, `/api/agent/sessions/${aId}`, { projectRoot: root, title: "   " });
  assert.equal(badTitle.res.status, 400);
  assert.equal(badTitle.data.ok, false);
  assert.equal(badTitle.data.code, "invalid_session_title");
});

test("校验：POST sessions 空/非字符串 title → 400；GET snapshot 空 sessionId → 400", async (t) => {
  const s = await setupServer(t, { gatewayScript: [{ reply: { text: "好。" } }] });
  const root = s.h.projectRoot;

  // POST 新建会话：空 title → 400 invalid_session_title
  const blank = await s.post("/api/agent/sessions", { projectRoot: root, title: "" });
  assert.equal(blank.res.status, 400);
  assert.equal(blank.data.ok, false);
  assert.equal(blank.data.code, "invalid_session_title");

  // POST 新建会话：非字符串 title → 400 invalid_session_title
  const nonString = await s.post("/api/agent/sessions", { projectRoot: root, title: 123 });
  assert.equal(nonString.res.status, 400);
  assert.equal(nonString.data.code, "invalid_session_title");

  // GET snapshot query 形态：空 sessionId → 400 invalid_session_id
  const badSnap = await s.get(`/api/agent/snapshot?projectRoot=${encodeURIComponent(root)}&sessionId=`);
  assert.equal(badSnap.res.status, 400);
  assert.equal(badSnap.data.ok, false);
  assert.equal(badSnap.data.code, "invalid_session_id");
});
