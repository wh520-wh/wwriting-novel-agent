import assert from "node:assert/strict";
import test from "node:test";
import { countEffectiveWords } from "../src/core/word-count.mjs";

test("countEffectiveWords excludes markdown structure and counts visible text", () => {
  const text = `---
title: Hidden
---
# 标题不算正文

<!-- segment:1 -->
雨夜里他收到信。The clue returns in 2026.`;
  assert.equal(countEffectiveWords(text), 12);
});
