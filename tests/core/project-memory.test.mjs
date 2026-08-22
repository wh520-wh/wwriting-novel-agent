// 项目记忆模块测试（任意工作区计划 Task 6）。
//
// 覆盖：缺失/空白/无 frontmatter/未知 schema 的容错读取、
// 初始模板不包含虚构事实、读函数零副作用（不创建 WWRITING.md）、不可读
//（目录占位）时返回 unreadable 标记且不外抛原始错误（解析失败不能阻止 prompt）。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { pathExists } from "../../src/core/fs-utils.mjs";
import {
  PROJECT_MEMORY_FILE,
  mergeProjectMemory,
  readProjectMemory,
  renderInitialProjectMemory
} from "../../src/core/project-memory.mjs";

async function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "wwriting-memory-"));
}

// ---------------------------------------------------------------------------
// 容错读取：读函数不产生任何副作用（不创建文件），缺失不阻止聊天
// ---------------------------------------------------------------------------

test("缺失 WWRITING.md 不阻止聊天且不自动创建", async () => {
  const root = await tempRoot();
  const memory = await readProjectMemory(root);
  assert.deepEqual(memory, { exists: false, content: "" });
  assert.equal(await pathExists(path.join(root, PROJECT_MEMORY_FILE)), false);
});

test("空白 WWRITING.md 作为普通内容返回，不报错", async () => {
  const root = await tempRoot();
  await fs.writeFile(path.join(root, PROJECT_MEMORY_FILE), "", "utf8");
  const memory = await readProjectMemory(root);
  assert.equal(memory.exists, true);
  assert.equal(memory.content, "");
});

test("无 frontmatter 的普通 Markdown 原样返回", async () => {
  const root = await tempRoot();
  const content = "# WWriting 项目记忆\n\n## 当前进度\n\n- 已完成：第 1-5 章\n";
  await fs.writeFile(path.join(root, PROJECT_MEMORY_FILE), content, "utf8");
  const memory = await readProjectMemory(root);
  assert.deepEqual(memory, { exists: true, content });
});

test("未知 schema_version 仍作为普通 Markdown 返回，不硬失败", async () => {
  const root = await tempRoot();
  const content = "---\nschema_version: 99\n---\n\n# WWriting 项目记忆\n\n- 项目：示例\n";
  await fs.writeFile(path.join(root, PROJECT_MEMORY_FILE), content, "utf8");
  const memory = await readProjectMemory(root);
  assert.equal(memory.exists, true);
  assert.ok(memory.content.includes("- 项目：示例"));
});

test("不可读 WWRITING.md（目录占位）返回 unreadable 标记，不外抛原始错误", async () => {
  const root = await tempRoot();
  await fs.mkdir(path.join(root, PROJECT_MEMORY_FILE)); // 目录：readFile 抛 EISDIR
  let memory = null;
  await assert.doesNotReject(async () => {
    memory = await readProjectMemory(root);
  });
  assert.deepEqual(memory, { exists: false, content: "", unreadable: true });
});

// ---------------------------------------------------------------------------
// 初始模板：稳定结构，不含虚构事实
// ---------------------------------------------------------------------------

test("renderInitialProjectMemory 默认模板：结构标题稳定，不含虚构事实", () => {
  const rendered = renderInitialProjectMemory();
  assert.ok(rendered.startsWith("---\nschema_version: 1\n---\n"), "模板以固定 frontmatter 开头");
  for (const heading of [
    "# WWriting 项目记忆",
    "## 项目定位",
    "## 当前有效要求",
    "## 权威文件",
    "## 当前进度",
    "## 持久事实",
    "## 待确认"
  ]) {
    assert.ok(rendered.includes(heading), `模板应包含 ${heading}`);
  }
  // 未传入任何内容时不得出现虚构的具体事实（具体章节、人物名、目标）
  assert.ok(!rendered.includes("示例小说"));
  assert.ok(!rendered.includes("第一章"));
  assert.ok(!rendered.includes("林深"));
  assert.ok(!rendered.includes("3000 字"));
});

test("renderInitialProjectMemory 渲染 title/confirmed/files，且过滤空值", () => {
  const rendered = renderInitialProjectMemory({
    title: "雨夜追凶",
    confirmed: { goal: "完成第一卷初稿", empty: "", whitespace: "   " },
    files: { 总纲: "docs/总纲.md", 世界观: "设定/世界观.md", emptyFile: "" }
  });
  assert.ok(rendered.includes("- 项目：雨夜追凶"));
  assert.ok(rendered.includes("- 完成第一卷初稿"));
  assert.ok(rendered.includes("- 总纲：docs/总纲.md"));
  assert.ok(rendered.includes("- 世界观：设定/世界观.md"));
  // 空/空白值不得渲染成条目
  assert.ok(!rendered.includes("emptyFile"));
  assert.ok(!rendered.includes("whitespace"));
  assert.ok(!rendered.includes("-  \n"), "空白值不得渲染成空条目");
  // 全部为空时 confirmed/files 小节保持空（不制造占位条目）
  const bare = renderInitialProjectMemory({ title: "", confirmed: { a: "   " }, files: { b: "" } });
  assert.ok(!bare.includes("- 项目："));
  assert.ok(!bare.includes("- ："));
});

// ---------------------------------------------------------------------------
// 初始模板：positioning（题材）渲染（计划 Task 11 迁移使用）
// ---------------------------------------------------------------------------

test("renderInitialProjectMemory 渲染 positioning 为题材行，空值不渲染", () => {
  const rendered = renderInitialProjectMemory({ title: "雨夜追凶", positioning: "刑警追查旧案。" });
  assert.ok(rendered.includes("- 项目：雨夜追凶"));
  assert.ok(rendered.includes("- 题材：刑警追查旧案。"));
  const bare = renderInitialProjectMemory({ title: "雨夜追凶", positioning: "   " });
  assert.ok(!bare.includes("- 题材："));
});

// ---------------------------------------------------------------------------
// 合并记忆：只在稳定小节补充缺失且不冲突的权威文件索引（计划 Task 11）
// ---------------------------------------------------------------------------

test("mergeProjectMemory 无文件时创建初始模板并写盘", async () => {
  const root = await tempRoot();
  const facts = {
    title: "雨夜追凶",
    projectPositioning: "刑警追查旧案。",
    requirements: ["计划约 60 章。", "单章目标约 3000 字。"],
    files: { 总纲: "OUTLINE.md", 章节: "chapters/" }
  };
  const content = await mergeProjectMemory(root, facts);
  assert.ok(content.startsWith("---\nschema_version: 1\n---\n"), "缺失时按初始模板创建");
  assert.ok(content.includes("- 项目：雨夜追凶"));
  assert.ok(content.includes("- 题材：刑警追查旧案。"));
  assert.ok(content.includes("- 计划约 60 章。"));
  assert.ok(content.includes("- 单章目标约 3000 字。"));
  assert.ok(content.includes("- 总纲：OUTLINE.md"));
  assert.ok(content.includes("- 章节：chapters/"));
  assert.equal(await fs.readFile(path.join(root, PROJECT_MEMORY_FILE), "utf8"), content, "合并结果已写盘");
});

test("mergeProjectMemory 已有文件：保留用户内容，只补充缺失且不冲突的索引", async () => {
  const root = await tempRoot();
  const userContent = [
    "---",
    "schema_version: 1",
    "---",
    "",
    "# WWriting 项目记忆",
    "",
    "## 项目定位",
    "",
    "- 项目：用户书名",
    "",
    "## 当前有效要求",
    "",
    "- 每章 5000 字。",
    "",
    "## 权威文件",
    "",
    "- 总纲：docs/我的总纲.md",
    "- 世界观：设定/世界观.md",
    "",
    "## 当前进度",
    "",
    "- 已完成：第 1-10 章",
    ""
  ].join("\n");
  await fs.writeFile(path.join(root, PROJECT_MEMORY_FILE), userContent, "utf8");
  const facts = {
    title: "旧标题",
    projectPositioning: "旧题材",
    requirements: ["单章目标约 3000 字。"],
    files: { 总纲: "OUTLINE.md", 设定: "SETTING.md", 章节: "chapters/" }
  };
  const content = await mergeProjectMemory(root, facts);
  // 用户内容原样保留
  assert.ok(content.includes("- 项目：用户书名"));
  assert.ok(content.includes("- 每章 5000 字。"));
  assert.ok(content.includes("- 已完成：第 1-10 章"));
  assert.ok(content.includes("- 总纲：docs/我的总纲.md"));
  assert.ok(content.includes("- 世界观：设定/世界观.md"));
  // 冲突：用户已把「总纲」标签指向其他文件 → 不追加旧 OUTLINE.md 行
  assert.ok(!content.includes("- 总纲：OUTLINE.md"));
  // 缺失且不冲突的索引被补充进「权威文件」小节
  assert.ok(content.includes("- 设定：SETTING.md"));
  assert.ok(content.includes("- 章节：chapters/"));
  // 旧字段不覆盖用户最新要求
  assert.ok(!content.includes("- 项目：旧标题"));
  assert.ok(!content.includes("- 题材：旧题材"));
  assert.ok(!content.includes("- 单章目标约 3000 字。"));
  // 新增行位于「权威文件」小节内、下一个小节之前
  const authorityIndex = content.indexOf("## 权威文件");
  const progressIndex = content.indexOf("## 当前进度");
  assert.ok(authorityIndex !== -1 && progressIndex !== -1 && authorityIndex < progressIndex);
  assert.ok(content.indexOf("- 设定：SETTING.md") > authorityIndex);
  assert.ok(content.indexOf("- 设定：SETTING.md") < progressIndex);
});

test("mergeProjectMemory 空白文件视为缺失并重建初始模板", async () => {
  const root = await tempRoot();
  await fs.writeFile(path.join(root, PROJECT_MEMORY_FILE), "   \n", "utf8");
  const content = await mergeProjectMemory(root, { title: "雨夜追凶", files: { 总纲: "OUTLINE.md" } });
  assert.ok(content.startsWith("---\nschema_version: 1\n---\n"), "空白内容按缺失重建稳定模板");
  assert.ok(content.includes("- 项目：雨夜追凶"));
  assert.ok(content.includes("- 总纲：OUTLINE.md"));
});

test("mergeProjectMemory 无缺失索引时保持原文件不变（不重写）", async () => {
  const root = await tempRoot();
  const userContent = "# WWriting 项目记忆\n\n## 权威文件\n\n- 总纲：OUTLINE.md\n";
  await fs.writeFile(path.join(root, PROJECT_MEMORY_FILE), userContent, "utf8");
  const content = await mergeProjectMemory(root, { files: { 总纲: "OUTLINE.md" } });
  assert.equal(content, userContent, "索引已齐全时不改动内容");
  assert.equal(await fs.readFile(path.join(root, PROJECT_MEMORY_FILE), "utf8"), userContent);
});
