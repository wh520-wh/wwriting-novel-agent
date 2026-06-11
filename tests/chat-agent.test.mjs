import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildChatContext } from "../src/core/chat/chat-context.mjs";
import { appendChatMessage } from "../src/core/chat/chat-store.mjs";
import { createToolRegistry } from "../src/core/chat/tool-registry.mjs";
import { registerReadTools } from "../src/core/chat/tools-read.mjs";
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

test("历史超 20 条折叠为提要", async () => {
  const projectRoot = await makeProject();
  for (let i = 0; i < 30; i += 1) await appendChatMessage(projectRoot, { role: "user", content: `历史消息${i}` });
  const registry = createToolRegistry();
  const project = await loadProject(projectRoot);
  const { messages } = await buildChatContext({ projectRoot, project, registry, userMessage: "新消息" });
  const digest = messages.find((m) => m.role === "system" && m.content.includes("早前对话提要"));
  assert.ok(digest);
  assert.match(digest.content, /历史消息0/u);
  const fullHistory = messages.filter((m) => m.content?.startsWith?.("历史消息") && !m.content.includes("提要"));
  assert.equal(fullHistory.length, 20);
});

import { runChatTurn, resumeChatTurn } from "../src/core/chat/chat-agent.mjs";
import { registerWriteTools } from "../src/core/chat/tools-write.mjs";
import { loadPendingAction, readChatHistory as readHistory } from "../src/core/chat/chat-store.mjs";
import { upsertChapter } from "../src/core/project-store.mjs";

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
  assert.deepEqual(history.map((m) => m.role), ["user", "assistant"]);
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

test("maxToolRounds 护栏", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry);
  const loopForever = '```json\n{"tool_calls":[{"tool":"get_status","args":{}}]}\n```';
  const out = await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient(Array(20).fill(loopForever)),
    userMessage: "随便"
  });
  assert.match(out.reply, /上限/u);
  assert.equal(out.toolEvents.length, 8);
});

test("已有 pending_action 时新消息被挡", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient(['```json\n{"tool_calls":[{"tool":"edit_chapter","args":{"chapter_no":1,"find":"六楼","replace":"五楼","reason":"x"}}]}\n```']),
    userMessage: "改"
  });
  const blocked = await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient(["should not be called"]),
    userMessage: "再改点别的"
  });
  assert.match(blocked.reply, /待确认/u);
  assert.ok(blocked.pendingAction);
});
