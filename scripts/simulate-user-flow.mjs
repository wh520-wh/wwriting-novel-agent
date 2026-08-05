// scripts/simulate-user-flow.mjs
// 用户真实操作全链路模拟（真实模型端到端回归）。
//
// 用途：模拟用户在产品里的完整操作序列，验证"中间有没有阻断"：
//   阶段1 新建项目（blueprint_status none，写作不再被拒）
//   阶段2 /init 经 chat agent 展开并完成项目理解
//   阶段3 写作第 1 章（runProject 完整流程：drafting → fact-check → 落盘）
//   阶段4 连续写作第 2 章（续写链路）
//   阶段5 chat 对话触发读工具（get_status / list_chapters / read_blueprint）
//   阶段6 chat 写工具链路（update_blueprint → pending 确认 → approve → 骨架打勾）
//
// 用法：
//   DEEPSEEK_API_KEY=sk-xxx node scripts/simulate-user-flow.mjs
//   可选：MODEL_NAME=deepseek-v4-flash（默认 flash，最便宜）
//
// ★ 维护义务（硬性要求）：
//   修改核心链路代码（project-store / chat-agent / chat-command-expander / agent-engine /
//   tool-registry / prompt 注入 / 写作准备态 / 跑偏核对）后，必须同步更新本脚本并跑通验证，
//   保证用户真实调用可用。真实 API 会暴露 mock 测试测不出的协议问题
//   （如空 assistant 消息 400、模型输出格式漂移），本脚本是最后防线。
//
// 已知风险（真实测试 2026-08-04 记录）：
//   - Flash 模型（deepseek-v4-flash）在写章循环可能把工具名/提示词字段复述进正文，
//     被 non_prose_output 检测拦截多次后 blocked（model_output_invalid）。
//     第 1 章通常成功，续写章可能触发；属模型协议适配问题，非代码 bug。
//   - 修复记录：agent-transcript.mjs appendAssistant 曾把模型空响应写入历史，
//     导致 DeepSeek API 400（Invalid assistant message）——已修复（空响应跳过入史）。

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createProjectAt, loadState, saveProject, loadProject, loadChapterIndex } from "../src/core/project-store.mjs";
import { runProject } from "../src/core/agent-engine.mjs";
import { runChatTurn, resumeChatTurn } from "../src/core/chat/chat-agent.mjs";
import { ModelClient } from "../src/core/model-client.mjs";
import { OpenAICompatibleAdapter } from "../src/core/provider-adapters.mjs";
import { createToolRegistry } from "../src/core/chat/tool-registry.mjs";
import { registerReadTools } from "../src/core/chat/tools-read.mjs";
import { registerWriteTools } from "../src/core/chat/tools-write.mjs";
import { makeChapterContract } from "../src/core/task-contract.mjs";
import { readEvents } from "../src/core/event-log.mjs";

const API_KEY = process.env.DEEPSEEK_API_KEY;
if (!API_KEY) {
  console.error("缺少 DEEPSEEK_API_KEY 环境变量（真实模型必须）。");
  process.exit(2);
}
const MODEL_NAME = process.env.MODEL_NAME ?? "deepseek-v4-flash";

function client() {
  return new ModelClient({
    adapters: { "openai-compatible": new OpenAICompatibleAdapter() },
    timeoutMs: 120000,
    totalDeadlineMs: 300000
  });
}

async function readyProject(p) {
  const project = await loadProject(p);
  project.active_model = {
    provider: "openai-compatible",
    model_name: MODEL_NAME,
    base_url: "https://api.deepseek.com",
    api_key_env: "DEEPSEEK_API_KEY"
  };
  await saveProject(p, project);
  return project;
}

const results = [];
function record(stage, ok, detail) {
  results.push({ stage, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${stage}: ${detail}`);
}

const tAll = Date.now();
const root = await fs.mkdtemp(path.join(os.tmpdir(), "usersim-"));
console.log(`用户流程模拟（模型: ${MODEL_NAME}）`);

// ---- 阶段1：用户新建项目 ----
console.log("【阶段1】用户新建项目");
const { projectRoot } = await createProjectAt(root, { title: "都市职场", slug: "u", story_seed: "程序员林晚在大厂内卷中觉醒" });
let s = await loadState(projectRoot);
const gateOk = s.blueprint_status === "none";
record("新建项目默认 blueprint_status none（写作不再被门禁拒绝）", gateOk, `blueprint_status=${s.blueprint_status}`);
const project = await readyProject(projectRoot);

// chat 工具注册表（阶段2 /init、阶段5/6 chat 链路共用）
const registry = createToolRegistry();
registerReadTools(registry);
registerWriteTools(registry);

// ---- 阶段2：用户触发 /init（经 chat agent 展开）----
console.log("【阶段2】用户触发 /init");
const t0 = Date.now();
let initOk = false;
try {
  const { expandChatCommand } = await import("../src/core/chat/chat-command-expander.mjs");
  const expanded = expandChatCommand({ command: "init", message: "/init 都市职场小说，程序员主角", args: "都市职场小说，程序员主角" });
  let initTurn = await runChatTurn({ projectRoot, project, registry, modelClient: client(), userMessage: expanded.userMessage, modelInstruction: expanded.modelInstruction });
  let resumed = 0;
  while (initTurn.pendingAction && resumed < 3) {
    initTurn = await resumeChatTurn({ projectRoot, project, registry, modelClient: client(), decision: "once" });
    resumed += 1;
  }
  const created = await Promise.all(
    ["OUTLINE.md", "SETTING.md", "AGENTS.md"].map(async (f) => {
      try { await fs.access(path.join(projectRoot, f)); return true; } catch { return false; }
    })
  );
  const createdCount = created.filter(Boolean).length;
  initOk = Boolean(initTurn.reply) && (initTurn.toolEvents ?? []).every((e) => e.ok !== false) && createdCount > 0;
  record("/init 经 chat agent 展开并完成项目理解", initOk, `耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s | 蓝图文件=${createdCount}/3 | 工具=${(initTurn.toolEvents ?? []).map((e) => e.tool).join(",")}`);
} catch (e) {
  record("/init 经 chat agent 展开并完成项目理解", false, `异常: ${e.message.slice(0, 120)}`);
}

// ---- 阶段3：用户点「写第 1 章」----
console.log("【阶段3】写作第 1 章");
const t1 = Date.now();
let ch1ok = false;
try {
  const r1 = await runProject(projectRoot, { modelClient: client(), contract: makeChapterContract(1) });
  ch1ok = r1.completed_chapters?.includes(1) || r1.task_completed === true;
  record("第 1 章写作完成", ch1ok, `耗时 ${((Date.now() - t1) / 1000).toFixed(1)}s | outcome=${r1.outcome} blocked=${r1.blocked ?? false}`);
} catch (e) {
  record("第 1 章写作完成", false, `异常: ${e.message.slice(0, 120)}`);
}

// ---- 阶段4：连续写作第 2 章 ----
console.log("【阶段4】写作第 2 章（连续写作）");
const t2 = Date.now();
let ch2ok = false;
try {
  const r2 = await runProject(projectRoot, { modelClient: client(), contract: makeChapterContract(2) });
  ch2ok = Boolean(r2.completed_chapters?.includes(2)) || r2.task_completed === true;
  record("第 2 章连续写作", ch2ok, `耗时 ${((Date.now() - t2) / 1000).toFixed(1)}s | outcome=${r2.outcome} blocked=${r2.blocked ?? false}${r2.reason ? ` reason=${r2.reason}` : ""}`);
} catch (e) {
  record("第 2 章连续写作", false, `异常: ${e.message.slice(0, 120)}`);
}

// ---- 阶段5：chat 读工具链路 ----
console.log("【阶段5】chat 对话（读工具）");
let chat1ok = false;
try {
  const t3 = Date.now();
  const chat1 = await runChatTurn({
    projectRoot, project, registry, modelClient: client(),
    userMessage: "这本书现在写到哪了？帮我看看大纲里第一卷的规划"
  });
  const tools = chat1.toolEvents?.map((e) => e.tool) ?? [];
  chat1ok = chat1.toolEvents?.length > 0 && chat1.toolEvents.every((e) => e.ok !== false) && Boolean(chat1.reply);
  record("chat 读工具链路", chat1ok, `耗时 ${((Date.now() - t3) / 1000).toFixed(1)}s | 工具=${tools.join(",")}`);
} catch (e) {
  record("chat 读工具链路", false, `异常: ${e.message.slice(0, 120)}`);
}

// ---- 阶段6：chat 写工具 pending 链路 ----
console.log("【阶段6】chat 写工具（pending → approve）");
let chat2ok = false;
try {
  const t4 = Date.now();
  const chat2 = await runChatTurn({
    projectRoot, project, registry, modelClient: client(),
    userMessage: "把第1章在蓝图骨架里标记为已完成，用 update_blueprint 的 check_segment"
  });
  if (chat2.pendingAction) {
    const resumed = await resumeChatTurn({ projectRoot, project, registry, modelClient: client(), decision: "once" });
    const outline = await fs.readFile(path.join(projectRoot, "OUTLINE.md"), "utf8");
    chat2ok = /\[x\] 第1章/.test(outline) && Boolean(resumed.reply);
    record("chat 写工具 pending/approve", chat2ok, `耗时 ${((Date.now() - t4) / 1000).toFixed(1)}s | 骨架打勾=${/\[x\] 第1章/.test(outline)}`);
  } else {
    record("chat 写工具 pending/approve", false, "模型未发起写工具（无 pending）");
  }
} catch (e) {
  record("chat 写工具 pending/approve", false, `异常: ${e.message.slice(0, 120)}`);
}

// ---- 汇总 ----
const failed = results.filter((r) => !r.ok);
console.log(`\n=== 汇总：${results.length - failed.length}/${results.length} 阶段通过，总耗时 ${((Date.now() - tAll) / 1000).toFixed(1)}s ===`);
if (failed.length > 0) {
  console.log("未通过阶段：");
  for (const f of failed) console.log(`  ✗ ${f.stage}: ${f.detail}`);
  process.exit(1);
}
console.log("全链路通过（真实模型）。");
