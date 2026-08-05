import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createToolRegistry, executeTool, renderToolDocs, checkToolPermission, toOpenAITools } from "../src/core/chat/tool-registry.mjs";
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

test("toOpenAITools 保留工具声明的 inputSchema，并兼容旧 params", () => {
  const registry = createToolRegistry();
  registry.register({
    name: "typed_tool",
    kind: "read",
    description: "typed",
    inputSchema: {
      type: "object",
      properties: {
        timeout_ms: { type: "integer", minimum: 100 },
        patch: { type: "object", additionalProperties: true }
      },
      required: ["timeout_ms"],
      additionalProperties: false
    },
    run: async () => ({ ok: true })
  });
  registry.register({
    name: "legacy_tool",
    kind: "read",
    params: { query: "搜索词" },
    run: async () => ({ ok: true })
  });

  const tools = toOpenAITools(registry);
  assert.equal(tools[0].function.parameters.properties.timeout_ms.type, "integer");
  assert.deepEqual(tools[0].function.parameters.required, ["timeout_ms"]);
  assert.equal(tools[1].function.parameters.properties.query.type, "string");
});

test("registry 接受 describeAction 动态描述器", () => {
  const registry = createToolRegistry();
  registry.register({
    name: "dynamic",
    kind: "write",
    params: {},
    describeAction: (args) => ({ category: args.remove ? "delete" : "write" }),
    run: async () => ({ ok: true })
  });
  assert.equal(registry.get("dynamic").describeAction({ remove: true }).category, "delete");
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

test("checkToolPermission 归档只读：写/控制拒绝，豁免名单放行，read 永放行", () => {
  const perms = { read_only: false, safe_edit: true };
  const archived = { archived: true };
  assert.equal(checkToolPermission({ kind: "read" }, perms, archived).allowed, true);
  assert.equal(checkToolPermission({ kind: "write", name: "edit_chapter" }, perms, archived).allowed, false);
  assert.equal(checkToolPermission({ kind: "control", name: "start_run" }, perms, archived).allowed, false);
  assert.equal(checkToolPermission({ kind: "write", name: "archive_project" }, perms, archived).allowed, true);
  assert.equal(checkToolPermission({ kind: "write", name: "export_book" }, perms, archived).allowed, true);
});

test("优先级：read_only 压过 yolo；safe_edit:false 压过 yolo", () => {
  assert.equal(checkToolPermission({ kind: "write", name: "edit_chapter" }, { read_only: true, yolo: true }).allowed, false);
  assert.equal(checkToolPermission({ kind: "write", name: "edit_chapter" }, { safe_edit: false, yolo: true }).allowed, false);
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
  assert.equal(missing.ok, true, "不存在章节不应抛错，返回 ok + note 让模型可恢复");
  assert.ok(missing.result.note, "应返回 note 说明章节没正文");
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

import { registerWriteTools, previewEditChapter } from "../src/core/chat/tools-write.mjs";
import { loadChapterIndex } from "../src/core/project-store.mjs";

test("edit_chapter 唯一命中才执行，并更新 index 与 checkpoint", async () => {
  const registry = createToolRegistry();
  registerWriteTools(registry);
  const projectRoot = await makeProjectWithChapter();
  const project = await (await import("../src/core/project-store.mjs")).loadProject(projectRoot);
  const dup = await executeTool(registry, "edit_chapter", { chapter_no: 1, find: "。", replace: "！" }, { projectRoot, project });
  assert.equal(dup.ok, false);
  assert.equal(dup.error, "find_not_unique");
  const missing = await executeTool(registry, "edit_chapter", { chapter_no: 1, find: "不存在的句子", replace: "x" }, { projectRoot, project });
  assert.equal(missing.error, "find_not_found");
  const out = await executeTool(registry, "edit_chapter", { chapter_no: 1, find: "六楼", replace: "十二楼", reason: "统一楼层" }, { projectRoot, project });
  assert.equal(out.ok, true);
  const content = await fs.readFile(path.join(projectRoot, "chapters", "001.md"), "utf8");
  assert.match(content, /十二楼/u);
  assert.doesNotMatch(content, /从六楼坠落/u);
  const index = await loadChapterIndex(projectRoot);
  const entry = index.chapters.find((c) => c.chapter_no === 1);
  assert.match(entry.checksum, /^sha256:/u);
  const checkpoints = await fs.readdir(path.join(projectRoot, "checkpoints"));
  assert.ok(checkpoints.length >= 1);
});

test("edit_chapter occurrence 消歧：find 多次命中时按 occurrence 替换指定位置", async () => {
  const registry = createToolRegistry();
  registerWriteTools(registry);
  const projectRoot = await makeProjectWithChapter();
  const project = await (await import("../src/core/project-store.mjs")).loadProject(projectRoot);
  const before = await fs.readFile(path.join(projectRoot, "chapters", "001.md"), "utf8");
  const firstIdx = before.indexOf("。");
  const secondIdx = before.indexOf("。", firstIdx + 1);
  assert.ok(secondIdx >= 0, "测试章节应含至少两个句号");
  const out = await executeTool(registry, "edit_chapter", { chapter_no: 1, find: "。", replace: "！", occurrence: 2 }, { projectRoot, project });
  assert.equal(out.ok, true);
  const after = await fs.readFile(path.join(projectRoot, "chapters", "001.md"), "utf8");
  assert.equal(after.charAt(firstIdx), "。", "第一个句号保留");
  assert.equal(after.charAt(secondIdx), "！", "第二个句号被替换");
});

test("edit_chapter find 找不到时返回最相似片段助重试（对照 Aider difflib 容错）", async () => {
  const registry = createToolRegistry();
  registerWriteTools(registry);
  const projectRoot = await makeProjectWithChapter();
  const project = await (await import("../src/core/project-store.mjs")).loadProject(projectRoot);
  const res = await executeTool(registry, "edit_chapter", { chapter_no: 1, find: "刘康从七楼坠落", replace: "x" }, { projectRoot, project });
  assert.equal(res.ok, false);
  assert.equal(res.error, "find_not_found");
  assert.match(res.message, /最相似片段/u);
  assert.match(res.message, /六楼/u);
});

test("appendChapterSegment 后 edit_chapter 能解析到草稿中的当前章（修复 chapter_not_found）", async () => {
  const projectRoot = await makeProject();
  const project = await (await import("../src/core/project-store.mjs")).loadProject(projectRoot);
  const { appendChapterSegment } = await import("../src/core/tool-runtime.mjs");
  await appendChapterSegment(projectRoot, project, {
    project_id: project.project_id, chapter_no: 1, segment_no: 1, content: "刘康从六楼坠落。沈泽在食堂。"
  });
  const index = await loadChapterIndex(projectRoot);
  const entry = index.chapters.find((c) => c.chapter_no === 1);
  assert.ok(entry.draft_path, "草稿写入后索引应有 draft_path");
  const registry = createToolRegistry();
  registerWriteTools(registry);
  const out = await executeTool(registry, "edit_chapter", { chapter_no: 1, find: "六楼", replace: "十二楼", reason: "统一楼层" }, { projectRoot, project });
  assert.equal(out.ok, true, "草稿阶段 edit 当前章不应再报 chapter_not_found");
  const draft = await fs.readFile(entry.draft_path, "utf8");
  assert.match(draft, /十二楼/u);
});

test("previewEditChapter 生成 before/after 摘录", async () => {
  const projectRoot = await makeProjectWithChapter();
  const preview = await previewEditChapter(projectRoot, { chapter_no: 1, find: "六楼", replace: "十二楼" });  assert.equal(preview.ok, true);
  assert.match(preview.before, /六楼/u);
  assert.match(preview.after, /十二楼/u);
});

test("queue_chapters 复用 expandInstruction 入队", async () => {
  const registry = createToolRegistry();
  registerWriteTools(registry);
  const projectRoot = await makeProject();
  const project = await (await import("../src/core/project-store.mjs")).loadProject(projectRoot);
  // 注入 stub task queue：记录所有 enqueue
  const queued = [];
  const out = await executeTool(registry, "queue_chapters", { instruction: "写2章" }, {
    projectRoot, project, getTaskQueue: async () => ({ enqueue: async (text) => { queued.push(text); return { id: String(queued.length) }; } })
  });
  assert.equal(out.ok, true);
  assert.equal(out.result.queued, 2);
  assert.equal(queued.length, 2);
});

test("queue_chapters 对早于当前章的目标章号如实报错而非静默 queued:0", async () => {
  const registry = createToolRegistry();
  registerWriteTools(registry);
  const projectRoot = await makeProject();
  const project = await (await import("../src/core/project-store.mjs")).loadProject(projectRoot);
  const { loadState, saveState } = await import("../src/core/project-store.mjs");
  await saveState(projectRoot, { ...(await loadState(projectRoot)), current_chapter_no: 3 });
  const queued = [];
  const out = await executeTool(registry, "queue_chapters", { instruction: "写到第1章" }, {
    projectRoot, project, getTaskQueue: async () => ({ enqueue: async (text) => { queued.push(text); return { id: String(queued.length) }; } })
  });
  assert.equal(out.ok, false);
  assert.equal(out.error, "bad_args");
  assert.match(out.message, /早于当前章节/u);
  assert.equal(queued.length, 0);
});

test("update_continuity 修改设定档案", async () => {
  const registry = createToolRegistry();
  registerWriteTools(registry);
  const projectRoot = await makeProject();
  const project = await (await import("../src/core/project-store.mjs")).loadProject(projectRoot);
  const out = await executeTool(registry, "update_continuity", { entity: "刘康", attribute: "坠楼楼层", value: "六楼", note: "用户裁决" }, { projectRoot, project });
  assert.equal(out.ok, true);
  const continuity = await (await import("../src/core/continuity-store.mjs")).loadContinuity(projectRoot);
  assert.equal(continuity.facts[0].value, "六楼");
  // 渲染不应再出现字面量 "(第null章)"
  const { renderContinuityMarkdown } = await import("../src/core/continuity-store.mjs");
  const md = renderContinuityMarkdown(continuity);
  assert.doesNotMatch(md, /第null章/u);
  assert.match(md, /未标章号|第1章/u);
});

test("update_settings 走 settings-runtime 校验（裸密钥被拒）", async () => {
  const registry = createToolRegistry();
  registerWriteTools(registry);
  const projectRoot = await makeProject();
  const project = await (await import("../src/core/project-store.mjs")).loadProject(projectRoot);
  const bad = await executeTool(registry, "update_settings", { patch: { api_key: "sk-real-key" } }, { projectRoot, project });
  assert.equal(bad.ok, false);
  const good = await executeTool(registry, "update_settings", { patch: { target_chapters: 12 } }, { projectRoot, project });
  assert.equal(good.ok, true);
});

import { registerControlTools } from "../src/core/chat/tools-control.mjs";

test("start_run 无 server 上下文时报 control_unavailable；有则启动", async () => {
  const registry = createToolRegistry();
  registerControlTools(registry);
  const projectRoot = await makeProject();
  const project = await (await import("../src/core/project-store.mjs")).loadProject(projectRoot);
  const noServer = await executeTool(registry, "start_run", {}, { projectRoot, project });
  assert.equal(noServer.ok, false);
  assert.equal(noServer.error, "control_unavailable");
  const calls = [];
  const server = {
    runJobs: new Map(),
    startProjectRun: async (...args) => { calls.push("start"); return { started: true }; },
    getTaskQueue: async () => ({ promoteNext: async () => ({ id: "t1", instruction: "写第1章" }) })
  };
  const out = await executeTool(registry, "start_run", {}, { projectRoot, project, server });
  assert.equal(out.ok, true);
  assert.deepEqual(calls, ["start"]);
});

test("pause_run 没有运行中任务时人话报错", async () => {
  const registry = createToolRegistry();
  registerControlTools(registry);
  const projectRoot = await makeProject();
  const project = await (await import("../src/core/project-store.mjs")).loadProject(projectRoot);
  const out = await executeTool(registry, "pause_run", {}, { projectRoot, project, server: { runJobs: new Map() } });
  assert.equal(out.ok, false);
  assert.match(out.message, /没有正在运行/u);
});

test("rewrite_chapter 组装重写指令入队", async () => {
  const registry = createToolRegistry();
  registerWriteTools(registry);
  const projectRoot = await makeProject();
  const project = await (await import("../src/core/project-store.mjs")).loadProject(projectRoot);
  const enqueued = [];
  const ctx = {
    projectRoot, project,
    getTaskQueue: async () => ({ enqueue: async (instruction, opts) => { enqueued.push({ instruction, opts }); return { id: "t1" }; } })
  };
  const out = await executeTool(registry, "rewrite_chapter", { chapter_no: 2, instructions: "增加沈泽心理描写" }, ctx);
  assert.equal(out.ok, true);
  assert.equal(out.result.queued, 1);
  assert.equal(out.result.task_id, "t1");
  assert.equal(enqueued.length, 1);
  assert.match(enqueued[0].instruction, /重写第2章/u);
  assert.match(enqueued[0].instruction, /心理描写/u);
  assert.equal(enqueued[0].opts.mode, "write");
});

test("export_book 工具：导出并返回路径/字数/skipped", async () => {
  const registry = createToolRegistry();
  registerWriteTools(registry);
  const projectRoot = await makeProjectWithChapter();
  const project = await (await import("../src/core/project-store.mjs")).loadProject(projectRoot);
  const out = await executeTool(registry, "export_book", { format: "md" }, { projectRoot, project });
  assert.equal(out.ok, true);
  assert.ok(out.result.path.includes("exports"));
  assert.equal(out.result.chapters, 1);
});

test("archive_project 工具：归档/解除归档写 archived_at；运行中拒绝", async () => {
  const registry = createToolRegistry();
  registerWriteTools(registry);
  const projectRoot = await makeProject();
  const project = await (await import("../src/core/project-store.mjs")).loadProject(projectRoot);
  const on = await executeTool(registry, "archive_project", { archived: true }, { projectRoot, project });
  assert.equal(on.ok, true);
  assert.ok((await (await import("../src/core/project-store.mjs")).loadProject(projectRoot)).archived_at);
  // 解除归档：注意 ctx.project 需带 archived_at 才能过豁免链（豁免名单放行）
  const archivedProject = await (await import("../src/core/project-store.mjs")).loadProject(projectRoot);
  const off = await executeTool(registry, "archive_project", { archived: false }, { projectRoot, project: archivedProject });
  assert.equal(off.ok, true);
  assert.equal((await (await import("../src/core/project-store.mjs")).loadProject(projectRoot)).archived_at, null);
  // 运行中拒绝
  const busyServer = { runJobs: new Map([[path.resolve(projectRoot), { status: "running", controller: new AbortController() }]]) };
  const busy = await executeTool(registry, "archive_project", { archived: true }, { projectRoot, project, server: busyServer });
  assert.equal(busy.ok, false);
  assert.equal(busy.error, "project_busy");
});
