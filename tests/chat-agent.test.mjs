import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildChatContext } from "../src/core/chat/chat-context.mjs";
import { appendChatMessage } from "../src/core/chat/chat-store.mjs";
import { createToolRegistry } from "../src/core/chat/tool-registry.mjs";
import { registerReadTools } from "../src/core/chat/tools-read.mjs";
import { readEvents } from "../src/core/event-log.mjs";
import { createProject, loadProject } from "../src/core/project-store.mjs";

async function makeProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-chatctx-"));
  const { projectRoot } = await createProject(root, {
    slug: "c", title: "上下文测试", story_seed: "种子",
    target_chapters: 3, min_words_per_chapter: 10, target_words_per_chapter: 12
  });
  return projectRoot;
}

test("buildChatContext 注入系统提示/记忆/历史/本轮消息", async () => {
  const projectRoot = await makeProject();
  await fs.writeFile(path.join(projectRoot, "memory", "book_summary.md"), "# 全书摘要\n\n主角觉醒。", "utf8");
  await appendChatMessage(projectRoot, { role: "user", content: "之前的问题" });
  await appendChatMessage(projectRoot, { role: "assistant", content: "之前的回答" });
  const registry = createToolRegistry();
  registerReadTools(registry);
  const project = await loadProject(projectRoot);
  const { messages, snapshot } = await buildChatContext({ projectRoot, project, registry, userMessage: "现在写到哪了？" });
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /主角觉醒/u);
  assert.match(messages[0].content, /get_status/u);
  assert.equal(messages.at(-1).role, "user");
  assert.equal(messages.at(-1).content, "现在写到哪了？");
  assert.equal(messages.length, 4);
  assert.equal(snapshot.title, "上下文测试");
});

test("buildChatContext 过滤 generating 占位消息（空 assistant 不进模型上下文）", async () => {
  const projectRoot = await makeProject();
  await appendChatMessage(projectRoot, { role: "user", content: "用户消息" });
  // runChatTurn 先写占位（content 为空，status=generating），模型回复后历史里会有空占位残留
  await appendChatMessage(projectRoot, { role: "assistant", content: "", status: "generating", turn_id: "t1" });
  await appendChatMessage(projectRoot, { role: "assistant", content: "正式回复" });
  const registry = createToolRegistry();
  registerReadTools(registry);
  const project = await loadProject(projectRoot);
  const { messages } = await buildChatContext({ projectRoot, project, registry, userMessage: "新消息" });
  const assistantContents = messages.filter((m) => m.role === "assistant").map((m) => m.content);
  assert.deepEqual(assistantContents, ["正式回复"]);
  assert.ok(!messages.some((m) => m.role === "assistant" && !m.content), "不应存在空 content 的 assistant 消息");
  // 同时确认生成中的占位（当前轮，最后一条）也被过滤
  await appendChatMessage(projectRoot, { role: "assistant", content: "", status: "generating", turn_id: "t2" });
  const { messages: messages2 } = await buildChatContext({ projectRoot, project, registry, userMessage: "又一条" });
  const last = messages2.at(-2);
  assert.equal(last.role, "assistant");
  assert.equal(last.content, "正式回复");
  assert.ok(messages2.every((m) => !(m.role === "assistant" && !m.content)));
});

test("历史超 40 条折叠为提要", async () => {
  const projectRoot = await makeProject();
  for (let i = 0; i < 50; i += 1) await appendChatMessage(projectRoot, { role: "user", content: `历史消息${i}` });
  const registry = createToolRegistry();
  const project = await loadProject(projectRoot);
  const { messages } = await buildChatContext({ projectRoot, project, registry, userMessage: "新消息" });
  const digest = messages.find((m) => m.role === "system" && m.content.includes("早前对话提要"));
  assert.ok(digest);
  assert.match(digest.content, /历史消息0/u);
  const fullHistory = messages.filter((m) => m.content?.startsWith?.("历史消息") && !m.content.includes("提要"));
  assert.equal(fullHistory.length, 40);
});

import { runChatTurn, resumeChatTurn } from "../src/core/chat/chat-agent.mjs";
import { registerWriteTools } from "../src/core/chat/tools-write.mjs";
import { registerControlTools } from "../src/core/chat/tools-control.mjs";
import { loadPendingAction, readChatHistory as readHistory, clearPendingAction } from "../src/core/chat/chat-store.mjs";
import { appendTranscript } from "../src/core/chat/transcript-store.mjs";
import { executeTool } from "../src/core/chat/tool-registry.mjs";
import { upsertChapter, saveProject, loadState, saveState } from "../src/core/project-store.mjs";

function scriptedClient(script) {
  let i = 0;
  return { generate: async () => ({ text: script[Math.min(i++, script.length - 1)], usageReport: {}, costSummary: { estimatedCost: 0 } }) };
}

async function makeChatProject() {
  const projectRoot = await makeProject();
  const chapterPath = path.join(projectRoot, "chapters", "001.md");
  await fs.mkdir(path.dirname(chapterPath), { recursive: true });
  await fs.writeFile(chapterPath, "# Chapter 001\n\n刘康从六楼坠落。", "utf8");
  await upsertChapter(projectRoot, { chapter_no: 1, status: "completed", final_path: chapterPath, actual_words: 8 });
  return projectRoot;
}

test("纯文本回复直接落历史", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry);
  const out = await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient(["进度是 1/3 章。"]),
    userMessage: "进度如何？"
  });
  assert.equal(out.reply, "进度是 1/3 章。");
  assert.equal(out.pendingAction, null);
  const history = await readHistory(projectRoot);
  assert.deepEqual(history.map((m) => m.role), ["user", "assistant", "assistant"]);
});

test("读工具自动执行并回填后续轮", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry);
  const out = await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient([
      '```json\n{"tool_calls":[{"tool":"get_status","args":{}}]}\n```',
      "已完成 1 章，共 3 章。"
    ]),
    userMessage: "进度如何？"
  });
  assert.equal(out.reply, "已完成 1 章，共 3 章。");
  assert.equal(out.toolEvents.length, 1);
  assert.equal(out.toolEvents[0].tool, "get_status");
  assert.equal(out.toolEvents[0].ok, true);
});

// ===== Task 7: 原生 tools 注入 =====
test("agentLoop 注入原生 tools（注册表工具名齐全、无 chapter_no）", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry);
  let captured = null;
  const modelClient = {
    generate: async (req) => {
      captured = req;
      return { text: "进度是 1/3 章。", usageReport: {}, costSummary: { estimatedCost: 0 } };
    }
  };
  const out = await runChatTurn({
    projectRoot, project, registry,
    modelClient,
    userMessage: "进度如何？"
  });
  assert.equal(out.reply, "进度是 1/3 章。");
  const toolRequest = captured.metadata.toolRequest;
  assert.ok(Array.isArray(toolRequest.tools) && toolRequest.tools.length > 0, "应注入非空 tools 数组");
  const names = toolRequest.tools.map((t) => t.function.name);
  assert.ok(names.includes("get_status"));
  assert.ok(names.includes("read_chapter"));
  for (const t of toolRequest.tools) {
    assert.equal(t.type, "function");
    assert.equal(t.function.parameters.type, "object");
  }
  assert.equal(toolRequest.chapter_no, undefined, "聊天场景不应有 chapter_no");
});

test("finish_reason=length 时文本回复追加截断标注并发 warn 事件", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry);
  const modelClient = {
    generate: async () => ({
      text: "很长的回复……",
      raw: { choices: [{ message: { content: "很长的回复……" }, finish_reason: "length" }] },
      usageReport: {}, costSummary: { estimatedCost: 0 }
    })
  };
  const out = await runChatTurn({
    projectRoot, project, registry,
    modelClient,
    userMessage: "写长点"
  });
  // 标注进入最终返回的 reply 与历史里的 assistant 消息
  assert.match(out.reply, /被截断/u);
  const history = await readHistory(projectRoot);
  assert.match(history.at(-1).content, /被截断/u);
  // warn 级事件落盘 run_log.jsonl
  const events = await readEvents(projectRoot);
  const trunc = events.find((e) => e.type === "chat_reply_truncated");
  assert.ok(trunc, "应有 chat_reply_truncated 事件");
  assert.equal(trunc.severity, "warn");
});

test("写工具落 pending_action 并暂停，approve 后执行并继续", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  const first = await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient([
      '```json\n{"tool_calls":[{"tool":"edit_chapter","args":{"chapter_no":1,"find":"六楼","replace":"十二楼","reason":"统一"}}]}\n```'
    ]),
    userMessage: "把第1章六楼改成十二楼"
  });
  assert.ok(first.pendingAction);
  assert.equal(first.pendingAction.tool, "edit_chapter");
  assert.match(first.pendingAction.preview.after, /十二楼/u);
  assert.ok(await loadPendingAction(projectRoot));
  const resumed = await resumeChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient(["已把第 1 章的六楼改为十二楼。"]),
    approve: true
  });
  assert.equal(resumed.reply, "已把第 1 章的六楼改为十二楼。");
  assert.equal(await loadPendingAction(projectRoot), null);
  const content = await fs.readFile(path.join(projectRoot, "chapters", "001.md"), "utf8");
  assert.match(content, /十二楼/u);
});

test("拒绝路径：reject 回填 user_rejected", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient(['```json\n{"tool_calls":[{"tool":"edit_chapter","args":{"chapter_no":1,"find":"六楼","replace":"九楼","reason":"x"}}]}\n```']),
    userMessage: "改楼层"
  });
  const resumed = await resumeChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient(["好的，保持六楼不变。"]),
    approve: false
  });
  assert.equal(resumed.reply, "好的，保持六楼不变。");
  const content = await fs.readFile(path.join(projectRoot, "chapters", "001.md"), "utf8");
  assert.match(content, /六楼/u);
});

test("maxToolRounds 护栏（默认 32）", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry);
  const loopForever = '```json\n{"tool_calls":[{"tool":"get_status","args":{}}]}\n```';
  // 提供足够多脚本条目使 32 轮都能跑满
  const out = await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient(Array(40).fill(loopForever)),
    userMessage: "随便"
  });
  assert.match(out.reply, /上限/u);
  assert.equal(out.toolEvents.length, 32);
  // 验证全部成功
  assert.ok(out.toolEvents.every((e) => e.ok === true));
});

test("已有 pending_action 时新消息不再硬挡：superseded 落盘 + 继续处理", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  // 第一轮挂 pending
  await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient(['```json\n{"tool_calls":[{"tool":"edit_chapter","args":{"chapter_no":1,"find":"六楼","replace":"五楼","reason":"x"}}]}\n```']),
    userMessage: "改"
  });
  // 第二轮有 pending 时发新消息 → 不再被挡，pending 被 superseded，新消息正常处理
  const second = await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient(["进度是 1/3 章。"]),
    userMessage: "进度如何？"
  });
  assert.equal(second.reply, "进度是 1/3 章。");
  assert.equal(second.pendingAction, null);
  // 历史中应有 superseded 工具消息
  const history = await readHistory(projectRoot);
  const supersededMsg = history.find((m) => m.superseded === true);
  assert.ok(supersededMsg, "应有 superseded 消息");
  assert.equal(supersededMsg.role, "tool");
  assert.equal(supersededMsg.ok, false);
  assert.equal(supersededMsg.tool, "edit_chapter");
  assert.equal(supersededMsg.result_summary, "因新指令自动取消");
  // pending 已被清除
  assert.equal(await loadPendingAction(projectRoot), null);
});

test("写作运行时写保护：running 时 update_continuity 免确认也被拒（防 lost update）", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  project.tool_permissions = { ...(project.tool_permissions ?? {}), yolo: true };
  await saveProject(projectRoot, project);
  const registry = createToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  const runJobs = new Map([[path.resolve(projectRoot), { status: "running", taskId: "t1" }]]);
  const out = await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient([
      '```json\n{"tool_calls":[{"tool":"update_continuity","args":{"entity":"刘康","attribute":"身高","value":"180","note":"补"}}]}\n```',
      "好的，等写作完成再改。"
    ]),
    userMessage: "把刘康身高设为 180",
    server: { runJobs }
  });
  assert.equal(out.toolEvents[0].tool, "update_continuity");
  assert.equal(out.toolEvents[0].ok, false);
  assert.equal(out.toolEvents[0].error, "run_busy");
  // continuity.json 未被写入：update_continuity 被拦，不与后台 runProject 并发写
  const contPath = path.join(projectRoot, "memory", "continuity.json");
  const exists = await fs.access(contPath).then(() => true).catch(() => false);
  assert.equal(exists, false);
});

test("写作运行时写保护：resume 批准时若已 running，pending 的 update_continuity 被拒", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  // 第一轮无 running，update_continuity 落 pending
  await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient([
      '```json\n{"tool_calls":[{"tool":"update_continuity","args":{"entity":"刘康","attribute":"身高","value":"180","note":"补"}}]}\n```'
    ]),
    userMessage: "把刘康身高设为 180",
    server: { runJobs: new Map() }
  });
  // 批准时写作任务已启动（pending 存时无 running，批准时 running 的竞态窗口）
  const runJobs = new Map([[path.resolve(projectRoot), { status: "running", taskId: "t1" }]]);
  await resumeChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient(["好的，等写作完成再改。"]),
    approve: true,
    server: { runJobs }
  });
  const toolMsg = (await readHistory(projectRoot)).find((m) => m.role === "tool" && m.tool === "update_continuity");
  assert.ok(toolMsg);
  assert.equal(toolMsg.ok, false);
  assert.match(toolMsg.result_summary, /run_busy|写作任务进行中/u);
  const contPath = path.join(projectRoot, "memory", "continuity.json");
  const exists = await fs.access(contPath).then(() => true).catch(() => false);
  assert.equal(exists, false);
});

test("畸形 JSON 按纯文本回复处理", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry);
  const out = await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient(['```json\n{"tool_calls": [{]}\n```']),
    userMessage: "随便"
  });
  assert.equal(out.reply, '```json\n{"tool_calls": [{]}\n```');
  assert.equal(out.toolEvents.length, 0);
});

test("模型调用未知工具 → tool 消息 unknown_tool", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry);
  const out = await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient([
      '```json\n{"tool_calls":[{"tool":"not_real","args":{}}]}\n```',
      "好吧，我用别的方法。"
    ]),
    userMessage: "查点东西"
  });
  assert.equal(out.reply, "好吧，我用别的方法。");
  assert.equal(out.toolEvents.length, 1);
  assert.equal(out.toolEvents[0].ok, false);
  assert.equal(out.toolEvents[0].error, "unknown_tool");
});

test("read_only 项目 write 工具不落 pending、直接回填 permission_denied", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  project.tool_permissions = { read_only: true };
  await saveProject(projectRoot, project);
  const registry = createToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  const out = await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient([
      '```json\n{"tool_calls":[{"tool":"edit_chapter","args":{"chapter_no":1,"find":"六楼","replace":"十楼","reason":"x"}}]}\n```',
      "明白了，不动。"
    ]),
    userMessage: "改"
  });
  assert.equal(out.pendingAction, null);
  assert.equal(out.toolEvents.length, 1);
  assert.equal(out.toolEvents[0].ok, false);
  assert.equal(out.toolEvents[0].error, "permission_denied");
  const content = await fs.readFile(path.join(projectRoot, "chapters", "001.md"), "utf8");
  assert.match(content, /六楼/u);
});

test("edit_chapter 运行中章被拒（chapter_busy）", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const state = await loadState(projectRoot);
  state.current_chapter_no = 1;
  await saveState(projectRoot, state);
  const registry = createToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  const server = {
    runJobs: new Map([[path.resolve(projectRoot), { status: "running" }]])
  };
  const out = await executeTool(registry, "edit_chapter", {
    chapter_no: 1, find: "六楼", replace: "十楼", reason: "x"
  }, { projectRoot, project, server });
  assert.equal(out.ok, false);
  assert.equal(out.error, "chapter_busy");
});

test("pending_action 跨进程持久：新 registry/loop 对象 approve 成功", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient(['```json\n{"tool_calls":[{"tool":"edit_chapter","args":{"chapter_no":1,"find":"六楼","replace":"十二楼","reason":"统一"}}]}\n```']),
    userMessage: "改"
  });
  const newRegistry = createToolRegistry();
  registerReadTools(newRegistry);
  registerWriteTools(newRegistry);
  const resumed = await resumeChatTurn({
    projectRoot, project, registry: newRegistry,
    modelClient: scriptedClient(["已改。"]),
    approve: true
  });
  assert.equal(await loadPendingAction(projectRoot), null);
  const content = await fs.readFile(path.join(projectRoot, "chapters", "001.md"), "utf8");
  assert.match(content, /十二楼/u);
});

test("auto_edit=true：edit_chapter 不落 pending 直接执行", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  project.tool_permissions = { ...project.tool_permissions, auto_edit: true };
  const registry = createToolRegistry();
  registerReadTools(registry); registerWriteTools(registry);
  const out = await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient([
      '```json\n{"tool_calls":[{"tool":"edit_chapter","args":{"chapter_no":1,"find":"六楼","replace":"十二楼","reason":"auto"}}]}\n```',
      "已自动改完。"
    ]),
    userMessage: "改楼层"
  });
  assert.equal(out.pendingAction, null);
  assert.equal(out.toolEvents[0].tool, "edit_chapter");
  assert.equal(out.toolEvents[0].ok, true);
  assert.match(await fs.readFile(path.join(projectRoot, "chapters", "001.md"), "utf8"), /十二楼/u);
});

test("auto_edit=true 不放开 control；yolo=true 放开 control", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry); registerWriteTools(registry); registerControlTools(registry);
  const callScript = ['```json\n{"tool_calls":[{"tool":"pause_run","args":{}}]}\n```', "好。"];
  project.tool_permissions = { ...project.tool_permissions, auto_edit: true, yolo: false };
  const a = await runChatTurn({ projectRoot, project, registry, modelClient: scriptedClient(callScript), userMessage: "暂停" });
  assert.ok(a.pendingAction, "auto 档 control 仍须确认");
  await clearPendingAction(projectRoot); // 从 chat-store 导入
  project.tool_permissions = { ...project.tool_permissions, yolo: true };
  const fakeServer = { runJobs: new Map([[path.resolve(projectRoot), { status: "running", controller: new AbortController() }]]) };
  const b = await runChatTurn({ projectRoot, project, registry, modelClient: scriptedClient(callScript), userMessage: "暂停", server: fakeServer });
  assert.equal(b.pendingAction, null);
  assert.equal(b.toolEvents[0].tool, "pause_run");
  assert.equal(b.toolEvents[0].ok, true);
});

// ===== §2.4：多工具支持 =====
test("多工具：同一轮多个 read 全部执行并落盘", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry);
  const out = await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient([
      '```json\n{"tool_calls":[{"tool":"get_status","args":{}},{"tool":"list_chapters","args":{}}]}\n```',
      "查完了。"
    ]),
    userMessage: "查状态和章节"
  });
  assert.equal(out.reply, "查完了。");
  assert.equal(out.toolEvents.length, 2);
  assert.equal(out.toolEvents[0].tool, "get_status");
  assert.equal(out.toolEvents[0].ok, true);
  assert.equal(out.toolEvents[1].tool, "list_chapters");
  assert.equal(out.toolEvents[1].ok, true);
  const history = await readHistory(projectRoot);
  const toolMsgs = history.filter((m) => m.role === "tool");
  assert.equal(toolMsgs.length, 2);
  assert.equal(toolMsgs[0].tool, "get_status");
  assert.equal(toolMsgs[1].tool, "list_chapters");
});

test("多工具：read + write 组合 → reads 先执行，write 落 pending，后续工具跳过", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  const out = await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient([
      '```json\n{"tool_calls":[{"tool":"get_status","args":{}},{"tool":"edit_chapter","args":{"chapter_no":1,"find":"六楼","replace":"十二楼","reason":"统一"}},{"tool":"list_chapters","args":{}}]}\n```',
      "已处理。"
    ]),
    userMessage: "查状态，再改楼层"
  });
  // 第一个 get_status 应已执行
  assert.equal(out.toolEvents.length, 3);
  assert.equal(out.toolEvents[0].tool, "get_status");
  assert.equal(out.toolEvents[0].ok, true);
  // 第二个 edit_chapter 落 pending
  assert.equal(out.toolEvents[1].tool, "edit_chapter");
  assert.equal(out.toolEvents[1].ok, true); // pending 时用 ok 标记预览成功
  assert.ok(out.pendingAction);
  // 第三个 list_chapters 应被跳过
  assert.equal(out.toolEvents[2].tool, "list_chapters");
  assert.equal(out.toolEvents[2].ok, false);
  assert.equal(out.toolEvents[2].error, "skipped_after_pending");
  // 历史记录：应有 get_status 的 tool 消息
  const history = await readHistory(projectRoot);
  const toolMsgs = history.filter((m) => m.role === "tool");
  assert.ok(toolMsgs.find((m) => m.tool === "get_status"));
  // 应有 skipped 的记录
  assert.ok(toolMsgs.find((m) => m.tool === "list_chapters" && m.ok === false));
});

// ===== §3.4: generating placeholder + failure message =====

test("runChatTurn writes generating placeholder before agentLoop", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry);
  await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient(["进度是 1/3 章。"]),
    userMessage: "进度如何？"
  });
  const history = await readHistory(projectRoot);
  // 应有: user, generating, assistant
  assert.equal(history.length, 3);
  assert.equal(history[0].role, "user");
  assert.equal(history[1].role, "assistant");
  assert.equal(history[1].status, "generating");
  assert.equal(history[1].content, "");
  assert.ok(history[1].turn_id);
  assert.equal(history[2].role, "assistant");
  assert.ok(!history[2].status || history[2].status !== "generating");
  assert.ok(history[2].content.length > 0);
});

test("runChatTurn writes failure message on agentLoop error", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry);
  const throwingClient = {
    generate: async () => { throw new Error("模型调用超时"); }
  };
  try {
    await runChatTurn({
      projectRoot, project, registry,
      modelClient: throwingClient,
      userMessage: "会出错的消息"
    });
    assert.fail("应抛异常");
  } catch (error) {
    assert.match(error.message, /模型调用超时/u);
  }
  const history = await readHistory(projectRoot);
  // 应有: user, generating, failed assistant
  assert.equal(history.length, 3, `历史应有 3 条，实际 ${history.length}`);
  assert.equal(history[0].role, "user");
  assert.equal(history[1].role, "assistant");
  assert.equal(history[1].status, "generating");
  assert.equal(history[2].role, "assistant");
  assert.equal(history[2].status, "failed");
  assert.match(history[2].content, /本轮失败/u);
  assert.ok(history[2].turn_id);
  // turn_id 应一致
  assert.equal(history[1].turn_id, history[2].turn_id);
});

// ===== §5.1: Transcript 记录 =====

test("appendTranscript 写入 chat_transcript.jsonl", async () => {
  const projectRoot = await makeChatProject();
  const entry = { turn_id: "t1", request_messages: [{ role: "user", content: "hi" }], raw_response: "hello", parsed_tool_calls: [], usage: { calls: 1, cost: 0 } };
  await appendTranscript(projectRoot, entry);
  const filePath = path.join(projectRoot, "chat_transcript.jsonl");
  const content = await fs.readFile(filePath, "utf8");
  const lines = content.trim().split("\n");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.ok(parsed.id);
  assert.ok(parsed.ts);
  assert.equal(parsed.turn_id, "t1");
  assert.equal(parsed.raw_response, "hello");
});

test("appendTranscript 写入失败只 warn 不抛", async () => {
  // 用一个不存在的路径 root 触发写入失败
  const badRoot = path.join(os.tmpdir(), "wwriting-nonexistent-" + Date.now(), "deep");
  const entry = { turn_id: "t1", request_messages: [], raw_response: "x", parsed_tool_calls: [], usage: {} };
  // 不应抛异常
  await appendTranscript(badRoot, entry);
});

test("runChatTurn 后 chat_transcript.jsonl 有记录", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry);
  await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient(["进度是 1/3 章。"]),
    userMessage: "进度如何？"
  });
  const filePath = path.join(projectRoot, "chat_transcript.jsonl");
  const exists = await fs.access(filePath).then(() => true).catch(() => false);
  assert.ok(exists, "transcript 文件应存在");
  const content = await fs.readFile(filePath, "utf8");
  const lines = content.trim().split("\n").filter(Boolean);
  assert.ok(lines.length >= 1, "应有至少 1 条 transcript 记录");
  const parsed = JSON.parse(lines[0]);
  assert.ok(parsed.turn_id);
  assert.ok(parsed.request_messages);
  assert.ok(parsed.raw_response);
  assert.ok(Array.isArray(parsed.parsed_tool_calls));
});
