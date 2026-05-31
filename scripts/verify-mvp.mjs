import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createProject } from "../src/core/project-store.mjs";
import { runProject, SimulatedInterrupt } from "../src/core/agent-engine.mjs";
import { countEffectiveWords } from "../src/core/word-count.mjs";
import { readEvents } from "../src/core/event-log.mjs";

const root = path.resolve(".demo_runs", `mvp-${Date.now()}`);
const { projectRoot } = await createProject(root, {
  slug: "demo-novel",
  title: "雨夜来信",
  story_seed: "雨夜里，一名落魄写手收到一封来自十年后的信。",
  target_chapters: 3,
  min_words_per_chapter: 3000,
  target_words_per_chapter: 3300
});

let interrupted = false;
try {
  await runProject(projectRoot, {
    simulateInterruptAfter: {
      chapter_no: 2,
      segment_no: 1
    }
  });
} catch (error) {
  if (error instanceof SimulatedInterrupt) {
    interrupted = true;
  } else {
    throw error;
  }
}
assert.equal(interrupted, true, "第 2 章中途模拟中断必须触发");

await runProject(projectRoot);

for (const chapterNo of [1, 2, 3]) {
  const file = path.join(projectRoot, "chapters", `${String(chapterNo).padStart(3, "0")}.md`);
  const content = await fs.readFile(file, "utf8");
  const words = countEffectiveWords(content);
  assert.ok(words >= 3000, `第 ${chapterNo} 章有效字数不足: ${words}`);
}

const events = await readEvents(projectRoot);
assert.ok(events.some((event) => event.type === "checkpoint_written"), "必须写入 checkpoint 事件");
assert.ok(events.some((event) => event.type === "chapter_completed" && event.chapter_no === 3), "第 3 章必须完成");

console.log(JSON.stringify({
  ok: true,
  projectRoot,
  chapters: 3,
  minWordsPerChapter: 3000,
  interruptedAndRecovered: true
}, null, 2));

