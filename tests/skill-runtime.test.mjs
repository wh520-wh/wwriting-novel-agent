import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProject } from "../src/core/project-store.mjs";
import {
  collectSkillPromptHooks,
  importProjectSkill,
  listProjectSkills,
  loadEnabledSkills,
  normalizeSkillManifest,
  parseSkillManifest,
  runSkillChecks
} from "../src/core/skill-runtime.mjs";

test("parseSkillManifest reads the planned YAML hook structure", () => {
  const manifest = parseSkillManifest(`
name: suspense-chapter-end
version: "1.0.0"
type: flow-control
enabled: true
priority: 50
scope: chapter
description: 每章必须以悬念或钩子结尾
hooks:
  - stage: planning
    action: append_prompt
    content: |
      本章大纲必须包含一个结尾悬念设计。
      结尾悬念类型优先从以下选择。
  - stage: reviewing
    action: check
    check: suspense-ending
    prompt: |
      检查本章最后 500 字是否包含有效的悬念或钩子。
`);
  const skill = normalizeSkillManifest(manifest);
  assert.equal(skill.name, "suspense-chapter-end");
  assert.equal(skill.priority, 50);
  assert.equal(skill.hooks.length, 2);
  assert.ok(skill.hooks[0].content.includes("结尾悬念"));
  assert.equal(skill.hooks[1].check, "suspense-ending");
});

test("collectSkillPromptHooks sorts by priority and respects conditions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-skill-hooks-"));
  const { projectRoot, project } = await createProject(root, {
    slug: "project",
    enabled_skills: ["late-style", "early-style"]
  });
  await writeSkill(projectRoot, "late-style", {
    name: "late-style",
    version: "1.0.0",
    type: "style",
    enabled: true,
    priority: 80,
    scope: "chapter",
    hooks: [{ stage: "planning", action: "append_prompt", content: "late instruction" }]
  });
  await writeSkill(projectRoot, "early-style", {
    name: "early-style",
    version: "1.0.0",
    type: "style",
    enabled: true,
    priority: 20,
    scope: "chapter",
    hooks: [
      {
        stage: "planning",
        action: "append_prompt",
        content: "early instruction",
        conditions: { min_chapter_no: 2 }
      }
    ]
  });
  const firstChapter = await collectSkillPromptHooks(projectRoot, project, "planning", { chapter_no: 1 });
  assert.equal(firstChapter.content, "late instruction");
  const secondChapter = await collectSkillPromptHooks(projectRoot, project, "planning", { chapter_no: 2 });
  assert.equal(secondChapter.content, "early instruction\n\nlate instruction");
});

test("built-in suspense skill can append prompt and check chapter endings", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-suspense-skill-"));
  const { projectRoot, project } = await createProject(root, {
    slug: "project",
    enabled_skills: ["suspense-chapter-end"]
  });
  const skills = await loadEnabledSkills(projectRoot, project);
  assert.ok(skills.some((skill) => skill.name === "suspense-chapter-end"));
  const prompts = await collectSkillPromptHooks(projectRoot, project, "planning", { chapter_no: 1 });
  assert.ok(prompts.content.includes("suspense hook"));
  const failed = await runSkillChecks(projectRoot, project, "reviewing", {
    chapter_no: 1,
    content: "He closed the door and slept. The room was quiet. Nothing changed."
  });
  assert.equal(failed[0].status, "failed");
  const passed = await runSkillChecks(projectRoot, project, "reviewing", {
    chapter_no: 1,
    content: "He closed the door. Then someone knocked from inside the empty room?"
  });
  assert.equal(passed[0].status, "passed");
});

test("listProjectSkills includes built-ins and imported project skills", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-skill-list-"));
  const { projectRoot } = await createProject(root, {
    slug: "project"
  });
  await importProjectSkill(projectRoot, {
    name: "custom-style",
    version: "1.0.0",
    type: "style",
    scope: "chapter",
    hooks: [{ stage: "planning", action: "append_prompt", content: "Use compact prose." }]
  });
  const skills = await listProjectSkills(projectRoot, { enabled_skills: ["custom-style"] });
  assert.ok(skills.some((skill) => skill.name === "suspense-chapter-end" && skill.source_type === "builtin"));
  const custom = skills.find((skill) => skill.name === "custom-style");
  assert.equal(custom.source_type, "project");
  assert.equal(custom.enabled_in_project, true);
});

async function writeSkill(projectRoot, name, manifest) {
  const dirPath = path.join(projectRoot, "skills", name);
  await fs.mkdir(dirPath, { recursive: true });
  await fs.writeFile(path.join(dirPath, "skill.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
