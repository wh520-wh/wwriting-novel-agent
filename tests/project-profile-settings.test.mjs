import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { updateProjectSettings } from "../src/core/settings-runtime.mjs";
import { createProject, loadProject, loadState, saveState } from "../src/core/project-store.mjs";
import { readEvents } from "../src/core/event-log.mjs";

async function makeProject(prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 3,
    min_words_per_chapter: 300,
    target_words_per_chapter: 360
  });
  return projectRoot;
}

test("project_profile can update title / target_chapters / min_words_per_chapter", async () => {
  const projectRoot = await makeProject("wwriting-profile-");
  const next = await updateProjectSettings(projectRoot, {
    project_profile: { title: "新标题", target_chapters: 10, min_words_per_chapter: 500 }
  });
  assert.equal(next.title, "新标题");
  assert.equal(next.target_chapters, 10);
  assert.equal(next.min_words_per_chapter, 500);
  assert.ok(next.target_words_per_chapter >= 500, "target_words must not be below min_words");
  const onDisk = await loadProject(projectRoot);
  assert.equal(onDisk.target_chapters, 10);
});

test("raising target_chapters reopens a completed project", async () => {
  const projectRoot = await makeProject("wwriting-reopen-");
  const state = await loadState(projectRoot);
  await saveState(projectRoot, {
    ...state,
    project_status: "completed",
    current_stage: "completed",
    current_chapter_no: 4
  });
  await updateProjectSettings(projectRoot, { project_profile: { target_chapters: 6 } });
  const next = await loadState(projectRoot);
  assert.equal(next.project_status, "idle");
  assert.equal(next.current_stage, "queued");
  const events = await readEvents(projectRoot);
  assert.ok(events.some((e) => e.type === "project_reopened"));
});

test("target_chapters below written chapters does not reopen", async () => {
  const projectRoot = await makeProject("wwriting-noreopen-");
  const state = await loadState(projectRoot);
  await saveState(projectRoot, {
    ...state,
    project_status: "completed",
    current_stage: "completed",
    current_chapter_no: 4
  });
  await updateProjectSettings(projectRoot, { project_profile: { target_chapters: 2 } });
  const next = await loadState(projectRoot);
  assert.equal(next.project_status, "completed");
});
