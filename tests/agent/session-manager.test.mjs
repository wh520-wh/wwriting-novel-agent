// session-manager 薄单测（第十五轮 F5c Task 9）——新建→重命名→归档→恢复→删除
// 一串走查；构造最小 state/registry stub，断言 registry 状态迁移。
//
// 构造说明：`宁真实勿 mock`——registry 用真实 createSessionRegistry（临时目录，
// 磁盘 index.json），sessionManager 的全部依赖（state/mutex/sessions Map/
// agentRoot）在测试内手造最小对象，ctx 只注入 ensureProject/resolveSessionState
// 两个 stub（生产里它们是 runtime 内部闭包，本就该由工厂注入）。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSessionRegistry } from "../../src/core/agent/session-registry.mjs";
import { createMutex } from "../../src/core/async-utils.mjs";
import {
  createSessionManager,
  deriveSessionTitle,
  hasNonTerminalRun
} from "../../src/core/agent/session-manager.mjs";

async function makeHarness(t, { resolveSessionState } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-manager-test-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const registry = createSessionRegistry({ root });
  const state = {
    registry,
    sessions: new Map(), // sessionId -> sessionState（最小 stub；删除守卫测例注入）
    mutex: createMutex(),
    agentRoot: path.join(root, "agent")
  };
  const manager = createSessionManager({
    ensureProject: () => state,
    resolveSessionState: resolveSessionState ?? (async () => null)
  });
  return { root, state, manager };
}

test("deriveSessionTitle：空回落「新对话」，折叠空白并截断 20 字符", () => {
  assert.equal(deriveSessionTitle(""), "新对话");
  assert.equal(deriveSessionTitle("   "), "新对话");
  assert.equal(deriveSessionTitle(null), "新对话");
  assert.equal(deriveSessionTitle("  写   第一章  "), "写 第一章");
  const long = deriveSessionTitle("这是一个非常长的消息摘要内容用来测试截断行为");
  assert.equal(long.length, 20, "截断到 20 字符");
  assert.ok(!long.includes("  "), "不含连续空白");
});

test("新建→重命名→归档→恢复→删除一串走查，registry 状态迁移正确", async (t) => {
  const { root, state, manager } = await makeHarness(t);

  // 新建：只写注册表条目
  const created = await manager.newSession({ projectRoot: "/p", title: "测试对话" });
  assert.equal(created.title, "测试对话");
  assert.equal(created.archived_at, null);

  // 列表 + run_status 投影（未物化会话恒 idle）
  const list1 = await manager.sessions({ projectRoot: "/p" });
  assert.equal(list1.sessions.length, 1);
  assert.equal(list1.sessions[0].session_id, created.session_id);
  assert.equal(list1.sessions[0].run_status, "idle");
  assert.equal(list1.active_session_id, created.session_id);

  // 重命名
  const renamed = await manager.renameSession({ projectRoot: "/p", sessionId: created.session_id, title: "改名后" });
  assert.equal(renamed.title, "改名后");

  // 归档：archived_at 非空
  const archived = await manager.archiveSession({ projectRoot: "/p", sessionId: created.session_id });
  assert.ok(archived.archived_at, "归档后 archived_at 非空");
  assert.equal((await state.registry.getLastActive()), null, "唯一会话归档后无最近活跃");

  // 恢复：archived_at 回 null
  const restored = await manager.restoreSession({ projectRoot: "/p", sessionId: created.session_id });
  assert.equal(restored.archived_at, null);

  // 删除：注册表条目消失 + 会话数据目录一并移除
  const dataDir = path.join(state.agentRoot, "sessions", created.session_id);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, "events.jsonl"), "x\n");
  const deleted = await manager.deleteSession({ projectRoot: "/p", sessionId: created.session_id });
  assert.deepEqual(deleted, { deleted: true, session_id: created.session_id });
  assert.equal((await state.registry.get(created.session_id)), null, "注册表条目已移除");
  assert.equal((await state.registry.list()).length, 0);
  await assert.rejects(fs.access(dataDir), "会话数据目录已删除");
});

test("syncSessionRegistry：touch 刷新 updated_at，失败不抛错", async (t) => {
  const { state, manager } = await makeHarness(t);
  const meta = await state.registry.create({ title: "s" });
  const sessionState = { sessionId: meta.session_id };
  await manager.syncSessionRegistry(state, sessionState);
  const after = await state.registry.get(meta.session_id);
  assert.ok(after.updated_at >= meta.updated_at, "touch 刷新 updated_at");
  // 未知会话：幂等不抛错（尽力而为）
  await manager.syncSessionRegistry(state, { sessionId: "ghost" });
});

test("autoNameSessionIfDefault：只改默认标题；已改名与不存在的会话不动", async (t) => {
  const { state, manager } = await makeHarness(t);
  const def = await state.registry.create({ title: "新对话" });
  await manager.autoNameSessionIfDefault(state, def.session_id, "  你好   世界 ");
  assert.equal((await state.registry.get(def.session_id)).title, "你好 世界", "默认标题按摘要命名");

  // 已改名（非「新对话」）的会话绝不动
  const custom = await state.registry.create({ title: "用户命名" });
  await manager.autoNameSessionIfDefault(state, custom.session_id, "不应覆盖");
  assert.equal((await state.registry.get(custom.session_id)).title, "用户命名");

  // 不存在的会话：不吃不抛
  await manager.autoNameSessionIfDefault(state, "ghost", "无所谓");
});

test("deleteSession 守卫：非终态 run 拒绝删除（session_busy）", async (t) => {
  const { root, state, manager } = await makeHarness(t);
  const meta = await state.registry.create({ title: "运行中" });
  state.sessions.set(meta.session_id, {
    journal: { getSession: async () => ({ active_run: { id: "r1", status: "running" } }) }
  });
  await assert.rejects(
    manager.deleteSession({ projectRoot: "/p", sessionId: meta.session_id }),
    (err) => err.code === "session_busy",
    "运行中会话删除被拒"
  );
  assert.ok(await state.registry.get(meta.session_id), "注册表条目保留");

  // 终态 run（completed）可删
  state.sessions.set(meta.session_id, {
    journal: { getSession: async () => ({ active_run: { id: "r1", status: "completed" } }) }
  });
  const result = await manager.deleteSession({ projectRoot: "/p", sessionId: meta.session_id });
  assert.equal(result.deleted, true);
});

test("requireSessionId 校验：空 sessionId 抛 invalid_session_id", async (t) => {
  const { manager } = await makeHarness(t);
  await assert.rejects(manager.renameSession({ projectRoot: "/p", sessionId: "", title: "x" }),
    (err) => err.code === "invalid_session_id");
});

test("appendSystemEvent：resolved null（无会话）时返回 { seq: null } 不抛错", async (t) => {
  const { manager } = await makeHarness(t);
  assert.deepEqual(
    await manager.appendSystemEvent({ projectRoot: "/p", type: "ui_restore", payload: { n: 1 } }),
    { seq: null }
  );
});

test("appendSystemEvent：有会话时 load 后追加系统事件（run_id=null，payload 兜底 {}）", async (t) => {
  const calls = [];
  const { manager } = await makeHarness(t, {
    resolveSessionState: async () => ({
      journal: {
        load: async () => { calls.push(["load"]); },
        append: async (event) => { calls.push(["append", event]); }
      }
    })
  });
  const result = await manager.appendSystemEvent({ projectRoot: "/p", type: "ui_restore", payload: { n: 2 } });
  assert.deepEqual(result, { seq: null });
  assert.deepEqual(calls, [
    ["load"],
    ["append", { type: "ui_restore", run_id: null, payload: { n: 2 } }]
  ]);
  // payload 缺省兜底空对象
  await manager.appendSystemEvent({ projectRoot: "/p", type: "ui_restore" });
  assert.deepEqual(calls, [
    ["load"],
    ["append", { type: "ui_restore", run_id: null, payload: { n: 2 } }],
    ["load"],
    ["append", { type: "ui_restore", run_id: null, payload: {} }]
  ]);
});

test("hasNonTerminalRun：与 TERMINAL_RUN_STATUSES 同口径（终态补集）", () => {
  assert.equal(hasNonTerminalRun(null), false);
  assert.equal(hasNonTerminalRun({}), false);
  assert.equal(hasNonTerminalRun({ active_run: { status: "running" } }), true);
  assert.equal(hasNonTerminalRun({ active_run: { status: "waiting_user" } }), true);
  assert.equal(hasNonTerminalRun({ active_run: { status: "completed" } }), false);
  assert.equal(hasNonTerminalRun({ active_run: { status: "cancelled" } }), false);
});
