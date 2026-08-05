import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runChatTurn } from "../src/core/chat/chat-agent.mjs";
import { loadPendingAction, readChatHistory } from "../src/core/chat/chat-store.mjs";
import { createToolRegistry } from "../src/core/chat/tool-registry.mjs";
import { registerReadTools } from "../src/core/chat/tools-read.mjs";
import { createProjectAt, loadProject, loadState, saveState } from "../src/core/project-store.mjs";

function makeProjectRoot() {
  return mkdtempSync(join(tmpdir(), "bp-test-"));
}

function scriptedClient(script) {
  let i = 0;
  return { generate: async () => ({ text: script[Math.min(i++, script.length - 1)], usageReport: {}, costSummary: { estimatedCost: 0 } }) };
}

function makeChatGuardFixture() {
  const projectRoot = makeProjectRoot();
  const registry = createToolRegistry();
  registerReadTools(registry);
  let fakeWriteExecuted = false;
  registry.register({
    name: "fake_write", kind: "write", description: "测试写工具", params: {},
    run: async () => { fakeWriteExecuted = true; return { done: true }; }
  });
  return { projectRoot, registry, fakeWriteExecuted: () => fakeWriteExecuted };
}

test("新建项目默认 blueprint_status none", async () => {
  const projectRoot = makeProjectRoot();
  await createProjectAt(projectRoot, { title: "T" });
  const state = await loadState(projectRoot);
  assert.equal(state.blueprint_status, "none");
});

test("blueprint_status 状态可正常读取", async () => {
  const projectRoot = makeProjectRoot();
  await createProjectAt(projectRoot, { title: "T" });
  const state = await loadState(projectRoot);
  for (const blueprint_status of ["partial", "complete", "legacy"]) {
    await saveState(projectRoot, { ...state, blueprint_status });
    assert.equal((await loadState(projectRoot)).blueprint_status, blueprint_status);
  }
});

test("blueprint_status none 不阻止 chat 写工具", async () => {
  const { projectRoot, registry, fakeWriteExecuted } = makeChatGuardFixture();
  await createProjectAt(projectRoot, { title: "T" });
  const project = await loadProject(projectRoot);
  await runChatTurn({
    projectRoot,
    project,
    registry,
    modelClient: scriptedClient([
      '```json\n{"tool_calls":[{"tool":"fake_write","args":{}}]}\n```',
      "已完成。"
    ]),
    userMessage: "改一下"
  });
  assert.equal(fakeWriteExecuted(), false, "普通模式应等待确认而不是被蓝图拒绝");
  const pending = await loadPendingAction(projectRoot);
  assert.equal(pending.tool, "fake_write");
  assert.notEqual(pending.error, "blueprint_not_ready");
  const history = await readChatHistory(projectRoot);
  assert.equal(history.some((m) => m.role === "tool" && m.tool === "fake_write"), false);
});

test("blueprint_status none 仍可创建恢复任务", async () => {
  const projectRoot = makeProjectRoot();
  await createProjectAt(projectRoot, { title: "T" });
  const { TaskQueue } = await import("../src/core/task-queue.mjs");
  const queue = new TaskQueue(projectRoot);
  const task = await queue.createRecoveryTask({ instruction: "继续第 1 章" });
  assert.equal(task.instruction, "继续第 1 章");
});
