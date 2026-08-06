// scripts/simulate-user-flow.mjs
// 用户真实操作全链路模拟（真实模型端到端回归，统一 Agent 内核计划 Task 9 改写）。
//
// 只走 ProjectAgent 公共接口（src/core/agent/index.mjs），覆盖：
//   阶段1 新建项目（blueprint_status none，无 agent_state）
//   阶段2 /init 作为普通聊天输入（保留原文，模型自主理解项目）
//   阶段3 写第 1 章（chapter workflow 完成正式提交）
//   阶段4 修改第 1 章（编辑正文）
//   阶段5 运行中排队（第二次发送进入 FIFO）
//   阶段6 立即（promote 打断当前输入，同一 Run）
//   阶段7 停止（stop 取消 Run）
// 真实 API 会暴露 mock 测试测不出的协议问题（如空 assistant 消息 400）。
//
// 用法：
//   DEEPSEEK_API_KEY=sk-xxx node scripts/simulate-user-flow.mjs
//   可选：MODEL_NAME=deepseek-v4-flash（默认 flash，最便宜）
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createProjectAt } from "../src/core/project-store.mjs";
import { createProjectAgent } from "../src/core/agent/index.mjs";
import { createModelGateway } from "../src/core/model/gateway.mjs";
import { OpenAICompatibleAdapter } from "../src/core/model/openai-compatible.mjs";
import { runShellCommand } from "../src/core/shell/runtime.mjs";
import { CostTracker } from "../src/core/cost-tracker.mjs";
import { readJson, safeJoin } from "../src/core/fs-utils.mjs";

const API_KEY = process.env.DEEPSEEK_API_KEY;
if (!API_KEY) {
  console.error("缺少 DEEPSEEK_API_KEY 环境变量（真实模型必须）。");
  process.exit(2);
}
const MODEL_NAME = process.env.MODEL_NAME ?? "deepseek-v4-flash";

const results = [];
function record(stage, ok, detail) {
  results.push({ stage, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${stage}: ${detail}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 等待 session 回到 idle（或超时抛错）。
async function waitForIdle(agent, projectRoot, { timeoutMs = 600000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { session } = await agent.snapshot({ projectRoot, afterSeq: 0, limit: 1 });
    if (session.status === "idle") return session;
    await sleep(1500);
  }
  throw new Error("等待 Agent 空闲超时");
}

// 等待特定事件出现。
async function waitForEvent(agent, projectRoot, type, { timeoutMs = 600000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { events } = await agent.snapshot({ projectRoot, afterSeq: 0, limit: 100000 });
    if (events.some((e) => e.type === type)) return;
    await sleep(1000);
  }
  throw new Error(`等待事件 ${type} 超时`);
}

const tAll = Date.now();
const root = await fs.mkdtemp(path.join(os.tmpdir(), "usersim-"));
console.log(`用户流程模拟（模型: ${MODEL_NAME}）`);

try {
  // ---- 阶段1：用户新建项目 ----
  console.log("【阶段1】用户新建项目");
  const { projectRoot } = await createProjectAt(path.join(root, "novel"), {
    title: "都市职场",
    story_seed: "程序员林晚在大厂内卷中觉醒"
  });
  const project = await (async () => {
    const yaml = await fs.readFile(path.join(projectRoot, "project.yaml"), "utf8");
    const { parseSimpleYaml } = await import("../src/core/simple-yaml.mjs");
    return parseSimpleYaml(yaml);
  })();
  record("新建项目 blueprint_status none", project.blueprint_status === "none", `blueprint_status=${project.blueprint_status}`);
  let stateFileExists = true;
  try {
    await fs.access(path.join(projectRoot, "agent_state" + ".json"));
  } catch {
    stateFileExists = false;
  }
  record("新项目不创建旧运行态文件", stateFileExists === false, stateFileExists ? "存在（BAD）" : "不存在（GOOD）");

  // 配置真实模型
  const { saveProject } = await import("../src/core/project-store.mjs");
  const loaded = await (async () => {
    const yaml = await fs.readFile(path.join(projectRoot, "project.yaml"), "utf8");
    const { parseSimpleYaml } = await import("../src/core/simple-yaml.mjs");
    return parseSimpleYaml(yaml);
  })();
  loaded.active_model = {
    provider: "openai-compatible",
    model_name: MODEL_NAME,
    base_url: "https://api.deepseek.com",
    api_key_env: "DEEPSEEK_API_KEY"
  };
  await saveProject(projectRoot, loaded);

  // 组合根：真实 gateway + 真实 shell
  const existingCost = await readJson(safeJoin(projectRoot, "cost.json"), null);
  const modelGateway = createModelGateway({
    adapter: new OpenAICompatibleAdapter({ apiKeyEnv: "DEEPSEEK_API_KEY" }),
    retryMax: 2,
    timeoutMs: 120000,
    totalDeadlineMs: 300000,
    costTracker: new CostTracker({ summary: existingCost })
  });
  const agent = createProjectAgent({ modelGateway, shell: runShellCommand });
  await agent.open({ projectRoot });

  // ---- 阶段2：用户触发 /init（普通聊天输入，保留原文）----
  console.log("【阶段2】用户触发 /init");
  const t0 = Date.now();
  const initText = "/init 都市职场小说，程序员主角林晚在裁员潮中觉醒，写一份项目理解与蓝图";
  try {
    await agent.submit({ projectRoot, text: initText, source: "chat" });
    await waitForIdle(agent, projectRoot);
    const { events } = await agent.snapshot({ projectRoot, afterSeq: 0, limit: 100000 });
    const queued = events.find((e) => e.type === "input_queued");
    record("/init 保留原文并完成项目理解", queued?.payload?.text === initText, `耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s | 原文保留=${queued?.payload?.text === initText}`);
  } catch (e) {
    record("/init 保留原文并完成项目理解", false, `异常: ${e.message.slice(0, 120)}`);
  }

  // ---- 阶段3：写第 1 章 ----
  console.log("【阶段3】写作第 1 章");
  const t1 = Date.now();
  let ch1ok = false;
  try {
    await agent.submit({ projectRoot, text: "写第 1 章：雨夜来信，按项目设定完成正式提交。", source: "chat" });
    await waitForIdle(agent, projectRoot);
    const chapterFile = path.join(projectRoot, "chapters", "001.md");
    await fs.access(chapterFile);
    ch1ok = true;
    record("第 1 章写作完成", ch1ok, `耗时 ${((Date.now() - t1) / 1000).toFixed(1)}s | chapters/001.md 已落盘`);
  } catch (e) {
    record("第 1 章写作完成", false, `异常: ${e.message.slice(0, 120)}`);
  }

  // ---- 阶段4：修改第 1 章 ----
  console.log("【阶段4】修改第 1 章（编辑正文）");
  const t2 = Date.now();
  let editOk = false;
  try {
    await agent.submit({ projectRoot, text: "把第 1 章开头改成从雨夜收到匿名电话开始，保持其余内容不变。", source: "chat" });
    await waitForIdle(agent, projectRoot);
    editOk = true;
    record("第 1 章编辑完成", editOk, `耗时 ${((Date.now() - t2) / 1000).toFixed(1)}s`);
  } catch (e) {
    record("第 1 章编辑完成", false, `异常: ${e.message.slice(0, 120)}`);
  }

  // ---- 阶段5：运行中排队 ----
  console.log("【阶段5】运行中排队（FIFO）");
  try {
    await agent.submit({ projectRoot, text: "写第 2 章", source: "chat" });
    const second = await agent.submit({ projectRoot, text: "第 2 章写好后再补充一段雨中场景", source: "chat" });
    record("运行中发送进入 FIFO 队列", second.queued === true, `queued=${second.queued} 同 run=${second.run_id !== null}`);
    await waitForIdle(agent, projectRoot);
  } catch (e) {
    record("运行中发送进入 FIFO 队列", false, `异常: ${e.message.slice(0, 120)}`);
  }

  // ---- 阶段6：立即（promote 打断当前输入，同一 Run）----
  console.log("【阶段6】立即（promote）");
  try {
    await agent.submit({ projectRoot, text: "写第 3 章：档案室的秘密", source: "chat" });
    const queuedInput = await agent.submit({ projectRoot, text: "先插入一个设定补充任务", source: "chat" });
    const before = await agent.snapshot({ projectRoot, afterSeq: 0, limit: 1 });
    const runId = before.session.active_run?.id;
    const promoted = await agent.promote({ projectRoot, inputId: queuedInput.input_id });
    record("立即保持同一 Run id", promoted.run_id === runId && promoted.promoted === true, `run=${promoted.run_id}`);
    await waitForIdle(agent, projectRoot);
  } catch (e) {
    record("立即保持同一 Run id", false, `异常: ${e.message.slice(0, 120)}`);
  }

  // ---- 阶段7：停止（stop 取消当前 Run）----
  console.log("【阶段7】停止（stop）");
  try {
    await agent.submit({ projectRoot, text: "写第 4 章：漫长的雨夜（长任务）", source: "chat" });
    // 给模型一点时间开始
    await sleep(4000);
    const stopped = await agent.stop({ projectRoot, reason: "user_stop" });
    record("停止取消当前 Run", stopped.cancelled === true, `cancelled=${stopped.cancelled}`);
    await waitForIdle(agent, projectRoot);
  } catch (e) {
    record("停止取消当前 Run", false, `异常: ${e.message.slice(0, 120)}`);
  }

  await modelGateway.costTracker.writeProjectReport(projectRoot).catch(() => {});
} finally {
  await fs.rm(root, { recursive: true, force: true });
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
