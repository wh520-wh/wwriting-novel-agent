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
