// tests/http/agent-routes.test.mjs —— Agent HTTP 路由行为测试（Task 7 Step 2/5）。
//
// 用 harness（Task 1 的 ProjectAgent 验收基建，mock gateway）构造真实 HTTP server，
// 只经 src/core/http/router.mjs + agent-routes.mjs 访问 Agent 公共 seam。
// 覆盖：input（空闲创建 Run / 运行中排队 200 + 同 run_id）、promote 同 run id、
// stop 取消 Run 与排队输入、retry 同一可恢复 Run、decide 决策、snapshot 分页、
// /api/project/events SSE 推送，以及错误码 → HTTP 状态映射。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
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

test("原始 Node 文件错误不回传响应正文（统一错误脱敏契约）", async (t) => {
  // 计划 Task 4 Step 6：agent 抛出原始 ENOENT（如 journal 目录被外部删除）时，
  // 响应正文不得出现 ENOENT/绝对路径/堆栈，message 只使用 publicErrorMessage 的
  // 固定中文文案，code 收敛为 INTERNAL_ERROR。
  const router = createRouter();
  const server = await startHttpServer(t, {
    router,
    routeModules: [
      createAgentRoutes({
        agent: {
          submit: async () => {
            const error = new Error(
              "ENOENT: no such file or directory, open 'C:\\Users\\test\\userData\\workspaces\\ws_x\\agent\\events.jsonl'"
            );
            error.code = "ENOENT";
            throw error;
          }
        }
      })
    ]
  });
  const { res, data } = await server.post("/api/agent/input", { projectRoot: "C:\\any\\folder", text: "你好" });
  assert.equal(res.status, 500);
  assert.equal(data.ok, false);
  assert.equal(data.code, "INTERNAL_ERROR");
  assert.match(data.message, /无法读取|请检查|重试/u);
  assert.doesNotMatch(JSON.stringify(data), /ENOENT|node:fs|at\s+\w+|[A-Z]:\\.*userData/iu);
});

// ---------------------------------------------------------------------------
// Task 5：尾部分页（tail/beforeSeq）、历史导出与不可逆清空
// ---------------------------------------------------------------------------

// 直接向 segment store 写合法事件（session_created + history_compacted），快速
// 构造 500+ 事件的 journal——避免逐 Run 推进模型循环（history_compacted 在
// reducer 中无副作用，不累积 queued inputs，也不会产生活动 Run）。
async function seedJournalEvents(agentRoot, projectRoot, { count = 500, sessionId = "seed-session" } = {}) {
  const eventsDir = path.join(agentRoot, "segments", "events");
  await fs.mkdir(eventsDir, { recursive: true });
  const at = "2026-01-01T00:00:00.000Z";
  const record = (seq) => ({
    schema_version: 2,
    seq,
    event_id: `seed-${seq}`,
    session_id: sessionId,
    run_id: null,
    project_root: projectRoot,
    at,
    type: seq === 1 ? "session_created" : "history_compacted",
    payload: seq === 1 ? {} : { reason: "seed", compacted_at: at, message_count: 1 }
  });
  const lines = Array.from({ length: count }, (_, i) => JSON.stringify(record(i + 1)));
  await fs.writeFile(path.join(eventsDir, "00000001.jsonl"), `${lines.join("\n")}\n`, "utf8");
}

// 构造带中间坏段的 journal：seg1=[1..4]、seg2=[5..8]+非法行（坏段）、seg3=[9..12]。
async function seedCorruptJournal(agentRoot, projectRoot) {
  const eventsDir = path.join(agentRoot, "segments", "events");
  await fs.mkdir(eventsDir, { recursive: true });
  const at = "2026-01-01T00:00:00.000Z";
  const record = (seq) => ({
    schema_version: 2,
    seq,
    event_id: `gap-${seq}`,
    session_id: "gap-session",
    run_id: null,
    project_root: projectRoot,
    at,
    type: seq === 1 ? "session_created" : "history_compacted",
    payload: seq === 1 ? {} : { reason: "seed", compacted_at: at, message_count: 1 }
  });
  const segment = (id, from, to, extra = "") => {
    const lines = Array.from({ length: to - from + 1 }, (_, i) => JSON.stringify(record(from + i)));
    return `${lines.join("\n")}${extra ? `\n${extra}` : ""}\n`;
  };
  await fs.writeFile(path.join(eventsDir, "00000001.jsonl"), segment(1, 1, 4), "utf8");
  await fs.writeFile(path.join(eventsDir, "00000002.jsonl"), segment(2, 5, 8, "{broken json"), "utf8");
  await fs.writeFile(path.join(eventsDir, "00000003.jsonl"), segment(3, 9, 12), "utf8");
}

test("Task 5 snapshot beforeSeq 分页：返回最近旧页（401–500、has_more、gaps）", async (t) => {
  const s = await setupServer(t);
  await seedJournalEvents(s.h.agentRoot, s.h.projectRoot, { count: 500 });
  await s.h.agent.open({ projectRoot: s.h.projectRoot });

  const page = await s.h.agent.snapshot({ projectRoot: s.h.projectRoot, beforeSeq: 501, limit: 100 });
  assert.equal(page.events.length, 100);
  assert.equal(page.events[0].seq, 401);
  assert.equal(page.events.at(-1).seq, 500);
  assert.equal(page.has_more, true);
  assert.deepEqual(page.gaps, []);
  assert.equal(page.session.session_id, "seed-session");
  assert.equal(page.session.status, "idle");
  assert.equal(page.session.last_seq, 500);

  // tail 页：最新 limit 条
  const tail = await s.h.agent.snapshot({ projectRoot: s.h.projectRoot, tail: true, limit: 3 });
  assert.deepEqual(tail.events.map((e) => e.seq), [498, 499, 500]);
  assert.equal(tail.has_more, true, "tail 页之前还有更旧事件");

  // afterSeq=0 只表示从头读取（旧客户端兼容）：从 seq 1 起
  const fromStart = await s.h.agent.snapshot({ projectRoot: s.h.projectRoot, afterSeq: 0, limit: 5 });
  assert.deepEqual(fromStart.events.map((e) => e.seq), [1, 2, 3, 4, 5]);
  assert.equal(fromStart.has_more, true);

  // HTTP 形状：beforeSeq 查询参数
  const res = await s.get(
    `/api/agent/snapshot?projectRoot=${encodeURIComponent(s.h.projectRoot)}&beforeSeq=501&limit=100`
  );
  assert.equal(res.res.status, 200);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.events.length, 100);
  assert.equal(res.data.events[0].seq, 401);
  assert.equal(res.data.events.at(-1).seq, 500);
  assert.equal(res.data.has_more, true);
  assert.deepEqual(res.data.gaps, []);
  assert.equal(res.data.session.session_id, "seed-session");
});

test("Task 5 clearHistory 守卫：活动 Run → history_busy；空闲未确认 → confirmation_required", async (t) => {
  const s = await setupServer(t, {
    gatewayScript: [
      async () => {
        await sleep(600);
        return { text: "慢答复" };
      }
    ],
    gatewayDelayMs: 0
  });
  await seedJournalEvents(s.h.agentRoot, s.h.projectRoot, { count: 500 });
  await s.h.agent.open({ projectRoot: s.h.projectRoot });

  // 空闲且未确认 → 区别于 history_busy 的 code
  await assert.rejects(
    s.h.agent.clearHistory({ projectRoot: s.h.projectRoot }),
    (error) => error.code === "confirmation_required"
  );

  // 活动 Run 且未确认 → history_busy（brief Step 1：busy 校验先于确认校验）
  const created = await s.h.agent.submit({ projectRoot: s.h.projectRoot, text: "慢任务" });
  assert.equal(created.queued, false);
  await assert.rejects(
    s.h.agent.clearHistory({ projectRoot: s.h.projectRoot }),
    (error) => error.code === "history_busy"
  );
  // 活动 Run 即使带了确认也 history_busy
  await assert.rejects(
    s.h.agent.clearHistory({ projectRoot: s.h.projectRoot, confirmIrreversible: true }),
    (error) => error.code === "history_busy"
  );
  await waitForIdle(s.h.agent, s.h.projectRoot);
});

test("Task 5 clearHistory 成功后同一实例立即可用：新 session_id、seq 从 1、旧消息不回写", async (t) => {
  const s = await setupServer(t, { gatewayScript: [{ reply: { text: "新会话答复" }, repeat: true }] });
  await seedJournalEvents(s.h.agentRoot, s.h.projectRoot, { count: 500 });
  await s.h.agent.open({ projectRoot: s.h.projectRoot });
  const old = await s.h.agent.snapshot({ projectRoot: s.h.projectRoot, tail: true, limit: 5 });
  assert.equal(old.session.last_seq, 500);

  const result = await s.h.agent.clearHistory({ projectRoot: s.h.projectRoot, confirmIrreversible: true });
  assert.equal(typeof result.session_id, "string");
  assert.notEqual(result.session_id, old.session.session_id, "清空后必须产生新 session_id");

  // 同一 ProjectAgent 实例立即 snapshot：seq 从新 generation 的 1 开始、旧消息不回写
  const fresh = await s.h.agent.snapshot({ projectRoot: s.h.projectRoot, afterSeq: 0, limit: 1000 });
  assert.equal(fresh.session.session_id, result.session_id);
  assert.equal(fresh.session.last_seq, 1, "新 session 从 seq 1 开始");
  assert.equal(fresh.events.length, 1, "清空后只有新的 session_created");
  assert.equal(fresh.events[0].type, "session_created");
  assert.equal(fresh.events[0].seq, 1);
  assert.deepEqual(fresh.gaps, []);

  // 同一实例 append 可用：新 Run 从 seq 2 起、旧事件不回写
  await s.h.agent.submit({ projectRoot: s.h.projectRoot, text: "清空后的第一条消息" });
  await waitForIdle(s.h.agent, s.h.projectRoot);
  const after = await s.h.agent.snapshot({ projectRoot: s.h.projectRoot, afterSeq: 0, limit: 100000 });
  assert.ok(after.events.some((e) => e.type === "run_started"), "新 Run 事件已落盘");
  assert.equal(after.events[0].seq, 1, "session_created 是唯一的 seq 1 事件");
  assert.ok(
    after.events.filter((e) => e.type !== "session_created").every((e) => e.seq >= 2),
    "新事件从 seq 2 开始，不复用旧 seq"
  );
  assert.ok(after.events.every((e) => e.session_id === result.session_id));
  assert.equal(after.events.some((e) => e.event_id === "seed-1"), false, "旧事件不得回写");

  // cleared-history 落盘：clear-manifest.json 记录原因与旧 session
  const clearedRoot = path.join(s.h.agentRoot, "cleared-history");
  const clearedEntries = await fs.readdir(clearedRoot);
  assert.equal(clearedEntries.length, 1);
  const clearManifest = JSON.parse(
    await fs.readFile(path.join(clearedRoot, clearedEntries[0], "clear-manifest.json"), "utf8")
  );
  assert.equal(clearManifest.reason, "user_clear");
  assert.equal(clearManifest.old_session_id, old.session.session_id);

  // 项目根数据不受影响：章节/总纲/设定/正式 checkpoint 不得被清空触碰
  for (const name of ["OUTLINE.md", "SETTING.md", "chapters", "checkpoints", "memory", "run_log.jsonl"]) {
    try {
      await fs.access(path.join(s.h.projectRoot, name));
    } catch {
      assert.fail(`清空不得触碰项目根 ${name}`);
    }
  }
});

test("Task 5 HTTP：POST /api/agent/history/export 返回 NDJSON 下载且不含未脱敏 secret", async (t) => {
  const s = await setupServer(t, {
    gatewayScript: [{ reply: { text: "关键信息：超级机密" } }],
    secrets: ["超级机密"]
  });
  await seedJournalEvents(s.h.agentRoot, s.h.projectRoot, { count: 60 });
  await s.h.agent.open({ projectRoot: s.h.projectRoot });
  await s.h.agent.submit({ projectRoot: s.h.projectRoot, text: "你好" });
  await waitForIdle(s.h.agent, s.h.projectRoot);

  const res = await fetch(`${s.base}/api/agent/history/export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectRoot: s.h.projectRoot })
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/x-ndjson/u);
  assert.match(res.headers.get("content-disposition") ?? "", /attachment/u);
  assert.match(res.headers.get("content-disposition") ?? "", /wwriting-agent-history\.jsonl/u);
  const body = await res.text();
  const lines = body.trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(lines.length >= 60, "导出包含 seed 事件");
  assert.ok(lines.some((line) => line.stream === "event" && line.record?.type === "session_created"));
  assert.ok(lines.some((line) => line.stream === "transcript" && line.record?.role === "assistant"), "导出包含 transcript 记录");
  assert.ok(lines.every((line) => ["event", "transcript", "gap"].includes(line.stream)), "每行都是 event/transcript/gap");
  assert.doesNotMatch(body, /超级机密/u, "导出响应不得包含未脱敏 secret");
});

test("Task 5 HTTP：export 的 gap 行保留损坏范围且不含隔离文件原文；退化 journal 可清空", async (t) => {
  const s = await setupServer(t);
  await seedCorruptJournal(s.h.agentRoot, s.h.projectRoot);
  await s.h.agent.open({ projectRoot: s.h.projectRoot });

  const res = await fetch(`${s.base}/api/agent/history/export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectRoot: s.h.projectRoot })
  });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.doesNotMatch(body, /broken json/u, "隔离文件原文不得出现在导出中");
  const lines = body.trim().split("\n").map((line) => JSON.parse(line));
  const gapLines = lines.filter((line) => line.stream === "gap");
  assert.equal(gapLines.length, 1, "坏段范围应有一条 gap 行");
  assert.deepEqual(gapLines[0].record, {
    stream: "events",
    start_seq: 5,
    end_seq: 8,
    reason: "segment_corrupt"
  });
  const eventLines = lines.filter((line) => line.stream === "event");
  assert.deepEqual(eventLines.map((line) => line.record.seq), [1, 2, 3, 4, 9, 10, 11, 12], "健康段按序导出");

  // 退化（needs_history_clear）journal 可以清空，清空后不再标记退化
  const cleared = await s.h.agent.clearHistory({ projectRoot: s.h.projectRoot, confirmIrreversible: true });
  const fresh = await s.h.agent.snapshot({ projectRoot: s.h.projectRoot, afterSeq: 0, limit: 100 });
  assert.equal(fresh.session.session_id, cleared.session_id);
  assert.equal(fresh.events.length, 1);
  assert.equal(fresh.session.needs_history_clear, undefined, "清空后不再标记 needs_history_clear");
});

test("Task 5 HTTP：POST /api/agent/history/clear 缺确认 400、活动 Run 409、成功 200", async (t) => {
  const s = await setupServer(t, {
    gatewayScript: [
      async () => {
        await sleep(600);
        return { text: "慢答复" };
      }
    ],
    gatewayDelayMs: 0
  });
  await seedJournalEvents(s.h.agentRoot, s.h.projectRoot, { count: 120 });
  await s.h.agent.open({ projectRoot: s.h.projectRoot });

  // 缺少 confirm_irreversible:true → 400 confirmation_required
  const missing = await s.post("/api/agent/history/clear", { projectRoot: s.h.projectRoot });
  assert.equal(missing.res.status, 400);
  assert.equal(missing.data.ok, false);
  assert.equal(missing.data.code, "confirmation_required");

  // 活动 Run → 409 history_busy（即使带了 confirm）
  const running = await s.post("/api/agent/input", { projectRoot: s.h.projectRoot, text: "慢任务" });
  assert.equal(running.data.status, "running");
  const busy = await s.post("/api/agent/history/clear", {
    projectRoot: s.h.projectRoot,
    confirm_irreversible: true
  });
  assert.equal(busy.res.status, 409);
  assert.equal(busy.data.ok, false);
  assert.equal(busy.data.code, "history_busy");
  await waitForIdle(s.h.agent, s.h.projectRoot);

  // 空闲 + confirm → 200 新 session
  const cleared = await s.post("/api/agent/history/clear", {
    projectRoot: s.h.projectRoot,
    confirm_irreversible: true
  });
  assert.equal(cleared.res.status, 200);
  assert.equal(cleared.data.ok, true);
  assert.equal(typeof cleared.data.session_id, "string");
  assert.equal(cleared.data.status, "idle");
  const snap = await s.get(`/api/agent/snapshot?projectRoot=${encodeURIComponent(s.h.projectRoot)}&afterSeq=0&limit=100`);
  assert.equal(snap.data.session.session_id, cleared.data.session_id);
  assert.equal(snap.data.events.length, 1, "清空后只剩新 session_created");
});

// ---------------------------------------------------------------------------
// Task 9：压缩取消/重试路由 + /compact 排队契约 + snapshot tail HTTP 形状
// ---------------------------------------------------------------------------

// 压缩路由测试用最小 stub agent（submit 满足 createAgentRoutes 的注入校验），
// 契约与错误映射聚焦在路由层；真实压缩状态机语义已由 Task 8 的
// tests/agent/compaction.test.mjs 覆盖。
function compactionStubAgent(overrides = {}) {
  return {
    submit: async () => ({ input_id: "in-1", run_id: "run-1", queued: false }),
    cancelCompaction: async () => ({ status: "cancelled", compaction_id: "c-1" }),
    retryCompaction: async () => ({ status: "completed", compaction_id: "c-1", attempt: 2 }),
    ...overrides
  };
}

function compactionHttpServer(t, agent) {
  const router = createRouter();
  return startHttpServer(t, {
    router,
    routeModules: [createAgentRoutes({ agent })]
  });
}

test("Task 9 POST /api/agent/compaction/:id/cancel 返回 200 + { ok, compaction_id, cancelling }", async (t) => {
  const server = await compactionHttpServer(t, compactionStubAgent());
  const { res, data } = await server.post("/api/agent/compaction/c-1/cancel", { projectRoot: "D:\\any" });
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.compaction_id, "c-1");
  assert.equal(data.cancelling, true, "取消请求被接受");
});

test("Task 9 POST /api/agent/compaction/:id/retry 返回 200 + { ok, compaction_id, retried }", async (t) => {
  const server = await compactionHttpServer(t, compactionStubAgent());
  const { res, data } = await server.post("/api/agent/compaction/c-1/retry", { projectRoot: "D:\\any" });
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.compaction_id, "c-1");
  assert.equal(data.retried, true, "重试请求被接受");
});

test("Task 9 不存在的 compaction id → 404 compaction_not_found（cancel 与 retry）", async (t) => {
  const agent = compactionStubAgent({
    cancelCompaction: async () => {
      const error = new Error("compaction ghost 不存在。");
      error.code = "compaction_not_found";
      throw error;
    },
    retryCompaction: async () => {
      const error = new Error("compaction ghost 不存在。");
      error.code = "compaction_not_found";
      throw error;
    }
  });
  const server = await compactionHttpServer(t, agent);
  const cancel = await server.post("/api/agent/compaction/ghost/cancel", { projectRoot: "D:\\any" });
  assert.equal(cancel.res.status, 404);
  assert.equal(cancel.data.ok, false);
  assert.equal(cancel.data.code, "compaction_not_found");
  const retry = await server.post("/api/agent/compaction/ghost/retry", { projectRoot: "D:\\any" });
  assert.equal(retry.res.status, 404);
  assert.equal(retry.data.ok, false);
  assert.equal(retry.data.code, "compaction_not_found");
});

test("Task 9 压缩状态冲突（重试已终结/进行中/无 Run）→ 409", async (t) => {
  const agent = compactionStubAgent({
    retryCompaction: async () => {
      const error = new Error("压缩已完成，无法重试。");
      error.code = "compaction_not_retryable";
      throw error;
    }
  });
  const server = await compactionHttpServer(t, agent);
  const retry = await server.post("/api/agent/compaction/c-1/retry", { projectRoot: "D:\\any" });
  assert.equal(retry.res.status, 409);
  assert.equal(retry.data.ok, false);
  assert.equal(retry.data.code, "compaction_not_retryable");
});

test("Task 9 取消/重试不泄漏底层错误文本（统一脱敏契约）", async (t) => {
  const agent = compactionStubAgent({
    cancelCompaction: async () => {
      const error = new Error(
        "ENOENT: no such file or directory, open 'C:\\Users\\test\\userData\\workspaces\\ws_x\\agent\\events.jsonl'"
      );
      error.code = "ENOENT";
      throw error;
    }
  });
  const server = await compactionHttpServer(t, agent);
  const { res, data } = await server.post("/api/agent/compaction/c-1/cancel", {
    projectRoot: "C:\\any\\folder"
  });
  assert.equal(res.status, 500);
  assert.equal(data.ok, false);
  assert.equal(data.code, "INTERNAL_ERROR");
  assert.doesNotMatch(JSON.stringify(data), /ENOENT|node:fs|at\s+\w+|[A-Z]:\\.*userData/iu);
});

test("Task 9 运行中提交 /compact 返回 queued 而不是新 Run", async (t) => {
  const s = await setupServer(t, {
    gatewayScript: [
      async () => {
        await sleep(600);
        return { text: "第一轮完成" };
      },
      { reply: { text: "排队任务完成" } }
    ],
    gatewayDelayMs: 0
  });
  const first = await s.post("/api/agent/input", { projectRoot: s.h.projectRoot, text: "任务一" });
  assert.equal(first.data.status, "running");
  const compact = await s.post("/api/agent/input", { projectRoot: s.h.projectRoot, text: "/compact" });
  assert.equal(compact.res.status, 200);
  assert.equal(compact.data.ok, true);
  assert.equal(compact.data.status, "queued", "/compact 运行中应排队而不是新 Run");
  assert.equal(compact.data.run_id, first.data.run_id, "排队沿用同一 Run id");
  await waitForIdle(s.h.agent, s.h.projectRoot);
  const events = await readEvents(s.h.agent, s.h.projectRoot);
  assert.equal(eventsOfType(events, "run_started").length, 1, "/compact 排队不得创建新 Run");
});

test("Task 9 GET /api/agent/snapshot?tail=1 返回最新尾页", async (t) => {
  const s = await setupServer(t);
  await seedJournalEvents(s.h.agentRoot, s.h.projectRoot, { count: 500 });
  await s.h.agent.open({ projectRoot: s.h.projectRoot });
  const res = await s.get(
    `/api/agent/snapshot?projectRoot=${encodeURIComponent(s.h.projectRoot)}&tail=1&limit=3`
  );
  assert.equal(res.res.status, 200);
  assert.equal(res.data.ok, true);
  assert.deepEqual(res.data.events.map((e) => e.seq), [498, 499, 500]);
  assert.equal(res.data.has_more, true, "尾页之前还有更旧事件");
  assert.equal(res.data.session.last_seq, 500);
});
