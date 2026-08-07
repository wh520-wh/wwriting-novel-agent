// src/core/skills/hooks.mjs 的测试（计划 Task 12 Step 4）。
//
// 覆盖：
//   - runSkillChecks 只对 active catalog 中声明 metadata.wwriting.hooks 的技能执行，
//     保持旧 skill-runtime 的 checker 结果契约（suspense/chapter-opening/ai-voice/
//     dialogue-ratio 四个确定性 checkers，从旧 tests/skill-runtime.test.mjs 迁入）；
//   - check prompt 从正文 ## Review checklist 提取（`- **<check-id>**：<prompt>`），
//     metadata.wwriting.hooks 只携带结构字段（Task 10 carry-forward）；
//   - runPostProcessHooks 从正文 ## Post-process 取内容并追加（旧 runPostProcessHooks
//     契约：{ content, results, hooks }）；
//   - context.skills 注入（active 列表或带 catalog() 的 service）不碰磁盘/真实用户目录；
//   - hook conditions（min/max_chapter_no）与 priority 排序；
//   - service seam 集成：旧 manifest 迁移后钩子从新 SKILL.md 生效。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSkillService, runPostProcessHooks, runSkillChecks } from "../../src/core/skills/index.mjs";
import { readSkillFile } from "../../src/core/skills/skill-file.mjs";

// 五个内置技能的真实 SKILL.md（src/skills），与 service 默认 builtinRoot 一致。
const BUILTIN_ROOT = path.resolve(import.meta.dirname, "..", "..", "src", "skills");
const BUILTIN_NAMES = [
  "suspense-chapter-end",
  "chapter-opening-hook",
  "avoid-ai-voice",
  "dialogue-not-summary",
  "show-dont-tell"
];

async function builtinSkills() {
  return Promise.all(BUILTIN_NAMES.map((name) => readSkillFile(path.join(BUILTIN_ROOT, name), { source: "builtin" })));
}

// ---------------------------------------------------------------------------
// checker 契约迁移（旧 tests/skill-runtime.test.mjs 的四个 checker 用例）
// ---------------------------------------------------------------------------

test("suspense-ending checker：平缓结尾 failed，悬念结尾 passed", async () => {
  const skills = await builtinSkills();
  const failed = await runSkillChecks("Z:/definitely-not-a-real-root", {}, "reviewing", {
    skills,
    chapter_no: 1,
    content: "He closed the door and slept. The room was quiet. Nothing changed."
  });
  const suspense = failed.find((result) => result.gate === "skill:suspense-chapter-end");
  assert.ok(suspense, "应产生 suspense-ending 检查结果");
  assert.equal(suspense.status, "failed");
  assert.ok(suspense.instruction.includes("suspense hook"), "失败时带修复指令");

  const passed = await runSkillChecks("Z:/definitely-not-a-real-root", {}, "reviewing", {
    skills,
    chapter_no: 1,
    content: "He closed the door. Then someone knocked from inside the empty room?"
  });
  assert.equal(passed.find((result) => result.gate === "skill:suspense-chapter-end").status, "passed");
});

test("chapter-opening checker：无场面开场 failed，动作开场 passed", async () => {
  const skills = await builtinSkills();
  const flat = await runSkillChecks("Z:/fake", {}, "reviewing", {
    skills,
    chapter_no: 1,
    content: "清晨的阳光透过窗帘照进房间。窗外传来鸟鸣。桌上一杯茶还冒着热气，一切都和昨天一样。"
  });
  const opening = flat.find((result) => result.gate === "skill:chapter-opening-hook");
  assert.equal(opening.status, "failed");
  assert.ok(opening.instruction.includes("正在发生"));

  const action = await runSkillChecks("Z:/fake", {}, "reviewing", {
    skills,
    chapter_no: 1,
    content: "突然，门被人从外面撞开，一个浑身是血的人滚了进来，抓住他的裤脚：“快逃！”"
  });
  assert.equal(action.find((result) => result.gate === "skill:chapter-opening-hook").status, "passed");
});

test("ai-voice checker：密集修饰词 failed，朴素正文 passed", async () => {
  const skills = await builtinSkills();
  const noisy = "她不禁微微一愣，仿佛时间瞬间凝固了。他不禁缓缓抬头，似乎想说什么，却顿时又止住，一种说不出的情绪悄然漫上心头。仿佛连风都不禁放慢了脚步，莫名地，他悄然握紧了拳头。";
  const noisyResult = await runSkillChecks("Z:/fake", {}, "reviewing", { skills, chapter_no: 1, content: noisy });
  const ai = noisyResult.find((result) => result.gate === "skill:avoid-ai-voice");
  assert.equal(ai.status, "failed");
  assert.ok(ai.ai_voice_total >= 8);

  const plain = "她把茶杯搁回桌上，杯底磕出轻响。他抬起头，喉结动了动，又把话咽了回去。窗外的风灌进来，桌上的纸页哗哗翻动。她等他开口。";
  const plainResult = await runSkillChecks("Z:/fake", {}, "reviewing", { skills, chapter_no: 1, content: plain });
  assert.equal(plainResult.find((result) => result.gate === "skill:avoid-ai-voice").status, "passed");
});

test("dialogue-ratio checker：无对话/全对话 failed，混合 passed", async () => {
  const skills = await builtinSkills();
  const noDialogue = "他沿着河岸走了很远。芦苇在风里弯下腰。他数着桥洞，一个，两个，三个。天色暗下来，他想起小时候的事，想起母亲说过的话。水声越来越大，他把手伸进冰凉的河水里。";
  const tooLittle = await runSkillChecks("Z:/fake", {}, "reviewing", { skills, chapter_no: 1, content: noDialogue });
  const dialogue = tooLittle.find((result) => result.gate === "skill:dialogue-not-summary");
  assert.equal(dialogue.status, "failed");
  assert.ok(dialogue.instruction.includes("对话占比过低"));

  const allDialogue = `“你来了？”“嗯。”“东西带来了吗？”“带了。”“给我。”“先谈价钱。”“你说。”“五百。”“五百？你疯了吗？”“那你就拿不到它。”“成交。”`;
  const tooMuch = await runSkillChecks("Z:/fake", {}, "reviewing", { skills, chapter_no: 1, content: allDialogue });
  assert.equal(tooMuch.find((result) => result.gate === "skill:dialogue-not-summary").status, "failed");

  const mixed = `他把信封推过桌面：“钱呢？”对面的人没有接，只是盯着信封看了一会儿。“你先打开。”那人说。他撕开封口，里面是一张发黄的照片。窗外下起雨来，雨点打在玻璃上，两个人谁都没再说话。`;
  const balanced = await runSkillChecks("Z:/fake", {}, "reviewing", { skills, chapter_no: 1, content: mixed });
  assert.equal(balanced.find((result) => result.gate === "skill:dialogue-not-summary").status, "passed");
});

// ---------------------------------------------------------------------------
// Task 10 carry-forward：check prompt 从正文取，metadata 只带结构
// ---------------------------------------------------------------------------

test("check prompt 从正文 Review checklist 提取；metadata 不携带 prompt", async () => {
  const skills = await builtinSkills();
  const aiVoice = skills.find((skill) => skill.name === "avoid-ai-voice");
  const checkHook = aiVoice.metadata.wwriting.hooks.find((hook) => hook.action === "check");
  assert.equal(checkHook.prompt, undefined, "metadata.wwriting.hooks 不得携带 prompt");
  assert.equal(checkHook.check, "ai-voice", "metadata 携带 checker id");

  const results = await runSkillChecks("Z:/fake", {}, "reviewing", {
    skills: [aiVoice],
    chapter_no: 1,
    content: "普通正文。"
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].prompt, "统计正文中模糊修饰词（仿佛/似乎/不禁/不由得/莫名/悄然/缓缓/微微/瞬间/顿时等）的出现密度，判断是否超标。");
});

test("check prompt 缺行时结果不携带 prompt（其余契约不变）", async () => {
  const skill = Object.freeze({
    name: "bare-check",
    description: "desc",
    body: "# Bare\n\n## Review checklist\n\n（清单为空）",
    metadata: { wwriting: { priority: 10, hooks: [{ stage: "reviewing", action: "check", check: "suspense-ending" }] } }
  });
  const results = await runSkillChecks("Z:/fake", {}, "reviewing", { skills: [skill], chapter_no: 1, content: "x" });
  assert.equal(results.length, 1);
  assert.equal(results[0].prompt, undefined);
  assert.equal(results[0].status, "failed", "checker 仍按正文内容确定性执行（“x” 无悬念钩子 → failed）");
  assert.ok(results[0].instruction, "失败时仍带修复指令（契约不因 prompt 缺失而改变）");
});

// ---------------------------------------------------------------------------
// runPostProcessHooks：从正文 Post-process 取内容并追加（旧契约）
// ---------------------------------------------------------------------------

test("runPostProcessHooks 从正文 Post-process 小节取内容并追加", async () => {
  const skill = Object.freeze({
    name: "post-note",
    description: "desc",
    body: "# Post Note\n\n## Post-process\n\nPost-process marker.",
    metadata: { wwriting: { priority: 40, hooks: [{ stage: "post_process", action: "post_process" }] } }
  });
  const result = await runPostProcessHooks("Z:/fake", {}, { skills: [skill], content: "正文" });
  assert.equal(result.content, "正文\n\nPost-process marker.\n");
  assert.equal(result.results[0].status, "applied");
  assert.equal(result.results[0].gate, "skill:post-note:post_process");
  assert.equal(result.hooks.length, 1);
  assert.equal(result.hooks[0].skill, "post-note");
});

test("runPostProcessHooks 缺 Post-process 小节时返回 skipped 且不改写内容", async () => {
  const skill = Object.freeze({
    name: "no-post",
    description: "desc",
    body: "# No Post\n\n## Instructions\n\n只有指令。",
    metadata: { wwriting: { priority: 40, hooks: [{ stage: "post_process", action: "post_process" }] } }
  });
  const result = await runPostProcessHooks("Z:/fake", {}, { skills: [skill], content: "正文" });
  assert.equal(result.content, "正文");
  assert.equal(result.results[0].status, "skipped");
  assert.ok(result.results[0].message.includes("No local post_process"));
});

// ---------------------------------------------------------------------------
// 注入语义：context.skills 优先、未声明 hooks 的技能跳过、conditions、排序
// ---------------------------------------------------------------------------

test("runSkillChecks 优先使用 context.skills（注入 active 列表，不碰磁盘）", async () => {
  const skills = await builtinSkills();
  const results = await runSkillChecks("Z:/definitely-not-a-real-root", {}, "reviewing", {
    skills,
    chapter_no: 1,
    content: "正文……结尾有一个巨大的悬念钩子！？"
  });
  // 五个内置技能中四个声明 reviewing/check 钩子（show-dont-tell 只有 append_prompt）
  assert.equal(results.length, 4);
  assert.ok(results.every((result) => result.gate.startsWith("skill:")));
});

test("未声明 metadata.wwriting.hooks 的技能不执行任何钩子", async () => {
  const plain = Object.freeze({ name: "plain", description: "desc", body: "# Plain", metadata: {} });
  const checks = await runSkillChecks("Z:/fake", {}, "reviewing", { skills: [plain], content: "x" });
  assert.deepEqual(checks, []);
  const post = await runPostProcessHooks("Z:/fake", {}, { skills: [plain], content: "x" });
  assert.deepEqual(post.results, []);
});

test("runSkillChecks 尊重 hook conditions（min/max_chapter_no）", async () => {
  const skill = Object.freeze({
    name: "cond-skill",
    description: "desc",
    body: "# Cond\n\n## Review checklist\n\n- **cond-check**：检查条件。",
    metadata: {
      wwriting: {
        priority: 10,
        hooks: [{ stage: "reviewing", action: "check", check: "cond-check", conditions: { min_chapter_no: 2 } }]
      }
    }
  });
  const early = await runSkillChecks("Z:/fake", {}, "reviewing", { skills: [skill], chapter_no: 1, content: "x" });
  assert.deepEqual(early, [], "chapter_no=1 不满足 min_chapter_no=2，钩子不执行");
  const late = await runSkillChecks("Z:/fake", {}, "reviewing", { skills: [skill], chapter_no: 2, content: "x" });
  assert.equal(late.length, 1);
  assert.equal(late[0].status, "skipped", "未知 checker id 返回 skipped");
  assert.ok(late[0].message.includes("No local checker"));
});

test("check 结果按 hook/skill priority 升序（同优先级按 name 排序）", async () => {
  const skills = await builtinSkills();
  const results = await runSkillChecks("Z:/fake", {}, "reviewing", { skills, chapter_no: 1, content: "普通正文" });
  assert.deepEqual(
    results.map((result) => result.gate),
    ["skill:avoid-ai-voice", "skill:chapter-opening-hook", "skill:dialogue-not-summary", "skill:suspense-chapter-end"],
    "avoid-ai-voice(30) → chapter-opening(40)/dialogue(40) → suspense(50)"
  );
});

// ---------------------------------------------------------------------------
// service seam 集成：旧 manifest 迁移后钩子从新 SKILL.md 生效
// ---------------------------------------------------------------------------

test("runSkillChecks/runPostProcessHooks 经 service seam 解析 active catalog（含旧 manifest 迁移）", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwr-hooks-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  await fs.mkdir(path.join(projectRoot, "skills", "post-note"), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, "skills", "post-note", "skill.json"),
    `${JSON.stringify({
      name: "post-note",
      version: "1.0.0",
      type: "post-process",
      enabled: true,
      priority: 40,
      scope: "chapter",
      hooks: [{ stage: "post_process", action: "post_process", content: "Post-process marker." }]
    }, null, 2)}\n`,
    "utf8"
  );
  // 注入 service 作为 context.skills：ensureMigrated 把 skill.json 转成 SKILL.md，
  // 钩子从新正文 Post-process 小节取内容。
  const service = createSkillService({
    userHome: path.join(root, "home"),
    resourcesPath: null,
    builtinRoot: path.join(root, "no-builtin")
  });
  const post = await runPostProcessHooks(projectRoot, {}, { skills: service, content: "正文" });
  assert.ok(post.content.includes("Post-process marker."), "迁移后的正文 Post-process 生效");
  assert.equal(post.results[0].status, "applied");
  // 旧 manifest 已移入 backup，live 目录只剩 SKILL.md
  const live = await fs.readdir(path.join(projectRoot, "skills", "post-note"));
  assert.deepEqual(live, ["SKILL.md"]);
});
