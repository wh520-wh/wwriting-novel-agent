// scripts/verify-unified-agent.mjs —— 统一 Agent 内核全量本地验证（Task 11 入口）。
//
// 通过 ProjectAgent 公共接口（src/core/agent/index.mjs）+ mock ModelGateway + 真实
// Shell 运行时验证统一内核的全部本地场景；同时承载被吸收的旧 Task 12 场景与
// 被合并的 fault/longrun/mvp/chat-online 有价值场景。真实模型场景在配置
// DEEPSEEK_API_KEY 时额外执行（可跳过）。
//
// 场景清单（Task 11 Step 2 本地矩阵的 25 个场景，Task 9 Step 6 版 22 场景补全后）：
//   简单回答无计划 / 复杂任务真实里程碑更新计划 / 同项目 FIFO 队列 /
//   立即保持同一 run id / 停止取消当前 Run 与排队输入 / 重试恢复同一可恢复 Run /
//   跨项目并行 / 通用读取编辑 Shell / 章节事务 / init 蓝图门禁移除 / 只读审查 /
//   重启 journal 恢复 / legacy 导入幂等 + blueprint_status 迁移 /
//   legacy 旧状态一次性导入且永不再次写入 / 新项目无旧状态文件 /
//   无撕裂原子写入 / 确定性导出无模型调用 / 自主 /init 读取目录并创建 WWRITING.md /
//   普通写入暂停确认 / 同类授权仅限当前输入（grant 随输入清除）/ YOLO 跳过普通
//   确认但不跳过 extreme / fresh 精确文字确认不可复用且不可模型提供 /
//   Shell cwd/超时/增量输出/进程树停止与 1 MiB 流尾（runtime.test.mjs 承载）/
//   命令、参数、分块流式密钥、最终输出与 journal 详情全量脱敏 /
//   同一活动合并而不重复渲染；私有推理永不渲染 / 900px 共享内容列与统一
//   Composer 菜单视口钳制在 cutover 后保留 / 停止中止命令并清除授权
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
  openPlainFolderHarness,
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
      { reply: { toolCalls: [tool("update_plan", { explanation: "先读取章节，再修正冲突", items: [{ id: "inspect", step: "检查已有章节", status: "in_progress" }] })] } },
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
    const { createWorkspaceStore } = await import("../src/core/workspaces/store.mjs");
    const store = createWorkspaceStore({ stateRoot: path.join(workspace, "user-data") });
    const agentA = createProjectAgent({ modelGateway: gatewayA, agentStorageRootFor: (root) => store.agentRootFor(root) });
    const agentB = createProjectAgent({ modelGateway: gatewayB, agentStorageRootFor: (root) => store.agentRootFor(root) });
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

// 通过全部内置技能 reviewing 门禁的章节正文（suspense-ending/chapter-opening/
// dialogue-ratio/ai-voice 都要 passed；短占位文已不能通过 Task 12 门禁）。
const GATE_PASSING_CHAPTER = "雨夜，雨声突然变大。林深猛地推开门，冲进老宅的客厅。他浑身湿透，抹了一把脸，低声道：“信上说，老宅的钟会在午夜敲十三下。”烛光下，墙上的照片里竟是多年不见的父亲。他正要细看，门外却传来一阵急促的敲门声。";

// ---------------------------------------------------------------------------
// 场景 9：章节事务（草稿 → 提交 → 文件/索引/记忆/checkpoint 一致）
// ---------------------------------------------------------------------------
step("场景 9 · 章节事务");
{
  const script = [];
  const h = await createProjectAgentHarness({ project: { min_words_per_chapter: 10, target_words_per_chapter: 20 }, gatewayScript: script });
  script.push(
    { reply: { toolCalls: [tool("enter_workflow", { workflow: "chapter", reason: "写第一章" })] } },
    { reply: { toolCalls: [tool("append_chapter_segment", { project_id: h.project.project_id, chapter_no: 1, segment_no: 1, content: GATE_PASSING_CHAPTER })] } },
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
// 场景 10：init 不再暴露蓝图提交（commit_blueprint 被运行层拒绝，无固定蓝图门禁）
// ---------------------------------------------------------------------------
step("场景 10 · init 蓝图门禁移除");
{
  const script = [];
  const h = await createProjectAgentHarness({ gatewayScript: script });
  script.push(
    { reply: { toolCalls: [tool("enter_workflow", { workflow: "init", reason: "/init 项目理解" })] } },
    // 模型即使尝试旧蓝图提交，init 工作流也不再暴露 commit_blueprint：
    // 运行层 allowed_tool_names 强制拒绝，不写 OUTLINE/SETTING/project.yaml
    { reply: { toolCalls: [tool("commit_blueprint", { project_id: h.project.project_id, outline: "# OUTLINE.md\n\n第一章 雨夜来信\n", setting: "# SETTING.md\n\n现代都市。\n", evidence_paths: [] })] } },
    { reply: { text: "/init 完成，已维护项目记忆。" } }
  );
  try {
    await h.agent.open({ projectRoot: h.projectRoot });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "/init 都市职场小说，程序员主角" });
    await waitForIdle(h.agent, h.projectRoot);
    const events = await readEvents(h.agent, h.projectRoot);
    const failed = eventsOfType(events, "tool_call_failed").filter((event) => event.payload.name === "commit_blueprint");
    assert.equal(failed.length, 1, "init 工作流调用 commit_blueprint 必须失败");
    assert.equal(failed[0].payload.error, "tool_not_allowed", "拒绝原因必须是运行层工具白名单");
    assert.equal(
      eventsOfType(events, "tool_call_completed").filter((event) => event.payload.name === "commit_blueprint").length,
      0,
      "commit_blueprint 不得完成"
    );
    const outline = await fs.readFile(path.join(h.projectRoot, "OUTLINE.md"), "utf8");
    assert.ok(outline.includes("> 蓝图未生成，请运行 /init"), "init 不得改写 OUTLINE.md");
    const project = parseSimpleYaml(await fs.readFile(path.join(h.projectRoot, "project.yaml"), "utf8"));
    assert.equal(project.blueprint_status, "none", "init 不得写入 blueprint_status=complete");
    assert.equal(eventsOfType(events, "run_completed").length, 1, "拒绝后 Run 正常完成，不阻塞普通写作");
    record("init：蓝图提交被运行层拒绝，不生成固定蓝图", true, "tool_not_allowed");
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
    const revived = createProjectAgent({ modelGateway: h.gateway, agentStorageRootFor: (root) => h.store.agentRootFor(root) });
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
    // 旧状态文件保留（只读导入），且完整跑一轮后不再被写入
    const legacyStatePath = path.join(h.projectRoot, LEGACY_STATE_FILE);
    assert.equal(await pathExists(legacyStatePath), true, "旧文件保留不删除（只读导入）");
    const stateBefore = await fs.readFile(legacyStatePath, "utf8");
    await h.agent.submit({ projectRoot: h.projectRoot, text: "导入后继续写作" });
    await waitForIdle(h.agent, h.projectRoot);
    const stateAfter = await fs.readFile(legacyStatePath, "utf8");
    assert.equal(stateAfter, stateBefore, "legacy 导入后完整跑一轮也不得再写入旧状态文件");
    record("legacy 导入：幂等 + blueprint_status 迁移 + 旧文件只读保留", true, `blueprint_status=${project.blueprint_status}`);
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
    { reply: { toolCalls: [tool("append_chapter_segment", { project_id: h.project.project_id, chapter_no: 1, segment_no: 1, content: GATE_PASSING_CHAPTER })] } },
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
    assert.ok(content.includes("老宅的钟会在午夜敲十三下"), "导出应包含章节正文");
    record("确定性导出：直接 book-export，无模型调用", true, `path=${path.basename(result.path)}`);
  } finally {
    await h.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 场景 16：自主 /init 在空目录用通用文件工具创建 WWRITING.md（无固定蓝图门禁）
// ---------------------------------------------------------------------------
step("场景 16 · 自主 /init");
{
  const original = "/init 都市职场小说，程序员主角林晚在裁员潮中觉醒";
  const h = await openPlainFolderHarness({
    gatewayScript: [
      // 模型自主读取目录，用普通通用工具创建/更新 WWRITING.md（不进入旧蓝图流程）
      { reply: { toolCalls: [tool("list_files", { path: "." })] } },
      { reply: { toolCalls: [tool("write_file", { path: "WWRITING.md", content: "# WWriting 项目记忆\n\n## 项目定位\n\n- 项目：都市职场小说\n" })] } },
      { reply: { text: "/init 完成，已建立项目记忆。" } }
    ]
  });
  try {
    await h.agent.submit({ projectRoot: h.projectRoot, text: original });
    await waitForIdle(h.agent, h.projectRoot);
    const events = await readEvents(h.agent, h.projectRoot);
    const queued = eventsOfType(events, "input_queued");
    assert.ok(queued.length >= 1, "应写入 input_queued");
    assert.equal(queued[0].payload.text, original, "/init 必须保留用户原文");
    const toolCalls = eventsOfType(events, "tool_call_completed");
    const names = toolCalls.map((e) => e.payload?.name);
    assert.ok(names.includes("list_files"), "模型应先读取目录");
    assert.ok(names.includes("write_file"), "模型应用 write_file 创建 WWRITING.md");
    assert.equal(eventsOfType(events, "run_completed").length, 1, "/init 使用同一个 Agent 循环");
    assert.equal(await pathExists(path.join(h.projectRoot, "WWRITING.md")), true, "应创建 WWRITING.md");
    for (const name of ["project.yaml", "OUTLINE.md", "SETTING.md", "AGENTS.md"]) {
      assert.equal(await pathExists(path.join(h.projectRoot, name)), false, `不得创建固定蓝图 ${name}`);
    }
    record("/init：保留原文 + 读取目录 + 创建 WWRITING.md + 无固定蓝图", true, `tools=${names.join(",")}`);
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
// 场景 20：extreme 需要当前决策的精确文字，且历史文字不可复用
// ---------------------------------------------------------------------------
step("场景 20 · extreme 精确文字确认与不可复用");
{
  const h = await createProjectAgentHarness({
    gatewayScript: [
      // stub shell（不产生真实进程）：extreme 判定只来自风险语料，命令本身不执行
      { reply: { toolCalls: [tool("shell", { command: "rm -rf /", purpose: "extreme 测试一" })] } },
      { reply: { toolCalls: [tool("shell", { command: "rm -rf $HOME", purpose: "extreme 测试二" })] } },
      { reply: { text: "已执行。" } }
    ]
  });
  try {
    await h.agent.open({ projectRoot: h.projectRoot });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "执行删除测试" });
    // 第一个 extreme 决策
    await waitForEvent(h.agent, h.projectRoot, "decision_requested");
    const first = (await readEvents(h.agent, h.projectRoot)).filter((e) => e.type === "decision_requested")[0].payload;
    assert.equal(first.kind, "extreme");
    // 错误文字 → confirmation_mismatch
    await assert.rejects(
      h.agent.decide({ projectRoot: h.projectRoot, decisionId: first.decision_id, choice: "随便写的文字" }),
      (error) => error.code === "confirmation_mismatch",
      "错误确认文字必须被拒绝"
    );
    // 精确文字 → 执行
    await h.agent.decide({ projectRoot: h.projectRoot, decisionId: first.decision_id, choice: first.confirmation_text });
    // 第二个 extreme 决策：必须生成全新文字，历史文字不能解锁
    const pollDeadline = Date.now() + 20000;
    let second = null;
    while (Date.now() < pollDeadline) {
      const { events } = await h.agent.snapshot({ projectRoot: h.projectRoot, afterSeq: 0, limit: 100000 });
      const decisions = eventsOfType(events, "decision_requested").map((e) => e.payload);
      if (decisions.length >= 2) {
        second = decisions[1];
        break;
      }
      await sleep(25);
    }
    assert.ok(second, "第二个 extreme 决策应出现");
    assert.notEqual(second.confirmation_text, first.confirmation_text, "每个 extreme 动作必须生成全新的确认文字");
    await assert.rejects(
      h.agent.decide({ projectRoot: h.projectRoot, decisionId: second.decision_id, choice: first.confirmation_text }),
      (error) => error.code === "confirmation_mismatch",
      "历史确认文字不得解锁新的 extreme 动作"
    );
    await h.agent.decide({ projectRoot: h.projectRoot, decisionId: second.decision_id, choice: second.confirmation_text });
    await waitForIdle(h.agent, h.projectRoot);
    const events = await readEvents(h.agent, h.projectRoot);
    const resolved = eventsOfType(events, "decision_resolved");
    assert.equal(resolved.length, 2, "两个决策都应成功解析");
    assert.equal(
      eventsOfType(events, "tool_call_completed").filter((e) => e.payload?.name === "shell").length,
      2,
      "精确文字确认后两个 extreme 命令都应执行"
    );
    record("extreme：错误文字拒绝、历史文字不可复用、精确文字执行", true, "决策数=2");
  } finally {
    await h.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 场景 21：Shell 增量输出 + 命令/参数/分块密钥/最终输出/journal 详情全量脱敏
// ---------------------------------------------------------------------------
step("场景 21 · Shell 增量输出与全量脱敏");
{
  const secret = "ww-secret-9f3a7c";
  // 命令文本本身包含完整密钥（命令侧脱敏）；输出按 chunk 拆分密钥
  //（流式脱敏：首行整段打印，随后两行分别打印前半/后半，跨 chunk 拼接）。
  const command =
    `node -e "console.log('head ${secret} tail');setTimeout(function(){console.log('p1 ${secret.slice(0, 5)}');console.log('p2 ${secret.slice(5)}')},80)"`;
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
    const journalText = events.map((e) => JSON.stringify(e)).join("\n");
    assert.ok(!journalText.includes(secret), "journal 任何事件（命令/参数/增量/结果/详情）都不得包含密钥");
    const deltas = eventsOfType(events, "tool_output_delta");
    assert.ok(deltas.length >= 2, "应产生增量输出事件");
    assert.ok(
      deltas.map((e) => JSON.stringify(e.payload)).join("\n").includes("[REDACTED]"),
      "流式输出中的密钥（含跨 chunk 拆分）应被脱敏标记"
    );
    const started = eventsOfType(events, "tool_call_started").map((e) => e.payload).find((c) => c.name === "shell");
    assert.ok(started, "shell 工具应开始");
    assert.ok(JSON.stringify(started).includes("[REDACTED]"), "命令/参数侧脱敏应生效");
    assert.ok(!JSON.stringify(started).includes(secret), "started 事件的 command/args 不得含密钥");
    const completed = eventsOfType(events, "tool_call_completed").map((e) => e.payload).find((c) => c.name === "shell");
    assert.ok(completed, "shell 工具应完成");
    assert.ok(!JSON.stringify(completed).includes(secret), "最终输出同样脱敏");
    record("Shell 全量脱敏：命令/参数/分块流/最终输出/journal 详情", true, `deltas=${deltas.length}`);
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
// 场景 23：无撕裂原子写入（session.json = 临时文件 + rename；events.jsonl 行完整）
// ---------------------------------------------------------------------------
step("场景 23 · 无撕裂原子写入");
{
  const h = await createProjectAgentHarness({
    gatewayScript: [
      { reply: { toolCalls: [tool("read_file", { path: "OUTLINE.md" })] } },
      { reply: { text: "第一轮完成" } },
      { reply: { toolCalls: [tool("read_file", { path: "project.yaml" })] } },
      { reply: { text: "第二轮完成" } }
    ],
    // 每轮模型调用延迟 150ms（共 4 轮）+ read_file 执行时间：运行窗口约 0.7s，
    // 轮询间隔 4ms 约产生 150+ 次采样。sawRunning 断言理论上存在 flake 可能，
    // 但 4ms 采样密度下在完整 running 窗口内一次都读不到的概率可忽略；若未来
    // 硬件/调度退化导致 flake，优先加长 gatewayDelayMs 而不是放宽断言——该断言
    // 保证「观察确实发生在写入活跃期」，是撕裂检测成立的前提。
    gatewayDelayMs: 150
  });
  try {
    await h.agent.open({ projectRoot: h.projectRoot });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "多轮任务" });
    const agentDir = h.agentRoot;
    const sessionPath = path.join(agentDir, "session.json");
    // 运行中高频轮询 session.json：任何时刻都必须读到完整 JSON（原子重写，无撕裂）
    const pollDeadline = Date.now() + 20000;
    let reads = 0;
    let sawRunning = false;
    while (Date.now() < pollDeadline) {
      const raw = await fs.readFile(sessionPath, "utf8").catch(() => null);
      if (raw !== null) {
        reads += 1;
        const parsed = JSON.parse(raw); // 撕裂写入会在这里抛错
        if (parsed?.status === "running") sawRunning = true;
      }
      const session = await readSession(h.agent, h.projectRoot);
      if (session.status === "idle") break;
      await sleep(4);
    }
    assert.ok(reads > 0, "运行期间应能持续读到 session.json");
    assert.ok(sawRunning, "应观察到 running 状态的 session 投影");
    await waitForIdle(h.agent, h.projectRoot);
    // 事件文件每行都是完整 JSON 且 seq 严格连续（无中间缺口、无撕裂行）
    const eventsRaw = await fs.readFile(path.join(agentDir, "events.jsonl"), "utf8");
    const lines = eventsRaw.split("\n").filter((line) => line.trim() !== "");
    let prevSeq = 0;
    for (const line of lines) {
      const event = JSON.parse(line); // 中间缺口/半行会在这里抛错
      assert.ok(Number.isInteger(event.seq) && event.seq === prevSeq + 1, "事件 seq 必须连续无缺口");
      prevSeq = event.seq;
    }
    // 原子写入不得残留临时文件
    const leftovers = (await fs.readdir(agentDir)).filter((name) => name.endsWith(".tmp"));
    assert.equal(leftovers.length, 0, "原子写入后不得残留临时文件");
    record("原子写入：运行中 session.json 无撕裂、事件行完整且 seq 连续、无 tmp 残留", true, `reads=${reads}`);
  } finally {
    await h.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 场景 24：真实端到端——活动合并、助手气泡（最终回复文本上屏）、私有推理零泄漏
// ---------------------------------------------------------------------------
step("场景 24 · 活动合并与私有推理排除");
{
  // 最小 DOM mock（无 JSDOM，与 agent-surface.test.mjs 同一风格）。只经公共 seam
  // src/app-shell/agent/index.js 驱动 AgentSurface（依赖规则测试的要求）。
  class MockElement {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this._parent = null;
      this._text = "";
      this._innerHTML = "";
      this.dataset = {};
      this.style = {};
      this._attrs = {};
      this._listeners = new Map();
      this._value = "";
      this.hidden = false;
      this.disabled = false;
      this.open = false;
      this.scrollTop = 0;
      this.scrollHeight = 0;
      this.clientHeight = 0;
      const classes = new Set();
      let className = "";
      Object.defineProperty(this, "className", {
        get() { return className; },
        set(value) {
          className = String(value ?? "");
          classes.clear();
          for (const item of className.split(/\s+/u).filter(Boolean)) classes.add(item);
        },
        enumerable: true,
        configurable: true
      });
      this.classList = {
        add: (...items) => {
          for (const item of items) classes.add(item);
          className = [...classes].join(" ");
        },
        remove: (...items) => {
          for (const item of items) classes.delete(item);
          className = [...classes].join(" ");
        },
        contains: (item) => classes.has(item),
        toggle: (item, force) => {
          const enabled = force === undefined ? !classes.has(item) : Boolean(force);
          if (enabled) classes.add(item);
          else classes.delete(item);
          className = [...classes].join(" ");
          return enabled;
        }
      };
    }
    get textContent() {
      return this._text + this.children.map((child) => child.textContent).join("");
    }
    set textContent(value) {
      this._text = String(value ?? "");
      this._innerHTML = "";
      this.children = [];
    }
    get innerHTML() { return this._innerHTML; }
    set innerHTML(value) {
      this._innerHTML = String(value ?? "");
      this._text = this._innerHTML.replace(/<[^>]*>/gu, "");
      this.children = [];
    }
    setAttribute(name, value) { this._attrs[name] = String(value); }
    getAttribute(name) { return this._attrs[name] ?? null; }
    append(...nodes) {
      for (const node of nodes) {
        if (node._parent) node._parent.removeChild(node);
        node._parent = this;
        this.children.push(node);
      }
    }
    appendChild(node) { this.append(node); return node; }
    replaceChildren(...nodes) {
      for (const child of this.children) child._parent = null;
      this.children = [];
      this.append(...nodes);
    }
    removeChild(node) {
      const index = this.children.indexOf(node);
      if (index >= 0) this.children.splice(index, 1);
      node._parent = null;
    }
    remove() { if (this._parent) this._parent.removeChild(this); }
    addEventListener() { /* 无交互，仅记录 */ }
    get value() { return this._value; }
    set value(v) { this._value = String(v ?? ""); }
  }
  // 真实端到端：真实 runtime（mock 模型网关 + stub shell）产生真实事件流，喂给
  // AgentSurface 渲染并断言 DOM。代码审查指出：手工伪造事件（尤其伪造带 text 的
  // assistant_message_completed）会掩盖「最终回复文本未进事件」的死路径——这里
  // 不再注入任何伪造事件。
  const h = await createProjectAgentHarness({
    gatewayScript: [
      { reply: { toolCalls: [tool("shell", { command: "echo hi", purpose: "活动流" })] } },
      { reply: { text: "这是最终回复。" } }
    ]
  });
  try {
    await h.agent.open({ projectRoot: h.projectRoot });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "写一段并总结" });
    await driveToIdle(h.agent, h.projectRoot);
    const events = await readEvents(h.agent, h.projectRoot);
    // 真实 runtime 必须把最终回复文本写入 assistant_message_completed（Task 11
    // 代码审查修复：state.js 仅在 payload.text 非空时渲染助手气泡）。
    const completed = eventsOfType(events, "assistant_message_completed");
    assert.ok(completed.length >= 1, "应产生 assistant_message_completed");
    assert.equal(completed[0].payload.text, "这是最终回复。", "真实 runtime 必须携带最终回复文本");
    // 真实事件流不得携带任何私有推理内容：本场景 gateway 未产生 reasoning token，
    // 因此不应出现 reasoning_delta；每轮恰好一次的 reasoning_completed 必须以空
    // text 闭合（不得有可用内容）；chain_of_thought / private_reasoning / 裸
    // reasoning 载荷字段在任意事件里都不得出现（reasoning_capability 是能力标签，
    // 不属于私有推理内容）。
    const reasoningDeltas = events.filter((event) => event.type === "reasoning_delta");
    assert.equal(reasoningDeltas.length, 0, "未产生 reasoning token 的场景不得出现 reasoning_delta");
    const reasoningCompleteds = eventsOfType(events, "reasoning_completed");
    assert.ok(reasoningCompleteds.length >= 1, "每条 model turn 都应闭合一次 reasoning_completed");
    for (const event of reasoningCompleteds) {
      assert.equal(event.payload.text, "", "无 reasoning token 时 completed 必须携带空 text");
      assert.notEqual(event.payload.availability, "available", "空 reasoning 不得标记为 available");
    }
    const journalText = events.map((e) => JSON.stringify(e)).join("\n");
    assert.ok(
      !journalText.includes("chain_of_thought") && !journalText.includes("private_reasoning"),
      "私有推理字段不得进入事件流"
    );
    assert.ok(!/"reasoning"\s*:/u.test(journalText), "不得出现裸 reasoning 载荷字段");

    const doc = {
      createElement: (tag) => new MockElement(tag),
      createElementNS: (_namespace, tag) => new MockElement(tag)
    };
    const root = new MockElement("div");
    const { createAgentSurface } = await import("../src/app-shell/agent/index.js");
    const surface = createAgentSurface({ root, api: null, document: doc });
    for (const event of events) surface.applyEvent(event);

    const allNodes = [];
    (function walk(node) {
      allNodes.push(node);
      for (const child of node.children) walk(child);
    })(root);
    // 同一 activity_id 只渲染一行，增量输出合并到同一输出节点
    const activityRows = allNodes.filter((node) => node.dataset?.activityId != null);
    assert.equal(activityRows.length, 1, "同一 activity_id 必须合并为单行，不得重复渲染");
    const outputNode = allNodes.find((node) => node.className === "agent-activity-output");
    assert.ok(outputNode, "应存在活动输出节点");
    assert.equal(outputNode.textContent, "stub stdout: echo hi", "活动输出应为真实 shell 增量");
    // 对话：用户气泡 + 助手气泡（真实最终回复文本上屏，不再依赖伪造事件）
    assert.equal(
      allNodes.filter((n) => n.dataset?.testid === "agent-user-message").length,
      1,
      "恰好一个用户气泡"
    );
    assert.equal(
      allNodes.filter((n) => n.dataset?.testid === "agent-assistant-message").length,
      1,
      "恰好一个助手气泡"
    );
    const rootText = root.textContent;
    assert.ok(rootText.includes("写一段并总结"), "用户消息应渲染");
    assert.ok(rootText.includes("这是最终回复。"), "助手气泡应渲染真实最终回复文本");

    // reducer 卫生检查（对真实事件克隆后追加推理字段重放，不污染真实流）：
    // 即便未来事件 payload 携带推理字段，也不得渲染。
    const hygieneRoot = new MockElement("div");
    const hygieneSurface = createAgentSurface({ root: hygieneRoot, api: null, document: doc });
    for (const event of events) {
      hygieneSurface.applyEvent(
        event.type === "model_turn_started" || event.type === "model_turn_completed"
          ? { ...event, payload: { ...event.payload, reasoning: "私有思考一", chain_of_thought: "内部推理一", private_reasoning: "不应渲染" } }
          : event
      );
    }
    assert.ok(!hygieneRoot.textContent.includes("私有思考"), "私有推理不得渲染");
    assert.ok(!hygieneRoot.textContent.includes("内部推理"), "chain-of-thought 不得渲染");
    assert.ok(!hygieneRoot.textContent.includes("不应渲染"), "private_reasoning 字段不得渲染");
    record("活动合并 + 助手气泡：真实事件流单行渲染、最终回复上屏、推理零泄漏", true, "rows=1");
  } finally {
    await h.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 场景 25：共享 900px 内容列与统一 Composer 菜单视口钳制
// ---------------------------------------------------------------------------
step("场景 25 · 900px 内容列与统一菜单视口钳制");
{
  const agentCssUrl = new URL("../src/app-shell/agent/agent.css", import.meta.url);
  const stylesCssUrl = new URL("../src/app-shell/styles.css", import.meta.url);
  const agentCss = await fs.readFile(agentCssUrl, "utf8");
  const stylesCss = await fs.readFile(stylesCssUrl, "utf8");
  assert.ok(stylesCss.includes("--content-column: 900px"), "styles.css 应定义 900px 内容列变量");
  assert.ok(agentCss.includes("--content-column: 900px"), "agent.css 应定义 900px 内容列变量");
  assert.ok(
    /\.agent-conversation[\s\S]*max-width:\s*var\(--content-column\)/u.test(agentCss),
    "对话应共享 max-width: var(--content-column)"
  );
  assert.ok(
    /\.agent-composer[\s\S]*max-width:\s*var\(--content-column\)/u.test(agentCss),
    "composer 应共享 max-width: var(--content-column)"
  );
  assert.ok(agentCss.includes("min(320px, calc(100vw - 32px))"), "模型菜单应保留 16px 视口安全区");
  assert.ok(agentCss.includes("bottom: calc(100% + 7px)"), "统一菜单应从 composer 向上展开");
  assert.ok(!agentCss.includes(".model-popover") && !agentCss.includes(".mode-popover"), "旧菜单实现不得残留");
  assert.ok(agentCss.includes("overflow-wrap: anywhere"), "长模型名称应允许任意位置换行");
  record("900px 内容列与统一菜单钳制：CSS 基线保留", true, "agent.css + styles.css");
}

// ---------------------------------------------------------------------------
// 场景 26：reasoning 原文逐 token 持久化，正文（assistant 事件）零泄漏
// ---------------------------------------------------------------------------
step("场景 26 · reasoning 原文持久化且正文无泄漏");
{
  const REASONING = "这是模型私下的思考过程，绝不应出现在任何公开正文里。";
  const h = await createProjectAgentHarness({
    gatewayScript: [
      async (request) => {
        // 流式 reasoning：逐 token 交给 onReasoningToken（§2.1：只进 reasoning 通道）
        request.metadata.onReasoningToken("这是模型私下的思考过程，");
        request.metadata.onReasoningToken("绝不应出现在任何公开正文里。");
        return { text: "这是公开回复，不含思考内容。" };
      }
    ],
    gatewayDelayMs: 0
  });
  try {
    await h.agent.open({ projectRoot: h.projectRoot });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "带思考的提问" });
    await waitForIdle(h.agent, h.projectRoot);
    const events = await readEvents(h.agent, h.projectRoot);

    // 原文持久化：reasoning_delta 增量拼接必须与原文完全一致（可被批量合并成一条）
    const deltas = eventsOfType(events, "reasoning_delta");
    assert.ok(deltas.length >= 1, "reasoning 轮次应产生 reasoning_delta");
    const persisted = deltas.map((event) => event.payload?.text ?? "").join("");
    assert.equal(persisted, REASONING, "reasoning 原文必须逐 token 持久化（增量拼接一致）");

    // reasoning_completed 恰好一次，携带安全全文与 availability
    const completed = eventsOfType(events, "reasoning_completed");
    assert.equal(completed.length, 1, "每条 model turn 恰好一次 reasoning_completed");
    assert.equal(completed[0].payload.text, REASONING, "reasoning_completed 必须携带原文全文");
    assert.equal(completed[0].payload.availability, "available");

    // 正文无泄漏：reasoning 原文只允许出现在 reasoning_delta/reasoning_completed，
    // 其余任何事件（尤其 assistant_message_* 正文通道）都不得携带。
    const reasoningSeqs = new Set(
      events.filter((event) => event.type === "reasoning_delta" || event.type === "reasoning_completed").map((event) => event.seq)
    );
    for (const event of events) {
      if (reasoningSeqs.has(event.seq)) continue;
      assert.ok(
        !JSON.stringify(event.payload).includes(REASONING),
        `${event.type} (seq=${event.seq}) 不得携带 reasoning 原文`
      );
    }
    assert.ok(
      eventsOfType(events, "assistant_message_completed").some((event) => event.payload.text === "这是公开回复，不含思考内容。"),
      "公开正文应正常持久化到 assistant_message_completed"
    );
    record("reasoning：原文逐 token 持久化 + 正文零泄漏", true, `deltas=${deltas.length}`);
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
