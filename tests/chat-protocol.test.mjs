import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentReply, buildSystemPrompt } from "../src/core/chat/agent-protocol.mjs";
import { createToolRegistry } from "../src/core/chat/tool-registry.mjs";

test("parseAgentReply 纯文本", () => {
  const out = parseAgentReply("好的，第 9 章写到沈泽探查北围墙。");
  assert.equal(out.type, "text");
  assert.match(out.text, /北围墙/u);
});

test("parseAgentReply 围栏 JSON 工具调用（只取第一个）", () => {
  const raw = '我来查一下。\n```json\n{"tool_calls":[{"tool":"get_status","args":{}},{"tool":"get_cost","args":{}}]}\n```';
  const out = parseAgentReply(raw);
  assert.equal(out.type, "tool_call");
  assert.equal(out.call.tool, "get_status");
  assert.equal(out.dropped, 1);
  assert.match(out.leadText, /我来查一下/u);
});

test("parseAgentReply 裸 JSON 也可", () => {
  const out = parseAgentReply('{"tool_calls":[{"tool":"read_chapter","args":{"chapter_no":2}}]}');
  assert.equal(out.type, "tool_call");
  assert.equal(out.call.args.chapter_no, 2);
});

test("parseAgentReply 畸形 JSON 回落为文本", () => {
  const out = parseAgentReply('```json\n{"tool_calls": [{]}\n```');
  assert.equal(out.type, "text");
});

test("buildSystemPrompt 含工具文档与协议说明", () => {
  const registry = createToolRegistry();
  registry.register({ name: "get_status", kind: "read", description: "查状态", params: {}, run: async () => ({}) });
  const prompt = buildSystemPrompt(registry, { title: "测试书", projectStatus: "running" });
  assert.match(prompt, /get_status/u);
  assert.match(prompt, /tool_calls/u);
  assert.match(prompt, /测试书/u);
});
