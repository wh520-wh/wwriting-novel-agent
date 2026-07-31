import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileChapterPrompt } from "../src/core/agent-engine.mjs";
import { safeJoin } from "../src/core/fs-utils.mjs";
import { createProject, loadState, saveState } from "../src/core/project-store.mjs";
import { loadEnabledSkills } from "../src/core/skill-runtime.mjs";
import { chapterFileName } from "../src/core/tool-runtime.mjs";

// L1 前缀稳定性测试防线：真实写作入口 compileChapterPrompt 的字节级防线。
// 拦的是「动态数据意外进入稳定区」（bug 类：chapter_no/draft 内容混进 stable 渲染），
// 放行的是「合法配置变化」（技能章节门控、风格文件编辑、story_seed 修改）。
// 与 prompt-prefix-measure.test.mjs（测量视角）互补：这里是断言防线，不是测量。

// 用可重复的固定文本生成正文（字符数 ≈ approxChars）
function prose(chapterNo, approxChars) {
  const sentence = `第${chapterNo}章叙述：雨落在窗台上，人物在灯下整理思绪，一句对白把场景往前推进一步。`;
  return sentence.repeat(Math.ceil(approxChars / sentence.length)).slice(0, approxChars);
}

// project_id 固定：createProject 会随机生成 UUID 且被编入 current_task 的 JSON，
// 固定后避免测试间因随机 id 引入无谓的 dynamicHash 差异。
const L1_PROJECT_ID = "project-l1";

async function buildRuntime(projectRoot, project) {
  return { stepSkills: await loadEnabledSkills(projectRoot, project) };
}

// 写入指定章节草稿、推进 state，再走真实写作入口编译一次
async function compileAt(projectRoot, project, runtime, { chapterNo, draftText, segmentNo = 1, stage = "drafting" }) {
  await fs.writeFile(
    safeJoin(projectRoot, "drafts", chapterFileName(chapterNo, `draft.${project.output_format}`)),
    draftText,
    "utf8"
  );
  const state = await loadState(projectRoot);
  state.current_chapter_no = chapterNo;
  state.current_stage = stage;
  state.current_segment_no = segmentNo;
  await saveState(projectRoot, state);
  const request = {
    kind: "draft_segment",
    project_id: L1_PROJECT_ID,
    chapter_no: chapterNo,
    segment_no: segmentNo,
    segment_target_words: 1100,
    allowed_tools: ["append_chapter_segment"]
  };
  return compileChapterPrompt(projectRoot, project, state, request, runtime);
}

function blockOf(compiled, name) {
  return compiled.blocks.find((block) => block.name === name);
}

function stableBlocksOf(compiled) {
  return compiled.blocks.filter((block) => block.kind === "stable").map((block) => block.content);
}

// —— 交付 1：L1 写作入口字节级测试 ——
test("L1 字节级：章号与草稿长度不同时 stable 区逐字节不变（动态数据未混入稳定区）", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-l1-entry-"));
  const { projectRoot, project } = await createProject(root, { slug: "project", target_chapters: 10 });
  const runtime = await buildRuntime(projectRoot, project);

  // 动态输入刻意不同：第 1 章 vs 第 5 章；草稿 100 字 vs 2000 字
  const compileCh1 = await compileAt(projectRoot, project, runtime, { chapterNo: 1, draftText: prose(1, 100) });
  const compileCh5 = await compileAt(projectRoot, project, runtime, { chapterNo: 5, draftText: prose(5, 2000) });

  const stableNames = compileCh1.blocks.filter((b) => b.kind === "stable").map((b) => b.name);
  assert.deepEqual(
    stableNames,
    compileCh5.blocks.filter((b) => b.kind === "stable").map((b) => b.name),
    "两次编译的 stable 块集合应一致"
  );

  // 逐字节断言：按块顺序逐项比较 content（字节级，不是哈希）
  for (const name of stableNames) {
    assert.equal(
      blockOf(compileCh1, name).content,
      blockOf(compileCh5, name).content,
      `stable 块 ${name} 在不同动态输入下发生字节变化（动态数据混入稳定区）`
    );
  }

  // 缓存键行为与逐字节断言一致：stableHash 相等、dynamicHash 变化
  assert.equal(compileCh1.stableHash, compileCh5.stableHash, "章号/草稿长度变化不应改变 stableHash");
  assert.notEqual(compileCh1.dynamicHash, compileCh5.dynamicHash, "章号/草稿长度变化应改变 dynamicHash");

  // 反向显式断言：动态输入确实不同（测试前提成立），且其内容没有出现在稳定区文本里
  const dynamicTextA = compileCh1.blocks.filter((b) => b.kind === "dynamic").map((b) => b.content).join("\n");
  const dynamicTextB = compileCh5.blocks.filter((b) => b.kind === "dynamic").map((b) => b.content).join("\n");
  assert.notEqual(dynamicTextA, dynamicTextB, "两次编译的动态区输入应不同（测试前提）");
  assert.ok(dynamicTextA.includes("chapter_no"), "current_task JSON 应包含 chapter_no（动态区正常）");

  const stableText = stableBlocksOf(compileCh1).join("\n");
  assert.ok(!stableText.includes("第 1 章") && !stableText.includes("第 5 章"), "章节号不应混入 stable 区");
  assert.ok(!stableText.includes("窗台上"), "草稿正文不应混入 stable 区");
});

// —— 交付 2a：技能章节门控（合法变化）——
const GATED_SKILL_NAME = "l1-gated-skill";
const GATED_SKILL_MANIFEST = {
  name: GATED_SKILL_NAME,
  version: "1.0.0",
  type: "flow-control",
  priority: 10,
  description: "L1 测试用门控技能：第 3 章起才参与写作提示。",
  hooks: [
    {
      stage: "drafting",
      action: "append_prompt",
      conditions: { min_chapter_no: 3 },
      content: "L1 门控技能规则：第三章起，每段对白后必须接一个动作描写。"
    }
  ]
};

async function createGatedSkillProject(root, { slug = "project" } = {}) {
  const { projectRoot, project } = await createProject(root, {
    slug,
    target_chapters: 10,
    enabled_skills: [GATED_SKILL_NAME]
  });
  const skillDir = safeJoin(projectRoot, "skills", GATED_SKILL_NAME);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(safeJoin(skillDir, "skill.json"), `${JSON.stringify(GATED_SKILL_MANIFEST, null, 2)}\n`, "utf8");
  return { projectRoot, project };
}

test("L1 合法变化：技能章节门控使 skill_instructions 变化（放行），章节号本身不混入 stable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-l1-gate-"));
  const { projectRoot, project } = await createGatedSkillProject(root);
  const runtime = await buildRuntime(projectRoot, project);

  const compileCh1 = await compileAt(projectRoot, project, runtime, { chapterNo: 1, draftText: prose(1, 100) });
  const compileCh5 = await compileAt(projectRoot, project, runtime, { chapterNo: 5, draftText: prose(5, 2000) });

  // 门控生效：低章号技能不参与，高章号参与
  assert.equal(blockOf(compileCh1, "skill_instructions"), undefined, "第 1 章时门控技能不应参与编译（min_chapter_no=3）");
  assert.ok(
    blockOf(compileCh5, "skill_instructions").content.includes("L1 门控技能规则"),
    "第 5 章时门控技能应参与编译"
  );

  // 合法变化放行：skill_instructions 变化 → stableHash 变化（防线不拦它）
  assert.notEqual(compileCh1.stableHash, compileCh5.stableHash, "技能门控导致的 skill_instructions 变化是合法前缀变化");

  // 区分 bug：除 skill_instructions 外，其余 stable 块必须逐字节一致（章节号本身没有混入）
  for (const name of ["system_rules", "goal", "style"]) {
    assert.equal(
      blockOf(compileCh1, name).content,
      blockOf(compileCh5, name).content,
      `stable 块 ${name} 不应因章节号变化而变化`
    );
  }

  // 同侧对照：ch3 与 ch5 都越过门控（≥3）时，章节号不同但 stable 区逐字节一致
  const compileCh3 = await compileAt(projectRoot, project, runtime, { chapterNo: 3, draftText: prose(3, 120) });
  const compileCh5B = await compileAt(projectRoot, project, runtime, { chapterNo: 5, draftText: prose(5, 1500) });
  assert.deepEqual(
    stableBlocksOf(compileCh3),
    stableBlocksOf(compileCh5B),
    "同为越过门控的章节（ch3/ch5），stable 区应逐字节一致——章节号本身不会混入"
  );
  assert.equal(compileCh3.stableHash, compileCh5B.stableHash);
  assert.notEqual(compileCh3.dynamicHash, compileCh5B.dynamicHash);
});

// —— 交付 2b：用户编辑风格文件（合法变化）——
test("L1 合法变化：用户编辑输出风格文件使 style 块变化（放行）", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-l1-style-"));
  const { projectRoot, project } = await createProject(root, { slug: "project" });
  const runtime = await buildRuntime(projectRoot, project);

  const before = await compileAt(projectRoot, project, runtime, { chapterNo: 1, draftText: prose(1, 100) });
  assert.ok(blockOf(before, "style").content.includes("你正在创作长篇小说"), "默认应使用内置 creative 风格");

  // 用户编辑风格文件：项目级覆盖同名内置风格
  const styleDir = safeJoin(projectRoot, ".wwriting", "output-styles");
  await fs.mkdir(styleDir, { recursive: true });
  await fs.writeFile(
    safeJoin(styleDir, "creative.md"),
    "---\nname: creative\ndescription: 用户编辑后的风格\n---\n你正在创作长篇悬疑小说。\n- 用户新增：每章必须有一个反转。\n",
    "utf8"
  );

  const after = await compileAt(projectRoot, project, runtime, { chapterNo: 1, draftText: prose(1, 100) });
  const styleAfter = blockOf(after, "style");

  assert.ok(styleAfter.content.includes("用户新增：每章必须有一个反转"), "编辑后的风格内容应进入 style 块");
  assert.notEqual(styleAfter.content, blockOf(before, "style").content, "用户编辑风格文件是合法前缀变化，style 块应变化");
  assert.notEqual(before.stableHash, after.stableHash, "风格编辑后 stableHash 应放行（变化）");

  // 编辑前后其余 stable 块逐字节一致：只有 style 被扰动
  for (const name of ["system_rules", "goal"]) {
    assert.equal(
      blockOf(before, name).content,
      blockOf(after, name).content,
      `stable 块 ${name} 不应受风格编辑影响`
    );
  }
});

// —— 交付 2c：story_seed 修改（合法变化）——
test("L1 合法变化：修改 story_seed 使 goal 块变化（放行）", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-l1-seed-"));
  const { projectRoot, project } = await createProject(root, { slug: "project" });
  const runtime = await buildRuntime(projectRoot, project);

  const before = await compileAt(projectRoot, project, runtime, { chapterNo: 1, draftText: prose(1, 100) });
  assert.equal(blockOf(before, "goal").content, "一个人在雨夜收到一封没有署名的信。");

  project.story_seed = "小镇图书管理员在旧书里发现一枚不属于任何时代的印章。";
  const after = await compileAt(projectRoot, project, runtime, { chapterNo: 1, draftText: prose(1, 100) });

  assert.equal(blockOf(after, "goal").content, project.story_seed, "goal 块应跟随 story_seed");
  assert.notEqual(before.stableHash, after.stableHash, "story_seed 修改是合法前缀变化，stableHash 应放行（变化）");

  // 修改前后其余 stable 块逐字节一致：只有 goal 被扰动
  for (const name of ["system_rules", "style"]) {
    assert.equal(
      blockOf(before, name).content,
      blockOf(after, name).content,
      `stable 块 ${name} 不应受 story_seed 修改影响`
    );
  }
});
