// count_text 客观字数工具测试（Task 9）。
//
// 覆盖（brief Step 1 的工具级要求 + 冻结输出契约 §2.2）：
//   - schema：path 必填，minimum/target 可选非负整数，additionalProperties: false
//   - 冻结契约：返回客观统计与差额，绝不出现 passed/failed/below_minimum/
//     required/must_call 质量判定字段（返回值与审计事件两侧都断言）
//   - 只读自动放行（与 read_file 同权限口径）：无 decision_requested，
//     read_only 模式下仍可调用
//   - 缺失文件 → { path, exists: false }（ENOENT 不抛、不泄露）
//   - 非 .md/.txt 扩展名 → unsupported_text_file
//   - 工作区外路径（相对穿越与绝对路径）→ path_outside_workspace
//   - .txt 纯文本文件可统计
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentJournal } from "../../src/core/agent/journal.mjs";
import { createToolRuntime } from "../../src/core/agent/tools.mjs";

const DEFAULT_PERMISSIONS = {
  network_allowed: false,
  safe_edit: true,
  read_only: false,
  auto_edit: false,
  yolo: false,
  dangerous: false
};

const COUNT_FIXTURE = `---
title: x
---
# 第一章
[主角](https://example.com) 有 2 个 plan。

\`code\`
\`\`\`js
const x = 1
\`\`\``;

// 与 tests/agent/tools.test.mjs 同款夹具（brief Step 1 手算结果）：
// visible = "第一章\n主角 有 2 个 plan。" → cjk 7 / latin 1 / numeric 1 /
// punct 1 / nonWhitespace 13 / effective 9。
const FIXTURE_COUNTS = {
  cjk_characters: 7,
  latin_words: 1,
  numeric_tokens: 1,
  punctuation_characters: 1,
  non_whitespace_characters: 13,
  effective_count: 9
};

async function setup(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-count-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const projectRoot = path.join(dir, "project");
  await fs.mkdir(projectRoot, { recursive: true });
  const journal = createAgentJournal({ projectRoot });
  await journal.load();
  const inputId = "input-1";
  const runId = "run-1";
  await journal.appendBatch([
    { type: "run_started", run_id: runId, payload: { workflow: "general", input_id: inputId } }
  ]);
  const tools = createToolRuntime({
    projectOperations: {},
    journal,
    secrets: options.secrets ?? [],
    ...(options.runtime ?? {})
  });
  const project = {
    project_id: "p1",
    archived_at: null,
    output_format: "md",
    tool_permissions: { ...DEFAULT_PERMISSIONS, ...(options.permissions ?? {}) }
  };
  const context = {
    projectRoot,
    project,
    run_id: runId,
    active_input_id: inputId
  };
  return { tools, journal, context, projectRoot, dir };
}

async function readEvents(journal) {
  return journal.read({ afterSeq: 0 });
}

function eventsOfType(events, type) {
  return events.filter((event) => event.type === type);
}

function assertClosure(events) {
  const openTools = new Map();
  const openDecisions = new Map();
  for (const event of events) {
    if (event.type === "tool_call_started") {
      openTools.set(event.payload.tool_call_id ?? event.payload.id, event);
    } else if (event.type === "tool_call_completed" || event.type === "tool_call_failed") {
      const id = event.payload.tool_call_id ?? event.payload.id;
      assert.ok(openTools.has(id), `tool 终态必须对应已开始 tool call: ${id}`);
      openTools.delete(id);
    } else if (event.type === "decision_requested") {
      openDecisions.set(event.payload.decision_id, event);
    } else if (event.type === "decision_resolved") {
      assert.ok(openDecisions.has(event.payload.decision_id), `decision 终态必须对应已请求 decision: ${event.payload.decision_id}`);
      openDecisions.delete(event.payload.decision_id);
    }
  }
  assert.deepEqual([...openTools.keys()], [], "每个 tool call 都必须收敛");
  assert.deepEqual([...openDecisions.keys()], [], "每个 decision 都必须收敛");
}

function toolCall(name, args) {
  return { id: `call_${name}_${Math.random().toString(36).slice(2, 8)}`, name, arguments: args };
}

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

test("count_text schema：path 必填，minimum/target 可选非负整数，不暴露风险字段", () => {
  const tools = createToolRuntime({ journal: { append: async () => {} } });
  const tool = tools.definitions().find((def) => def.function.name === "count_text").function;
  assert.equal(
    tool.description,
    "统计工作区内 Markdown 或纯文本文件的客观字数；minimum/target 只计算差额，不判定通过或失败。"
  );
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["minimum", "path", "target"]);
  assert.deepEqual(tool.parameters.required, ["path"]);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.equal(tool.parameters.properties.path.type, "string");
  assert.equal(tool.parameters.properties.path.minLength, 1);
  assert.equal(tool.parameters.properties.minimum.type, "integer");
  assert.equal(tool.parameters.properties.minimum.minimum, 0);
  assert.equal(tool.parameters.properties.target.type, "integer");
  assert.equal(tool.parameters.properties.target.minimum, 0);
  for (const forbidden of ["risk", "scope", "extreme", "grant_key", "confirmation_type"]) {
    assert.ok(!Object.keys(tool.parameters.properties).includes(forbidden), `schema 不得暴露 ${forbidden}`);
  }
  assert.ok(tools.definitions().some((def) => def.function.name === "count_text"), "count_text 必须注册进通用工具集");
});

// ---------------------------------------------------------------------------
// 冻结输出契约（§2.2）+ 只读自动放行
// ---------------------------------------------------------------------------

test("count_text 返回冻结契约字段与差额，无质量判定字段，只读自动放行", async (t) => {
  const h = await setup(t);
  await fs.mkdir(path.join(h.projectRoot, "正文"), { recursive: true });
  await fs.writeFile(path.join(h.projectRoot, "正文", "第011章.md"), COUNT_FIXTURE, "utf8");
  const result = await h.tools.execute(
    toolCall("count_text", { path: "正文/第011章.md", minimum: 8, target: 20 }),
    h.context
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, {
    path: "正文/第011章.md",
    exists: true,
    ...FIXTURE_COUNTS,
    minimum: 8,
    target: 20,
    minimum_gap: 1,
    target_gap: -11
  });
  // 冻结契约（§2.2）：禁止任何质量判定字段
  for (const forbidden of ["passed", "failed", "below_minimum", "required", "must_call"]) {
    assert.equal(Object.hasOwn(result.result, forbidden), false, `输出不得包含 ${forbidden}`);
  }
  // 审计事件侧同样不得出现判定字段（auditToolResult 是结果的结构化克隆）
  const events = await readEvents(h.journal);
  const completed = eventsOfType(events, "tool_call_completed").find((event) => event.payload.name === "count_text");
  assert.ok(completed, "count_text 应有 tool_call_completed");
  for (const forbidden of ["passed", "failed", "below_minimum", "required", "must_call"]) {
    assert.ok(!JSON.stringify(completed.payload).includes(`"${forbidden}"`), `审计事件不得包含 ${forbidden} 字段`);
  }
  // 项目内只读自动放行：无 decision_requested
  assert.equal(eventsOfType(events, "decision_requested").length, 0);
  assertClosure(events);
});

test("count_text 不传 minimum/target 时差额为 null", async (t) => {
  const h = await setup(t);
  await fs.writeFile(path.join(h.projectRoot, "note.md"), "主角回家。", "utf8");
  const result = await h.tools.execute(toolCall("count_text", { path: "note.md" }), h.context);
  assert.equal(result.ok, true);
  assert.equal(result.result.cjk_characters, 4);
  assert.equal(result.result.minimum, null);
  assert.equal(result.result.target, null);
  assert.equal(result.result.minimum_gap, null);
  assert.equal(result.result.target_gap, null);
  assertClosure(await readEvents(h.journal));
});

test("count_text 是只读工具：read_only 模式下仍可调用", async (t) => {
  const h = await setup(t, { permissions: { read_only: true } });
  await fs.writeFile(path.join(h.projectRoot, "notes.md"), "雨夜", "utf8");
  const result = await h.tools.execute(toolCall("count_text", { path: "notes.md" }), h.context);
  assert.equal(result.ok, true);
  assert.equal(result.result.cjk_characters, 2);
  const events = await readEvents(h.journal);
  assert.equal(eventsOfType(events, "decision_requested").length, 0, "只读工具不得要求确认");
  assertClosure(events);
});

// ---------------------------------------------------------------------------
// 路径与文件类型安全
// ---------------------------------------------------------------------------

test("count_text 缺失文件返回 { path, exists: false }，不抛 ENOENT", async (t) => {
  const h = await setup(t);
  const result = await h.tools.execute(toolCall("count_text", { path: "missing.md" }), h.context);
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, { path: "missing.md", exists: false });
  // 事件侧不泄露 ENOENT/绝对内部路径
  const events = await readEvents(h.journal);
  for (const event of events) {
    assert.ok(!JSON.stringify(event).includes("ENOENT"), "事件不得泄露 ENOENT");
    assert.ok(!JSON.stringify(event).includes(h.dir), "事件不得泄露绝对内部路径");
  }
  assertClosure(events);
});

test("count_text 非 .md/.txt 扩展名返回 unsupported_text_file", async (t) => {
  const h = await setup(t);
  await fs.writeFile(path.join(h.projectRoot, "data.json"), "{}", "utf8");
  const result = await h.tools.execute(toolCall("count_text", { path: "data.json" }), h.context);
  assert.equal(result.ok, false);
  assert.equal(result.error, "unsupported_text_file");
  assert.equal(result.message, "只支持 Markdown 或纯文本文件。");
  assertClosure(await readEvents(h.journal));
});

test("count_text 工作区外路径返回 path_outside_workspace（相对穿越与绝对路径）", async (t) => {
  // yolo 放行权限层，工具自身必须仍拒绝工作区外目标（防护在工具内，不在权限层）
  const h = await setup(t, { permissions: { yolo: true } });
  const outside = path.join(h.dir, "secret.txt");
  await fs.writeFile(outside, "外部内容", "utf8");
  const relativeTraversal = await h.tools.execute(toolCall("count_text", { path: path.relative(h.projectRoot, outside) }), h.context);
  assert.equal(relativeTraversal.ok, false);
  assert.equal(relativeTraversal.error, "path_outside_workspace");
  const absolute = await h.tools.execute(toolCall("count_text", { path: outside }), h.context);
  assert.equal(absolute.ok, false);
  assert.equal(absolute.error, "path_outside_workspace");
  const events = await readEvents(h.journal);
  assert.ok(!JSON.stringify(events).includes("外部内容"), "工作区外文件内容不得被统计或泄露");
  assertClosure(events);
});

test("count_text 支持 .txt 纯文本文件", async (t) => {
  const h = await setup(t);
  await fs.writeFile(path.join(h.projectRoot, "outline.txt"), "第一章\n主角计划。", "utf8");
  const result = await h.tools.execute(toolCall("count_text", { path: "outline.txt" }), h.context);
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, {
    path: "outline.txt",
    exists: true,
    cjk_characters: 7,
    latin_words: 0,
    numeric_tokens: 0,
    punctuation_characters: 1,
    non_whitespace_characters: 8,
    effective_count: 7,
    minimum: null,
    target: null,
    minimum_gap: null,
    target_gap: null
  });
  assertClosure(await readEvents(h.journal));
});

// ---------------------------------------------------------------------------
// 参数校验
// ---------------------------------------------------------------------------

test("count_text 缺少 path 返回 bad_args", async (t) => {
  const h = await setup(t);
  const result = await h.tools.execute(toolCall("count_text", {}), h.context);
  assert.equal(result.ok, false);
  assert.equal(result.error, "bad_args");
  assert.equal(result.message, "参数无效：path 必须是字符串。");
  assertClosure(await readEvents(h.journal));
});
