import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runProject } from "../src/core/agent-engine.mjs";
import { createWritingProject } from "./helpers.mjs";
import { DYNAMIC_BLOCK_ORDER, PromptCompiler, STABLE_BLOCK_ORDER } from "../src/core/prompt-compiler.mjs";

test("project_memory 与 chapter_plan 属于 dynamic 顺序且不在 stable 顺序", () => {
  assert.ok(!STABLE_BLOCK_ORDER.includes("project_memory"));
  assert.ok(!STABLE_BLOCK_ORDER.includes("chapter_plan"));
  assert.deepEqual(DYNAMIC_BLOCK_ORDER.slice(0, 2), ["project_memory", "chapter_plan"]);
  assert.ok(DYNAMIC_BLOCK_ORDER.indexOf("chapter_plan") < DYNAMIC_BLOCK_ORDER.indexOf("current_task"));
});

test("跨章只变 project_memory/chapter_plan 时 stableHash 不变", () => {
  const compiler = new PromptCompiler({ templateVersion: "drafting.v1" });
  const stableBlocks = { system_rules: "rules", goal: "goal", style: "style" };
  const a = compiler.compile({
    stableBlocks,
    dynamicBlocks: { project_memory: "第一章摘要", chapter_plan: "Chapter 1 of 10.", current_task: "{}" }
  });
  const b = compiler.compile({
    stableBlocks,
    dynamicBlocks: { project_memory: "第一二章摘要，内容已变化", chapter_plan: "Chapter 2 of 10.", current_task: "{}" }
  });
  assert.equal(a.stableHash, b.stableHash);
  assert.notEqual(a.dynamicHash, b.dynamicHash);
  // 渲染顺序仍是 memory/plan 在 current_task 之前
  const memoryIndex = b.prompt.indexOf("内容已变化");
  const taskIndex = b.prompt.indexOf("current_task");
  assert.ok(memoryIndex !== -1 && memoryIndex < taskIndex);
});

test("跑完 2 章后 cache_report.json 的所有 cacheVersion 保持 1", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-cache-prefix-"));
  const { projectRoot } = await createWritingProject(root, {
    slug: "project",
    target_chapters: 2,
    min_words_per_chapter: 200,
    target_words_per_chapter: 260
  });
  await runProject(projectRoot);
  const cacheReport = JSON.parse(
    await fs.readFile(path.join(projectRoot, "cache_report.json"), "utf8")
  );
  for (const [key, entry] of Object.entries(cacheReport.entries)) {
    assert.equal(
      entry.cacheVersion,
      1,
      `entry ${key} 跨章稳定前缀不应失效，cacheVersion=${entry.cacheVersion}`
    );
  }
  assert.equal(cacheReport.last_call.stableChanged, false);
});
