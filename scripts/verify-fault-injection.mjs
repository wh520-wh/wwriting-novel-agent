import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProject, SimulatedInterrupt } from "../src/core/agent-engine.mjs";
import { readEvents } from "../src/core/event-log.mjs";
import { MockModel } from "../src/core/mock-model.mjs";
import { createProject, loadChapterIndex } from "../src/core/project-store.mjs";
import { runReviewerAgent } from "../src/core/reviewer-agent.mjs";
import { countEffectiveWords } from "../src/core/word-count.mjs";

class SeededFaultModel {
  constructor() {
    this.mock = new MockModel();
  }

  async generate(request) {
    if (request.attempt === 1 && shouldInjectInvalidOutput(request)) {
      return {
        type: "status_message",
        message: "Injected fault: model wrote status text instead of using append_chapter_segment."
      };
    }
    return this.mock.generate(request);
  }
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-faults-"));
const { projectRoot } = await createProject(root, {
  slug: "fault-injection-novel",
  target_chapters: 8,
  min_words_per_chapter: 220,
  target_words_per_chapter: 260,
  max_model_calls: 80
});

let interruptedAndRecovered = false;
try {
  await runProject(projectRoot, {
    model: new SeededFaultModel(),
    simulateInterruptAfter: {
      chapter_no: 4,
      segment_no: 1
    }
  });
} catch (error) {
  if (!(error instanceof SimulatedInterrupt)) {
    throw error;
  }
  interruptedAndRecovered = true;
}

await runProject(projectRoot, {
  model: new SeededFaultModel()
});

const index = await loadChapterIndex(projectRoot);
const completed = index.chapters.filter((chapter) => chapter.status === "completed");
assert.equal(completed.length, 8);
for (const chapter of completed) {
  const chapterPath = path.join(projectRoot, "chapters", `${String(chapter.chapter_no).padStart(3, "0")}.md`);
  const content = await fs.readFile(chapterPath, "utf8");
  assert.ok(countEffectiveWords(content) >= 220);
  assert.equal((content.match(/segment:1/gu) ?? []).length, 1);
}

const events = await readEvents(projectRoot);
const rejected = events.filter((event) => event.type === "tool_call_rejected");
assert.ok(interruptedAndRecovered);
assert.ok(rejected.length >= 1);

const review = await runReviewerAgent(projectRoot);
assert.equal(review.status, "passed");

console.log(
  JSON.stringify(
    {
      ok: true,
      projectRoot,
      chapters: completed.length,
      injectedFaults: rejected.length,
      interruptedAndRecovered,
      reviewerStatus: review.status
    },
    null,
    2
  )
);

function shouldInjectInvalidOutput(request) {
  const chapterNo = Number(request.chapter_no ?? 0);
  const segmentNo = Number(request.segment_no ?? 0);
  return (chapterNo * 17 + segmentNo * 31) % 4 === 0;
}
