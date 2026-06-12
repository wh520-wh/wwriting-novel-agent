// tests/chat-tool-args.test.mjs
// tool 消息必须带 args 摘要（JSON 字符串，截断 200），供前端人话标签/溯源 chips 使用。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runChatTurn } from "../src/core/chat/chat-agent.mjs";
import { readChatHistory } from "../src/core/chat/chat-store.mjs";
import { createToolRegistry, summarizeArgs } from "../src/core/chat/tool-registry.mjs";
import { registerReadTools } from "../src/core/chat/tools-read.mjs";
import { createProject, loadProject, upsertChapter } from "../src/core/project-store.mjs";

function scriptedClient(script) {
  let i = 0;
  return { generate: async () => ({ text: script[Math.min(i++, script.length - 1)], usageReport: {}, costSummary: { estimatedCost: 0 } }) };
}

async function makeChatProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-args-"));
  const { projectRoot } = await createProject(root, {
    slug: "a", title: "args 测试", story_seed: "种子",
    target_chapters: 3, min_words_per_chapter: 10, target_words_per_chapter: 12
  });
  const chapterPath = path.join(projectRoot, "chapters", "001.md");
  await fs.mkdir(path.dirname(chapterPath), { recursive: true });
  await fs.writeFile(chapterPath, "# Chapter 001\n\n刘康从六楼坠落。", "utf8");
  await upsertChapter(projectRoot, { chapter_no: 1, status: "completed", final_path: chapterPath, actual_words: 8 });
  return projectRoot;
}

test("summarizeArgs 已导出且截断 200 字符", () => {
  assert.equal(summarizeArgs({ chapter_no: 1 }), '{"chapter_no":1}');
  const long = summarizeArgs({ find: "甲".repeat(300) });
  assert.ok(long.length <= 201, String(long.length)); // 200 + 截断省略号
  assert.ok(long.endsWith("…"));
});

test("读工具执行后历史里的 tool 消息带 args", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry);
  await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient([
      '```json\n{"tool_calls":[{"tool":"read_chapter","args":{"chapter_no":1}}]}\n```',
      "第 1 章讲坠楼。"
    ]),
    userMessage: "第一章讲什么？"
  });
  const history = await readChatHistory(projectRoot);
  const toolMsg = history.find((m) => m.role === "tool");
  assert.ok(toolMsg, "应有 tool 消息");
  assert.equal(toolMsg.args, '{"chapter_no":1}');
});

test("权限拒绝分支的 tool 消息同样带 args", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  project.tool_permissions = { read_only: true };
  const registry = createToolRegistry();
  registerReadTools(registry);
  registry.register({
    name: "fake_write", kind: "write", description: "测试写工具", params: {},
    run: async () => ({ done: true })
  });
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
  assert.ok(toolMsg);
  assert.equal(toolMsg.ok, false);
  assert.equal(toolMsg.args, '{"x":1}');
});
