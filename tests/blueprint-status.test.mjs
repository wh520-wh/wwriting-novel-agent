import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runProject } from "../src/core/agent-engine.mjs";
import { runChatTurn, resumeChatTurn } from "../src/core/chat/chat-agent.mjs";
import { loadPendingAction, readChatHistory, savePendingAction } from "../src/core/chat/chat-store.mjs";
import { createToolRegistry } from "../src/core/chat/tool-registry.mjs";
import { registerReadTools } from "../src/core/chat/tools-read.mjs";
import { createProjectAt, loadProject, loadState, saveState } from "../src/core/project-store.mjs";
import { assertBlueprintReady } from "../src/core/blueprint-guard.mjs";

const BLUEPRINT_BLOCK_MESSAGE = "请先完成 /init 生成大纲与设定";

function makeProjectRoot() {
  return mkdtempSync(join(tmpdir(), "bp-test-"));
}

function scriptedClient(script) {
  let i = 0;
  return { generate: async () => ({ text: script[Math.min(i++, script.length - 1)], usageReport: {}, costSummary: { estimatedCost: 0 } }) };
}

// chat 门禁夹具：none 项目 + 只读注册表 + 一个记录执行的 fake_write 写工具
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

test("新建项目默认 blueprint_status none，拒绝写作", async () => {
  const projectRoot = makeProjectRoot();
  await createProjectAt(projectRoot, { title: "T" });
  const state = await loadState(projectRoot);
  assert.equal(state.blueprint_status, "none");
  await assert.rejects(() => assertBlueprintReady(projectRoot), /完成.*init/u);
});

test("partial 状态拒绝写作", async () => {
  const projectRoot = makeProjectRoot();
  await createProjectAt(projectRoot, { title: "T" });
  const state = await loadState(projectRoot);
  state.blueprint_status = "partial";
  await saveState(projectRoot, state);
  await assert.rejects(() => assertBlueprintReady(projectRoot), /完成.*init/u);
});

test("complete 状态允许写作", async () => {
  const projectRoot = makeProjectRoot();
  await createProjectAt(projectRoot, { title: "T" });
  const state = await loadState(projectRoot);
  state.blueprint_status = "complete";
  await saveState(projectRoot, state);
  await assert.doesNotReject(() => assertBlueprintReady(projectRoot));
});

test("legacy 状态允许写作", async () => {
  const projectRoot = makeProjectRoot();
  await createProjectAt(projectRoot, { title: "T" });
  const state = await loadState(projectRoot);
  state.blueprint_status = "legacy";
  await saveState(projectRoot, state);
  await assert.doesNotReject(() => assertBlueprintReady(projectRoot));
});

// 章节产物证据：写 chapters/001.md（升级前旧项目的等价证据）
async function addChapterEvidence(projectRoot) {
  await mkdir(join(projectRoot, "chapters"), { recursive: true });
  await writeFile(join(projectRoot, "chapters", "001.md"), "# 第1章\n\n旧项目正文……\n", "utf8");
}

// Task 9 收紧后的兜底语义（spec §1.4 P2-5）：字段缺失不再是无条件放行——
// 有章节产物才视为 legacy 放行；字段缺失且无产物按 none 拒绝（门禁不形同虚设）。
test("blueprint_status 字段缺失且无章节产物时拒绝", async () => {
  const projectRoot = makeProjectRoot();
  await createProjectAt(projectRoot, { title: "T" });
  const state = await loadState(projectRoot);
  delete state.blueprint_status;
  await saveState(projectRoot, state);
  await assert.rejects(() => assertBlueprintReady(projectRoot), /完成.*init/u);
});

test("blueprint_status 字段缺失但有章节产物时视为 legacy 放行", async () => {
  const projectRoot = makeProjectRoot();
  await createProjectAt(projectRoot, { title: "T" });
  const state = await loadState(projectRoot);
  delete state.blueprint_status;
  await saveState(projectRoot, state);
  await addChapterEvidence(projectRoot);
  await assert.doesNotReject(() => assertBlueprintReady(projectRoot));
});

test("agent_state.json 不存在且无章节产物时拒绝", async () => {
  const projectRoot = makeProjectRoot();
  await assert.rejects(() => assertBlueprintReady(projectRoot), /完成.*init/u);
});

test("agent_state.json 不存在但有章节产物时视为 legacy 放行", async () => {
  const projectRoot = makeProjectRoot();
  await addChapterEvidence(projectRoot);
  await assert.doesNotReject(() => assertBlueprintReady(projectRoot));
});

test("runProject 在 blueprint_status none 时拒绝", async () => {
  const projectRoot = makeProjectRoot();
  await createProjectAt(projectRoot, { title: "T" });
  await assert.rejects(() => runProject(projectRoot), /完成.*init/u);
});

test("chat 写工具在 blueprint_status none 时被拒且不执行", async () => {
  const { projectRoot, registry, fakeWriteExecuted } = makeChatGuardFixture();
  await createProjectAt(projectRoot, { title: "T" });
  const project = await loadProject(projectRoot);
  await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient([
      '```json\n{"tool_calls":[{"tool":"fake_write","args":{"x":1}}]}\n```',
      "好的。"
    ]),
    userMessage: "改一下"
  });
  const history = await readChatHistory(projectRoot);
  const toolMsg = history.find((m) => m.role === "tool" && m.tool === "fake_write");
  assert.ok(toolMsg, "应有被拒的 tool 消息");
  assert.equal(toolMsg.ok, false);
  assert.equal(toolMsg.result_summary, BLUEPRINT_BLOCK_MESSAGE);
  assert.equal(fakeWriteExecuted(), false, "写工具不得执行");
});

test("resumeChatTurn 执行 pending 写工具在 blueprint_status none 时被拒并清 pending", async () => {
  const { projectRoot, registry, fakeWriteExecuted } = makeChatGuardFixture();
  await createProjectAt(projectRoot, { title: "T" });
  const project = await loadProject(projectRoot);
  await savePendingAction(projectRoot, { tool: "fake_write", args: { x: 1 }, preview: null, lead_text: "" });
  const out = await resumeChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient(["好的。"]),
    approve: true
  });
  assert.equal(out.toolEvents[0]?.ok, false);
  assert.equal(out.toolEvents[0]?.error, "blueprint_not_ready");
  assert.equal(fakeWriteExecuted(), false, "写工具不得执行");
  assert.equal(await loadPendingAction(projectRoot), null, "pending 应被清除");
  // 拒绝路径的 tool 消息 result_summary 应为纯 message（与 agentLoop 一致，非 JSON 序列化）
  const history = await readChatHistory(projectRoot);
  const toolMsg = history.find((m) => m.role === "tool" && m.tool === "fake_write");
  assert.equal(toolMsg?.result_summary, BLUEPRINT_BLOCK_MESSAGE);
});
