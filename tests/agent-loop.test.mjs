// tests/agent-loop.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { runAgentLoop } from "../src/core/agent-loop.mjs";

test("agent loop: 提交工具成功后由 shouldStopAfterTurn 结束，事件序列完整", async () => {
  const events = [];
  let calls = 0;
  const result = await runAgentLoop({
    context: { allowedTools: ["read_thing", "commit_thing"], feedback: null, steering: [] },
    callModel: async () => {
      calls += 1;
      return calls === 1
        ? { type: "tool_call", tool: "read_thing", input: {} }
        : { type: "tool_call", tool: "commit_thing", input: {} };
    },
    executeTool: async (output) => ({
      ok: true,
      committed: output.tool === "commit_thing",
      readOnly: output.tool === "read_thing",
      summary: "ok",
      result: output.tool === "commit_thing" ? { saved: true } : undefined,
    }),
    shouldStopAfterTurn: (ctx, r) =>
      r.committed ? { stop: true, reason: "committed", outcome: "completed", result: r.result } : { stop: false },
    emitEvent: async (type, data) => { events.push({ type, ...data }); },
    maxTurns: 5,
  });
  assert.equal(result.outcome, "completed");
  assert.equal(result.turns, 2);
  assert.deepEqual(result.lastResult, { saved: true });
  assert.deepEqual(events.map((e) => e.type), [
    "turn_start", "tool_execution_start", "tool_execution_end", "turn_end",
    "turn_start", "tool_execution_start", "tool_execution_end", "turn_end",
  ]);
});

test("agent loop: 达到 maxTurns 返回 exhausted，不额外多发 turn_start", async () => {
  const events = [];
  const result = await runAgentLoop({
    context: { allowedTools: ["read_thing"], feedback: null, steering: [] },
    callModel: async () => ({ type: "tool_call", tool: "read_thing", input: {} }),
    executeTool: async () => ({ ok: true, readOnly: true, summary: "ok" }),
    shouldStopAfterTurn: () => ({ stop: false }),
    emitEvent: async (type, data) => { events.push({ type, ...data }); },
    maxTurns: 3,
  });
  assert.equal(result.outcome, "exhausted");
  assert.equal(result.turns, 3);
  assert.equal(events.filter((e) => e.type === "turn_start").length, 3);
});

test("agent loop: 外部 abort 后下一轮开始前返回 aborted", async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = await runAgentLoop({
    context: { allowedTools: ["read_thing"], feedback: null, steering: [] },
    callModel: async () => {
      calls += 1;
      if (calls === 1) controller.abort();
      return { type: "tool_call", tool: "read_thing", input: {} };
    },
    executeTool: async () => ({ ok: true, readOnly: true }),
    shouldStopAfterTurn: () => ({ stop: false }),
    signal: controller.signal,
    maxTurns: 10,
  });
  assert.equal(result.outcome, "aborted");
  assert.equal(result.turns, 1);
});

test("agent loop: prepareNextTurn 可切换 allowedTools 并注入 steering", async () => {
  const seen = [];
  const result = await runAgentLoop({
    context: { allowedTools: ["read_thing", "commit_thing"], feedback: null, steering: ["直接提交"] },
    prepareNextTurn: (ctx) => {
      if (ctx.turn >= 2) ctx.allowedTools = ["commit_thing"];
      if (ctx.steering.length > 0) {
        ctx.feedback = (ctx.feedback ?? "") + ctx.steering.join("\n");
        ctx.steering = [];
      }
    },
    callModel: async (ctx) => {
      seen.push({ turn: ctx.turn, allowedTools: [...ctx.allowedTools], feedback: ctx.feedback });
      return { type: "tool_call", tool: "commit_thing", input: {} };
    },
    executeTool: async () => ({ ok: true, committed: true, result: { saved: true } }),
    shouldStopAfterTurn: (ctx, r) => (r.committed ? { stop: true, outcome: "completed", result: r.result } : { stop: false }),
    maxTurns: 5,
  });
  assert.equal(result.outcome, "completed");
  assert.deepEqual(seen[0].allowedTools, ["read_thing", "commit_thing"]);
  assert.equal(seen[0].feedback, "直接提交");
});
