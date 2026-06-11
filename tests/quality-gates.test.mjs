import assert from "node:assert/strict";
import test from "node:test";
import { runTitleGate, runWordCapGate, parseChineseChapterNo } from "../src/core/quality-gates.mjs";

const TITLE_BAD_SAMPLE = "# 第一章\n\n正文…\n\n## 第二章（第1章续）\n\n续写正文…";

test("runTitleGate 正确标题 passed", () => {
  const out = runTitleGate("# 第一章\n\n正文", 1);
  assert.equal(out.status, "passed");
  assert.equal(out.found_title, "第一章");
});

test("runTitleGate 错位标题 failed，含 found_title 与 line", () => {
  const out = runTitleGate(TITLE_BAD_SAMPLE, 1);
  assert.equal(out.status, "failed");
  assert.match(out.found_title, /第二章/u);
  assert.equal(out.gate, "chapter-title-gate");
  assert.ok(out.line >= 1);
});

test("runTitleGate 中文数字解析", () => {
  assert.equal(parseChineseChapterNo("第十二章"), 12);
  assert.equal(parseChineseChapterNo("第一百二十三章"), 123);
  assert.equal(parseChineseChapterNo("第9章"), 9);
});

test("runWordCapGate 超标 warning + overflow 正确", () => {
  const out = runWordCapGate(5147, { targetWords: 3300 });
  assert.equal(out.status, "warning");
  assert.equal(out.actual_words, 5147);
  assert.equal(out.max_words, 4950);
  assert.equal(out.overflow_words, 197);
  assert.equal(out.gate, "word-cap-gate");
});

test("runWordCapGate 不超标 passed", () => {
  const out = runWordCapGate(4000, { targetWords: 3300 });
  assert.equal(out.status, "passed");
  assert.equal(out.actual_words, 4000);
});

test("runWordCapGate 有价时 cost 估算 > 0", () => {
  const out = runWordCapGate(5147, { targetWords: 3300, outputPricePerMillion: 6 });
  assert.ok(out.overflow_cost_estimate > 0);
});

test("runWordCapGate 无价时 cost 估算 null", () => {
  const out = runWordCapGate(5147, { targetWords: 3300 });
  assert.equal(out.overflow_cost_estimate, null);
});
