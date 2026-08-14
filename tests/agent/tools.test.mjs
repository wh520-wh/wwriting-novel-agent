// src/core/agent/tools.mjs（统一 ToolRuntime）的测试（统一 Agent 内核计划 Task 4）。
//
// tests/agent/ 是允许测试内部 seam 的目录：本文件直接导入 tools.mjs 与 journal.mjs，
// 覆盖计划 Task 4 Step 6–9 要求的全部不变量：
//   - 恰好 13 个工具的 typed schema（八个 general + 五个 deep，Task 7 删除
//     enter_workflow、Task 8 删除 commit_blueprint、Task 12 加 read_skill、
//     Task 9 加 count_text）；
//     模型不能提供/覆盖 risk/scope/extreme/grant_key
//   - 系统拥有的风险分类（shell 的 extreme 由运行时判定，模型参数不参与）
//   - 硬能力拒绝优先（dangerous 封印/归档/read_only/safe_edit=false），extreme 确认
//     不能覆盖能力禁用
//   - 权限顺序：extreme → YOLO → 项目内 read 自动 → auto_edit → input grant → 确认
//   - grant 绑定 active_input_id + grant_key + target class；输入切换/清除后过期
//   - stale decision 拒绝（terminal / superseded / 错误确认文字）
//   - YOLO 放行普通项目外操作但不绕过 extreme
//   - extreme 每次动作生成全新 confirmation_text，只有精确匹配可执行
//   - 停止（abort）中止可中断 Shell 工作、作废待决 decision（活动闭环）
//   - tool_output_delta 脱敏后按单次工具累计 1 MiB 截断；跨 chunk 密钥仍被脱敏
//   - 受保护路径拒绝（journal/checkpoints/章节索引/草稿）；正式章节文件可直编
//   - 深工具 schema/权限/审计完整；projectOperations 注入的调用形状
// 本文件不 import src/core/chat/*（Step 9 要求）。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentJournal } from "../../src/core/agent/journal.mjs";
import { sha256 } from "../../src/core/fs-utils.mjs";
import { createToolRuntime } from "../../src/core/agent/tools.mjs";
import { createProjectLockRegistry } from "../../src/core/project-lock.mjs";
import { EXTREME_COMMANDS } from "../fixtures/command-risk-corpus.mjs";

// 本机可用的 extreme 命令（Windows 语料第一条为 del 清盘）
const EXTREME_COMMAND = EXTREME_COMMANDS[0];

const GENERAL_NAMES = ["list_files", "search_files", "read_file", "write_file", "edit_file", "shell", "read_skill", "count_text"];
const DEEP_NAMES = ["update_plan", "append_chapter_segment", "commit_chapter", "finalize_revision", "rollback_chapter"];
// 旧编排工具名全部按片段拼接（避免本文件自身成为 Task 11 Step 6 全库 rg 的命中点，
// 与 dependency-rules.test.mjs 对旧数据文件名的片段约定一致；即使当前 rg 只禁
// 其中两个名字的字面量，其余名字同样按片段构造保持一致性）。
const BANNED_NAMES = [
  "start_" + "run",
  "pause_" + "run",
  "queue_" + "chapters",
  "resolve_" + "failure",
  "export_" + "book"
];

const DEFAULT_PERMISSIONS = {
  network_allowed: false,
  safe_edit: true,
  read_only: false,
  auto_edit: false,
  yolo: false,
  dangerous: false
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

// 创建项目目录 + journal（含一个活动 Run 与活动输入）+ ToolRuntime + 桩依赖。
async function setup(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-tools-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const projectRoot = path.join(dir, "project");
  for (const rel of ["chapters", "drafts", "memory", "checkpoints", ".wwriting/agent/checkpoints"]) {
    await fs.mkdir(path.join(projectRoot, rel), { recursive: true });
  }
  const journal = createAgentJournal({ projectRoot });
  await journal.load();
  const inputId = options.inputId ?? "input-1";
  const runId = options.runId ?? "run-1";
  await journal.appendBatch([
    { type: "run_started", run_id: runId, payload: { input_id: inputId } }
  ]);

  const opsCalls = [];
  const projectOperations = options.projectOperations ?? {
    appendChapterSegment: async (args) => {
      opsCalls.push(["appendChapterSegment", args]);
      return { ok: true, draft_path: "draft.md", bytes_written: 1, actual_words: 1, checksum: "sha256:draft" };
    },
    commitChapter: async (args) => {
      opsCalls.push(["commitChapter", args]);
      return { ok: true, checkpoint_id: "cp-1" };
    },
    finalizeChapter: async (args) => {
      opsCalls.push(["finalizeChapter", args]);
      return { ok: true, chapter_no: args.chapterNo, actual_words: 1, checksum: "sha256:final", checkpoint_id: "cp-final" };
    },
    rollbackChapter: async (args) => {
      opsCalls.push(["rollbackChapter", args]);
      return { ok: true, chapter_no: args.chapterNo, actual_words: 1, checksum: "sha256:rollback", checkpoint_id: "cp-rollback" };
    }
  };

  const shellCalls = [];
  const shellRuntime = options.shellRuntime ?? (async ({ command, cwd, timeoutMs, purpose, signal, onOutput }) => {
    shellCalls.push({ command, cwd, timeoutMs, purpose });
    if (signal?.aborted) {
      const error = new Error("命令已停止。");
      error.code = "shell_cancelled";
      error.stdout = "";
      error.stderr = "";
      error.durationMs = 0;
      throw error;
    }
    onOutput?.({ stream: "stdout", text: `out:${command}` });
    return { exitCode: 0, cwd, signal: null, durationMs: 1, stdout: `out:${command}`, stderr: "" };
  });

  const tools = createToolRuntime({
    projectOperations,
    journal,
    shellRuntime,
    projectLocks: options.projectLocks,
    secrets: options.secrets ?? [],
    ...(options.runtime ?? {})
  });
  const project = {
    project_id: options.projectId ?? "p1",
    archived_at: options.archived_at ?? null,
    output_format: "md",
    tool_permissions: { ...DEFAULT_PERMISSIONS, ...(options.permissions ?? {}) }
  };
  const context = {
    projectRoot,
    project,
    run_id: runId,
    active_input_id: inputId,
    signal: options.signal
  };
  return { tools, journal, context, projectRoot, runId, inputId, shellCalls, opsCalls, dir };
}

async function readEvents(journal) {
  return journal.read({ afterSeq: 0 });
}

function eventsOfType(events, type) {
  return events.filter((event) => event.type === type);
}

// 轮询 journal 直到 predicate 命中（用于等待 execute 挂起后的 decision_requested 等）
async function waitForEvents(journal, predicate, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await readEvents(journal);
    if (predicate(events)) return events;
    await sleep(10);
  }
  throw new Error("waitForEvents 超时");
}

// 活动闭环：每个 tool_call 与 decision 都必须收敛
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

// 等待第 count 个 decision_requested（count 从 1 开始），返回该事件。
// 用数量而不是「最新」定位，避免早先决策的事件让轮询提前返回。
async function nextDecision(journal, count = 1) {
  const events = await waitForEvents(journal, (list) => eventsOfType(list, "decision_requested").length >= count);
  return eventsOfType(events, "decision_requested")[count - 1];
}

// ---------------------------------------------------------------------------
// Step 4/5：注册表与 typed schema、系统拥有的风险
// ---------------------------------------------------------------------------

test("恰好注册八个 general 与五个 deep 工具", () => {
  const tools = createToolRuntime({ journal: { append: async () => {} } });
  const names = tools.definitions().map((def) => def.function.name);
  assert.deepEqual(names, [...GENERAL_NAMES, ...DEEP_NAMES]);
  assert.equal(names.length, 13, "工具总数应为 13（八个 general + 五个 deep，含 finalize_revision 与 rollback_chapter）");
  for (const banned of BANNED_NAMES) {
    assert.ok(!names.includes(banned), `不得注册 ${banned}`);
  }
});

test("shell schema 只暴露 command/cwd/timeout_ms/purpose，模型不能提供风险字段", () => {
  const tools = createToolRuntime({ journal: { append: async () => {} } });
  const shell = tools.definitions().find((def) => def.function.name === "shell").function;
  assert.deepEqual(Object.keys(shell.parameters.properties), ["command", "cwd", "timeout_ms", "purpose"]);
  assert.equal(shell.parameters.additionalProperties, false);
  assert.deepEqual(shell.parameters.required, ["command", "purpose"]);
  assert.equal(shell.parameters.properties.timeout_ms.minimum, 1000);
  assert.equal(shell.parameters.properties.timeout_ms.maximum, 1800000);
  // 其它工具同样不暴露风险字段
  for (const def of tools.definitions()) {
    const props = Object.keys(def.function.parameters.properties);
    for (const forbidden of ["risk", "scope", "extreme", "grant_key", "confirmation_type"]) {
      assert.ok(!props.includes(forbidden), `${def.function.name} 不得暴露 ${forbidden}`);
    }
  }
});

test("deep 工具 schema 与计划一致", () => {
  const tools = createToolRuntime({ journal: { append: async () => {} } });
  const byName = new Map(tools.definitions().map((def) => [def.function.name, def.function]));
  const plan = byName.get("update_plan");
  assert.deepEqual(Object.keys(plan.parameters.properties), ["explanation", "items"]);
  assert.deepEqual(plan.parameters.properties.items.items.properties.status.enum, ["pending", "in_progress", "completed"]);
  assert.deepEqual(plan.parameters.properties.items.items.required, ["id", "step", "status"], "plan 项必须携带稳定 id");
  assert.ok(plan.parameters.properties.items.items.properties.id, "plan 项应有 id 字段");
  assert.ok(plan.parameters.properties.items.items.properties.description, "plan 项应有可选 description");
  assert.ok(!byName.has("enter_workflow"), "Task 7：enter_workflow 必须从注册表删除");
  assert.ok(!byName.has("commit_blueprint"), "Task 8：commit_blueprint 必须从注册表删除");
  assert.deepEqual(
    Object.keys(byName.get("append_chapter_segment").parameters.properties).sort(),
    ["chapter_no", "content", "project_id", "segment_no"]
  );
  assert.deepEqual(
    Object.keys(byName.get("commit_chapter").parameters.properties).sort(),
    ["chapter_no", "expected_draft_checksum", "project_id"],
    "Task 10：commit_chapter 不得再暴露 exception_decisions"
  );
});

// ---------------------------------------------------------------------------
// read_skill（Task 12 Step 2/3：schema 逐字、只读自动放行、二进制 asset）
// ---------------------------------------------------------------------------

const BUILTIN_ROOT = path.resolve(import.meta.dirname, "..", "..", "src", "skills");

// 临时 root 的 skills service（内置技能来自仓库 src/skills；migration marker 只
// 写进临时 home，绝不触碰真实用户目录）。
async function tempSkillService(t) {
  const homeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-tools-skill-"));
  const home = path.join(homeRoot, "home");
  t.after(async () => {
    await fs.rm(homeRoot, { recursive: true, force: true });
  });
  const { createSkillService } = await import("../../src/core/skills/index.mjs");
  return createSkillService({ userHome: home, resourcesPath: null, builtinRoot: BUILTIN_ROOT });
}

test("read_skill schema 与 Task 12 冻结契约逐字一致", () => {
  const tools = createToolRuntime({ journal: { append: async () => {} } });
  const tool = tools.definitions().find((def) => def.function.name === "read_skill").function;
  assert.equal(tool.description, "读取已发现 Agent Skill 的 SKILL.md 或其安全资源。");
  assert.deepEqual(Object.keys(tool.parameters.properties), ["name", "resource"]);
  assert.deepEqual(tool.parameters.required, ["name"]);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.equal(
    tool.parameters.properties.resource.description,
    "默认 SKILL.md；也可为 references/...、scripts/...、assets/..."
  );
  // 只读类别：项目内 read 自动放行，不产生决策、不弹写入确认（见下方执行测试）
});

test("read_skill 按 active catalog name 返回 SKILL.md 正文，只读自动放行无决策", async (t) => {
  const h = await setup(t, { runtime: { skills: await tempSkillService(t) } });
  const result = await h.tools.execute(
    toolCall("read_skill", { name: "suspense-chapter-end" }),
    h.context
  );
  assert.equal(result.ok, true);
  assert.equal(result.result.name, "suspense-chapter-end");
  assert.equal(result.result.resource, "SKILL.md");
  assert.ok(result.result.content.includes("## Instructions"), "返回 SKILL.md 完整正文");
  assert.ok(result.result.content.includes("悬念"), "正文含技能指令");
  assert.equal(typeof result.result.path, "string");
  assert.ok(Number.isInteger(result.result.bytes));
  // 项目内只读：自动放行，不弹确认
  const events = await readEvents(h.journal);
  assert.equal(eventsOfType(events, "decision_requested").length, 0, "read_skill 是只读工具，不得要求确认");
  assertClosure(events);
});

test("read_skill 读取命名安全资源（references/...）", async (t) => {
  const h = await setup(t, { runtime: { skills: await tempSkillService(t) } });
  // 项目层技能带 references 资源
  const skillDir = path.join(h.projectRoot, "skills", "ref-skill");
  await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: ref-skill\ndescription: ref\n---\n\n# Ref\n",
    "utf8"
  );
  await fs.writeFile(path.join(skillDir, "references", "guide.md"), "# 参考\n", "utf8");
  const result = await h.tools.execute(
    toolCall("read_skill", { name: "ref-skill", resource: "references/guide.md" }),
    h.context
  );
  assert.equal(result.ok, true);
  assert.equal(result.result.content, "# 参考\n");
});

test("read_skill 未知技能名返回 skill_not_found", async (t) => {
  const h = await setup(t, { runtime: { skills: await tempSkillService(t) } });
  const result = await h.tools.execute(toolCall("read_skill", { name: "no-such-skill" }), h.context);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "skill_not_found");
});

test("read_skill 拒绝穿越技能目录的资源路径", async (t) => {
  const h = await setup(t, { runtime: { skills: await tempSkillService(t) } });
  const skillDir = path.join(h.projectRoot, "skills", "esc-skill");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: esc-skill\ndescription: esc\n---\n\n# Esc\n",
    "utf8"
  );
  await fs.writeFile(path.join(h.projectRoot, "secret.txt"), "x", "utf8");
  const result = await h.tools.execute(
    toolCall("read_skill", { name: "esc-skill", resource: "../../secret.txt" }),
    h.context
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "skill_resource_unsafe");
});

test("read_skill 二进制 asset 返回元数据+绝对路径，不把二进制塞进模型上下文", async (t) => {
  const h = await setup(t, { runtime: { skills: await tempSkillService(t) } });
  const skillDir = path.join(h.projectRoot, "skills", "bin-skill");
  await fs.mkdir(path.join(skillDir, "assets"), { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: bin-skill\ndescription: bin\n---\n\n# Bin\n",
    "utf8"
  );
  const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
  await fs.writeFile(path.join(skillDir, "assets", "cover.png"), payload);
  const result = await h.tools.execute(
    toolCall("read_skill", { name: "bin-skill", resource: "assets/cover.png" }),
    h.context
  );
  assert.equal(result.ok, true);
  assert.equal(result.result.binary, true, "二进制 asset 标记 binary=true");
  assert.equal(result.result.content, undefined, "二进制内容不得进入模型上下文");
  assert.equal(result.result.bytes, payload.length);
  assert.ok(result.result.path.endsWith(path.join("assets", "cover.png")), "返回绝对路径");
  // 审计事件同样不含二进制内容（content_length 只针对文本读取）
  const events = await readEvents(h.journal);
  const completed = eventsOfType(events, "tool_call_completed").find((event) => event.payload.name === "read_skill");
  assert.ok(completed, "read_skill 应有 tool_call_completed");
  assert.equal(completed.payload.binary, true);
  assert.equal(completed.payload.content, undefined);
  assertClosure(events);
});

test("read_skill 未注入 skills service 时返回 工具不可用。", async (t) => {
  // setup 缺省注入全局单例；这里显式注入空 service 模拟未接线
  const h = await setup(t, { runtime: { skills: {} } });
  const result = await h.tools.execute(toolCall("read_skill", { name: "suspense-chapter-end" }), h.context);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "not_wired");
  assert.equal(result.message, "工具不可用。");
});

// ---------------------------------------------------------------------------
// 权限：只读自动 / 普通确认 / grant / 硬拒绝
// ---------------------------------------------------------------------------

test("项目内 read 自动执行，不产生决策", async (t) => {
  const h = await setup(t);
  await fs.writeFile(path.join(h.projectRoot, "notes.md"), "hello", "utf8");
  const result = await h.tools.execute(toolCall("read_file", { path: "notes.md" }), h.context);
  assert.equal(result.ok, true);
  assert.equal(result.result.content, "hello");
  const events = await readEvents(h.journal);
  assert.equal(eventsOfType(events, "decision_requested").length, 0);
  assert.equal(eventsOfType(events, "tool_call_completed").at(-1).payload.name, "read_file");
  assertClosure(events);
});

test("普通写入暂停等待确认；允许后落盘并写全事件链", async (t) => {
  const h = await setup(t);
  const pending = h.tools.execute(toolCall("write_file", { path: "notes.md", content: "第一条笔记" }), h.context);
  const events = await waitForEvents(h.journal, (list) => eventsOfType(list, "decision_requested").length >= 1);
  const decision = eventsOfType(events, "decision_requested")[0];
  assert.ok(decision.payload.decision_id);
  assert.ok(decision.payload.activity_id);
  assert.equal(decision.payload.kind, "normal");
  assert.equal(decision.payload.input_id, h.inputId);
  assert.equal(decision.payload.fingerprint.includes("write:project:project-root"), true);
  // waiting_user 状态在 decision_requested 之前写入
  const statusEvents = eventsOfType(events, "run_status_changed");
  assert.equal(statusEvents.at(-1).payload.status, "waiting_user");
  const session = await h.journal.getSession();
  assert.equal(session.status, "waiting_user");

  await h.tools.resolveDecision({ decisionId: decision.payload.decision_id, choice: "allow" });
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(await fs.readFile(path.join(h.projectRoot, "notes.md"), "utf8"), "第一条笔记");
  const done = await readEvents(h.journal);
  assert.equal(eventsOfType(done, "decision_resolved")[0].payload.choice, "allow");
  assert.equal(eventsOfType(done, "run_status_changed").at(-1).payload.status, "running");
  assert.ok(eventsOfType(done, "tool_call_completed").some((event) => event.payload.name === "write_file"));
  assertClosure(done);
});

test("allow_input 创建绑定 active_input_id 的 grant，同类操作在本条输入内自动放行", async (t) => {
  const h = await setup(t);
  const pending1 = h.tools.execute(toolCall("write_file", { path: "a.txt", content: "A" }), h.context);
  const decision1 = await nextDecision(h.journal);
  await h.tools.resolveDecision({ decisionId: decision1.payload.decision_id, choice: "allow_input" });
  const result1 = await pending1;
  assert.equal(result1.ok, true);

  // 同一输入内第二个同 key 写操作：grant 命中，不再确认
  const result2 = await h.tools.execute(toolCall("write_file", { path: "b.txt", content: "B" }), h.context);
  assert.equal(result2.ok, true);
  const events = await readEvents(h.journal);
  const grants = eventsOfType(events, "permission_grant_created");
  assert.equal(grants.length, 1);
  assert.equal(grants[0].payload.input_id, h.inputId);
  assert.equal(grants[0].payload.grant_key, "write:project:project-root");
  assert.equal(eventsOfType(events, "decision_requested").length, 1, "第二条写入不得再次确认");
  assertClosure(events);

  // 清除 grant（input 完成/切换时运行时调用）→ 再次写入需确认（第二个决策）
  const cleared = await h.tools.clearGrants({ inputId: h.inputId, reason: "input_consumed" });
  assert.equal(cleared, 1);
  const pending3 = h.tools.execute(toolCall("write_file", { path: "c.txt", content: "C" }), h.context);
  const decision3 = await nextDecision(h.journal, 2);
  await h.tools.resolveDecision({ decisionId: decision3.payload.decision_id, choice: "allow" });
  const result3 = await pending3;
  assert.equal(result3.ok, true);
  const done = await readEvents(h.journal);
  assert.ok(eventsOfType(done, "permission_grant_cleared").some((event) => event.payload.input_id === h.inputId));
  assertClosure(done);
});

test("grant 不跨输入：切换活动输入后同类操作重新确认，旧决策 superseded", async (t) => {
  const h = await setup(t);
  const pending1 = h.tools.execute(toolCall("write_file", { path: "a.txt", content: "A" }), h.context);
  const decision1 = await nextDecision(h.journal);
  await h.tools.resolveDecision({ decisionId: decision1.payload.decision_id, choice: "allow_input" });
  await pending1;

  // 「立即」切换活动输入（journal 事件由 Task 6 编排，这里直接构造）
  const input2 = "input-2";
  await h.journal.appendBatch([
    { type: "input_queued", run_id: h.runId, payload: { input_id: input2, text: "第二条" } },
    { type: "input_consumed", run_id: h.runId, payload: { input_id: input2 } }
  ]);

  // 新输入下写操作：input-1 的 grant 不得放行 → 重新确认（第二个决策）
  const context2 = { ...h.context, active_input_id: input2 };
  const pending2 = h.tools.execute(toolCall("write_file", { path: "b.txt", content: "B" }), h.context && context2);
  const decision2 = await nextDecision(h.journal, 2);
  assert.equal(decision2.payload.input_id, input2, "新输入的决策必须绑定新输入");
  await h.tools.resolveDecision({ decisionId: decision2.payload.decision_id, choice: "allow" });
  const result2 = await pending2;
  assert.equal(result2.ok, true);

  // 第三笔写入（input-2 下）保持待决，不解析
  const pending3 = h.tools.execute(toolCall("write_file", { path: "c.txt", content: "C" }), h.context && context2);
  const decision3 = await nextDecision(h.journal, 3);
  assert.equal(decision3.payload.input_id, input2);

  // 再次切换活动输入（input-3）：旧响应此刻到达 → decision3 被 superseded 拒绝
  const input3 = "input-3";
  await h.journal.appendBatch([
    { type: "input_queued", run_id: h.runId, payload: { input_id: input3, text: "第三条" } },
    { type: "input_consumed", run_id: h.runId, payload: { input_id: input3 } }
  ]);
  await assert.rejects(
    () => h.tools.resolveDecision({ decisionId: decision3.payload.decision_id, choice: "allow" }),
    (error) => error.code === "decision_superseded"
  );
  const result3 = await pending3;
  assert.equal(result3.ok, false, "被 superseded 的决策不得执行工具");
  assert.equal(await pathExists(path.join(h.projectRoot, "c.txt")), false);

  // 早已解析的决策（input-1 的 grant 决策）此刻是终态
  await assert.rejects(
    () => h.tools.resolveDecision({ decisionId: decision1.payload.decision_id, choice: "allow_input" }),
    (error) => error.code === "decision_terminal"
  );
  const done = await readEvents(h.journal);
  assert.ok(
    eventsOfType(done, "decision_resolved").some((event) => event.payload.choice === "superseded"),
    "superseded 决策必须写 decision_resolved 终态（活动闭环）"
  );
  assertClosure(done);
});

test("deny 决策不落盘，返回 操作已拒绝。", async (t) => {
  const h = await setup(t);
  const pending = h.tools.execute(toolCall("write_file", { path: "denied.txt", content: "不应出现" }), h.context);
  const decision = await nextDecision(h.journal);
  await h.tools.resolveDecision({ decisionId: decision.payload.decision_id, choice: "deny" });
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "permission_denied");
  assert.equal(result.message, "操作已拒绝。");
  assert.equal(await pathExists(path.join(h.projectRoot, "denied.txt")), false);
  const events = await readEvents(h.journal);
  const failed = eventsOfType(events, "tool_call_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].payload.error, "permission_denied");
  assertClosure(events);
});

test("stale decision：已终结的决策不能再次处理", async (t) => {
  const h = await setup(t);
  const pending = h.tools.execute(toolCall("write_file", { path: "a.txt", content: "A" }), h.context);
  const decision = await nextDecision(h.journal);
  await h.tools.resolveDecision({ decisionId: decision.payload.decision_id, choice: "allow" });
  await pending;
  await assert.rejects(
    () => h.tools.resolveDecision({ decisionId: decision.payload.decision_id, choice: "allow" }),
    (error) => error.code === "decision_terminal"
  );
  await assert.rejects(
    () => h.tools.resolveDecision({ decisionId: "no-such-decision", choice: "allow" }),
    (error) => error.code === "decision_not_found"
  );
});

test("硬能力拒绝优先：read_only / 归档 / dangerous 封印 / safe_edit=false", async (t) => {
  // read_only：写拒绝、读放行，extreme 也不能覆盖
  {
    const h = await setup(t, { permissions: { read_only: true } });
    const result = await h.tools.execute(toolCall("write_file", { path: "a.txt", content: "A" }), h.context);
    assert.equal(result.ok, false);
    assert.equal(result.message, "当前为只读模式。");
    const extremeResult = await h.tools.execute(toolCall("shell", { command: EXTREME_COMMAND, purpose: "高危" }), h.context);
    assert.equal(extremeResult.ok, false);
    assert.equal(extremeResult.message, "当前为只读模式。");
    await fs.writeFile(path.join(h.projectRoot, "notes.md"), "x", "utf8");
    const read = await h.tools.execute(toolCall("read_file", { path: "notes.md" }), h.context);
    assert.equal(read.ok, true);
    assertClosure(await readEvents(h.journal));
  }
  // 归档态
  {
    const h = await setup(t, { archived_at: "2026-08-01T00:00:00.000Z" });
    const result = await h.tools.execute(toolCall("write_file", { path: "a.txt", content: "A" }), h.context);
    assert.equal(result.ok, false);
    assert.equal(result.message, "项目已归档，无法修改。");
  }
  // dangerous 封印
  {
    const h = await setup(t, { permissions: { dangerous: true } });
    const result = await h.tools.execute(toolCall("write_file", { path: "a.txt", content: "A" }), h.context);
    assert.equal(result.ok, false);
    assert.equal(result.message, "当前权限不允许修改文件。");
  }
  // safe_edit=false：正文/设定写入与深工具硬拒绝，普通文件仍可确认
  {
    const h = await setup(t, { permissions: { safe_edit: false } });
    const outline = await h.tools.execute(toolCall("write_file", { path: "OUTLINE.md", content: "# O" }), h.context);
    assert.equal(outline.ok, false);
    assert.equal(outline.message, "当前权限不允许修改文件。");
    const chapter = await h.tools.execute(toolCall("write_file", { path: "chapters/001.md", content: "x" }), h.context);
    assert.equal(chapter.ok, false);
    const deep = await h.tools.execute(toolCall("append_chapter_segment", {
      project_id: "p1",
      chapter_no: 1,
      segment_no: 1,
      content: "正文"
    }), h.context);
    assert.equal(deep.ok, false);
    assert.equal(h.opsCalls.length, 0, "safe_edit=false 时深工具不得调用 project operations");
    const pending = h.tools.execute(toolCall("write_file", { path: "notes.md", content: "n" }), h.context);
    const decision = await nextDecision(h.journal);
    await h.tools.resolveDecision({ decisionId: decision.payload.decision_id, choice: "allow" });
    assert.equal((await pending).ok, true, "safe_edit=false 不阻止普通项目文件写入");
    assertClosure(await readEvents(h.journal));
  }
});

test("extreme 确认每次生成全新文字；错误文字/历史文字均不能解锁", async (t) => {
  const h = await setup(t);
  const pending1 = h.tools.execute(toolCall("shell", { command: EXTREME_COMMAND, purpose: "高危一" }), h.context);
  const decision1 = await nextDecision(h.journal);
  assert.equal(decision1.payload.kind, "extreme");
  const text1 = decision1.payload.confirmation_text;
  assert.ok(text1 && text1.length > 0, "extreme 决策必须生成确认文字");
  // 错误文字（含模型文本、allow 等）拒绝且决策保持待决
  for (const wrong of ["不匹配的文字", "allow", "allow_input", "deny"]) {
    await assert.rejects(
      () => h.tools.resolveDecision({ decisionId: decision1.payload.decision_id, choice: wrong }),
      (error) => error.code === "confirmation_mismatch"
    );
  }
  await h.tools.resolveDecision({ decisionId: decision1.payload.decision_id, choice: text1 });
  const result1 = await pending1;
  assert.equal(result1.ok, true);
  assert.equal(h.shellCalls[0].command, EXTREME_COMMAND);

  // 第二个 extreme：确认文字必须全新（第二个决策）
  const pending2 = h.tools.execute(toolCall("shell", { command: EXTREME_COMMAND, purpose: "高危二" }), h.context);
  const decision2 = await nextDecision(h.journal, 2);
  const text2 = decision2.payload.confirmation_text;
  assert.ok(text2 && text2 !== text1, "每个 extreme 动作都必须生成全新确认文字");
  await assert.rejects(
    () => h.tools.resolveDecision({ decisionId: decision2.payload.decision_id, choice: text1 }),
    (error) => error.code === "confirmation_mismatch"
  );
  await h.tools.resolveDecision({ decisionId: decision2.payload.decision_id, choice: text2 });
  const result2 = await pending2;
  assert.equal(result2.ok, true);
  assertClosure(await readEvents(h.journal));
});

test("YOLO 放行普通写入（含项目外）但不绕过 extreme", async (t) => {
  const h = await setup(t, { permissions: { yolo: true } });
  const inside = await h.tools.execute(toolCall("write_file", { path: "yolo-note.txt", content: "Y" }), h.context);
  assert.equal(inside.ok, true, "YOLO 应自动放行项目内普通写入");
  const outsidePath = path.join(h.dir, "outside.txt");
  const outside = await h.tools.execute(toolCall("write_file", { path: outsidePath, content: "O" }), h.context);
  assert.equal(outside.ok, true, "YOLO 应放行项目外普通写入");
  assert.equal(await pathExists(outsidePath), true);

  const pending = h.tools.execute(toolCall("shell", { command: EXTREME_COMMAND, purpose: "高危" }), h.context);
  const decision = await nextDecision(h.journal);
  assert.equal(decision.payload.kind, "extreme", "YOLO 不得跳过 extreme 确认");
  await h.tools.resolveDecision({ decisionId: decision.payload.decision_id, choice: decision.payload.confirmation_text });
  assert.equal((await pending).ok, true);
  const events = await readEvents(h.journal);
  assert.equal(eventsOfType(events, "decision_requested").length, 1, "YOLO 下只有 extreme 需要确认");
  assertClosure(events);
});

test("auto_edit 自动放行项目内 write，项目外仍需确认", async (t) => {
  const h = await setup(t, { permissions: { auto_edit: true } });
  const inside = await h.tools.execute(toolCall("write_file", { path: "auto.txt", content: "A" }), h.context);
  assert.equal(inside.ok, true);
  const pending = h.tools.execute(toolCall("write_file", { path: path.join(h.dir, "out.txt"), content: "O" }), h.context);
  const decision = await nextDecision(h.journal);
  await h.tools.resolveDecision({ decisionId: decision.payload.decision_id, choice: "allow" });
  assert.equal((await pending).ok, true);
  const events = await readEvents(h.journal);
  assert.equal(eventsOfType(events, "decision_requested").length, 1);
  assertClosure(events);
});

test("junction 指向项目外时按真实路径判定，不能绕过 auto_edit", { skip: process.platform !== "win32" }, async (t) => {
  const h = await setup(t, { permissions: { auto_edit: true } });
  const outsideRoot = path.join(h.dir, "outside");
  await fs.mkdir(outsideRoot, { recursive: true });
  const junction = path.join(h.projectRoot, "external-link");
  await fs.symlink(outsideRoot, junction, "junction");

  const pending = h.tools.execute(
    toolCall("write_file", { path: "external-link/pwn.txt", content: "outside" }),
    h.context
  );
  const decision = await nextDecision(h.journal);
  assert.equal(decision.payload.kind, "normal");
  await h.tools.resolveDecision({ decisionId: decision.payload.decision_id, choice: "allow" });
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(await fs.readFile(path.join(outsideRoot, "pwn.txt"), "utf8"), "outside");
});

test("Agent 写工具与 HTTP 操作共用同一个项目锁", async (t) => {
  const projectLocks = createProjectLockRegistry();
  const h = await setup(t, { permissions: { auto_edit: true }, projectLocks });
  let releaseHttpOperation;
  const httpOperationStarted = new Promise((resolve) => {
    void projectLocks.runExclusive(h.projectRoot, async () => {
      resolve();
      await new Promise((release) => { releaseHttpOperation = release; });
    });
  });
  await httpOperationStarted;

  let settled = false;
  const write = h.tools.execute(
    toolCall("write_file", { path: "locked.txt", content: "serialized" }),
    h.context
  ).then((result) => {
    settled = true;
    return result;
  });
  await sleep(30);
  assert.equal(settled, false, "HTTP 操作持锁期间 Agent 写入必须等待");
  assert.equal(await pathExists(path.join(h.projectRoot, "locked.txt")), false);

  releaseHttpOperation();
  const result = await write;
  assert.equal(result.ok, true);
  assert.equal(await fs.readFile(path.join(h.projectRoot, "locked.txt"), "utf8"), "serialized");
});

// ---------------------------------------------------------------------------
// 受保护路径（Step 7）
// ---------------------------------------------------------------------------

test("通用写工具拒绝直接写受保护路径", async (t) => {
  const h = await setup(t);
  // journal 审计事件会正常追加到 segments/events（新分段格式）；用唯一 marker
  // 断言被拒的写入内容从未落盘
  const MARKER = "PROTECTED_WRITE_MARKER_9f3c";
  const agentDir = path.join(h.projectRoot, ".wwriting", "agent");
  const protectedTargets = [
    ["events.jsonl", ".wwriting/agent/events.jsonl"],
    ["session.json", ".wwriting/agent/session.json"],
    ["transcript.jsonl", ".wwriting/agent/transcript.jsonl"],
    ["agent journal 新文件", ".wwriting/agent/private.txt"],
    ["agent checkpoints", ".wwriting/agent/checkpoints/x.json"],
    ["project checkpoints", "checkpoints/cp.json"],
    ["chapter index", "memory/chapter_index.json"],
    ["draft file", "drafts/001.draft.md"],
    ["draft 中间点文件名", "drafts/2.修订.draft.txt"],
    ["version archive", ".versions/chapters/001/v1.md"],
    ["memory archive", "memory/chapter_memory.json"],
    ["project config", "project.yaml"]
  ];
  for (const [label, rel] of protectedTargets) {
    const result = await h.tools.execute(toolCall("write_file", { path: rel, content: MARKER }), h.context);
    assert.equal(result.ok, false, `write_file 应拒绝 ${label}`);
    assert.ok(typeof result.message === "string" && result.message.length > 0, "拒绝消息必须有内容");
  }
  // memory/ 与 project.yaml 拒绝消息按 rule 提供明确指引（非泛化『当前权限不允许修改文件』）
  for (const label of ["memory archive", "project config"]) {
    const [entryLabel, rel] = protectedTargets.find(([l]) => l === label);
    const result = await h.tools.execute(toolCall("write_file", { path: rel, content: MARKER }), h.context);
    assert.ok(result.message.includes("系统文件，只读"), `${entryLabel} 拒绝消息必须声明系统文件只读`);
  }
  const draftResult = await h.tools.execute(toolCall("write_file", { path: "drafts/001.draft.md", content: MARKER }), h.context);
  assert.ok(draftResult.message.includes("append_chapter_segment"), "草稿拒绝消息必须提示合法通道 append_chapter_segment");
  // events 落在 segments/events；拒绝写入不得产生脏行（每行仍是合法 JSON）
  const eventsSegment = path.join(agentDir, "segments", "events", "00000001.jsonl");
  const eventsFile = await fs.readFile(eventsSegment, "utf8");
  for (const line of eventsFile.split("\n").filter((l) => l.trim() !== "")) {
    assert.doesNotThrow(() => JSON.parse(line), "events segment 必须保持合法 JSONL（被拒写入不得产生脏行）");
  }
  const sessionFile = await fs.readFile(path.join(agentDir, "session.json"), "utf8");
  assert.ok(!sessionFile.includes(MARKER), "session.json 投影不得包含被拒写入内容");
  // 本测试未追加任何 transcript：不得创建单体 transcript.jsonl（新格式）
  assert.equal(await pathExists(path.join(agentDir, "transcript.jsonl")), false, "不得创建单体 transcript.jsonl");
  assert.equal(await pathExists(path.join(agentDir, "private.txt")), false);
  assert.equal(await pathExists(path.join(h.projectRoot, "checkpoints", "cp.json")), false);
  assert.equal(await pathExists(path.join(h.projectRoot, "memory", "chapter_index.json")), false);
  assert.equal(await pathExists(path.join(h.projectRoot, "chapters", "001.md")), false);
  assert.equal(await pathExists(path.join(h.projectRoot, "drafts", "001.draft.md")), false);
  // 普通项目文件不受影响（仍受普通确认约束）
  const pendingOk = h.tools.execute(toolCall("write_file", { path: "notes.md", content: "n" }), h.context);
  const okDecision = await nextDecision(h.journal);
  await h.tools.resolveDecision({ decisionId: okDecision.payload.decision_id, choice: "allow" });
  const ok = await pendingOk;
  assert.equal(ok.ok, true);
  assertClosure(await readEvents(h.journal));
});

test("受保护路径大小写变体不能绕过（win32 文件系统大小写不敏感）", { skip: process.platform !== "win32" }, async (t) => {
  // auto_edit 下普通项目写会自动放行——若大小写变体绕过保护，会静默写入
  const h = await setup(t, { permissions: { auto_edit: true } });
  const variants = [
    ".wwriting/AGENT/events.jsonl",
    ".wwriting/Agent/session.json",
    "Checkpoints/cp.json",
    "memory/Chapter_Index.json",
    "DRAFTS/001.draft.md"
  ];
  for (const rel of variants) {
    const result = await h.tools.execute(toolCall("write_file", { path: rel, content: "x" }), h.context);
    assert.equal(result.ok, false, `大小写变体 ${rel} 必须被拒绝`);
    assert.ok(typeof result.message === "string" && result.message.length > 0, "拒绝消息必须有内容");
  }
  // 对照组：大小写正确的普通文件在 auto_edit 下自动放行
  const ok = await h.tools.execute(toolCall("write_file", { path: "notes.md", content: "n" }), h.context);
  assert.equal(ok.ok, true, "auto_edit 下普通项目写仍自动放行");
  assertClosure(await readEvents(h.journal));
});

test("drafts/ 只能经 append_chapter_segment 写入：auto_edit 与 yolo 下直写也被拒", async (t) => {
  for (const permissions of [{ auto_edit: true }, { yolo: true }]) {
    const h = await setup(t, { permissions });
    for (const rel of ["drafts/001.draft.md", "drafts/001.draft.txt"]) {
      const result = await h.tools.execute(toolCall("write_file", { path: rel, content: "正文" }), h.context);
      assert.equal(result.ok, false, `${JSON.stringify(permissions)} 下直写草稿 ${rel} 必须被拒`);
      assert.ok(result.message.includes("append_chapter_segment"), `${rel} 拒绝消息必须提示合法通道 append_chapter_segment`);
      assert.equal(await pathExists(path.join(h.projectRoot, rel)), false);
    }
    const edit = await h.tools.execute(
      toolCall("edit_file", { path: "drafts/001.draft.md", find: "x", replace: "y" }),
      h.context
    );
    assert.equal(edit.ok, false, "edit_file 直写草稿同样被拒");
    // 常规项目文件在 auto_edit/yolo 下仍可写
    const ok = await h.tools.execute(toolCall("write_file", { path: "notes.md", content: "n" }), h.context);
    assert.equal(ok.ok, true);
    assertClosure(await readEvents(h.journal));
  }
});

test("正式章节文件可直接编辑：auto_edit/yolo 下 write_file/edit_file 放行，系统文件仍拒", async (t) => {
  for (const permissions of [{ auto_edit: true }, { yolo: true }]) {
    const h = await setup(t, { permissions });
    const rel = "chapters/001.md";
    await fs.mkdir(path.join(h.projectRoot, "chapters"), { recursive: true });
    await fs.writeFile(path.join(h.projectRoot, rel), "第一章 原始正文", "utf8");
    const edit = await h.tools.execute(
      toolCall("edit_file", { path: rel, find: "原始", replace: "修订后" }),
      h.context
    );
    assert.equal(edit.ok, true, `${JSON.stringify(permissions)} 下 edit_file 编辑正式章节应放行`);
    assert.match(await fs.readFile(path.join(h.projectRoot, rel), "utf8"), /修订后/u);
    const write = await h.tools.execute(
      toolCall("write_file", { path: rel, content: "整章重写" }),
      h.context
    );
    assert.equal(write.ok, true, "write_file 整章重写应放行");
    assert.equal(await fs.readFile(path.join(h.projectRoot, rel), "utf8"), "整章重写");
    // 草稿与索引仍受保护
    const draft = await h.tools.execute(toolCall("write_file", { path: "drafts/001.draft.md", content: "x" }), h.context);
    assert.equal(draft.ok, false, "草稿仍必须经 append_chapter_segment 写入");
    const index = await h.tools.execute(toolCall("write_file", { path: "memory/chapter_index.json", content: "{}" }), h.context);
    assert.equal(index.ok, false, "章节索引仍只读");
    assertClosure(await readEvents(h.journal));
  }
});

test("edit_file/write_file expected_checksum 防覆盖：匹配放行、过期拒绝、缺省不检查", async (t) => {
  const h = await setup(t, { permissions: { auto_edit: true } });
  const rel = "chapters/001.md";
  await fs.mkdir(path.join(h.projectRoot, "chapters"), { recursive: true });
  await fs.writeFile(path.join(h.projectRoot, rel), "v1 正文", "utf8");
  const stale = sha256("v1 正文");
  // 匹配：通过
  const ok = await h.tools.execute(
    toolCall("edit_file", { path: rel, find: "v1", replace: "v2", expected_checksum: stale }),
    h.context
  );
  assert.equal(ok.ok, true, "expected_checksum 匹配应放行");
  // 过期：拒绝（文件已被改为 v2，旧校验和 stale）
  const staleEdit = await h.tools.execute(
    toolCall("edit_file", { path: rel, find: "v2", replace: "v3", expected_checksum: stale }),
    h.context
  );
  assert.equal(staleEdit.ok, false);
  assert.equal(staleEdit.error.code, "stale_checksum");
  assert.equal(await fs.readFile(path.join(h.projectRoot, rel), "utf8"), "v2 正文", "过期编辑不得落盘");
  // write_file 同样拒绝过期覆盖
  const staleWrite = await h.tools.execute(
    toolCall("write_file", { path: rel, content: "v9", expected_checksum: stale }),
    h.context
  );
  assert.equal(staleWrite.ok, false);
  assert.equal(staleWrite.error.code, "stale_checksum");
  // 缺省：不检查（向后兼容）
  const none = await h.tools.execute(toolCall("edit_file", { path: rel, find: "v2", replace: "v4" }), h.context);
  assert.equal(none.ok, true);
  assert.equal(await fs.readFile(path.join(h.projectRoot, rel), "utf8"), "v4 正文");
  assertClosure(await readEvents(h.journal));
});

test("write_file expected_checksum + 目标不存在：拒绝 file_not_found", async (t) => {
  const h = await setup(t, { permissions: { auto_edit: true } });
  await fs.mkdir(path.join(h.projectRoot, "chapters"), { recursive: true });
  const missing = await h.tools.execute(
    toolCall("write_file", { path: "chapters/002.md", content: "x", expected_checksum: "sha256:x" }),
    h.context
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "file_not_found");
  assertClosure(await readEvents(h.journal));
});

test("tool_call_failed 的 message 先脱敏（路径内嵌 token 形片段不泄漏）", async (t) => {
  const h = await setup(t);
  const tokenPath = "sk-abcdefghijklmnop/notes.txt";
  const result = await h.tools.execute(toolCall("read_file", { path: tokenPath }), h.context);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "file_not_found");
  assert.ok(!result.message.includes("sk-abcdefghijklmnop"), "返回 message 不得含 token 明文");
  const failed = eventsOfType(await readEvents(h.journal), "tool_call_failed")[0];
  assert.ok(!failed.payload.message.includes("sk-abcdefghijklmnop"), "事件 message 不得含 token 明文");
  assert.ok(failed.payload.message.includes("[REDACTED]"), "事件 message 应已脱敏");
  assertClosure(await readEvents(h.journal));
});

test("plan_updated 事件侧脱敏（事件侧统一脱敏口径）", async (t) => {
  const h = await setup(t);
  const result = await h.tools.execute(
    toolCall("update_plan", {
      explanation: "检查 api_key=abc123secret",
      items: [{ id: "read", step: "读取 sk-abcdefghijklmnop", status: "in_progress" }]
    }),
    h.context
  );
  assert.equal(result.ok, true);
  // 返回值原样（模型看得到自己写的计划）
  assert.equal(result.result.items[0].step, "读取 sk-abcdefghijklmnop");
  const updated = eventsOfType(await readEvents(h.journal), "plan_updated")[0];
  assert.ok(updated.payload.explanation.includes("[REDACTED]"), "explanation 应脱敏");
  assert.ok(!updated.payload.explanation.includes("abc123secret"), "explanation 不得含密钥");
  assert.ok(updated.payload.items[0].step.includes("[REDACTED]"), "plan step 应脱敏");
  assert.ok(!updated.payload.items[0].step.includes("sk-abcdefghijklmnop"), "plan step 不得含 token");
  assertClosure(await readEvents(h.journal));
});

test("clearGrants 同时清理该 input 的终态决策记录（decisions 表有界）", async (t) => {
  const h = await setup(t);
  const pending = h.tools.execute(toolCall("write_file", { path: "a.txt", content: "A" }), h.context);
  const decision = await nextDecision(h.journal);
  await h.tools.resolveDecision({ decisionId: decision.payload.decision_id, choice: "allow" });
  await pending;
  assert.equal(h.tools._pendingDecisionCount(), 0, "已解析决策不再计入待决");
  await h.tools.clearGrants({ inputId: h.inputId, reason: "input_consumed" });
  // 记录被清理后，旧响应得到 decision_not_found（同样是拒绝；语义与 terminal 等价）
  await assert.rejects(
    () => h.tools.resolveDecision({ decisionId: decision.payload.decision_id, choice: "allow" }),
    (error) => ["decision_not_found", "decision_terminal"].includes(error.code)
  );
  assertClosure(await readEvents(h.journal));
});

test("shell 拒绝在 journal / checkpoints 目录内运行", async (t) => {
  const h = await setup(t);
  const cwdResult = await h.tools.execute(
    toolCall("shell", { command: "echo hi", cwd: path.join(h.projectRoot, ".wwriting", "agent"), purpose: "查看" }),
    h.context
  );
  assert.equal(cwdResult.ok, false);
  assert.ok(cwdResult.message.includes("系统文件，只读"), "journal 目录内 shell 必须给出只读指引");
  const cpResult = await h.tools.execute(
    toolCall("shell", { command: "echo hi", cwd: path.join(h.projectRoot, "checkpoints"), purpose: "查看" }),
    h.context
  );
  assert.equal(cpResult.ok, false);
  const ok = await h.tools.execute(toolCall("shell", { command: "git status", purpose: "查看" }), h.context);
  assert.equal(ok.ok, true, "项目根目录内运行 shell 正常");
});

// ---------------------------------------------------------------------------
// shell 适配：参数映射、风险系统计算、增量输出脱敏与 1 MiB 截断
// ---------------------------------------------------------------------------

test("shell 适配解析 cwd/超时钳制/风险与 scope；项目外写命令需确认", async (t) => {
  const h = await setup(t);
  const pending = h.tools.execute(
    toolCall("shell", { command: "Set-Content out.txt x", cwd: path.join(h.dir, "outside"), timeout_ms: 30000, purpose: "写外部文件" }),
    h.context
  );
  const decision = await nextDecision(h.journal);
  assert.equal(decision.payload.kind, "normal");
  assert.equal(decision.payload.description, "写外部文件");
  await h.tools.resolveDecision({ decisionId: decision.payload.decision_id, choice: "allow" });
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(h.shellCalls[0].cwd, path.resolve(path.join(h.dir, "outside")));
  // 超时钳制：缺省 120000，超界钳到 [1000, 1800000]
  await h.tools.execute(toolCall("shell", { command: "git status", purpose: "查看" }), h.context);
  assert.equal(h.shellCalls[1].timeoutMs, 120000);
  await h.tools.execute(toolCall("shell", { command: "git status", timeout_ms: 9999999, purpose: "查看" }), h.context);
  assert.equal(h.shellCalls[2].timeoutMs, 1800000);
  // 项目内普通读命令自动执行，且极危命令由系统判 extreme（模型参数不参与）
  const read = await h.tools.execute(toolCall("shell", { command: "git status", purpose: "查看" }), h.context);
  assert.equal(read.ok, true);
  const events = await readEvents(h.journal);
  const started = eventsOfType(events, "tool_call_started").filter((event) => event.payload.name === "shell").at(-1);
  assert.ok(started.payload.action, "started 事件必须记录归一化 action");
  assert.equal(started.payload.action.risk, "normal");
  assert.equal(started.payload.action.category, "read");
  assert.equal(started.payload.action.scope, "project");
  assert.equal(started.payload.action.grant_key, "read:project:project-root");
  assertClosure(events);
});

test("tool_output_delta 脱敏：命令、参数、流式输出与最终输出均不含 secret", async (t) => {
  const SECRET = "super-secret-token-77";
  const h = await setup(t, {
    secrets: [SECRET],
    shellRuntime: async ({ command, signal, onOutput }) => {
      if (signal?.aborted) throw Object.assign(new Error("命令已停止。"), { code: "shell_cancelled", durationMs: 0 });
      onOutput?.({ stream: "stdout", text: "hello " });
      onOutput?.({ stream: "stdout", text: "super-secret-to" }); // 跨 chunk 拆分
      onOutput?.({ stream: "stdout", text: "ken-77 world" });
      onOutput?.({ stream: "stderr", text: "err: api_key=abc123secret" });
      return { exitCode: 0, cwd: null, signal: null, durationMs: 2, stdout: `hello ${SECRET} world`, stderr: "err: api_key=abc123secret" };
    }
  });
  const result = await h.tools.execute(
    toolCall("shell", {
      command: `git status ${SECRET} api_key=abc123secret`,
      purpose: `读取 ${SECRET}`,
      timeout_ms: 5000
    }),
    h.context
  );
  assert.equal(result.ok, true);
  assert.equal(result.result.stdout, "hello [REDACTED] world");
  const events = await readEvents(h.journal);
  for (const event of events) {
    const serialized = JSON.stringify(event);
    assert.ok(!serialized.includes(SECRET), `任何事件都不得包含未脱敏 secret: ${event.type}`);
    assert.ok(!serialized.includes("abc123secret"), `任何事件都不得包含命令密钥: ${event.type}`);
  }
  const deltas = eventsOfType(events, "tool_output_delta").filter((event) => event.payload.name === "shell");
  const streamed = deltas.map((event) => event.payload.text ?? "").join("");
  assert.ok(streamed.includes("hello") && streamed.includes("[REDACTED]") && streamed.includes("world"));
  assert.ok(streamed.includes("err: api_key=[REDACTED]"), "stderr 增量同样脱敏");
  assert.ok(!streamed.includes(SECRET), "跨 chunk 拆分的 secret 拼接后仍被脱敏");
  const completed = eventsOfType(events, "tool_call_completed").find((event) => event.payload.name === "shell");
  assert.equal(completed.payload.exit_code, 0);
  assertClosure(events);
});

test("tool_output_delta 按单次工具累计 1 MiB 截断", async (t) => {
  const chunk = "x".repeat(256 * 1024);
  const h = await setup(t, {
    shellRuntime: async ({ signal, onOutput }) => {
      if (signal?.aborted) throw Object.assign(new Error("命令已停止。"), { code: "shell_cancelled", durationMs: 0 });
      for (let i = 0; i < 5; i += 1) onOutput?.({ stream: "stdout", text: chunk });
      return { exitCode: 0, cwd: null, signal: null, durationMs: 1, stdout: chunk.repeat(5), stderr: "" };
    }
  });
  const result = await h.tools.execute(toolCall("shell", { command: "git status", purpose: "大输出" }), h.context);
  assert.equal(result.ok, true);
  const events = await readEvents(h.journal);
  const total = eventsOfType(events, "tool_output_delta")
    .filter((event) => event.payload.name === "shell")
    .reduce((sum, event) => sum + (event.payload.text ?? "").length, 0);
  assert.ok(total <= 1024 * 1024, `增量事件累计不得超过 1 MiB，实际 ${total}`);
  assertClosure(events);
});

// ---------------------------------------------------------------------------
// R5-10：write_file/edit_file 的 content/replace 运行时类型校验
// ---------------------------------------------------------------------------

test("write_file/edit_file：非字符串 content/replace/find 返回 bad_args（R5-10）", async (t) => {
  const h = await setup(t, { permissions: { yolo: true } });

  // content 传对象：不得静默写成 "[object Object]"
  const objContent = await h.tools.execute(
    toolCall("write_file", { path: "obj.txt", content: { evil: true } }),
    h.context
  );
  assert.equal(objContent.ok, false);
  assert.equal(objContent.error.code, "bad_args");
  assert.equal(await pathExists(path.join(h.projectRoot, "obj.txt")), false, "非字符串 content 不得落盘");

  // 数组 content 同样拒绝
  const arrContent = await h.tools.execute(
    toolCall("write_file", { path: "arr.txt", content: ["a", "b"] }),
    h.context
  );
  assert.equal(arrContent.ok, false);
  assert.equal(arrContent.error.code, "bad_args");
  assert.equal(await pathExists(path.join(h.projectRoot, "arr.txt")), false);

  // edit_file：replace 传对象拒绝，且文件不得被改写
  await h.tools.execute(toolCall("write_file", { path: "edit.md", content: "原文" }), h.context);
  const badReplace = await h.tools.execute(
    toolCall("edit_file", { path: "edit.md", find: "原文", replace: { nested: 1 } }),
    h.context
  );
  assert.equal(badReplace.ok, false);
  assert.equal(badReplace.error.code, "bad_args");
  assert.equal(await fs.readFile(path.join(h.projectRoot, "edit.md"), "utf8"), "原文", "非字符串 replace 不得改写文件");

  // find 传非字符串同样拒绝
  const badFind = await h.tools.execute(
    toolCall("edit_file", { path: "edit.md", find: ["原文"], replace: "新" }),
    h.context
  );
  assert.equal(badFind.ok, false);
  assert.equal(badFind.error.code, "bad_args");
  assert.equal(await fs.readFile(path.join(h.projectRoot, "edit.md"), "utf8"), "原文");
  assertClosure(await readEvents(h.journal));
});

// ---------------------------------------------------------------------------
// R5-15：shell 输出截断对称——delta 与终态统一携带 content_length/truncated
// ---------------------------------------------------------------------------

test("shell 大输出：delta 与 final 统一携带 content_length 与 truncated（R5-15）", async (t) => {
  const chunk = "y".repeat(256 * 1024);
  const h = await setup(t, {
    shellRuntime: async ({ signal, onOutput }) => {
      if (signal?.aborted) throw Object.assign(new Error("命令已停止。"), { code: "shell_cancelled", durationMs: 0 });
      for (let i = 0; i < 5; i += 1) onOutput?.({ stream: "stdout", text: chunk });
      return { exitCode: 0, cwd: null, signal: null, durationMs: 1, stdout: chunk.repeat(5), stderr: "" };
    }
  });
  const result = await h.tools.execute(toolCall("shell", { command: "git status", purpose: "大输出" }), h.context);
  assert.equal(result.ok, true);
  // final（终态工具结果）携带与 delta 相同的截断字段
  assert.equal(typeof result.result.content_length, "number", "final 必须携带 content_length");
  assert.equal(typeof result.result.truncated, "boolean", "final 必须携带 truncated");
  assert.equal(result.result.truncated, true, "超过 1 MiB 的输出必须标记 truncated");
  assert.equal(result.result.content_length, chunk.length * 5, "content_length 为最终捕获长度");

  const events = await readEvents(h.journal);
  const deltas = eventsOfType(events, "tool_output_delta").filter((event) => event.payload.name === "shell");
  assert.ok(deltas.length > 0, "必须产生增量事件");
  for (const delta of deltas) {
    assert.equal(delta.payload.content_length, delta.payload.text.length, "每个 delta 的 content_length 与 text 长度一致");
    assert.equal(typeof delta.payload.truncated, "boolean", "每个 delta 必须携带 truncated");
  }
  const total = deltas.reduce((sum, delta) => sum + (delta.payload.text ?? "").length, 0);
  assert.ok(total <= 1024 * 1024, `增量累计不得超过 1 MiB（实际 ${total}）`);
  assert.ok(deltas.some((delta) => delta.payload.truncated === true), "预算耗尽处必须有 delta 标记 truncated");

  // 审计终态事件同样携带
  const completed = eventsOfType(events, "tool_call_completed").find((event) => event.payload.name === "shell");
  assert.ok(completed, "必须产生 tool_call_completed");
  assert.equal(typeof completed.payload.content_length, "number", "tool_call_completed 必须携带 content_length");
  assert.equal(typeof completed.payload.truncated, "boolean", "tool_call_completed 必须携带 truncated");
  assert.equal(completed.payload.truncated, true);
  assertClosure(events);
});

test("shell 小输出：delta 与 final 的截断字段为未截断口径（R5-15）", async (t) => {
  const h = await setup(t); // 默认桩输出 "out:<command>"
  const result = await h.tools.execute(toolCall("shell", { command: "git status", purpose: "小输出" }), h.context);
  assert.equal(result.ok, true);
  assert.equal(typeof result.result.content_length, "number", "final 必须携带 content_length");
  assert.equal(result.result.truncated, false, "小输出不得标记截断");

  const events = await readEvents(h.journal);
  const deltas = eventsOfType(events, "tool_output_delta").filter((event) => event.payload.name === "shell");
  assert.ok(deltas.length > 0, "必须产生增量事件");
  for (const delta of deltas) {
    assert.equal(delta.payload.content_length, delta.payload.text.length, "每个 delta 的 content_length 与 text 长度一致");
    assert.equal(delta.payload.truncated, false, "小输出的 delta 不得标记截断");
  }
  const completed = eventsOfType(events, "tool_call_completed").find((event) => event.payload.name === "shell");
  assert.equal(completed.payload.truncated, false, "小输出的终态不得标记截断");
  assertClosure(events);
});

test("停止（abort）中止 shell、作废待决决策且不泄漏未脱敏输出", async (t) => {
  const controller = new AbortController();
  const h = await setup(t, {
    secrets: ["hunter2"],
    signal: controller.signal,
    shellRuntime: async ({ signal, onOutput }) => {
      // git status 是只读命令（自动执行）；输出里带密钥，随后等待停止
      onOutput?.({ stream: "stdout", text: "secret= hunter2" });
      await new Promise((resolve) => {
        signal?.addEventListener("abort", () => resolve());
      });
      const error = Object.assign(new Error("命令已停止。"), {
        code: "shell_cancelled",
        durationMs: 42,
        stdout: "secret= hunter2",
        stderr: ""
      });
      throw error;
    }
  });
  const pending = h.tools.execute(toolCall("shell", { command: "git status", purpose: "长驻" }), h.context);
  await sleep(30);
  controller.abort("用户停止");
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "shell_cancelled");
  const events = await readEvents(h.journal);
  const failed = eventsOfType(events, "tool_call_failed").find((event) => event.payload.name === "shell");
  assert.ok(failed, "停止后应有 tool_call_failed");
  assert.equal(failed.payload.error, "shell_cancelled");
  for (const event of events) {
    assert.ok(!JSON.stringify(event).includes("hunter2"), "停止路径不得泄漏未脱敏输出");
  }
  assertClosure(events);
});

test("决策等待期间停止：decision 以 cancelled 作废并闭环", async (t) => {
  const controller = new AbortController();
  const h = await setup(t, { signal: controller.signal });
  const pending = h.tools.execute(toolCall("write_file", { path: "a.txt", content: "A" }), h.context);
  const decision = await nextDecision(h.journal);
  controller.abort("用户停止");
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "tool_cancelled");
  const events = await readEvents(h.journal);
  const resolved = eventsOfType(events, "decision_resolved");
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].payload.choice, "cancelled");
  assert.equal(await pathExists(path.join(h.projectRoot, "a.txt")), false);
  assertClosure(events);
});

test("调用前已 abort：工具直接 tool_cancelled", async (t) => {
  const controller = new AbortController();
  controller.abort();
  const h = await setup(t, { signal: controller.signal });
  const result = await h.tools.execute(toolCall("read_file", { path: "notes.md" }), h.context);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "tool_cancelled");
  assertClosure(await readEvents(h.journal));
});

// ---------------------------------------------------------------------------
// 工具执行期限（Task 2：统一空闲期限与绝对期限）
// ---------------------------------------------------------------------------

// 假时钟 seam：只有测试主动推进时间，setTimer 回调才会触发（不依赖真实等待）。
// 同时充当 clock/setTimer/clearTimer 三个注入点的最小实现。
function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const scheduled = [];
  return {
    clock: () => now,
    setTimer(fn, ms) {
      const timer = { id: nextId, at: now + Math.max(0, ms), fn };
      nextId += 1;
      scheduled.push(timer);
      scheduled.sort((a, b) => a.at - b.at);
      return timer.id;
    },
    clearTimer(id) {
      const index = scheduled.findIndex((timer) => timer.id === id);
      if (index >= 0) scheduled.splice(index, 1);
    },
    advance(ms) {
      now += Math.max(0, ms);
      const due = scheduled.filter((timer) => timer.at <= now).sort((a, b) => a.at - b.at);
      for (const timer of due) {
        const index = scheduled.indexOf(timer);
        if (index >= 0) scheduled.splice(index, 1);
        timer.fn();
      }
    }
  };
}

// 注册一个只等待 abort 的挂起 probe 工具（read 类别自动放行；run 不自行结束，
// 期限/停止信号触发后才 settle）。deadline 为工具定义可选的较短期限声明。
function registerPendingProbe(tools, { deadline, run } = {}) {
  tools._registerTool("probe", {
    ...(deadline ? { deadline } : {}),
    description: "probe",
    schema: { type: "object", properties: {}, additionalProperties: false },
    describeAction: () => ({
      category: "read",
      scope: "project",
      targetClass: "project-root",
      grantKey: "read:project:project-root",
      title: "probe",
      description: "probe",
      targets: []
    }),
    async run(args, context) {
      if (typeof run === "function") return run(args, context);
      await new Promise((resolve) => context.signal?.addEventListener("abort", () => resolve()));
      return { done: true };
    }
  });
}

test("静默工具超过空闲期限：结构化 tool_timeout(idle)，不向 Runtime 抛异常", { timeout: 15000 }, async (t) => {
  const h = await setup(t, {
    runtime: { toolIdleTimeoutMs: 60, toolAbsoluteTimeoutMs: 2000 },
    shellRuntime: async ({ signal }) => {
      await new Promise((resolve) => signal?.addEventListener("abort", () => resolve()));
      throw Object.assign(new Error("命令已停止。"), { code: "shell_cancelled", durationMs: 0 });
    }
  });
  // 直接 await：若超时以 rejection 逃逸（而不是结构化结果），本测试立即失败
  const startedAt = Date.now();
  const result = await h.tools.execute(toolCall("shell", { command: "git status", purpose: "长驻" }), h.context);
  const elapsed = Date.now() - startedAt;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "tool_timeout");
  assert.equal(result.error.kind, "idle");
  assert.equal(result.message, "工具执行超时。");
  assert.ok(elapsed < 1000, `60ms 空闲期限应远早于 2000ms 绝对期限触发（实际 ${elapsed}ms）`);
  const events = await readEvents(h.journal);
  const failed = eventsOfType(events, "tool_call_failed").find((event) => event.payload.name === "shell");
  assert.ok(failed, "超时必须有 tool_call_failed（活动闭环）");
  assert.equal(failed.payload.error, "tool_timeout");
  assert.deepEqual(failed.payload.technical, { kind: "idle" });
  assertClosure(events);
});

test("持续报告 activity 的工具在绝对期限被回收（absolute 不被 activity 重置）", { timeout: 15000 }, async (t) => {
  const h = await setup(t, {
    runtime: { toolIdleTimeoutMs: 150, toolAbsoluteTimeoutMs: 400 },
    shellRuntime: async ({ signal, onOutput }) => {
      let tick = 0;
      const interval = setInterval(() => {
        onOutput?.({ stream: tick % 2 === 0 ? "stdout" : "stderr", text: "." });
        tick += 1;
      }, 20);
      await new Promise((resolve) => signal?.addEventListener("abort", () => resolve()));
      clearInterval(interval);
      throw Object.assign(new Error("命令已停止。"), { code: "shell_cancelled", durationMs: 0 });
    }
  });
  const startedAt = Date.now();
  const result = await h.tools.execute(toolCall("shell", { command: "git status", purpose: "持续输出" }), h.context);
  const elapsed = Date.now() - startedAt;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "tool_timeout");
  assert.equal(result.error.kind, "absolute", "持续 stdout/stderr 刷新空闲期限，必须由绝对期限回收");
  assert.ok(elapsed >= 350, `持续输出应活过 150ms 空闲期限直到 ~400ms 绝对期限（实际 ${elapsed}ms）`);
  assertClosure(await readEvents(h.journal));
});

test("工具定义声明的较短自定义期限被遵守", { timeout: 15000 }, async (t) => {
  const h = await setup(t, { runtime: { toolIdleTimeoutMs: 5000, toolAbsoluteTimeoutMs: 10000 } });
  registerPendingProbe(h.tools, { deadline: { idleMs: 40, absoluteMs: 500 } });
  const startedAt = Date.now();
  const result = await h.tools.execute(toolCall("probe", {}), h.context);
  const elapsed = Date.now() - startedAt;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "tool_timeout");
  assert.equal(result.error.kind, "idle", "声明的 40ms 空闲期限应早于系统 5000ms 触发");
  assert.ok(elapsed < 1000, `自定义 40ms 期限应远早于系统 5000ms（实际 ${elapsed}ms）`);
  assertClosure(await readEvents(h.journal));
});

test("自定义绝对期限不能抬高系统上限（钳制到系统绝对期限）", { timeout: 15000 }, async (t) => {
  const h = await setup(t, { runtime: { toolIdleTimeoutMs: 1000, toolAbsoluteTimeoutMs: 2000 } });
  registerPendingProbe(h.tools, {
    deadline: { absoluteMs: 99999 }, // 高于系统 2000ms 上限
    run: async (_args, context) => {
      const interval = setInterval(() => context.reportActivity(), 10); // 持续 activity
      await new Promise((resolve) => context.signal?.addEventListener("abort", () => resolve()));
      clearInterval(interval);
      return { done: true };
    }
  });
  const startedAt = Date.now();
  const result = await h.tools.execute(toolCall("probe", {}), h.context);
  const elapsed = Date.now() - startedAt;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "tool_timeout");
  assert.equal(result.error.kind, "absolute", "声明 99999ms 绝对期限必须被钳制到系统 2000ms");
  assert.ok(elapsed >= 1500, `系统绝对期限 2000ms 附近回收（实际 ${elapsed}ms）`);
  assertClosure(await readEvents(h.journal));
});

test("自定义空闲期限不能抬高系统上限（钳制到系统空闲期限）", { timeout: 15000 }, async (t) => {
  const h = await setup(t, { runtime: { toolIdleTimeoutMs: 500, toolAbsoluteTimeoutMs: 5000 } });
  registerPendingProbe(h.tools, { deadline: { idleMs: 99999 } }); // 高于系统 500ms
  const startedAt = Date.now();
  const result = await h.tools.execute(toolCall("probe", {}), h.context);
  const elapsed = Date.now() - startedAt;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "tool_timeout");
  assert.equal(result.error.kind, "idle", "声明 99999ms 空闲期限必须被钳制到系统 500ms");
  assert.ok(elapsed >= 400 && elapsed < 4000, `系统空闲期限 500ms 附近回收（实际 ${elapsed}ms）`);
  assertClosure(await readEvents(h.journal));
});

test("clock/setTimer/clearTimer seam：假时钟精确驱动空闲期限", { timeout: 15000 }, async (t) => {
  const fake = createFakeTimers();
  const h = await setup(t, {
    runtime: {
      toolIdleTimeoutMs: 100,
      toolAbsoluteTimeoutMs: 1000,
      clock: fake.clock,
      setTimer: fake.setTimer,
      clearTimer: fake.clearTimer
    },
    shellRuntime: async ({ signal }) => {
      await new Promise((resolve) => signal?.addEventListener("abort", () => resolve()));
      throw Object.assign(new Error("命令已停止。"), { code: "shell_cancelled", durationMs: 0 });
    }
  });
  const pending = h.tools.execute(toolCall("shell", { command: "git status", purpose: "假时钟" }), h.context);
  await sleep(30); // 等待 run 挂起（期限定时器已注册到假时钟）
  fake.advance(100); // 推进 100ms → 空闲期限回调触发
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "tool_timeout");
  assert.equal(result.error.kind, "idle");
  assert.ok(result.duration_ms >= 100, "duration_ms 应来自假时钟");
  assertClosure(await readEvents(h.journal));
});

// ---------------------------------------------------------------------------
// Task 3：工具错误转结构化结果 {ok:false,error:{code,message,retryable?}}，
// 不向 Runtime 抛异常（异常杀死 Run 的回归面）
// ---------------------------------------------------------------------------

test("executor throw → 结构化 {ok:false,error:{code,message}}，不向 Runtime 抛异常", async (t) => {
  const h = await setup(t);
  const unregister = h.tools._registerTool("explode", {
    description: "explode",
    schema: { type: "object", properties: {}, additionalProperties: false },
    describeAction: () => ({
      category: "read",
      scope: "project",
      targetClass: "project-root",
      grantKey: "read:project:project-root",
      title: "explode",
      description: "explode",
      targets: []
    }),
    async run() {
      const error = new Error("领域错误：磁盘已满。");
      error.code = "disk_full";
      throw error;
    }
  });
  // 直接 await：若 executor 异常以 rejection 逃逸（杀死 Run），本测试立即失败
  const result = await h.tools.execute(toolCall("explode", {}), h.context);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "disk_full");
  assert.equal(result.error.message, "领域错误：磁盘已满。");
  assert.equal(result.message, "领域错误：磁盘已满。");
  assert.ok(result.tool_call_id, "结果应回传原 tool_call_id");
  const events = await readEvents(h.journal);
  const failed = eventsOfType(events, "tool_call_failed")[0];
  assert.equal(failed.payload.error, "disk_full", "journal 事件 payload.error 保持字符串 code");
  assert.equal(failed.payload.message, "领域错误：磁盘已满。");
  assertClosure(events);
  unregister();
});

test("executor 裸异常（无 code）→ error.code 回落 tool_failed", async (t) => {
  const h = await setup(t);
  const unregister = h.tools._registerTool("blow", {
    description: "blow",
    schema: { type: "object", properties: {}, additionalProperties: false },
    describeAction: () => ({
      category: "read",
      scope: "project",
      targetClass: "project-root",
      grantKey: "read:project:project-root",
      title: "blow",
      description: "blow",
      targets: []
    }),
    async run() {
      throw new Error("裸异常文本。");
    }
  });
  const result = await h.tools.execute(toolCall("blow", {}), h.context);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "tool_failed");
  assert.equal(result.error.message, "裸异常文本。");
  assertClosure(await readEvents(h.journal));
  unregister();
});

test("tool_timeout 结构化结果携带 error.code/kind/message/retryable（回给模型的完整形状）", { timeout: 15000 }, async (t) => {
  const h = await setup(t, {
    runtime: { toolIdleTimeoutMs: 60, toolAbsoluteTimeoutMs: 2000 },
    shellRuntime: async ({ signal }) => {
      await new Promise((resolve) => signal?.addEventListener("abort", () => resolve()));
      throw Object.assign(new Error("命令已停止。"), { code: "shell_cancelled", durationMs: 0 });
    }
  });
  const result = await h.tools.execute(toolCall("shell", { command: "git status", purpose: "长驻" }), h.context);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "tool_timeout");
  assert.equal(result.error.kind, "idle");
  assert.equal(result.error.message, "工具执行超时。");
  assert.equal(result.error.retryable, true, "超时是瞬态条件，应标记可重试");
  assert.equal(result.message, "工具执行超时。");
  assertClosure(await readEvents(h.journal));
});

test("工具 context 注入组合 signal（父停止传导）与 reportActivity", { timeout: 15000 }, async (t) => {
  const controller = new AbortController();
  const h = await setup(t, {
    signal: controller.signal,
    runtime: { toolIdleTimeoutMs: 10000, toolAbsoluteTimeoutMs: 20000 }
  });
  let observed = null;
  h.tools._registerTool("probe", {
    description: "probe",
    schema: { type: "object", properties: {}, additionalProperties: false },
    describeAction: () => ({
      category: "read",
      scope: "project",
      targetClass: "project-root",
      grantKey: "read:project:project-root",
      title: "probe",
      description: "probe",
      targets: []
    }),
    async run(_args, context) {
      observed = {
        signal: context.signal,
        reportActivity: typeof context.reportActivity,
        parentAbortSeen: null
      };
      await new Promise((resolve) => {
        context.signal?.addEventListener("abort", () => {
          observed.parentAbortSeen = true;
          resolve();
        });
      });
      return { done: true, signalAborted: context.signal.aborted };
    }
  });
  const pending = h.tools.execute(toolCall("probe", {}), h.context);
  const pollDeadline = Date.now() + 5000;
  while (!observed && Date.now() < pollDeadline) await sleep(5);
  assert.ok(observed, "工具 run 应已启动并注入 context");
  assert.ok(observed.signal instanceof AbortSignal, "工具 context.signal 必须是 AbortSignal");
  assert.equal(observed.reportActivity, "function", "工具 context 必须有 reportActivity()");
  assert.equal(observed.parentAbortSeen, null, "父停止前工具 signal 不得中断");
  controller.abort("用户停止");
  const result = await pending;
  assert.equal(observed.parentAbortSeen, true, "父 signal 停止必须传导到工具组合 signal");
  assert.equal(result.ok, true, "父停止只传导信号，工具自身的收尾结果原样透传");
  assert.equal(result.result.signalAborted, true);
  assertClosure(await readEvents(h.journal));
});

test("write_file 在极短期限内仍原子完成（不产生半写文件）", { timeout: 20000 }, async (t) => {
  const h = await setup(t, {
    permissions: { auto_edit: true },
    runtime: { toolIdleTimeoutMs: 5, toolAbsoluteTimeoutMs: 10000 }
  });
  const content = "A".repeat(4 * 1024 * 1024);
  const target = path.join(h.projectRoot, "big.md");
  const result = await h.tools.execute(toolCall("write_file", { path: "big.md", content }), h.context);
  // 无论超时是否与写入竞争：目标文件要么不存在、要么完整（最终 rename 区间不被截断）
  if (await pathExists(target)) {
    assert.equal(await fs.readFile(target, "utf8"), content, "文件必须完整写入，不允许半写/截断");
  }
  assert.ok(
    result.ok === true || (result.ok === false && result.error.code === "tool_timeout"),
    `写工具结果必须是完成或结构化 tool_timeout，实际 ${JSON.stringify(result)}`
  );
  assertClosure(await readEvents(h.journal));
});

test("未知工具返回 工具不可用。 且活动闭环", async (t) => {
  const h = await setup(t);
  const result = await h.tools.execute(toolCall("no_such_tool", {}), h.context);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "unknown_tool");
  assert.equal(result.message, "工具不可用。");
  const events = await readEvents(h.journal);
  const failed = eventsOfType(events, "tool_call_failed")[0];
  assert.equal(failed.payload.error, "unknown_tool");
  assert.equal(failed.payload.message, "工具不可用。");
  assertClosure(events);
});

// ---------------------------------------------------------------------------
// hook 执行（隐藏在本接口内部）
// ---------------------------------------------------------------------------

test("BeforeToolUse 否决短路执行；AfterToolUse 记录成功与失败", async (t) => {
  const h = await setup(t);
  const order = [];
  const unregister = h.tools.registerHook("BeforeToolUse", async () => {
    order.push("before-1");
    return { allow: false, reason: "nope" };
  });
  h.tools.registerHook("AfterToolUse", async () => {
    order.push("after");
  });
  // 权限确认在前、hook 否决在后：先允许，再让 BeforeToolUse 否决执行
  const vetoPending = h.tools.execute(toolCall("write_file", { path: "a.txt", content: "A" }), h.context);
  const decision1 = await nextDecision(h.journal);
  await h.tools.resolveDecision({ decisionId: decision1.payload.decision_id, choice: "allow" });
  const vetoed = await vetoPending;
  assert.equal(vetoed.ok, false);
  assert.equal(vetoed.message, "nope");
  assert.deepEqual(order, ["before-1"], "否决后不得继续执行");
  assertClosure(await readEvents(h.journal));

  // 移除否决 hook 后正常执行且 AfterToolUse 收到 ok
  unregister();
  const okPending = h.tools.execute(toolCall("write_file", { path: "b.txt", content: "B" }), h.context);
  const decision2 = await nextDecision(h.journal, 2);
  await h.tools.resolveDecision({ decisionId: decision2.payload.decision_id, choice: "allow" });
  const ok = await okPending;
  assert.equal(ok.ok, true);
  assert.ok(order.includes("after"), "AfterToolUse 应在成功后执行");
  assertClosure(await readEvents(h.journal));
});

test("单个 AfterToolUse 抛错不影响主流程", async (t) => {
  const h = await setup(t);
  h.tools.registerHook("AfterToolUse", async () => {
    throw new Error("boom");
  });
  const result = await h.tools.execute(toolCall("read_file", { path: "x.md" }), h.context);
  // read_file 目标不存在 → tool_failed，但 hook 抛错不得阻断结果返回
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "file_not_found");
});

// ---------------------------------------------------------------------------
// 深工具：schema/权限/审计/执行体接线
// ---------------------------------------------------------------------------

test("update_plan 校验计划状态并写 plan_updated", async (t) => {
  const h = await setup(t);
  const items = [
    { id: "check", step: "检查已有章节", status: "in_progress", description: "对照章节清单" },
    { id: "fix", step: "修正冲突", status: "pending" }
  ];
  const result = await h.tools.execute(toolCall("update_plan", { explanation: "先核对", items }), h.context);
  assert.equal(result.ok, true);
  assert.deepEqual(result.result.items, items);
  const events = await readEvents(h.journal);
  const updated = eventsOfType(events, "plan_updated")[0];
  assert.equal(updated.payload.explanation, "先核对");
  assert.deepEqual(updated.payload.items, items);
  // 两个 in_progress / 非法状态 / 空 items 拒绝
  const bad = await h.tools.execute(
    toolCall("update_plan", {
      items: [
        { id: "a", step: "a", status: "in_progress" },
        { id: "b", step: "b", status: "in_progress" }
      ]
    }),
    h.context
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, "bad_args");
  const badStatus = await h.tools.execute(toolCall("update_plan", { items: [{ id: "a", step: "a", status: "done" }] }), h.context);
  assert.equal(badStatus.ok, false);
  const empty = await h.tools.execute(toolCall("update_plan", { items: [] }), h.context);
  assert.equal(empty.ok, false);
  // 缺 id / 重复 id 拒绝
  const noId = await h.tools.execute(toolCall("update_plan", { items: [{ step: "a", status: "pending" }] }), h.context);
  assert.equal(noId.ok, false, "新事件缺 id 应被工具 schema 拒绝");
  assert.equal(noId.error.code, "bad_args");
  const dupId = await h.tools.execute(
    toolCall("update_plan", {
      items: [
        { id: "a", step: "a", status: "pending" },
        { id: "a", step: "b", status: "pending" }
      ]
    }),
    h.context
  );
  assert.equal(dupId.ok, false, "重复 id 应被拒绝");
  assert.equal(dupId.error.code, "bad_args");
  assertClosure(await readEvents(h.journal));
});

test("enter_workflow 已删除：未知工具，不产生 workflow_changed", async (t) => {
  const h = await setup(t);
  const names = h.tools.definitions().map((def) => def.function.name);
  assert.ok(!names.includes("enter_workflow"), "enter_workflow 不得注册");
  const result = await h.tools.execute(toolCall("enter_workflow", { workflow: "chapter", reason: "用户要求正式写作" }), h.context);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "unknown_tool");
  const events = await readEvents(h.journal);
  assert.equal(eventsOfType(events, "workflow_changed").length, 0, "不再产生 workflow_changed 事件");
  assertClosure(events);
});

test("commit_blueprint 已删除：不在注册表，调用返回未知工具", async (t) => {
  const h = await setup(t);
  const names = h.tools.definitions().map((def) => def.function.name);
  assert.ok(!names.includes("commit_blueprint"), "commit_blueprint 不得注册");
  const result = await h.tools.execute(
    toolCall("commit_blueprint", { project_id: "p1", outline: "# OUTLINE", setting: "# SETTING", evidence_paths: [] }),
    h.context
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "unknown_tool", "已删除工具按未知工具处理");
  const events = await readEvents(h.journal);
  const failed = eventsOfType(events, "tool_call_failed").filter((event) => event.payload.name === "commit_blueprint");
  assert.equal(failed.length, 1, "调用必须记录为失败");
  assert.equal(failed[0].payload.error, "unknown_tool");
  assert.equal(h.opsCalls.length, 0, "不得调用任何 project operations");
  assertClosure(events);
});

test("append_chapter_segment / commit_chapter 调用注入的 projectOperations", async (t) => {
  const h = await setup(t);
  const segment = await h.tools.execute(
    toolCall("append_chapter_segment", { project_id: "p1", chapter_no: 1, segment_no: 1, content: "正文第一段" }),
    h.context
  );
  assert.equal(segment.ok, true);
  assert.deepEqual(h.opsCalls[0][0], "appendChapterSegment");
  const segmentArgs = h.opsCalls[0][1];
  assert.equal(segmentArgs.projectRoot, h.projectRoot);
  assert.equal(segmentArgs.projectId, "p1");
  assert.equal(segmentArgs.chapterNo, 1);
  assert.equal(segmentArgs.segmentNo, 1);
  assert.equal(segmentArgs.content, "正文第一段");
  assert.ok(segmentArgs.signal instanceof AbortSignal, "project operations 必须收到组合 AbortSignal（Task 2 工具期限 signal）");

  const commit = await h.tools.execute(
    toolCall("commit_chapter", { project_id: "p1", chapter_no: 1, expected_draft_checksum: "sha256:x" }),
    h.context
  );
  assert.equal(commit.ok, true);
  assert.deepEqual(h.opsCalls[1][0], "commitChapter");
  assert.equal(h.opsCalls[1][1].expectedDraftChecksum, "sha256:x");
  assert.equal("exceptionDecisions" in h.opsCalls[1][1], false, "Task 10：commit_chapter 不再传递 exceptionDecisions");
  const events = await readEvents(h.journal);
  assert.ok(eventsOfType(events, "checkpoint_linked").some((event) => event.payload.chapter_no === 1), "提交必须链接 checkpoint");
  assertClosure(await readEvents(h.journal));
});

test("finalize_revision 调用注入的 projectOperations，参数透传", async (t) => {
  const h = await setup(t);
  const result = await h.tools.execute(
    toolCall("finalize_revision", { project_id: "p1", chapter_no: 3, expected_checksum: "sha256:x" }),
    h.context
  );
  assert.equal(result.ok, true);
  assert.deepEqual(h.opsCalls[0][0], "finalizeChapter");
  assert.equal(h.opsCalls[0][1].chapterNo, 3);
  assert.equal(h.opsCalls[0][1].expectedChecksum, "sha256:x");
  const events = await readEvents(h.journal);
  assert.ok(eventsOfType(events, "checkpoint_linked").some((event) => event.payload.chapter_no === 3), "确认修订必须链接 checkpoint");
  assertClosure(await readEvents(h.journal));
});

test("rollback_chapter 调用注入的 projectOperations，version 缺省透传 null", async (t) => {
  const h = await setup(t);
  const explicit = await h.tools.execute(
    toolCall("rollback_chapter", { project_id: "p1", chapter_no: 2, version: 1 }),
    h.context
  );
  assert.equal(explicit.ok, true);
  assert.deepEqual(h.opsCalls[0][0], "rollbackChapter");
  assert.equal(h.opsCalls[0][1].chapterNo, 2);
  assert.equal(h.opsCalls[0][1].version, 1);
  const omitted = await h.tools.execute(
    toolCall("rollback_chapter", { project_id: "p1", chapter_no: 2 }),
    h.context
  );
  assert.equal(omitted.ok, true);
  assert.equal(h.opsCalls[1][1].version, null, "缺省 version 以 null 透传，语义由领域层决定");
  const events = await readEvents(h.journal);
  assert.ok(eventsOfType(events, "checkpoint_linked").some((event) => event.payload.chapter_no === 2), "回滚必须链接 checkpoint");
  assertClosure(await readEvents(h.journal));
});

test("深工具参数校验：bad_args 不调用 project operations", async (t) => {
  const h = await setup(t);
  const bad = await h.tools.execute(
    toolCall("append_chapter_segment", { project_id: "p1", chapter_no: 0, segment_no: 1, content: "x" }),
    h.context
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, "bad_args");
  const bad2 = await h.tools.execute(
    toolCall("commit_chapter", { project_id: "p1", chapter_no: 1.5 }),
    h.context
  );
  assert.equal(bad2.ok, false);
  assert.equal(h.opsCalls.length, 0, "参数无效时不得调用 project operations");
});

test("projectOperations 未接线（Task 5 之前）时深工具返回 工具不可用。", async (t) => {
  const h = await setup(t, { projectOperations: {} });
  const segment = await h.tools.execute(
    toolCall("append_chapter_segment", { project_id: "p1", chapter_no: 1, segment_no: 1, content: "x" }),
    h.context
  );
  assert.equal(segment.ok, false);
  assert.equal(segment.error.code, "not_wired");
  assert.equal(segment.message, "工具不可用。");
  const commit = await h.tools.execute(toolCall("commit_chapter", { project_id: "p1", chapter_no: 1 }), h.context);
  assert.equal(commit.ok, false);
  assert.equal(commit.message, "工具不可用。");
  assertClosure(await readEvents(h.journal));
});

// ---------------------------------------------------------------------------
// 通用文件工具行为与 scope
// ---------------------------------------------------------------------------

test("list_files / search_files / edit_file 基本行为", async (t) => {
  // auto_edit 让项目内写自动放行，测试聚焦工具行为而非确认流程
  const h = await setup(t, { permissions: { auto_edit: true } });
  await fs.writeFile(path.join(h.projectRoot, "alpha.md"), "第一章 雨夜\n雨下了一整夜。\n", "utf8");
  await fs.mkdir(path.join(h.projectRoot, "sub"), { recursive: true });
  await fs.writeFile(path.join(h.projectRoot, "sub", "beta.txt"), "beta 内容", "utf8");

  const list = await h.tools.execute(toolCall("list_files", {}), h.context);
  assert.equal(list.ok, true);
  const names = list.result.entries.map((entry) => entry.name);
  assert.ok(names.includes("alpha.md") && names.includes("sub"));

  const search = await h.tools.execute(toolCall("search_files", { query: "雨夜" }), h.context);
  assert.equal(search.ok, true);
  const contentHit = search.result.matches.find((match) => match.kind === "content");
  assert.ok(contentHit, "内容搜索应命中");
  assert.ok(contentHit.path.endsWith("alpha.md"));

  const edit = await h.tools.execute(
    toolCall("edit_file", { path: "alpha.md", find: "第一章 雨夜", replace: "第一章 雨夜（修订）" }),
    h.context
  );
  assert.equal(edit.ok, true);
  const content = await fs.readFile(path.join(h.projectRoot, "alpha.md"), "utf8");
  assert.ok(content.includes("第一章 雨夜（修订）"));

  // 多处匹配必须带 occurrence
  await fs.writeFile(path.join(h.projectRoot, "multi.txt"), "abc abc", "utf8");
  const notUnique = await h.tools.execute(toolCall("edit_file", { path: "multi.txt", find: "abc", replace: "xyz" }), h.context);
  assert.equal(notUnique.ok, false);
  assert.equal(notUnique.error.code, "find_not_unique");
  const occurrence = await h.tools.execute(
    toolCall("edit_file", { path: "multi.txt", find: "abc", replace: "xyz", occurrence: 2 }),
    h.context
  );
  assert.equal(occurrence.ok, true);
  assert.equal(await fs.readFile(path.join(h.projectRoot, "multi.txt"), "utf8"), "abc xyz");
  // occurrence 小数/负数拒绝（schema 声明 integer，运行时复核）
  const badOccurrence = await h.tools.execute(
    toolCall("edit_file", { path: "multi.txt", find: "abc", replace: "xyz", occurrence: 1.5 }),
    h.context
  );
  assert.equal(badOccurrence.ok, false);
  assert.equal(badOccurrence.error.code, "bad_args");
  assertClosure(await readEvents(h.journal));
});

test("项目外文件读取需要确认（scope outside）", async (t) => {
  const h = await setup(t);
  const outside = path.join(h.dir, "secret.txt");
  await fs.writeFile(outside, "外部内容", "utf8");
  const pending = h.tools.execute(toolCall("read_file", { path: outside }), h.context);
  const decision = await nextDecision(h.journal);
  assert.equal(decision.payload.kind, "normal");
  await h.tools.resolveDecision({ decisionId: decision.payload.decision_id, choice: "allow" });
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.result.content, "外部内容");
  assertClosure(await readEvents(h.journal));
});

test("注入的 permissionPolicy 可替换内置策略", async (t) => {
  const h = await setup(t, {
    runtime: {
      permissionPolicy: async (action, context) => {
        if (action.category === "write" && context.project?.project_id === "p1") return { decision: "allow" };
        return { decision: "confirm" };
      }
    }
  });
  const result = await h.tools.execute(toolCall("write_file", { path: "custom.txt", content: "c" }), h.context);
  assert.equal(result.ok, true, "注入策略放行项目内写入");
  assert.equal(eventsOfType(await readEvents(h.journal), "decision_requested").length, 0);
});
