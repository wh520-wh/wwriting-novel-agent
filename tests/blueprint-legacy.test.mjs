// 旧项目迁移（spec §1.4 P2-5）测试：
// 1. 有章节产物但无 blueprint_status 字段的项目，loadState 动态标 legacy，允许写作；
// 2. legacy 项目 /init 走 runBlueprintInitForLegacy 反推生成蓝图（mock 模型回显章节摘要）。
// 测试框架：node:test + node:assert/strict（对齐 blueprint-status.test.mjs 写法）。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BLUEPRINT_SPLIT, runBlueprintInitForLegacy } from "../src/core/blueprint-init.mjs";
import { assertBlueprintReady } from "../src/core/blueprint-guard.mjs";
import { createProjectAt, loadState, saveState, upsertChapter } from "../src/core/project-store.mjs";

const PLACEHOLDER = "蓝图未生成，请运行 /init";

function makeProjectRoot() {
  return mkdtempSync(join(tmpdir(), "blueprint-legacy-"));
}

// 建"旧项目"（模拟升级前）：createProjectAt 后删除 OUTLINE.md/SETTING.md、
// 删除 agent_state.json 的 blueprint_status 字段，再写章节正文 + 索引 + task_plan.md。
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
  await writeFile(join(projectRoot, "chapters", "001.md"), "# 第1章 雨夜来信\n\n少年在雨夜收到一封信，踏上寻访之路。\n", "utf8");
  await writeFile(join(projectRoot, "task_plan.md"), "任务计划：围绕信件展开第一卷。\n", "utf8");
}

// mock 模型：从 prompt 里捞出章节摘要行回显进 OUTLINE 骨架，
// 验证"已有章节信息确实进入了反推输入"（而非凭空生成）。
function legacyEchoClient() {
  return {
    generate: async ({ prompt }) => {
      // 找包含真实章节证据（正文头部"雨夜"）的摘要行——比模板里的 "第1章《标题》" 更精确
      const chapterLine = String(prompt ?? "")
        .split("\n")
        .find((line) => line.includes("雨夜") && line.trim().startsWith("-"))
        ?? "- [ ] 第1章《旧章》：反推摘要";
      return {
        text: [
          "# OUTLINE.md",
          "",
          "## 一、总纲（锚点区 · 只增不改）",
          "### 1. 主题与核心概念",
          "主题：旧项目反推（章节摘要回显）",
          "### 2. 主线",
          "围绕已有章节归纳主线",
          "### 3. 核心矛盾",
          "反推自章节证据",
          "### 4. 卷划分",
          "第一卷：已有章节",
          "### 5. 题材字段：修炼境界体系",
          "练气 → 筑基 → 金丹",
          "",
          "## 二、章节骨架（事实区 · 跟正文走）",
          "### 第一卷",
          chapterLine,
          BLUEPRINT_SPLIT,
          "# SETTING.md",
          "",
          "## 一、世界观（基础 · 所有题材）",
          "### 1. 世界设定",
          "反推自 continuity 与章节",
          "### 2. 地理与时间线",
          "未知，待对照确认",
          "",
          "## 二、角色表（基础 · 所有题材）",
          "- 主角：旧章节主角 / 身份待对照",
          "",
          "## 三、题材专属设定（按题材加）",
          "境界体系：练气、筑基"
        ].join("\n")
      };
    }
  };
}

test("已有章节无 OUTLINE.md 标 legacy，允许写作", async () => {
  const projectRoot = makeProjectRoot();
  await makeLegacyProject(projectRoot);

  const state = await loadState(projectRoot);
  assert.equal(state.blueprint_status, "legacy", "loadState 应动态标 legacy");

  await assert.doesNotReject(() => assertBlueprintReady(projectRoot), "legacy 项目应允许写作");
});

test("legacy /init 反推生成蓝图", async () => {
  const projectRoot = makeProjectRoot();
  await makeLegacyProject(projectRoot);

  const result = await runBlueprintInitForLegacy(projectRoot, { modelClient: legacyEchoClient() });

  assert.ok(result.outlineContent.includes("第1章"), "OUTLINE 应包含从已有章节反推的章节骨架");
  assert.ok(result.outlineContent.includes("雨夜"), "OUTLINE 应回显真实章节内容（反推输入确实来自已有章节）");
  assert.ok(result.notice.includes("对照"), "应提示用户对照确认（反推不保证与正文完全一致）");

  const state = await loadState(projectRoot);
  assert.equal(state.blueprint_status, "complete", "反推生成后状态置 complete（不再是 legacy）");

  const outline = await readFile(join(projectRoot, "OUTLINE.md"), "utf8");
  assert.ok(outline.includes("雨夜"), "OUTLINE.md 落盘内容应含反推骨架");
  assert.ok(!outline.includes(PLACEHOLDER), "OUTLINE.md 不应再是占位内容");
  const setting = await readFile(join(projectRoot, "SETTING.md"), "utf8");
  assert.ok(setting.includes("世界观"), "SETTING.md 应落盘");
  await assert.rejects(() => readFile(join(projectRoot, ".OUTLINE.md.tmp")), { code: "ENOENT" });
  await assert.rejects(() => readFile(join(projectRoot, ".SETTING.md.tmp")), { code: "ENOENT" });
});
