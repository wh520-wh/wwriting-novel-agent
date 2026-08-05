// 统一活动事件流测试：思考、工具执行、Shell 增量输出、停止都经同一 chat_activity 事件
// 流出（onEvent -> SSE）。活动事件是 Task 9 活动流 UI 的数据源，事件序列是协议的一部分。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runChatTurn, resumeChatTurn, MAX_TOOL_ROUNDS } from "../src/core/chat/chat-agent.mjs";
import { readChatHistory } from "../src/core/chat/chat-store.mjs";
import { createToolRegistry } from "../src/core/chat/tool-registry.mjs";
import { registerReadTools } from "../src/core/chat/tools-read.mjs";
import { registerWriteTools } from "../src/core/chat/tools-write.mjs";
import { registerShellTools } from "../src/core/chat/tools-shell.mjs";
import { loadProject, upsertChapter } from "../src/core/project-store.mjs";
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
  const first = await runChatTurn(fixture);
  // I-1: pending 持久化了确认卡 activity_id，resume 复用同一 id 发终态（活动闭环）
  const cardId = first.pendingAction.activity_id;
  assert.ok(cardId, "pending 应持久化确认卡 activity_id");
  events.length = 0; // 只看 resume 段的序列
  const resumed = await resumeChatTurn({
    projectRoot: fixture.projectRoot, project: fixture.project, registry: fixture.registry,
    modelClient: scriptedClient([textReply("已执行。")]),
    decision: "once",
    onEvent: (event) => events.push(event)
  });
  assert.equal(resumed.reply, "已执行。");
  const activities = events.filter((event) => event.type === "chat_activity");
  const states = activities.map((event) => `${event.phase}:${event.state}`);
  // I-1 后 resume 不再重发 requested（原轮已发出，同 activity_id 直接从 running 续起）
  assert.deepEqual(states, [
    "editing:running",
    "editing:succeeded",
    "thinking:running",
    "complete:succeeded"
  ]);
  const terminal = activities.find((event) => event.phase === "editing" && event.state === "succeeded");
  assert.equal(terminal.activity_id, cardId, "resume 终态应复用确认卡 activity_id");
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

// ===== I-4: 补充覆盖（review 修复） =====

// 通用不悬空检查：每个 requested / waiting_confirmation 都必须有同 activity_id 的终态
// （succeeded / failed / cancelled），否则说明该活动流悬空、UI 会永久停在中间状态。
function assertNoDanglingActivities(activities, message = "不应有悬空的活动（requested/waiting_confirmation 无终态）") {
  const open = new Set();
  for (const ev of activities) {
    if (ev.state === "requested" || ev.state === "waiting_confirmation") open.add(ev.activity_id);
    if (["succeeded", "failed", "cancelled"].includes(ev.state)) open.delete(ev.activity_id);
  }
  assert.deepEqual([...open], [], message);
}

test("工具执行失败：活动终态为 tool:failed 且历史 status 落 failed", async () => {
  const events = [];
  const fixture = await makeFixture({
    modelReplies: [toolCall("boom_read", {}), textReply("完成")],
    onEvent: (event) => events.push(event),
    register: (registry) => registry.register({
      name: "boom_read", kind: "read", description: "测试必炸工具",
      params: {},
      run: async () => { throw Object.assign(new Error("工具执行爆炸"), { code: "boom" }); }
    })
  });
  await runChatTurn(fixture);
  const activities = events.filter((event) => event.type === "chat_activity");
  const failed = activities.filter((event) => event.state === "failed");
  assert.equal(failed.length, 1, "应有 1 条 failed 活动");
  assert.equal(failed[0].phase, "tool");
  assert.equal(failed[0].error, "boom");
  assert.equal(activities.at(-1).phase, "complete");
  assert.equal(activities.at(-1).state, "succeeded");
  assertNoDanglingActivities(activities);
  // 结构化历史：status failed + output 落错误消息
  const history = await readChatHistory(fixture.projectRoot);
  const toolMsg = history.find((m) => m.role === "tool" && m.tool === "boom_read");
  assert.ok(toolMsg, "应有 boom_read 工具消息");
  assert.equal(toolMsg.status, "failed");
  assert.match(toolMsg.output, /工具执行爆炸/u);
});

test("工具轮数达上限：以 complete:succeeded 收尾且无悬空活动", async () => {
  const events = [];
  const fixture = await makeFixture({ modelReplies: [textReply("x")], onEvent: (event) => events.push(event) });
  // 模型永远只发工具调用 -> 触发 MAX_TOOL_ROUNDS 上限
  fixture.modelClient = {
    generate: async () => ({ text: toolCall("get_status", {}), usageReport: {}, costSummary: { estimatedCost: 0 } })
  };
  const out = await runChatTurn(fixture);
  assert.ok(out.toolEvents.length >= MAX_TOOL_ROUNDS, "应执行满 MAX_TOOL_ROUNDS 轮");
  const activities = events.filter((event) => event.type === "chat_activity");
  assert.equal(activities.at(-1).phase, "complete");
  assert.equal(activities.at(-1).state, "succeeded");
  assertNoDanglingActivities(activities);
});

test("确认卡闭环：resume once 与 reject 都用同一 activity_id 发终态", async () => {
  // --- resume once：waiting_confirmation -> running -> succeeded（同一 activity_id）---
  const onceEvents = [];
  const fixture = await makeFixture({
    modelReplies: [toolCall("fake_write", {})],
    onEvent: (event) => onceEvents.push(event),
    register: registerFakeWrite
  });
  const first = await runChatTurn(fixture);
  assert.ok(first.pendingAction);
  const preOnce = onceEvents.filter((event) => event.type === "chat_activity");
  const waitingOnce = preOnce.find((event) => event.state === "waiting_confirmation");
  assert.ok(waitingOnce, "应有 waiting_confirmation 活动");
  const requestedOnce = preOnce.find((event) => event.state === "requested");
  assert.equal(requestedOnce.activity_id, waitingOnce.activity_id, "requested 与 waiting_confirmation 应复用同一 activity_id");
  assert.equal(first.pendingAction.activity_id, waitingOnce.activity_id, "pending 应持久化确认卡 activity_id");
  onceEvents.length = 0;
  const resumed = await resumeChatTurn({
    projectRoot: fixture.projectRoot, project: fixture.project, registry: fixture.registry,
    modelClient: scriptedClient([textReply("已执行。")]),
    decision: "once",
    onEvent: (event) => onceEvents.push(event)
  });
  assert.equal(resumed.reply, "已执行。");
  const onceActivities = onceEvents.filter((event) => event.type === "chat_activity");
  const onceTerminal = onceActivities.find((event) => ["succeeded", "failed"].includes(event.state) && event.phase === "editing");
  assert.ok(onceTerminal, "resume once 应发出编辑终态");
  assert.equal(onceTerminal.activity_id, waitingOnce.activity_id, "resume 终态应复用确认卡 activity_id");

  // --- reject：同一 activity_id 收到 cancelled 终态 ---
  const rejectEvents = [];
  const fixture2 = await makeFixture({
    modelReplies: [toolCall("fake_write", {})],
    onEvent: (event) => rejectEvents.push(event),
    register: registerFakeWrite
  });
  const first2 = await runChatTurn(fixture2);
  assert.ok(first2.pendingAction);
  const preReject = rejectEvents.filter((event) => event.type === "chat_activity");
  const waitingReject = preReject.find((event) => event.state === "waiting_confirmation");
  rejectEvents.length = 0;
  const rejected = await resumeChatTurn({
    projectRoot: fixture2.projectRoot, project: fixture2.project, registry: fixture2.registry,
    modelClient: scriptedClient([textReply("好的。")]),
    decision: "reject",
    onEvent: (event) => rejectEvents.push(event)
  });
  assert.ok(rejected.reply, "reject 后应正常继续对话");
  const rejectActivities = rejectEvents.filter((event) => event.type === "chat_activity");
  const cancelled = rejectActivities.find((event) => event.state === "cancelled");
  assert.ok(cancelled, "reject 应发出 cancelled 终态");
  assert.equal(cancelled.activity_id, waitingReject.activity_id, "reject 终态应复用确认卡 activity_id");
  assert.equal(cancelled.error, "user_rejected");
  assertNoDanglingActivities(rejectActivities, "reject 后不应有悬空活动");
});

test("edit_chapter 预览失败：同一 activity_id 收到 cancelled 终态，无悬空活动", async () => {
  const events = [];
  const fixture = await makeFixture({
    modelReplies: [
      toolCall("edit_chapter", { chapter_no: 1, find: "不存在的文字", replace: "x", reason: "x" }),
      textReply("完成")
    ],
    onEvent: (event) => events.push(event)
  });
  // 真实章节文件（与 chat-agent.test.mjs 同构造）：find 不命中 -> locateFind 抛
  // find_not_found -> previewEditChapter 失败，走预览失败拒绝路径（不落 pending）。
  const chapterPath = path.join(fixture.projectRoot, "chapters", "001.md");
  await fs.mkdir(path.dirname(chapterPath), { recursive: true });
  await fs.writeFile(chapterPath, "# Chapter 001\n\n刘康从六楼坠落。", "utf8");
  await upsertChapter(fixture.projectRoot, { chapter_no: 1, status: "completed", final_path: chapterPath, actual_words: 8 });
  const out = await runChatTurn(fixture);
  // 预览失败 -> 不挂 pending（确认卡直接作废，因此必须在本轮内补终态闭环）
  assert.equal(out.pendingAction, null);
  assert.equal(out.toolEvents[0].error, "find_not_found", "预览失败应按原始错误码记为 find_not_found");
  const activities = events.filter((event) => event.type === "chat_activity");
  const waiting = activities.find((event) => event.state === "waiting_confirmation");
  assert.ok(waiting, "应发出 waiting_confirmation 活动");
  const cancelled = activities.filter((event) => event.state === "cancelled" && event.phase === "editing").at(-1);
  assert.ok(cancelled, "预览失败应补发 cancelled 终态");
  assert.equal(cancelled.activity_id, waiting.activity_id, "cancelled 终态应复用确认卡 activity_id");
  assert.equal(cancelled.error, "preview_failed");
  assertNoDanglingActivities(activities);
});

test("supersede：新消息覆盖旧 pending 时用同一 activity_id 发 cancelled 终态", async () => {
  const events = [];
  const fixture = await makeFixture({
    modelReplies: [toolCall("fake_write", {})],
    onEvent: (event) => events.push(event),
    register: registerFakeWrite
  });
  const first = await runChatTurn(fixture);
  assert.ok(first.pendingAction);
  const pre = events.filter((event) => event.type === "chat_activity");
  const waiting = pre.find((event) => event.state === "waiting_confirmation");
  assert.ok(waiting, "应有 waiting_confirmation 活动");
  events.length = 0;
  // 新用户消息 -> 旧 pending 被 supersede（第一轮模型回复仍是 fake_write，本轮会再挂新 pending）
  await runChatTurn({ ...fixture, userMessage: "换一个任务", onEvent: (event) => events.push(event) });
  const activities = events.filter((event) => event.type === "chat_activity");
  const superseded = activities.find((event) => event.state === "cancelled");
  assert.ok(superseded, "supersede 应发 cancelled 终态");
  assert.equal(superseded.activity_id, waiting.activity_id, "supersede 终态应复用旧确认卡 activity_id");
  assert.equal(superseded.error, "superseded");
  // 旧确认卡必须闭环（本轮新挂的 pending 卡仍待确认，属预期，不在检查范围）
  const stillOpen = new Set();
  for (const ev of activities) {
    if (ev.state === "requested" || ev.state === "waiting_confirmation") stillOpen.add(ev.activity_id);
    if (["succeeded", "failed", "cancelled"].includes(ev.state)) stillOpen.delete(ev.activity_id);
  }
  assert.ok(!stillOpen.has(waiting.activity_id), "旧确认卡 activity_id 不应悬空");
});

test("模型抛错：thinking 活动有 failed 终态（spinner 不悬空）", async () => {
  const events = [];
  const fixture = await makeFixture({ modelReplies: [textReply("x")], onEvent: (event) => events.push(event) });
  fixture.modelClient = { generate: async () => { throw new Error("模型调用超时"); } };
  await assert.rejects(() => runChatTurn(fixture), /模型调用超时/u);
  const activities = events.filter((event) => event.type === "chat_activity");
  const thinkingFailed = activities.filter((event) => event.phase === "thinking" && event.state === "failed");
  assert.equal(thinkingFailed.length, 1, "应有 1 条 thinking:failed 终态");
  assert.equal(activities.at(-1).state, "failed", "最后一个活动应为 failed 终态");
  assert.equal(activities.at(-1).error, "模型调用超时");
});

test("deny 路径不产生悬空活动（read_only 下发写工具）", async () => {
  const events = [];
  const fixture = await makeFixture({
    modelReplies: [toolCall("fake_write", {}), textReply("完成")],
    onEvent: (event) => events.push(event),
    register: registerFakeWrite
  });
  fixture.project.tool_permissions = { ...(fixture.project.tool_permissions ?? {}), read_only: true };
  const out = await runChatTurn(fixture);
  assert.equal(out.pendingAction, null);
  assert.equal(out.toolEvents[0].error, "permission_denied");
  const activities = events.filter((event) => event.type === "chat_activity");
  // 记录现状：deny 路径不发 activity；断言不出现 requested/waiting_confirmation 无终态的半截序列
  assert.ok(!activities.some((event) => event.state === "requested"), "deny 路径不应有 requested 活动");
  assertNoDanglingActivities(activities);
});

test("shell 非零退出码：活动终态与历史 status 为 failed（toolEvents ok 语义不变）", async () => {
  const events = [];
  const fixture = await makeFixture({
    modelReplies: [
      toolCall("shell", { command: `"${process.execPath}" -e "process.exit(3)"`, purpose: "测试退出码" }),
      textReply("已执行。")
    ],
    onEvent: (event) => events.push(event)
  });
  fixture.project.tool_permissions = { ...(fixture.project.tool_permissions ?? {}), yolo: true };
  const out = await runChatTurn(fixture);
  assert.equal(out.toolEvents[0].ok, true, "toolEvents ok 保持 outcome.ok 语义");
  const activities = events.filter((event) => event.type === "chat_activity");
  const terminal = activities.filter((event) => event.phase === "command" && ["succeeded", "failed"].includes(event.state)).at(-1);
  assert.equal(terminal.state, "failed", "shell 非零退出码应发 failed 终态");
  assert.equal(terminal.exit_code, 3);
  assertNoDanglingActivities(activities);
  const history = await readChatHistory(fixture.projectRoot);
  const toolMsg = history.find((m) => m.role === "tool" && m.tool === "shell");
  assert.ok(toolMsg, "应有 shell 工具消息");
  assert.equal(toolMsg.status, "failed");
  assert.equal(toolMsg.exit_code, 3);
});
