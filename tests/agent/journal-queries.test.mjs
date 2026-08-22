// 项目级 Agent journal 投影查询测试（内核分区重构 Task 3，F2）。
//
// 从 runtime.mjs 收敛进 createAgentJournal 工厂的四条投影查询方法的黑盒验证：
//   - findInputMeta：从事件找回 input_queued 的 text 与 kind（最近 100k 条上限）
//   - hasTerminalEvent：逆序扫描判定输入是否已有终态事件（needsCompletionTerminal 迁入）
//   - findTerminalInputId：找回可恢复 Run 的未终结输入（终态 input 与 open input 兜底）
//   - isIdleInitiatedRun：以 Run 首个 input_started 判定空闲发起（legacy run_started 兜底）
//
// 构造模式对齐 tests/agent/journal-recovery.test.mjs：mkdtemp + load()。
// 事件链约束以 reducer 为准：空 journal 的 load() 自建首会话（createFirstSession），
// run_started 先于 input_started（requireActiveRun，journal.mjs:343-352）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentJournal } from "../../src/core/agent/journal.mjs";

async function makeWorkspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-journal-queries-"));
  t.after(async () => await fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("findInputMeta 返回 input_queued 的 text 与 kind", async (t) => {
  const projectRoot = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot });
  await journal.load();
  await journal.append({ type: "input_queued", run_id: null,
    payload: { input_id: "in-1", text: "写第一章", kind: null } });
  await journal.append({ type: "input_queued", run_id: null,
    payload: { input_id: "in-2", text: "/compact", kind: "compact" } });
  assert.deepEqual(await journal.findInputMeta("in-1"), { text: "写第一章", kind: null });
  assert.deepEqual(await journal.findInputMeta("in-2"), { text: "/compact", kind: "compact" });
  assert.deepEqual(await journal.findInputMeta("nope"), { text: null, kind: null });
});

test("hasTerminalEvent 与 findTerminalInputId 的终态判定", async (t) => {
  const projectRoot = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot });
  await journal.load();
  await journal.append({ type: "input_queued", run_id: null,
    payload: { input_id: "in-1", text: "hi", kind: null } });
  await journal.append({ type: "run_started", run_id: "r-1",
    payload: { input_id: "in-1" } });
  assert.equal(await journal.hasTerminalEvent("r-1", "in-1"), true);
  assert.equal(await journal.findTerminalInputId("r-1"), "in-1");
  await journal.append({ type: "input_completed", run_id: "r-1",
    payload: { input_id: "in-1" } });
  assert.equal(await journal.hasTerminalEvent("r-1", "in-1"), false);
});

test("isIdleInitiatedRun 以 run 首个 input_started 判定", async (t) => {
  const projectRoot = await makeWorkspace(t);
  const journal = createAgentJournal({ projectRoot });
  await journal.load();
  await journal.append({ type: "input_queued", run_id: null,
    payload: { input_id: "in-c", text: "/compact", kind: "compact" } });
  await journal.append({ type: "run_started", run_id: "r-9", payload: {} });
  await journal.append({ type: "input_started", run_id: "r-9",
    payload: { input_id: "in-c" } });
  assert.equal(await journal.isIdleInitiatedRun("r-9", "in-c"), true);
  assert.equal(await journal.isIdleInitiatedRun("r-9", "in-x"), false);
});
