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

test("session: 领域 stopRun 主动终止（连续无效输出上限）", async () => {
  const { session } = makeSession({
    respond: () => ({ type: "status_message", message: "嗯" }),
    executeTool: async () => ({ ok: false, stopRun: { outcome: "failed", reason: "model_output_invalid" } }),
  });
  const run = await session.start();
  assert.equal(run.outcome, "failed");
  assert.equal(run.reason, "model_output_invalid");
});
