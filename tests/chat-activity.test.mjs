// 统一活动事件流测试：思考、工具执行、Shell 增量输出、停止都经同一 chat_activity 事件
// 流出（onEvent -> SSE）。活动事件是 Task 9 活动流 UI 的数据源，事件序列是协议的一部分。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runChatTurn, resumeChatTurn } from "../src/core/chat/chat-agent.mjs";
import { readChatHistory } from "../src/core/chat/chat-store.mjs";
import { createToolRegistry } from "../src/core/chat/tool-registry.mjs";
import { registerReadTools } from "../src/core/chat/tools-read.mjs";
import { registerWriteTools } from "../src/core/chat/tools-write.mjs";
import { registerShellTools } from "../src/core/chat/tools-shell.mjs";
import { loadProject } from "../src/core/project-store.mjs";
import { createWritingProject } from "./helpers.mjs";

// ===== 测试辅助：与 chat-agent.test.mjs 同风格 =====

// 拼 ```json 围栏的 tool_calls 回复（parseAgentReply 的兜底解析路径）。
function toolCall(tool, args) {
  return `\`\`\`json\n{"tool_calls":[{"tool":"${tool}","args":${JSON.stringify(args)}}]}\n\`\`\``;
}

function textReply(text) {
  return text;
}

function scriptedClient(script) {
  let i = 0;
  return { generate: async () => ({ text: script[Math.min(i++, script.length - 1)], usageReport: {}, costSummary: { estimatedCost: 0 } }) };
}

async function makeChatProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-activity-"));
  const { projectRoot } = await createWritingProject(root, {
    slug: "c", title: "活动事件测试", story_seed: "种子",
    target_chapters: 3, min_words_per_chapter: 10, target_words_per_chapter: 12
  });
  return projectRoot;
}

// makeFixture：真实项目 + 真实注册表（read/write/shell），modelReplies 逐轮驱动模型回复。
async function makeFixture({ modelReplies, onEvent, register, userMessage = "随便聊聊", ...rest }) {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  registerShellTools(registry);
  register?.(registry);
  return {
    projectRoot, project, registry,
    modelClient: scriptedClient(modelReplies),
    userMessage,
    ...rest,
    onEvent
  };
}

// 注册一个默认权限下必挂确认的写工具（模拟 edit_chapter 的确认路径，无真实副作用）。
function registerFakeWrite(registry) {
  registry.register({
    name: "fake_write",
    kind: "write",
    description: "测试用写工具",
    params: {},
    run: async () => ({ done: true })
  });
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// ===== 事件序列 =====

test("聊天活动按 thinking -> requested -> running -> succeeded 发出", async () => {
  const events = [];
  await runChatTurn(await makeFixture({
    modelReplies: [toolCall("get_status", {}), textReply("完成")],
    onEvent: (event) => events.push(event)
  }));
  const states = events.filter((event) => event.type === "chat_activity").map((event) => `${event.phase}:${event.state}`);
  assert.deepEqual(states, [
    "thinking:running",
    "tool:requested",
    "tool:running",
    "tool:succeeded",
    "thinking:running",
    "complete:succeeded"
  ]);
});

test("等待确认和取消是显式活动状态", async () => {
  const events = [];
  const out = await runChatTurn(await makeFixture({
    modelReplies: [toolCall("fake_write", {})],
    onEvent: (event) => events.push(event),
    register: registerFakeWrite
  }));
  assert.ok(out.pendingAction);
  const activities = events.filter((event) => event.type === "chat_activity");
  assert.ok(activities.some((event) => event.state === "waiting_confirmation"), "应发出 waiting_confirmation 活动");
  // 挂 pending 的活动不应出现执行终态（不执行工具）
  assert.ok(!activities.some((event) => event.state === "succeeded" && event.phase === "editing"));
});

test("resume 执行与续轮继续发活动事件", async () => {
  const events = [];
  const fixture = await makeFixture({
    modelReplies: [toolCall("fake_write", {})],
    onEvent: (event) => events.push(event),
    register: registerFakeWrite
  });
  await runChatTurn(fixture);
  events.length = 0; // 只看 resume 段的序列
  const resumed = await resumeChatTurn({
    projectRoot: fixture.projectRoot, project: fixture.project, registry: fixture.registry,
    modelClient: scriptedClient([textReply("已执行。")]),
    decision: "once",
    onEvent: (event) => events.push(event)
  });
  assert.equal(resumed.reply, "已执行。");
  const states = events.filter((event) => event.type === "chat_activity").map((event) => `${event.phase}:${event.state}`);
  assert.deepEqual(states, [
    "editing:requested",
    "editing:running",
    "editing:succeeded",
    "thinking:running",
    "complete:succeeded"
  ]);
});

// ===== Shell 增量输出 =====

test("shell 增量输出经同一 activity_id 流式发出并落结构化历史", async () => {
  const events = [];
  const fixture = await makeFixture({
    modelReplies: [
      toolCall("shell", { command: `"${process.execPath}" -e "console.log('hello-from-shell')"`, purpose: "测试输出" }),
      textReply("已执行。")
    ],
    onEvent: (event) => events.push(event)
  });
  // shell 属 control 类：yolo 放行免确认，让命令真正执行
  fixture.project.tool_permissions = { ...(fixture.project.tool_permissions ?? {}), yolo: true };
  const out = await runChatTurn(fixture);
  assert.equal(out.toolEvents[0].tool, "shell");
  assert.equal(out.toolEvents[0].ok, true);
  const activities = events.filter((event) => event.type === "chat_activity");
  const commandRunning = activities.filter((event) => event.phase === "command" && event.state === "running");
  const streamed = commandRunning.filter((event) => event.output_delta.length > 0);
  assert.ok(streamed.length > 0, "应有流式 output_delta 事件");
  // 增量输出必须复用同一个 activity_id（同一次命令 = 同一个活动）
  assert.equal(new Set(commandRunning.map((event) => event.activity_id)).size, 1, "增量输出应复用同一 activity_id");
  assert.match(streamed.map((event) => event.output_delta).join(""), /hello-from-shell/u);
  // 终态：succeeded 且带退出码
  const terminal = activities.filter((event) => event.phase === "command" && ["succeeded", "failed"].includes(event.state));
  assert.equal(terminal.at(-1).state, "succeeded");
  assert.equal(terminal.at(-1).exit_code, 0);
  // 结构化工具历史：status/command/cwd/output/exit_code/duration_ms 落盘
  const history = await readChatHistory(fixture.projectRoot);
  const toolMsg = history.find((m) => m.role === "tool" && m.tool === "shell");
  assert.ok(toolMsg, "应有 shell 工具消息");
  assert.equal(toolMsg.status, "succeeded");
  assert.equal(toolMsg.exit_code, 0);
  assert.match(toolMsg.output, /hello-from-shell/u);
  assert.ok(toolMsg.command.includes("console.log"));
  assert.equal(toolMsg.cwd, fixture.projectRoot);
  assert.ok(typeof toolMsg.duration_ms === "number" && toolMsg.duration_ms >= 0);
});

// ===== 停止 =====

test("停止时最后一个活动状态为 cancelled，不再停留在 running", async () => {
  const events = [];
  const fixture = await makeFixture({ modelReplies: [textReply("x")], onEvent: (event) => events.push(event) });
  const controller = new AbortController();
  fixture.signal = controller.signal;
  fixture.modelClient = {
    generate: ({ signal }) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })
  };
  const turn = runChatTurn(fixture);
  await delay(50);
  controller.abort("用户停止");
  const out = await turn;
  assert.equal(out.cancelled, true);
  const activities = events.filter((event) => event.type === "chat_activity");
  assert.ok(activities.length >= 2, "停止前应有 thinking 活动");
  assert.equal(activities.at(-1).state, "cancelled", "最后一个活动状态应为 cancelled");
});
