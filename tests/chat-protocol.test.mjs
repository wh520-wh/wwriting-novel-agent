import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentReply, buildSystemPrompt } from "../src/core/chat/agent-protocol.mjs";
import { createToolRegistry } from "../src/core/chat/tool-registry.mjs";

test("parseAgentReply 纯文本", () => {
  const out = parseAgentReply("好的，第 9 章写到沈泽探查北围墙。");
  assert.equal(out.type, "text");
  assert.match(out.text, /北围墙/u);
});

test("parseAgentReply 围栏 JSON 工具调用（返回全部 tool_calls）", () => {
  const raw = '我来查一下。\n```json\n{"tool_calls":[{"tool":"get_status","args":{}},{"tool":"read_chapter","args":{"chapter_no":3}}]}\n```';
  const out = parseAgentReply(raw);
  assert.equal(out.type, "tool_call");
  assert.equal(out.call.tool, "get_status");
  assert.equal(out.tool_calls.length, 2);
  assert.equal(out.tool_calls[0].tool, "get_status");
  assert.equal(out.tool_calls[1].tool, "read_chapter");
  assert.equal(out.tool_calls[1].args.chapter_no, 3);
  assert.match(out.leadText, /我来查一下/u);
});

test("parseAgentReply 裸 JSON 也可", () => {
  const out = parseAgentReply('{"tool_calls":[{"tool":"read_chapter","args":{"chapter_no":2}}]}');
  assert.equal(out.type, "tool_call");
  assert.equal(out.call.args.chapter_no, 2);
});

test("parseAgentReply 识别 XML tool_call 包装并隐藏协议标记", () => {
  const raw = [
    "看起来任务队列是空的，我先安排第一章。",
    "<tool_call>",
    "<tool_call>",
    '{"tool_calls":[{"tool":"queue_chapters","args":{"instruction":"开始写第1章"}}]}',
    "</tool_call>",
    "</tool_call>"
  ].join("\n");
  const out = parseAgentReply(raw);
  assert.equal(out.type, "tool_call");
  assert.equal(out.call.tool, "queue_chapters");
  assert.deepEqual(out.call.args, { instruction: "开始写第1章" });
  assert.equal(out.leadText, "看起来任务队列是空的，我先安排第一章。");
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

// ===== S4.5: 多围栏扫描 + 稿块约定 =====
test("稿块围栏在前、tool call 围栏在后：调用不丢失，稿块留在 leadText", () => {
  const reply = [
    "开场我先给你看一段：",
    "```稿",
    "夜雨敲窗，他点了灯。",
    "```",
    '```json',
    '{"tool_calls":[{"tool":"read_chapter","args":{"chapter_no":2}}]}',
    "```"
  ].join("\n");
  const parsed = parseAgentReply(reply);
  assert.equal(parsed.type, "tool_call");
  assert.equal(parsed.call.tool, "read_chapter");
  assert.deepEqual(parsed.call.args, { chapter_no: 2 });
  assert.ok(parsed.leadText.includes("```稿"), "稿块应保留在 leadText 中");
  assert.ok(parsed.leadText.includes("夜雨敲窗"));
});

test("只有稿块围栏（无 tool call）：整体按文本返回", () => {
  const reply = "```稿\n正文片段。\n```\n\n这是说明。";
  const parsed = parseAgentReply(reply);
  assert.equal(parsed.type, "text");
  assert.equal(parsed.text, reply);
});

test("多个非 JSON 围栏 + 裸 JSON tool call：裸 JSON 仍可解析", () => {
  const parsed = parseAgentReply('{"tool_calls":[{"tool":"get_status","args":{}}]}');
  assert.equal(parsed.type, "tool_call");
  assert.equal(parsed.call.tool, "get_status");
});

test("buildSystemPrompt 包含稿块约定", () => {
  const registry = { list: () => [] };
  const prompt = buildSystemPrompt(registry, {});
  assert.match(prompt, /```稿/u);
});
