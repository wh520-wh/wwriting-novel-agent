import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProject, createProjectAt, loadProject, saveProject } from "../src/core/project-store.mjs";
import { parseSimpleYaml } from "../src/core/simple-yaml.mjs";
import { pathExists } from "../src/core/fs-utils.mjs";

test("createProject rejects unsafe slug before creating directories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-slug-"));
  const outsideName = `wwriting-outside-${Date.now()}`;
  const outsidePath = path.resolve(root, "..", outsideName);
  await assert.rejects(() => createProject(root, { slug: `../${outsideName}` }), /Invalid project slug/u);
  assert.equal(await pathExists(outsidePath), false);
  await assert.rejects(() => createProject(root, { slug: "bad\\name" }), /Invalid project slug/u);
});

test("new projects default to no active model", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-model-config-"));
  const { projectRoot } = await createProject(root, {
    slug: "project"
  });
  const project = await loadProject(projectRoot);
  // Task 8：未配置模型 = active_model null（用户面不再以 mock 兜底）
  assert.equal(project.active_model, null);
  assert.equal(project.default_writer_model, null);
  assert.equal(project.default_reviewer_model, null);
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
  // 统一 Agent 内核计划 Rule 9：新项目不创建旧运行态文件，blueprint_status
  // 是 project.yaml 的持久字段（文件名按片段构造，遵守依赖规则 H）。
  assert.equal(await pathExists(path.join(projectRoot, "agent_state" + ".json")), false);
  assert.equal(await pathExists(path.join(projectRoot, "memory", "chapter_index.json")), true);
  const project = await loadProject(projectRoot);
  assert.equal(project.title, "Picked Folder Novel");
  assert.equal(project.target_chapters, 12);
  assert.equal(project.root_path, projectRoot);
  assert.equal(project.blueprint_status, "none", "新项目 project.yaml 应含 blueprint_status=none");
});

// ---------------------------------------------------------------------------
// Task 12：enabled_skills 移除（新建不默认填充、保存时剥离、parser 忽略旧字段）
// ---------------------------------------------------------------------------

test("createProject 不再默认填充 enabled_skills，也不生成 skills/*/skill.json", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-no-skills-"));
  const { projectRoot } = await createProject(root, { slug: "project" });
  const source = await fs.readFile(path.join(projectRoot, "project.yaml"), "utf8");
  const project = parseSimpleYaml(source);
  assert.equal(project.enabled_skills, undefined, "新项目 project.yaml 不得包含 enabled_skills");
  // 内置技能来自 src/skills 的 SKILL.md（catalog 发现），项目 skills/ 保持为空。
  assert.deepEqual(await fs.readdir(path.join(projectRoot, "skills")), []);
});

test("saveProject 保存时移除旧 project.yaml 的 enabled_skills 字段", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-save-strip-"));
  const { projectRoot } = await createProject(root, { slug: "project" });
  // 模拟旧版本 project.yaml 残留 enabled_skills
  const legacy = { ...(await loadProject(projectRoot)), enabled_skills: ["suspense-chapter-end"] };
  await saveProject(projectRoot, legacy);
  const after = await loadProject(projectRoot);
  assert.equal(after.enabled_skills, undefined, "保存后 enabled_skills 必须被移除");
  const source = await fs.readFile(path.join(projectRoot, "project.yaml"), "utf8");
  assert.ok(!source.includes("enabled_skills"), "project.yaml 文本不得再出现 enabled_skills");
  // 其它字段原样保留
  assert.equal(after.title, legacy.title);
  assert.equal(after.blueprint_status, "none");
});
