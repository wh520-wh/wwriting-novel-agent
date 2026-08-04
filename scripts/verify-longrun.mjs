import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createProject, loadChapterIndex, loadState, saveState } from "../src/core/project-store.mjs";
import { readEvents } from "../src/core/event-log.mjs";
import { runProject } from "../src/core/agent-engine.mjs";
import { countEffectiveWords } from "../src/core/word-count.mjs";

const root = path.resolve(".demo_runs", `longrun-${Date.now()}`);
const { projectRoot } = await createProject(root, {
  slug: "twenty-chapter-novel",
  title: "Twenty Chapter Longrun",
  story_seed: "A long-form suspense novel generated through durable local files.",
  target_chapters: 20,
  min_words_per_chapter: 300,
  target_words_per_chapter: 360,
  max_model_calls: 120
});
// 蓝图门禁（spec §1.4）：新建项目 blueprint_status 默认 "none"，写作入口会拒绝。
// 预置 complete 放行（与 tests/helpers.mjs createWritingProject 同款模式）。
const blueprintState = await loadState(projectRoot);
blueprintState.blueprint_status = "complete";
await saveState(projectRoot, blueprintState);

const result = await runProject(projectRoot, { maxSteps: 2000 });
assert.equal(result.completed, true, "project must complete the 20 chapter run");

const state = await loadState(projectRoot);
assert.equal(state.project_status, "completed");
assert.equal(state.current_stage, "completed");

const index = await loadChapterIndex(projectRoot);
assert.equal(index.chapters.filter((chapter) => chapter.status === "completed").length, 20);

for (const chapterNo of Array.from({ length: 20 }, (_, index) => index + 1)) {
  const finalPath = path.join(projectRoot, "chapters", `${String(chapterNo).padStart(3, "0")}.md`);
  const content = await fs.readFile(finalPath, "utf8");
  const words = countEffectiveWords(content);
  assert.ok(words >= 300, `chapter ${chapterNo} is below the minimum word count: ${words}`);
  const segmentMatches = content.match(/segment:\d+/gu) ?? [];
  assert.equal(new Set(segmentMatches).size, segmentMatches.length, `chapter ${chapterNo} has duplicate segment markers`);
}

const events = await readEvents(projectRoot);
assert.ok(events.some((event) => event.type === "checkpoint_written"), "checkpoints must be written");
assert.equal(events.filter((event) => event.type === "chapter_completed").length, 20);
assert.ok(events.some((event) => event.type === "model_usage_recorded"), "model usage must be recorded");
assert.ok(events.some((event) => event.type === "cache_report_updated"), "cache report updates must be recorded");

const cost = JSON.parse(await fs.readFile(path.join(projectRoot, "cost.json"), "utf8"));
const cache = JSON.parse(await fs.readFile(path.join(projectRoot, "cache_report.json"), "utf8"));
assert.ok(cost.calls >= 20, "cost report must include model calls");
assert.ok(cost.totalTokens > 0, "cost report must include token counts");
assert.ok(cache.last_call.cacheKey, "cache report must include the last cache key");

console.log(
  JSON.stringify(
    {
      ok: true,
      projectRoot,
      chapters: 20,
      minWordsPerChapter: 300,
      modelCalls: cost.calls,
      cacheKey: cache.last_call.cacheKey
    },
    null,
    2
  )
);
