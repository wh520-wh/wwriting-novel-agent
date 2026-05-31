import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProject, createProjectAt, loadProject } from "../src/core/project-store.mjs";
import { pathExists } from "../src/core/fs-utils.mjs";

test("createProject rejects unsafe slug before creating directories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-slug-"));
  const outsideName = `wwriting-outside-${Date.now()}`;
  const outsidePath = path.resolve(root, "..", outsideName);
  await assert.rejects(() => createProject(root, { slug: `../${outsideName}` }), /Invalid project slug/u);
  assert.equal(await pathExists(outsidePath), false);
  await assert.rejects(() => createProject(root, { slug: "bad\\name" }), /Invalid project slug/u);
});

test("new projects default to one active model and disabled stage overrides", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-model-config-"));
  const { projectRoot } = await createProject(root, {
    slug: "project"
  });
  const project = await loadProject(projectRoot);
  assert.equal(project.active_model.provider, "mock");
  assert.equal(project.active_model.model_name, "mock-writer");
  assert.deepEqual(project.stage_overrides, { enabled: false });
});

test("createProjectAt initializes an explicitly selected empty directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-explicit-root-"));
  const projectRoot = path.join(root, "picked-folder");
  const result = await createProjectAt(projectRoot, {
    title: "Picked Folder Novel",
    story_seed: "一句话大纲",
    target_chapters: 12,
    min_words_per_chapter: 1500
  });
  assert.equal(result.projectRoot, projectRoot);
  assert.equal(await pathExists(path.join(projectRoot, "project.yaml")), true);
  assert.equal(await pathExists(path.join(projectRoot, "agent_state.json")), true);
  assert.equal(await pathExists(path.join(projectRoot, "memory", "chapter_index.json")), true);
  const project = await loadProject(projectRoot);
  assert.equal(project.title, "Picked Folder Novel");
  assert.equal(project.target_chapters, 12);
  assert.equal(project.root_path, projectRoot);
});
