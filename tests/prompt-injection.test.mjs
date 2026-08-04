import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileChapterPrompt, truncateOutline, truncateSetting } from "../src/core/agent-engine.mjs";
import { saveContinuity } from "../src/core/continuity-store.mjs";
import { safeJoin } from "../src/core/fs-utils.mjs";
import { DYNAMIC_BLOCK_ORDER } from "../src/core/prompt-compiler.mjs";
import { loadState, saveState } from "../src/core/project-store.mjs";
import { loadEnabledSkills } from "../src/core/skill-runtime.mjs";
import { createWritingProject } from "./helpers.mjs";

// Task 4: prompt 注入改造（spec §1.5 P1-8 / P1-9 修订）
// - outline / setting block 内容构建（stable）：读 OUTLINE.md 总纲区 + SETTING.md 静态部分
// - character_status / current_outline_segment（dynamic）：continuity 角色状态 + 当前卷骨架
// - 读取失败降级（P1-8）：蓝图文件缺失/损坏时跳过对应块，不阻断写作
// - 大小限制（P1-8）：总纲 4000 字、设定 6000 字截断
// - 切分（P1-9）：角色当前状态绝对不能进 stable block（会破坏 stableHash 缓存）

// 与 /init（blueprint-init.mjs OUTLINE_STRUCTURE / SETTING_STRUCTURE）同构的固定结构文档。
const OUTLINE_DOC = `# OUTLINE.md

## 一、总纲（锚点区 · 只增不改）
### 1. 主题与核心概念
测试主题：雨夜与档案。
### 2. 主线
测试主线：林晚在旧档案里追查失踪的父亲，发现印章背后的势力。
### 3. 核心矛盾
测试核心矛盾：真相与保护家人之间的两难。
### 4. 卷划分
第一卷：序章与调查（第1-2章）；第二卷：深入（第3-4章）。
### 5. 题材字段
异术体系：印章可封存记忆，代价是遗忘自身。

## 二、章节骨架（事实区 · 跟正文走）
### 第一卷
- [ ] 第1章《雨夜来信》：收到无名信，开启调查。
- [ ] 第2章《档案室的灰》：在水印标记上发现父亲笔迹。
### 第二卷
- [ ] 第3章《印章来历》：顾沉舟透露印章背后的势力。
- [ ] 第4章《代价》：林晚在真相与保护家人之间选择。
`;

const SETTING_DOC = `# SETTING.md

## 一、世界观（基础 · 所有题材）
### 1. 世界设定
测试世界观：现代都市 + 隐秘的印章异术传承。
### 2. 地理与时间线
临河小城；时间线以雨夜为节点。

## 二、角色表（基础 · 所有题材）
- 林晚：档案管理员 / 冷静、记性好 / 过目不忘 / 失踪者之女 / 正常
- 顾沉舟：市图书馆馆长 / 温和、深藏不露 / 知道印章来历 / 盟友 / 正常

## 三、题材专属设定（按题材加）
印章异术：封存记忆，代价是遗忘自身。
`;

async function createFixture({ outline = true, setting = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-prompt-injection-"));
  const { projectRoot, project } = await createWritingProject(root, { slug: "project", target_chapters: 10 });
  // createProject 会预写占位蓝图（"蓝图未生成，请运行 /init"），fixture 里按需替换或删除
  if (outline) await fs.writeFile(safeJoin(projectRoot, "OUTLINE.md"), OUTLINE_DOC, "utf8");
  else await fs.rm(safeJoin(projectRoot, "OUTLINE.md"), { force: true });
  if (setting) await fs.writeFile(safeJoin(projectRoot, "SETTING.md"), SETTING_DOC, "utf8");
  else await fs.rm(safeJoin(projectRoot, "SETTING.md"), { force: true });
  return { root, projectRoot, project };
}

// 与 runProject 同源的 runtime 构造方式：compileChapterPrompt 只消费 runtime.stepSkills
async function buildRuntime(projectRoot, project) {
  return { stepSkills: await loadEnabledSkills(projectRoot, project) };
}

async function compile(projectRoot, project, chapterNo, runtime, { segmentNo = 1 } = {}) {
  const state = await loadState(projectRoot);
  state.current_chapter_no = chapterNo;
  state.current_stage = "drafting";
  state.current_segment_no = segmentNo;
  await saveState(projectRoot, state);
  const request = {
    kind: "draft_segment",
    project_id: "project-prompt-injection",
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

test("blueprint_status=complete 时注入 outline/setting stable block（含总纲与设定内容）", async () => {
  const { projectRoot, project } = await createFixture();
  const runtime = await buildRuntime(projectRoot, project);

  const compiled = await compile(projectRoot, project, 1, runtime);

  const outline = blockOf(compiled, "outline");
  assert.ok(outline, "outline block 应存在（OUTLINE.md 存在）");
  assert.equal(outline.kind, "stable", "outline 必须是 stable block（P1-9）");
  assert.ok(outline.content.includes("测试主线"), "outline block 应含总纲主线");
  assert.ok(outline.content.includes("测试核心矛盾"), "outline block 应含核心矛盾");
  assert.ok(outline.content.includes("卷划分"), "outline block 应含卷划分");
  assert.ok(compiled.prompt.includes("[Stable Block] outline"), "最终 prompt 应含 outline 稳定块标记");

  const setting = blockOf(compiled, "setting");
  assert.ok(setting, "setting block 应存在（SETTING.md 存在）");
  assert.equal(setting.kind, "stable", "setting 必须是 stable block（P1-9）");
  assert.ok(setting.content.includes("测试世界观"), "setting block 应含世界观");
  assert.ok(setting.content.includes("林晚"), "setting block 应含角色静态规划（身份/性格/能力/关系）");
  assert.ok(compiled.prompt.includes("[Stable Block] setting"), "最终 prompt 应含 setting 稳定块标记");

  // 骨架区（动态）不应泄漏进 stable 的 outline block
  assert.ok(!outline.content.includes("第1章《雨夜来信》"), "章节骨架属于 dynamic 区，不应混入 stable outline");
});

test("OUTLINE.md/SETTING.md 缺失时降级跳过对应块，不阻断编译", async () => {
  const { projectRoot, project } = await createFixture({ outline: false, setting: false });
  const runtime = await buildRuntime(projectRoot, project);

  const compiled = await compile(projectRoot, project, 1, runtime); // 不应抛错
  assert.ok(!compiled.prompt.includes("[Stable Block] outline"), "无 OUTLINE.md 时不注入 outline block");
  assert.ok(!compiled.prompt.includes("[Stable Block] setting"), "无 SETTING.md 时不注入 setting block");
  assert.ok(!compiled.blocks.some((b) => b.name === "outline" || b.name === "setting"));
  assert.ok(compiled.prompt.includes("[Stable Block] system_rules"), "既有稳定块不受降级影响");

  // 部分缺失：只有 OUTLINE.md 时，setting 仍注入
  const partial = await createFixture({ outline: true, setting: false });
  const partialCompiled = await compile(partial.projectRoot, partial.project, 1, runtime);
  assert.ok(blockOf(partialCompiled, "outline"), "有 OUTLINE.md 时应注入 outline");
  assert.ok(!blockOf(partialCompiled, "setting"), "无 SETTING.md 时 setting 跳过");

  // 反向：只有 SETTING.md 时，outline 仍跳过
  const partial2 = await createFixture({ outline: false, setting: true });
  const partial2Compiled = await compile(partial2.projectRoot, partial2.project, 1, runtime);
  assert.ok(!blockOf(partial2Compiled, "outline"), "无 OUTLINE.md 时 outline 跳过");
  assert.ok(blockOf(partial2Compiled, "setting"), "有 SETTING.md 时应注入 setting");

  // 占位蓝图（createProject 预写的"蓝图未生成，请运行 /init"）等价于无蓝图 → 跳过
  const freshRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-prompt-injection-"));
  const { projectRoot: freshRoot2, project: freshProject } = await createWritingProject(freshRoot, { slug: "project" });
  const freshCompiled = await compile(freshRoot2, freshProject, 1, runtime);
  assert.ok(!blockOf(freshCompiled, "outline"), "占位 OUTLINE.md 不应注入 outline block");
  assert.ok(!blockOf(freshCompiled, "setting"), "占位 SETTING.md 不应注入 setting block");
  assert.ok(!freshCompiled.prompt.includes("蓝图未生成"), "占位文案不应泄漏进 prompt");
});

test("总纲超 4000 字、设定超 6000 字时截断（block 内容有界且带截断标记）", async () => {
  // 总纲区：在第 4 小节（卷划分）体内塞入 5900+ 字（末尾带唯一非周期标记词），使核心段超 4000 上限
  const uniqueOutlineTail = "玄铁重剑封印之地";
  const longOutline = OUTLINE_DOC.replace(
    "### 5. 题材字段",
    `${"很长的一段补充设定：".repeat(590)}${uniqueOutlineTail}\n### 5. 题材字段`
  );
  // 设定区：世界观塞入 7000+ 字（末尾带唯一标记词），且角色表放 15 个角色（超 ≤10 上限）
  const uniqueSettingTail = "千手观音灯塔残卷";
  const longSetting = SETTING_DOC.replace(
    "## 三、题材专属设定",
    `${"世界规则补充：".repeat(1000)}${uniqueSettingTail}\n## 三、题材专属设定`
  ).replace(
    "- 林晚：档案管理员 / 冷静、记性好 / 过目不忘 / 失踪者之女 / 正常",
    Array.from({ length: 15 }, (_, i) => `- 角色${i + 1}：身份${i + 1} / 性格${i + 1} / 能力${i + 1} / 关系${i + 1} / 正常`).join("\n")
  );
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-prompt-injection-"));
  const { projectRoot, project } = await createWritingProject(root, { slug: "project", target_chapters: 10 });
  await fs.writeFile(safeJoin(projectRoot, "OUTLINE.md"), longOutline, "utf8");
  await fs.writeFile(safeJoin(projectRoot, "SETTING.md"), longSetting, "utf8");
  const runtime = await buildRuntime(projectRoot, project);

  const compiled = await compile(projectRoot, project, 1, runtime);

  const outline = blockOf(compiled, "outline");
  assert.ok(outline, "超长 OUTLINE.md 仍应注入 outline block（截断而非丢弃）");
  assert.ok(outline.content.length < 4500, `outline block 应有界（实际 ${outline.content.length} 字，上限 4000 + 截断标记）`);
  assert.ok(outline.content.includes("截断"), "截断后应带截断标记");
  assert.ok(!outline.content.includes(uniqueOutlineTail), "超限内容尾部不应保留（只保留前 4000 字内片段）");

  const setting = blockOf(compiled, "setting");
  assert.ok(setting, "超长 SETTING.md 仍应注入 setting block（截断而非丢弃）");
  assert.ok(setting.content.length < 6500, `setting block 应有界（实际 ${setting.content.length} 字，上限 6000 + 截断标记）`);
  assert.ok(setting.content.includes("截断"), "截断后应带截断标记");
  assert.ok(!setting.content.includes(uniqueSettingTail), "超限设定尾部不应保留（只保留前 6000 字内片段）");

  // prompt 总长有界（防"无限膨胀"回归）
  assert.ok(compiled.prompt.length < 12000, `截断后 prompt 总长应有界（实际 ${compiled.prompt.length}）`);
});

test("truncateSetting 角色表超 10 个时只保留前 10 个角色（spec §1.5 P1-8）", () => {
  const bullet = (i) => `- 角色${i + 1}：${"能力细节描述".repeat(80)}`;
  const doc = [
    "## 一、世界观（基础 · 所有题材）",
    "### 1. 世界设定",
    "世界规则补充：".repeat(60),
    "",
    "## 二、角色表（基础 · 所有题材）",
    ...Array.from({ length: 15 }, (_, i) => bullet(i))
  ].join("\n");
  // 世界观 ~470 字 + 15 个长角色条目（~490 字/条）合计 ~7800 字 > 6000 → 触发截断；
  // 截断后保留世界观 + 前 10 个角色（10 × 490 + 470 ≈ 5400 ≤ 6000，无需再硬截断）
  const out = truncateSetting(doc, 6000);
  const characterBullets = out.split("\n").filter((line) => line.trimStart().startsWith("- "));
  assert.ok(characterBullets.length === 10, `角色表应只保留前 10 个角色（实际 ${characterBullets.length} 个）`);
  assert.ok(out.includes("仅保留前 10 个角色"), "截断应带角色表说明");
  assert.ok(out.includes("角色10"), "应保留前 10 个角色条目");
  assert.ok(!out.includes("角色11"), "第 11 个角色起应被截掉");
  assert.ok(out.length <= 6000, "截断结果应有界");
});

test("truncateOutline 超限时保留核心段并带截断标记", () => {
  const doc = [
    "## 一、总纲（锚点区 · 只增不改）",
    "### 1. 主题与核心概念",
    "测试主题。",
    "### 2. 主线",
    "测试主线。",
    "### 3. 核心矛盾",
    "测试核心矛盾。",
    "### 4. 卷划分",
    `第一卷；第二卷。${"很长的题材设定".repeat(600)}`,
    "### 5. 题材字段",
    "异术体系：封存记忆。"
  ].join("\n");
  // 长内容塞在第 4 小节内（600×7=4200 字），使核心段（1-4 小节）合计 > 4000 → 触发截断
  const out = truncateOutline(doc, 4000);
  assert.ok(out.length < 4100, "总纲截断应有界");
  assert.ok(out.includes("截断"), "应带截断标记");
  assert.ok(out.includes("### 1. 主题与核心概念") && out.includes("### 4. 卷划分"), "应保留核心段（主题/主线/核心矛盾/卷划分）");
  assert.ok(!out.includes("### 5. 题材字段"), "题材字段段应被裁掉");
});

test("character_status 在 dynamic block，绝不放进 stable 的 outline/setting（P1-9）", async () => {
  const { projectRoot, project } = await createFixture();
  await saveContinuity(projectRoot, {
    schema_version: 2,
    facts: [],
    timeline: [],
    characters: [
      { name: "林晚", status: "重伤，暂居档案馆地下室", traits: ["冷静"], chapter_no: 2 },
      { name: "顾沉舟", status: "失联，最后一次现身码头仓库", traits: ["温和"], chapter_no: null },
      { name: "宋昭", status: "第5章才登场", traits: ["神秘"], chapter_no: 5 }
    ]
  });
  const runtime = await buildRuntime(projectRoot, project);

  const compiled = await compile(projectRoot, project, 2, runtime);

  const status = blockOf(compiled, "character_status");
  assert.ok(status, "有 continuity 角色数据时应注入 character_status block");
  assert.equal(status.kind, "dynamic", "character_status 必须是 dynamic block（P1-9）");
  assert.ok(status.content.includes("重伤，暂居档案馆地下室"), "状态内容应来自 continuity");
  assert.ok(status.content.includes("失联，最后一次现身码头仓库"));
  assert.ok(!status.content.includes("宋昭"), "只注入与当前章相关角色（chapter_no ≤ 本章）");
  assert.ok(compiled.prompt.includes("重伤，暂居档案馆地下室"), "最终 prompt 应含角色状态");

  // 角色状态绝不进入任何 stable 块（否则破坏 stableHash 缓存）；
  // 状态串特意取文档中不存在的唯一文本，避免与 OUTLINE/SETTING 正文撞词
  for (const name of ["outline", "setting", "system_rules", "goal", "style"]) {
    const block = blockOf(compiled, name);
    assert.ok(block, `stable 块 ${name} 应存在`);
    assert.ok(!block.content.includes("重伤，暂居档案馆地下室"), `角色当前状态不应出现在 stable 块 ${name}`);
    assert.ok(!block.content.includes("失联，最后一次现身码头仓库"), `角色当前状态不应出现在 stable 块 ${name}`);
  }

  // dynamic 顺序：current_outline_segment 与 character_status 在 chapter_plan 之后、current_task 之前
  const dynamicNames = compiled.blocks.filter((b) => b.kind === "dynamic").map((b) => b.name);
  const rank = (name) => DYNAMIC_BLOCK_ORDER.indexOf(name);
  assert.ok(dynamicNames.indexOf("current_outline_segment") < dynamicNames.indexOf("current_task"));
  assert.ok(dynamicNames.indexOf("character_status") < dynamicNames.indexOf("current_task"));
  assert.ok(
    rank("chapter_plan") < rank("current_outline_segment")
      && rank("current_outline_segment") < rank("character_status")
      && rank("character_status") < rank("current_task"),
    "DYNAMIC_BLOCK_ORDER 顺序应为 project_memory → chapter_plan → current_outline_segment → character_status → current_task"
  );
});

test("current_outline_segment 注入当前卷骨架（dynamic）；无蓝图时跳过", async () => {
  const { projectRoot, project } = await createFixture();
  const runtime = await buildRuntime(projectRoot, project);

  const compiled = await compile(projectRoot, project, 3, runtime);
  const segment = blockOf(compiled, "current_outline_segment");
  assert.ok(segment, "current_outline_segment block 应存在");
  assert.equal(segment.kind, "dynamic", "当前卷骨架是每章变化的动态块（P1-9）");
  assert.ok(segment.content.includes("第二卷"), "第 3 章应定位到第二卷骨架");
  assert.ok(segment.content.includes("第3章《印章来历》"), "应含当前卷的章节条目");
  assert.ok(!segment.content.includes("第1章《雨夜来信》"), "不应包含其他卷的条目");
  assert.ok(!segment.content.includes("测试主线"), "骨架块不应混入总纲区内容（总纲在 stable outline）");

  // 降级：无 OUTLINE.md 时骨架块为空/跳过
  const degraded = await createFixture({ outline: false, setting: false });
  const degradedCompiled = await compile(degraded.projectRoot, degraded.project, 3, runtime);
  assert.ok(!blockOf(degradedCompiled, "current_outline_segment"), "无 OUTLINE.md 时不注入骨架块");
});

test("角色状态变化只影响 dynamicHash，outline/setting 稳定块跨章字节不变（缓存防线）", async () => {
  const { projectRoot, project } = await createFixture();
  await saveContinuity(projectRoot, {
    schema_version: 2,
    facts: [],
    timeline: [],
    characters: [{ name: "林晚", status: "正常", traits: ["冷静"], chapter_no: 1 }]
  });
  const runtime = await buildRuntime(projectRoot, project);

  const ch1 = await compile(projectRoot, project, 1, runtime);
  const ch2a = await compile(projectRoot, project, 2, runtime);

  // 同一蓝图下跨章：outline/setting 字节不变，stableHash 稳定
  assert.equal(blockOf(ch1, "outline").content, blockOf(ch2a, "outline").content, "outline 跨章应字节不变");
  assert.equal(blockOf(ch1, "setting").content, blockOf(ch2a, "setting").content, "setting 跨章应字节不变");
  assert.equal(ch1.stableHash, ch2a.stableHash, "跨章 stableHash 应稳定");
  assert.notEqual(ch1.dynamicHash, ch2a.dynamicHash, "跨章 dynamicHash 应变化（骨架/角色状态每章变）");

  // 角色状态变化：stableHash 不受影响，dynamicHash 变化（character_status 在 dynamic 区的价值）
  await saveContinuity(projectRoot, {
    schema_version: 2,
    facts: [],
    timeline: [],
    characters: [{ name: "林晚", status: "重伤", traits: ["冷静"], chapter_no: 2 }]
  });
  const ch2b = await compile(projectRoot, project, 2, runtime);
  assert.equal(ch2a.stableHash, ch2b.stableHash, "角色状态变化不应改变 stableHash（P1-9 核心）");
  assert.notEqual(ch2a.dynamicHash, ch2b.dynamicHash, "角色状态变化应改变 dynamicHash");
  assert.equal(blockOf(ch2a, "setting").content, blockOf(ch2b, "setting").content, "setting 不随角色状态变化");
});
