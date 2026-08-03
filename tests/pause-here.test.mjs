import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runProject } from "../src/core/agent-engine.mjs";
import { appendEvent, readEvents } from "../src/core/event-log.mjs";
import { loadChapterIndex, loadState } from "../src/core/project-store.mjs";
import { createWritingProject } from "./helpers.mjs";

test("历史 pause-here 事件不会阻止新一轮运行", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-pause-stale-"));
  const { projectRoot } = await createWritingProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 300,
    target_words_per_chapter: 360
  });
  await appendEvent(projectRoot, { type: "failure_resolved", severity: "info", message: "pause-here", data: { failureId: "old" } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const result = await runProject(projectRoot);
  assert.equal(result.completed, true);
  const index = await loadChapterIndex(projectRoot);
  assert.equal(index.chapters.filter((c) => c.status === "completed").length, 1);
});

test("运行中收到 pause-here 会干净暂停并返回 paused 结果", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-pause-fresh-"));
  const { projectRoot } = await createWritingProject(root, {
    slug: "project",
    target_chapters: 3,
    min_words_per_chapter: 300,
    target_words_per_chapter: 360
  });
  let injected = false;
  const result = await runProject(projectRoot, {
    onHeartbeat: async () => {
      if (!injected) {
        injected = true;
        await appendEvent(projectRoot, { type: "failure_resolved", severity: "info", message: "pause-here", data: { failureId: "fresh" } });
      }
    }
  });
  assert.equal(result.paused, true);
  assert.equal(result.completed, false);
  const state = await loadState(projectRoot);
  assert.equal(state.project_status, "paused");
  const events = await readEvents(projectRoot);
  assert.ok(events.some((e) => e.type === "project_paused"));
});

test("运行中收到 manual-review-handoff 也会暂停（与 pause-here 同效）", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-pause-handoff-"));
  const { projectRoot } = await createWritingProject(root, {
    slug: "project",
    target_chapters: 3,
    min_words_per_chapter: 300,
    target_words_per_chapter: 360
  });
  let injected = false;
  const result = await runProject(projectRoot, {
    onHeartbeat: async () => {
      if (!injected) {
        injected = true;
        await appendEvent(projectRoot, { type: "failure_resolved", severity: "info", message: "manual-review-handoff", data: { failureId: "handoff" } });
      }
    }
  });
  assert.equal(result.paused, true);
  const state = await loadState(projectRoot);
  assert.equal(state.project_status, "paused");
});
