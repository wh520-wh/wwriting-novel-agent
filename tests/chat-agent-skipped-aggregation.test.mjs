// Task 3: SKIPPED 循环修复 —— 连续 SKIPPED 后端聚合（spec §2.2 + §2.3-U1 P2-9）。
//
// 协议：事件层面（toolEvents）保持逐条 skipped_after_pending（不回归），
// 落盘层面聚合成一条 batch_skipped 消息（"N 个后续操作已跳过（待前序确认）：..."），
// 历史回放 / UI 重载看到的都是聚合后的一条。
// 另验证 system prompt 新增"写/控制后不再同轮发其他工具"约束（治本，减少 SKIPPED 产生）。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runChatTurn } from "../src/core/chat/chat-agent.mjs";
import { buildChatContext } from "../src/core/chat/chat-context.mjs";
import { createToolRegistry } from "../src/core/chat/tool-registry.mjs";
import { registerReadTools } from "../src/core/chat/tools-read.mjs";
import { registerWriteTools } from "../src/core/chat/tools-write.mjs";
import { readChatHistory } from "../src/core/chat/chat-store.mjs";
import { loadProject, upsertChapter } from "../src/core/project-store.mjs";
import { createWritingProject } from "./helpers.mjs";

function scriptedClient(script) {
  let i = 0;
  return {
    generate: async () => ({ text: script[Math.min(i++, script.length - 1)], usageReport: {}, costSummary: { estimatedCost: 0 } })
  };
}

async function makeChatProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-skipped-"));
  const { projectRoot } = await createWritingProject(root, {
    slug: "s", title: "跳过聚合", story_seed: "种子",
    target_chapters: 3, min_words_per_chapter: 10, target_words_per_chapter: 12
  });
  const chapterPath = path.join(projectRoot, "chapters", "001.md");
  await fs.mkdir(path.dirname(chapterPath), { recursive: true });
  await fs.writeFile(chapterPath, "# Chapter 001\n\n刘康从六楼坠落。", "utf8");
  await upsertChapter(projectRoot, { chapter_no: 1, status: "completed", final_path: chapterPath, actual_words: 8 });
  return projectRoot;
}

function makeRegistry() {
  const registry = createToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  return registry;
}

test("连续 SKIPPED 聚合成一条 batch_skipped 落盘（事件层面仍逐条）", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const registry = makeRegistry();
  const out = await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient([
      '```json\n{"tool_calls":[{"tool":"edit_chapter","args":{"chapter_no":1,"find":"六楼","replace":"十二楼","reason":"统一"}},{"tool":"list_chapters","args":{}},{"tool":"read_chapter","args":{"chapter_no":1}},{"tool":"get_status","args":{}}]}\n```'
    ]),
    userMessage: "改楼层，然后读一下章节和状态"
  });
  // 事件层面：write 后 3 个 read 仍逐条 skipped_after_pending（不改跳过决策）
  assert.ok(out.pendingAction, "write 工具仍落 pending");
  assert.equal(out.pendingAction.tool, "edit_chapter");
  assert.equal(out.toolEvents.length, 4);
  const skipped = out.toolEvents.filter((e) => e.error === "skipped_after_pending");
  assert.equal(skipped.length, 3, "事件层面 3 个后续工具逐条 skipped_after_pending");
  assert.deepEqual(skipped.map((e) => e.tool), ["list_chapters", "read_chapter", "get_status"]);

  // 落盘层面：tool 消息只有 1 条聚合消息（不是 4 条逐条）
  const history = await readChatHistory(projectRoot);
  const toolMsgs = history.filter((m) => m.role === "tool");
  assert.equal(toolMsgs.length, 1, "落盘 tool 消息应只有聚合的 1 条");
  assert.equal(toolMsgs[0].tool, "batch_skipped");
  assert.equal(toolMsgs[0].ok, false);
  assert.match(toolMsgs[0].result_summary, /3 个后续操作已跳过/u);
  assert.match(toolMsgs[0].result_summary, /list_chapters, read_chapter, get_status/u);
});

test("不回归：write 后单个后续工具仍 skipped_after_pending（事件层面）+ 落盘聚合", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const registry = makeRegistry();
  const out = await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient([
      '```json\n{"tool_calls":[{"tool":"get_status","args":{}},{"tool":"edit_chapter","args":{"chapter_no":1,"find":"六楼","replace":"十二楼","reason":"统一"}},{"tool":"list_chapters","args":{}}]}\n```',
      "已处理。"
    ]),
    userMessage: "查状态，再改楼层"
  });
  // 事件层面与原测试一致（tests/chat-agent.test.mjs:515 不回归）
  assert.equal(out.toolEvents.length, 3);
  assert.equal(out.toolEvents[0].tool, "get_status");
  assert.equal(out.toolEvents[0].ok, true);
  assert.equal(out.toolEvents[1].tool, "edit_chapter");
  assert.equal(out.toolEvents[1].ok, true);
  assert.ok(out.pendingAction);
  assert.equal(out.toolEvents[2].tool, "list_chapters");
  assert.equal(out.toolEvents[2].ok, false);
  assert.equal(out.toolEvents[2].error, "skipped_after_pending");
  // 落盘：get_status 一条 + 聚合跳过一条（没有逐条 SKIPPED 消息）
  const history = await readChatHistory(projectRoot);
  const toolMsgs = history.filter((m) => m.role === "tool");
  assert.equal(toolMsgs.length, 2);
  assert.equal(toolMsgs[0].tool, "get_status");
  assert.equal(toolMsgs[0].ok, true);
  const skippedMsg = toolMsgs.find((m) => m.tool === "batch_skipped");
  assert.ok(skippedMsg, "SKIPPED 应聚合为一条 batch_skipped");
  assert.equal(skippedMsg.ok, false);
  assert.match(skippedMsg.result_summary, /1 个后续操作已跳过/u);
  assert.match(skippedMsg.result_summary, /list_chapters/u);
});

test("纯 read 轮（无 SKIPPED）不产生 batch_skipped 聚合消息", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const registry = makeRegistry();
  const out = await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient([
      '```json\n{"tool_calls":[{"tool":"get_status","args":{}},{"tool":"list_chapters","args":{}}]}\n```',
      "查完了。"
    ]),
    userMessage: "查状态和章节"
  });
  assert.equal(out.pendingAction, null);
  assert.equal(out.toolEvents.length, 2);
  assert.ok(out.toolEvents.every((e) => e.ok === true));
  const history = await readChatHistory(projectRoot);
  const toolMsgs = history.filter((m) => m.role === "tool");
  assert.equal(toolMsgs.length, 2);
  assert.ok(!toolMsgs.some((m) => m.tool === "batch_skipped"), "无跳过时不得落盘聚合消息");
});

test("system prompt 含「写/控制后不再同轮发其他工具」约束", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const registry = makeRegistry();
  const { messages } = await buildChatContext({ projectRoot, project, registry, userMessage: "hi" });
  const system = messages[0].content;
  assert.match(system, /发起写\/控制类工具后，不要再在同一轮发起其他工具/u);
  assert.match(system, /等本轮写工具确认后再发/u);
});
