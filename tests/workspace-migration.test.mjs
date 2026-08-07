// 项目内 Agent 数据无损迁移测试（计划 Task 3 Step 3/4）。
//
// 覆盖 migrateProjectAgentStorage 的全部契约（SPEC §9.2）：
//   - 私有目录为空时复制白名单（events.jsonl / session.json / transcript.jsonl /
//     checkpoints/），不复制旧 migration.json；
//   - 目标已有事件时不覆盖（target_not_empty），目标字节不变；
//   - events.jsonl 中间损坏时拒绝导入（invalid_source），目标目录保持干净
//     （允许新会话在私有目录从零开始），原目录字节不变；
//   - 尾部半行截断（崩溃痕迹）容忍后完整导入，字节级一致复制；
//   - 原目录只读：复制前后字节完全一致，绝不删除/重命名/覆盖；
//   - 第二次迁移幂等：不产生重复数据、不覆盖目标。
//
// 本文件位于 tests/ 根目录（非 tests/agent/），按依赖规则不得 import agent 内部
// 文件；"拒绝后仍允许新会话"由"目标目录保持干净"断言覆盖（journal.load() 会在
// 空私有目录从零创建新 session）。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateProjectAgentStorage } from "../src/core/workspaces/migration.mjs";

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function makeWorkspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-migration-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

// 旧 journal 夹具：目录 + 白名单文件 + 旧 migration.json（不得被复制）。
async function createLegacyAgentDir(projectRoot, { events, trailingHalfLine = null } = {}) {
  const agentDir = path.join(projectRoot, ".wwriting", "agent");
  await fs.mkdir(path.join(agentDir, "checkpoints"), { recursive: true });
  let eventsRaw = events.join("\n") + "\n";
  if (trailingHalfLine !== null) eventsRaw += trailingHalfLine;
  await fs.writeFile(path.join(agentDir, "events.jsonl"), eventsRaw, "utf8");
  await fs.writeFile(path.join(agentDir, "session.json"), JSON.stringify({ schema_version: 1, session_id: "legacy-sess" }, null, 2) + "\n", "utf8");
  await fs.writeFile(
    path.join(agentDir, "transcript.jsonl"),
    `${JSON.stringify({ role: "user", content: "旧对话" })}\n`,
    "utf8"
  );
  await fs.writeFile(path.join(agentDir, "checkpoints", "cp-1.json"), JSON.stringify({ checkpoint_id: "cp-1" }) + "\n", "utf8");
  await fs.writeFile(
    path.join(agentDir, "migration.json"),
    `${JSON.stringify({ schema_version: 1, legacy_imported: true, project_agent_imported: false }, null, 2)}\n`,
    "utf8"
  );
  return agentDir;
}

function legacyEvent(seq, overrides = {}) {
  return JSON.stringify({
    schema_version: 1,
    seq,
    event_id: `evt-${seq}`,
    session_id: "legacy-sess",
    run_id: null,
    project_root: "D:\\legacy\\project",
    type: "session_created",
    at: new Date(Date.UTC(2026, 0, seq)).toISOString(),
    payload: {},
    ...overrides
  });
}

async function readDirBytes(dir) {
  const entries = {};
  async function walk(rel) {
    const target = path.join(dir, rel);
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(target)) await walk(path.join(rel, name));
    } else {
      entries[rel] = await fs.readFile(target);
    }
  }
  await walk("");
  return entries;
}

async function snapshotDir(dir) {
  if (!(await pathExists(dir))) return null;
  return readDirBytes(dir);
}

test("私有目录为空时复制白名单文件与 checkpoints，不复制旧 migration.json", async (t) => {
  const ws = await makeWorkspace(t);
  const projectRoot = path.join(ws, "project");
  const agentDir = await createLegacyAgentDir(projectRoot, {
    events: [
      legacyEvent(1),
      legacyEvent(2, { type: "input_queued", payload: { input_id: "i1", text: "你好" } })
    ]
  });
  const before = await snapshotDir(agentDir);
  const targetAgentRoot = path.join(ws, "user-data", "workspaces", "ws_test", "agent");

  const result = await migrateProjectAgentStorage({ projectRoot, targetAgentRoot });
  assert.deepEqual(result, { imported: true });

  // 白名单文件字节级一致
  for (const name of ["events.jsonl", "session.json", "transcript.jsonl"]) {
    assert.equal(
      await fs.readFile(path.join(targetAgentRoot, name), "utf8"),
      await fs.readFile(path.join(agentDir, name), "utf8"),
      `${name} 应与源字节一致`
    );
  }
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(targetAgentRoot, "checkpoints", "cp-1.json"), "utf8")),
    { checkpoint_id: "cp-1" },
    "checkpoints/ 应被复制"
  );
  assert.equal(
    await pathExists(path.join(targetAgentRoot, "migration.json")),
    false,
    "不得复制旧 migration.json 覆盖新的应用私有迁移状态"
  );
  // 原目录字节不变
  assert.deepEqual(await snapshotDir(agentDir), before, "原 .wwriting/agent 字节必须完全一致");
});

test("目标已有事件时拒绝覆盖（target_not_empty），目标与源均字节不变", async (t) => {
  const ws = await makeWorkspace(t);
  const projectRoot = path.join(ws, "project");
  const agentDir = await createLegacyAgentDir(projectRoot, {
    events: [legacyEvent(1), legacyEvent(2, { type: "input_queued", payload: { input_id: "i1", text: "旧" } })]
  });
  const sourceBefore = await snapshotDir(agentDir);
  const targetAgentRoot = path.join(ws, "user-data", "workspaces", "ws_test", "agent");
  await fs.mkdir(targetAgentRoot, { recursive: true });
  const existing = "已有目标事件\n";
  await fs.writeFile(path.join(targetAgentRoot, "events.jsonl"), existing, "utf8");

  const result = await migrateProjectAgentStorage({ projectRoot, targetAgentRoot });
  assert.deepEqual(result, { imported: false, reason: "target_not_empty" });
  assert.equal(await fs.readFile(path.join(targetAgentRoot, "events.jsonl"), "utf8"), existing, "目标不得被覆盖");
  assert.equal(await pathExists(path.join(targetAgentRoot, "session.json")), false, "其余文件也不得复制");
  assert.deepEqual(await snapshotDir(agentDir), sourceBefore, "原目录字节必须完全一致");
});

test("events.jsonl 中间损坏：拒绝导入且目标保持干净（允许新会话），源字节不变", async (t) => {
  const ws = await makeWorkspace(t);
  const projectRoot = path.join(ws, "project");
  const agentDir = await createLegacyAgentDir(projectRoot, {
    events: [
      legacyEvent(1),
      legacyEvent(2, { type: "input_queued", payload: { input_id: "i1", text: "一" } }),
      "{broken json line", // 中间损坏行
      legacyEvent(4, { type: "input_queued", payload: { input_id: "i2", text: "二" } })
    ]
  });
  const before = await snapshotDir(agentDir);
  const targetAgentRoot = path.join(ws, "user-data", "workspaces", "ws_test", "agent");

  const result = await migrateProjectAgentStorage({ projectRoot, targetAgentRoot });
  assert.deepEqual(result, { imported: false, reason: "invalid_source" });

  // 目标目录干净：没有任何半份复制产物 → 新会话可在私有目录从零创建
  const copied = (await pathExists(targetAgentRoot)) ? await fs.readdir(targetAgentRoot) : [];
  assert.deepEqual(copied, [], "拒绝导入后目标目录必须保持干净（无半份数据）");
  assert.deepEqual(await snapshotDir(agentDir), before, "原目录字节必须完全一致");
});

test("尾部半行截断（崩溃痕迹）容忍后导入，字节级一致复制", async (t) => {
  const ws = await makeWorkspace(t);
  const projectRoot = path.join(ws, "project");
  const agentDir = await createLegacyAgentDir(projectRoot, {
    events: [
      legacyEvent(1),
      legacyEvent(2, { type: "input_queued", payload: { input_id: "i1", text: "一" } })
    ],
    trailingHalfLine: '{"partial'
  });
  const before = await snapshotDir(agentDir);
  const targetAgentRoot = path.join(ws, "user-data", "workspaces", "ws_test", "agent");

  const result = await migrateProjectAgentStorage({ projectRoot, targetAgentRoot });
  assert.deepEqual(result, { imported: true });
  // 复制是字节级原样（含尾部半行）；截断修复由 journal.load() 负责（journal-recovery 已覆盖）
  assert.equal(
    await fs.readFile(path.join(targetAgentRoot, "events.jsonl"), "utf8"),
    await fs.readFile(path.join(agentDir, "events.jsonl"), "utf8"),
    "events.jsonl 必须字节级一致复制（含尾部半行）"
  );
  assert.deepEqual(await snapshotDir(agentDir), before, "原目录字节必须完全一致");
});

test("迁移只读：完整白名单复制前后源目录字节完全一致（含目录结构）", async (t) => {
  const ws = await makeWorkspace(t);
  const projectRoot = path.join(ws, "project");
  const agentDir = await createLegacyAgentDir(projectRoot, {
    events: [legacyEvent(1)]
  });
  const before = await snapshotDir(agentDir);
  const targetAgentRoot = path.join(ws, "user-data", "workspaces", "ws_test", "agent");
  await migrateProjectAgentStorage({ projectRoot, targetAgentRoot });
  await migrateProjectAgentStorage({ projectRoot, targetAgentRoot });
  assert.deepEqual(await snapshotDir(agentDir), before, "多次迁移后原目录字节必须完全一致");
});

test("第二次迁移幂等：目标已有数据时返回 target_not_empty，不重复、不覆盖", async (t) => {
  const ws = await makeWorkspace(t);
  const projectRoot = path.join(ws, "project");
  const agentDir = await createLegacyAgentDir(projectRoot, {
    events: [legacyEvent(1), legacyEvent(2, { type: "input_queued", payload: { input_id: "i1", text: "一" } })]
  });
  const targetAgentRoot = path.join(ws, "user-data", "workspaces", "ws_test", "agent");

  const first = await migrateProjectAgentStorage({ projectRoot, targetAgentRoot });
  assert.deepEqual(first, { imported: true });
  const eventsAfterFirst = await fs.readFile(path.join(targetAgentRoot, "events.jsonl"), "utf8");
  const filesAfterFirst = (await fs.readdir(targetAgentRoot)).sort();

  const second = await migrateProjectAgentStorage({ projectRoot, targetAgentRoot });
  assert.deepEqual(second, { imported: false, reason: "target_not_empty" });
  assert.equal(await fs.readFile(path.join(targetAgentRoot, "events.jsonl"), "utf8"), eventsAfterFirst, "第二次不得改写目标事件");
  assert.deepEqual((await fs.readdir(targetAgentRoot)).sort(), filesAfterFirst, "第二次不得新增任何文件");
});

test("源目录缺失时返回 missing 且不创建目标目录", async (t) => {
  const ws = await makeWorkspace(t);
  const projectRoot = path.join(ws, "plain-project");
  await fs.mkdir(projectRoot, { recursive: true });
  const targetAgentRoot = path.join(ws, "user-data", "workspaces", "ws_test", "agent");

  const result = await migrateProjectAgentStorage({ projectRoot, targetAgentRoot });
  assert.deepEqual(result, { imported: false, reason: "missing" });
  assert.equal(await pathExists(targetAgentRoot), false, "无源数据时不应创建目标目录");
});
