// Task 10：题材字段分化模板（/init 按题材加专属字段）单元测试。
// 验证点：
// 1. /init 时按用户题材命中模板后，模板字段清单真的进入 prompt（mock 从 prompt 提取回显，
//    而不是 mock 自说自话）；
// 2. 未命中题材时走基础模板（不强制字段）；
// 3. pickTemplate 关键词匹配 / 默认值。
// 测试框架：node:test + node:assert/strict（对齐 blueprint-init.test.mjs 写法）。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BLUEPRINT_SPLIT, runBlueprintInit, runBlueprintInitForLegacy } from "../src/core/blueprint-init.mjs";
import { GENRE_TEMPLATES, pickTemplate } from "../src/core/blueprint-templates.mjs";
import { createProjectAt, loadState, saveState, upsertChapter } from "../src/core/project-store.mjs";

function makeProjectRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// 从 prompt 里提取「OUTLINE 题材字段：…」/「SETTING 题材字段：…」清单行中的字段列表。
// 这是模板字段进入 prompt 的直接证据：mock 只回显 prompt 里真实存在的内容。
function extractFields(prompt, label) {
  const prefix = `${label} 题材字段：`;
  const line = String(prompt ?? "")
    .split("\n")
    .find((l) => l.includes(prefix));
  if (!line) return [];
  return line
    .slice(line.indexOf(prefix) + prefix.length)
    .split(/[、,，]/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

// mock 模型：把 prompt 里的题材字段清单回显进 OUTLINE 总纲区（第 5 节起编号）
// 与 SETTING「三、题材专属设定」区，验证字段清单确实经由 prompt 传给模型。
function templateEchoClient() {
  return {
    generate: async ({ prompt }) => {
      const outlineFields = extractFields(prompt, "OUTLINE");
      const settingFields = extractFields(prompt, "SETTING");
      return {
        text: [
          "# OUTLINE.md",
          "",
          "## 一、总纲（锚点区 · 只增不改）",
          "### 1. 主题与核心概念",
          "主题：按用户题材规划",
          "### 2. 主线",
          "围绕题材展开主线",
          "### 3. 核心矛盾",
          "核心冲突",
          "### 4. 卷划分",
          "第一卷：开局",
          ...outlineFields.map((field, index) => `### ${5 + index}. ${field}`),
          "",
          "## 二、章节骨架（事实区 · 跟正文走）",
          "### 第一卷",
          "- [ ] 第1章《开场》：主要事件 / 爽点 / 伏笔",
          BLUEPRINT_SPLIT,
          "# SETTING.md",
          "",
          "## 一、世界观（基础 · 所有题材）",
          "### 1. 世界设定",
          "世界观设定",
          "### 2. 地理与时间线",
          "地理与时间",
          "",
          "## 二、角色表（基础 · 所有题材）",
          "- 主角：身份 / 性格 / 能力 / 关系 / 状态",
          "",
          "## 三、题材专属设定（按题材加）",
          ...settingFields.map((field) => `- ${field}：设定内容`)
        ].join("\n")
      };
    }
  };
}

// 建"旧项目"（同 blueprint-legacy.test.mjs 的最小版）：无 OUTLINE.md/SETTING.md、
// 无 blueprint_status 字段，有已有章节正文。
async function makeLegacyProject(projectRoot) {
  await createProjectAt(projectRoot, { title: "旧项目" });
  const state = await loadState(projectRoot);
  delete state.blueprint_status;
  await saveState(projectRoot, state);
  await rm(join(projectRoot, "OUTLINE.md"));
  await rm(join(projectRoot, "SETTING.md"));
  await upsertChapter(projectRoot, {
    chapter_no: 1,
    title: "第1章",
    status: "completed",
    final_path: join(projectRoot, "chapters", "001.md")
  });
  await writeFile(join(projectRoot, "chapters", "001.md"), "# 第1章\n\n已有章节正文。\n", "utf8");
}

// ---- 集成测试：题材模板字段经由 prompt 传给模型并出现在输出里 ----

test("玄幻题材：OUTLINE 加能力体系/修为阶层字段，SETTING 加力量体系/境界划分", async () => {
  const projectRoot = makeProjectRoot("blueprint-tpl-xh-");
  await createProjectAt(projectRoot, { title: "测试玄幻" });

  const { outlineContent, settingContent } = await runBlueprintInit(projectRoot, {
    modelClient: templateEchoClient(),
    userRequirements: "玄幻小说，主角修仙"
  });

  assert.ok(outlineContent.includes("能力体系"), "OUTLINE 应包含能力体系字段");
  assert.ok(outlineContent.includes("修为阶层"), "OUTLINE 应包含修为阶层字段");
  assert.ok(settingContent.includes("力量体系"), "SETTING 应包含力量体系字段");
  assert.ok(settingContent.includes("境界划分"), "SETTING 应包含境界划分字段");
});

test("爱情题材：OUTLINE 加情感基调字段", async () => {
  const projectRoot = makeProjectRoot("blueprint-tpl-aq-");
  await createProjectAt(projectRoot, { title: "测试爱情" });

  const { outlineContent } = await runBlueprintInit(projectRoot, {
    modelClient: templateEchoClient(),
    userRequirements: "爱情小说"
  });

  assert.ok(outlineContent.includes("情感基调"), "OUTLINE 应包含情感基调字段");
});

test("未匹配题材走基础模板：不强制题材字段", async () => {
  const projectRoot = makeProjectRoot("blueprint-tpl-base-");
  await createProjectAt(projectRoot, { title: "通用" });

  const { outlineContent } = await runBlueprintInit(projectRoot, {
    modelClient: templateEchoClient(),
    userRequirements: "随便写个温馨小故事"
  });

  assert.ok(!outlineContent.includes("能力体系"), "未匹配模板时不应强制题材字段");
  assert.ok(!outlineContent.includes("情感基调"), "未匹配模板时不应强制题材字段");
});

test("无用户需求时显式走默认玄幻模板（与默认东方玄幻方向自洽，不依赖默认文案措辞）", async () => {
  const projectRoot = makeProjectRoot("blueprint-tpl-none-");
  await createProjectAt(projectRoot, { title: "无需求" });

  // 不传 userRequirements：prompt 的默认方向是"通用东方玄幻"，无输入必须显式命中玄幻模板
  const { outlineContent } = await runBlueprintInit(projectRoot, {
    modelClient: templateEchoClient()
  });

  assert.ok(outlineContent.includes("能力体系"), "无输入应显式命中默认玄幻模板（能力体系）");
  assert.ok(outlineContent.includes("修为阶层"), "无输入应显式命中默认玄幻模板（修为阶层）");
});

test("legacy 反推生成同样按题材套模板（用户给题材需求时）", async () => {
  const projectRoot = makeProjectRoot("blueprint-tpl-legacy-");
  await makeLegacyProject(projectRoot);

  const { outlineContent } = await runBlueprintInitForLegacy(projectRoot, {
    modelClient: templateEchoClient(),
    userRequirements: "爱情小说"
  });

  assert.ok(outlineContent.includes("情感基调"), "legacy 反推 OUTLINE 也应包含题材模板字段");
});

// ---- pickTemplate 单测：关键词匹配 / 默认值 ----

test("pickTemplate 关键词匹配题材模板", () => {
  assert.deepEqual(pickTemplate("玄幻小说，主角修仙"), { genre: "玄幻", ...GENRE_TEMPLATES["玄幻"] });
  assert.deepEqual(pickTemplate("爱情小说"), { genre: "爱情", ...GENRE_TEMPLATES["爱情"] });
  assert.deepEqual(pickTemplate("都市异能"), { genre: "都市", ...GENRE_TEMPLATES["都市"] });
  assert.deepEqual(pickTemplate("悬疑推理"), { genre: "悬疑", ...GENRE_TEMPLATES["悬疑"] });
  assert.deepEqual(pickTemplate("科幻小说"), { genre: "科幻", ...GENRE_TEMPLATES["科幻"] });
});

test("pickTemplate 科幻与玄幻不互误", () => {
  // 「玄幻」与「科幻」互不为子串，命中必须精确到对应题材
  assert.equal(pickTemplate("科幻小说").genre, "科幻");
  assert.equal(pickTemplate("玄幻小说").genre, "玄幻");
  assert.equal(pickTemplate("星际科幻").genre, "科幻");
});

test("pickTemplate 组合题材按模板迭代顺序取优先级", () => {
  // 迭代顺序即优先级：先命中"玄幻"；"科幻都市"同时含都市/科幻，都市在前取都市
  assert.equal(pickTemplate("都市异能玄幻").genre, "玄幻");
  assert.equal(pickTemplate("科幻都市").genre, "都市");
});

test("pickTemplate 无匹配返回 undefined（走基础模板）", () => {
  assert.equal(pickTemplate("随便写写"), undefined);
  assert.equal(pickTemplate(""), undefined);
  assert.equal(pickTemplate(undefined), undefined);
});
