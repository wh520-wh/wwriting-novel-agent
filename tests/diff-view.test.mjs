import assert from "node:assert/strict";
import test from "node:test";
import { diffLines, diffParagraphs, summarizeDiff } from "../src/app-shell/diff-view.js";

test("diffLines：改一行 → del+add，上下文 keep", () => {
  const out = diffLines("a\nb\nc", "a\nB\nc");
  assert.deepEqual(out, [
    { type: "keep", text: "a" },
    { type: "del", text: "b" },
    { type: "add", text: "B" },
    { type: "keep", text: "c" }
  ]);
});

test("diffLines：纯增/纯删/无变化/全替换", () => {
  assert.deepEqual(diffLines("a", "a\nb"), [{ type: "keep", text: "a" }, { type: "add", text: "b" }]);
  assert.deepEqual(diffLines("a\nb", "a"), [{ type: "keep", text: "a" }, { type: "del", text: "b" }]);
  assert.deepEqual(diffLines("a", "a"), [{ type: "keep", text: "a" }]);
  assert.deepEqual(diffLines("x", "y"), [{ type: "del", text: "x" }, { type: "add", text: "y" }]);
});

// ===== S4.5: 段落级 diff =====
test("diffParagraphs：按空行分段做 LCS", () => {
  const before = "甲段。\n\n乙段。\n\n丙段。";
  const after = "甲段。\n\n乙段改。\n\n丙段。";
  assert.deepEqual(diffParagraphs(before, after), [
    { type: "keep", text: "甲段。" },
    { type: "del", text: "乙段。" },
    { type: "add", text: "乙段改。" },
    { type: "keep", text: "丙段。" }
  ]);
});

test("diffParagraphs：纯新增与纯删除", () => {
  assert.deepEqual(diffParagraphs("", "新段。"), [{ type: "add", text: "新段。" }]);
  assert.deepEqual(diffParagraphs("旧段。", ""), [{ type: "del", text: "旧段。" }]);
});

test("summarizeDiff：改动段数取 del/add 较大者，字数去空白", () => {
  const rows = [
    { type: "keep", text: "甲" },
    { type: "del", text: "乙段。" },
    { type: "add", text: "乙段改了。" },
    { type: "add", text: "丁段 新增。" }
  ];
  assert.deepEqual(summarizeDiff(rows), { changedParagraphs: 2, addedChars: 10, removedChars: 3 });
});
