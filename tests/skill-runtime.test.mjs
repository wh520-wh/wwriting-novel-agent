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
  assert.ok(prompts.content.includes("悬念钩子"));
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

test("built-in skill pack includes chapter-opening, ai-voice, dialogue and show-dont-tell skills", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-skill-pack-"));
  const { projectRoot } = await createProject(root, { slug: "project" });
  const skills = await listProjectSkills(projectRoot, {});
  const names = skills.map((skill) => skill.name);
  for (const name of ["chapter-opening-hook", "avoid-ai-voice", "dialogue-not-summary", "show-dont-tell"]) {
    assert.ok(names.includes(name), `built-in skill missing: ${name}`);
  }
  const opening = skills.find((skill) => skill.name === "chapter-opening-hook");
  assert.ok(opening.description.includes("开头"));
  assert.ok(opening.hooks.some((hook) => hook.stage === "planning" && hook.action === "append_prompt"));
  assert.ok(opening.hooks.some((hook) => hook.stage === "reviewing" && hook.check === "chapter-opening"));
});

test("chapter-opening checker fails on scene-less openings and passes on action openings", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-opening-"));
  const { projectRoot, project } = await createProject(root, {
    slug: "project",
    enabled_skills: ["chapter-opening-hook"]
  });
  const flat = await runSkillChecks(projectRoot, project, "reviewing", {
    chapter_no: 1,
    content: "清晨的阳光透过窗帘照进房间。窗外传来鸟鸣。桌上一杯茶还冒着热气，一切都和昨天一样。"
  });
  assert.equal(flat[0].status, "failed");
  assert.ok(flat[0].instruction.includes("正在发生"));
  const action = await runSkillChecks(projectRoot, project, "reviewing", {
    chapter_no: 1,
    content: "突然，门被人从外面撞开，一个浑身是血的人滚了进来，抓住他的裤脚：“快逃！”"
  });
  assert.equal(action[0].status, "passed");
});

test("ai-voice checker fails on dense filler words and passes on plain prose", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-aivoice-"));
  const { projectRoot, project } = await createProject(root, {
    slug: "project",
    enabled_skills: ["avoid-ai-voice"]
  });
  const noisy = "她不禁微微一愣，仿佛时间瞬间凝固了。他不禁缓缓抬头，似乎想说什么，却顿时又止住，一种说不出的情绪悄然漫上心头。仿佛连风都不禁放慢了脚步，莫名地，他悄然握紧了拳头。";
  const noisyResult = await runSkillChecks(projectRoot, project, "reviewing", { chapter_no: 1, content: noisy });
  assert.equal(noisyResult[0].status, "failed");
  assert.ok(noisyResult[0].ai_voice_total >= 8);
  const plain = "她把茶杯搁回桌上，杯底磕出轻响。他抬起头，喉结动了动，又把话咽了回去。窗外的风灌进来，桌上的纸页哗哗翻动。她等他开口。";
  const plainResult = await runSkillChecks(projectRoot, project, "reviewing", { chapter_no: 1, content: plain });
  assert.equal(plainResult[0].status, "passed");
});

test("dialogue-ratio checker flags dialogue-less and dialogue-only chapters", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-dialogue-"));
  const { projectRoot, project } = await createProject(root, {
    slug: "project",
    enabled_skills: ["dialogue-not-summary"]
  });
  const noDialogue = "他沿着河岸走了很远。芦苇在风里弯下腰。他数着桥洞，一个，两个，三个。天色暗下来，他想起小时候的事，想起母亲说过的话。水声越来越大，他把手伸进冰凉的河水里。";
  const tooLittle = await runSkillChecks(projectRoot, project, "reviewing", { chapter_no: 1, content: noDialogue });
  assert.equal(tooLittle[0].status, "failed");
  assert.ok(tooLittle[0].instruction.includes("对话占比过低"));

  const allDialogue = `“你来了？”“嗯。”“东西带来了吗？”“带了。”“给我。”“先谈价钱。”“你说。”“五百。”“五百？你疯了吗？”“那你就拿不到它。”“成交。”`;
  const tooMuch = await runSkillChecks(projectRoot, project, "reviewing", { chapter_no: 1, content: allDialogue });
  assert.equal(tooMuch[0].status, "failed");
  assert.ok(tooMuch[0].instruction.includes("几乎全是对话"));

  const mixed = `他把信封推过桌面：“钱呢？”对面的人没有接，只是盯着信封看了一会儿。“你先打开。”那人说。他撕开封口，里面是一张发黄的照片。窗外下起雨来，雨点打在玻璃上，两个人谁都没再说话。`;
  const balanced = await runSkillChecks(projectRoot, project, "reviewing", { chapter_no: 1, content: mixed });
  assert.equal(balanced[0].status, "passed");
});

async function writeSkill(projectRoot, name, manifest) {
  const dirPath = path.join(projectRoot, "skills", name);
  await fs.mkdir(dirPath, { recursive: true });
  await fs.writeFile(path.join(dirPath, "skill.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
