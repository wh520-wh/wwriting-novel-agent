// 项目记忆模块测试（任意工作区计划 Task 6）。
//
// 覆盖：缺失/空白/无 frontmatter/未知 schema 的容错读取、styleSkill 解析、
// 初始模板不包含虚构事实、读函数零副作用（不创建 WWRITING.md）、不可读
//（目录占位）时返回 unreadable 标记且不外抛原始错误（解析失败不能阻止 prompt）。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { pathExists } from "../src/core/fs-utils.mjs";
import {
  PROJECT_MEMORY_FILE,
  readProjectMemory,
  renderInitialProjectMemory
} from "../src/core/project-memory.mjs";

async function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "wwriting-memory-"));
}

// ---------------------------------------------------------------------------
// 容错读取：读函数不产生任何副作用（不创建文件），缺失不阻止聊天
// ---------------------------------------------------------------------------

test("缺失 WWRITING.md 不阻止聊天且不自动创建", async () => {
  const root = await tempRoot();
  const memory = await readProjectMemory(root);
  assert.deepEqual(memory, { exists: false, content: "", styleSkill: null });
  assert.equal(await pathExists(path.join(root, PROJECT_MEMORY_FILE)), false);
});

test("空白 WWRITING.md 作为普通内容返回，不报错", async () => {
  const root = await tempRoot();
  await fs.writeFile(path.join(root, PROJECT_MEMORY_FILE), "", "utf8");
  const memory = await readProjectMemory(root);
  assert.equal(memory.exists, true);
  assert.equal(memory.content, "");
  assert.equal(memory.styleSkill, null);
});

test("无 frontmatter 的普通 Markdown 原样返回，styleSkill 为 null", async () => {
  const root = await tempRoot();
  const content = "# WWriting 项目记忆\n\n## 当前进度\n\n- 已完成：第 1-5 章\n";
  await fs.writeFile(path.join(root, PROJECT_MEMORY_FILE), content, "utf8");
  const memory = await readProjectMemory(root);
  assert.deepEqual(memory, { exists: true, content, styleSkill: null });
});

test("未知 schema_version 仍作为普通 Markdown 返回，不硬失败", async () => {
  const root = await tempRoot();
  const content = "---\nschema_version: 99\n---\n\n# WWriting 项目记忆\n\n- 项目：示例\n";
  await fs.writeFile(path.join(root, PROJECT_MEMORY_FILE), content, "utf8");
  const memory = await readProjectMemory(root);
  assert.equal(memory.exists, true);
  assert.equal(memory.styleSkill, null);
  assert.ok(memory.content.includes("- 项目：示例"));
});

test("不可读 WWRITING.md（目录占位）返回 unreadable 标记，不外抛原始错误", async () => {
  const root = await tempRoot();
  await fs.mkdir(path.join(root, PROJECT_MEMORY_FILE)); // 目录：readFile 抛 EISDIR
  let memory = null;
  await assert.doesNotReject(async () => {
    memory = await readProjectMemory(root);
  });
  assert.deepEqual(memory, { exists: false, content: "", styleSkill: null, unreadable: true });
});

// ---------------------------------------------------------------------------
// styleSkill frontmatter 解析
// ---------------------------------------------------------------------------

test("frontmatter 中的 writing_style_skill 被解析", async () => {
  const root = await tempRoot();
  const content = "---\nschema_version: 1\nwriting_style_skill: fast-readable\n---\n\n# WWriting 项目记忆\n";
  await fs.writeFile(path.join(root, PROJECT_MEMORY_FILE), content, "utf8");
  const memory = await readProjectMemory(root);
  assert.equal(memory.exists, true);
  assert.equal(memory.styleSkill, "fast-readable");
});

test("正文中的 writing_style_skill 行不被当作 frontmatter 技能", async () => {
  const root = await tempRoot();
  const content = "# WWriting 项目记忆\n\nwriting_style_skill: balanced\n";
  await fs.writeFile(path.join(root, PROJECT_MEMORY_FILE), content, "utf8");
  const memory = await readProjectMemory(root);
  assert.equal(memory.styleSkill, null);
});

test("frontmatter 未闭合时按普通 Markdown 处理，styleSkill 为 null", async () => {
  const root = await tempRoot();
  const content = "---\nwriting_style_skill: balanced\n\n# 未闭合 frontmatter\n";
  await fs.writeFile(path.join(root, PROJECT_MEMORY_FILE), content, "utf8");
  const memory = await readProjectMemory(root);
  assert.equal(memory.exists, true);
  assert.equal(memory.styleSkill, null);
  assert.ok(memory.content.includes("未闭合"));
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
