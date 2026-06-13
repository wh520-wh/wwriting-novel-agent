// tests/chat-agent-cancel.test.mjs
// 中断语义：轮间/模型调用中可停；已开始的工具不打断；落「（已停止。）」并返回 cancelled。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runChatTurn } from "../src/core/chat/chat-agent.mjs";
import { readChatHistory } from "../src/core/chat/chat-store.mjs";
import { createToolRegistry } from "../src/core/chat/tool-registry.mjs";
import { registerReadTools } from "../src/core/chat/tools-read.mjs";
import { createProject, loadProject } from "../src/core/project-store.mjs";

async function makeProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-cancel-"));
  const { projectRoot } = await createProject(root, {
    slug: "c", title: "取消测试", story_seed: "种子",
    target_chapters: 3, min_words_per_chapter: 10, target_words_per_chapter: 12
  });
  return projectRoot;
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

test("发起前已 abort：不调模型，直接落「（已停止。）」", async () => {
  const projectRoot = await makeProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry);
  const controller = new AbortController();
  controller.abort("用户停止");
  let generateCalls = 0;
  const out = await runChatTurn({
    projectRoot, project, registry, signal: controller.signal,
    modelClient: { generate: async () => { generateCalls += 1; return { text: "不应到达", costSummary: { estimatedCost: 0 } }; } },
    userMessage: "你好"
  });
  assert.equal(out.cancelled, true);
  assert.equal(generateCalls, 0);
  const history = await readChatHistory(projectRoot);
  assert.equal(history.at(-1).content, "（已停止。）");
  assert.equal(history.at(-1).role, "assistant");
});

test("模型调用进行中 abort：generate 抛 AbortError，循环落「（已停止。）」", async () => {
  const projectRoot = await makeProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry);
  const controller = new AbortController();
  const modelClient = {
    generate: ({ signal }) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })
  };
  const turn = runChatTurn({
    projectRoot, project, registry, signal: controller.signal, modelClient, userMessage: "慢问题"
  });
  await delay(50);
  controller.abort("用户停止");
  const out = await turn;
  assert.equal(out.cancelled, true);
  const history = await readChatHistory(projectRoot);
  assert.equal(history.at(-1).content, "（已停止。）");
});

test("工具执行中 abort：工具跑完不被打断，工具结果落盘后才停", async () => {
  const projectRoot = await makeProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  let toolFinished = false;
  registry.register({
    name: "slow_read", kind: "read", description: "慢读", params: {},
    run: async () => { await delay(150); toolFinished = true; return { done: true }; }
  });
  const controller = new AbortController();
  let round = 0;
  const modelClient = {
    generate: async () => {
      round += 1;
      if (round === 1) return { text: '```json\n{"tool_calls":[{"tool":"slow_read","args":{}}]}\n```', costSummary: { estimatedCost: 0 } };
      return { text: "第二轮文本（不应作为最终回复，因为已 abort）", costSummary: { estimatedCost: 0 } };
    }
  };
  const turn = runChatTurn({ projectRoot, project, registry, signal: controller.signal, modelClient, userMessage: "查一下" });
  await delay(50); // 此刻第一轮 generate 已返回，slow_read 执行中
  controller.abort("用户停止");
  const out = await turn;
  assert.equal(toolFinished, true, "已开始的工具必须执行完");
  assert.equal(out.cancelled, true);
  const history = await readChatHistory(projectRoot);
  const roles = history.map((m) => m.role);
  assert.ok(roles.includes("tool"), "工具结果应已落盘");
  assert.equal(history.at(-1).content, "（已停止。）");
});

test("不传 signal 行为完全不变（回归）", async () => {
  const projectRoot = await makeProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry);
  const out = await runChatTurn({
    projectRoot, project, registry,
    modelClient: { generate: async () => ({ text: "正常回复。", costSummary: { estimatedCost: 0 } }) },
    userMessage: "你好"
  });
  assert.equal(out.reply, "正常回复。");
  assert.equal(out.cancelled, undefined);
});
