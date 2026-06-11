import assert from "node:assert/strict";
import test from "node:test";
import {
  PromptCompiler,
  STABLE_BLOCK_ORDER,
  DYNAMIC_BLOCK_ORDER,
  computeChapterWordGap
} from "../src/core/prompt-compiler.mjs";

// --- computeChapterWordGap ---

test("computeChapterWordGap 返回已写字数与剩余缺口", () => {
  // 1 个汉字算 1 个 effective word；1200 个字 = 1200
  const gap = computeChapterWordGap({
    draftContent: "字".repeat(1200),
    minWords: 3000
  });
  assert.equal(gap.chapterWordsWritten, 1200);
  assert.equal(gap.chapterWordsRemaining, 1800);
});

test("computeChapterWordGap 字数已达标时剩余为 0", () => {
  const gap = computeChapterWordGap({
    draftContent: "字".repeat(3200),
    minWords: 3000
  });
  assert.equal(gap.chapterWordsWritten, 3200);
  assert.equal(gap.chapterWordsRemaining, 0);
});

test("computeChapterWordGap draft 为空时已写为 0、剩余为 minWords", () => {
  const gap = computeChapterWordGap({ draftContent: "", minWords: 3000 });
  assert.equal(gap.chapterWordsWritten, 0);
  assert.equal(gap.chapterWordsRemaining, 3000);
});

test("computeChapterWordGap draftContent 为 null/undefined 时不抛错", () => {
  const fromNull = computeChapterWordGap({ draftContent: null, minWords: 3000 });
  assert.equal(fromNull.chapterWordsWritten, 0);
  assert.equal(fromNull.chapterWordsRemaining, 3000);
  const fromUndefined = computeChapterWordGap({ draftContent: undefined, minWords: 3000 });
  assert.equal(fromUndefined.chapterWordsWritten, 0);
  assert.equal(fromUndefined.chapterWordsRemaining, 3000);
});

test("computeChapterWordGap minWords 缺失时按 3000 默认值兜底", () => {
  const gap = computeChapterWordGap({ draftContent: "字".repeat(1500) });
  assert.equal(gap.chapterWordsWritten, 1500);
  assert.equal(gap.chapterWordsRemaining, 1500);
});

test("computeChapterWordGap 缺口为负数时裁剪为 0", () => {
  const gap = computeChapterWordGap({ draftContent: "字".repeat(5000), minWords: 3000 });
  assert.equal(gap.chapterWordsWritten, 5000);
  assert.equal(gap.chapterWordsRemaining, 0);
});

// --- PromptCompiler stable / dynamic block ordering ---

test("PromptCompiler 把传入的稳定块按 STABLE_BLOCK_ORDER 排序", () => {
  const compiler = new PromptCompiler({ templateVersion: "drafting.v1" });
  const compiled = compiler.compile({
    stableBlocks: {
      outline: "O",
      goal: "G",
      system_rules: "SR"
    },
    dynamicBlocks: {}
  });
  const stableNames = compiled.blocks.filter((b) => b.kind === "stable").map((b) => b.name);
  // 传入的 3 个块按 STABLE_BLOCK_ORDER 中出现顺序排好
  assert.deepEqual(stableNames, ["system_rules", "goal", "outline"]);
});

test("PromptCompiler 把传入的动态块按 DYNAMIC_BLOCK_ORDER 排序", () => {
  const compiler = new PromptCompiler();
  const compiled = compiler.compile({
    stableBlocks: {},
    dynamicBlocks: {
      recent_trace_summary: "trace",
      current_task: "task",
      chapter_plan: "plan"
    }
  });
  const dynamicNames = compiled.blocks.filter((b) => b.kind === "dynamic").map((b) => b.name);
  // 传入的 3 个块按 DYNAMIC_BLOCK_ORDER 排好
  assert.deepEqual(dynamicNames, ["chapter_plan", "current_task", "recent_trace_summary"]);
});

test("PromptCompiler 暴露稳定的 stableHash 与 dynamicHash（相同输入产出相同哈希）", () => {
  const compiler = new PromptCompiler({ templateVersion: "drafting.test" });
  const a = compiler.compile({
    stableBlocks: { system_rules: "sr" },
    dynamicBlocks: { current_task: "ct" }
  });
  const b = compiler.compile({
    stableBlocks: { system_rules: "sr" },
    dynamicBlocks: { current_task: "ct" }
  });
  assert.equal(typeof a.stableHash, "string");
  assert.equal(typeof a.dynamicHash, "string");
  assert.equal(a.stableHash, b.stableHash);
  assert.equal(a.dynamicHash, b.dynamicHash);
});
