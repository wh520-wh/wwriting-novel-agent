import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createToolRegistry, executeTool, renderToolDocs, checkToolPermission } from "../src/core/chat/tool-registry.mjs";
import { createProject } from "../src/core/project-store.mjs";
import { readEvents } from "../src/core/event-log.mjs";

async function makeProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-chattools-"));
  const { projectRoot } = await createProject(root, {
    slug: "t", title: "工具测试", story_seed: "种子",
    target_chapters: 3, min_words_per_chapter: 10, target_words_per_chapter: 12
  });
  return projectRoot;
}

test("registry 注册与文档渲染", () => {
  const registry = createToolRegistry();
  registry.register({ name: "demo_read", kind: "read", description: "演示", params: { x: "数字" }, run: async () => ({ x: 1 }) });
  const docs = renderToolDocs(registry);
  assert.match(docs, /demo_read/u);
  assert.match(docs, /演示/u);
  assert.match(docs, /x: 数字/u);
});

test("executeTool 未知工具返回 ok:false 不抛", async () => {
  const registry = createToolRegistry();
  const projectRoot = await makeProject();
  const out = await executeTool(registry, "nope", {}, { projectRoot, project: { tool_permissions: {} } });
  assert.equal(out.ok, false);
  assert.equal(out.error, "unknown_tool");
});

test("read_only 项目拒绝 write/control 工具，放行 read", () => {
  const permsRO = { read_only: true, safe_edit: true };
  assert.equal(checkToolPermission({ kind: "read" }, permsRO).allowed, true);
  assert.equal(checkToolPermission({ kind: "write" }, permsRO).allowed, false);
  assert.equal(checkToolPermission({ kind: "control" }, permsRO).allowed, false);
  const noSafeEdit = { read_only: false, safe_edit: false };
  assert.equal(checkToolPermission({ kind: "write", name: "edit_chapter" }, noSafeEdit).allowed, false);
  assert.equal(checkToolPermission({ kind: "write", name: "queue_chapters" }, noSafeEdit).allowed, true);
});

test("executeTool 成功路径写 chat_tool_executed 事件", async () => {
  const registry = createToolRegistry();
  registry.register({ name: "demo_read", kind: "read", description: "演示", params: {}, run: async () => ({ ok: 1 }) });
  const projectRoot = await makeProject();
  const out = await executeTool(registry, "demo_read", {}, { projectRoot, project: { project_id: "p", tool_permissions: {} } });
  assert.equal(out.ok, true);
  const events = await readEvents(projectRoot);
  const evt = events.find((e) => e.type === "chat_tool_executed");
  assert.ok(evt);
  assert.equal(evt.data.tool, "demo_read");
  assert.equal(evt.data.ok, true);
});

test("executeTool 工具抛错被包装为 ok:false", async () => {
  const registry = createToolRegistry();
  registry.register({ name: "boom", kind: "read", description: "炸", params: {}, run: async () => { throw new Error("内部错误"); } });
  const projectRoot = await makeProject();
  const out = await executeTool(registry, "boom", {}, { projectRoot, project: { tool_permissions: {} } });
  assert.equal(out.ok, false);
  assert.equal(out.error, "tool_failed");
  assert.match(out.message, /内部错误/u);
});

import { registerReadTools } from "../src/core/chat/tools-read.mjs";
import { upsertChapter } from "../src/core/project-store.mjs";

async function makeProjectWithChapter() {
  const projectRoot = await makeProject();
  const chapterPath = path.join(projectRoot, "chapters", "001.md");
  await fs.mkdir(path.dirname(chapterPath), { recursive: true });
  await fs.writeFile(chapterPath, "# Chapter 001\n\n# 第一章\n\n刘康从六楼坠落。沈泽在食堂。", "utf8");
  await upsertChapter(projectRoot, { chapter_no: 1, status: "completed", final_path: chapterPath, actual_words: 20 });
  return projectRoot;
}

test("get_status 返回项目概览", async () => {
  const registry = createToolRegistry();
  registerReadTools(registry);
  const projectRoot = await makeProjectWithChapter();
  const project = await (await import("../src/core/project-store.mjs")).loadProject(projectRoot);
  const out = await executeTool(registry, "get_status", {}, { projectRoot, project });
  assert.equal(out.ok, true);
  assert.equal(out.result.target_chapters, 3);
  assert.equal(out.result.completed_chapters, 1);
});

test("read_chapter 读正文并尊重 max_chars", async () => {
  const registry = createToolRegistry();
  registerReadTools(registry);
  const projectRoot = await makeProjectWithChapter();
  const project = await (await import("../src/core/project-store.mjs")).loadProject(projectRoot);
  const out = await executeTool(registry, "read_chapter", { chapter_no: 1, max_chars: 10 }, { projectRoot, project });
  assert.equal(out.ok, true);
  assert.ok(out.result.content.length <= 11);
  const missing = await executeTool(registry, "read_chapter", { chapter_no: 99 }, { projectRoot, project });
  assert.equal(missing.ok, false);
});

test("search_text 命中返回章节与摘录", async () => {
  const registry = createToolRegistry();
  registerReadTools(registry);
  const projectRoot = await makeProjectWithChapter();
  const project = await (await import("../src/core/project-store.mjs")).loadProject(projectRoot);
  const out = await executeTool(registry, "search_text", { query: "六楼" }, { projectRoot, project });
  assert.equal(out.ok, true);
  assert.equal(out.result.matches.length, 1);
  assert.equal(out.result.matches[0].chapter_no, 1);
  assert.match(out.result.matches[0].excerpt, /六楼/u);
});

test("read_continuity / read_outline / get_cost 在空项目不报错", async () => {
  const registry = createToolRegistry();
  registerReadTools(registry);
  const projectRoot = await makeProject();
  const project = await (await import("../src/core/project-store.mjs")).loadProject(projectRoot);
  for (const name of ["read_continuity", "read_outline", "get_cost"]) {
    const out = await executeTool(registry, name, {}, { projectRoot, project });
    assert.equal(out.ok, true, `${name} should be ok`);
  }
});
