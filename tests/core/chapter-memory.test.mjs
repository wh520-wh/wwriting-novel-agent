import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildContinuityBriefing,
  buildContinuityPromptContext,
  CHAPTER_MEMORY_SCHEMA_VERSION,
  ENDING_EXCERPT_CHARS,
  loadChapterMemory,
  MAX_CONTEXT_CHAPTERS,
  OPENING_EXCERPT_CHARS,
  recordChapterMemory,
} from "../../src/core/chapter-memory.mjs";
import { saveContinuity } from "../../src/core/continuity-store.mjs";
import { ensureDir } from "../../src/core/fs-utils.mjs";

async function makeTmpProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-chmem-"));
  await ensureDir(path.join(dir, "memory"));
  return dir;
}

async function cleanup(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

// --- loadChapterMemory ---

test("loadChapterMemory returns empty chapters for missing file", async () => {
  const dir = await makeTmpProject();
  try {
    const memory = await loadChapterMemory(dir);
    assert.equal(memory.schema_version, CHAPTER_MEMORY_SCHEMA_VERSION);
    assert.deepEqual(memory.chapters, []);
  } finally {
    await cleanup(dir);
  }
});

test("loadChapterMemory reads existing memory file", async () => {
  const dir = await makeTmpProject();
  try {
    const data = {
      schema_version: CHAPTER_MEMORY_SCHEMA_VERSION,
      chapters: [{ chapter_no: 1, title: "Ch1", actual_words: 3000, checksum: null, opening_excerpt: "abc", ending_excerpt: "xyz" }]
    };
    await fs.writeFile(path.join(dir, "memory", "chapter_memory.json"), JSON.stringify(data), "utf8");
    const memory = await loadChapterMemory(dir);
    assert.equal(memory.chapters.length, 1);
    assert.equal(memory.chapters[0].chapter_no, 1);
    assert.equal(memory.chapters[0].title, "Ch1");
  } finally {
    await cleanup(dir);
  }
});

test("loadChapterMemory normalizes and sorts corrupt data", async () => {
  const dir = await makeTmpProject();
  try {
    const data = {
      chapters: [
        { chapter_no: 3, title: "Three" },
        { chapter_no: "not-a-number" },
        { chapter_no: -1 },
        { chapter_no: 1, title: "One" },
      ]
    };
    await fs.writeFile(path.join(dir, "memory", "chapter_memory.json"), JSON.stringify(data), "utf8");
    const memory = await loadChapterMemory(dir);
    // "not-a-number" => NaN, -1 => filtered out
    assert.equal(memory.chapters.length, 2);
    assert.equal(memory.chapters[0].chapter_no, 1);
    assert.equal(memory.chapters[1].chapter_no, 3);
  } finally {
    await cleanup(dir);
  }
});

// --- recordChapterMemory ---

test("recordChapterMemory creates new entry and sorts by chapter_no", async () => {
  const dir = await makeTmpProject();
  try {
    const result = await recordChapterMemory(dir, { chapterNo: 1, title: "Chapter One", content: "Hello world.", actualWords: 100 });
    assert.equal(result.chapters.length, 1);
    assert.equal(result.chapters[0].chapter_no, 1);
    assert.equal(result.chapters[0].title, "Chapter One");
    assert.equal(result.chapters[0].actual_words, 100);
    // file should exist
    const saved = JSON.parse(await fs.readFile(path.join(dir, "memory", "chapter_memory.json"), "utf8"));
    assert.equal(saved.chapters.length, 1);
  } finally {
    await cleanup(dir);
  }
});

test("recordChapterMemory replaces existing chapter with same number", async () => {
  const dir = await makeTmpProject();
  try {
    await recordChapterMemory(dir, { chapterNo: 1, title: "V1", content: "First version.", actualWords: 50 });
    await recordChapterMemory(dir, { chapterNo: 1, title: "V2", content: "Second version.", actualWords: 60 });
    const memory = await loadChapterMemory(dir);
    assert.equal(memory.chapters.length, 1);
    assert.equal(memory.chapters[0].title, "V2");
    assert.equal(memory.chapters[0].actual_words, 60);
  } finally {
    await cleanup(dir);
  }
});

test("recordChapterMemory rejects invalid chapterNo", async () => {
  const dir = await makeTmpProject();
  try {
    await assert.rejects(() => recordChapterMemory(dir, { chapterNo: 0, content: "x" }), /positive integer/);
    await assert.rejects(() => recordChapterMemory(dir, { chapterNo: -5, content: "x" }), /positive integer/);
    await assert.rejects(() => recordChapterMemory(dir, { chapterNo: "abc", content: "x" }), /positive integer/);
  } finally {
    await cleanup(dir);
  }
});

test("recordChapterMemory extracts opening and ending excerpts", async () => {
  const dir = await makeTmpProject();
  try {
    const longContent = "A".repeat(2000) + " " + "B".repeat(2000);
    const result = await recordChapterMemory(dir, { chapterNo: 1, content: longContent, actualWords: 4000 });
    const ch = result.chapters[0];
    // opening excerpt should start with A's
    assert.ok(ch.opening_excerpt.startsWith("A"));
    // ending excerpt should end with B's (or have ellipsis prefix)
    assert.ok(ch.ending_excerpt.endsWith("B") || ch.ending_excerpt.startsWith("…"));
  } finally {
    await cleanup(dir);
  }
});

test("recordChapterMemory strips HTML comments from excerpts", async () => {
  const dir = await makeTmpProject();
  try {
    const content = "Before. <!-- hidden --> After content.";
    const result = await recordChapterMemory(dir, { chapterNo: 1, content });
    const ch = result.chapters[0];
    assert.ok(!ch.opening_excerpt.includes("<!--"));
    assert.ok(ch.opening_excerpt.includes("Before."));
    assert.ok(ch.opening_excerpt.includes("After content."));
  } finally {
    await cleanup(dir);
  }
});

test("recordChapterMemory defaults title when not provided", async () => {
  const dir = await makeTmpProject();
  try {
    const result = await recordChapterMemory(dir, { chapterNo: 5, content: "content" });
    assert.equal(result.chapters[0].title, "第005章");
  } finally {
    await cleanup(dir);
  }
});

// --- buildContinuityPromptContext ---

test("buildContinuityPromptContext returns special message for chapter 1 with no previous chapters", async () => {
  const dir = await makeTmpProject();
  try {
    const ctx = await buildContinuityPromptContext(dir, 1);
    assert.ok(ctx.includes("第 1 章可以建立初始处境"));
    assert.ok(ctx.includes("当前目标章节：第 1 章"));
  } finally {
    await cleanup(dir);
  }
});

test("buildContinuityPromptContext includes previous chapters up to MAX_CONTEXT_CHAPTERS", async () => {
  const dir = await makeTmpProject();
  try {
    for (let i = 1; i <= 6; i++) {
      await recordChapterMemory(dir, { chapterNo: i, title: `Ch${i}`, content: `Content of chapter ${i}.`, actualWords: 100 * i });
    }
    const ctx = await buildContinuityPromptContext(dir, 7);
    // Should include up to MAX_CONTEXT_CHAPTERS (2) previous chapters: 5,6
    for (let i = 5; i <= 6; i++) {
      assert.ok(ctx.includes(`第 ${i} 章`), `should include chapter ${i}`);
    }
    // chapters 1-4 should NOT be in context
    assert.ok(!ctx.includes("第 1 章："));
    assert.ok(!ctx.includes("第 2 章："));
    assert.ok(!ctx.includes("第 3 章："));
    assert.ok(!ctx.includes("第 4 章："));
  } finally {
    await cleanup(dir);
  }
});

test("buildContinuityPromptContext excludes current and future chapters", async () => {
  const dir = await makeTmpProject();
  try {
    await recordChapterMemory(dir, { chapterNo: 1, content: "ch1", actualWords: 10 });
    await recordChapterMemory(dir, { chapterNo: 2, content: "ch2", actualWords: 10 });
    await recordChapterMemory(dir, { chapterNo: 3, content: "ch3", actualWords: 10 });
    const ctx = await buildContinuityPromptContext(dir, 2);
    // chapter 2 is the target, so only chapter 1 should appear
    assert.ok(ctx.includes("第 1 章"));
    assert.ok(!ctx.includes("第 2 章："));
    assert.ok(!ctx.includes("第 3 章"));
  } finally {
    await cleanup(dir);
  }
});

// --- exported constants ---

test("exported constants have expected values", () => {
  assert.equal(CHAPTER_MEMORY_SCHEMA_VERSION, 1);
  assert.equal(MAX_CONTEXT_CHAPTERS, 2);
  assert.equal(OPENING_EXCERPT_CHARS, 420);
  assert.equal(ENDING_EXCERPT_CHARS, 900);
});

// ---------------------------------------------------------------------------
// 第十六轮 T1/T5：前情简报组装（read_continuity 工具的数据源）
// ---------------------------------------------------------------------------

test("buildContinuityBriefing: 空项目 = 第 1 章初始处境话术", async () => {
  const root = await makeTmpProject();
  const content = await buildContinuityBriefing(root, {});
  assert.match(content, /第 1 章可以建立初始处境/u);
});

test("buildContinuityBriefing: 三块组装 + 伏笔按埋设章排序 top5", async () => {
  const root = await makeTmpProject();
  await recordChapterMemory(root, { chapterNo: 1, title: "开端", content: "a".repeat(2000), actualWords: 2000 });
  const foreshadows = Array.from({ length: 7 }, (_, i) => ({
    content: `伏笔${i + 1}`, planted_chapter: i + 1, expected_payoff_hint: "", status: "open", paid_chapter: null
  }));
  await saveContinuity(root, {
    schema_version: 3,
    facts: [{ entity: "主角", attribute: "佩剑", value: "断剑", chapter_no: 1, quote: "", conflict_with: null }],
    timeline: [],
    characters: [{ name: "主角", traits: ["冷静"], status: "在场", chapter_no: 1 }],
    foreshadows
  });
  const content = await buildContinuityBriefing(root, {});
  assert.match(content, /第 1 章：开端/u);
  assert.match(content, /### 关键事实/u);
  assert.match(content, /伏笔1/u);
  assert.match(content, /伏笔5/u);
  assert.doesNotMatch(content, /伏笔6/u);
  assert.match(content, /距今 1 章未收/u);
});

test("buildContinuityBriefing: entity 命中与未命中", async () => {
  const root = await makeTmpProject();
  await saveContinuity(root, {
    schema_version: 3,
    facts: [{ entity: "主角", attribute: "佩剑", value: "断剑", chapter_no: 1, quote: "", conflict_with: null }],
    timeline: [], characters: [], foreshadows: []
  });
  assert.match(await buildContinuityBriefing(root, { entity: "主角" }), /断剑/u);
  assert.match(await buildContinuityBriefing(root, { entity: "路人" }), /未找到实体/u);
});
