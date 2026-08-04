// 蓝图工具（spec §1.6 P2-7/P2-8）单元测试：
// read_blueprint（读 OUTLINE.md/SETTING.md）+ update_blueprint（extend 只增不改 / check_segment 骨架打勾）。
// 测试框架：node:test + node:assert/strict（对齐 chat-tools.test.mjs 的调用模式：
// createToolRegistry + registerReadTools/registerWriteTools + executeTool）。
// 注：直接调 executeTool 走工具层，不经过 chat-agent 的蓝图门禁（门禁在 chat-agent 层，工具本身无状态校验）。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createToolRegistry, executeTool } from "../src/core/chat/tool-registry.mjs";
import { registerReadTools } from "../src/core/chat/tools-read.mjs";
import { registerWriteTools } from "../src/core/chat/tools-write.mjs";
import { createProject, loadProject } from "../src/core/project-store.mjs";

// 与 /init 生成的 OUTLINE.md 同构：总纲区（### N. 字段）+ 章节骨架区（- [ ] 第N章）
const OUTLINE_FIXTURE = `# OUTLINE.md

## 一、总纲（锚点区 · 只增不改）
### 1. 主题与核心概念
主题：东方玄幻修炼体系
### 2. 主线
主角从山村少年成长为一代宗师
### 3. 核心矛盾
正道与魔道的理念冲突

## 二、章节骨架（事实区 · 跟正文走）
### 第一卷
- [ ] 第1章《少年出山》：少年拜入山门，初遇宿敌
- [ ] 第2章《试炼》：入门考核
`;

const SETTING_FIXTURE = `# SETTING.md

## 一、世界观（基础 · 所有题材）
### 1. 世界设定
东方玄幻大陆，灵气复苏
### 2. 地理与时间线
九州大陆，上古纪元

## 二、角色表（基础 · 所有题材）
- 主角：山村少年 / 坚韧 / 剑术天赋 / - / 当前状态：初出茅庐
`;

async function makeBlueprintProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-blueprint-tools-"));
  const { projectRoot } = await createProject(root, {
    slug: "bp", title: "蓝图工具测试", story_seed: "种子",
    target_chapters: 3, min_words_per_chapter: 10, target_words_per_chapter: 12
  });
  // createProject 会生成占位 OUTLINE.md/SETTING.md，这里覆盖成真实蓝图结构
  await fs.writeFile(path.join(projectRoot, "OUTLINE.md"), OUTLINE_FIXTURE, "utf8");
  await fs.writeFile(path.join(projectRoot, "SETTING.md"), SETTING_FIXTURE, "utf8");
  const project = await loadProject(projectRoot);
  return { projectRoot, project };
}

function makeRegistry() {
  const registry = createToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  return registry;
}

test("read_blueprint section=outline 读 OUTLINE.md，section=setting 读 SETTING.md", async () => {
  const { projectRoot, project } = await makeBlueprintProject();
  const registry = makeRegistry();

  const outline = await executeTool(registry, "read_blueprint", { section: "outline" }, { projectRoot, project });
  assert.equal(outline.ok, true);
  assert.match(outline.result.content, /总纲/u);
  assert.match(outline.result.content, /第1章/u);

  const setting = await executeTool(registry, "read_blueprint", { section: "setting" }, { projectRoot, project });
  assert.equal(setting.ok, true);
  assert.match(setting.result.content, /世界观/u);

  const all = await executeTool(registry, "read_blueprint", {}, { projectRoot, project });
  assert.equal(all.ok, true);
  assert.match(all.result.outline, /总纲/u);
  assert.match(all.result.setting, /世界观/u);
});

test("update_blueprint mode=extend 追加新字段成功（只增）", async () => {
  const { projectRoot, project } = await makeBlueprintProject();
  const registry = makeRegistry();

  const out = await executeTool(registry, "update_blueprint", {
    file: "outline", mode: "extend", content: "### 6. 新支线\n主角在中途发现身世之谜"
  }, { projectRoot, project });
  assert.equal(out.ok, true, out.message);

  const outline = await fs.readFile(path.join(projectRoot, "OUTLINE.md"), "utf8");
  assert.match(outline, /新支线/u);
  assert.match(outline, /身世之谜/u);
  // 已有内容原样保留
  assert.match(outline, /第2章《试炼》/u);
});

test("update_blueprint mode=extend 试图覆盖已有总纲字段被拒绝（只增不改）", async () => {
  const { projectRoot, project } = await makeBlueprintProject();
  const registry = makeRegistry();

  // 含已有区标题（## 一、总纲）→ 拒绝
  const res = await executeTool(registry, "update_blueprint", {
    file: "outline", mode: "extend", content: "## 一、总纲\n（覆盖）"
  }, { projectRoot, project });
  assert.equal(res.ok, false);
  assert.match(res.message, /不可修改/u);

  // 含已有字段标题（### 2. 主线）→ 同样拒绝，且文件未被改动
  const res2 = await executeTool(registry, "update_blueprint", {
    file: "outline", mode: "extend", content: "### 2. 主线\n（改写主线）"
  }, { projectRoot, project });
  assert.equal(res2.ok, false);
  assert.match(res2.message, /不可修改/u);

  const outline = await fs.readFile(path.join(projectRoot, "OUTLINE.md"), "utf8");
  assert.equal(outline, OUTLINE_FIXTURE, "拒绝后 OUTLINE.md 不应有任何改动");

  // SETTING.md 同样受只增不改约束
  const res3 = await executeTool(registry, "update_blueprint", {
    file: "setting", mode: "extend", content: "### 1. 世界设定\n（改写世界）"
  }, { projectRoot, project });
  assert.equal(res3.ok, false);
  assert.match(res3.message, /不可修改/u);
});

test("update_blueprint mode=check_segment 骨架打勾；非法 mode 与不存在章号报错", async () => {
  const { projectRoot, project } = await makeBlueprintProject();
  const registry = makeRegistry();

  const out = await executeTool(registry, "update_blueprint", {
    file: "outline", mode: "check_segment", chapterNo: 1
  }, { projectRoot, project });
  assert.equal(out.ok, true, out.message);

  const outline = await fs.readFile(path.join(projectRoot, "OUTLINE.md"), "utf8");
  assert.match(outline, /\[x\] 第1章/u);
  assert.match(outline, /\[ \] 第2章/u, "其他章不应被误打勾");

  // 重复打勾幂等，不报错
  const again = await executeTool(registry, "update_blueprint", {
    file: "outline", mode: "check_segment", chapterNo: 1
  }, { projectRoot, project });
  assert.equal(again.ok, true);

  // 骨架中不存在的章号 → 报错而非静默
  const missing = await executeTool(registry, "update_blueprint", {
    file: "outline", mode: "check_segment", chapterNo: 99
  }, { projectRoot, project });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /第 99 章/u);

  // 非法 mode → 报错
  const badMode = await executeTool(registry, "update_blueprint", {
    file: "outline", mode: "modify", content: "### 1. 主题与核心概念\n覆盖"
  }, { projectRoot, project });
  assert.equal(badMode.ok, false);
  assert.equal(badMode.error, "bad_args");
  assert.match(badMode.message, /extend|check_segment/u);
});
