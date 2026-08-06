// scripts/verify-unified-agent.mjs —— 统一 Agent 内核全量本地验证（Task 11 入口）。
//
// 通过 ProjectAgent 公共接口（src/core/agent/index.mjs）+ mock ModelGateway + 真实
// Shell 运行时验证统一内核的全部本地场景；同时承载被吸收的旧 Task 12 场景与
// 被合并的 fault/longrun/mvp/chat-online 有价值场景。真实模型场景在配置
// DEEPSEEK_API_KEY 时额外执行（可跳过）。
//
// 场景清单（Task 11 Step 2 + Task 9 Step 6）：
//   简单回答无计划 / 复杂任务计划更新 / 同项目 FIFO / 立即同 run id /
//   停止取消 Run 与排队输入 / 重试恢复同一 Run / 跨项目并行 /
//   通用读取编辑 Shell / 章节事务 / 蓝图事务 / 只读审查 /
//   重启 journal 恢复 / legacy 导入幂等 / 新项目无旧状态文件 /
//   确定性导出无模型调用 / 自主 /init 保留原文并读取项目上下文 /
//   普通写入暂停确认 / 同类授权仅限当前输入 / YOLO 跳过普通确认不跳过 extreme /
//   extreme 需要当前精确文字 / Shell 增量输出与脱敏 / 停止中止命令并清除授权
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createProjectAgentHarness,
  createLegacyProjectRoot,
  createProjectRoot,
  createMockModelGateway,
  eventsOfType,
  LEGACY_STATE_FILE,
  readEvents,
  readSession,
  sleep,
  tool,
  waitFor,
  waitForIdle
} from "../tests/helpers/project-agent-harness.mjs";
import { exportBook } from "../src/core/book-export.mjs";
import { parseSimpleYaml } from "../src/core/simple-yaml.mjs";

const SECRET = "ww-secret-token-9f3a";
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}: ${detail}`);
}
function step(name) {
  console.log(`\n【${name}】`);
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

// 等待某个事件出现（含当前最新一次快照）。
async function waitForEvent(agent, projectRoot, type, { timeoutMs = 20000 } = {}) {
  return waitFor(
    agent,
    projectRoot,
    (_session, snapshot) => snapshot.events.some((event) => event.type === type),
    { timeoutMs, describe: `事件 ${type}` }
  );
}

// 驱动到 idle：途中出现的普通确认一律以 allow 应答（用于不关心确认细节的场景）。
async function driveToIdle(agent, projectRoot, { timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { session, events } = await agent.snapshot({ projectRoot, afterSeq: 0, limit: 100000 });
    if (session.status === "idle") return;
    for (const event of events) {
      if (event.type !== "decision_requested") continue;
      const decisionId = event.payload?.decision_id;
      if (typeof decisionId !== "string") continue;
      await agent.decide({ projectRoot, decisionId, choice: "allow" }).catch(() => {});
    }
    await sleep(25);
  }
  throw new Error(`driveToIdle 超时（${timeoutMs}ms）：无法回到 idle`);
}

// ---------------------------------------------------------------------------
// 场景 1：简单回答不需要任务计划
// ---------------------------------------------------------------------------
step("场景 1 · 简单回答不需要任务计划");
{
  const h = await createProjectAgentHarness({ gatewayScript: [{ reply: { text: "好的，我明白了。" } }] });
  try {
    await h.agent.open({ projectRoot: h.projectRoot });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "你好" });
    await waitForIdle(h.agent, h.projectRoot);
    const events = await readEvents(h.agent, h.projectRoot);
    const session = await readSession(h.agent, h.projectRoot);
    assert.equal(session.active_run.status, "completed");
    assert.equal(eventsOfType(events, "plan_updated").length, 0, "简单回答不得创建任务计划");
    assert.equal(eventsOfType(events, "run_completed").length, 1);
    record("简单回答：单 Run 完成且无计划", true, `run=${session.active_run.id}`);
  } finally {
    await h.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 场景 2：复杂任务在真实里程碑更新任务计划
// ---------------------------------------------------------------------------
step("场景 2 · 复杂任务计划更新");
{
  const h = await createProjectAgentHarness({
    gatewayScript: [
      { reply: { toolCalls: [tool("update_plan", { explanation: "先读取章节，再修正冲突", items: [{ step: "检查已有章节", status: "in_progress" }] })] } },
      { reply: { text: "计划已更新，继续处理。" } }
    ]
  });
  try {
    await h.agent.open({ projectRoot: h.projectRoot });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "检查一下第三章是否与设定冲突" });
    await waitForIdle(h.agent, h.projectRoot);
    const events = await readEvents(h.agent, h.projectRoot);
    assert.ok(eventsOfType(events, "plan_updated").length >= 1, "复杂任务应写入 plan_updated");
    const session = await readSession(h.agent, h.projectRoot);
    assert.equal(session.active_run.status, "completed");
    record("复杂任务：计划在真实里程碑更新", true, `plan_updated=${eventsOfType(events, "plan_updated").length}`);
  } finally {
    await h.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 场景 3：同一项目 FIFO 队列（运行中发送排队、同一 run id）
// ---------------------------------------------------------------------------
step("场景 3 · 同项目 FIFO 队列");
{
  const h = await createProjectAgentHarness({
    gatewayScript: [
      async () => { await sleep(400); return { text: "第一轮答复" }; },
      { reply: { text: "第二轮答复" } }
    ],
    gatewayDelayMs: 0
  });
  try {
    await h.agent.open({ projectRoot: h.projectRoot });
    const first = await h.agent.submit({ projectRoot: h.projectRoot, text: "任务一" });
    const second = await h.agent.submit({ projectRoot: h.projectRoot, text: "任务二" });
    assert.equal(second.queued, true, "运行中发送应排队");
    assert.equal(second.run_id, first.run_id, "排队输入沿用同一 Run");
    await waitForIdle(h.agent, h.projectRoot);
    const events = await readEvents(h.agent, h.projectRoot);
    assert.equal(eventsOfType(events, "run_started").length, 1, "排队不创建新 Run");
    assert.equal(eventsOfType(events, "input_consumed").length, 2, "两条输入都被消费");
    record("FIFO：运行中排队、同 run id、顺序消费", true, `run=${first.run_id}`);
  } finally {
    await h.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 场景 4：立即（promote）保持同一 Run id 并打断当前输入
// ---------------------------------------------------------------------------
step("场景 4 · 立即保持同一 Run id");
{
  const h = await createProjectAgentHarness({
    gatewayScript: [
      async () => { await sleep(400); return { text: "被打断的答复" }; },
      { reply: { text: "提升后答复" } }
    ],
    gatewayDelayMs: 0
  });
  try {
    await h.agent.open({ projectRoot: h.projectRoot });
    const first = await h.agent.submit({ projectRoot: h.projectRoot, text: "任务一" });
    const second = await h.agent.submit({ projectRoot: h.projectRoot, text: "任务二" });
    const promoted = await h.agent.promote({ projectRoot: h.projectRoot, inputId: second.input_id });
    assert.equal(promoted.run_id, first.run_id, "立即保持同一 run id");
    assert.equal(promoted.promoted, true);
    await waitForIdle(h.agent, h.projectRoot);
    const events = await readEvents(h.agent, h.projectRoot);
    assert.ok(eventsOfType(events, "input_promoted").length >= 1, "应写入 input_promoted");
    assert.equal(eventsOfType(events, "run_started").length, 1, "立即不创建新 Run");
    record("立即：同 run id 打断并提升", true, `run=${first.run_id}`);
  } finally {
    await h.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 场景 5：停止取消当前 Run 与排队输入
// ---------------------------------------------------------------------------
step("场景 5 · 停止取消 Run 与排队输入");
{
  const h = await createProjectAgentHarness({
    gatewayScript: [async () => { await sleep(600); return { text: "被停止" }; }],
    gatewayDelayMs: 0
  });
  try {
    await h.agent.open({ projectRoot: h.projectRoot });
    const first = await h.agent.submit({ projectRoot: h.projectRoot, text: "任务一" });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "任务二" });
    const stopped = await h.agent.stop({ projectRoot: h.projectRoot, reason: "user_stop" });
    assert.equal(stopped.run_id, first.run_id);
    assert.equal(stopped.cancelled, true);
    const events = await readEvents(h.agent, h.projectRoot);
    assert.ok(eventsOfType(events, "run_cancelled").length >= 1, "应写入 run_cancelled");
    assert.ok(eventsOfType(events, "input_cancelled").length >= 2, "活动与排队输入都应取消");
    const session = await readSession(h.agent, h.projectRoot);
    assert.equal(session.status, "idle");
    record("停止：Run 取消 + 排队输入取消", true, `cancelled inputs=${eventsOfType(events, "input_cancelled").length}`);
  } finally {
    await h.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 场景 6：重试恢复同一可恢复 Run
// ---------------------------------------------------------------------------
step("场景 6 · 重试恢复同一可恢复 Run");
{
  const h = await createProjectAgentHarness({
    gatewayScript: [
      { error: Object.assign(new Error("provider timeout"), { code: "model_error" }) },
      { reply: { text: "重试后成功答复" } }
    ]
  });
  try {
    await h.agent.open({ projectRoot: h.projectRoot });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "写第三章" });
    await waitForEvent(h.agent, h.projectRoot, "run_failed");
    const failed = await readSession(h.agent, h.projectRoot);
    assert.equal(failed.active_run.status, "failed");
    const runId = failed.active_run.id;
    const retried = await h.agent.retry({ projectRoot: h.projectRoot, runId });
    assert.equal(retried.run_id, runId, "重试必须继续同一 Run");
    await waitForIdle(h.agent, h.projectRoot);
    const session = await readSession(h.agent, h.projectRoot);
    assert.equal(session.active_run.id, runId);
    assert.equal(session.active_run.status, "completed");
    record("重试：同一 Run 从 failed 恢复并完成", true, `run=${runId}`);
  } finally {
    await h.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 场景 7：不同项目并行运行
// ---------------------------------------------------------------------------
step("场景 7 · 跨项目并行");
{
  const workspace = await fs.mkdtemp(path.join(process.env.TEMP ?? "/tmp", "wwriting-parallel-"));
  try {
    const { projectRoot: aRoot } = await createProjectRoot(workspace, { slug: "a" });
    const { projectRoot: bRoot } = await createProjectRoot(workspace, { slug: "b" });
    const gatewayA = createMockModelGateway({ script: [async () => { await sleep(500); return { text: "A 完成" }; }], delayMs: 0 });
    const gatewayB = createMockModelGateway({ script: [async () => { await sleep(500); return { text: "B 完成" }; }], delayMs: 0 });
    const { createProjectAgent } = await import("../src/core/agent/index.mjs");
    const agentA = createProjectAgent({ modelGateway: gatewayA });
    const agentB = createProjectAgent({ modelGateway: gatewayB });
    await agentA.open({ projectRoot: aRoot });
    await agentB.open({ projectRoot: bRoot });
    const a = agentA.submit({ projectRoot: aRoot, text: "A 的任务" });
    const b = agentB.submit({ projectRoot: bRoot, text: "B 的任务" });
    await Promise.all([a, b]);
    // 两个 Run 同时处于 running（并行推进，不是串行）
    await sleep(80);
    const midA = await agentA.snapshot({ projectRoot: aRoot, afterSeq: 0, limit: 1 });
    const midB = await agentB.snapshot({ projectRoot: bRoot, afterSeq: 0, limit: 1 });
    assert.equal(midA.session.active_run.status, "running");
    assert.equal(midB.session.active_run.status, "running");
    await waitForIdle(agentA, aRoot);
    await waitForIdle(agentB, bRoot);
    assert.equal(gatewayA.calls.length, 1);
    assert.equal(gatewayB.calls.length, 1);
    record("并行：两个项目各自独立 Run 同时推进", true, "A/B 均完成");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 场景 8：通用读取/编辑/Shell（stub shell 走真实 ToolRuntime）
// ---------------------------------------------------------------------------
step("场景 8 · 通用读取/编辑/Shell");
{
  const h = await createProjectAgentHarness({
    gatewayScript: [
      { reply: { toolCalls: [tool("read_file", { path: "OUTLINE.md" })] } },
      { reply: { toolCalls: [tool("edit_file", { path: "OUTLINE.md", find: "> 蓝图未生成，请运行 /init", replace: "第一章 开端" })] } },
      { reply: { toolCalls: [tool("shell", { command: "echo hello", purpose: "验证 shell" })] } },
      { reply: { text: "全部完成。" } }
    ],
    secrets: [SECRET]
  });
  try {
    await h.agent.open({ projectRoot: h.projectRoot });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "读大纲、改大纲、运行命令" });
    await driveToIdle(h.agent, h.projectRoot);
    const events = await readEvents(h.agent, h.projectRoot);
    const toolCalls = eventsOfType(events, "tool_call_completed");
    const names = toolCalls.map((e) => e.payload?.name);
    assert.ok(names.includes("read_file"), "应执行 read_file");
    assert.ok(names.includes("edit_file"), "应执行 edit_file");
    assert.ok(names.includes("shell"), "应执行 shell");
    const outline = await fs.readFile(path.join(h.projectRoot, "OUTLINE.md"), "utf8");
    assert.ok(outline.includes("第一章 开端"), "edit_file 应写入文件");
    record("通用工具：read/edit/shell 全部执行", true, `tools=${names.join(",")}`);
  } finally {
    await h.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 场景 9：章节事务（草稿 → 提交 → 文件/索引/记忆/checkpoint 一致）
// ---------------------------------------------------------------------------
step("场景 9 · 章节事务");
{
  const script = [];
  const h = await createProjectAgentHarness({ project: { min_words_per_chapter: 10, target_words_per_chapter: 20 }, gatewayScript: script });
  script.push(
    { reply: { toolCalls: [tool("enter_workflow", { workflow: "chapter", reason: "写第一章" })] } },
    { reply: { toolCalls: [tool("append_chapter_segment", { project_id: h.project.project_id, chapter_no: 1, segment_no: 1, content: "雨夜，一封没有署名的信落在门缝里。" })] } },
    { reply: { toolCalls: [tool("commit_chapter", { project_id: h.project.project_id, chapter_no: 1 })] } },
    { reply: { text: "第一章已完成。" } }
  );
  try {
    await h.agent.open({ projectRoot: h.projectRoot });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "写第一章" });
    await waitForIdle(h.agent, h.projectRoot);
    const finalFile = path.join(h.projectRoot, "chapters", "001.md");
    assert.equal(await pathExists(finalFile), true, "正式章节文件应存在");
    const index = JSON.parse(await fs.readFile(path.join(h.projectRoot, "memory", "chapter_index.json"), "utf8"));
    const chapter = index.chapters.find((c) => c.chapter_no === 1);
    assert.ok(chapter, "章节索引应含第 1 章");
    assert.equal(chapter.status, "completed");
    const memory = JSON.parse(await fs.readFile(path.join(h.projectRoot, "memory", "chapter_memory.json"), "utf8"));
    assert.ok(Array.isArray(memory.chapters), "章节记忆应存在");
    const events = await readEvents(h.agent, h.projectRoot);
    assert.ok(eventsOfType(events, "checkpoint_linked").length >= 1, "提交应记录 checkpoint 引用");
    record("章节事务：草稿/门禁/正式文件/索引/记忆/checkpoint 一致", true, `words=${chapter.actual_words}`);
  } finally {
    await h.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 场景 10：蓝图事务（OUTLINE/SETTING/project.yaml 一致提交）
// ---------------------------------------------------------------------------
step("场景 10 · 蓝图事务");
{
  const script = [];
  const h = await createProjectAgentHarness({ gatewayScript: script });
  script.push(
    { reply: { toolCalls: [tool("enter_workflow", { workflow: "init", reason: "/init 项目理解" })] } },
    { reply: { toolCalls: [tool("commit_blueprint", { project_id: h.project.project_id, outline: "# OUTLINE.md\n\n第一章 雨夜来信\n第二章 档案室\n", setting: "# SETTING.md\n\n现代都市，档案管理员林晚。\n", evidence_paths: ["AGENTS.md"] })] } },
    { reply: { text: "/init 完成，蓝图已提交。" } }
  );
  try {
    await h.agent.open({ projectRoot: h.projectRoot });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "/init 都市职场小说，程序员主角" });
    await waitForIdle(h.agent, h.projectRoot);
    const outline = await fs.readFile(path.join(h.projectRoot, "OUTLINE.md"), "utf8");
    const setting = await fs.readFile(path.join(h.projectRoot, "SETTING.md"), "utf8");
    assert.ok(outline.includes("雨夜来信"), "OUTLINE 应写入新内容");
    assert.ok(setting.includes("林晚"), "SETTING 应写入新内容");
    const project = parseSimpleYaml(await fs.readFile(path.join(h.projectRoot, "project.yaml"), "utf8"));
    assert.equal(project.blueprint_status, "complete", "project.yaml 应同步 blueprint_status=complete");
    record("蓝图事务：OUTLINE/SETTING/blueprint_status 一致提交", true, "blueprint_status=complete");
  } finally {
    await h.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 场景 11：只读审查（review workflow 不修改项目文件）
// ---------------------------------------------------------------------------
step("场景 11 · 只读审查");
{
  const h = await createProjectAgentHarness({
    gatewayScript: [
      { reply: { toolCalls: [tool("enter_workflow", { workflow: "review", reason: "审稿" })] } },
      { reply: { toolCalls: [tool("read_file", { path: "OUTLINE.md" })] } },
      { reply: { text: "审查完成：未发现严重冲突。" } }
    ]
  });
  try {
    await h.agent.open({ projectRoot: h.projectRoot });
    const before = await fs.readFile(path.join(h.projectRoot, "OUTLINE.md"), "utf8");
    await h.agent.submit({ projectRoot: h.projectRoot, text: "审查全书设定一致性" });
    await waitForIdle(h.agent, h.projectRoot);
    const after = await fs.readFile(path.join(h.projectRoot, "OUTLINE.md"), "utf8");
    assert.equal(after, before, "审查不得修改项目文件");
    const events = await readEvents(h.agent, h.projectRoot);
    assert.equal(eventsOfType(events, "run_completed").length, 1);
    record("只读审查：review workflow 只读完成", true, "文件未被修改");
  } finally {
    await h.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 场景 12：重启后 journal 恢复（新 agent 实例接续同一 Session）
// ---------------------------------------------------------------------------
step("场景 12 · 重启 journal 恢复");
{
  const h = await createProjectAgentHarness({ gatewayScript: [{ reply: { text: "第一次答复" } }] });
  try {
    await h.agent.open({ projectRoot: h.projectRoot });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "第一个任务" });
    await waitForIdle(h.agent, h.projectRoot);
    const sessionBefore = await readSession(h.agent, h.projectRoot);
    // 新实例 = 模拟应用重启
    const { createProjectAgent } = await import("../src/core/agent/index.mjs");
    const revived = createProjectAgent({ modelGateway: h.gateway });
    await revived.open({ projectRoot: h.projectRoot });
    const sessionAfter = await revived.snapshot({ projectRoot: h.projectRoot, afterSeq: 0, limit: 100000 });
    assert.equal(sessionAfter.session.session_id, sessionBefore.session_id, "重启后 Session 一致");
    assert.equal(sessionAfter.session.status, "idle");
    // 重启后新提交正常创建新 Run
    await revived.submit({ projectRoot: h.projectRoot, text: "重启后任务" });
    await waitForIdle(revived, h.projectRoot);
    const events = await readEvents(revived, h.projectRoot);
    assert.equal(eventsOfType(events, "run_started").length, 2, "重启后提交应创建第二个 Run");
    record("重启恢复：journal 重建同一 Session，继续可用", true, `session=${sessionBefore.session_id}`);
  } finally {
    await h.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 场景 13：legacy 导入幂等 + blueprint_status 迁移
// ---------------------------------------------------------------------------
step("场景 13 · legacy 导入幂等");
{
  const h = await createProjectAgentHarness({ legacy: true, gatewayScript: [] });
  try {
    await h.agent.open({ projectRoot: h.projectRoot });
    const eventsAfterFirst = await readEvents(h.agent, h.projectRoot);
    assert.ok(eventsOfType(eventsAfterFirst, "session_created").length >= 1);
    const project = parseSimpleYaml(await fs.readFile(path.join(h.projectRoot, "project.yaml"), "utf8"));
    assert.ok(["complete", "none", "partial", "legacy"].includes(project.blueprint_status), "blueprint_status 应迁移到 project.yaml");
    // 第二次 open：幂等，不产生重复事件
    await h.agent.open({ projectRoot: h.projectRoot });
    const eventsAfterSecond = await readEvents(h.agent, h.projectRoot);
    assert.equal(eventsAfterSecond.length, eventsAfterFirst.length, "第二次 open 不得产生新事件");
    assert.equal(await pathExists(path.join(h.projectRoot, LEGACY_STATE_FILE)), true, "旧文件保留不删除（只读导入）");
    record("legacy 导入：幂等 + blueprint_status 迁移 + 旧文件保留", true, `blueprint_status=${project.blueprint_status}`);
  } finally {
    await h.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 场景 14：新项目不创建旧状态文件
// ---------------------------------------------------------------------------
step("场景 14 · 新项目无旧状态文件");
{
  const workspace = await fs.mkdtemp(path.join(process.env.TEMP ?? "/tmp", "wwriting-nostate-"));
  try {
    const { projectRoot } = await createProjectRoot(workspace, { slug: "novel" });
    const LEGACY_NAMES = ["agent_state", "task_queue"].map((n) => n + ".json").concat(["failures", "chat_history"].map((n) => n + ".jsonl"));
    for (const name of LEGACY_NAMES) {
      assert.equal(await pathExists(path.join(projectRoot, name)), false, `新项目不得创建 ${name}`);
    }
    const project = parseSimpleYaml(await fs.readFile(path.join(projectRoot, "project.yaml"), "utf8"));
    assert.equal(project.blueprint_status, "none");
    record("新项目：project.yaml 含 blueprint_status=none，无旧状态文件", true, "");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 场景 15：确定性导出不调用模型
// ---------------------------------------------------------------------------
step("场景 15 · 确定性导出");
{
  const script = [];
  const h = await createProjectAgentHarness({ project: { min_words_per_chapter: 10, target_words_per_chapter: 20 }, gatewayScript: script });
  script.push(
    { reply: { toolCalls: [tool("enter_workflow", { workflow: "chapter", reason: "写第一章" })] } },
    { reply: { toolCalls: [tool("append_chapter_segment", { project_id: h.project.project_id, chapter_no: 1, segment_no: 1, content: "雨夜来信的开篇段落，讲述了主角在雨夜收到一封没有署名的信，决定追查寄信人。" })] } },
    { reply: { toolCalls: [tool("commit_chapter", { project_id: h.project.project_id, chapter_no: 1 })] } },
    { reply: { text: "完成" } }
  );
  try {
    await h.agent.open({ projectRoot: h.projectRoot });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "写第一章" });
    await waitForIdle(h.agent, h.projectRoot);
    const callsBefore = h.gateway.calls.length;
    const result = await exportBook(h.projectRoot, { format: "txt" });
    assert.equal(h.gateway.calls.length, callsBefore, "导出不得调用模型");
    assert.equal(await pathExists(result.path), true, "导出文件应存在");
    const content = await fs.readFile(result.path, "utf8");
    assert.ok(content.includes("雨夜来信的开篇段落"), "导出应包含章节正文");
    record("确定性导出：直接 book-export，无模型调用", true, `path=${path.basename(result.path)}`);
  } finally {
    await h.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 场景 16：自主 /init 保留用户原文并自主读取项目上下文
// ---------------------------------------------------------------------------
step("场景 16 · 自主 /init");
{
  const original = "/init 都市职场小说，程序员主角林晚在裁员潮中觉醒";
  const script = [];
  const h = await createProjectAgentHarness({ gatewayScript: script });
  script.push(
    // 模型自主选择读取项目上下文（不固定顺序、无软件预判）
      { reply: { toolCalls: [tool("read_file", { path: "OUTLINE.md" }), tool("read_file", { path: "SETTING.md" })] } },
    { reply: { toolCalls: [tool("commit_blueprint", { project_id: h.project.project_id, outline: "# OUTLINE.md\n\n第一章 裁员名单\n", setting: "# SETTING.md\n\n程序员职场。\n", evidence_paths: [] })] } },
    { reply: { text: "/init 完成，已建立蓝图。" } }
  );
  try {
    await h.agent.open({ projectRoot: h.projectRoot });
    await h.agent.submit({ projectRoot: h.projectRoot, text: original });
    await waitForIdle(h.agent, h.projectRoot);
    const events = await readEvents(h.agent, h.projectRoot);
    const queued = eventsOfType(events, "input_queued");
    assert.ok(queued.length >= 1, "应写入 input_queued");
    assert.equal(queued[0].payload.text, original, "/init 必须保留用户原文");
    const toolCalls = eventsOfType(events, "tool_call_completed");
    const names = toolCalls.map((e) => e.payload?.name);
    assert.ok(names.includes("read_file"), "模型应自主读取项目上下文");
    assert.ok(names.includes("commit_blueprint"), "模型应自主提交蓝图");
    assert.equal(eventsOfType(events, "run_completed").length, 1, "/init 使用同一个 Agent 循环");
    record("/init：保留原文 + 自主读取 + 单循环完成", true, `tools=${names.join(",")}`);
  } finally {
    await h.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 场景 17：普通写入暂停等待确认
// ---------------------------------------------------------------------------
step("场景 17 · 普通写入暂停确认");
{
  const h = await createProjectAgentHarness({
    gatewayScript: [
      { reply: { toolCalls: [tool("write_file", { path: "notes.md", content: "一段需要确认的笔记" })] } },
      { reply: { text: "写入完成。" } }
    ]
  });
  try {
    await h.agent.open({ projectRoot: h.projectRoot });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "帮我写一份笔记" });
    await waitForEvent(h.agent, h.projectRoot, "decision_requested");
    const session = await readSession(h.agent, h.projectRoot);
    assert.equal(session.status, "waiting_user", "确认期间会话应等待用户");
    const events = await readEvents(h.agent, h.projectRoot);
    const decision = eventsOfType(events, "decision_requested")[0].payload;
    assert.equal(decision.name, "write_file");
    await h.agent.decide({ projectRoot: h.projectRoot, decisionId: decision.decision_id, choice: "allow" });
    await waitForIdle(h.agent, h.projectRoot);
    assert.equal(await pathExists(path.join(h.projectRoot, "notes.md")), true, "允许后应写入文件");
    record("普通写入：decision 暂停 → allow 继续", true, `decision=${decision.decision_id}`);
  } finally {
    await h.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 场景 18：同类授权只作用于当前输入（grant 绑定 active_input_id）
// ---------------------------------------------------------------------------
step("场景 18 · 同类授权仅限当前输入");
{
  const h = await createProjectAgentHarness({
    gatewayScript: [
      // 输入 1：第一次 write_file → 确认 allow_input；第二次 write_file 自动执行
      { reply: { toolCalls: [tool("write_file", { path: "a.txt", content: "A" })] } },
      { reply: { toolCalls: [tool("write_file", { path: "b.txt", content: "B" })] } },
      { reply: { text: "输入 1 完成" } },
      // 输入 2：又一次 write_file → 必须重新确认（授权不跨输入）
      { reply: { toolCalls: [tool("write_file", { path: "c.txt", content: "C" })] } },
      { reply: { text: "输入 2 完成" } }
    ]
  });
  try {
    await h.agent.open({ projectRoot: h.projectRoot });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "任务一" });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "任务二" });
    await waitForEvent(h.agent, h.projectRoot, "decision_requested");
    const firstDecision = (await readEvents(h.agent, h.projectRoot)).filter((e) => e.type === "decision_requested")[0].payload;
    await h.agent.decide({ projectRoot: h.projectRoot, decisionId: firstDecision.decision_id, choice: "allow_input" });
    // 等待输入 1 完成、输入 2 的第一个写操作再次请求确认（waitFor 不 await 异步
    // 谓词，这里用同步轮询）
    const pollDeadline = Date.now() + 20000;
    let decisionCount = 0;
    while (Date.now() < pollDeadline) {
      const { events } = await h.agent.snapshot({ projectRoot: h.projectRoot, afterSeq: 0, limit: 100000 });
      decisionCount = eventsOfType(events, "decision_requested").length;
      if (decisionCount >= 2) break;
      await sleep(25);
    }
    assert.equal(decisionCount, 2, "第二个输入的写操作必须重新确认");
    const all = await readEvents(h.agent, h.projectRoot);
    const decisions = eventsOfType(all, "decision_requested").map((e) => e.payload);
    assert.ok(eventsOfType(all, "permission_grant_created").length >= 1, "allow_input 应创建临时 grant");
    assert.ok(eventsOfType(all, "permission_grant_cleared").length >= 1, "输入完成后 grant 应清除");
    await h.agent.decide({ projectRoot: h.projectRoot, decisionId: decisions[1].decision_id, choice: "allow" });
    await waitForIdle(h.agent, h.projectRoot);
    assert.equal(await pathExists(path.join(h.projectRoot, "a.txt")), true);
    assert.equal(await pathExists(path.join(h.projectRoot, "b.txt")), true, "同类授权应自动执行第二个写操作");
    assert.equal(await pathExists(path.join(h.projectRoot, "c.txt")), true);
    record("同类授权：allow_input 仅作用于当前输入", true, "决策数=2（跨输入必须重新确认）");
  } finally {
    await h.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 场景 19：YOLO 跳过普通确认但不跳过 extreme
// ---------------------------------------------------------------------------
step("场景 19 · YOLO 模式");
{
  const h = await createProjectAgentHarness({
    project: { tool_permissions: { yolo: true, auto_edit: false, safe_edit: true, read_only: false } },
    gatewayScript: [
      // 普通写：YOLO 下自动执行，无确认
      { reply: { toolCalls: [tool("write_file", { path: "yolo-notes.md", content: "YOLO 写入" })] } },
      // extreme 命令：YOLO 也不能绕过
      { reply: { toolCalls: [tool("shell", { command: "rm -rf /", purpose: "extreme 测试" })] } },
      { reply: { text: "YOLO 场景完成" } }
    ]
  });
  try {
    await h.agent.open({ projectRoot: h.projectRoot });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "YOLO 模式测试" });
    // 普通写自动执行后，extreme 命令应请求确认
    await waitForEvent(h.agent, h.projectRoot, "decision_requested");
    const events = await readEvents(h.agent, h.projectRoot);
    const decisions = eventsOfType(events, "decision_requested").map((e) => e.payload);
    assert.equal(decisions.length, 1, "YOLO 下只有 extreme 需要确认");
    assert.equal(decisions[0].kind, "extreme");
    assert.equal(await pathExists(path.join(h.projectRoot, "yolo-notes.md")), true, "YOLO 应自动执行普通写入");
    // extreme 只接受精确文字（deny 也会被拒）；以停止收敛 Run，等同用户拒绝
    const stopped = await h.agent.stop({ projectRoot: h.projectRoot, reason: "user_stop" });
    assert.equal(stopped.cancelled, true);
    record("YOLO：跳过普通确认，extreme 仍要确认", true, "kind=extreme");
  } finally {
    await h.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 场景 20：extreme 需要当前决策的精确文字
// ---------------------------------------------------------------------------
step("场景 20 · extreme 精确文字确认");
{
  const h = await createProjectAgentHarness({
    gatewayScript: [
      // stub shell（不产生真实进程）：extreme 判定只来自风险语料，命令本身不执行
      { reply: { toolCalls: [tool("shell", { command: "rm -rf /", purpose: "extreme 测试" })] } },
      { reply: { text: "已执行。" } }
    ]
  });
  try {
    await h.agent.open({ projectRoot: h.projectRoot });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "执行删除测试" });
    await waitForEvent(h.agent, h.projectRoot, "decision_requested");
    const decision = (await readEvents(h.agent, h.projectRoot)).filter((e) => e.type === "decision_requested").at(-1).payload;
    assert.equal(decision.kind, "extreme");
    // 错误文字 → confirmation_mismatch
    await assert.rejects(
      h.agent.decide({ projectRoot: h.projectRoot, decisionId: decision.decision_id, choice: "随便写的文字" }),
      (error) => error.code === "confirmation_mismatch",
      "错误确认文字必须被拒绝"
    );
    // 精确文字 → 执行
    await h.agent.decide({ projectRoot: h.projectRoot, decisionId: decision.decision_id, choice: decision.confirmation_text });
    await waitForIdle(h.agent, h.projectRoot);
    const events = await readEvents(h.agent, h.projectRoot);
    const resolved = eventsOfType(events, "decision_resolved");
    assert.equal(resolved.length, 1, "精确文字应使决策成功解析");
    record("extreme：错误文字拒绝，精确文字执行", true, `text=${decision.confirmation_text}`);
  } finally {
    await h.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 场景 21：Shell 增量输出 + 命令/输出脱敏（真实 Shell）
// ---------------------------------------------------------------------------
step("场景 21 · Shell 增量输出与脱敏");
{
  const secret = "ww-secret-9f3a7c";
  const command = `node -e "console.log('start');console.log('${secret}');setTimeout(()=>console.log('done'),200)"`;
  const h = await createProjectAgentHarness({
    gatewayScript: [
      { reply: { toolCalls: [tool("shell", { command, purpose: "输出脱敏验证" })] } },
      { reply: { text: "命令完成。" } }
    ],
    realShell: true,
    secrets: [secret]
  });
  try {
    await h.agent.open({ projectRoot: h.projectRoot });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "运行输出脱敏测试命令" });
    await driveToIdle(h.agent, h.projectRoot);
    const events = await readEvents(h.agent, h.projectRoot);
    const deltas = eventsOfType(events, "tool_output_delta");
    assert.ok(deltas.length >= 2, "应产生增量输出事件");
    const outputs = deltas.map((e) => JSON.stringify(e.payload)).join("\n");
    assert.ok(!outputs.includes(secret), "journal 中的输出不得包含密钥");
    assert.ok(outputs.includes("[REDACTED]"), "密钥应被脱敏标记");
    const completed = eventsOfType(events, "tool_call_completed").map((e) => e.payload);
    const shellCall = completed.find((c) => c.name === "shell");
    assert.ok(shellCall, "shell 工具应完成");
    assert.ok(!JSON.stringify(shellCall).includes(secret), "工具结果同样脱敏");
    record("Shell 增量输出 + 脱敏", true, `deltas=${deltas.length}（密钥已脱敏）`);
  } finally {
    await h.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 场景 22：停止中止正在运行的命令并清除授权
// ---------------------------------------------------------------------------
step("场景 22 · 停止中止命令并清除授权");
{
  const h = await createProjectAgentHarness({
    gatewayScript: [
      { reply: { toolCalls: [tool("write_file", { path: "pre.txt", content: "先写入" })] } },
      { reply: { toolCalls: [tool("shell", { command: "node -e \"setTimeout(()=>{},30000)\"", purpose: "长命令" })] } },
      { reply: { text: "不会到达" } }
    ],
    realShell: true
  });
  try {
    await h.agent.open({ projectRoot: h.projectRoot });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "启动长命令" });
    // 写文件先确认（allow_input：同类写入授权，与 shell 无关）
    await waitForEvent(h.agent, h.projectRoot, "decision_requested");
    const firstDecision = (await readEvents(h.agent, h.projectRoot)).filter((e) => e.type === "decision_requested")[0].payload;
    assert.equal(firstDecision.name, "write_file");
    await h.agent.decide({ projectRoot: h.projectRoot, decisionId: firstDecision.decision_id, choice: "allow_input" });
    // shell 自身仍需确认：等待第二个决策并允许
    const pollDeadline = Date.now() + 20000;
    let shellDecision = null;
    while (Date.now() < pollDeadline) {
      const { events } = await h.agent.snapshot({ projectRoot: h.projectRoot, afterSeq: 0, limit: 100000 });
      const pending = eventsOfType(events, "decision_requested").map((e) => e.payload);
      shellDecision = pending.find((d) => d.name === "shell") ?? null;
      if (shellDecision) break;
      await sleep(25);
    }
    assert.ok(shellDecision, "shell 命令应请求确认");
    await h.agent.decide({ projectRoot: h.projectRoot, decisionId: shellDecision.decision_id, choice: "allow" });
    // 等待 shell 工具真正启动
    await waitFor(h.agent, h.projectRoot, (_s, snapshot) =>
      snapshot.events.some((e) => e.type === "tool_call_started" && e.payload?.name === "shell"),
      { describe: "shell 工具启动" }
    );
    const started = await readSession(h.agent, h.projectRoot);
    assert.equal(started.active_run.status, "running");
    const stopped = await h.agent.stop({ projectRoot: h.projectRoot, reason: "user_stop" });
    assert.equal(stopped.cancelled, true);
    const events = await readEvents(h.agent, h.projectRoot);
    assert.ok(eventsOfType(events, "run_cancelled").length >= 1);
    const cleared = eventsOfType(events, "permission_grant_cleared");
    assert.ok(cleared.length >= 1, "停止必须清除该输入的全部 grant");
    const session = await readSession(h.agent, h.projectRoot);
    assert.equal(session.active_run.active_grants.length, 0, "停止后不得残留 grant");
    record("停止：中止运行命令 + 清除 grant", true, `grant_cleared=${cleared.length}`);
  } finally {
    await h.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 可选：真实模型短流程（verify-chat-online 有价值场景并入；未配置时跳过）
// ---------------------------------------------------------------------------
step("可选 · 真实模型短流程（DEEPSEEK_API_KEY 已配置）");
if (process.env.DEEPSEEK_API_KEY) {
  const workspace = await fs.mkdtemp(path.join(process.env.TEMP ?? "/tmp", "wwriting-online-"));
  try {
    const { createProjectAgent } = await import("../src/core/agent/index.mjs");
    const { createModelGateway } = await import("../src/core/model/gateway.mjs");
    const { OpenAICompatibleAdapter } = await import("../src/core/model/openai-compatible.mjs");
    const { runShellCommand } = await import("../src/core/shell/runtime.mjs");
    const { CostTracker } = await import("../src/core/cost-tracker.mjs");
    const { projectRoot } = await createProjectRoot(workspace, { slug: "novel" });
    const gateway = createModelGateway({
      adapter: new OpenAICompatibleAdapter({ apiKeyEnv: "DEEPSEEK_API_KEY" }),
      retryMax: 2,
      timeoutMs: 120000,
      totalDeadlineMs: 240000,
      costTracker: new CostTracker()
    });
    const agent = createProjectAgent({ modelGateway: gateway, shell: runShellCommand });
    await agent.open({ projectRoot });
    // /init 原文保留 + 普通对话
    await agent.submit({ projectRoot, text: "/init 短流程验证：只读项目结构并简要说明即可" });
    await waitForIdle(agent, projectRoot, { timeoutMs: 180000 });
    await agent.submit({ projectRoot, text: "项目里有哪些文件？简单列出即可" });
    await waitForIdle(agent, projectRoot, { timeoutMs: 180000 });
    const events = await readEvents(agent, projectRoot);
    assert.ok(eventsOfType(events, "run_completed").length >= 2, "真实模型两轮都应完成");
    record("真实模型：/init 保留原文 + 普通对话完成", true, `runs=${eventsOfType(events, "run_completed").length}`);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
} else {
  console.log("  - 未配置 DEEPSEEK_API_KEY，真实模型场景跳过（可选）。");
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log(`\n=== verify:unified-agent 汇总：${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length > 0) {
  for (const f of failed) console.log(`  ✗ ${f.name}: ${f.detail}`);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, scenarios: results.map((r) => r.name) }, null, 2));
