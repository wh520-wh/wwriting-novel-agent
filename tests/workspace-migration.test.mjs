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
import { createWorkspaceStore } from "../src/core/workspaces/store.mjs";
import { serializeSimpleYaml } from "../src/core/simple-yaml.mjs";
import {
  discoverLegacyAuthorityFiles,
  legacyProjectFacts,
  legacySettingsImport,
  migrateLegacyProject,
  migrateProjectAgentStorage,
  positiveFact,
  stringOrEmpty
} from "../src/core/workspaces/migration.mjs";

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
    `${JSON.stringify({ schema_version: 1, legacy_imported: true }, null, 2)}\n`,
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

// 计划修复（整支审阅）：复制中途失败（session.json 是目录 → copyFile 抛错）时，
// staging 事务化 + 回滚必须让目标回到空状态，修复源后可重试成功。
test("复制中途失败：拒绝导入、目标无半份产物（无 events.jsonl / .staging-*），修复后重试成功", async (t) => {
  const ws = await makeWorkspace(t);
  const projectRoot = path.join(ws, "project");
  const agentDir = await createLegacyAgentDir(projectRoot, {
    events: [legacyEvent(1), legacyEvent(2, { type: "input_queued", payload: { input_id: "i1", text: "旧" } })]
  });
  // 损坏源：session.json 换成同名目录（LEGACY_COPY_FILES 顺序为 events.jsonl → session.json，
  // events.jsonl 已复制进 staging 之后复制失败——确定性注入复制中途失败）
  await fs.rm(path.join(agentDir, "session.json"));
  await fs.mkdir(path.join(agentDir, "session.json"));
  const before = await snapshotDir(agentDir);
  const targetAgentRoot = path.join(ws, "user-data", "workspaces", "ws_test", "agent");

  const result = await migrateProjectAgentStorage({ projectRoot, targetAgentRoot });
  assert.deepEqual(result, { imported: false, reason: "invalid_source" });

  // 事务化回滚：目标回到空状态，无半份 events.jsonl、无 .staging-* 残留
  const leftover = (await pathExists(targetAgentRoot)) ? await fs.readdir(targetAgentRoot) : [];
  assert.deepEqual(leftover, [], "复制失败后目标目录必须干净（回滚 events.jsonl 且无 .staging-*）");
  assert.deepEqual(await snapshotDir(agentDir), before, "原目录字节必须完全一致");

  // 修复源（session.json 恢复为合法文件）后重试成功，源仍只读
  await fs.rm(path.join(agentDir, "session.json"), { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "session.json"),
    JSON.stringify({ schema_version: 1, session_id: "legacy-sess" }, null, 2) + "\n",
    "utf8"
  );
  const repaired = await snapshotDir(agentDir);
  const retry = await migrateProjectAgentStorage({ projectRoot, targetAgentRoot });
  assert.deepEqual(retry, { imported: true });
  assert.equal(await pathExists(path.join(targetAgentRoot, "events.jsonl")), true, "重试应完成迁移");
  assert.equal(
    await fs.readFile(path.join(targetAgentRoot, "events.jsonl"), "utf8"),
    await fs.readFile(path.join(agentDir, "events.jsonl"), "utf8"),
    "重试复制应字节级一致"
  );
  assert.deepEqual(await snapshotDir(agentDir), repaired, "重试后源目录字节必须完全一致");
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

// ---------------------------------------------------------------------------
// 新分段格式迁移（计划 Task 4 Step 2 case 5 / Step 7）
// ---------------------------------------------------------------------------

// 新格式 journal 夹具：segments/ + journal-manifest.json + session.json +
// active-context.json + checkpoints/，不存在单体 events.jsonl/transcript.jsonl。
async function createNewFormatAgentDir(projectRoot) {
  const agentDir = path.join(projectRoot, ".wwriting", "agent");
  await fs.mkdir(path.join(agentDir, "segments", "events"), { recursive: true });
  await fs.mkdir(path.join(agentDir, "segments", "transcript"), { recursive: true });
  await fs.mkdir(path.join(agentDir, "checkpoints"), { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "journal-manifest.json"),
    JSON.stringify({
      schema_version: 1,
      generation_id: "gen-new-1",
      events_root: "segments/events",
      transcript_root: "segments/transcript",
      last_event_seq: 2,
      last_transcript_seq: 1,
      gaps: []
    }, null, 2) + "\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(agentDir, "segments", "events", "00000001.jsonl"),
    `${JSON.stringify({ schema_version: 2, seq: 1, event_id: "evt-1", session_id: "new-sess", run_id: null, project_root: projectRoot, type: "session_created", at: "2026-08-01T00:00:00.000Z", payload: {} })}\n`,
    "utf8"
  );
  await fs.writeFile(
    path.join(agentDir, "segments", "transcript", "00000001.jsonl"),
    `${JSON.stringify({ transcript_seq: 1, role: "user", content: "新格式对话" })}\n`,
    "utf8"
  );
  await fs.writeFile(
    path.join(agentDir, "session.json"),
    JSON.stringify({ schema_version: 1, session_id: "new-sess", last_seq: 2, status: "idle" }, null, 2) + "\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(agentDir, "active-context.json"),
    JSON.stringify({ schema_version: 1, context_id: "ctx-1" }, null, 2) + "\n",
    "utf8"
  );
  await fs.writeFile(path.join(agentDir, "checkpoints", "cp-1.json"), JSON.stringify({ checkpoint_id: "cp-1" }) + "\n", "utf8");
  return agentDir;
}

test("源已是新分段格式：复制 segments/、journal-manifest.json、session.json、active-context.json 与 checkpoints/，不复制单体 events.jsonl", async (t) => {
  const ws = await makeWorkspace(t);
  const projectRoot = path.join(ws, "project");
  const agentDir = await createNewFormatAgentDir(projectRoot);
  const before = await snapshotDir(agentDir);
  const targetAgentRoot = path.join(ws, "user-data", "workspaces", "ws_test", "agent");

  const result = await migrateProjectAgentStorage({ projectRoot, targetAgentRoot });
  assert.deepEqual(result, { imported: true });

  // 新格式白名单逐字节一致复制
  for (const rel of [
    "journal-manifest.json",
    "session.json",
    "active-context.json",
    "segments/events/00000001.jsonl",
    "segments/transcript/00000001.jsonl",
    "checkpoints/cp-1.json"
  ]) {
    assert.equal(
      await fs.readFile(path.join(targetAgentRoot, rel), "utf8"),
      await fs.readFile(path.join(agentDir, rel), "utf8"),
      `${rel} 应与源字节一致`
    );
  }
  // 新格式源不复制单体 events.jsonl/transcript.jsonl（journal 在目标端直接读 segments）
  assert.equal(await pathExists(path.join(targetAgentRoot, "events.jsonl")), false);
  assert.equal(await pathExists(path.join(targetAgentRoot, "transcript.jsonl")), false);
  // 原目录字节不变（源只读）
  assert.deepEqual(await snapshotDir(agentDir), before, "原 .wwriting/agent 字节必须完全一致");
});

test("回归：新格式目标无 events.jsonl 时第二次 open 仍返回 target_not_empty，不会复制旧源", async (t) => {
  const ws = await makeWorkspace(t);
  const projectRoot = path.join(ws, "project");
  const agentDir = await createNewFormatAgentDir(projectRoot);
  const before = await snapshotDir(agentDir);
  const targetAgentRoot = path.join(ws, "user-data", "workspaces", "ws_test", "agent");

  const first = await migrateProjectAgentStorage({ projectRoot, targetAgentRoot });
  assert.deepEqual(first, { imported: true });
  assert.equal(await pathExists(path.join(targetAgentRoot, "events.jsonl")), false, "新格式目标不含单体 events.jsonl");

  // 第二次 open：目标已有新格式数据（manifest + segments）→ target_not_empty
  const second = await migrateProjectAgentStorage({ projectRoot, targetAgentRoot });
  assert.deepEqual(second, { imported: false, reason: "target_not_empty" });
  assert.deepEqual(await snapshotDir(agentDir), before, "原目录字节必须完全一致");
});

// ---------------------------------------------------------------------------
// 旧 project.yaml 一次性只读迁移（计划 Task 11）
// ---------------------------------------------------------------------------

// 旧项目夹具：project.yaml（含标题/题材/章节字数目标/输出格式/模型/权限）+
// 旧 .wwriting/agent（events/session/transcript/checkpoints/migration.json）+
// 权威文件 OUTLINE.md/SETTING.md/chapters/。
async function createLegacyProject(projectRoot, { project = {} } = {}) {
  await fs.mkdir(projectRoot, { recursive: true });
  const legacy = {
    schema_version: 1,
    project_id: "legacy-1",
    title: "雨夜追凶",
    story_seed: "刑警在雨夜追查一桩二十年前的旧案。",
    root_path: projectRoot,
    output_format: "md",
    target_chapters: 60,
    min_words_per_chapter: 2800,
    target_words_per_chapter: 3000,
    run_mode: "auto",
    default_writer_model: "mock-writer",
    active_model: {
      provider: "openai-compatible",
      model_name: "deepseek-chat",
      base_url: "https://api.deepseek.com",
      api_key_env: "DEEPSEEK_API_KEY"
    },
    blueprint_status: "complete",
    tool_permissions: {
      network_allowed: true,
      safe_edit: true,
      read_only: false,
      auto_edit: true,
      yolo: true,
      dangerous: false
    },
    ...project
  };
  await fs.writeFile(path.join(projectRoot, "project.yaml"), serializeSimpleYaml(legacy), "utf8");
  await createLegacyAgentDir(projectRoot, {
    events: [legacyEvent(1), legacyEvent(2, { type: "input_queued", payload: { input_id: "i1", text: "旧对话" } })]
  });
  await fs.writeFile(path.join(projectRoot, "OUTLINE.md"), "# OUTLINE.md\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "SETTING.md"), "# SETTING.md\n", "utf8");
  await fs.mkdir(path.join(projectRoot, "chapters"), { recursive: true });
  return projectRoot;
}

// 旧项目只读快照：project.yaml + .wwriting/agent 逐字节（不含新建的 WWRITING.md）。
async function snapshotLegacyProject(projectRoot) {
  const entries = {};
  async function walk(rel) {
    const target = path.join(projectRoot, rel);
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(target)) await walk(path.join(rel, name));
    } else {
      entries[rel] = await fs.readFile(target);
    }
  }
  for (const rel of ["project.yaml", path.join(".wwriting", "agent")]) {
    if (await pathExists(path.join(projectRoot, rel))) await walk(rel);
  }
  return entries;
}

test("旧 project.yaml 只读导入私有设置和 WWRITING.md", async (t) => {
  const ws = await makeWorkspace(t);
  const projectRoot = path.join(ws, "project");
  await createLegacyProject(projectRoot);
  const workspaceStore = createWorkspaceStore({ stateRoot: path.join(ws, "user-data") });
  const before = await snapshotLegacyProject(projectRoot);
  const result = await migrateLegacyProject({ projectRoot, workspaceStore });
  assert.equal(result.imported, true);
  assert.match(await fs.readFile(path.join(projectRoot, "WWRITING.md"), "utf8"), /单章目标约 3000 字/u);
  const settings = await workspaceStore.loadSettings(projectRoot);
  assert.equal(settings.legacy_project_imported, true);
  // Task 5 裁决：导入的设置必须携带旧值而非安全默认（旧 network_allowed/yolo 不得
  // 被私有 settings 的 4-bool 归一化默认遮蔽）。
  assert.equal(settings.active_model?.model_name, "deepseek-chat");
  assert.equal(settings.tool_permissions.network_allowed, true);
  assert.equal(settings.tool_permissions.auto_edit, true);
  assert.equal(settings.tool_permissions.yolo, true);
  assert.equal(settings.tool_permissions.read_only, false);
  assert.deepEqual(await snapshotLegacyProject(projectRoot), before, "原 project.yaml 与 .wwriting/agent 字节必须完全不变");
});

test("已有 WWRITING.md 不被覆盖：只补充缺失且不冲突的权威文件索引", async (t) => {
  const ws = await makeWorkspace(t);
  const projectRoot = path.join(ws, "project");
  await createLegacyProject(projectRoot);
  const workspaceStore = createWorkspaceStore({ stateRoot: path.join(ws, "user-data") });
  const userMemory = `---
schema_version: 1
---

# WWriting 项目记忆

## 项目定位

- 项目：用户自定义书名

## 当前有效要求

- 每章 5000 字。

## 权威文件

- 总纲：docs/我的总纲.md
- 世界观：设定/世界观.md

## 当前进度

- 已完成：第 1-10 章

用户自由文本，不得重排或改写。
`;
  await fs.writeFile(path.join(projectRoot, "WWRITING.md"), userMemory, "utf8");
  const before = await snapshotLegacyProject(projectRoot);

  const result = await migrateLegacyProject({ projectRoot, workspaceStore });
  assert.equal(result.imported, true);
  const after = await fs.readFile(path.join(projectRoot, "WWRITING.md"), "utf8");
  // 用户内容原样保留：自由文本、标题、字数要求、已有索引
  assert.ok(after.includes("用户自由文本，不得重排或改写。"));
  assert.ok(after.includes("- 项目：用户自定义书名"));
  assert.ok(after.includes("- 每章 5000 字。"));
  assert.ok(after.includes("- 总纲：docs/我的总纲.md"));
  assert.ok(after.includes("- 世界观：设定/世界观.md"));
  // 冲突：用户已把「总纲」标签指向其他文件 → 不追加旧 OUTLINE.md 行
  assert.ok(!after.includes("- 总纲：OUTLINE.md"));
  // 缺失且不冲突的权威文件索引被补充进稳定小节
  assert.ok(after.includes("- 设定：SETTING.md"));
  assert.ok(after.includes("- 章节：chapters/"));
  // 旧字段不覆盖用户最新要求
  assert.ok(!after.includes("单章目标约 3000 字。"));
  assert.ok(!after.includes("雨夜追凶"));
  assert.deepEqual(await snapshotLegacyProject(projectRoot), before, "原 project.yaml 与 .wwriting/agent 字节必须完全不变");
});

test("没有 WWRITING.md 时创建，只写可证事实（不写 blueprint_status/运行态）", async (t) => {
  const ws = await makeWorkspace(t);
  const projectRoot = path.join(ws, "project");
  await createLegacyProject(projectRoot);
  const workspaceStore = createWorkspaceStore({ stateRoot: path.join(ws, "user-data") });

  const result = await migrateLegacyProject({ projectRoot, workspaceStore });
  assert.equal(result.imported, true);
  const memory = await fs.readFile(path.join(projectRoot, "WWRITING.md"), "utf8");
  // 可证事实：标题、题材、章节/字数目标、输出格式、实际存在的权威文件索引
  assert.ok(memory.includes("- 项目：雨夜追凶"));
  assert.ok(memory.includes("- 题材：刑警在雨夜追查一桩二十年前的旧案。"));
  assert.ok(memory.includes("- 计划约 60 章。"));
  assert.ok(memory.includes("- 单章最低参考约 2800 字。"));
  assert.ok(memory.includes("- 单章目标约 3000 字。"));
  assert.ok(memory.includes("- 正文格式：md。"));
  assert.ok(memory.includes("- 总纲：OUTLINE.md"));
  assert.ok(memory.includes("- 设定：SETTING.md"));
  assert.ok(memory.includes("- 章节：chapters/"));
  // 不可证/派生状态不写长期记忆；AGENTS.md/正文 不存在 → 不推测
  assert.ok(!memory.includes("blueprint_status"));
  assert.ok(!memory.includes("run_mode"));
  assert.ok(!memory.includes("stage_overrides"));
  assert.ok(!memory.includes("default_writer_model"));
  assert.ok(!memory.includes("AGENTS.md"));
  assert.ok(!memory.includes("- 正文：正文/"));
});

test("project.yaml 损坏（同名目录）：迁移失败、无半份写入、标记保持 false", async (t) => {
  const ws = await makeWorkspace(t);
  const projectRoot = path.join(ws, "project");
  await createLegacyAgentDir(projectRoot, { events: [legacyEvent(1)] });
  await fs.mkdir(path.join(projectRoot, "project.yaml")); // 损坏：readFile 抛 EISDIR
  const workspaceStore = createWorkspaceStore({ stateRoot: path.join(ws, "user-data") });
  const before = await snapshotLegacyProject(projectRoot);

  const result = await migrateLegacyProject({ projectRoot, workspaceStore });
  assert.equal(result.imported, false);
  assert.ok(["invalid_source", "missing"].includes(result.reason));
  assert.equal(await pathExists(path.join(projectRoot, "WWRITING.md")), false, "损坏时不写 WWRITING.md");
  assert.equal((await workspaceStore.loadSettings(projectRoot)).legacy_project_imported, false, "失败时标记保持 false，下次打开重试");
  assert.deepEqual(await snapshotLegacyProject(projectRoot), before, "原文件字节必须完全不变");
});

test("第二次迁移幂等：已导入标记跳过重写，记忆内容与源字节不变", async (t) => {
  const ws = await makeWorkspace(t);
  const projectRoot = path.join(ws, "project");
  await createLegacyProject(projectRoot);
  const workspaceStore = createWorkspaceStore({ stateRoot: path.join(ws, "user-data") });

  const first = await migrateLegacyProject({ projectRoot, workspaceStore });
  assert.equal(first.imported, true);
  const memoryAfterFirst = await fs.readFile(path.join(projectRoot, "WWRITING.md"), "utf8");
  const settingsAfterFirst = JSON.stringify(await workspaceStore.loadSettings(projectRoot));
  const legacyAfterFirst = await snapshotLegacyProject(projectRoot);

  const second = await migrateLegacyProject({ projectRoot, workspaceStore });
  assert.equal(second.imported, true);
  assert.equal(second.reason, "already_imported");
  assert.equal(await fs.readFile(path.join(projectRoot, "WWRITING.md"), "utf8"), memoryAfterFirst, "第二次不得重复写入记忆");
  assert.equal(JSON.stringify(await workspaceStore.loadSettings(projectRoot)), settingsAfterFirst, "第二次不得改写设置");
  assert.deepEqual(await snapshotLegacyProject(projectRoot), legacyAfterFirst, "原 project.yaml 与 .wwriting/agent 字节必须完全不变");
});

test("无 project.yaml 的普通目录：返回 missing，不创建任何文件", async (t) => {
  const ws = await makeWorkspace(t);
  const projectRoot = path.join(ws, "plain");
  await fs.mkdir(projectRoot, { recursive: true });
  const workspaceStore = createWorkspaceStore({ stateRoot: path.join(ws, "user-data") });

  const result = await migrateLegacyProject({ projectRoot, workspaceStore });
  assert.equal(result.imported, false);
  assert.equal(result.reason, "missing");
  assert.equal(await pathExists(path.join(projectRoot, "WWRITING.md")), false);
  assert.equal((await workspaceStore.loadSettings(projectRoot)).legacy_project_imported, false);
});

test("字段映射 helper：stringOrEmpty/positiveFact/discoverLegacyAuthorityFiles", async (t) => {
  assert.equal(stringOrEmpty("标题"), "标题");
  assert.equal(stringOrEmpty("   "), "");
  assert.equal(stringOrEmpty(42), "");
  assert.equal(stringOrEmpty(null), "");
  assert.equal(stringOrEmpty(undefined), "");
  assert.equal(positiveFact(60, (v) => `计划约 ${v} 章。`), "计划约 60 章。");
  assert.equal(positiveFact(0, (v) => `计划约 ${v} 章。`), "");
  assert.equal(positiveFact(-3, (v) => `计划约 ${v} 章。`), "");
  assert.equal(positiveFact(3.5, (v) => `计划约 ${v} 章。`), "");
  assert.equal(positiveFact("60", (v) => `计划约 ${v} 章。`), "");

  const ws = await makeWorkspace(t);
  const root = path.join(ws, "proj");
  await fs.mkdir(path.join(root, "chapters"), { recursive: true });
  await fs.writeFile(path.join(root, "OUTLINE.md"), "# O\n", "utf8");
  await fs.writeFile(path.join(root, "正文"), "x", "utf8");
  const files = await discoverLegacyAuthorityFiles(root);
  assert.deepEqual(files, { 总纲: "OUTLINE.md", 章节: "chapters/", 正文: "正文/" }, "只返回实际存在项，不推测文件名");
});

test("legacyProjectFacts 只映射确定字段，legacySettingsImport 只映射 4-bool 等价字段", async (t) => {
  const project = {
    title: "雨夜追凶",
    story_seed: "刑警追查旧案。",
    target_chapters: 60,
    min_words_per_chapter: 2800,
    target_words_per_chapter: 3000,
    output_format: "md",
    blueprint_status: "complete",
    run_mode: "auto",
    active_model: { provider: "openai-compatible", model_name: "deepseek-chat" },
    tool_permissions: { network_allowed: true, safe_edit: true, read_only: false, auto_edit: true, yolo: true, dangerous: false }
  };
  const ws = await makeWorkspace(t);
  const facts = await legacyProjectFacts(project, ws);
  assert.deepEqual(facts, {
    title: "雨夜追凶",
    projectPositioning: "刑警追查旧案。",
    requirements: [
      "计划约 60 章。",
      "单章最低参考约 2800 字。",
      "单章目标约 3000 字。",
      "正文格式：md。"
    ],
    files: {}
  });
  const patch = legacySettingsImport(project);
  assert.deepEqual(patch, {
    active_model: { provider: "openai-compatible", model_name: "deepseek-chat" },
    tool_permissions: { auto_edit: true, network_allowed: true, yolo: true }
  }, "safe_edit/dangerous 无 4-bool 等价字段，不得发明映射；read_only 为 false 不覆盖默认");
  assert.deepEqual(legacySettingsImport({ title: "仅标题", tool_permissions: { safe_edit: true } }), {});
  assert.deepEqual(legacySettingsImport({ active_model: "not-an-object" }), {});
});
