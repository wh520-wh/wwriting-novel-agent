// 旧项目确定性资料迁移测试（计划 Task 11；Task 13 起不再覆盖聊天迁移）。
//
// 覆盖保留的确定性项目资料/技能迁移契约（SPEC §9.1）：
//   - 旧 project.yaml → WWRITING.md + 私有 settings 的一次性只读迁移；
//   - 迁移失败/无源不抛错、幂等、标记 legacy_project_imported 最后写入；
//   - Task 13 负向断言：迁移不读取/不复制/不迁移任何聊天内容（旧 .wwriting/agent
//     的 events/transcript 字节不变，旧文本不进入 WWRITING.md 与私有设置）。
//
// 本文件位于 tests/ 根目录（非 tests/agent/），按依赖规则不得 import agent 内部
// 文件；"聊天内容不导入"的 agent 级断言（open/submit/snapshot/exportHistory/模型
// 请求）由 tests/agent/project-agent.test.mjs 与 tests/acceptance/ 承载。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkspaceStore } from "../../src/core/workspaces/store.mjs";
import { serializeSimpleYaml } from "../../src/core/simple-yaml.mjs";
import {
  discoverLegacyAuthorityFiles,
  legacyProjectFacts,
  legacySettingsImport,
  migrateLegacyProject,
  positiveFact,
  stringOrEmpty
} from "../../src/core/workspaces/migration.mjs";

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

// Task 13 负向断言：保留的确定性项目资料迁移只读 project.yaml 元数据，绝不导入
// 聊天内容——旧 .wwriting/agent 的对话文本不得进入 WWRITING.md/私有设置，旧聊天
// 文件保持字节不变（agent 级 open/submit/snapshot/导出/模型请求断言见
// tests/agent/project-agent.test.mjs 与 tests/acceptance/）。
test("不导入断言：确定性项目资料迁移不把旧聊天内容带入 WWRITING.md/设置", async (t) => {
  const ws = await makeWorkspace(t);
  const projectRoot = path.join(ws, "project");
  await createLegacyProject(projectRoot);
  const workspaceStore = createWorkspaceStore({ stateRoot: path.join(ws, "user-data") });

  const result = await migrateLegacyProject({ projectRoot, workspaceStore });
  assert.equal(result.imported, true);

  const memory = await fs.readFile(path.join(projectRoot, "WWRITING.md"), "utf8");
  assert.ok(!memory.includes("旧对话"), "聊天内容不得进入 WWRITING.md");
  assert.equal(JSON.stringify(await workspaceStore.loadSettings(projectRoot)).includes("旧对话"), false, "聊天内容不得进入私有设置");
  // 旧聊天源保持字节不变（不删除/不重命名/不复制；事件流与 transcript 均原样）
  const legacyEvents = await fs.readFile(path.join(projectRoot, ".wwriting", "agent", "events.jsonl"), "utf8");
  assert.ok(legacyEvents.includes("旧对话"), "夹具的旧聊天数据应仍在源文件（未被消费/改写）");
  const legacyTranscript = await fs.readFile(path.join(projectRoot, ".wwriting", "agent", "transcript.jsonl"), "utf8");
  assert.ok(legacyTranscript.includes("旧对话"), "旧 transcript 应仍在源文件");
  const after = await snapshotLegacyProject(projectRoot);
  assert.ok(after["project.yaml"].length > 0 && after[path.join(".wwriting", "agent", "events.jsonl")].length > 0, "源快照仍完整");
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
