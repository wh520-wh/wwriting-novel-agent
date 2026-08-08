// active context checkpoint 存储测试（统一 Journal/上下文窗口/自动压缩计划 Task 7）。
//
// 覆盖（brief Step 1/2/4）：候选提交、原子指针、失败/取消不覆盖、结构化错误、固定磁盘布局、
// 候选→提交时序的故障注入（marker 写入后 / pointer replace 后 / completed append 后杀断）、
// reconcileAfterCrash 四个固定裁决、以及只保留一个 active checkpoint / 一个 completed event。
//
// 说明：journal.mjs 的 FIXED_EVENT_TYPES 在 Task 8 才加入 context_compaction_* 类型
//（Task 7 严格限定为纯新文件，不得修改 journal.mjs），因此本测试使用实现同一最小接口
// （read/append，append 尊重预写 event_id，与 journal.stampEvent 语义一致）的 journal fake；
// Task 8 的 coordinator 与真实 journal 接通后，同一 store 代码直接可用。
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createContextCheckpointStore } from "../../src/core/agent/context-checkpoints.mjs";
import { readJson } from "../../src/core/fs-utils.mjs";

function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "ww-checkpoints-"));
}

function fakeClock() {
  let t = 1_700_000_000_000;
  return () => {
    t += 1000;
    return t;
  };
}

function fakeId() {
  let n = 0;
  return () => {
    n += 1;
    return `id-${n}`;
  };
}

// journal fake：满足 reconcileAfterCrash/commitCandidate 所需的最小接口
// { append(event), read({ afterSeq, limit }) }；append 尊重预写 event_id。
function createFakeJournal({ events = [] } = {}) {
  const recorded = events.map((event, index) => ({
    schema_version: 2,
    seq: index + 1,
    event_id: event.event_id ?? `pre-${index + 1}`,
    session_id: "session-1",
    run_id: event.run_id ?? null,
    project_root: "project",
    type: event.type,
    at: event.at ?? new Date().toISOString(),
    payload: event.payload ?? {}
  }));
  return {
    _events: recorded,
    append(event) {
      const stamped = {
        schema_version: 2,
        seq: recorded.length + 1,
        event_id: event.event_id ?? `fake-${recorded.length + 1}`,
        session_id: "session-1",
        run_id: event.run_id ?? null,
        project_root: "project",
        type: event.type,
        at: event.at ?? new Date().toISOString(),
        payload: event.payload ?? {}
      };
      recorded.push(stamped);
      return Promise.resolve(stamped);
    },
    async read({ afterSeq = 0, limit } = {}) {
      let out = recorded.filter((event) => event.seq > afterSeq);
      if (limit != null) out = out.slice(0, limit);
      return out;
    }
  };
}

function makeSummary(overrides = {}) {
  return {
    schema_version: 1,
    current_task: "完成第三章初稿",
    user_confirmed_decisions: ["主角改名为林默"],
    verified_facts: ["林默 17 岁"],
    files_and_artifacts: ["chapters/003.md"],
    completed_steps: ["拟定第三章大纲"],
    pending_steps: ["写完第三章结尾"],
    pending_decisions: ["第三章是否保留梦境场景"],
    failures_and_recovery: ["第二章模型中断后已恢复"],
    open_tool_calls: [],
    recent_user_intent: "继续写第三章",
    omitted_information: ["第三章早期删改记录"],
    reload_from_workspace: ["WWRITING.md"],
    ...overrides
  };
}

function makeCandidate(overrides = {}) {
  return {
    schema_version: 1,
    checkpoint_id: "ck-1",
    source_checkpoint_id: null,
    source_seq: { start: 1, end: 40 },
    source_transcript_seq: { start: 1, end: 20 },
    configured_model_id: "vendor/model[1m]",
    provider_model_id: "vendor/model",
    trigger: "automatic",
    summary: makeSummary(),
    recent_messages: [{ role: "user", content: "最近 12 轮原文" }],
    open_tool_calls: [],
    reload_from_workspace: ["WWRITING.md"],
    estimated_tokens: 5_000,
    created_at: new Date().toISOString(),
    sha256: "",
    ...overrides
  };
}

function makeSourceState(overrides = {}) {
  return {
    source_checkpoint_id: null,
    source_seq: { start: 1, end: 40 },
    source_transcript_seq: { start: 1, end: 20 },
    configured_model_id: "vendor/model[1m]",
    provider_model_id: "vendor/model",
    trigger: "automatic",
    effective_context_window: 256_000,
    target_tokens: 64_000,
    current_task: "完成第三章初稿",
    user_confirmed_decisions: ["主角改名为林默"],
    pending_steps: ["写完第三章结尾"],
    open_tool_calls: [],
    reload_from_workspace: ["WWRITING.md"],
    ...overrides
  };
}

function makeCommitEvent(overrides = {}) {
  return {
    event_id: "completed-1",
    payload: {
      compaction_id: "comp-1",
      trigger: "automatic",
      attempt: 1,
      estimated_tokens_before: 90_000,
      estimated_tokens_after: 5_000,
      released_tokens: 85_000,
      duration_ms: 1234
    },
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// readActive / 候选写入与清理
// ---------------------------------------------------------------------------

test("readActive：无 checkpoint 时返回空指针形状", async () => {
  const dir = await makeTmpDir();
  const store = createContextCheckpointStore({ agentDir: dir, clock: fakeClock(), idFactory: fakeId() });
  const active = await store.readActive();
  assert.equal(active.schema_version, 1);
  assert.equal(active.checkpoint_id, null);
  assert.equal(active.commit_id, null);
  assert.equal(active.committed_at, null);
  assert.equal(active.source_seq_end, null);
  assert.equal(active.sha256, null);
});

test("writeCandidate/discardCandidate：候选落盘与幂等清理", async () => {
  const dir = await makeTmpDir();
  const store = createContextCheckpointStore({ agentDir: dir, clock: fakeClock(), idFactory: fakeId() });
  const candidate = makeCandidate({ checkpoint_id: "ck-cand" });
  const filePath = await store.writeCandidate(candidate);
  assert.equal(filePath, path.join(dir, "checkpoints", ".candidate-ck-cand.json"));
  assert.deepEqual(await readJson(filePath), candidate);
  await store.discardCandidate("ck-cand");
  await assert.rejects(fs.access(filePath), (error) => error.code === "ENOENT");
  // 幂等：已删除的候选再次清理不抛错
  await store.discardCandidate("ck-cand");
});

test("writeCandidate：非法 checkpoint_id 返回结构化错误（候选写入失败）", async () => {
  const dir = await makeTmpDir();
  const store = createContextCheckpointStore({ agentDir: dir, clock: fakeClock(), idFactory: fakeId() });
  await assert.rejects(
    store.writeCandidate(makeCandidate({ checkpoint_id: "a/b" })),
    (e) => e.code === "checkpoint_invalid_id"
  );
  await assert.rejects(
    store.writeCandidate(makeCandidate({ checkpoint_id: ".." })),
    (e) => e.code === "checkpoint_invalid_id"
  );
  await assert.rejects(
    store.writeCandidate({}),
    (e) => e.code === "checkpoint_candidate_schema"
  );
});

// ---------------------------------------------------------------------------
// validateCandidate：结构化错误
// ---------------------------------------------------------------------------

test("validateCandidate：缺字段/非对象/schema_version 错误均返回 schema 结构化错误", async () => {
  const dir = await makeTmpDir();
  const store = createContextCheckpointStore({ agentDir: dir, clock: fakeClock(), idFactory: fakeId() });
  const sourceState = makeSourceState();

  await assert.rejects(
    store.validateCandidate(makeCandidate({ summary: null }), sourceState),
    (e) => e.code === "checkpoint_summary_schema" && /schema/u.test(e.message)
  );
  const missingSummaryField = makeCandidate();
  delete missingSummaryField.summary.current_task;
  await assert.rejects(
    store.validateCandidate(missingSummaryField, sourceState),
    (e) => e.code === "checkpoint_summary_schema" && /schema/u.test(e.message)
  );
  await assert.rejects(
    store.validateCandidate(makeCandidate({ schema_version: 2 }), sourceState),
    (e) => e.code === "checkpoint_schema" && /schema/u.test(e.message)
  );
  await assert.rejects(
    store.validateCandidate(null, sourceState),
    (e) => e.code === "checkpoint_schema" && /schema/u.test(e.message)
  );
  await assert.rejects(
    store.validateCandidate(makeCandidate({ source_seq: { start: "x", end: 40 } }), sourceState),
    (e) => e.code === "checkpoint_schema" && /schema/u.test(e.message)
  );
});

test("validateCandidate：source seq 变化返回结构化错误", async () => {
  const dir = await makeTmpDir();
  const store = createContextCheckpointStore({ agentDir: dir, clock: fakeClock(), idFactory: fakeId() });
  await assert.rejects(
    store.validateCandidate(makeCandidate({ source_seq: { start: 1, end: 99 } }), makeSourceState()),
    (e) => e.code === "checkpoint_source_seq_mismatch"
  );
  await assert.rejects(
    store.validateCandidate(makeCandidate({ source_transcript_seq: { start: 1, end: 99 } }), makeSourceState()),
    (e) => e.code === "checkpoint_source_seq_mismatch"
  );
});

test("validateCandidate：摘要超过目标返回结构化错误", async () => {
  const dir = await makeTmpDir();
  const store = createContextCheckpointStore({ agentDir: dir, clock: fakeClock(), idFactory: fakeId() });
  await assert.rejects(
    store.validateCandidate(makeCandidate({ estimated_tokens: 65_000 }), makeSourceState({ target_tokens: 64_000 })),
    (e) => e.code === "checkpoint_target_exceeded" && e.message.includes("target")
  );
  // 未给 target_tokens 时按 effective_context_window 的 25% 推导
  await assert.rejects(
    store.validateCandidate(makeCandidate({ estimated_tokens: 70_000 }), makeSourceState({ effective_context_window: 256_000, target_tokens: null })),
    (e) => e.code === "checkpoint_target_exceeded"
  );
});

test("validateCandidate：open_tool_calls 等保护字段被删返回结构化错误", async () => {
  const dir = await makeTmpDir();
  const store = createContextCheckpointStore({ agentDir: dir, clock: fakeClock(), idFactory: fakeId() });
  const sourceState = makeSourceState({
    open_tool_calls: [{ tool_call_id: "tc-1", name: "edit_file", status: "open" }]
  });
  // 保护校验作用于 summary 对应字段（顶层 open_tool_calls 只是 checkpoint 元数据）
  await assert.rejects(
    store.validateCandidate(makeCandidate({ summary: makeSummary({ open_tool_calls: [] }) }), sourceState),
    (e) => e.code === "checkpoint_protected_state" && e.message.includes("open_tool_calls")
  );
  const droppedReload = makeCandidate({ summary: makeSummary({ reload_from_workspace: [] }) });
  await assert.rejects(
    store.validateCandidate(droppedReload, makeSourceState()),
    (e) => e.code === "checkpoint_protected_state" && e.message.includes("reload_from_workspace")
  );
});

test("validateCandidate：合法候选返回校验报告", async () => {
  const dir = await makeTmpDir();
  const store = createContextCheckpointStore({ agentDir: dir, clock: fakeClock(), idFactory: fakeId() });
  const report = await store.validateCandidate(makeCandidate(), makeSourceState());
  assert.deepEqual(report, { schema_ok: true, protected_state_ok: true, target_ok: true, hash_ok: false });
});

// ---------------------------------------------------------------------------
// commitCandidate：成功路径
// ---------------------------------------------------------------------------

test("commitCandidate：成功提交只切换一次指针并追加 completed（含预写 event_id）", async () => {
  const dir = await makeTmpDir();
  const store = createContextCheckpointStore({ agentDir: dir, clock: fakeClock(), idFactory: fakeId() });
  const journal = createFakeJournal();

  const before = await store.readActive();
  const result = await store.commitCandidate(makeCandidate(), {
    journal,
    commitEvent: makeCommitEvent(),
    sourceState: makeSourceState()
  });

  assert.equal(result.checkpoint_id, "ck-1");
  assert.equal(result.event_id, "completed-1");
  assert.ok(result.commit_id.startsWith("id-"), "commit_id 由 idFactory 生成");
  assert.ok(result.sha256.startsWith("sha256:"), "checkpoint sha256 必须是 sha256: 前缀");

  const after = await store.readActive();
  assert.equal(after.checkpoint_id, "ck-1");
  assert.equal(after.schema_version, 1);
  assert.equal(after.commit_id, result.commit_id);
  assert.equal(after.source_seq_end, 40);
  assert.equal(after.sha256, result.sha256);
  assert.deepEqual(
    Object.keys(after).sort(),
    ["checkpoint_id", "commit_id", "committed_at", "schema_version", "sha256", "source_seq_end"]
  );

  // 正式 checkpoint 文件：不可变内容 + 读回 hash 一致
  const file = await readJson(path.join(dir, "checkpoints", "context-ck-1.json"));
  assert.equal(file.schema_version, 1);
  assert.equal(file.sha256, result.sha256);
  assert.equal(file.checkpoint_id, "ck-1");

  // journal 恰好一条 completed，event_id 预写，payload 完整契约
  const events = await journal.read({ afterSeq: 0 });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "context_compaction_completed");
  assert.equal(events[0].event_id, "completed-1");
  assert.equal(events[0].payload.compaction_id, "comp-1");
  assert.equal(events[0].payload.checkpoint_id, "ck-1");
  assert.deepEqual(events[0].payload.source_seq, { start: 1, end: 40 });
  assert.deepEqual(events[0].payload.source_transcript_seq, { start: 1, end: 20 });
  assert.equal(events[0].payload.summary_schema_version, 1);
  assert.equal(events[0].payload.estimated_tokens_before, 90_000);
  assert.equal(events[0].payload.estimated_tokens_after, 5_000);
  assert.deepEqual(events[0].payload.validation, {
    schema_ok: true,
    protected_state_ok: true,
    target_ok: true,
    hash_ok: true
  });

  // marker 已删除；checkpoints 只有一个正式文件
  const rootFiles = await fs.readdir(dir);
  assert.ok(!rootFiles.some((name) => name.startsWith("compaction-commit-")), "marker 应已删除");
  const checkpoints = await fs.readdir(path.join(dir, "checkpoints"));
  assert.deepEqual(checkpoints, ["context-ck-1.json"]);
  assert.equal(before.checkpoint_id, null, "提交前指针为空");
});

// ---------------------------------------------------------------------------
// brief Step 1 逐字：失败不覆盖旧指针
// ---------------------------------------------------------------------------

test("commitCandidate：缺字段候选返回 schema 错误且 active 指针保持旧值（brief Step 1）", async () => {
  const dir = await makeTmpDir();
  const store = createContextCheckpointStore({ agentDir: dir, clock: fakeClock(), idFactory: fakeId() });
  const before = await store.readActive();
  const invalid = makeCandidate();
  delete invalid.summary;
  await assert.rejects(store.commitCandidate({ candidate: invalid }), /schema/u);
  assert.equal((await store.readActive()).checkpoint_id, before.checkpoint_id);
  const leftovers = await fs.readdir(path.join(dir, "checkpoints")).catch(() => []);
  assert.deepEqual(leftovers, [], "校验失败不得留下候选/正式文件");
});

test("commitCandidate：失败/取消路径旧指针与原始 Journal 不变", async () => {
  const dir = await makeTmpDir();
  const store = createContextCheckpointStore({ agentDir: dir, clock: fakeClock(), idFactory: fakeId() });
  const journal = createFakeJournal();
  const before = await store.readActive();

  // 模型输出非法 → 校验失败，无任何写入
  await assert.rejects(
    store.commitCandidate(makeCandidate({ summary: "不是对象" }), { journal, commitEvent: makeCommitEvent(), sourceState: makeSourceState() }),
    /schema/u
  );
  assert.equal((await store.readActive()).checkpoint_id, before.checkpoint_id);
  assert.deepEqual(await journal.read({ afterSeq: 0 }), [], "校验失败不得追加事件");

  // 候选写入后手动 discard（取消路径）
  await store.writeCandidate(makeCandidate({ checkpoint_id: "ck-cancel" }));
  await store.discardCandidate("ck-cancel");
  assert.deepEqual((await store.readActive()).checkpoint_id, before.checkpoint_id);
  assert.deepEqual((await fs.readdir(path.join(dir, "checkpoints"))).filter((n) => n.startsWith(".candidate-")), []);
});

// ---------------------------------------------------------------------------
// 故障注入：candidate→commit 时序三个崩溃点 + 对账裁决
// ---------------------------------------------------------------------------

// 先成功提交 ck-old，再为 comp-new 追加 started/running，返回
// { dir, journal, store, newCandidate, newSourceState, newCommitEvent }
async function setupSecondCompaction() {
  const dir = await makeTmpDir();
  const store = createContextCheckpointStore({ agentDir: dir, clock: fakeClock(), idFactory: fakeId() });
  const journal = createFakeJournal();
  await store.commitCandidate(makeCandidate({ checkpoint_id: "ck-old", estimated_tokens: 3_000 }), {
    journal,
    commitEvent: makeCommitEvent({ event_id: "ev-old", payload: { compaction_id: "comp-old", trigger: "automatic", attempt: 1 } }),
    sourceState: makeSourceState()
  });
  // Task 8 coordinator 在 commitCandidate 之前追加 started/running
  await journal.append({ event_id: "cs-new", type: "context_compaction_started", payload: { compaction_id: "comp-new", trigger: "automatic", attempt: 1 } });
  await journal.append({ event_id: "cr-new", type: "context_compaction_running", payload: { compaction_id: "comp-new", trigger: "automatic", attempt: 1 } });
  const newCandidate = makeCandidate({
    checkpoint_id: "ck-new",
    source_checkpoint_id: "ck-old",
    source_seq: { start: 41, end: 80 },
    source_transcript_seq: { start: 21, end: 40 }
  });
  const newSourceState = makeSourceState({
    source_checkpoint_id: "ck-old",
    source_seq: { start: 41, end: 80 },
    source_transcript_seq: { start: 21, end: 40 }
  });
  const newCommitEvent = makeCommitEvent({
    event_id: "ev-new",
    payload: { compaction_id: "comp-new", trigger: "automatic", attempt: 1, estimated_tokens_before: 90_000 }
  });
  return { dir, journal, store, newCandidate, newSourceState, newCommitEvent };
}

async function listMarkers(dir) {
  const files = await fs.readdir(dir);
  return files.filter((name) => name.startsWith("compaction-commit-")).sort();
}

test("故障注入：marker 写入后杀断 → 对账裁决 1（旧指针保持、清理未提交文件、追加 failed）", async () => {
  const { dir, journal, newCandidate, newSourceState, newCommitEvent } = await setupSecondCompaction();

  await assert.rejects(
    createContextCheckpointStore({ agentDir: dir, clock: fakeClock(), idFactory: fakeId() }).commitCandidate(newCandidate, {
      journal,
      commitEvent: newCommitEvent,
      sourceState: newSourceState,
      faults: { crashAfter: "writeMarker" }
    }),
    (e) => e.code === "checkpoint_crash_fault"
  );

  // 崩溃现场：marker 存在、指针仍是 ck-old、正式 ck-new 已落盘
  assert.equal((await listMarkers(dir)).length, 1);
  const marker = await readJson(path.join(dir, "compaction-commit-" + (await listMarkers(dir))[0].replace("compaction-commit-", "").replace(".json", "")) + ".json");
  assert.equal(marker.checkpoint_id, "ck-new");
  assert.equal(marker.event_id, "ev-new");
  assert.deepEqual(marker.old_pointer, { checkpoint_id: "ck-old", sha256: (await readJson(path.join(dir, "active-context.json"))).sha256, source_seq_end: 40 });
  assert.equal(marker.new_pointer.checkpoint_id, "ck-new");
  assert.equal(marker.new_pointer.source_seq_end, 80);
  assert.equal(marker.payload.compaction_id, "comp-new");
  assert.deepEqual(marker.payload.validation, { schema_ok: true, protected_state_ok: true, target_ok: true, hash_ok: true });

  // 重启：新 store 实例 + 同一 journal 对账
  const restarted = createContextCheckpointStore({ agentDir: dir, clock: fakeClock(), idFactory: fakeId() });
  const report = await restarted.reconcileAfterCrash({ journal });
  assert.equal(report.verdict, "1_pointer_not_switched");

  // 旧上下文继续生效；只有一个 active checkpoint（ck-old）
  assert.equal((await restarted.readActive()).checkpoint_id, "ck-old");
  const checkpoints = await fs.readdir(path.join(dir, "checkpoints"));
  assert.deepEqual(checkpoints, ["context-ck-old.json"], "未提交的 ck-new 正式文件应被清理");
  assert.deepEqual(await listMarkers(dir), [], "marker 应被删除");
  // started/running 未有终态 → 追加 failed(commit_not_switched)
  const events = await journal.read({ afterSeq: 0 });
  const failedEvents = events.filter((e) => e.type === "context_compaction_failed");
  assert.equal(failedEvents.length, 1);
  assert.equal(failedEvents[0].payload.error_code, "commit_not_switched");
  assert.equal(failedEvents[0].payload.compaction_id, "comp-new");
  const completedCount = events.filter((e) => e.type === "context_compaction_completed").length;
  assert.equal(completedCount, 1, "Journal 中只有一个 completed event（ck-old）");
});

test("故障注入：pointer replace 后杀断 → 对账裁决 2（marker 补齐同一 completed）", async () => {
  const { dir, journal, newCandidate, newSourceState, newCommitEvent } = await setupSecondCompaction();

  await assert.rejects(
    createContextCheckpointStore({ agentDir: dir, clock: fakeClock(), idFactory: fakeId() }).commitCandidate(newCandidate, {
      journal,
      commitEvent: newCommitEvent,
      sourceState: newSourceState,
      faults: { crashAfter: "replacePointer" }
    }),
    (e) => e.code === "checkpoint_crash_fault"
  );

  // 崩溃现场：marker 存在、指针已是 ck-new、Journal 尚无 ev-new
  assert.equal((await listMarkers(dir)).length, 1);
  assert.equal((await readJson(path.join(dir, "active-context.json"))).checkpoint_id, "ck-new");
  assert.ok(!(await journal.read({ afterSeq: 0 })).some((e) => e.event_id === "ev-new"));

  const restarted = createContextCheckpointStore({ agentDir: dir, clock: fakeClock(), idFactory: fakeId() });
  const report = await restarted.reconcileAfterCrash({ journal });
  assert.equal(report.verdict, "2_completed_reappended");

  // marker 用保存的 payload 补齐同一个 completed 后删除
  const events = await journal.read({ afterSeq: 0 });
  const completedEvents = events.filter((e) => e.type === "context_compaction_completed");
  assert.equal(completedEvents.length, 2, "ck-old + ck-new 各一个 completed");
  assert.equal(completedEvents[1].event_id, "ev-new");
  assert.equal(completedEvents[1].payload.checkpoint_id, "ck-new");
  assert.equal(completedEvents[1].payload.compaction_id, "comp-new");
  assert.deepEqual(completedEvents[1].payload.source_seq, { start: 41, end: 80 });
  assert.deepEqual(await listMarkers(dir), []);
  // 只有一个 active checkpoint（ck-new）
  assert.equal((await restarted.readActive()).checkpoint_id, "ck-new");
  assert.deepEqual((await fs.readdir(path.join(dir, "checkpoints"))).sort(), ["context-ck-new.json", "context-ck-old.json"]);
});

test("I5：指针切换后 completed append 失败 → best-effort 不报失败，marker 保留、对账裁决 2 补写", async () => {
  const { dir, journal, newCandidate, newSourceState, newCommitEvent } = await setupSecondCompaction();
  const store = createContextCheckpointStore({ agentDir: dir, clock: fakeClock(), idFactory: fakeId() });

  // 提交前指针还是 ck-old；注入 appendCompleted 失败（指针已切换后的步骤必须
  // best-effort——绝不把已成功的提交误报成失败，否则 journal 同时持有双终态）。
  const result = await store.commitCandidate(newCandidate, {
    journal,
    commitEvent: newCommitEvent,
    sourceState: newSourceState,
    faults: { failBefore: "appendCompleted" }
  });
  assert.equal(result.checkpoint_id, "ck-new", "指针已切换的提交仍报告成功");
  assert.equal((await store.readActive()).checkpoint_id, "ck-new", "active 指针已切换");
  const events = await journal.read({ afterSeq: 0 });
  assert.equal(
    events.filter((e) => e.type === "context_compaction_completed").length,
    1,
    "completed 事件未追加（append 失败）——只有旧 ck-old 的 completed"
  );
  assert.equal((await listMarkers(dir)).length, 1, "marker 保留等待对账");
  // 对账裁决 2：marker 保存完整 payload，补写同一 event_id 的 completed
  const restarted = createContextCheckpointStore({ agentDir: dir, clock: fakeClock(), idFactory: fakeId() });
  const report = await restarted.reconcileAfterCrash({ journal });
  assert.equal(report.verdict, "2_completed_reappended");
  const events2 = await journal.read({ afterSeq: 0 });
  const reappended = events2.filter((e) => e.type === "context_compaction_completed" && e.event_id === "ev-new");
  assert.equal(reappended.length, 1, "对账补写同 event_id 的 completed");
  assert.deepEqual(await listMarkers(dir), [], "对账后 marker 清理");
});

test("I5：指针切换后 marker 删除失败 → best-effort 不报失败，对账裁决 3 清理 marker", async () => {
  const { dir, journal, newCandidate, newSourceState, newCommitEvent } = await setupSecondCompaction();
  const store = createContextCheckpointStore({ agentDir: dir, clock: fakeClock(), idFactory: fakeId() });

  const result = await store.commitCandidate(newCandidate, {
    journal,
    commitEvent: newCommitEvent,
    sourceState: newSourceState,
    faults: { failBefore: "deleteMarker" }
  });
  assert.equal(result.checkpoint_id, "ck-new", "marker 删除失败不得把成功提交变失败");
  assert.equal((await store.readActive()).checkpoint_id, "ck-new");
  assert.equal((await listMarkers(dir)).length, 1, "marker 遗留（对账清理）");
  const restarted = createContextCheckpointStore({ agentDir: dir, clock: fakeClock(), idFactory: fakeId() });
  const report = await restarted.reconcileAfterCrash({ journal });
  assert.equal(report.verdict, "3_marker_cleaned");
  assert.deepEqual(await listMarkers(dir), [], "对账后 marker 清理");
});

test("故障注入：completed append 后杀断 → 对账裁决 3（只删 marker，不重复追加）", async () => {
  const { dir, journal, newCandidate, newSourceState, newCommitEvent } = await setupSecondCompaction();

  await assert.rejects(
    createContextCheckpointStore({ agentDir: dir, clock: fakeClock(), idFactory: fakeId() }).commitCandidate(newCandidate, {
      journal,
      commitEvent: newCommitEvent,
      sourceState: newSourceState,
      faults: { crashAfter: "appendCompleted" }
    }),
    (e) => e.code === "checkpoint_crash_fault"
  );

  assert.equal((await listMarkers(dir)).length, 1);
  assert.ok((await journal.read({ afterSeq: 0 })).some((e) => e.event_id === "ev-new"), "completed 已追加");

  const restarted = createContextCheckpointStore({ agentDir: dir, clock: fakeClock(), idFactory: fakeId() });
  const report = await restarted.reconcileAfterCrash({ journal });
  assert.equal(report.verdict, "3_marker_cleaned");

  const events = await journal.read({ afterSeq: 0 });
  const completedEvents = events.filter((e) => e.type === "context_compaction_completed");
  assert.equal(completedEvents.length, 2, "completed 不重复");
  assert.equal(completedEvents[1].event_id, "ev-new");
  assert.deepEqual(await listMarkers(dir), []);
  assert.equal((await restarted.readActive()).checkpoint_id, "ck-new");
});

test("故障注入：正式文件写入后（marker 前）杀断 → 对账清理孤儿文件且不动 Journal", async () => {
  const { dir, journal, newCandidate, newSourceState, newCommitEvent } = await setupSecondCompaction();

  await assert.rejects(
    createContextCheckpointStore({ agentDir: dir, clock: fakeClock(), idFactory: fakeId() }).commitCandidate(newCandidate, {
      journal,
      commitEvent: newCommitEvent,
      sourceState: newSourceState,
      faults: { crashAfter: "writeFinalCheckpoint" }
    }),
    (e) => e.code === "checkpoint_crash_fault"
  );

  // 崩溃现场：正式 ck-new 已落盘、无 marker、指针仍是 ck-old
  assert.deepEqual(await listMarkers(dir), []);
  assert.equal((await readJson(path.join(dir, "active-context.json"))).checkpoint_id, "ck-old");

  const restarted = createContextCheckpointStore({ agentDir: dir, clock: fakeClock(), idFactory: fakeId() });
  const report = await restarted.reconcileAfterCrash({ journal });
  assert.equal(report.status, "noop");

  assert.deepEqual(await fs.readdir(path.join(dir, "checkpoints")), ["context-ck-old.json"], "孤儿正式文件被清理");
  assert.equal((await restarted.readActive()).checkpoint_id, "ck-old");
  const events = await journal.read({ afterSeq: 0 });
  assert.ok(!events.some((e) => e.type === "context_compaction_failed"), "无 marker 时不追加 failed");
  assert.equal(events.filter((e) => e.type === "context_compaction_completed").length, 1);
});

test("故障注入：候选文件残留 → 对账清理候选", async () => {
  const dir = await makeTmpDir();
  const store = createContextCheckpointStore({ agentDir: dir, clock: fakeClock(), idFactory: fakeId() });
  const journal = createFakeJournal();
  await store.writeCandidate(makeCandidate({ checkpoint_id: "ck-orphan" }));
  const restarted = createContextCheckpointStore({ agentDir: dir, clock: fakeClock(), idFactory: fakeId() });
  const report = await restarted.reconcileAfterCrash({ journal });
  assert.equal(report.status, "noop");
  assert.ok(report.cleaned.some((name) => name.includes(".candidate-ck-orphan.json")), "候选应被清理");
  assert.deepEqual(await fs.readdir(path.join(dir, "checkpoints")), []);
});

// ---------------------------------------------------------------------------
// reconcileAfterCrash 裁决 4：存储损坏
// ---------------------------------------------------------------------------

test("reconcileAfterCrash 裁决 4：指针指向新 checkpoint 但 marker 缺失且 Journal 无 completed → 存储损坏", async () => {
  const dir = await makeTmpDir();
  const store = createContextCheckpointStore({ agentDir: dir, clock: fakeClock(), idFactory: fakeId() });
  // 手工构造损坏现场：指针已切换、无 marker、Journal 无 completed
  await store.commitCandidate(makeCandidate({ checkpoint_id: "ck-a" }), {
    journal: createFakeJournal(),
    commitEvent: makeCommitEvent({ event_id: "ev-a" }),
    sourceState: makeSourceState()
  });
  const journal = createFakeJournal(); // 新的空 journal：无任何 completed
  await assert.rejects(
    store.reconcileAfterCrash({ journal }),
    (e) => e.code === "checkpoint_corrupt" && e.message.includes("ck-a") && e.checkpoint_id === "ck-a"
  );
});

test("reconcileAfterCrash 裁决 4：指针新 + completed 存在（无 marker）→ 正常无操作", async () => {
  const dir = await makeTmpDir();
  const store = createContextCheckpointStore({ agentDir: dir, clock: fakeClock(), idFactory: fakeId() });
  const journal = createFakeJournal();
  await store.commitCandidate(makeCandidate({ checkpoint_id: "ck-a" }), {
    journal,
    commitEvent: makeCommitEvent({ event_id: "ev-a" }),
    sourceState: makeSourceState()
  });
  // 正常稳态：无 marker、completed 已在 Journal
  const report = await store.reconcileAfterCrash({ journal });
  assert.equal(report.status, "noop");
  assert.equal((await store.readActive()).checkpoint_id, "ck-a");
});

test("reconcileAfterCrash：无任何提交痕迹时 noop", async () => {
  const dir = await makeTmpDir();
  const store = createContextCheckpointStore({ agentDir: dir, clock: fakeClock(), idFactory: fakeId() });
  const report = await store.reconcileAfterCrash({ journal: createFakeJournal() });
  assert.equal(report.status, "noop");
  assert.equal(report.verdict, null);
});
