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
function makeEvent(seq, { root, type, sessionId = "sess-1", runId = null, payload = {} }) {
  return {
    schema_version: 1,
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

  // 存储布局：events.jsonl / session.json / transcript.jsonl / migration.json / checkpoints/
  const dir = agentDir(root);
  for (const name of ["events.jsonl", "session.json", "transcript.jsonl", "migration.json"]) {
    assert.equal(await fs.access(path.join(dir, name)).then(() => true).catch(() => false), true, `${name} 应存在`);
  }
  assert.equal((await fs.stat(path.join(dir, "checkpoints"))).isDirectory(), true, "checkpoints/ 应为目录");
  const migration = JSON.parse(await fs.readFile(path.join(dir, "migration.json"), "utf8"));
  assert.deepEqual(migration, { schema_version: 1, legacy_imported: false });

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
  await journal.append({ type: "model_turn_started", run_id: "run-1", payload: {} });
  await journal.append({ type: "model_turn_completed", run_id: "run-1", payload: {} });
  await journal.append({ type: "input_consumed", run_id: "run-1", payload: { input_id: "in-1" } });
  await journal.append({ type: "run_completed", run_id: "run-1", payload: {} });

  const events = await journal.read({});
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3, 4, 5, 6, 7], "seq 必须从 1 连续递增");
  const runStarted = events[2];
  assert.equal(runStarted.type, "run_started");
  assert.equal(runStarted.run_id, "run-1");
  assert.equal(runStarted.project_root, root);
  assert.equal(runStarted.schema_version, 1);
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

  const records = await journal.readTranscript();
  assert.deepEqual(records, [
    { role: "user", text: "第一条消息" },
    { role: "assistant", text: "回复", usage: { tokens: 10 } }
  ]);
  // 逐行 JSON
  const raw = await fs.readFile(path.join(agentDir(root), "transcript.jsonl"), "utf8");
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
        { step: "检查已有章节", status: "in_progress" },
        { step: "修正冲突", status: "pending" },
        { step: "验证修改", status: "pending" }
      ]
    }
  });

  const session = await journal.getSession();
  assert.equal(session.active_run.workflow, "chapter");
  assert.deepEqual(session.active_run.visible_plan, {
    explanation: "先核对已完成章节",
    items: [
      { step: "检查已有章节", status: "in_progress" },
      { step: "修正冲突", status: "pending" },
      { step: "验证修改", status: "pending" }
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
  await fs.writeFile(
    path.join(agentDir(root), "events.jsonl"),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n" + '{"partial',
    "utf8"
  );

  const journal = createAgentJournal({ projectRoot: root, clock: createClock(), idFactory: createIds() });
  const session = await journal.load();
  assert.equal(session.last_seq, 5, "缺失尾部应被容忍并截断");
  assert.equal(session.active_run.status, "running");

  // 文件已截断为完整行，后续 append 正常衔接
  const raw = await fs.readFile(path.join(agentDir(root), "events.jsonl"), "utf8");
  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  assert.equal(lines.length, 5);
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

test("FIXED_EVENT_TYPES 包含计划固定的 28 个事件类型", () => {
  assert.equal(FIXED_EVENT_TYPES.length, 28);
  assert.deepEqual(
    [...FIXED_EVENT_TYPES].sort(),
    [
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
      "model_turn_completed",
      "model_turn_started",
      "permission_grant_cleared",
      "permission_grant_created",
      "plan_updated",
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
