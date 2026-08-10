// 单流 journal → 会话注册表迁移测试（统一 Agent 内核计划 Task 3）。
//
// tests/agent/ 是允许测试内部 seam 的目录：本文件直接导入
// src/core/agent/journal-session-migration.mjs（深模块内部实现），覆盖：
//   - 迁移判定：segments/events/ 存在且 sessions/index.json 不存在 → 迁移；
//   - 迁移动作：segments/ 整目录 + session.json + journal-manifest.json 及同一
//     storageRoot 布局下的 checkpoints/ 等一并搬入 sessions/<id>/，内容不重写
//     （逐行一致）；
//   - 注册表：getLastActive === <id>、title === "对话 1"；
//   - 迁移标记合并写入 migration.json，不覆盖既有键（legacy_imported/imported_at）；
//   - 幂等：再次调用 → { migrated:false, sessionId:null }（index.json 或标记存在即跳过）；
//   - 边界：agentRoot 不存在 / 无旧数据 / sessions/index.json 已存在 → 不迁移不抛错；
//   - 集成：迁移后的目录与 journal 从新位置读取时的布局完全一致（load 可重放）。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentJournal } from "../../src/core/agent/journal.mjs";
import { migrateSingleSessionToRegistry, adoptLegacyFlatFilesToRegistry } from "../../src/core/agent/journal-session-migration.mjs";
import { createSessionRegistry } from "../../src/core/agent/session-registry.mjs";

const BASE_TIME = Date.parse("2026-08-06T00:00:00.000Z");

async function makeRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-session-migration-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

// 手工构造一条事件（与 journal.mjs stampEvent 的形状一致；旧单流日志中就是这种事件）。
function makeEvent(seq, { root, type, sessionId = "sess-1", runId = null, payload = {} }) {
  return {
    schema_version: 2,
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

// 构造旧单流 agentRoot（.wwriting/agent）：segments/events + segments/transcript +
// checkpoints/ + session.json + journal-manifest.json + 既有 migration.json。
async function writeOldSingleStream(root, { events, sessionJson = null, manifest = null }) {
  const agentRoot = path.join(root, ".wwriting", "agent");
  await fs.mkdir(path.join(agentRoot, "segments", "events"), { recursive: true });
  await fs.writeFile(
    path.join(agentRoot, "segments", "events", "00000001.jsonl"),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8"
  );
  await fs.mkdir(path.join(agentRoot, "segments", "transcript"), { recursive: true });
  await fs.writeFile(
    path.join(agentRoot, "segments", "transcript", "00000001.jsonl"),
    '{"transcript_seq":1,"role":"user","text":"旧消息"}\n',
    "utf8"
  );
  await fs.mkdir(path.join(agentRoot, "checkpoints"), { recursive: true });
  await fs.writeFile(
    path.join(agentRoot, "checkpoints", "context-cp-1.json"),
    JSON.stringify({ checkpoint_id: "cp-1" }),
    "utf8"
  );
  if (sessionJson) {
    await fs.writeFile(path.join(agentRoot, "session.json"), JSON.stringify(sessionJson, null, 2) + "\n", "utf8");
  }
  if (manifest) {
    await fs.writeFile(path.join(agentRoot, "journal-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  }
  // 既有迁移标记（模拟更早的 legacy flat-file 导入已完成）
  await fs.writeFile(
    path.join(agentRoot, "migration.json"),
    JSON.stringify(
      { schema_version: 1, legacy_imported: true, imported_at: "2026-08-07T00:00:00.000Z" },
      null,
      2
    ) + "\n",
    "utf8"
  );
  return agentRoot;
}

function makeSessionProjection(root, { lastSeq, status, run }) {
  return {
    schema_version: 1,
    session_id: "sess-1",
    project_root: root,
    status,
    active_run: run,
    queued_inputs: [],
    context_usage: null,
    active_context_checkpoint_id: null,
    compaction: null,
    history_degraded: false,
    history_gaps: [],
    revisions: { context: 0 },
    last_seq: lastSeq,
    updated_at: new Date(BASE_TIME + lastSeq * 1000).toISOString()
  };
}

// ---------------------------------------------------------------------------
// 主迁移路径
// ---------------------------------------------------------------------------

test("迁移：旧单流搬入 sessions/<id>，注册表写入会话 1", async (t) => {
  const root = await makeRoot(t);
  const projectRoot = path.join(root, "project");
  const events = [
    makeEvent(1, { root: projectRoot, type: "session_created" }),
    makeEvent(2, { root: projectRoot, type: "input_queued", payload: { input_id: "in-1", text: "你好" } }),
    makeEvent(3, { root: projectRoot, type: "run_started", runId: "run-1", payload: { workflow: "general", input_id: "in-1" } })
  ];
  const agentRoot = await writeOldSingleStream(root, {
    events,
    sessionJson: makeSessionProjection(projectRoot, {
      lastSeq: 3,
      status: "running",
      run: {
        id: "run-1", status: "running", workflow: "general", active_input_id: "in-1",
        visible_plan: null, assistant_text: null, active_grants: [],
        started_at: events[2].at, finished_at: null, active_elapsed_ms: 0, active_since: events[2].at
      }
    }),
    manifest: {
      schema_version: 1,
      generation_id: "gen-1",
      events_root: "segments/events",
      transcript_root: "segments/transcript",
      last_event_seq: 3,
      last_transcript_seq: 1,
      gaps: [],
      generations: []
    }
  });

  const r = await migrateSingleSessionToRegistry({ agentRoot, idFactory: () => "sid-1" });
  assert.equal(r.migrated, true);
  assert.equal(r.sessionId, "sid-1");

  // 事件搬到 sessions/sid-1/segments/events/，内容逐行一致（不重写）
  const targetEvents = path.join(agentRoot, "sessions", "sid-1", "segments", "events", "00000001.jsonl");
  assert.equal(await pathExists(targetEvents), true, "事件段应搬入会话目录");
  assert.equal(
    await fs.readFile(targetEvents, "utf8"),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "事件内容逐行一致"
  );

  // 布局其他部分一并搬走（以 journal.mjs 实际布局为准）
  for (const rel of [
    "session.json",
    "journal-manifest.json",
    "segments/transcript/00000001.jsonl",
    "checkpoints/context-cp-1.json"
  ]) {
    assert.equal(await pathExists(path.join(agentRoot, "sessions", "sid-1", rel)), true, `${rel} 应被搬入会话目录`);
  }
  // migration.json 是 journal 级状态，不搬入会话目录
  assert.equal(await pathExists(path.join(agentRoot, "sessions", "sid-1", "migration.json")), false, "migration.json 不得搬入会话目录");

  // 注册表：最近活跃 / title
  const reg = createSessionRegistry({ root: agentRoot });
  assert.equal(await reg.getLastActive(), "sid-1");
  const meta = await reg.get("sid-1");
  assert.equal(meta.title, "对话 1");

  // 迁移标记合并写入，不覆盖既有字段
  const marker = JSON.parse(await fs.readFile(path.join(agentRoot, "migration.json"), "utf8"));
  assert.equal(marker.sessions_migrated, true);
  assert.equal(marker.legacy_imported, true, "既有 legacy_imported 不被覆盖");
  assert.equal(marker.imported_at, "2026-08-07T00:00:00.000Z", "既有 imported_at 不被覆盖");

  // 旧路径不再存在
  assert.equal(await pathExists(path.join(agentRoot, "segments", "events")), false, "旧 segments/events 应已搬走");
  assert.equal(await pathExists(path.join(agentRoot, "session.json")), false, "旧 session.json 应已搬走");

  // 幂等：再次调用 → migrated:false
  const again = await migrateSingleSessionToRegistry({ agentRoot, idFactory: () => "sid-1" });
  assert.deepEqual(again, { migrated: false, sessionId: null });
});

test("纯 flat 遗留（无 segments）→ adoptLegacyFlatFilesToRegistry 迁入会话 1", async (t) => {
  const root = await makeRoot(t);
  const agentRoot = path.join(root, ".wwriting", "agent");
  await fs.mkdir(agentRoot, { recursive: true });
  await fs.writeFile(path.join(agentRoot, "events.jsonl"), `{"seq":1,"type":"session_created"}\n`, "utf8");
  await fs.writeFile(path.join(agentRoot, "transcript.jsonl"), `{"role":"user","content":"旧对话"}\n`, "utf8");
  await fs.writeFile(path.join(agentRoot, "session.json"), JSON.stringify({ schema_version: 1, session_id: "flat-sess" }) + "\n", "utf8");
  await fs.mkdir(path.join(agentRoot, "checkpoints"), { recursive: true });

  const r = await adoptLegacyFlatFilesToRegistry({ agentRoot, idFactory: () => "sid-flat" });
  assert.equal(r.migrated, true);
  assert.equal(r.sessionId, "sid-flat");

  // flat 条目搬入会话目录（内容不重写），注册表与会话 1 对齐，标记写入
  const sessionDir = path.join(agentRoot, "sessions", "sid-flat");
  assert.equal(await pathExists(path.join(sessionDir, "events.jsonl")), true, "events.jsonl 应搬入会话目录");
  assert.equal(await pathExists(path.join(sessionDir, "transcript.jsonl")), true, "transcript.jsonl 应搬入会话目录");
  assert.equal(await pathExists(path.join(sessionDir, "session.json")), true, "session.json 应搬入会话目录");
  assert.equal(await pathExists(path.join(sessionDir, "checkpoints")), true, "checkpoints/ 应搬入会话目录");
  assert.equal(await pathExists(path.join(agentRoot, "events.jsonl")), false, "根上不再残留 flat 文件");
  const reg = createSessionRegistry({ root: agentRoot });
  assert.equal(await reg.getLastActive(), "sid-flat");
  assert.equal((await reg.get("sid-flat")).title, "对话 1");
  const marker = JSON.parse(await fs.readFile(path.join(agentRoot, "migration.json"), "utf8"));
  assert.equal(marker.sessions_migrated, true);

  // 幂等：再次调用 → migrated:false（index.json 已存在）
  assert.deepEqual(
    await adoptLegacyFlatFilesToRegistry({ agentRoot, idFactory: () => "sid-other" }),
    { migrated: false, sessionId: null }
  );
});

test("纯 flat 无源 / 已注册：adoptLegacyFlatFilesToRegistry 不迁移不抛错", async (t) => {
  const root = await makeRoot(t);

  // 无任何 flat 条目 → 无源
  const empty = path.join(root, "empty-agent");
  await fs.mkdir(empty, { recursive: true });
  assert.deepEqual(
    await adoptLegacyFlatFilesToRegistry({ agentRoot: empty, idFactory: () => "sid-x" }),
    { migrated: false, sessionId: null }
  );

  // sessions/index.json 已存在（注册表已建立）→ 跳过，根上的 flat 文件原样保留
  const adopted = path.join(root, "adopted-agent");
  await fs.mkdir(adopted, { recursive: true });
  await fs.writeFile(path.join(adopted, "events.jsonl"), "x\n", "utf8");
  const reg = createSessionRegistry({ root: adopted });
  await reg.create({ sessionId: "existing", title: "已有会话" });
  assert.deepEqual(
    await adoptLegacyFlatFilesToRegistry({ agentRoot: adopted, idFactory: () => "sid-y" }),
    { migrated: false, sessionId: null }
  );
  assert.equal(await pathExists(path.join(adopted, "events.jsonl")), true, "已注册时不搬动根上文件");
});

// ---------------------------------------------------------------------------
// 失败恢复：搬迁中途崩溃后的自愈
// ---------------------------------------------------------------------------

test("搬迁残留自愈：目标已有部分条目（segments 未搬）时重试完成迁移", async (t) => {
  const root = await makeRoot(t);
  const projectRoot = path.join(root, "project");
  const events = [
    makeEvent(1, { root: projectRoot, type: "session_created" }),
    makeEvent(2, { root: projectRoot, type: "input_queued", payload: { input_id: "in-1", text: "你好" } }),
    makeEvent(3, { root: projectRoot, type: "run_started", runId: "run-1", payload: { workflow: "general", input_id: "in-1" } })
  ];
  const agentRoot = await writeOldSingleStream(root, {
    events,
    sessionJson: makeSessionProjection(projectRoot, {
      lastSeq: 3,
      status: "running",
      run: {
        id: "run-1", status: "running", workflow: "general", active_input_id: "in-1",
        visible_plan: null, assistant_text: null, active_grants: [],
        started_at: events[2].at, finished_at: null, active_elapsed_ms: 0, active_since: events[2].at
      }
    }),
    manifest: {
      schema_version: 1,
      generation_id: "gen-1",
      events_root: "segments/events",
      transcript_root: "segments/transcript",
      last_event_seq: 3,
      last_transcript_seq: 1,
      gaps: [],
      generations: []
    }
  });

  // 模拟前一次运行搬走了 session.json + journal-manifest.json，segments/ 未搬
  // （segments/events 仍在旧根 → 迁移判定继续成立，重试应补完剩余条目）
  const sidDir = path.join(agentRoot, "sessions", "sid-1");
  await fs.mkdir(sidDir, { recursive: true });
  await fs.rename(path.join(agentRoot, "session.json"), path.join(sidDir, "session.json"));
  await fs.rename(path.join(agentRoot, "journal-manifest.json"), path.join(sidDir, "journal-manifest.json"));

  const r = await migrateSingleSessionToRegistry({ agentRoot, idFactory: () => "sid-1" });
  assert.equal(r.migrated, true, "部分搬迁后重试应完成迁移");
  assert.equal(await pathExists(path.join(agentRoot, "segments", "events")), false, "剩余条目（含 segments）应搬走");
  assert.equal(
    await pathExists(path.join(sidDir, "segments", "events", "00000001.jsonl")),
    true,
    "segments 补搬进会话目录"
  );
  const reg = createSessionRegistry({ root: agentRoot });
  assert.equal(await reg.getLastActive(), "sid-1");
  assert.equal((await reg.get("sid-1")).title, "对话 1");
});

// ---------------------------------------------------------------------------
// 边界：无源数据 / 已注册 / 已标记
// ---------------------------------------------------------------------------

test("边界：agentRoot 不存在 / 无旧数据 → 不迁移不抛错", async (t) => {
  const root = await makeRoot(t);

  // agentRoot 目录不存在
  const missing = path.join(root, "nope");
  assert.deepEqual(
    await migrateSingleSessionToRegistry({ agentRoot: missing, idFactory: () => "sid-x" }),
    { migrated: false, sessionId: null }
  );

  // agentRoot 存在但无 segments/events（无旧单流数据）
  const emptyRoot = path.join(root, "empty");
  await fs.mkdir(path.join(emptyRoot, ".wwriting", "agent"), { recursive: true });
  assert.deepEqual(
    await migrateSingleSessionToRegistry({ agentRoot: emptyRoot, idFactory: () => "sid-x" }),
    { migrated: false, sessionId: null }
  );
});

test("边界：sessions/index.json 已存在 → 跳过迁移，旧数据原样保留", async (t) => {
  const root = await makeRoot(t);
  const projectRoot = path.join(root, "project");
  const agentRoot = await writeOldSingleStream(root, {
    events: [makeEvent(1, { root: projectRoot, type: "session_created" })]
  });
  const reg = createSessionRegistry({ root: agentRoot });
  await reg.create({ sessionId: "other", title: "已有会话" });

  assert.deepEqual(
    await migrateSingleSessionToRegistry({ agentRoot, idFactory: () => "sid-1" }),
    { migrated: false, sessionId: null }
  );
  assert.equal(await pathExists(path.join(agentRoot, "segments", "events")), true, "旧数据应原样保留");
});

test("边界：migration.json 已标记 sessions_migrated → 跳过迁移", async (t) => {
  const root = await makeRoot(t);
  const projectRoot = path.join(root, "project");
  const agentRoot = await writeOldSingleStream(root, {
    events: [makeEvent(1, { root: projectRoot, type: "session_created" })]
  });
  // 手工写入已完成标记（模拟迁移完成但 index.json 缺失的现场）
  await fs.writeFile(
    path.join(agentRoot, "migration.json"),
    JSON.stringify({ schema_version: 1, legacy_imported: false, sessions_migrated: true }, null, 2) + "\n",
    "utf8"
  );

  assert.deepEqual(
    await migrateSingleSessionToRegistry({ agentRoot, idFactory: () => "sid-1" }),
    { migrated: false, sessionId: null }
  );
  assert.equal(await pathExists(path.join(agentRoot, "segments", "events")), true, "标记存在时旧数据不搬走");
});

// ---------------------------------------------------------------------------
// 集成：迁移后的目录与 journal 从新位置读取时的布局完全一致
// ---------------------------------------------------------------------------

test("迁移后的会话目录能被 journal 从新位置 load 并干净重放", async (t) => {
  const root = await makeRoot(t);
  const projectRoot = path.join(root, "project");
  const events = [
    makeEvent(1, { root: projectRoot, type: "session_created" }),
    makeEvent(2, { root: projectRoot, type: "input_queued", payload: { input_id: "in-1", text: "你好" } }),
    makeEvent(3, { root: projectRoot, type: "run_started", runId: "run-1", payload: { workflow: "general", input_id: "in-1" } }),
    makeEvent(4, { root: projectRoot, type: "input_consumed", runId: "run-1", payload: { input_id: "in-1" } }),
    makeEvent(5, { root: projectRoot, type: "run_completed", runId: "run-1", payload: {} })
  ];
  const agentRoot = await writeOldSingleStream(root, {
    events,
    sessionJson: makeSessionProjection(projectRoot, {
      lastSeq: 5,
      status: "idle",
      run: {
        id: "run-1", status: "completed", workflow: "general", active_input_id: null,
        visible_plan: null, assistant_text: null, active_grants: [],
        started_at: events[2].at, finished_at: events[4].at, active_elapsed_ms: 0, active_since: null
      }
    }),
    manifest: {
      schema_version: 1,
      generation_id: "gen-1",
      events_root: "segments/events",
      transcript_root: "segments/transcript",
      last_event_seq: 5,
      last_transcript_seq: 1,
      gaps: [],
      generations: []
    }
  });

  const r = await migrateSingleSessionToRegistry({ agentRoot, idFactory: () => "sid-1" });
  assert.equal(r.migrated, true);

  // 新位置 = <agentRoot>/sessions/sid-1，journal 用同一 storageRoot 打开
  const journal = createAgentJournal({
    projectRoot,
    storageRoot: path.join(agentRoot, "sessions", "sid-1")
  });
  const session = await journal.load();
  assert.equal(session.session_id, "sess-1", "重放保留原会话 id");
  assert.equal(session.last_seq, 5);
  assert.equal(session.status, "idle");
  assert.equal(session.active_run.status, "completed");

  const all = await journal.read({});
  assert.deepEqual(all.map((event) => event.seq), [1, 2, 3, 4, 5], "事件序列完整无缺");
  assert.equal(all.length, 5, "干净重放不追加恢复事件");
});
