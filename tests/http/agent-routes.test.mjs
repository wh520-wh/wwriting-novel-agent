// tests/http/agent-routes.test.mjs —— Agent HTTP 路由行为测试（Task 7 Step 2/5）。
//
// 用 harness（Task 1 的 ProjectAgent 验收基建，mock gateway）构造真实 HTTP server，
// 只经 src/core/http/router.mjs + agent-routes.mjs 访问 Agent 公共 seam。
// 覆盖：input（空闲创建 Run / 运行中排队 200 + 同 run_id）、promote 同 run id、
// stop 取消 Run 与排队输入、retry 同一可恢复 Run、decide 决策、snapshot 分页、
// /api/project/events SSE 推送，以及错误码 → HTTP 状态映射。
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createRouter } from "../../src/core/http/router.mjs";
import { createAgentRoutes } from "../../src/core/http/agent-routes.mjs";
import { startHttpServer } from "../helpers/http-test.mjs";
import {
  createProjectAgentHarness,
  eventsOfType,
  readEvents,
  sleep,
  tool,
  waitFor,
  waitForIdle
} from "../helpers/project-agent-harness.mjs";

// 组装 router + agent-routes，返回真实 HTTP server。
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

test("POST /api/agent/input 空闲时创建 Run（200 + running）", async (t) => {
  const s = await setupServer(t, { gatewayScript: [{ reply: { text: "好。" } }] });
  const { res, data } = await s.post("/api/agent/input", { projectRoot: s.h.projectRoot, text: "你好" });
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(typeof data.input_id, "string");
  assert.equal(typeof data.run_id, "string");
  assert.equal(data.status, "running");
  await waitForIdle(s.h.agent, s.h.projectRoot);
  const session = (await s.h.agent.snapshot({ projectRoot: s.h.projectRoot, afterSeq: 0, limit: 100 })).session;
  assert.equal(session.active_run.id, data.run_id, "snapshot 中的 Run id 与响应一致");
  assert.equal(session.active_run.status, "completed");
});

test("POST /api/agent/input 运行中排队：HTTP 200 + queued + 同一 run_id", async (t) => {
  const s = await setupServer(t, {
    gatewayScript: [
      async () => {
        await sleep(600);
        return { text: "第一轮答复" };
      },
      { reply: { text: "第二轮答复" } }
    ],
    gatewayDelayMs: 0
  });
  const first = await s.post("/api/agent/input", { projectRoot: s.h.projectRoot, text: "任务一" });
  assert.equal(first.data.status, "running");
  const second = await s.post("/api/agent/input", { projectRoot: s.h.projectRoot, text: "任务二" });
  assert.equal(second.res.status, 200);
  assert.equal(second.data.ok, true);
  assert.equal(second.data.status, "queued", "运行中发送应排队");
  assert.equal(second.data.run_id, first.data.run_id, "排队输入沿用同一 Run");
  assert.notEqual(second.data.input_id, first.data.input_id);

  const mid = (await s.h.agent.snapshot({ projectRoot: s.h.projectRoot, afterSeq: 0, limit: 100 })).session;
  assert.equal(mid.status, "running");
  assert.equal(mid.queued_inputs.length, 1);

  await waitForIdle(s.h.agent, s.h.projectRoot);
  const events = await readEvents(s.h.agent, s.h.projectRoot);
  assert.equal(eventsOfType(events, "run_started").length, 1, "排队不创建新 Run");
  assert.equal(eventsOfType(events, "input_consumed").length, 2, "两条输入都被消费");
});

test("POST /api/agent/input/:inputId/promote 同一 Run 内提升", async (t) => {
  const s = await setupServer(t, {
    gatewayScript: [
      async () => {
        await sleep(600);
        return { text: "第一轮答复" };
      },
      { reply: { text: "提升后答复" } }
    ],
    gatewayDelayMs: 0
  });
  const first = await s.post("/api/agent/input", { projectRoot: s.h.projectRoot, text: "任务一" });
  const second = await s.post("/api/agent/input", { projectRoot: s.h.projectRoot, text: "任务二" });
  const promoted = await s.post(`/api/agent/input/${second.data.input_id}/promote`, {
    projectRoot: s.h.projectRoot
  });
  assert.equal(promoted.res.status, 200);
  assert.equal(promoted.data.ok, true);
  assert.equal(promoted.data.run_id, first.data.run_id, "promote 返回同一 run id");
  assert.equal(promoted.data.input_id, second.data.input_id);
  assert.equal(promoted.data.promoted, true);

  await waitForIdle(s.h.agent, s.h.projectRoot);
  const events = await readEvents(s.h.agent, s.h.projectRoot);
  assert.equal(eventsOfType(events, "run_started").length, 1, "promote 不创建新 Run");
  assert.ok(eventsOfType(events, "input_promoted").length >= 1, "应写入 input_promoted 事件");
  const session = (await s.h.agent.snapshot({ projectRoot: s.h.projectRoot, afterSeq: 0, limit: 100 })).session;
  assert.equal(session.status, "idle");
  assert.equal(session.active_run.status, "completed");
});

test("POST /api/agent/run/:runId/stop 取消当前 Run 与排队输入", async (t) => {
  const s = await setupServer(t, {
    gatewayScript: [
      async () => {
        await sleep(800);
        return { text: "被停止" };
      }
    ],
    gatewayDelayMs: 0
  });
  const first = await s.post("/api/agent/input", { projectRoot: s.h.projectRoot, text: "任务一" });
  await s.post("/api/agent/input", { projectRoot: s.h.projectRoot, text: "任务二" });
  const stopped = await s.post(`/api/agent/run/${first.data.run_id}/stop`, {
    projectRoot: s.h.projectRoot
  });
  assert.equal(stopped.res.status, 200);
  assert.equal(stopped.data.ok, true);
  assert.equal(stopped.data.run_id, first.data.run_id);
  assert.equal(stopped.data.cancelled, true);

  const session = (await s.h.agent.snapshot({ projectRoot: s.h.projectRoot, afterSeq: 0, limit: 100 })).session;
  assert.equal(session.status, "idle");
  assert.equal(session.active_run.id, first.data.run_id);
  assert.equal(session.active_run.status, "cancelled");
  const events = await readEvents(s.h.agent, s.h.projectRoot);
  assert.equal(eventsOfType(events, "run_cancelled").length, 1);
  assert.equal(eventsOfType(events, "input_cancelled").length, 2, "活动与排队输入都取消");
});

test("POST /api/agent/run/:runId/stop 无活动 Run 时 404", async (t) => {
  const s = await setupServer(t);
  const { res, data } = await s.post("/api/agent/run/unknown-run/stop", { projectRoot: s.h.projectRoot });
  assert.equal(res.status, 404);
  assert.equal(data.ok, false);
  assert.equal(data.code, "run_not_found");
});

test("POST /api/agent/run/:runId/retry 恢复同一可恢复 Run", async (t) => {
  const s = await setupServer(t, {
    gatewayScript: [
      { error: new Error("模型挂了") },
      { reply: { text: "恢复成功" } }
    ]
  });
  const first = await s.post("/api/agent/input", { projectRoot: s.h.projectRoot, text: "写一章" });
  await waitForIdle(s.h.agent, s.h.projectRoot);
  const failed = (await s.h.agent.snapshot({ projectRoot: s.h.projectRoot, afterSeq: 0, limit: 100 })).session;
  assert.equal(failed.active_run.status, "failed", "模型失败后 Run 进入可恢复 failed");

  const retried = await s.post(`/api/agent/run/${first.data.run_id}/retry`, { projectRoot: s.h.projectRoot });
  assert.equal(retried.res.status, 200);
  assert.equal(retried.data.ok, true);
  assert.equal(retried.data.run_id, first.data.run_id, "retry 恢复同一 Run");
  assert.equal(retried.data.retried, true);

  await waitForIdle(s.h.agent, s.h.projectRoot);
  const session = (await s.h.agent.snapshot({ projectRoot: s.h.projectRoot, afterSeq: 0, limit: 100 })).session;
  assert.equal(session.active_run.status, "completed");
  const events = await readEvents(s.h.agent, s.h.projectRoot);
  const runStarts = eventsOfType(events, "run_started");
  assert.equal(runStarts.length, 2);
  assert.ok(runStarts.every((event) => event.run_id === first.data.run_id), "两次 run_started 同 id");
});

test("POST /api/agent/decision/:decisionId 解决权限决策", async (t) => {
  // 脚本条目是延迟求值的函数：root 在 setup 后赋值，模型轮次发生时已可用。
  let root = "";
  const s = await setupServer(t, {
    gatewayScript: [
      () => ({
        toolCalls: [tool("write_file", { path: path.join(root, "notes.md"), content: "草稿内容" })]
      }),
      { reply: { text: "已处理" } }
    ]
  });
  root = s.h.projectRoot;
  const submitted = await s.post("/api/agent/input", { projectRoot: s.h.projectRoot, text: "写个文件" });
  assert.equal(submitted.data.status, "running");
  const waiting = await waitFor(s.h.agent, s.h.projectRoot, (session) => session.status === "waiting_user", {
    describe: "权限决策挂起"
  });
  const events = await readEvents(s.h.agent, s.h.projectRoot);
  const requests = eventsOfType(events, "decision_requested");
  assert.ok(requests.length >= 1, "应写入 decision_requested 事件");
  const decisionId = requests[requests.length - 1].payload.decision_id;
  assert.equal(typeof decisionId, "string");

  const resolved = await s.post(`/api/agent/decision/${decisionId}`, {
    projectRoot: s.h.projectRoot,
    choice: "deny"
  });
  assert.equal(resolved.res.status, 200);
  assert.equal(resolved.data.ok, true);
  assert.equal(resolved.data.decision_id, decisionId);
  assert.equal(resolved.data.granted, "deny");

  await waitForIdle(s.h.agent, s.h.projectRoot);
  const after = await readEvents(s.h.agent, s.h.projectRoot);
  assert.equal(eventsOfType(after, "decision_resolved").length >= 1, true, "决策应写终态事件");
  const session = (await s.h.agent.snapshot({ projectRoot: s.h.projectRoot, afterSeq: 0, limit: 100 })).session;
  assert.equal(session.status, "idle");
});

test("POST /api/agent/decision/:decisionId 未知决策 404", async (t) => {
  const s = await setupServer(t);
  const { res, data } = await s.post("/api/agent/decision/not-a-decision", {
    projectRoot: s.h.projectRoot,
    choice: "allow"
  });
  assert.equal(res.status, 404);
  assert.equal(data.ok, false);
  assert.equal(data.code, "decision_not_found");
});

test("GET /api/agent/snapshot 分页（afterSeq/limit）", async (t) => {
  const s = await setupServer(t, { gatewayScript: [{ reply: { text: "第一轮" } }, { reply: { text: "第二轮" } }] });
  await s.post("/api/agent/input", { projectRoot: s.h.projectRoot, text: "甲" });
  await waitForIdle(s.h.agent, s.h.projectRoot);
  await s.post("/api/agent/input", { projectRoot: s.h.projectRoot, text: "乙" });
  await waitForIdle(s.h.agent, s.h.projectRoot);

  const all = await s.get(`/api/agent/snapshot?projectRoot=${encodeURIComponent(s.h.projectRoot)}`);
  assert.equal(all.res.status, 200);
  assert.equal(all.data.ok, true);
  assert.equal(typeof all.data.session.session_id, "string");
  assert.equal(all.data.session.status, "idle");
  assert.ok(Array.isArray(all.data.events));

  const afterSeq = all.data.events[0].seq;
  const page = await s.get(
    `/api/agent/snapshot?projectRoot=${encodeURIComponent(s.h.projectRoot)}&afterSeq=${afterSeq}&limit=2`
  );
  assert.equal(page.res.status, 200);
  assert.ok(page.data.events.length <= 2, "limit 生效");
  assert.ok(page.data.events.every((event) => event.seq > afterSeq), "afterSeq 过滤生效");
  const seqs = page.data.events.map((event) => event.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "事件按 seq 升序");
});

test("GET /api/project/events SSE 推送 journal 事件", async (t) => {
  const s = await setupServer(t, { gatewayScript: [{ reply: { text: "收到" } }] });
  const controller = new AbortController();
  const res = await fetch(
    `${s.base}/api/project/events?projectRoot=${encodeURIComponent(s.h.projectRoot)}`,
    { signal: controller.signal }
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/u);

  await s.post("/api/agent/input", { projectRoot: s.h.projectRoot, text: "事件流测试" });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    if (buffer.includes("run_started")) break;
  }
  assert.match(buffer, /input_queued/u, "SSE 应推送 input_queued 事件");
  assert.match(buffer, /run_started/u, "SSE 应推送 run_started 事件");
  assert.match(buffer, /data:/u, "SSE 使用 data: 帧");
  controller.abort();
  await reader.cancel().catch(() => {});
  await waitForIdle(s.h.agent, s.h.projectRoot);
});

test("错误映射：缺少 projectRoot / text → 400", async (t) => {
  const s = await setupServer(t);
  const noRoot = await s.post("/api/agent/input", { text: "你好" });
  assert.equal(noRoot.res.status, 400);
  assert.equal(noRoot.data.code, "invalid_project_root");

  const noText = await s.post("/api/agent/input", { projectRoot: s.h.projectRoot });
  assert.equal(noText.res.status, 400);
  assert.equal(noText.data.code, "empty_input");
});

test("错误映射：坏 JSON → 400 BAD_REQUEST", async (t) => {
  const s = await setupServer(t);
  const { res, data } = await s.post("/api/agent/input", "{not json");
  assert.equal(res.status, 400);
  assert.equal(data.ok, false);
  assert.equal(data.code, "BAD_REQUEST");
});

test("错误映射：未知路由 → 404 NOT_FOUND；promote 非排队输入 → 409", async (t) => {
  const s = await setupServer(t, {
    gatewayScript: [
      async () => {
        await sleep(600);
        return { text: "第一轮答复" };
      },
      { reply: { text: "第二轮答复" } }
    ],
    gatewayDelayMs: 0
  });
  const missing = await s.get("/api/agent/does-not-exist");
  assert.equal(missing.res.status, 404);
  assert.equal(missing.data.code, "NOT_FOUND");

  await s.post("/api/agent/input", { projectRoot: s.h.projectRoot, text: "任务一" });
  const conflict = await s.post("/api/agent/input/not-queued/promote", { projectRoot: s.h.projectRoot });
  assert.equal(conflict.res.status, 409);
  assert.equal(conflict.data.code, "input_not_queued");
  await waitForIdle(s.h.agent, s.h.projectRoot);
});

test("畸形 % 编码路径返回 400 BAD_REQUEST，不悬挂连接", async (t) => {
  const s = await setupServer(t);
  // %zz 不是合法 percent-encoding：decodeURIComponent 会抛 URIError。修复前该
  // 异常发生在 router try 块之外 → 无响应（fetch 悬挂）+ unhandledRejection。
  const controller = new AbortController();
  const guard = setTimeout(() => controller.abort(), 5000);
  const res = await fetch(`${s.base}/api/agent/input/%zz/promote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectRoot: s.h.projectRoot }),
    signal: controller.signal
  });
  clearTimeout(guard);
  assert.equal(res.status, 400, "畸形编码路径应得到 400 而不是悬挂");
  const data = await res.json();
  assert.equal(data.ok, false);
  assert.equal(data.code, "BAD_REQUEST");
});

test("retry 已终结（completed）的 Run → 409 run_not_recoverable", async (t) => {
  const s = await setupServer(t, { gatewayScript: [{ reply: { text: "好。" } }] });
  const first = await s.post("/api/agent/input", { projectRoot: s.h.projectRoot, text: "已完成任务" });
  await waitForIdle(s.h.agent, s.h.projectRoot);
  const retried = await s.post(`/api/agent/run/${first.data.run_id}/retry`, { projectRoot: s.h.projectRoot });
  assert.equal(retried.res.status, 409, "completed Run 不可重试，应 409 而非 500");
  assert.equal(retried.data.ok, false);
  assert.equal(retried.data.code, "run_not_recoverable");
});
