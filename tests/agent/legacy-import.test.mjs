// tests/agent/legacy-import.test.mjs —— 一次性旧数据导入测试（Task 7 Step 4/5）。
//
// 本文件是依赖规则测试 H 的白名单之一：允许出现旧数据文件名（agent_state.json /
// chat_history.jsonl / chat_transcript.jsonl / chat_pending_action.json /
// task_queue.json / failures.jsonl），也允许直接测试 agent 内部 seam
//（createAgentJournal / runLegacyImport）。
//
// 覆盖：
//   - blueprint_status 三种迁移分支：显式值（complete/partial）优先；缺失时按章节
//     产物判 legacy / none；
//   - 可见历史导入 transcript（chat_history 优先、chat_transcript 兜底、内容去重）；
//   - 未解决错误事实（无 resolution 的 failures + 未清除 pending action）导入；
//   - 至多导入一个未完成 Run（running 状态 + 多任务队列 → 恰好一个 run_started）；
//   - 幂等：第二次导入不产生重复事件/消息，project.yaml 字节不变；
//   - 只读：导入前后旧文件字节不变（绝不双写/重命名/删除）；
//   - 完整链路：open() 触发导入后，提交一轮 Agent 运行也不写旧状态文件。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentJournal } from "../../src/core/agent/journal.mjs";
import { runLegacyImport } from "../../src/core/agent/legacy-import.mjs";
import {
  createLegacyProjectRoot,
  createProjectAgentHarness,
  eventsOfType,
  pathExists,
  readEvents,
  waitForIdle
} from "../helpers/project-agent-harness.mjs";

// 旧数据文件名（本文件是白名单，允许字面量）。
const STATE_FILE = "agent_state.json";
const CHAT_HISTORY_FILE = "chat_history.jsonl";
const CHAT_TRANSCRIPT_FILE = "chat_transcript.jsonl";
const PENDING_ACTION_FILE = "chat_pending_action.json";
const TASK_QUEUE_FILE = "task_queue.json";
const FAILURES_FILE = "failures.jsonl";

async function writeJson(target, value) {
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readText(target) {
  return fs.readFile(target, "utf8");
}

async function snapshotFiles(projectRoot) {
  const names = [STATE_FILE, CHAT_HISTORY_FILE, CHAT_TRANSCRIPT_FILE, PENDING_ACTION_FILE, TASK_QUEUE_FILE, FAILURES_FILE];
  const entries = {};
  for (const name of names) {
    const target = path.join(projectRoot, name);
    entries[name] = (await pathExists(target)) ? await readText(target) : null;
  }
  return entries;
}

function makeWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), "wwriting-legacy-"));
}

test("显式 complete：blueprint_status 迁入 project.yaml，历史入 transcript，migration 置位", async (t) => {
  const workspace = await makeWorkspace();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const { projectRoot } = await createLegacyProjectRoot(workspace); // 默认 blueprint_status: complete
  const before = await snapshotFiles(projectRoot);

  const journal = createAgentJournal({ projectRoot });
  await journal.load();
  const result = await runLegacyImport({ projectRoot, journal });

  assert.equal(result.imported, true);
  assert.equal(result.blueprint_status, "complete");
  assert.match(await readText(path.join(projectRoot, "project.yaml")), /blueprint_status:\s*["']?complete["']?/u);

  const migration = JSON.parse(await readText(path.join(projectRoot, ".wwriting", "agent", "migration.json")));
  assert.equal(migration.legacy_imported, true, "journal 与 project.yaml 写成功后才置位");

  const transcript = await journal.readTranscript();
  const messages = transcript.filter((record) => record.role === "user" || record.role === "assistant");
  assert.equal(messages.length, 2, "两条旧对话历史导入 transcript");
  assert.equal(messages[0].content, "旧对话第一条");
  assert.equal(messages[1].content, "旧对话回复");

  const after = await snapshotFiles(projectRoot);
  for (const name of Object.keys(before)) {
    assert.equal(after[name], before[name], `旧文件 ${name} 不得被改写`);
  }
});

test("幂等：第二次导入不产生重复事件/消息，project.yaml 字节不变", async (t) => {
  const workspace = await makeWorkspace();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const { projectRoot } = await createLegacyProjectRoot(workspace);
  const journal = createAgentJournal({ projectRoot });
  await journal.load();
  const first = await runLegacyImport({ projectRoot, journal });
  assert.equal(first.imported, true);
  const yamlBefore = await readText(path.join(projectRoot, "project.yaml"));
  const transcriptBefore = await journal.readTranscript();
  const eventsBefore = await journal.read({ afterSeq: 0 });

  const second = await runLegacyImport({ projectRoot, journal });
  assert.equal(second.imported, false, "已置位后不再导入");
  assert.deepEqual(await journal.readTranscript(), transcriptBefore, "第二次导入不得新增 transcript 记录");
  assert.deepEqual(await journal.read({ afterSeq: 0 }), eventsBefore, "第二次导入不得新增 journal 事件");
  assert.equal(await readText(path.join(projectRoot, "project.yaml")), yamlBefore, "第二次导入不得改写 project.yaml");
});

test("blueprint_status 缺失 + 章节产物存在 → legacy", async (t) => {
  const workspace = await makeWorkspace();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const { projectRoot } = await createLegacyProjectRoot(workspace, { legacyBlueprintStatus: null });
  // 移除显式字段（模拟更旧的项目）
  const state = JSON.parse(await readText(path.join(projectRoot, STATE_FILE)));
  delete state.blueprint_status;
  await writeJson(path.join(projectRoot, STATE_FILE), state);
  await fs.writeFile(path.join(projectRoot, "chapters", "001.md"), "# 第一章\n\n正文。", "utf8");

  const journal = createAgentJournal({ projectRoot });
  await journal.load();
  const result = await runLegacyImport({ projectRoot, journal });
  assert.equal(result.blueprint_status, "legacy");
  assert.match(await readText(path.join(projectRoot, "project.yaml")), /blueprint_status:\s*["']?legacy["']?/u);
});

test("blueprint_status 缺失 + 无章节产物 → none", async (t) => {
  const workspace = await makeWorkspace();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const { projectRoot } = await createLegacyProjectRoot(workspace, { legacyBlueprintStatus: null });
  const state = JSON.parse(await readText(path.join(projectRoot, STATE_FILE)));
  delete state.blueprint_status;
  await writeJson(path.join(projectRoot, STATE_FILE), state);

  const journal = createAgentJournal({ projectRoot });
  await journal.load();
  const result = await runLegacyImport({ projectRoot, journal });
  assert.equal(result.blueprint_status, "none");
  assert.match(await readText(path.join(projectRoot, "project.yaml")), /blueprint_status:\s*["']?none["']?/u);
});

test("显式 partial 优先于章节产物判定", async (t) => {
  const workspace = await makeWorkspace();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const { projectRoot } = await createLegacyProjectRoot(workspace, { legacyBlueprintStatus: "partial" });
  await fs.writeFile(path.join(projectRoot, "chapters", "001.md"), "# 第一章\n\n正文。", "utf8");
  const journal = createAgentJournal({ projectRoot });
  await journal.load();
  const result = await runLegacyImport({ projectRoot, journal });
  assert.equal(result.blueprint_status, "partial", "显式 partial 优先，即使有章节产物");
});

test("未完成状态导入至多一个 Run，输入取最近任务指令", async (t) => {
  const workspace = await makeWorkspace();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const { projectRoot } = await createLegacyProjectRoot(workspace);
  const state = JSON.parse(await readText(path.join(projectRoot, STATE_FILE)));
  state.project_status = "running";
  await writeJson(path.join(projectRoot, STATE_FILE), state);
  await writeJson(path.join(projectRoot, TASK_QUEUE_FILE), {
    schema_version: 3,
    tasks: [
      { id: "task-1", index: 0, instruction: "写第一章", status: "running" },
      { id: "task-2", index: 1, instruction: "写第二章", status: "running" }
    ]
  });

  const journal = createAgentJournal({ projectRoot });
  await journal.load();
  const result = await runLegacyImport({ projectRoot, journal });
  assert.equal(result.imported, true);
  assert.equal(typeof result.run?.run_id, "string");

  const events = await journal.read({ afterSeq: 0 });
  const runStarts = events.filter((event) => event.type === "run_started" && event.payload?.legacy === true);
  assert.equal(runStarts.length, 1, "至多导入一个未完成 Run");
  const queued = events.filter((event) => event.type === "input_queued");
  assert.equal(queued.length, 1);
  assert.equal(queued[0].payload.text, "写第二章", "输入文本取最近任务指令");
  const session = await journal.getSession();
  assert.equal(session.active_run.id, result.run.run_id);
  assert.equal(session.status, "running");

  // 重复导入：不得产生第二个 Run
  const again = await runLegacyImport({ projectRoot, journal });
  assert.equal(again.imported, false);
  const eventsAfter = await journal.read({ afterSeq: 0 });
  assert.equal(eventsAfter.filter((event) => event.type === "run_started" && event.payload?.legacy === true).length, 1);
});

test("idle 状态（含已完成的队列任务）不导入 Run", async (t) => {
  const workspace = await makeWorkspace();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const { projectRoot } = await createLegacyProjectRoot(workspace); // project_status: idle
  await writeJson(path.join(projectRoot, TASK_QUEUE_FILE), {
    schema_version: 3,
    tasks: [
      { id: "task-1", index: 0, instruction: "写第一章", status: "completed" },
      { id: "task-2", index: 1, instruction: "写第二章", status: "cancelled" }
    ]
  });
  const journal = createAgentJournal({ projectRoot });
  await journal.load();
  const result = await runLegacyImport({ projectRoot, journal });
  assert.equal(result.run, null, "idle 项目不导入 Run");
  const events = await journal.read({ afterSeq: 0 });
  assert.equal(events.some((event) => event.type === "run_started"), false);
});

test("未解决错误事实导入 transcript note，已解决的不导入", async (t) => {
  const workspace = await makeWorkspace();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const { projectRoot } = await createLegacyProjectRoot(workspace);
  await fs.writeFile(
    path.join(projectRoot, FAILURES_FILE),
    [
      JSON.stringify({ id: "f-1", type: "quality_gate", message: "字数不足", resolution: null }),
      JSON.stringify({ id: "f-2", type: "quality_gate", message: "已修复", resolution: { action: "fixed" } })
    ].join("\n") + "\n",
    "utf8"
  );
  await writeJson(path.join(projectRoot, PENDING_ACTION_FILE), {
    id: "p-1",
    status: "pending",
    tool: "write_file",
    created_at: new Date().toISOString()
  });

  const journal = createAgentJournal({ projectRoot });
  await journal.load();
  await runLegacyImport({ projectRoot, journal });
  const transcript = await journal.readTranscript();
  const notes = transcript.filter((record) => record.role === "note");
  assert.equal(notes.length, 2, "一条未解决失败 + 一条未清除 pending action");
  const failureNote = JSON.parse(notes.find((note) => note.legacy_id.startsWith("failures:"))?.content ?? "{}");
  assert.equal(failureNote.legacy_error, true);
  assert.equal(failureNote.message, "字数不足");
  const pendingNote = JSON.parse(notes.find((note) => note.legacy_id === "pending_action:0")?.content ?? "{}");
  assert.equal(pendingNote.legacy_pending_action, true);
  assert.equal(notes.some((note) => note.content.includes("已修复")), false, "已解决失败不导入");
});

test("损坏旧文件不阻塞导入（0 字节 state / 坏 JSON 队列 / 坏 pending action）", async (t) => {
  const workspace = await makeWorkspace();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const { projectRoot } = await createLegacyProjectRoot(workspace);
  // 0 字节 agent_state.json（JSON.parse("") 抛错）、损坏 task_queue.json、
  // 损坏 chat_pending_action.json —— 修复前 readJson 直接 throw，导入永久失败，
  // 每次 open 只留下 warn 重试。
  await fs.writeFile(path.join(projectRoot, STATE_FILE), "", "utf8");
  await fs.writeFile(path.join(projectRoot, TASK_QUEUE_FILE), "{broken json", "utf8");
  await fs.writeFile(path.join(projectRoot, PENDING_ACTION_FILE), "not json at all", "utf8");

  const journal = createAgentJournal({ projectRoot });
  await journal.load();
  const result = await runLegacyImport({ projectRoot, journal });
  assert.equal(result.imported, true, "损坏旧文件应容错，导入必须成功");
  // 显式 blueprint 缺失 + 无章节产物 → none（blueprint 迁移兜底仍工作）
  assert.equal(result.blueprint_status, "none");
  const migration = JSON.parse(await readText(path.join(projectRoot, ".wwriting", "agent", "migration.json")));
  assert.equal(migration.legacy_imported, true);
  // 历史仍正常导入（chat_history 未损坏）
  const messages = (await journal.readTranscript()).filter((r) => r.role === "user" || r.role === "assistant");
  assert.equal(messages.length, 2);

  // 第二次 open 幂等仍成立
  const again = await runLegacyImport({ projectRoot, journal });
  assert.equal(again.imported, false);
});

test("chat_transcript 在 chat_history 缺失时兜底导入", async (t) => {
  const workspace = await makeWorkspace();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const { projectRoot } = await createLegacyProjectRoot(workspace);
  await fs.rm(path.join(projectRoot, CHAT_HISTORY_FILE));
  await fs.appendFile(
    path.join(projectRoot, CHAT_TRANSCRIPT_FILE),
    `${JSON.stringify({ role: "user", content: "来自完整模型链" })}\n${JSON.stringify({ role: "assistant", content: "模型回复" })}\n`,
    "utf8"
  );
  const journal = createAgentJournal({ projectRoot });
  await journal.load();
  await runLegacyImport({ projectRoot, journal });
  const messages = (await journal.readTranscript()).filter((r) => r.role === "user" || r.role === "assistant");
  assert.deepEqual(
    messages.map((record) => record.content),
    ["来自完整模型链", "模型回复"],
    "chat_history 缺失时用 chat_transcript 兜底"
  );
});

test("完整链路：open() 触发导入后，一轮 Agent 运行也不写旧状态文件", async (t) => {
  const h = await createProjectAgentHarness({ legacy: true, gatewayScript: [{ reply: { text: "好。" } }] });
  t.after(() => h.cleanup());
  // 补充旧任务队列与失败记录（夹具默认只有 state + chat history）
  await writeJson(path.join(h.projectRoot, TASK_QUEUE_FILE), {
    schema_version: 3,
    tasks: [{ id: "task-1", index: 0, instruction: "写第一章", status: "completed" }]
  });
  await fs.writeFile(path.join(h.projectRoot, FAILURES_FILE), `${JSON.stringify({ id: "f-1", message: "旧失败", resolution: null })}\n`, "utf8");
  const before = await snapshotFiles(h.projectRoot);

  await h.agent.open({ projectRoot: h.projectRoot });
  const yaml = await readText(path.join(h.projectRoot, "project.yaml"));
  assert.match(yaml, /blueprint_status:\s*["']?complete["']?/u);

  await h.agent.submit({ projectRoot: h.projectRoot, text: "继续写作", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);

  const after = await snapshotFiles(h.projectRoot);
  for (const name of Object.keys(before)) {
    assert.equal(after[name], before[name], `导入后不得再写旧文件 ${name}`);
  }
  const events = await readEvents(h.agent, h.projectRoot);
  assert.equal(eventsOfType(events, "session_created").length, 1, "多次 open 不重复创建 session");
});

test("缺少 project.yaml：跳过 blueprint 字段迁移但仍可导入对话", async (t) => {
  const workspace = await makeWorkspace();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  // 普通文件夹：只有旧聊天文件，没有 project.yaml
  const projectRoot = path.join(workspace, "plain-folder");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.appendFile(
    path.join(projectRoot, CHAT_HISTORY_FILE),
    `${JSON.stringify({ role: "user", text: "旧对话" })}\n`,
    "utf8"
  );
  const journal = createAgentJournal({ projectRoot });
  await journal.load();
  const result = await runLegacyImport({ projectRoot, journal });
  assert.equal(result.imported, true, "缺少 project.yaml 仍应导入对话");
  assert.equal(result.blueprint_status, null, "缺少 project.yaml 时跳过 blueprint 字段迁移");
  const messages = (await journal.readTranscript()).filter((r) => r.role === "user" || r.role === "assistant");
  assert.deepEqual(messages.map((record) => record.content), ["旧对话"], "对话仍应导入");
  assert.equal(await pathExists(path.join(projectRoot, "project.yaml")), false, "不得创建 project.yaml");
  // 幂等：第二次导入不再执行
  const again = await runLegacyImport({ projectRoot, journal });
  assert.equal(again.imported, false);
});
