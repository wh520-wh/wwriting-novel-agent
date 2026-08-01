import assert from "node:assert/strict";
import test from "node:test";
import { ToolTranscript } from "../src/core/agent-transcript.mjs";

test("ToolTranscript 单轮：user -> assistant -> 提交 toMessages", () => {
  const t = new ToolTranscript();
  t.appendUser("写第 1 章第 1 段");
  t.appendAssistant({ content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "append_chapter_segment", arguments: '{"content":"正文"}' } }] });
  const msgs = t.toMessages();
  assert.equal(msgs[0].role, "user");
  assert.equal(msgs[1].role, "assistant");
  assert.equal(msgs[1].tool_calls[0].id, "call_1");
});

test("ToolTranscript 多轮：assistant tool_calls + role=tool 结果完整回传", () => {
  const t = new ToolTranscript();
  t.appendUser("写章");
  t.appendAssistant({ content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_chapter", arguments: '{"chapter_no":1}' } }] });
  t.appendToolResult("c1", { chapter_no: 1, content: "前文" });
  t.appendAssistant({ content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "append_chapter_segment", arguments: '{"content":"新段"}' } }] });
  const msgs = t.toMessages();
  assert.equal(msgs.length, 4);
  assert.equal(msgs[2].role, "tool");
  assert.equal(msgs[2].tool_call_id, "c1");
  assert.equal(msgs[3].role, "assistant");
  assert.equal(msgs[3].tool_calls[0].id, "c2");
});

test("ToolTranscript 保存 reasoning_content（DeepSeek thinking 多轮要求）", () => {
  const t = new ToolTranscript();
  t.appendUser("写章");
  t.appendAssistant({ content: null, reasoning_content: "思考过程", tool_calls: [{ id: "c1", type: "function", function: { name: "get_status", arguments: "{}" } }] });
  t.appendToolResult("c1", { ok: true });
  const msgs = t.toMessages();
  assert.equal(msgs[1].reasoning_content, "思考过程");
});

test("pendingToolCalls: assistant 发起但未回传结果的 tool_calls", () => {
  const t = new ToolTranscript();
  t.appendUser("写章");
  t.appendAssistant({ content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_chapter", arguments: "{}" } }] });
  assert.equal(t.pendingToolCalls.length, 1);
  assert.equal(t.pendingToolCalls[0].id, "c1");
  t.appendToolResult("c1", { ok: true });
  assert.equal(t.pendingToolCalls.length, 0);
});

test("pendingToolCalls: 无 id 的 tool_call 被跳过（无法匹配 result）", () => {
  const t = new ToolTranscript();
  t.appendUser("写章");
  t.appendAssistant({ content: null, tool_calls: [{ type: "function", function: { name: "read_chapter", arguments: "{}" } }] });
  assert.equal(t.pendingToolCalls.length, 0);
});

test("appendToolResult 截断超长 result（防多轮 transcript 超上下文）", () => {
  const t = new ToolTranscript();
  t.appendUser("写章");
  t.appendAssistant({ content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_chapter", arguments: "{}" } }] });
  const longResult = { content: "x".repeat(5000) };
  t.appendToolResult("c1", longResult);
  const toolMsg = t.toMessages().find((m) => m.role === "tool");
  assert.ok(toolMsg.content.length <= 4001, `截断后应 <= 4001 字符，实际 ${toolMsg.content.length}`);
  assert.ok(toolMsg.content.includes("…"), "截断后应带省略号标记");
});

test("serialize + restore: 循环不变量", () => {
  const t = new ToolTranscript();
  t.appendUser("写章");
  t.appendAssistant({ content: null, reasoning_content: "思考", tool_calls: [{ id: "c1", type: "function", function: { name: "read_chapter", arguments: '{"chapter_no":1}' } }] });
  t.appendToolResult("c1", { chapter_no: 1 });
  const serialized = JSON.parse(JSON.stringify(t.serialize()));
  const restored = ToolTranscript.restore(serialized);
  assert.deepEqual(restored.toMessages(), t.toMessages());
  assert.equal(restored.pendingToolCalls.length, 0);
});

test("restore 带 pendingToolCalls: 恢复时识别未完成 tool_call", () => {
  const t = new ToolTranscript();
  t.appendUser("写章");
  t.appendAssistant({ content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_chapter", arguments: "{}" } }] });
  const restored = ToolTranscript.restore(t.serialize());
  assert.equal(restored.pendingToolCalls.length, 1);
  assert.equal(restored.pendingToolCalls[0].id, "c1");
});
