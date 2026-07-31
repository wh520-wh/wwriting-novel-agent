// tests/writing-agent-session.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { WritingAgentSession } from "../src/core/writing-agent-session.mjs";

function makeSession(overrides = {}) {
  const events = [];
  const seen = [];
  const session = new WritingAgentSession({
    allowedTools: ["read_thing", "edit_thing", "commit_thing"],
    commitTool: "commit_thing",
    maxConsecutiveReads: 3,
    maxTurns: 10,
    emitEvent: async (type, data) => { events.push({ type, ...data }); },
    callModel: async (ctx) => {
      seen.push({ turn: ctx.turn, allowedTools: [...ctx.allowedTools], feedback: ctx.feedback });
      return overrides.respond(ctx, seen.length);
    },
    executeTool: overrides.executeTool,
    ...overrides.sessionOptions,
  });
  return { session, events, seen };
}

test("session: 连续 3 次只读工具后自动切换 commit-only，事件只发一次", async () => {
  const { session, events, seen } = makeSession({
    respond: (ctx, n) => (n <= 3
      ? { type: "tool_call", tool: "read_thing", input: {} }
      : { type: "tool_call", tool: "commit_thing", input: {} }),
    executeTool: async (output) => ({
      ok: true,
      readOnly: output.tool === "read_thing",
      committed: output.tool === "commit_thing",
      result: output.tool === "commit_thing" ? { saved: true } : undefined,
    }),
  });
  const run = await session.start();
  assert.equal(run.outcome, "completed");
  assert.deepEqual(seen[3].allowedTools, ["commit_thing"]); // 第 4 轮已被切换
  assert.equal(events.filter((e) => e.type === "agent_loop_commit_only").length, 1);
  assert.deepEqual(
    events.filter((e) => e.type === "agent_end").map((e) => e.outcome),
    ["completed"],
  );
  assert.equal(events.at(-1).type, "agent_settled");
});

test("session: 编辑工具成功重置只读计数并还原白名单", async () => {
  const { session, events, seen } = makeSession({
    respond: (ctx, n) => {
      if (n <= 2) return { type: "tool_call", tool: "read_thing", input: {} };
      if (n === 3) return { type: "tool_call", tool: "edit_thing", input: {} };
      if (n === 4) return { type: "tool_call", tool: "read_thing", input: {} };
      return { type: "tool_call", tool: "commit_thing", input: {} };
    },
    executeTool: async (output) => ({
      ok: true,
      readOnly: output.tool === "read_thing",
      committed: output.tool === "commit_thing",
    }),
  });
  await session.start();
  assert.deepEqual(seen[3].allowedTools, ["read_thing", "edit_thing", "commit_thing"]);
  assert.equal(events.filter((e) => e.type === "agent_loop_commit_only").length, 0);
});

test("session: steer 文本注入下一轮 feedback", async () => {
  let sessionRef = null;
  const { session, seen } = makeSession({
    respond: (ctx, n) => {
      if (n === 1) sessionRef.steer("不要再查了，直接写");
      return n <= 1
        ? { type: "tool_call", tool: "read_thing", input: {} }
        : { type: "tool_call", tool: "commit_thing", input: {} };
    },
    executeTool: async (output) => ({
      ok: true,
      readOnly: output.tool === "read_thing",
      committed: output.tool === "commit_thing",
    }),
  });
  sessionRef = session;
  await session.start();
  assert.equal(seen[1].feedback, "不要再查了，直接写");
});

test("session: followUp 在 agent_end 之后、agent_settled 之前执行", async () => {
  const order = [];
  const { session, events } = makeSession({
    respond: () => ({ type: "tool_call", tool: "commit_thing", input: {} }),
    executeTool: async () => ({ ok: true, committed: true }),
  });
  session.followUp(async () => { order.push("followUp"); });
  await session.start();
  await session.waitForIdle();
  const types = events.map((e) => e.type);
  assert.ok(types.indexOf("agent_end") < types.indexOf("agent_settled"));
  assert.deepEqual(order, ["followUp"]);
  assert.equal(session.status, "idle");
});

test("session: abort 使当前 run 以 aborted 结束，settled 照常发出", async () => {
  const controller = new AbortController();
  let sessionRef = null;
  const { session, events } = makeSession({
    respond: (ctx, n) => {
      if (n === 1) sessionRef.abort();
      return { type: "tool_call", tool: "read_thing", input: {} };
    },
    executeTool: async () => ({ ok: true, readOnly: true }),
  });
  sessionRef = session;
  const run = await session.start({ signal: controller.signal });
  assert.equal(run.outcome, "aborted");
  assert.equal(events.filter((e) => e.type === "agent_end").at(-1).outcome, "aborted");
  assert.equal(events.at(-1).type, "agent_settled");
  await session.waitForIdle();
});

test("session: 非 AbortError 失败后 waitForIdle 不悬挂", async () => {
  const { session } = makeSession({
    respond: () => ({ type: "tool_call", tool: "read_thing", input: {} }),
    executeTool: async () => {
      throw new Error("tool exploded");
    },
  });
  const runPromise = session.start();
  const idlePromise = session.waitForIdle(); // run 期间调用，拿到内部 idlePromise
  await assert.rejects(runPromise, /tool exploded/);
  await Promise.race([
    idlePromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("waitForIdle 悬挂")), 500)),
  ]);
  assert.equal(session.status, "idle");
});

test("session: emitEvent 抛错后 start 可复用（状态回 idle）", async () => {
  let calls = 0;
  const { session, events } = makeSession({
    respond: () => ({ type: "tool_call", tool: "commit_thing", input: {} }),
    executeTool: async () => ({ ok: true, committed: true }),
    sessionOptions: {
      emitEvent: async (type, data) => {
        if (type === "agent_start" && calls === 0) {
          calls += 1;
          throw new Error("disk write failed");
        }
        calls += 1;
        events.push({ type, ...data });
      },
    },
  });
  await assert.rejects(session.start(), /disk write failed/);
  assert.equal(session.status, "idle");
  const run = await session.start(); // 第二次 start 应正常完成
  assert.equal(run.outcome, "completed");
  assert.equal(session.status, "idle");
});

test("session: agent_end 事件写盘失败 → start reject、状态回 idle、waitForIdle 可 resolve", async () => {
  const { session } = makeSession({
    respond: () => ({ type: "tool_call", tool: "commit_thing", input: {} }),
    executeTool: async () => ({ ok: true, committed: true }),
    sessionOptions: {
      emitEvent: async (type) => {
        if (type === "agent_end") throw new Error("agent_end disk full");
      },
    },
  });
  const runPromise = session.start();
  const idlePromise = session.waitForIdle(); // run 期间调用，拿到内部 idlePromise
  await assert.rejects(runPromise, /agent_end disk full/);
  await Promise.race([
    idlePromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("waitForIdle 悬挂")), 500)),
  ]);
  assert.equal(session.status, "idle");
});

test("session: followUp 任务抛错 → start reject、状态回 idle（不卡 settling）", async () => {
  const { session } = makeSession({
    respond: () => ({ type: "tool_call", tool: "commit_thing", input: {} }),
    executeTool: async () => ({ ok: true, committed: true }),
  });
  session.followUp(async () => { throw new Error("followUp job exploded"); });
  await assert.rejects(session.start(), /followUp job exploded/);
  assert.equal(session.status, "idle");
  const run = await session.start(); // 状态已回 idle，可复用
  assert.equal(run.outcome, "completed");
});

test("session: agent_loop_commit_only 事件写盘失败时 start reject 而非未处理拒绝崩溃", async () => {
  const { session } = makeSession({
    respond: (ctx, n) => (n <= 3
      ? { type: "tool_call", tool: "read_thing", input: {} }
      : { type: "tool_call", tool: "commit_thing", input: {} }),
    executeTool: async (output) => ({
      ok: true,
      readOnly: output.tool === "read_thing",
      committed: output.tool === "commit_thing",
    }),
    sessionOptions: {
      emitEvent: async (type) => {
        if (type === "agent_loop_commit_only") throw new Error("disk full");
      },
    },
  });
  await assert.rejects(session.start(), /disk full/);
  assert.equal(session.status, "idle");
});

test("session: 领域 stopRun 主动终止（连续无效输出上限）", async () => {
  const { session } = makeSession({
    respond: () => ({ type: "status_message", message: "嗯" }),
    executeTool: async () => ({ ok: false, stopRun: { outcome: "failed", reason: "model_output_invalid" } }),
  });
  const run = await session.start();
  assert.equal(run.outcome, "failed");
  assert.equal(run.reason, "model_output_invalid");
});
