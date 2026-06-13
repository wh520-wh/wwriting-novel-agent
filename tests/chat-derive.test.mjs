// tests/chat-derive.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { deriveSources, deriveSuggestions } from "../src/app-shell/chat-derive.mjs";

const msgs = [
  { id: "u1", role: "user", content: "早些的问题" },
  { id: "t0", role: "tool", tool: "read_outline", ok: true, args: "{}", result_summary: "old" },
  { id: "a1", role: "assistant", content: "早些的回答" },
  { id: "u2", role: "user", content: "主角第3章干了什么？" },
  { id: "t1", role: "tool", tool: "read_chapter", ok: true, args: '{"chapter_no":3}', result_summary: '{"words":1200}' },
  { id: "t2", role: "tool", tool: "read_continuity", ok: true, args: "{}", result_summary: "{}" },
  { id: "t3", role: "tool", tool: "read_chapter", ok: true, args: '{"chapter_no":3}', result_summary: "{}" },
  { id: "t4", role: "tool", tool: "edit_chapter", ok: true, args: '{"chapter_no":3}', result_summary: "{}" },
  { id: "t5", role: "tool", tool: "get_status", ok: false, args: "{}", result_summary: "err" },
  { id: "a2", role: "assistant", content: "他点了灯。" }
];

test("deriveSources：窗口=上一条 user 之后；只取 ok 的 read 工具；按 label 去重", () => {
  const chips = deriveSources(msgs, msgs.at(-1));
  assert.deepEqual(chips.map((c) => c.label), ["第 3 章", "设定记忆"]);
  assert.equal(chips[0].chapterNo, 3);
  assert.equal(chips[0].resultSummary, '{"words":1200}');
});

test("deriveSources：找不到消息时返回 []", () => {
  assert.deepEqual(deriveSources(msgs, { id: "nope" }), []);
  assert.deepEqual(deriveSources(msgs, null), []);
});

test("deriveSources：a1 的窗口只含 u1 之后的 read_outline", () => {
  const chips = deriveSources(msgs, msgs[2]);
  assert.deepEqual(chips.map((c) => c.label), ["大纲"]);
});

test("deriveSuggestions：归档项目", () => {
  const s = deriveSuggestions({ project: { archived_at: "2026-06-01" }, summary: {}, chapters: [] });
  assert.deepEqual(s.map((x) => x.label), ["导出成书", "解除归档"]);
});

test("deriveSuggestions：有待修订章节", () => {
  const s = deriveSuggestions({
    project: {}, summary: { completedChapters: 4, targetChapters: 10 },
    chapters: [{ chapter_no: 3, status: "needs_revision" }]
  });
  assert.equal(s[0].label, "处理第 3 章的待修订");
  assert.equal(s.length, 3);
});

test("deriveSuggestions：全部完成", () => {
  const s = deriveSuggestions({ project: {}, summary: { completedChapters: 10, targetChapters: 10 }, chapters: [] });
  assert.deepEqual(s.map((x) => x.label), ["导出成书", "把目标章节数提高 10 章再续写"]);
});

test("deriveSuggestions：写作中段", () => {
  const s = deriveSuggestions({ project: {}, summary: { completedChapters: 4, targetChapters: 10 }, chapters: [] });
  assert.deepEqual(s.map((x) => x.label), ["续写下一章（第 5 章）", "回顾第 4 章的结尾", "目前花了多少钱？"]);
});

test("deriveSuggestions：新项目", () => {
  const s = deriveSuggestions({ project: {}, summary: { completedChapters: 0, targetChapters: 10 }, chapters: [] });
  assert.deepEqual(s.map((x) => x.label), ["排 5 章试写", "这本书的设定是什么？", "帮我完善大纲"]);
});

test("deriveSuggestions：message 默认等于 label，可直接发送", () => {
  const s = deriveSuggestions({ project: {}, summary: {}, chapters: [] });
  for (const item of s) assert.equal(typeof item.message, "string");
});
