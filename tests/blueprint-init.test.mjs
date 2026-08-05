// /init 独立流程（blueprint-init.mjs）单元测试：原子提交 + 失败回滚语义 +
// Task 7 题材推断（空需求时用 story_seed 匹配模板，未命中/空 seed 玄幻兜底，
// requirements 非空时优先于 seed）。
// 测试框架：node:test + node:assert/strict（对齐 blueprint-status.test.mjs 的写法）。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BLUEPRINT_SPLIT, runBlueprintInit } from "../src/core/blueprint-init.mjs";
import { createProjectAt, loadState } from "../src/core/project-store.mjs";

const PLACEHOLDER = "蓝图未生成，请运行 /init";

function makeProjectRoot() {
  return mkdtempSync(join(tmpdir(), "blueprint-init-"));
}

// mock modelClient：单轮返回按分隔符拆分的 OUTLINE.md + SETTING.md 内容，
// 并把用户需求回显进总纲主题（测试断言 outline 含"玄幻"即来自 userRequirements）。
function echoClient(requirements) {
  return {
    generate: async () => ({
      text: [
        "# OUTLINE.md",
        "",
        "## 一、总纲（锚点区 · 只增不改）",
        "### 1. 主题与核心概念",
        `主题：${requirements}，东方玄幻修炼体系`,
        "### 2. 主线",
        "主角从山村少年成长为一代宗师",
        "### 3. 核心矛盾",
        "正道与魔道的理念冲突",
        "### 4. 卷划分",
        "第一卷：初入江湖",
        "### 5. 题材字段：修炼境界体系",
        "练气 → 筑基 → 金丹",
        "",
        "## 二、章节骨架（事实区 · 跟正文走）",
        "### 第一卷",
        "- [ ] 第1章《少年出山》：少年拜入山门，初遇宿敌",
        BLUEPRINT_SPLIT,
        "# SETTING.md",
        "",
        "## 一、世界观（基础 · 所有题材）",
        "### 1. 世界设定",
        "东方玄幻大陆，灵气复苏",
        "### 2. 地理与时间线",
        "九州大陆，上古纪元",
        "",
        "## 二、角色表（基础 · 所有题材）",
        "- 主角：山村少年 / 坚韧 / 剑术天赋 / - / 当前状态：初出茅庐",
        "",
        "## 三、题材专属设定（按题材加）",
        "境界体系：练气、筑基、金丹、元婴"
      ].join("\n")
    })
  };
}

test("原子提交：成功后状态变 complete，两文件有内容，无 .tmp 残留", async () => {
  const projectRoot = makeProjectRoot();
  await createProjectAt(projectRoot, { title: "测试玄幻" });

  await runBlueprintInit(projectRoot, {
    modelClient: echoClient("玄幻小说"),
    userRequirements: "玄幻小说"
  });

  const state = await loadState(projectRoot);
  assert.equal(state.blueprint_status, "complete");

  const outline = await readFile(join(projectRoot, "OUTLINE.md"), "utf8");
  assert.ok(outline.includes("玄幻"), "OUTLINE.md 应包含用户需求（玄幻）");
  assert.ok(outline.includes("章节骨架"), "OUTLINE.md 应有章节骨架区");
  assert.ok(!outline.includes(PLACEHOLDER), "OUTLINE.md 不应再是占位内容");

  const setting = await readFile(join(projectRoot, "SETTING.md"), "utf8");
  assert.ok(setting.includes("世界观"), "SETTING.md 应有世界观区");
  assert.ok(setting.includes("角色表"), "SETTING.md 应有角色表区");

  // 原子提交不留下 .tmp 垃圾
  await assert.rejects(() => readFile(join(projectRoot, ".OUTLINE.md.tmp")), { code: "ENOENT" });
  await assert.rejects(() => readFile(join(projectRoot, ".SETTING.md.tmp")), { code: "ENOENT" });
});

test("失败时状态保持 none，不留半蓝图", async () => {
  const projectRoot = makeProjectRoot();
  await createProjectAt(projectRoot, { title: "T" });
  const failingClient = { generate: async () => { throw new Error("API 失败"); } };

  await assert.rejects(
    () => runBlueprintInit(projectRoot, { modelClient: failingClient, userRequirements: "x" }),
    /API 失败/u
  );

  const state = await loadState(projectRoot);
  assert.equal(state.blueprint_status, "none");

  // 失败路径不写最终文件（保持 createProjectAt 的占位内容），也不留 .tmp
  const outline = await readFile(join(projectRoot, "OUTLINE.md"), "utf8");
  assert.ok(outline.includes(PLACEHOLDER), "失败后 OUTLINE.md 应保持占位内容");
  const setting = await readFile(join(projectRoot, "SETTING.md"), "utf8");
  assert.ok(setting.includes(PLACEHOLDER), "失败后 SETTING.md 应保持占位内容");
  await assert.rejects(() => readFile(join(projectRoot, ".OUTLINE.md.tmp")), { code: "ENOENT" });
  await assert.rejects(() => readFile(join(projectRoot, ".SETTING.md.tmp")), { code: "ENOENT" });
});

// mock modelClient：捕获收到的 prompt（用于断言题材模板选择），返回固定合法蓝图输出。
function captureClient(captured) {
  return {
    generate: async ({ prompt }) => {
      captured.prompt = prompt;
      return {
        text: [
          "# OUTLINE.md",
          "",
          "## 一、总纲（锚点区 · 只增不改）",
          "### 1. 主题与核心概念",
          "主题：测试蓝图",
          "### 2. 主线",
          "主角从山村少年成长为一代宗师",
          "### 3. 核心矛盾",
          "正道与魔道的理念冲突",
          "### 4. 卷划分",
          "第一卷：初入江湖",
          "### 5. 题材字段：修炼境界体系",
          "练气 → 筑基 → 金丹",
          "",
          "## 二、章节骨架（事实区 · 跟正文走）",
          "### 第一卷",
          "- [ ] 第1章《少年出山》：少年拜入山门，初遇宿敌",
          BLUEPRINT_SPLIT,
          "# SETTING.md",
          "",
          "## 一、世界观（基础 · 所有题材）",
          "### 1. 世界设定",
          "东方玄幻大陆，灵气复苏",
          "### 2. 地理与时间线",
          "九州大陆，上古纪元",
          "",
          "## 二、角色表（基础 · 所有题材）",
          "- 主角：山村少年 / 坚韧 / 剑术天赋 / - / 当前状态：初出茅庐",
          "",
          "## 三、题材专属设定（按题材加）",
          "境界体系：练气、筑基、金丹、元婴"
        ].join("\n")
      };
    }
  };
}

// Task 7 题材推断矩阵：断言 prompt 里模板命中的「题材专属字段」前缀行
// （buildGenreTemplateLines 输出「已匹配题材模板「XX」」，未命中才走基础模板无此行）。
test("题材推断：story_seed 含科幻关键词且 requirements 为空 → 科幻模板", async () => {
  const projectRoot = makeProjectRoot();
  await createProjectAt(projectRoot, { title: "测试", story_seed: "科幻末世废土，主角驾驶机甲对抗外星舰队" });
  const captured = {};
  await runBlueprintInit(projectRoot, { modelClient: captureClient(captured), userRequirements: "" });

  assert.match(captured.prompt, /已匹配题材模板「科幻」/u, "seed 命中科幻应选科幻模板");
  assert.ok(captured.prompt.includes("故事种子：科幻末世废土，主角驾驶机甲对抗外星舰队"), "seed 仍注入 prompt");
});

test("题材推断：story_seed 无题材关键词且 requirements 为空 → 玄幻兜底模板", async () => {
  const projectRoot = makeProjectRoot();
  await createProjectAt(projectRoot, { title: "测试", story_seed: "两个少年在雨夜相遇，约定一起看海" });
  const captured = {};
  await runBlueprintInit(projectRoot, { modelClient: captureClient(captured), userRequirements: "" });

  assert.match(captured.prompt, /已匹配题材模板「玄幻」/u, "seed 未命中任何题材应走玄幻兜底");
});

test("题材推断：story_seed 为空且 requirements 为空 → 玄幻兜底模板", async () => {
  const projectRoot = makeProjectRoot();
  await createProjectAt(projectRoot, { title: "测试", story_seed: "" });
  const captured = {};
  await runBlueprintInit(projectRoot, { modelClient: captureClient(captured), userRequirements: "" });

  assert.match(captured.prompt, /已匹配题材模板「玄幻」/u, "seed 为空应走玄幻兜底");
  assert.ok(!captured.prompt.includes("故事种子："), "seed 为空时不应注入故事种子行");
});

test("题材推断：story_seed 含科幻但 /init 显式指定都市 → 都市模板（requirements 优先）", async () => {
  const projectRoot = makeProjectRoot();
  await createProjectAt(projectRoot, { title: "测试", story_seed: "科幻末世废土，主角驾驶机甲" });
  const captured = {};
  await runBlueprintInit(projectRoot, { modelClient: captureClient(captured), userRequirements: "都市" });

  assert.match(captured.prompt, /已匹配题材模板「都市」/u, "显式需求优先于 seed");
});

test("题材推断：requirements 非空但未命中题材词 → 基础模板（不走玄幻兜底，契约不变）", async () => {
  const projectRoot = makeProjectRoot();
  await createProjectAt(projectRoot, { title: "测试", story_seed: "科幻末世废土，主角驾驶机甲" });
  const captured = {};
  await runBlueprintInit(projectRoot, { modelClient: captureClient(captured), userRequirements: "随便写个温馨小故事" });

  assert.ok(!/已匹配题材模板/u.test(captured.prompt), "未命中时不应输出任何题材模板行（走基础模板）");
  assert.ok(captured.prompt.includes("按题材自然分化"), "未命中时保留基础模板的按题材自然分化指令");
});

test("题材推断：userRequirements 显式 null 视为空需求 → 走 seed 推断（科幻模板）", async () => {
  const projectRoot = makeProjectRoot();
  await createProjectAt(projectRoot, { title: "测试", story_seed: "科幻末世废土，主角驾驶机甲" });
  const captured = {};
  await runBlueprintInit(projectRoot, { modelClient: captureClient(captured), userRequirements: null });

  assert.match(captured.prompt, /已匹配题材模板「科幻」/u, "null 需求应走空需求路径并命中 seed 题材");
  assert.ok(captured.prompt.includes("故事种子：科幻末世废土，主角驾驶机甲"), "seed 仍注入 prompt");
});

test("题材推断：纯空格 story_seed 视为无设定 → 玄幻兜底且不注入种子行", async () => {
  const projectRoot = makeProjectRoot();
  await createProjectAt(projectRoot, { title: "测试", story_seed: "   " });
  const captured = {};
  await runBlueprintInit(projectRoot, { modelClient: captureClient(captured), userRequirements: "" });

  assert.match(captured.prompt, /已匹配题材模板「玄幻」/u, "纯空格 seed 应走玄幻兜底");
  assert.ok(!captured.prompt.includes("故事种子："), "纯空格 seed 不应注入故事种子空行");
});
