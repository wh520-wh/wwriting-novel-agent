import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { updateProjectSettings } from "../src/core/settings-runtime.mjs";
import { createProject, loadProject } from "../src/core/project-store.mjs";
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

test("raising target_chapters 只改配置真相源，不再写运行态/发出重开事件", async () => {
  const projectRoot = await makeProject("wwriting-reopen-");
  const next = await updateProjectSettings(projectRoot, { project_profile: { target_chapters: 6 } });
  assert.equal(next.target_chapters, 6);
  const onDisk = await loadProject(projectRoot);
  assert.equal(onDisk.target_chapters, 6);
  const events = await readEvents(projectRoot);
  assert.ok(
    !events.some((e) => e.type === "project_reopened"),
    "统一 Agent 内核 Rule 9：配置更新不得再写运行态或发出重开事件"
  );
});

test("target_chapters 低于已写章节不产生任何额外副作用", async () => {
  const projectRoot = await makeProject("wwriting-noreopen-");
  await updateProjectSettings(projectRoot, { project_profile: { target_chapters: 2 } });
  const onDisk = await loadProject(projectRoot);
  assert.equal(onDisk.target_chapters, 2);
  const events = await readEvents(projectRoot);
  assert.ok(!events.some((e) => e.type === "project_reopened"));
});
