// 项目级 Agent journal 测试（统一 Agent 内核计划 Task 2）。
//
// tests/agent/ 是允许测试内部 seam 的目录：本文件直接导入
// src/core/agent/journal.mjs（深模块内部实现），覆盖：
//   - 惰性创建 .wwriting/agent/ 与 session_created（锁内才发明 Session id）
//   - append/appendBatch 的 seq 分配、事件盖章与原子重写 session.json
//   - Session/Run reducer 的全部拒绝不变量（未知事件、两个 active Run、
//     consumed input 残留、两个 in_progress plan 项、无 retry 的 terminal→running 等）
//   - 崩溃恢复：stale session.json 重放修复；dangling assistant 活动标记
//     run_interrupted 并清除 grant；缺失尾部容忍（含多字节 UTF-8 断点）、
//     中间 seq 缺口报错
//   - transcript 与 projection 互不影响
//   - 进程内互斥锁：同一实例并发 append 串行、并发 load 单次 session_created、
//     不同项目互不共享锁
//   - 单实例硬契约：同一 projectRoot 同一进程只允许一个 journal 实例（并发
//     多实例不受保护）；reducer 拒绝混入其他 Session 的事件
//   - 投影写入是尽力而为的可重建缓存：session.json 写入失败不阻断 append，
//     失败通过 journal.projection_write_error 暴露
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FIXED_EVENT_TYPES, createAgentJournal } from "../../src/core/agent/journal.mjs";

const BASE_TIME = Date.parse("2026-08-06T00:00:00.000Z");

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

async function makeWorkspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-journal-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

// 确定性时钟：每次调用 +1000ms；确定性 id：id-1、id-2、…
function createClock() {
  let n = 0;
  return () => BASE_TIME + n++ * 1000;
}

function createIds() {
  let n = 0;
  return () => `id-${(n += 1)}`;
}

function agentDir(root) {
  return path.join(root, ".wwriting", "agent");
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readSessionFile(root) {
  return JSON.parse(await fs.readFile(path.join(agentDir(root), "session.json"), "utf8"));
}

async function readRawEvents(root) {
  const raw = await fs.readFile(path.join(agentDir(root), "events.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

// 手工构造一条事件（用于模拟崩溃现场的 events.jsonl）。
function makeEvent(seq, { root, type, sessionId = "sess-1", runId = null, payload = {}, schemaVersion = 1 }) {
  return {
    schema_version: schemaVersion,
    seq,
    event_id: `evt-${seq}`,
    session_id: sessionId,
    run_id: runId,
    project_root: root,
    type,
    at: new Date(BASE_TIME + seq * 1000).toISOString(),
    payload
  };
}

async function writeCrashJournal(root, events) {
  await fs.mkdir(agentDir(root), { recursive: true });
  await fs.writeFile(
    path.join(agentDir(root), "events.jsonl"),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8"
  );
}

// ---------------------------------------------------------------------------
// 存储布局与 session 生命周期
// ---------------------------------------------------------------------------

test("load 惰性创建 .wwriting/agent 并在锁内追加 session_created", async (t) => {
  const root = await makeWorkspace(t);
  const clock = createClock();
  const journal = createAgentJournal({ projectRoot: root, clock, idFactory: createIds() });

  const session = await journal.load();

  // 存储布局（新分段格式）：segments/events、segments/transcript、session.json、
  // journal-manifest.json、migration.json、checkpoints/；不再创建单体 events.jsonl/
  // transcript.jsonl
  const dir = agentDir(root);
  for (const name of ["session.json", "migration.json", "journal-manifest.json"]) {
    assert.equal(await fs.access(path.join(dir, name)).then(() => true).catch(() => false), true, `${name} 应存在`);
  }
  assert.equal(await pathExists(path.join(dir, "events.jsonl")), false, "新格式 journal 不得创建单体 events.jsonl");
  assert.equal(await pathExists(path.join(dir, "transcript.jsonl")), false, "新格式 journal 不得创建单体 transcript.jsonl");
  assert.equal((await fs.stat(path.join(dir, "checkpoints"))).isDirectory(), true, "checkpoints/ 应为目录");
  assert.equal((await fs.stat(path.join(dir, "segments", "events"))).isDirectory(), true, "segments/events 应为目录");
  assert.equal((await fs.stat(path.join(dir, "segments", "transcript"))).isDirectory(), true, "segments/transcript 应为目录");
  const migration = JSON.parse(await fs.readFile(path.join(dir, "migration.json"), "utf8"));
  assert.deepEqual(migration, { schema_version: 1, legacy_imported: false, project_agent_imported: false });
  const manifest = JSON.parse(await fs.readFile(path.join(dir, "journal-manifest.json"), "utf8"));
  assert.equal(manifest.schema_version, 1);
  assert.equal(typeof manifest.generation_id, "string");
  assert.equal(manifest.events_root, "segments/events");
  assert.equal(manifest.transcript_root, "segments/transcript");
  assert.deepEqual(manifest.gaps, []);

  // 第一个锁定 load 追加 session_created 并写出第一份 session.json
  const events = await journal.read({});
  assert.equal(events.length, 1);
  const created = events[0];
  assert.equal(created.type, "session_created");
  assert.equal(created.seq, 1);
  assert.equal(created.schema_version, 1);
  assert.equal(created.session_id, session.session_id);
  assert.equal(created.project_root, root);
  assert.equal(created.run_id, null);
  assert.equal(created.at, new Date(BASE_TIME).toISOString(), "clock 应注入确定性时间");
  assert.deepEqual(created.payload, {});
  assert.ok(created.event_id.length > 0);

  // projection 契约形状
  assert.equal(session.schema_version, 1);
  assert.equal(session.project_root, root);
  assert.equal(session.status, "idle");
  assert.equal(session.active_run, null);
  assert.deepEqual(session.queued_inputs, []);
  assert.equal(session.last_seq, 1);
  assert.equal(session.updated_at, created.at);

  // session.json 与 projection 一致
  const onDisk = await readSessionFile(root);
  assert.deepEqual(onDisk, session);

  // 第二次 load 幂等：不产生重复 session_created
  const again = await journal.load();
  assert.equal(again.session_id, session.session_id);
  assert.equal((await journal.read({})).length, 1);
});

test("journal 使用 storageRoot 落盘，同时事件仍记录真实 project_root", async (t) => {
  const root = await makeWorkspace(t);
  const projectRoot = path.join(root, "project");
  const storageRoot = path.join(root, "private-agent");
  const journal = createAgentJournal({ projectRoot, storageRoot });
  await journal.load();
  await journal.append({ type: "input_queued", payload: { input_id: "i1", text: "你好" } });
  assert.equal(await pathExists(path.join(storageRoot, "segments", "events", "00000001.jsonl")), true, "事件应落在 storageRoot 的 segments/events");
  assert.equal(await pathExists(path.join(storageRoot, "events.jsonl")), false, "storageRoot 不得出现单体 events.jsonl");
  assert.equal(await pathExists(path.join(projectRoot, ".wwriting", "agent")), false, "项目目录不得出现 .wwriting/agent");
  const event = JSON.parse(
    (await fs.readFile(path.join(storageRoot, "segments", "events", "00000001.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .at(-1)
  );
  assert.equal(event.project_root, path.resolve(projectRoot));
});

test("journal 的 migration 标记经 readMigration/writeMigration 读写应用私有目录", async (t) => {
  const root = await makeWorkspace(t);
  const projectRoot = path.join(root, "project");
  const storageRoot = path.join(root, "private-agent");
  const journal = createAgentJournal({ projectRoot, storageRoot });
  await journal.load();
  const initial = await journal.readMigration();
  assert.deepEqual(initial, { schema_version: 1, legacy_imported: false, project_agent_imported: false });
  await journal.writeMigration({ schema_version: 1, legacy_imported: true, imported_at: "2026-08-07T00:00:00.000Z" });
  assert.deepEqual(await journal.readMigration(), {
    schema_version: 1,
    legacy_imported: true,
    imported_at: "2026-08-07T00:00:00.000Z"
  });
  // 标记落在应用私有目录（storageRoot），项目内 .wwriting/agent 不出现 migration.json
  assert.equal(await pathExists(path.join(storageRoot, "migration.json")), true);
  assert.equal(await pathExists(path.join(projectRoot, ".wwriting", "agent", "migration.json")), false);
});

test("同一实例并发 load 只产生一个 session_created（锁内才发明 Session id）", async (t) => {
  const root = await makeWorkspace(t);
  // 单实例硬契约：并发 load 的互斥由实例锁保证；跨实例并发不受保护（见文件头注释）
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });

  const [sa, sb] = await Promise.all([journal.load(), journal.load()]);
  assert.equal(sa.session_id, sb.session_id);
  assert.equal(sa.session_id, "id-1", "Session id 应在第一次锁定 load 内由 idFactory 生成");
  const all = await journal.read({});
  assert.equal(all.filter((event) => event.type === "session_created").length, 1);
});

test("load 拒绝混入其他 Session 的事件（单实例契约兜底）", async (t) => {
  const root = await makeWorkspace(t);
  const events = [
    makeEvent(1, { root, type: "session_created" }),
    makeEvent(2, { root, type: "input_queued", sessionId: "other-session", payload: { input_id: "in-1", text: "外来事件" } })
  ];
  await writeCrashJournal(root, events);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await assert.rejects(() => journal.load(), /session_id/);
});

test("append 分配连续 seq、盖章事件字段并原子重写 session.json", async (t) => {
  const root = await makeWorkspace(t);
  const clock = createClock();
  const journal = createAgentJournal({ projectRoot: root, clock, idFactory: createIds() });
  await journal.load();

  await journal.append({ type: "input_queued", payload: { input_id: "in-1", text: "你好" } });
  await journal.append({
    type: "run_started",
    run_id: "run-1",
    payload: { workflow: "general", input_id: "in-1" }
  });
  await journal.append({ type: "model_turn_started", run_id: "run-1", payload: { turn_id: "turn-1", input_id: "in-1", reasoning_capability: "supported" } });
  await journal.append({ type: "model_turn_completed", run_id: "run-1", payload: { turn_id: "turn-1", input_id: "in-1", outcome: "completed" } });
  await journal.append({ type: "input_consumed", run_id: "run-1", payload: { input_id: "in-1" } });
  await journal.append({ type: "run_completed", run_id: "run-1", payload: {} });

  const events = await journal.read({});
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3, 4, 5, 6, 7], "seq 必须从 1 连续递增");
  const runStarted = events[2];
  assert.equal(runStarted.type, "run_started");
  assert.equal(runStarted.run_id, "run-1");
  assert.equal(runStarted.project_root, root);
  assert.equal(runStarted.schema_version, 2, "新追加事件盖章 v2 schema");
  assert.equal(runStarted.session_id, events[0].session_id);
  assert.equal(new Date(runStarted.at).getTime(), BASE_TIME + 2000);
  assert.equal(runStarted.payload.workflow, "general");

  const session = await journal.getSession();
  assert.equal(session.status, "idle");
  assert.equal(session.active_run.id, "run-1");
  assert.equal(session.active_run.status, "completed");
  assert.equal(session.active_run.workflow, "general");
  assert.equal(session.active_run.active_input_id, null);
  assert.equal(session.active_run.started_at, runStarted.at);
  assert.deepEqual(session.queued_inputs, []);
  assert.equal(session.last_seq, 7);

  // session.json 与内存 projection 一致（原子重写产物）
  const onDisk = await readSessionFile(root);
  assert.deepEqual(onDisk, session);
});

test("append/appendBatch 返回 projection 副本，调用方篡改不污染内部状态", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });

  const returned = await journal.append({
    type: "input_queued",
    payload: { input_id: "in-1", text: "一" }
  });
  // 调用方篡改返回值
  returned.last_seq = 999;
  returned.queued_inputs.push({ id: "junk", text: "垃圾", status: "queued", queued_at: "x" });

  await journal.append({ type: "input_queued", payload: { input_id: "in-2", text: "二" } });
  const session = await journal.getSession();
  assert.equal(session.last_seq, 3, "内部 seq 不受返回值篡改影响（不会盖出 seq 1000）");
  assert.deepEqual(session.queued_inputs.map((item) => item.id), ["in-1", "in-2"]);

  // appendBatch 同样返回副本
  const batchReturned = await journal.appendBatch([
    { type: "run_started", run_id: "run-1", payload: { workflow: "general" } }
  ]);
  batchReturned.active_run.status = "hacked";
  assert.equal((await journal.getSession()).active_run.status, "running");
});

test("append 归一化调用方传入的 at 并拒绝非法时间", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await journal.append({
    type: "input_queued",
    payload: { input_id: "in-1", text: "一" },
    at: 1750000000000
  });
  const events = await journal.read({});
  assert.equal(events.at(-1).at, new Date(1750000000000).toISOString(), "调用方 at 应归一化为 ISO-8601");
  await assert.rejects(
    () => journal.append({ type: "input_queued", payload: { input_id: "in-2", text: "二" }, at: "not-a-date" }),
    /非法时间值/
  );
});

test("append 拒绝重复 event_id", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await journal.append({ type: "input_queued", payload: { input_id: "in-1", text: "一" }, event_id: "dup-1" });
  await assert.rejects(
    () => journal.append({ type: "input_queued", payload: { input_id: "in-2", text: "二" }, event_id: "dup-1" }),
    /event_id .* 重复/
  );
});

test("appendBatch 连续 seq，interrupt/promote 批次原子生效", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await journal.append({ type: "input_queued", payload: { input_id: "in-1", text: "先改第三章" } });
  await journal.append({
    type: "run_started",
    run_id: "run-1",
    payload: { workflow: "general", input_id: "in-1" }
  });
  await journal.append({ type: "input_queued", payload: { input_id: "in-2", text: "第二条" } });

  // 一次"立即"必须在同一批次中按顺序写入 interrupt_requested 与 input_promoted
  await journal.appendBatch([
    { type: "interrupt_requested", run_id: "run-1", payload: {} },
    { type: "input_promoted", run_id: "run-1", payload: { input_id: "in-2" } }
  ]);

  const events = await journal.read({});
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3, 4, 5, 6], "appendBatch 内 seq 连续");
  const batch = events.slice(-2);
  assert.equal(batch[0].type, "interrupt_requested");
  assert.equal(batch[1].type, "input_promoted");
  assert.equal(batch[1].payload.input_id, "in-2");

  const session = await journal.getSession();
  assert.equal(session.active_run.id, "run-1", "promote 不创建新 Run");
  assert.equal(session.active_run.status, "interrupting");
  assert.equal(session.status, "interrupting");
  assert.equal(session.active_run.active_input_id, "in-2");
  // 被打断的活动输入放回队首，剩余输入保持顺序
  assert.deepEqual(session.queued_inputs.map((item) => item.id), ["in-1"]);
  assert.equal(session.queued_inputs[0].text, "先改第三章");
  assert.equal(session.queued_inputs[0].status, "queued");
});

test("read 支持 afterSeq/limit 分页", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  for (let i = 1; i <= 5; i += 1) {
    await journal.append({
      type: "input_queued",
      payload: { input_id: `in-${i}`, text: `消息 ${i}` }
    });
  }
  const all = await journal.read({});
  assert.equal(all.length, 6);
  const page = await journal.read({ afterSeq: 3, limit: 2 });
  assert.deepEqual(page.map((event) => event.seq), [4, 5]);
  assert.deepEqual(page.map((event) => event.payload.input_id), ["in-3", "in-4"]);
  assert.equal((await journal.read({ afterSeq: 6 })).length, 0);
});

test("appendTranscript 与 Session projection 互不影响", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await journal.appendTranscript({ role: "user", text: "第一条消息" });
  await journal.appendTranscript({ role: "assistant", text: "回复", usage: { tokens: 10 } });

  // 每条新 record 由 Journal 盖 transcript_seq（不改 role/content 等原始字段）
  const records = await journal.readTranscript();
  assert.deepEqual(records, [
    { role: "user", text: "第一条消息", transcript_seq: 1 },
    { role: "assistant", text: "回复", usage: { tokens: 10 }, transcript_seq: 2 }
  ]);
  // 逐行 JSON，落在 segments/transcript
  const segment = path.join(agentDir(root), "segments", "transcript", "00000001.jsonl");
  assert.equal(await pathExists(segment), true, "transcript 应落在 segments/transcript");
  assert.equal(await pathExists(path.join(agentDir(root), "transcript.jsonl")), false, "不得创建单体 transcript.jsonl");
  const raw = await fs.readFile(segment, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => JSON.parse(line)), "transcript 每行都是合法 JSON");

  // transcript 不参与 Session projection
  const session = await journal.getSession();
  assert.equal(session.last_seq, 1);
  assert.equal(session.status, "idle");
});

// ---------------------------------------------------------------------------
// reducer 状态流
// ---------------------------------------------------------------------------

test("run_status_changed 反映 waiting_user/running 与 decision 闭环", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await journal.append({ type: "input_queued", payload: { input_id: "in-1", text: "写入文件" } });
  await journal.append({
    type: "run_started",
    run_id: "run-1",
    payload: { workflow: "general", input_id: "in-1" }
  });
  await journal.append({ type: "run_status_changed", run_id: "run-1", payload: { status: "waiting_user" } });
  await journal.append({
    type: "decision_requested",
    run_id: "run-1",
    payload: { decision_id: "d-1", activity_id: "a-1", summary: "确认写入？" }
  });

  let session = await journal.getSession();
  assert.equal(session.status, "waiting_user");
  assert.equal(session.active_run.status, "waiting_user");

  await journal.append({ type: "decision_resolved", run_id: "run-1", payload: { decision_id: "d-1", choice: "allow" } });
  await journal.append({ type: "run_status_changed", run_id: "run-1", payload: { status: "running" } });
  await journal.append({ type: "run_completed", run_id: "run-1", payload: {} });

  session = await journal.getSession();
  assert.equal(session.status, "idle");
  assert.equal(session.active_run.status, "completed");
});

test("permission grant 创建与清除反映在 projection", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await journal.append({ type: "input_queued", payload: { input_id: "in-1", text: "写章节" } });
  await journal.append({
    type: "run_started",
    run_id: "run-1",
    payload: { workflow: "chapter", input_id: "in-1" }
  });
  await journal.append({
    type: "permission_grant_created",
    run_id: "run-1",
    payload: {
      grant_id: "g-1",
      input_id: "in-1",
      grant_key: "write:project:chapter-files",
      target_class: "chapter-files"
    }
  });

  let session = await journal.getSession();
  assert.deepEqual(session.active_run.active_grants, [
    {
      id: "g-1",
      input_id: "in-1",
      grant_key: "write:project:chapter-files",
      target_class: "chapter-files",
      created_at: session.active_run.active_grants[0].created_at
    }
  ]);
  assert.ok(!Number.isNaN(Date.parse(session.active_run.active_grants[0].created_at)));

  // input 完成时同一批次追加 permission_grant_cleared
  await journal.appendBatch([
    { type: "input_consumed", run_id: "run-1", payload: { input_id: "in-1" } },
    {
      type: "permission_grant_cleared",
      run_id: "run-1",
      payload: { input_id: "in-1", grant_key: "write:project:chapter-files", grant_id: "g-1" }
    }
  ]);
  session = await journal.getSession();
  assert.deepEqual(session.active_run.active_grants, []);
});

test("reducer 拒绝 permission_grant_created 引用非活 input，队列 input 视为活", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await journal.append({ type: "input_queued", payload: { input_id: "in-1", text: "一" } });
  await journal.append({ type: "input_queued", payload: { input_id: "in-2", text: "二" } });
  await journal.append({
    type: "run_started",
    run_id: "run-1",
    payload: { workflow: "general", input_id: "in-1" }
  });
  await assert.rejects(
    () =>
      journal.append({
        type: "permission_grant_created",
        run_id: "run-1",
        payload: { grant_id: "g-1", input_id: "ghost", grant_key: "k", target_class: "t" }
      }),
    /非活 input/
  );
  // 队列中的 input 也视为活 input（同一批次 grant 先于 consumed 到达的顺序变体）
  await journal.append({
    type: "permission_grant_created",
    run_id: "run-1",
    payload: { grant_id: "g-2", input_id: "in-2", grant_key: "k", target_class: "t" }
  });
  assert.equal((await journal.getSession()).active_run.active_grants.length, 1);
});

test("无 Run 时 permission_grant_cleared 容错不抛错", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await journal.append({
    type: "permission_grant_cleared",
    payload: { input_id: "in-1", grant_key: "write:project:chapter-files" }
  });
  const session = await journal.getSession();
  assert.equal(session.last_seq, 2);
  assert.equal(session.active_run, null);
});

test("workflow_changed 与 plan_updated 反映在 projection", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await journal.append({ type: "input_queued", payload: { input_id: "in-1", text: "正式写第一章" } });
  await journal.append({
    type: "run_started",
    run_id: "run-1",
    payload: { workflow: "general", input_id: "in-1" }
  });
  await journal.append({ type: "workflow_changed", run_id: "run-1", payload: { workflow: "chapter" } });
  await journal.append({
    type: "plan_updated",
    run_id: "run-1",
    payload: {
      explanation: "先核对已完成章节",
      items: [
        { id: "check", step: "检查已有章节", status: "in_progress", description: "对照章节清单" },
        { id: "fix", step: "修正冲突", status: "pending" },
        { id: "verify", step: "验证修改", status: "pending" }
      ]
    }
  });

  const session = await journal.getSession();
  assert.equal(session.active_run.workflow, "chapter");
  assert.deepEqual(session.active_run.visible_plan, {
    explanation: "先核对已完成章节",
    items: [
      { id: "check", step: "检查已有章节", status: "in_progress", description: "对照章节清单" },
      { id: "fix", step: "修正冲突", status: "pending" },
      { id: "verify", step: "验证修改", status: "pending" }
    ]
  });
});

// ---------------------------------------------------------------------------
// reducer 拒绝不变量
// ---------------------------------------------------------------------------

test("reducer 拒绝未知事件类型，且拒绝后 journal 不被污染", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await assert.rejects(() => journal.append({ type: "no_such_event", payload: {} }), /未知 journal 事件类型/);
  assert.equal((await journal.read({})).length, 1, "被拒绝的事件不得落盘");
  // 后续合法操作不受影响
  await journal.append({ type: "input_queued", payload: { input_id: "in-1", text: "好" } });
  assert.equal((await journal.read({})).length, 2);
});

test("reducer 拒绝两个 active Run", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await journal.append({
    type: "run_started",
    run_id: "run-1",
    payload: { workflow: "general" }
  });
  await assert.rejects(
    () => journal.append({ type: "run_started", run_id: "run-2", payload: { workflow: "general" } }),
    /两个 active Run/
  );
});

test("reducer 拒绝已终结 Run 的重复终结事件", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await journal.append({ type: "run_started", run_id: "run-1", payload: { workflow: "general" } });
  await journal.append({ type: "run_completed", run_id: "run-1", payload: {} });
  await assert.rejects(
    () => journal.append({ type: "run_cancelled", run_id: "run-1", payload: { reason: "user_stop" } }),
    /需要非终结 Run/
  );
});

test("reducer 拒绝无 retry 的 terminal→running，允许 retry: true", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await journal.append({ type: "run_started", run_id: "run-1", payload: { workflow: "general" } });
  await journal.append({ type: "run_failed", run_id: "run-1", payload: { error: "provider outage" } });

  await assert.rejects(
    () => journal.append({ type: "run_status_changed", run_id: "run-1", payload: { status: "running" } }),
    /retry/
  );
  await journal.append({
    type: "run_status_changed",
    run_id: "run-1",
    payload: { status: "running", retry: true }
  });
  const session = await journal.getSession();
  assert.equal(session.active_run.status, "running");
  assert.equal(session.status, "running");
});

test("reducer 允许 run_started 恢复同一可恢复 Run（retry 语义）", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await journal.append({ type: "input_queued", payload: { input_id: "in-1", text: "写一段话" } });
  await journal.append({
    type: "run_started",
    run_id: "run-1",
    payload: { workflow: "general", input_id: "in-1" }
  });
  await journal.append({ type: "run_failed", run_id: "run-1", payload: { error: "timeout" } });

  // retry：同一 run_id 重新 run_started → 恢复同一 Run
  await journal.append({ type: "run_started", run_id: "run-1", payload: { workflow: "general" } });
  const session = await journal.getSession();
  assert.equal(session.active_run.id, "run-1");
  assert.equal(session.active_run.status, "running");
  assert.equal(session.active_run.workflow, "general");
});

test("reducer 拒绝未知/重复的 input 消费与取消", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await journal.append({ type: "input_queued", payload: { input_id: "in-1", text: "任务" } });
  await journal.append({
    type: "run_started",
    run_id: "run-1",
    payload: { workflow: "general", input_id: "in-1" }
  });
  await journal.append({ type: "input_consumed", run_id: "run-1", payload: { input_id: "in-1" } });

  // 重复消费（in-1 已消费）
  await assert.rejects(
    () => journal.append({ type: "input_consumed", run_id: "run-1", payload: { input_id: "in-1" } }),
    /引用未知 input/
  );
  // 消费从未排队/活动的 input
  await assert.rejects(
    () => journal.append({ type: "input_consumed", run_id: "run-1", payload: { input_id: "ghost" } }),
    /引用未知 input/
  );
  await assert.rejects(
    () => journal.append({ type: "input_cancelled", payload: { input_id: "ghost" } }),
    /引用未知 input/
  );
  // 已终结的 input 不得重新排队
  await assert.rejects(
    () => journal.append({ type: "input_queued", payload: { input_id: "in-1", text: "再来" } }),
    /已终结/
  );
});

test("reducer 拒绝重复排队同一 input", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await journal.append({ type: "input_queued", payload: { input_id: "in-1", text: "一" } });
  await assert.rejects(
    () => journal.append({ type: "input_queued", payload: { input_id: "in-1", text: "重复" } }),
    /已在队列中/
  );
});

test("reducer 拒绝两个 in_progress plan 项与非法状态", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await journal.append({ type: "run_started", run_id: "run-1", payload: { workflow: "general" } });

  await assert.rejects(
    () =>
      journal.append({
        type: "plan_updated",
        run_id: "run-1",
        payload: {
          items: [
            { step: "A", status: "in_progress" },
            { step: "B", status: "in_progress" }
          ]
        }
      }),
    /最多一个 in_progress/
  );
  await assert.rejects(
    () =>
      journal.append({
        type: "plan_updated",
        run_id: "run-1",
        payload: { items: [{ step: "A", status: "doing" }] }
      }),
    /status 非法/
  );
  await assert.rejects(
    () => journal.append({ type: "plan_updated", run_id: "run-1", payload: { items: [] } }),
    /非空 items/
  );
});

test("reducer 拒绝 input_promoted 非排队输入与无 Run 的 run 级事件", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await journal.append({ type: "input_queued", payload: { input_id: "in-1", text: "一" } });
  await journal.append({
    type: "run_started",
    run_id: "run-1",
    payload: { workflow: "general", input_id: "in-1" }
  });
  await assert.rejects(
    () => journal.append({ type: "input_promoted", run_id: "run-1", payload: { input_id: "ghost" } }),
    /引用非排队 input/
  );
});

test("reducer 拒绝无 Run 的 run 级事件", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await assert.rejects(
    () => journal.append({ type: "interrupt_requested", payload: {} }),
    /需要活动 Run/
  );
  await assert.rejects(
    () => journal.append({ type: "interrupt_safe_point_reached", payload: {} }),
    /需要活动 Run/
  );
  await assert.rejects(
    () => journal.append({ type: "model_turn_started", payload: {} }),
    /需要活动 Run/
  );
  await assert.rejects(
    () => journal.append({ type: "run_completed", run_id: "run-1", payload: {} }),
    /需要活动 Run/
  );
});

test("reducer 拒绝无 Run 的 run_status_changed 与 permission_grant_created 无 input_id", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await assert.rejects(
    () => journal.append({ type: "run_status_changed", payload: { status: "running" } }),
    /需要活动 Run/
  );
  await journal.append({ type: "run_started", run_id: "run-1", payload: { workflow: "general" } });
  await assert.rejects(
    () =>
      journal.append({
        type: "permission_grant_created",
        run_id: "run-1",
        payload: { grant_key: "write:project:chapter-files", target_class: "chapter-files" }
      }),
    /input_id/
  );
});

test("reducer 拒绝未开始/重复的 tool call 事件", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await journal.append({ type: "run_started", run_id: "run-1", payload: { workflow: "general" } });
  await assert.rejects(
    () =>
      journal.append({
        type: "tool_call_completed",
        run_id: "run-1",
        payload: { tool_call_id: "tc-1", name: "shell" }
      }),
    /未开始的 tool call/
  );
  await assert.rejects(
    () =>
      journal.append({
        type: "tool_output_delta",
        run_id: "run-1",
        payload: { tool_call_id: "tc-1", name: "shell", text: "增量输出" }
      }),
    /未开始的 tool call/
  );
  await journal.append({
    type: "tool_call_started",
    run_id: "run-1",
    payload: { tool_call_id: "tc-1", name: "shell" }
  });
  await assert.rejects(
    () =>
      journal.append({
        type: "tool_call_started",
        run_id: "run-1",
        payload: { tool_call_id: "tc-1", name: "shell" }
      }),
    /重复开始/
  );
  await journal.append({
    type: "tool_call_completed",
    run_id: "run-1",
    payload: { tool_call_id: "tc-1", name: "shell", exit_code: 0 }
  });
  await journal.append({ type: "run_completed", run_id: "run-1", payload: {} });
});

test("reducer 拒绝 run_id 不匹配的事件", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await journal.append({ type: "run_started", run_id: "run-1", payload: { workflow: "general" } });
  await assert.rejects(
    () => journal.append({ type: "model_turn_started", run_id: "run-2", payload: {} }),
    /与活动 Run .* 不一致/
  );
  await assert.rejects(
    () => journal.append({ type: "run_status_changed", run_id: "run-2", payload: { status: "waiting_user" } }),
    /与活动 Run .* 不一致/
  );
  await assert.rejects(
    () =>
      journal.append({
        type: "tool_call_started",
        run_id: "run-2",
        payload: { tool_call_id: "tc-1", name: "shell" }
      }),
    /与活动 Run .* 不一致/
  );
});

// ---------------------------------------------------------------------------
// 崩溃恢复
// ---------------------------------------------------------------------------

test("stale session.json 在 load 时被重放修复", async (t) => {
  const root = await makeWorkspace(t);
  const j1 = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await j1.load();
  await j1.append({ type: "input_queued", payload: { input_id: "in-1", text: "你好" } });
  await j1.append({
    type: "run_started",
    run_id: "run-1",
    payload: { workflow: "general", input_id: "in-1" }
  });
  const eventsBefore = await j1.read({});

  // 模拟崩溃：session.json 落后于 events.jsonl（陈旧内容）
  await fs.writeFile(
    path.join(agentDir(root), "session.json"),
    JSON.stringify({ stale: true, session_id: "stale-session", last_seq: 0 }),
    "utf8"
  );

  // 全新 journal 实例（模拟进程重启，无内存状态）
  const j2 = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  const session = await j2.load();
  assert.equal(session.active_run.id, "run-1");
  assert.equal(session.last_seq, eventsBefore.length);
  assert.equal(session.status, "running");
  const onDisk = await readSessionFile(root);
  assert.deepEqual(onDisk, session, "load 必须重放 journal 并修复 projection");
  // 事件未被重复/修改
  assert.equal((await j2.read({})).length, eventsBefore.length);
});

test("损坏的 session.json（非法 JSON）在 load 时同样被修复", async (t) => {
  const root = await makeWorkspace(t);
  const j1 = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await j1.load();
  await j1.append({ type: "input_queued", payload: { input_id: "in-1", text: "你好" } });
  await fs.writeFile(path.join(agentDir(root), "session.json"), "{{{ not json", "utf8");

  const j2 = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  const session = await j2.load();
  assert.equal(session.last_seq, 2);
  assert.deepEqual(session.queued_inputs, [{ id: "in-1", text: "你好", status: "queued", queued_at: session.queued_inputs[0].queued_at }]);
});

test("session.json 写入失败是尽力而为：不阻断 append，错误可观察，events.jsonl 是真相源", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();

  // 让 session.json 变成目录 → 原子写必然失败（rename 覆盖目录失败）
  await fs.rm(path.join(agentDir(root), "session.json"));
  await fs.mkdir(path.join(agentDir(root), "session.json"));

  const session = await journal.append({
    type: "input_queued",
    payload: { input_id: "in-1", text: "一" }
  });
  assert.equal(session.last_seq, 2, "append 仍应成功（事件已落盘）");
  assert.ok(journal.projection_write_error, "写入失败应记入可观察字段");
  assert.ok(typeof journal.projection_write_error.message === "string" && journal.projection_write_error.message.length > 0);
  assert.ok(!Number.isNaN(Date.parse(journal.projection_write_error.at)));
  assert.equal((await journal.read({})).length, 2, "事件确实落盘");

  // 修复后投影写入恢复，错误字段清空
  await fs.rmdir(path.join(agentDir(root), "session.json"));
  await journal.append({ type: "input_queued", payload: { input_id: "in-2", text: "二" } });
  assert.equal(journal.projection_write_error, null);
  assert.deepEqual(await readSessionFile(root), await journal.getSession());
});

test("load 容忍缺失尾部（不完整最后一行）并截断修复", async (t) => {
  const root = await makeWorkspace(t);
  const events = [
    makeEvent(1, { root, type: "session_created" }),
    makeEvent(2, { root, type: "input_queued", payload: { input_id: "in-1", text: "一" } }),
    makeEvent(3, { root, type: "run_started", runId: "run-1", payload: { workflow: "general", input_id: "in-1" } }),
    makeEvent(4, { root, type: "model_turn_started", runId: "run-1" }),
    makeEvent(5, { root, type: "model_turn_completed", runId: "run-1" })
  ];
  await fs.mkdir(agentDir(root), { recursive: true });
  // 旧单体格式（legacy）：5 条完整事件 + 尾部半行 → legacy 迁移丢弃半行
  await fs.writeFile(
    path.join(agentDir(root), "events.jsonl"),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n" + '{"partial',
    "utf8"
  );

  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  const session = await journal.load();
  assert.equal(session.last_seq, 5, "缺失尾部应被容忍（迁移时丢弃半行）");
  assert.equal(session.active_run.status, "running");

  // 旧文件已迁移改名为 events.legacy.jsonl；segments 只含 5 条完整事件
  assert.equal(await pathExists(path.join(agentDir(root), "events.jsonl")), false, "events.jsonl 迁移后应被改名");
  assert.equal(await pathExists(path.join(agentDir(root), "events.legacy.jsonl")), true, "旧文件应保留为 events.legacy.jsonl");
  const segment = path.join(agentDir(root), "segments", "events", "00000001.jsonl");
  const raw = await fs.readFile(segment, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  assert.equal(lines.length, 5, "segments 只含完整事件，半行不进 segment");
  // 后续 append 正常衔接
  await journal.append({ type: "input_queued", payload: { input_id: "in-2", text: "二" } });
  const last = (await journal.read({})).at(-1);
  assert.equal(last.seq, 6);
});

test("load 容忍断在多字节 UTF-8 字符中间的缺失尾部（基于 Buffer 的字节偏移）", async (t) => {
  const root = await makeWorkspace(t);
  const events = [
    makeEvent(1, { root, type: "session_created" }),
    makeEvent(2, { root, type: "input_queued", payload: { input_id: "in-1", text: "你好" } }),
    makeEvent(3, { root, type: "input_queued", payload: { input_id: "in-2", text: "世界" } })
  ];
  await fs.mkdir(agentDir(root), { recursive: true });
  // 最后一行是 '{"broken": "' + "中"（E4 B8 AD）的前两个字节 E4 B8：
  // 解码后是 U+FFFD，字节数（6）与原文（2）不一致——偏移必须按 Buffer 计算
  const content = Buffer.concat([
    Buffer.from(events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8"),
    Buffer.from('{"broken": "', "utf8"),
    Buffer.from([0xe4, 0xb8])
  ]);
  await fs.writeFile(path.join(agentDir(root), "events.jsonl"), content);

  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  const session = await journal.load();
  assert.equal(session.last_seq, 3, "多字节断点应被容忍并精确截断");
  await journal.append({ type: "input_queued", payload: { input_id: "in-3", text: "三" } });

  // 第二次 load（新实例）必须仍能干净重放：若截断偏移按解码后字符串计算，
  // 文件中会残留被截坏的字节，后续 load 必然失败
  const again = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  const session2 = await again.load();
  assert.equal(session2.last_seq, 4);
  assert.deepEqual(session2.queued_inputs.map((item) => item.id), ["in-1", "in-2", "in-3"]);
});

test("load 拒绝中间 seq 缺口（不静默跳过）", async (t) => {
  const root = await makeWorkspace(t);
  const events = [
    makeEvent(1, { root, type: "session_created" }),
    makeEvent(2, { root, type: "input_queued", payload: { input_id: "in-1", text: "一" } }),
    makeEvent(4, { root, type: "input_queued", payload: { input_id: "in-2", text: "二" } })
  ];
  await writeCrashJournal(root, events);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await assert.rejects(() => journal.load(), /seq 缺口/);
});

test("dangling assistant tool call 恢复为 run_interrupted 并清除 grant", async (t) => {
  const root = await makeWorkspace(t);
  const events = [
    makeEvent(1, { root, type: "session_created" }),
    makeEvent(2, { root, type: "input_queued", payload: { input_id: "in-1", text: "运行命令" } }),
    makeEvent(3, { root, type: "run_started", runId: "run-1", payload: { workflow: "general", input_id: "in-1" } }),
    makeEvent(4, {
      root,
      type: "permission_grant_created",
      runId: "run-1",
      payload: { grant_id: "g-1", input_id: "in-1", grant_key: "write:project:chapter-files", target_class: "chapter-files" }
    }),
    makeEvent(5, { root, type: "model_turn_started", runId: "run-1" }),
    makeEvent(6, { root, type: "tool_call_started", runId: "run-1", payload: { tool_call_id: "tc-1", name: "shell" } }),
    makeEvent(7, { root, type: "tool_output_delta", runId: "run-1", payload: { tool_call_id: "tc-1", name: "shell", text: "..." } })
  ];
  await writeCrashJournal(root, events);
  // 崩溃现场：session.json 陈旧
  await fs.writeFile(path.join(agentDir(root), "session.json"), "{}", "utf8");

  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  const session = await journal.load();
  assert.equal(session.status, "idle");
  assert.equal(session.active_run.id, "run-1");
  assert.equal(session.active_run.status, "interrupted", "dangling tool call 的 Run 必须标记 interrupted");
  assert.deepEqual(session.active_run.active_grants, [], "进程重启后的不可恢复 grant 必须清除");
  assert.equal(session.last_seq, 9);

  const all = await journal.read({});
  const interrupted = all.filter((event) => event.type === "run_interrupted");
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0].run_id, "run-1");
  assert.equal(interrupted[0].seq, 9);
  const cleared = all.filter((event) => event.type === "permission_grant_cleared");
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0].payload.grant_id, "g-1");
  assert.equal(cleared[0].payload.input_id, "in-1");

  // 幂等：再次 load 不重复标记
  await journal.load();
  assert.equal((await journal.read({})).filter((event) => event.type === "run_interrupted").length, 1);
});

test("dangling model turn 同样恢复为 run_interrupted", async (t) => {
  const root = await makeWorkspace(t);
  const events = [
    makeEvent(1, { root, type: "session_created" }),
    makeEvent(2, { root, type: "input_queued", payload: { input_id: "in-1", text: "写一段" } }),
    makeEvent(3, { root, type: "run_started", runId: "run-1", payload: { workflow: "general", input_id: "in-1" } }),
    makeEvent(4, { root, type: "model_turn_started", runId: "run-1" })
  ];
  await writeCrashJournal(root, events);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  const session = await journal.load();
  assert.equal(session.active_run.status, "interrupted");
  assert.equal((await journal.read({})).filter((event) => event.type === "run_interrupted").length, 1);
});

test("无 dangling 活动时 load 不标记 interrupted（Run 保持 running 可恢复）", async (t) => {
  const root = await makeWorkspace(t);
  const events = [
    makeEvent(1, { root, type: "session_created" }),
    makeEvent(2, { root, type: "input_queued", payload: { input_id: "in-1", text: "写一段" } }),
    makeEvent(3, { root, type: "run_started", runId: "run-1", payload: { workflow: "general", input_id: "in-1" } }),
    makeEvent(4, { root, type: "model_turn_started", runId: "run-1" }),
    makeEvent(5, { root, type: "tool_call_started", runId: "run-1", payload: { tool_call_id: "tc-1", name: "read_file" } }),
    makeEvent(6, { root, type: "tool_call_completed", runId: "run-1", payload: { tool_call_id: "tc-1", name: "read_file" } }),
    makeEvent(7, { root, type: "model_turn_completed", runId: "run-1" })
  ];
  await writeCrashJournal(root, events);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  const session = await journal.load();
  assert.equal(session.active_run.status, "running", "全部活动已闭合的 Run 可恢复，不应标记 interrupted");
  assert.equal(session.last_seq, 7);
  assert.equal((await journal.read({})).filter((event) => event.type === "run_interrupted").length, 0);
});

test("reducer 拒绝在 stopping 状态上写入 interrupt_requested（promote 不能击穿 stop）", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await journal.append({ type: "input_queued", payload: { input_id: "in-1", text: "任务" } });
  await journal.append({
    type: "run_started",
    run_id: "run-1",
    payload: { workflow: "general", input_id: "in-1" }
  });
  await journal.append({ type: "run_status_changed", run_id: "run-1", payload: { status: "stopping" } });
  await assert.rejects(
    () => journal.append({ type: "interrupt_requested", run_id: "run-1", payload: {} }),
    /正在停止/
  );
  // 被拒绝后 journal 不被污染：状态保持 stopping，可继续正常停止收敛
  assert.equal((await journal.getSession()).active_run.status, "stopping");
  await journal.appendBatch([
    { type: "input_cancelled", run_id: "run-1", payload: { input_id: "in-1" } },
    { type: "run_cancelled", run_id: "run-1", payload: { reason: "user_stop" } }
  ]);
  assert.equal((await journal.getSession()).active_run.status, "cancelled");
});

test("reducer 拒绝非空队列上的 run_completed（输入不得滞留跨 Run 边界）", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await journal.append({ type: "input_queued", payload: { input_id: "in-1", text: "一" } });
  await journal.append({ type: "input_queued", payload: { input_id: "in-2", text: "二" } });
  await journal.append({
    type: "run_started",
    run_id: "run-1",
    payload: { workflow: "general", input_id: "in-1" }
  });
  await assert.rejects(
    () => journal.append({ type: "run_completed", run_id: "run-1", payload: {} }),
    /队列非空/
  );
  // 队列清空后可以正常自然终结
  await journal.append({ type: "input_consumed", run_id: "run-1", payload: { input_id: "in-1" } });
  await journal.append({ type: "input_consumed", run_id: "run-1", payload: { input_id: "in-2" } });
  await journal.append({ type: "run_completed", run_id: "run-1", payload: {} });
  const session = await journal.getSession();
  assert.equal(session.active_run.status, "completed");
  assert.deepEqual(session.queued_inputs, []);
});

test("崩溃恢复闭合遗留的未解决 decision（decision_resolved cancelled）", async (t) => {
  const root = await makeWorkspace(t);
  const events = [
    makeEvent(1, { root, type: "session_created" }),
    makeEvent(2, { root, type: "input_queued", payload: { input_id: "in-1", text: "写入文件" } }),
    makeEvent(3, { root, type: "run_started", runId: "run-1", payload: { workflow: "general", input_id: "in-1" } }),
    makeEvent(4, { root, type: "model_turn_started", runId: "run-1" }),
    makeEvent(5, { root, type: "model_turn_completed", runId: "run-1" }),
    makeEvent(6, { root, type: "tool_call_started", runId: "run-1", payload: { tool_call_id: "tc-1", name: "write_file" } }),
    makeEvent(7, { root, type: "run_status_changed", runId: "run-1", payload: { status: "waiting_user" } }),
    makeEvent(8, { root, type: "decision_requested", runId: "run-1", payload: { decision_id: "d-1", activity_id: "a-1", input_id: "in-1" } })
  ];
  await writeCrashJournal(root, events);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  const session = await journal.load();
  assert.equal(session.active_run.status, "interrupted");
  const all = await journal.read({});
  const resolved = all.filter((event) => event.type === "decision_resolved");
  assert.equal(resolved.length, 1, "恢复必须闭合崩溃遗留的 decision");
  assert.equal(resolved[0].payload.decision_id, "d-1");
  assert.equal(resolved[0].payload.choice, "cancelled");
  assert.equal(resolved[0].run_id, "run-1");
  // 幂等：再次 load 不重复闭合
  await journal.load();
  assert.equal((await journal.read({})).filter((event) => event.type === "decision_resolved").length, 1);
});

// ---------------------------------------------------------------------------
// 并发与隔离
// ---------------------------------------------------------------------------

test("并发 append 在锁内串行，seq 连续且队列有序", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await Promise.all([
    journal.append({ type: "input_queued", payload: { input_id: "in-1", text: "一" } }),
    journal.append({ type: "input_queued", payload: { input_id: "in-2", text: "二" } }),
    journal.append({ type: "input_queued", payload: { input_id: "in-3", text: "三" } })
  ]);
  const seqs = (await journal.read({})).map((event) => event.seq);
  assert.deepEqual(seqs, [1, 2, 3, 4]);
  const session = await journal.getSession();
  assert.deepEqual(session.queued_inputs.map((item) => item.id), ["in-1", "in-2", "in-3"]);
});

test("不同项目 journal 互不共享锁", async (t) => {
  const root = await makeWorkspace(t);
  const ids = createIds();
  const a = createAgentJournal({ projectRoot: path.join(root, "a"), clock: createClock(), idFactory: ids });
  const b = createAgentJournal({ projectRoot: path.join(root, "b"), clock: createClock(), idFactory: ids });
  await Promise.all([
    a.load(),
    b.load(),
    a.append({ type: "input_queued", payload: { input_id: "in-1", text: "项目 A" } }),
    b.append({ type: "input_queued", payload: { input_id: "in-1", text: "项目 B" } })
  ]);
  const sa = await a.getSession();
  const sb = await b.getSession();
  assert.equal(sa.last_seq, 2);
  assert.equal(sb.last_seq, 2);
  assert.notEqual(sa.session_id, sb.session_id);
  assert.equal(sa.queued_inputs[0].text, "项目 A");
  assert.equal(sb.queued_inputs[0].text, "项目 B");
});

test("append 无需显式 load（自初始化）", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.append({ type: "input_queued", payload: { input_id: "in-1", text: "第一条" } });
  const events = await journal.read({});
  assert.equal(events[0].type, "session_created");
  assert.equal(events[1].type, "input_queued");
  assert.equal(events[1].seq, 2);
});

test("FIXED_EVENT_TYPES 包含计划固定的 32 个事件类型（含 reasoning 与 journal_recovery_boundary）", () => {
  assert.equal(FIXED_EVENT_TYPES.length, 32);
  assert.deepEqual(
    [...FIXED_EVENT_TYPES].sort(),
    [
      "assistant_message_delta",
      "assistant_message_completed",
      "checkpoint_linked",
      "decision_requested",
      "decision_resolved",
      "history_compacted",
      "input_cancelled",
      "input_consumed",
      "input_promoted",
      "input_queued",
      "interrupt_requested",
      "interrupt_safe_point_reached",
      "journal_recovery_boundary",
      "model_turn_completed",
      "model_turn_started",
      "permission_grant_cleared",
      "permission_grant_created",
      "plan_updated",
      "reasoning_completed",
      "reasoning_delta",
      "run_cancelled",
      "run_completed",
      "run_failed",
      "run_interrupted",
      "run_started",
      "run_status_changed",
      "session_created",
      "tool_call_completed",
      "tool_call_failed",
      "tool_call_started",
      "tool_output_delta",
      "workflow_changed"
    ].sort()
  );
});

test("journal_recovery_boundary：以 session projection 为新状态锚点，清空 side 开放活动并置 session idle", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  // 完成一个 Run，留下一个已打开的 tool call 侧状态（后续不再闭合它）
  await journal.append({ type: "input_queued", payload: { input_id: "in-1", text: "一" } });
  await journal.append({ type: "run_started", run_id: "run-1", payload: { workflow: "general", input_id: "in-1" } });
  await journal.append({ type: "tool_call_started", run_id: "run-1", payload: { tool_call_id: "tc-1", name: "shell" } });
  await journal.append({ type: "input_consumed", run_id: "run-1", payload: { input_id: "in-1" } });
  await journal.append({ type: "run_completed", run_id: "run-1", payload: {} });

  // 恢复边界：旧 Run 已终结（idle），边界以当前 projection 为锚点
  await journal.append({
    type: "journal_recovery_boundary",
    payload: { gap_start: 5, gap_end: 8, reason: "segment_corrupt", resume_allowed: false }
  });
  let session = await journal.getSession();
  assert.equal(session.status, "idle", "边界后 session 必须 idle");
  assert.equal(session.active_run.status, "completed", "旧 Run 保持终结状态（锚点）");

  // 边界后允许创建新的 Run（旧开放 tool call 不再阻塞）
  await journal.append({ type: "run_started", run_id: "run-2", payload: { workflow: "general" } });
  session = await journal.getSession();
  assert.equal(session.active_run.id, "run-2");
  assert.equal(session.status, "running");
  await journal.append({ type: "run_completed", run_id: "run-2", payload: {} });

  const all = await journal.read({});
  const boundary = all.filter((event) => event.type === "journal_recovery_boundary");
  assert.equal(boundary.length, 1);
  assert.equal(boundary[0].payload.resume_allowed, false);
  assert.equal(boundary[0].payload.gap_start, 5);
  assert.equal(boundary[0].payload.gap_end, 8);
});

test("契约：reasoning_delta/reasoning_completed 是固定事件类型，v2 turn 事件按 §2.3 payload 闭环", async (t) => {
  assert.ok(FIXED_EVENT_TYPES.includes("reasoning_delta"));
  assert.ok(FIXED_EVENT_TYPES.includes("reasoning_completed"));

  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await journal.append({ type: "input_queued", payload: { input_id: "in-1", text: "写一段" } });
  await journal.append({
    type: "run_started",
    run_id: "run-1",
    payload: { workflow: "general", input_id: "in-1" }
  });
  await journal.append({
    type: "model_turn_started",
    run_id: "run-1",
    payload: { turn_id: "turn-1", input_id: "in-1", reasoning_capability: "supported" }
  });
  await journal.append({
    type: "reasoning_delta",
    run_id: "run-1",
    payload: { turn_id: "turn-1", input_id: "in-1", text: "先检查事实，再回答。" }
  });
  await journal.append({
    type: "reasoning_completed",
    run_id: "run-1",
    payload: { turn_id: "turn-1", input_id: "in-1", text: "先检查事实，再回答。", availability: "available" }
  });
  await journal.append({
    type: "model_turn_completed",
    run_id: "run-1",
    payload: { turn_id: "turn-1", input_id: "in-1", outcome: "completed" }
  });

  const events = await journal.read({});
  const byType = Object.fromEntries(events.map((event) => [event.type, event]));
  assert.equal(byType.model_turn_started.payload.reasoning_capability, "supported");
  assert.equal(byType.reasoning_delta.payload.text, "先检查事实，再回答。");
  assert.equal(byType.reasoning_completed.payload.availability, "available");
  assert.equal(byType.model_turn_completed.payload.outcome, "completed");
});

// ---------------------------------------------------------------------------
// journal v2：schema 升级、turn 校验与旧日志兼容（Task 3）
// ---------------------------------------------------------------------------

test("v2 append 缺 turn_id 的 model_turn_*/reasoning 事件必须拒绝且不污染 journal", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await journal.append({ type: "input_queued", payload: { input_id: "in-1", text: "写一段" } });
  await journal.append({
    type: "run_started",
    run_id: "run-1",
    payload: { workflow: "general", input_id: "in-1" }
  });

  await assert.rejects(
    () =>
      journal.append({
        type: "model_turn_started",
        run_id: "run-1",
        payload: { input_id: "in-1", reasoning_capability: "supported" }
      }),
    /turn_id/
  );
  await assert.rejects(
    () =>
      journal.append({
        type: "model_turn_completed",
        run_id: "run-1",
        payload: { input_id: "in-1", outcome: "completed" }
      }),
    /turn_id/
  );
  await assert.rejects(
    () =>
      journal.append({
        type: "reasoning_delta",
        run_id: "run-1",
        payload: { input_id: "in-1", text: "x" }
      }),
    /turn_id/
  );
  await assert.rejects(
    () =>
      journal.append({
        type: "reasoning_completed",
        run_id: "run-1",
        payload: { input_id: "in-1", text: "x", availability: "available" }
      }),
    /turn_id/
  );

  // 被拒绝的事件一律不落盘，后续合法 v2 turn 事件可正常追加
  const session = await journal.getSession();
  assert.equal(session.last_seq, 3, "4 条缺 turn_id 的事件必须全部被拒绝");
  await journal.append({
    type: "model_turn_started",
    run_id: "run-1",
    payload: { turn_id: "turn-1", input_id: "in-1", reasoning_capability: "supported" }
  });
  assert.equal((await journal.getSession()).last_seq, 4);
});

test("v2 turn 校验：delta 引用未知 turn、completed 重复/未开始、非法 outcome/availability 均拒绝", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await journal.append({ type: "input_queued", payload: { input_id: "in-1", text: "写一段" } });
  await journal.append({
    type: "run_started",
    run_id: "run-1",
    payload: { workflow: "general", input_id: "in-1" }
  });

  await assert.rejects(
    () =>
      journal.append({
        type: "reasoning_delta",
        run_id: "run-1",
        payload: { turn_id: "ghost", input_id: "in-1", text: "x" }
      }),
    /未知 turn/
  );
  await assert.rejects(
    () =>
      journal.append({
        type: "model_turn_completed",
        run_id: "run-1",
        payload: { turn_id: "turn-1", input_id: "in-1", outcome: "completed" }
      }),
    /未开始的 turn/
  );

  // 合法顺序：started → delta → completed(reasoning) → completed(turn)
  await journal.append({
    type: "model_turn_started",
    run_id: "run-1",
    payload: { turn_id: "turn-1", input_id: "in-1", reasoning_capability: "supported" }
  });
  // turn 已开始后：非法 availability 必须拒绝
  await assert.rejects(
    () =>
      journal.append({
        type: "reasoning_completed",
        run_id: "run-1",
        payload: { turn_id: "turn-1", input_id: "in-1", text: "x", availability: "weird" }
      }),
    /availability 非法/
  );
  await assert.rejects(
    () =>
      journal.append({
        type: "model_turn_started",
        run_id: "run-1",
        payload: { turn_id: "turn-1", input_id: "in-1", reasoning_capability: "supported" }
      }),
    /重复开始/
  );
  // turn 已开始后：空 delta 仍必须拒绝
  await assert.rejects(
    () =>
      journal.append({
        type: "reasoning_delta",
        run_id: "run-1",
        payload: { turn_id: "turn-1", input_id: "in-1", text: "" }
      }),
    /非空字符串/
  );
  await journal.append({
    type: "reasoning_completed",
    run_id: "run-1",
    payload: { turn_id: "turn-1", input_id: "in-1", text: "x", availability: "available" }
  });
  // reasoning_completed 只出现一次
  await assert.rejects(
    () =>
      journal.append({
        type: "reasoning_completed",
        run_id: "run-1",
        payload: { turn_id: "turn-1", input_id: "in-1", text: "y", availability: "available" }
      }),
    /已 completed/
  );
  await assert.rejects(
    () =>
      journal.append({
        type: "model_turn_completed",
        run_id: "run-1",
        payload: { turn_id: "turn-1", input_id: "in-1", outcome: "weird" }
      }),
    /outcome 非法/
  );
  await journal.append({
    type: "model_turn_completed",
    run_id: "run-1",
    payload: { turn_id: "turn-1", input_id: "in-1", outcome: "completed" }
  });
  // turn 已闭合：completed 只出现一次
  await assert.rejects(
    () =>
      journal.append({
        type: "model_turn_completed",
        run_id: "run-1",
        payload: { turn_id: "turn-1", input_id: "in-1", outcome: "completed" }
      }),
    /未开始的 turn/
  );
  await journal.append({ type: "input_consumed", run_id: "run-1", payload: { input_id: "in-1" } });
  await journal.append({ type: "run_completed", run_id: "run-1", payload: {} });
  assert.equal((await journal.getSession()).active_run.status, "completed");
});

test("纯 v1 日志（无 turn_id 的 model_turn_*）可打开并按顺序建立/关闭 legacy turn 栈", async (t) => {
  const root = await makeWorkspace(t);
  const events = [
    makeEvent(1, { root, type: "session_created" }),
    makeEvent(2, { root, type: "input_queued", payload: { input_id: "in-1", text: "你好" } }),
    makeEvent(3, { root, type: "run_started", runId: "run-1", payload: { workflow: "general", input_id: "in-1" } }),
    makeEvent(4, { root, type: "model_turn_started", runId: "run-1" }),
    makeEvent(5, { root, type: "model_turn_completed", runId: "run-1" }),
    makeEvent(6, { root, type: "input_consumed", runId: "run-1", payload: { input_id: "in-1" } }),
    makeEvent(7, { root, type: "run_completed", runId: "run-1" })
  ];
  await writeCrashJournal(root, events);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  const session = await journal.load();
  assert.equal(session.schema_version, 1, "纯 v1 日志重放后 projection 保持 v1");
  assert.equal(session.active_run.id, "run-1");
  assert.equal(session.active_run.status, "completed", "v1 日志不能被打开阻塞，也不能误标记 interrupted");
  // legacy turn 栈正确闭合：无 dangling，不需要 run_interrupted 恢复
  assert.equal((await journal.read({})).filter((event) => event.type === "run_interrupted").length, 0);
  // 工作时钟字段对 v1 重放同样可回放：completed 有 finished_at
  assert.equal(session.active_run.finished_at, events[6].at);
});

test("v1 日志重放后可继续追加 v2 事件，projection 升为 v2 且新事件盖章 v2", async (t) => {
  const root = await makeWorkspace(t);
  const events = [
    makeEvent(1, { root, type: "session_created" }),
    makeEvent(2, { root, type: "input_queued", payload: { input_id: "in-1", text: "一" } }),
    makeEvent(3, { root, type: "run_started", runId: "run-1", payload: { workflow: "general", input_id: "in-1" } }),
    makeEvent(4, { root, type: "model_turn_started", runId: "run-1" }),
    makeEvent(5, { root, type: "model_turn_completed", runId: "run-1" }),
    makeEvent(6, { root, type: "input_consumed", runId: "run-1", payload: { input_id: "in-1" } }),
    makeEvent(7, { root, type: "run_completed", runId: "run-1" })
  ];
  await writeCrashJournal(root, events);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  const before = await journal.load();
  assert.equal(before.schema_version, 1);

  // 同一 Session 上继续追加 v2 事件（v1 session 后继续追加）
  await journal.append({ type: "input_queued", payload: { input_id: "in-2", text: "二" } });
  await journal.append({
    type: "run_started",
    run_id: "run-2",
    payload: { workflow: "general", input_id: "in-2" }
  });
  await journal.append({
    type: "model_turn_started",
    run_id: "run-2",
    payload: { turn_id: "turn-2", input_id: "in-2", reasoning_capability: "supported" }
  });
  await journal.append({
    type: "reasoning_delta",
    run_id: "run-2",
    payload: { turn_id: "turn-2", input_id: "in-2", text: "先查事实" }
  });
  await journal.append({
    type: "reasoning_completed",
    run_id: "run-2",
    payload: { turn_id: "turn-2", input_id: "in-2", text: "先查事实", availability: "available" }
  });
  await journal.append({
    type: "model_turn_completed",
    run_id: "run-2",
    payload: { turn_id: "turn-2", input_id: "in-2", outcome: "completed" }
  });
  await journal.append({ type: "input_consumed", run_id: "run-2", payload: { input_id: "in-2" } });
  await journal.append({ type: "run_completed", run_id: "run-2", payload: {} });

  const after = await journal.getSession();
  assert.equal(after.schema_version, 2, "追加 v2 事件后 session projection 取最高 schema version");
  assert.equal(after.active_run.id, "run-2");
  assert.equal(after.active_run.status, "completed");
  const raw = await journal.read({});
  const appended = raw.filter((event) => event.seq > 7);
  assert.ok(appended.length > 0);
  assert.ok(appended.every((event) => event.schema_version === 2), "后续 append 全部盖章 v2");
  assert.ok(appended.some((event) => event.type === "reasoning_delta"), "reasoning_delta 已落盘");
});

// ---------------------------------------------------------------------------
// 有效工作耗时：由 journal 投影负责（Task 3）
// ---------------------------------------------------------------------------

test("工作时钟：active_elapsed_ms 排除 waiting_user（10s 运行 + 30s 等待 + 5s 恢复运行）", async (t) => {
  const root = await makeWorkspace(t);
  let now = BASE_TIME;
  const clock = () => now;
  const journal = createAgentJournal({ projectRoot: root, clock, idFactory: createIds() });
  await journal.load();
  await journal.append({ type: "input_queued", payload: { input_id: "in-1", text: "写一段" } });

  now += 10_000;
  await journal.append({
    type: "run_started",
    run_id: "run-1",
    payload: { workflow: "general", input_id: "in-1" }
  });
  now += 10_000;
  await journal.append({ type: "run_status_changed", run_id: "run-1", payload: { status: "waiting_user" } });
  now += 30_000;
  await journal.append({ type: "run_status_changed", run_id: "run-1", payload: { status: "running" } });
  now += 5_000;
  await journal.append({ type: "input_consumed", run_id: "run-1", payload: { input_id: "in-1" } });
  await journal.append({ type: "run_completed", run_id: "run-1", payload: {} });

  const session = await journal.getSession();
  assert.equal(session.active_run.active_elapsed_ms, 15_000, "有效耗时 = 10s 首次运行 + 5s 恢复后运行，30s 等待不计入");
  assert.equal(session.active_run.active_since, null, "终态后不再计时");
  assert.equal(session.active_run.finished_at, new Date(BASE_TIME + 55_000).toISOString());
});

test("retry 保留累计有效耗时并重新设置 active_since", async (t) => {
  const root = await makeWorkspace(t);
  let now = BASE_TIME;
  const clock = () => now;
  const journal = createAgentJournal({ projectRoot: root, clock, idFactory: createIds() });
  await journal.load();

  now += 5_000;
  await journal.append({ type: "run_started", run_id: "run-1", payload: { workflow: "general" } });
  now += 5_000;
  await journal.append({ type: "run_failed", run_id: "run-1", payload: { error: "boom", code: "model_error" } });
  let session = await journal.getSession();
  assert.equal(session.active_run.active_elapsed_ms, 5_000);
  assert.equal(session.active_run.active_since, null);
  assert.equal(session.active_run.finished_at, new Date(BASE_TIME + 10_000).toISOString());

  now += 60_000;
  await journal.append({ type: "run_started", run_id: "run-1", payload: { workflow: "general" } });
  session = await journal.getSession();
  assert.equal(session.active_run.active_elapsed_ms, 5_000, "retry 保留累计耗时（60s 失败期不计入）");
  assert.equal(session.active_run.active_since, new Date(BASE_TIME + 70_000).toISOString(), "retry 重新设置 active_since");
  // 注意：transitionWorkClock 按 brief 原样实现，retry 后 finished_at 保留旧终态值，
  // 直到下一次终态事件覆盖（对活动 Run 的展示语义无影响）。
});

test("崩溃恢复：未闭合 reasoning turn 仍触发既有 interrupted 恢复", async (t) => {
  const root = await makeWorkspace(t);
  const events = [
    makeEvent(1, { root, type: "session_created" }),
    makeEvent(2, { root, type: "input_queued", payload: { input_id: "in-1", text: "写一段" } }),
    makeEvent(3, { root, type: "run_started", runId: "run-1", payload: { workflow: "general", input_id: "in-1" } }),
    makeEvent(4, {
      root,
      type: "model_turn_started",
      runId: "run-1",
      schemaVersion: 2,
      payload: { turn_id: "turn-1", input_id: "in-1", reasoning_capability: "supported" }
    }),
    makeEvent(5, {
      root,
      type: "reasoning_delta",
      runId: "run-1",
      schemaVersion: 2,
      payload: { turn_id: "turn-1", input_id: "in-1", text: "推理到一半……" }
    })
  ];
  await writeCrashJournal(root, events);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  const session = await journal.load();
  assert.equal(session.active_run.status, "interrupted", "未闭合 reasoning turn 的 Run 必须标记 interrupted");
  assert.equal(session.last_seq, 6, "5 条崩溃事件 + 1 条恢复 run_interrupted");
  const all = await journal.read({});
  assert.equal(all.filter((event) => event.type === "run_interrupted").length, 1);
  // 幂等：再次 load 不重复标记
  await journal.load();
  assert.equal((await journal.read({})).filter((event) => event.type === "run_interrupted").length, 1);
});

// ---------------------------------------------------------------------------
// plan_updated 结构化深化：id/description 与旧格式兼容
// ---------------------------------------------------------------------------

test("plan_updated 新格式：id/description 进入 projection", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await journal.append({ type: "run_started", run_id: "run-1", payload: { workflow: "general" } });
  await journal.append({
    type: "plan_updated",
    run_id: "run-1",
    payload: {
      items: [
        { id: "a", step: "第一步", status: "in_progress", description: "补充说明" },
        { id: "b", step: "第二步", status: "pending" }
      ]
    }
  });
  const session = await journal.getSession();
  assert.deepEqual(session.active_run.visible_plan.items, [
    { id: "a", step: "第一步", status: "in_progress", description: "补充说明" },
    { id: "b", step: "第二步", status: "pending" }
  ]);
});

test("plan_updated 旧格式（无 id/description）回放兼容：按位置生成占位 id", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await journal.append({ type: "run_started", run_id: "run-1", payload: { workflow: "general" } });
  await journal.append({
    type: "plan_updated",
    run_id: "run-1",
    payload: {
      items: [
        { step: "旧步骤一", status: "in_progress" },
        { step: "旧步骤二", status: "pending" }
      ]
    }
  });
  const session = await journal.getSession();
  assert.deepEqual(session.active_run.visible_plan.items, [
    { id: "item-0", step: "旧步骤一", status: "in_progress" },
    { id: "item-1", step: "旧步骤二", status: "pending" }
  ]);
});

test("reducer 拒绝重复 id 的 plan 项", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await journal.append({ type: "run_started", run_id: "run-1", payload: { workflow: "general" } });
  await assert.rejects(
    () =>
      journal.append({
        type: "plan_updated",
        run_id: "run-1",
        payload: {
          items: [
            { id: "a", step: "一", status: "pending" },
            { id: "a", step: "二", status: "pending" }
          ]
        }
      }),
    /id 重复/
  );
});

// ---------------------------------------------------------------------------
// assistant_message_delta 增量正文投影（步骤7）
// ---------------------------------------------------------------------------

test("assistant_message_delta 在 active_run 累积正文，completed 全文终态对齐", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await journal.append({ type: "run_started", run_id: "run-1", payload: { workflow: "general" } });
  await journal.append({ type: "assistant_message_delta", run_id: "run-1", payload: { input_id: "in-1", text: "第一部分。" } });
  await journal.append({ type: "assistant_message_delta", run_id: "run-1", payload: { input_id: "in-1", text: "第二部分。" } });
  let session = await journal.getSession();
  assert.equal(session.active_run.assistant_text, "第一部分。第二部分。", "delta 应累积到 run 投影");
  // completed 携带全文 → 以全文为权威终态（覆盖累积）
  await journal.append({ type: "assistant_message_completed", run_id: "run-1", payload: { input_id: "in-1", text: "第一部分。第二部分。" } });
  session = await journal.getSession();
  assert.equal(session.active_run.assistant_text, "第一部分。第二部分。");
});

test("assistant_message_completed 不带全文时保留 delta 累积", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await journal.append({ type: "run_started", run_id: "run-1", payload: { workflow: "general" } });
  await journal.append({ type: "assistant_message_delta", run_id: "run-1", payload: { text: "累积正文" } });
  await journal.append({ type: "assistant_message_completed", run_id: "run-1", payload: { input_id: "in-1" } });
  const session = await journal.getSession();
  assert.equal(session.active_run.assistant_text, "累积正文");
});

test("model_turn_started 为新 Provider 轮次重置临时正文", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await journal.append({ type: "run_started", run_id: "run-1", payload: { workflow: "general" } });
  await journal.append({ type: "model_turn_started", run_id: "run-1", payload: { turn_id: "turn-1", input_id: "in-1", reasoning_capability: "supported" } });
  await journal.append({ type: "assistant_message_delta", run_id: "run-1", payload: { text: "工具轮前言" } });
  await journal.append({ type: "model_turn_completed", run_id: "run-1", payload: { turn_id: "turn-1", input_id: "in-1", outcome: "completed" } });
  await journal.append({ type: "model_turn_started", run_id: "run-1", payload: { turn_id: "turn-2", input_id: "in-1", reasoning_capability: "supported" } });

  const session = await journal.getSession();
  assert.equal(session.active_run.assistant_text, null);
});

test("assistant_message_delta 校验：空 text 拒绝；无活动 Run 拒绝", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await journal.append({ type: "run_started", run_id: "run-1", payload: { workflow: "general" } });
  await assert.rejects(
    () => journal.append({ type: "assistant_message_delta", run_id: "run-1", payload: { text: "" } }),
    /非空 text/u
  );
  await journal.append({ type: "run_completed", run_id: "run-1", payload: {} });
  await assert.rejects(
    () => journal.append({ type: "assistant_message_delta", run_id: "run-1", payload: { text: "x" } }),
    /需要(?:活动|非终结) Run/u
  );
});

test("retry 恢复同一 Run 时重置 assistant_text", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await journal.append({ type: "run_started", run_id: "run-1", payload: { workflow: "general" } });
  await journal.append({ type: "assistant_message_delta", run_id: "run-1", payload: { text: "旧尝试正文" } });
  await journal.append({ type: "run_failed", run_id: "run-1", payload: { error: "模型失败", code: "model_error" } });
  await journal.append({ type: "run_started", run_id: "run-1", payload: { workflow: "general" } });
  let session = await journal.getSession();
  assert.equal(session.active_run.assistant_text, null, "retry 后正文增量应重置");
  await journal.append({ type: "assistant_message_delta", run_id: "run-1", payload: { text: "新尝试正文" } });
  session = await journal.getSession();
  assert.equal(session.active_run.assistant_text, "新尝试正文");
});

test("assistant_message_delta 崩溃恢复：events.jsonl 重放重建同一投影", async (t) => {
  const root = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await journal.load();
  await journal.append({ type: "run_started", run_id: "run-1", payload: { workflow: "general" } });
  await journal.append({ type: "assistant_message_delta", run_id: "run-1", payload: { text: "增量一" } });
  await journal.append({ type: "assistant_message_delta", run_id: "run-1", payload: { text: "增量二" } });
  // 模拟崩溃：session.json 落后于 events.jsonl，load() 重放修复
  await fs.writeFile(path.join(agentDir(root), "session.json"), JSON.stringify({ stale: true }));
  const recovered = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  await recovered.load();
  const session = await recovered.getSession();
  assert.equal(session.active_run.assistant_text, "增量一增量二", "重放 delta 得到与实时一致的结果");
});
