// 统一 Agent 公共行为验收测试（计划 Task 1 Step 2 契约冻结，TDD 红阶段）。
//
// 这些场景只通过公共 seam 驱动 Agent：
//   - 后端：src/core/agent/index.mjs（经 tests/helpers/project-agent-harness.mjs 构造）
//   - 前端：src/app-shell/agent/index.js（AgentSurface，Task 8 才存在）
// 绝不 import 旧编排内部文件。
//
// 冻结契约摘要（详见 harness 头注释）：
//   - agent.snapshot({ projectRoot, afterSeq, limit }) -> { session, events }
//   - agent.submit 在输入落盘后 resolve，Run 异步推进；观测用 waitFor/waitForIdle 轮询 snapshot
//   - agent.decide 的 choice 词汇："allow" | "allow_input" | "deny" | 精确 confirmation_text
//   - 事件类型必须来自 FIXED_EVENT_TYPES（计划固定的 28 个类型）
//
// 当前状态（Task 6 完成、规格审查裁决后）：19/21 场景通过。剩余 2 个红场景按
// 任务归属，不是本任务缺陷：
//   - "AgentSurface 保留 900px 内容基线与模型菜单视口钳制"：Task 8 实现
//     src/app-shell/agent/（index.js + agent.css）后转绿；
//   - "旧项目把 blueprint_status 迁入 project.yaml 且不再写旧状态文件"：Task 7
//     legacy-import 范围（migration.json 脚手架已在 journal.mjs；旧状态一次性
//     只读导入与 migration.legacy_imported 置位在 Task 7 实现）。
// Task 9 cutover 后本文件必须全部通过。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  LEGACY_CHAT_HISTORY_FILE,
  LEGACY_FAILURES_FILE,
  LEGACY_STATE_FILE,
  LEGACY_TASK_QUEUE_FILE,
  createProjectAgentHarness,
  eventsOfType,
  openPlainFolderHarness,
  pathExists,
  readEvents,
  readSession,
  sleep,
  tool,
  waitFor,
  waitForIdle
} from "../helpers/project-agent-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");

// 计划固定的 journal 事件类型（31 个）。
const FIXED_EVENT_TYPES = [
  "session_created",
  "run_started",
  "run_status_changed",
  "input_queued",
  "input_promoted",
  "input_consumed",
  "input_cancelled",
  "interrupt_requested",
  "interrupt_safe_point_reached",
  "model_turn_started",
  "model_turn_completed",
  "tool_call_started",
  "tool_output_delta",
  "tool_call_completed",
  "tool_call_failed",
  "decision_requested",
  "decision_resolved",
  "permission_grant_created",
  "permission_grant_cleared",
  "workflow_changed",
  "plan_updated",
  "reasoning_completed",
  "reasoning_delta",
  "history_compacted",
  "checkpoint_linked",
  "assistant_message_delta",
  "assistant_message_completed",
  "run_completed",
  "run_failed",
  "run_cancelled",
  "run_interrupted"
];

const SESSION_STATUSES = ["idle", "running", "waiting_user", "interrupting", "stopping", "error"];
const RUN_STATUSES = [
  "running",
  "waiting_user",
  "interrupting",
  "stopping",
  "completed",
  "failed",
  "cancelled",
  "interrupted"
];
const WORKFLOWS = ["general", "chapter", "init"];
const PLAN_STATUSES = ["pending", "in_progress", "completed"];

const EXTREME_COMMANDS =
  process.platform === "win32"
    ? ["del /f /s /q C:\\*.*", "format D:"]
    : ["rm -rf /", "rm -rf $HOME"];

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

async function openHarness(t, options) {
  const h = await createProjectAgentHarness(options);
  t.after(() => h.cleanup());
  await h.agent.open({ projectRoot: h.projectRoot });
  return h;
}

function assertSessionShape(session) {
  // §2.3：session projection 记录已重放事件的最高 schema version——全新 Session
  //（仅 bootstrap session_created）为 1；追加过 v2 事件后升为 2。
  assert.ok(
    session.schema_version === 1 || session.schema_version === 2,
    `session schema_version 应为 1 或 2，实际 ${String(session.schema_version)}`
  );
  assert.ok(typeof session.session_id === "string" && session.session_id.length > 0);
  assert.ok(SESSION_STATUSES.includes(session.status), `未知 session status: ${session.status}`);
  assert.ok(Number.isInteger(session.last_seq) && session.last_seq >= 0);
  assert.ok(!Number.isNaN(Date.parse(session.updated_at)), "updated_at 应为 ISO-8601");
  assert.ok(Array.isArray(session.queued_inputs));
  if (session.active_run !== null) {
    assert.ok(typeof session.active_run.id === "string" && session.active_run.id.length > 0);
    assert.ok(RUN_STATUSES.includes(session.active_run.status), `未知 run status: ${session.active_run.status}`);
    assert.ok(WORKFLOWS.includes(session.active_run.workflow), `未知 workflow: ${session.active_run.workflow}`);
    assert.ok(!Number.isNaN(Date.parse(session.active_run.started_at)), "started_at 应为 ISO-8601");
    assert.ok(Array.isArray(session.active_run.active_grants));
    for (const grant of session.active_run.active_grants) {
      assert.ok(grant.id && grant.input_id && grant.grant_key && grant.target_class && grant.created_at);
    }
  }
}

function assertPlanItems(items) {
  assert.ok(Array.isArray(items) && items.length > 0, "plan items 不能为空");
  const inProgress = items.filter((item) => item.status === "in_progress");
  assert.ok(inProgress.length <= 1, "最多一个 in_progress 项");
  for (const item of items) {
    assert.ok(PLAN_STATUSES.includes(item.status), `未知 plan 状态: ${item.status}`);
    assert.ok(typeof item.step === "string" && item.step.length > 0);
    assert.ok(typeof item.id === "string" && item.id.length > 0, "plan 项应携带稳定 id");
  }
}

// 活动闭环不变量：每个 input/tool/decision 都必须收敛到终态。
function assertActivityClosure(events) {
  const openInputs = new Map();
  const openTools = new Map();
  const openDecisions = new Map();
  for (const event of events) {
    if (event.type === "input_queued") {
      openInputs.set(event.payload.input_id, event);
    } else if (event.type === "input_consumed" || event.type === "input_cancelled") {
      assert.ok(openInputs.has(event.payload.input_id), `input 终态必须对应已排队 input: ${event.payload.input_id}`);
      openInputs.delete(event.payload.input_id);
    } else if (event.type === "tool_call_started") {
      openTools.set(event.payload.tool_call_id ?? event.payload.id, event);
    } else if (event.type === "tool_call_completed" || event.type === "tool_call_failed") {
      const id = event.payload.tool_call_id ?? event.payload.id;
      assert.ok(openTools.has(id), `tool 终态必须对应已开始 tool call: ${id}`);
      openTools.delete(id);
    } else if (event.type === "decision_requested") {
      openDecisions.set(event.payload.decision_id, event);
    } else if (event.type === "decision_resolved") {
      assert.ok(openDecisions.has(event.payload.decision_id), `decision 终态必须对应已请求 decision: ${event.payload.decision_id}`);
      openDecisions.delete(event.payload.decision_id);
    }
  }
  assert.deepEqual(
    [...openInputs.keys()],
    [],
    "每个 input 都必须收敛（consumed 或 cancelled）"
  );
  assert.deepEqual(
    [...openTools.keys()],
    [],
    "每个 tool call 都必须收敛（completed 或 failed）"
  );
  assert.deepEqual(
    [...openDecisions.keys()],
    [],
    "每个 decision 都必须收敛（resolved）"
  );
}

async function waitForDecision(agent, projectRoot, count = 1) {
  const snapshot = await waitFor(agent, projectRoot, (session, snap) =>
    eventsOfType(snap.events, "decision_requested").length >= count
  );
  return eventsOfType(snapshot.events, "decision_requested")[count - 1];
}

// ---------------------------------------------------------------------------
// 契约形状
// ---------------------------------------------------------------------------

test("session 投影与 journal 事件符合冻结契约", async (t) => {
  const h = await openHarness(t, {
    gatewayScript: [
      async () => ({
        toolCalls: [tool("read_file", { path: path.join(h.projectRoot, "project.yaml") })]
      }),
      { reply: { text: "已读取项目配置。" } }
    ]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "看一下项目配置", source: "chat" });
  const running = await readSession(h.agent, h.projectRoot);
  assertSessionShape(running);
  assert.equal(running.status, "running");
  assert.equal(running.active_run.workflow, "general");

  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  assert.ok(events.length >= 1, "journal 至少要有 session_created");
  let prevSeq = 0;
  for (const event of events) {
    // §2.3：bootstrap session_created 保持 v1（journal.mjs initialize 手工盖章）；
    // 其余新追加事件统一盖章 v2（EVENT_SCHEMA_VERSION）。旧 v1 日志重放场景由
    // journal-recovery.test.mjs 单独覆盖，本测试只面对全新 journal。
    assert.equal(
      event.schema_version,
      event.type === "session_created" ? 1 : 2,
      `${event.type} 的 schema_version 应符合 v1/v2 追加契约`
    );
    assert.ok(Number.isInteger(event.seq) && event.seq > prevSeq, "seq 必须严格递增");
    prevSeq = event.seq;
    assert.ok(typeof event.event_id === "string" && event.event_id.length > 0);
    assert.equal(event.session_id, running.session_id);
    assert.ok(FIXED_EVENT_TYPES.includes(event.type), `未知事件类型: ${event.type}`);
    assert.ok(!Number.isNaN(Date.parse(event.at)), "事件 at 应为 ISO-8601");
    assert.ok(event.payload !== null && typeof event.payload === "object", "事件必须有 payload 对象");
  }
  const finalSession = await readSession(h.agent, h.projectRoot);
  assert.equal(finalSession.status, "idle");
  assert.equal(finalSession.last_seq, prevSeq, "last_seq 必须等于最新事件 seq");
});

// ---------------------------------------------------------------------------
// Session / Run 生命周期
// ---------------------------------------------------------------------------

test("空闲提交创建且只创建一个 Run", async (t) => {
  const h = await openHarness(t, {
    gatewayScript: [{ reply: { text: "好的。" } }]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "你好", source: "chat" });
  const running = await readSession(h.agent, h.projectRoot);
  assert.equal(running.status, "running");
  assert.ok(running.active_run, "空闲提交应立即有 active run");
  assert.equal(running.active_run.workflow, "general");
  const queuedInputs = eventsOfType(await readEvents(h.agent, h.projectRoot), "input_queued");
  assert.equal(queuedInputs.length, 1);
  assert.equal(running.active_run.active_input_id, queuedInputs[0].payload.input_id);

  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  const started = eventsOfType(events, "run_started");
  const completed = eventsOfType(events, "run_completed");
  assert.equal(started.length, 1, "必须且只能创建一个 Run");
  assert.equal(completed.length, 1);
  assert.equal(started[0].run_id, completed[0].run_id, "同一 Run 必须保持同一 id");
  assert.equal(eventsOfType(events, "input_consumed").length, 1);
  assertActivityClosure(events);
});

test("运行中提交进入 FIFO 队列", async (t) => {
  const h = await openHarness(t, {
    project: { tool_permissions: { yolo: true } }, // yolo 是 fixture 权限模式：stub 命令免普通确认（extreme 仍强制确认）
    gatewayScript: [
      { reply: { toolCalls: [tool("shell", { command: "stub", timeout_ms: 30000 })] } },
      { reply: { text: "第一条处理完成。" } },
      { reply: { text: "第二条处理完成。" } }
    ],
    gatewayDelayMs: 60
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "第一条", source: "chat" });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "第二条", source: "chat" });
  const session = await readSession(h.agent, h.projectRoot);
  assert.equal(session.status, "running");
  assert.equal(session.queued_inputs.length, 1, "运行中的提交应排队而不是新建 Run");
  const queued = session.queued_inputs[0];
  assert.equal(queued.text, "第二条");
  assert.equal(queued.status, "queued");
  assert.ok(queued.id);
  assert.ok(!Number.isNaN(Date.parse(queued.queued_at)));

  const eventsBefore = await readEvents(h.agent, h.projectRoot);
  const queuedEvents = eventsOfType(eventsBefore, "input_queued");
  assert.equal(queuedEvents.length, 2);
  assert.equal(session.active_run.active_input_id, queuedEvents[0].payload.input_id);

  await waitForIdle(h.agent, h.projectRoot);
  const consumed = eventsOfType(await readEvents(h.agent, h.projectRoot), "input_consumed");
  assert.equal(consumed.length, 2);
  assert.equal(consumed[0].payload.input_id, queuedEvents[0].payload.input_id);
  assert.equal(consumed[1].payload.input_id, queuedEvents[1].payload.input_id);
  const texts = h.gateway.calls.map((call) => JSON.stringify(call.request));
  assert.ok(texts[0].includes("第一条"), "首个模型轮次应包含第一条输入");
  assert.ok(texts.some((text, i) => i > 0 && text.includes("第二条")), "后续轮次应包含第二条输入");
});

test("FIFO 按发送顺序消费输入", async (t) => {
  const h = await openHarness(t, {
    gatewayScript: [
      { reply: { text: "第一。" } },
      { reply: { text: "第二。" } },
      { reply: { text: "第三。" } }
    ],
    gatewayDelayMs: 60
  });
  // 输入文本用路径无关的独特标记（Windows 上绝对项目根含 "C:\"/"AppData" 等字母，
  // 用单字母 A/B/C 做顺序标记会被路径字母污染）
  const MARKERS = ["MARK_A_9f2", "MARK_B_1c7", "MARK_C_4e8"];
  await h.agent.submit({ projectRoot: h.projectRoot, text: MARKERS[0], source: "chat" });
  await h.agent.submit({ projectRoot: h.projectRoot, text: MARKERS[1], source: "chat" });
  await h.agent.submit({ projectRoot: h.projectRoot, text: MARKERS[2], source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  const queued = eventsOfType(events, "input_queued");
  const consumed = eventsOfType(events, "input_consumed");
  assert.equal(queued.length, 3);
  assert.equal(consumed.length, 3);
  assert.deepEqual(
    consumed.map((event) => event.payload.input_id),
    queued.map((event) => event.payload.input_id),
    "input_consumed 顺序必须与 input_queued 顺序一致（FIFO）"
  );
  const texts = h.gateway.calls.map((call) => JSON.stringify(call.request));
  const positions = MARKERS.map((text) => texts.findIndex((serialized) => serialized.includes(text)));
  assert.ok(positions.every((index) => index >= 0), "每个输入都应出现在模型请求中");
  assert.ok(positions[0] < positions[1] && positions[1] < positions[2], "模型按 FIFO 顺序处理输入");
  assertActivityClosure(events);
});

test("立即（promote）保持同一 Run id", async (t) => {
  const h = await openHarness(t, {
    gatewayScript: [
      { reply: { toolCalls: [tool("shell", { command: "stub", timeout_ms: 30000 })] } },
      { reply: { text: "优先处理第二条。" } },
      { reply: { text: "继续处理第一条。" } }
    ],
    gatewayDelayMs: 60
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "第一条", source: "chat" });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "第二条", source: "chat" });
  const before = await readSession(h.agent, h.projectRoot);
  const runId = before.active_run.id;
  const queuedInput = before.queued_inputs[0];
  assert.ok(queuedInput, "第二条应处于排队状态");

  await h.agent.promote({ projectRoot: h.projectRoot, inputId: queuedInput.id });
  const after = await readSession(h.agent, h.projectRoot);
  assert.equal(after.active_run.id, runId, "promote 不得创建新 Run");
  assert.equal(after.active_run.active_input_id, queuedInput.id, "promote 后活动输入应切换为被提升的输入");

  const events = await readEvents(h.agent, h.projectRoot);
  const interrupts = eventsOfType(events, "interrupt_requested");
  const promoted = eventsOfType(events, "input_promoted");
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].payload.input_id, queuedInput.id);
  const interruptIndex = events.findIndex((event) => event.type === "interrupt_requested");
  const promotedIndex = events.findIndex((event) => event.type === "input_promoted");
  assert.ok(interrupts.length >= 1 && interruptIndex < promotedIndex, "interrupt_requested 应先于 input_promoted");

  await waitForIdle(h.agent, h.projectRoot);
  const done = await readEvents(h.agent, h.projectRoot);
  const completed = eventsOfType(done, "run_completed");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].run_id, runId, "Run 完成后仍保持同一 id");
  const texts = h.gateway.calls.map((call) => JSON.stringify(call.request));
  const firstB = texts.findIndex((serialized) => serialized.includes("第二条"));
  const lastA = texts.map((serialized) => serialized.includes("第一条")).lastIndexOf(true);
  assert.ok(firstB >= 0 && lastA >= 0 && firstB < lastA, "被提升的输入应先于被打断的输入被处理");
  assertActivityClosure(done);
});

test("停止取消当前 Run 并取消排队输入", async (t) => {
  const h = await openHarness(t, {
    gatewayScript: [
      { reply: { toolCalls: [tool("shell", { command: "stub", timeout_ms: 30000 })] } },
      { reply: { text: "完成。" } }
    ]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "任务一", source: "chat" });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "任务二", source: "chat" });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "任务三", source: "chat" });
  await waitFor(h.agent, h.projectRoot, (session, snap) =>
    eventsOfType(snap.events, "tool_call_started").length >= 1
  );
  const runId = (await readSession(h.agent, h.projectRoot)).active_run.id;

  await h.agent.stop({ projectRoot: h.projectRoot, reason: "user_stop" });
  const final = await waitForIdle(h.agent, h.projectRoot);
  assert.equal(final.session.status, "idle");
  const events = await readEvents(h.agent, h.projectRoot);
  const cancelled = eventsOfType(events, "run_cancelled");
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].run_id, runId, "停止必须取消当前 Run");
  assert.ok(eventsOfType(events, "input_cancelled").length >= 2, "未消费的排队输入应全部 input_cancelled");
  assert.equal(eventsOfType(events, "run_completed").length, 0, "停止后不得出现 run_completed");
  assertActivityClosure(events);
});

test("retry 恢复同一可恢复 Run", async (t) => {
  const modelError = new Error("provider outage");
  modelError.code = "model_error";
  const h = await openHarness(t, {
    gatewayScript: [{ error: modelError }, { reply: { text: "恢复成功。" } }]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "写一段话", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const failedEvents = eventsOfType(await readEvents(h.agent, h.projectRoot), "run_failed");
  assert.equal(failedEvents.length, 1, "模型调用失败应产生 run_failed");
  const runId = failedEvents[0].run_id;

  await h.agent.retry({ projectRoot: h.projectRoot, runId });
  const resumed = await readSession(h.agent, h.projectRoot);
  assert.equal(resumed.active_run.id, runId, "retry 必须恢复同一个 Run");
  assert.equal(resumed.active_run.status, "running");
  await waitForIdle(h.agent, h.projectRoot);
  const done = await readEvents(h.agent, h.projectRoot);
  const completed = eventsOfType(done, "run_completed");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].run_id, runId, "恢复后的 Run 完成后仍是同一 id");
  assertActivityClosure(done);
});

test("同一项目同一时刻只有一个模型轮次", async (t) => {
  const h = await openHarness(t, {
    project: { tool_permissions: { yolo: true } }, // yolo 是 fixture 权限模式：stub 命令免普通确认（extreme 仍强制确认）
    gatewayScript: [
      { reply: { toolCalls: [tool("shell", { command: "stub", timeout_ms: 30000 })] } },
      { reply: { text: "第一条完成。" } },
      { reply: { text: "第二条完成。" } }
    ],
    gatewayDelayMs: 150
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "第一条", source: "chat" });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "第二条", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  assert.ok(h.gateway.calls.length >= 2, "应产生至少两个模型轮次");
  const sorted = [...h.gateway.calls].sort((a, b) => a.startedAt - b.startedAt);
  for (let i = 1; i < sorted.length; i += 1) {
    assert.ok(
      sorted[i].startedAt >= sorted[i - 1].finishedAt,
      `同一项目模型轮次不得并发：call ${i - 1} 与 call ${i} 时间重叠`
    );
  }
});

test("不同项目可并行运行", async (t) => {
  const h1 = await openHarness(t, {
    gatewayScript: [{ reply: { text: "项目一答复。" } }],
    gatewayDelayMs: 400
  });
  const h2 = await openHarness(t, {
    gatewayScript: [{ reply: { text: "项目二答复。" } }],
    gatewayDelayMs: 400
  });
  await h1.agent.submit({ projectRoot: h1.projectRoot, text: "项目一任务", source: "chat" });
  await h2.agent.submit({ projectRoot: h2.projectRoot, text: "项目二任务", source: "chat" });
  await Promise.all([
    waitForIdle(h1.agent, h1.projectRoot),
    waitForIdle(h2.agent, h2.projectRoot)
  ]);
  const call1 = h1.gateway.calls[0];
  const call2 = h2.gateway.calls[0];
  assert.ok(call1 && call2, "两个项目都应产生模型轮次");
  const overlap = call1.startedAt <= call2.finishedAt && call2.startedAt <= call1.finishedAt;
  assert.ok(overlap, "不同项目的模型轮次应当可以并发（时间重叠）");
  const events1 = await readEvents(h1.agent, h1.projectRoot);
  const events2 = await readEvents(h2.agent, h2.projectRoot);
  assert.equal(eventsOfType(events1, "run_completed").length, 1);
  assert.equal(eventsOfType(events2, "run_completed").length, 1);
});

// ---------------------------------------------------------------------------
// Visible Plan 与工作流
// ---------------------------------------------------------------------------

test("复杂任务更新 Visible Plan", async (t) => {
  const planA = {
    explanation: "先核对已完成章节",
    items: [
      { id: "check", step: "检查已有章节", status: "in_progress" },
      { id: "fix", step: "修正冲突", status: "pending" },
      { id: "verify", step: "验证修改", status: "pending" }
    ]
  };
  const planB = {
    explanation: "先核对已完成章节",
    items: [
      { id: "check", step: "检查已有章节", status: "completed" },
      { id: "fix", step: "修正冲突", status: "in_progress" },
      { id: "verify", step: "验证修改", status: "pending" }
    ]
  };
  const planC = {
    explanation: "先核对已完成章节",
    items: [
      { id: "check", step: "检查已有章节", status: "completed" },
      { id: "fix", step: "修正冲突", status: "completed" },
      { id: "verify", step: "验证修改", status: "completed" }
    ]
  };
  const h = await openHarness(t, {
    gatewayScript: [
      { reply: { toolCalls: [tool("update_plan", planA)] } },
      { reply: { toolCalls: [tool("update_plan", planB)] } },
      { reply: { toolCalls: [tool("update_plan", planC)] } },
      { reply: { text: "全部完成。" } }
    ]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "检查并修正章节冲突", source: "chat" });
  await waitFor(h.agent, h.projectRoot, (session) => session.active_run?.visible_plan?.items?.length === 3);
  const mid = await readSession(h.agent, h.projectRoot);
  assert.ok(mid.active_run.visible_plan, "复杂任务运行中应有可见计划");
  assert.equal(mid.active_run.visible_plan.explanation, "先核对已完成章节");
  assertPlanItems(mid.active_run.visible_plan.items);

  await waitForIdle(h.agent, h.projectRoot);
  const updates = eventsOfType(await readEvents(h.agent, h.projectRoot), "plan_updated");
  assert.equal(updates.length, 3, "每次 update_plan 都应产生 plan_updated");
  for (const event of updates) {
    assertPlanItems(event.payload.items);
    assert.equal(event.payload.explanation, "先核对已完成章节");
  }
  const last = updates[updates.length - 1];
  assert.ok(last.payload.items.every((item) => item.status === "completed"), "终态计划应全部 completed");
});

test("/init 保留用户原文并允许模型自主选择项目读取", async (t) => {
  const originalText = "/init 请先理解这个老项目，再给出建议";
  const marker = "OUTLINE_MARKER_9f3c7b";
  const h = await openHarness(t, {
    gatewayScript: [
      async (request) => {
        const serialized = JSON.stringify(request);
        assert.ok(serialized.includes(originalText), "首个模型轮次必须包含用户 /init 原文");
        assert.ok(!serialized.includes(marker), "模型自主读取前不得预先注入项目文件内容");
        return { toolCalls: [tool("read_file", { path: path.join(h.projectRoot, "OUTLINE.md") })] };
      },
      async (request) => {
        const serialized = JSON.stringify(request);
        assert.ok(serialized.includes(marker), "模型选择读取后应获得项目文件内容");
        return { text: "已了解项目。OUTLINE 目前只是占位，建议之后补全。" };
      }
    ]
  });
  await fs.appendFile(path.join(h.projectRoot, "OUTLINE.md"), `\n${marker}\n`, "utf8");
  await h.agent.submit({ projectRoot: h.projectRoot, text: originalText, source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  const readsStarted = eventsOfType(events, "tool_call_started").filter((event) => event.payload.name === "read_file");
  const readsDone = eventsOfType(events, "tool_call_completed").filter((event) => event.payload.name === "read_file");
  assert.ok(readsStarted.length >= 1, "模型应自主发起 read_file 工具调用");
  assert.equal(readsDone.length, readsStarted.length);
  assert.equal(eventsOfType(events, "run_completed").length, 1);
  assertActivityClosure(events);
});

// ---------------------------------------------------------------------------
// 权限、确认与授权
// ---------------------------------------------------------------------------

test("普通写入暂停等待确认", async (t) => {
  const h = await openHarness(t, {
    gatewayScript: [
      async () => ({
        toolCalls: [tool("write_file", { path: path.join(h.projectRoot, "notes.md"), content: "第一条笔记" })]
      }),
      { reply: { text: "已写入。" } }
    ]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "把这句话写入笔记", source: "chat" });
  const decision = await waitForDecision(h.agent, h.projectRoot, 1);
  assert.ok(decision.payload.decision_id, "决策必须携带 decision_id");
  assert.ok(decision.payload.activity_id, "决策必须携带 activity_id");
  const waiting = await readSession(h.agent, h.projectRoot);
  assert.equal(waiting.status, "waiting_user", "普通写入必须暂停等待用户确认");
  assert.equal(waiting.active_run.status, "waiting_user");

  await h.agent.decide({ projectRoot: h.projectRoot, decisionId: decision.payload.decision_id, choice: "allow" });
  await waitForIdle(h.agent, h.projectRoot);
  const content = await fs.readFile(path.join(h.projectRoot, "notes.md"), "utf8");
  assert.ok(content.includes("第一条笔记"), "确认后写入应生效");
  const events = await readEvents(h.agent, h.projectRoot);
  const resolved = eventsOfType(events, "decision_resolved");
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].payload.decision_id, decision.payload.decision_id);
  assert.ok(eventsOfType(events, "tool_call_completed").some((event) => event.payload.name === "write_file"));
  assertActivityClosure(events);
});

test("本条输入授权不跨入下一条排队输入", async (t) => {
  const h = await openHarness(t, {
    gatewayScript: [
      async () => ({
        toolCalls: [tool("write_file", { path: path.join(h.projectRoot, "a.txt"), content: "A 内容" })]
      }),
      async () => ({
        toolCalls: [tool("write_file", { path: path.join(h.projectRoot, "b.txt"), content: "B 内容" })]
      }),
      { reply: { text: "第一条输入完成。" } },
      async () => ({
        toolCalls: [tool("write_file", { path: path.join(h.projectRoot, "c.txt"), content: "C 内容" })]
      }),
      { reply: { text: "第二条输入完成。" } }
    ]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "先写入 A 和 B", source: "chat" });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "再写入 C", source: "chat" });

  const decision1 = await waitForDecision(h.agent, h.projectRoot, 1);
  await h.agent.decide({ projectRoot: h.projectRoot, decisionId: decision1.payload.decision_id, choice: "allow_input" });
  const decision2 = await waitForDecision(h.agent, h.projectRoot, 2);
  await h.agent.decide({ projectRoot: h.projectRoot, decisionId: decision2.payload.decision_id, choice: "allow" });
  await waitForIdle(h.agent, h.projectRoot);

  for (const name of ["a.txt", "b.txt", "c.txt"]) {
    assert.equal(await pathExists(path.join(h.projectRoot, name)), true, `${name} 应已写入`);
  }
  const events = await readEvents(h.agent, h.projectRoot);
  const queued = eventsOfType(events, "input_queued");
  const requests = eventsOfType(events, "decision_requested");
  assert.equal(requests.length, 2, "两条输入各应产生一次决策");
  assert.equal(requests[1].payload.input_id, queued[1].payload.input_id, "第二条输入的写入必须重新请求确认");
  const grants = eventsOfType(events, "permission_grant_created");
  assert.ok(grants.length >= 1, "allow_input 应创建临时 grant");
  assert.equal(grants[0].payload.input_id, queued[0].payload.input_id, "grant 必须绑定 active_input_id");
  const cleared = eventsOfType(events, "permission_grant_cleared");
  assert.ok(cleared.length >= 1, "input 完成后应清除其全部 grant");
  assertActivityClosure(events);
});

test("YOLO 跳过普通确认但不跳过 extreme 确认", async (t) => {
  const h = await openHarness(t, {
    project: { tool_permissions: { yolo: true } },
    gatewayScript: [
      async () => ({
        toolCalls: [tool("write_file", { path: path.join(h.projectRoot, "yolo-note.txt"), content: "YOLO 写入" })]
      }),
      { reply: { toolCalls: [tool("shell", { command: EXTREME_COMMANDS[0], timeout_ms: 5000 })] } },
      { reply: { text: "完成。" } }
    ]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "写入并执行高危命令", source: "chat" });
  const decision = await waitForDecision(h.agent, h.projectRoot, 1);
  assert.ok(decision.payload.confirmation_text, "extreme 决策必须携带 confirmation_text");
  assert.ok(decision.payload.confirmation_text.length > 0);
  assert.equal(await pathExists(path.join(h.projectRoot, "yolo-note.txt")), true, "YOLO 应自动放行普通写入");
  await h.agent.decide({
    projectRoot: h.projectRoot,
    decisionId: decision.payload.decision_id,
    choice: decision.payload.confirmation_text
  });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  assert.equal(eventsOfType(events, "decision_requested").length, 1, "YOLO 下普通写入不得请求确认，extreme 必须确认");
  assertActivityClosure(events);
});

test("extreme 确认必须使用当前决策的精确生成文字", async (t) => {
  const h = await openHarness(t, {
    gatewayScript: [
      { reply: { toolCalls: [tool("shell", { command: EXTREME_COMMANDS[0], timeout_ms: 5000 })] } },
      { reply: { toolCalls: [tool("shell", { command: EXTREME_COMMANDS[1], timeout_ms: 5000 })] } },
      { reply: { text: "完成。" } }
    ]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "执行两个高危命令", source: "chat" });

  const decision1 = await waitForDecision(h.agent, h.projectRoot, 1);
  const text1 = decision1.payload.confirmation_text;
  assert.ok(text1 && text1.length > 0, "extreme 决策必须生成新的确认文字");
  await assert.rejects(
    () => h.agent.decide({ projectRoot: h.projectRoot, decisionId: decision1.payload.decision_id, choice: "不匹配的文字" }),
    "错误文字不得通过 extreme 确认"
  );
  await h.agent.decide({ projectRoot: h.projectRoot, decisionId: decision1.payload.decision_id, choice: text1 });

  const decision2 = await waitForDecision(h.agent, h.projectRoot, 2);
  const text2 = decision2.payload.confirmation_text;
  assert.ok(text2 && text2 !== text1, "每个 extreme 动作都必须生成全新的确认文字");
  await assert.rejects(
    () => h.agent.decide({ projectRoot: h.projectRoot, decisionId: decision2.payload.decision_id, choice: text1 }),
    "历史确认文字不得解锁新 extreme 动作"
  );
  await h.agent.decide({ projectRoot: h.projectRoot, decisionId: decision2.payload.decision_id, choice: text2 });
  await waitForIdle(h.agent, h.projectRoot);

  const events = await readEvents(h.agent, h.projectRoot);
  assert.equal(eventsOfType(events, "decision_requested").length, 2);
  assert.equal(eventsOfType(events, "decision_resolved").length, 2);
  assert.equal(
    eventsOfType(events, "tool_call_completed").filter((event) => event.payload.name === "shell").length,
    2,
    "精确文字确认后两个 extreme 命令都应执行"
  );
  await assert.rejects(
    () => h.agent.decide({ projectRoot: h.projectRoot, decisionId: decision1.payload.decision_id, choice: text1 }),
    "已终结的 decision 不得再次生效"
  );
  assertActivityClosure(events);
});

// ---------------------------------------------------------------------------
// Shell 运行时
// ---------------------------------------------------------------------------

test("Shell 增量输出、cwd/退出码/耗时、进程树停止与 secret 脱敏", async (t) => {
  const SECRET = "super-secret-token-77";

  // 子场景一：真实 Shell 增量输出 + 报告 cwd/exit/duration + 脱敏
  const h1 = await openHarness(t, {
    realShell: true,
    project: { tool_permissions: { yolo: true } }, // yolo 是 fixture 权限模式：echo 命令免普通确认（extreme 仍强制确认）
    secrets: [SECRET],
    gatewayScript: [
      async () => ({
        toolCalls: [
          tool("shell", {
            command: `echo hello ${SECRET} world`,
            cwd: h1.projectRoot,
            timeout_ms: 10000,
            purpose: "验收输出流"
          })
        ]
      }),
      { reply: { text: "输出完成。" } }
    ]
  });
  await h1.agent.submit({ projectRoot: h1.projectRoot, text: "运行一条命令", source: "chat" });
  await waitForIdle(h1.agent, h1.projectRoot);
  const events1 = await readEvents(h1.agent, h1.projectRoot);
  const deltas = eventsOfType(events1, "tool_output_delta").filter((event) => event.payload.name === "shell");
  assert.ok(deltas.length >= 1, "shell 必须产生增量输出事件");
  for (const event of events1) {
    assert.ok(!JSON.stringify(event).includes(SECRET), "任何 journal 事件都不得包含未脱敏 secret");
  }
  const streamed = deltas.map((event) => event.payload.text ?? "").join("");
  assert.ok(streamed.includes("hello") && streamed.includes("world"), "脱敏后的输出应保留非 secret 内容");
  const completed = eventsOfType(events1, "tool_call_completed").filter((event) => event.payload.name === "shell");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].payload.exit_code, 0, "shell 完成事件应报告退出码");
  assert.equal(path.resolve(completed[0].payload.cwd), h1.projectRoot, "shell 完成事件应报告 cwd");
  assert.ok(completed[0].payload.duration_ms >= 0, "shell 完成事件应报告耗时");
  assertActivityClosure(events1);

  // 子场景二：stop 必须终止子进程树（子进程 1s 后写 marker；进程树未被终止则 marker 出现）
  const markerName = "stop-marker.txt";
  const childCommand =
    `node -e "setTimeout(function(){require('fs').writeFileSync('${markerName}','x')},1000); ` +
    `setInterval(function(){},500)"`;
  const h2 = await openHarness(t, {
    realShell: true,
    project: { tool_permissions: { yolo: true } }, // yolo 是 fixture 权限模式：子进程命令免普通确认（extreme 仍强制确认）
    secrets: [SECRET],
    gatewayScript: [
      // cwd 缺省 = 项目根（不能在对象字面量里引用尚未初始化的 h2）
      { reply: { toolCalls: [tool("shell", { command: childCommand, timeout_ms: 30000 })] }, repeat: true },
      { reply: { text: "完成。" } }
    ]
  });
  await h2.agent.submit({ projectRoot: h2.projectRoot, text: "启动长驻任务", source: "chat" });
  await waitFor(h2.agent, h2.projectRoot, (session, snap) =>
    eventsOfType(snap.events, "tool_call_started").some((event) => event.payload.name === "shell")
  );
  await h2.agent.stop({ projectRoot: h2.projectRoot, reason: "user_stop" });
  await waitForIdle(h2.agent, h2.projectRoot);
  await sleep(2000);
  assert.equal(
    await pathExists(path.join(h2.projectRoot, markerName)),
    false,
    "stop 必须终止整个子进程树"
  );
  const events2 = await readEvents(h2.agent, h2.projectRoot);
  assert.ok(eventsOfType(events2, "run_cancelled").length === 1, "stop 后 Run 应收敛为 cancelled");
  assertActivityClosure(events2);
});

// ---------------------------------------------------------------------------
// 活动闭环
// ---------------------------------------------------------------------------

test("活动 id 在成功、失败、拒绝、抢占与停止时闭环", async (t) => {
  // 1) 成功：read_file 完成
  {
    const h = await openHarness(t, {
      gatewayScript: [
        async () => ({
          toolCalls: [tool("read_file", { path: path.join(h.projectRoot, "project.yaml") })]
        }),
        { reply: { text: "读完了。" } }
      ]
    });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "读取配置", source: "chat" });
    await waitForIdle(h.agent, h.projectRoot);
    const events = await readEvents(h.agent, h.projectRoot);
    assert.ok(eventsOfType(events, "tool_call_completed").length >= 1, "成功场景应有完成的 tool call");
    assertActivityClosure(events);
  }

  // 2) 失败：未知工具名 -> tool_call_failed
  {
    const h = await openHarness(t, {
      gatewayScript: [
        { reply: { toolCalls: [{ id: "call_unknown_1", name: "no_such_tool", arguments: {} }] } },
        { reply: { text: "我换个方式。" } }
      ]
    });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "调用不存在的工具", source: "chat" });
    await waitForIdle(h.agent, h.projectRoot);
    const events = await readEvents(h.agent, h.projectRoot);
    assert.ok(eventsOfType(events, "tool_call_failed").length >= 1, "未知工具应产生 tool_call_failed");
    assertActivityClosure(events);
  }

  // 3) 拒绝：deny 决策 -> decision_resolved，文件不落盘
  {
    const h = await openHarness(t, {
      gatewayScript: [
        async () => ({
          toolCalls: [tool("write_file", { path: path.join(h.projectRoot, "denied.txt"), content: "不应出现" })]
        }),
        { reply: { text: "好的，不写。" } }
      ]
    });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "写入一个文件", source: "chat" });
    const decision = await waitForDecision(h.agent, h.projectRoot, 1);
    await h.agent.decide({ projectRoot: h.projectRoot, decisionId: decision.payload.decision_id, choice: "deny" });
    await waitForIdle(h.agent, h.projectRoot);
    assert.equal(await pathExists(path.join(h.projectRoot, "denied.txt")), false, "拒绝后不得写入文件");
    const events = await readEvents(h.agent, h.projectRoot);
    assert.ok(eventsOfType(events, "decision_resolved").length >= 1, "拒绝场景应有 decision_resolved");
    assertActivityClosure(events);
  }

  // 4) 抢占：promote 打断当前输入
  {
    const h = await openHarness(t, {
      gatewayScript: [
        { reply: { toolCalls: [tool("shell", { command: "stub", timeout_ms: 30000 })] } },
        { reply: { text: "处理第二条。" } },
        { reply: { text: "处理第一条。" } }
      ]
    });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "第一条", source: "chat" });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "第二条", source: "chat" });
    const session = await readSession(h.agent, h.projectRoot);
    await h.agent.promote({ projectRoot: h.projectRoot, inputId: session.queued_inputs[0].id });
    await waitForIdle(h.agent, h.projectRoot);
    const events = await readEvents(h.agent, h.projectRoot);
    assert.ok(eventsOfType(events, "input_promoted").length === 1);
    assertActivityClosure(events);
  }

  // 5) 停止：run_cancelled + 活动全部收敛
  {
    const h = await openHarness(t, {
      gatewayScript: [
        { reply: { toolCalls: [tool("shell", { command: "stub", timeout_ms: 30000 })] } },
        { reply: { text: "完成。" } }
      ]
    });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "任务", source: "chat" });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "排队任务", source: "chat" });
    await waitFor(h.agent, h.projectRoot, (session, snap) =>
      eventsOfType(snap.events, "tool_call_started").length >= 1
    );
    await h.agent.stop({ projectRoot: h.projectRoot, reason: "user_stop" });
    await waitForIdle(h.agent, h.projectRoot);
    const events = await readEvents(h.agent, h.projectRoot);
    assert.ok(eventsOfType(events, "run_cancelled").length === 1);
    assert.ok(eventsOfType(events, "input_cancelled").length >= 1);
    assertActivityClosure(events);
  }
});

// ---------------------------------------------------------------------------
// AgentSurface 布局基线
// ---------------------------------------------------------------------------

test("AgentSurface 保留 1040px 内容基线与统一菜单视口钳制", async () => {
  const { createAgentSurface } = await import("../../src/app-shell/agent/index.js");
  assert.equal(typeof createAgentSurface, "function", "AgentSurface 必须导出 createAgentSurface 工厂");
  const css = await fs.readFile(path.join(ROOT, "src", "app-shell", "agent", "agent.css"), "utf8");
  assert.match(css, /--content-column:\s*1040px/u, "根变量应定义 1040px 内容列");
  assert.match(
    css,
    /\.agent-composer-menu--model \.agent-composer-popover\s*\{[^}]*width:\s*min\(320px,\s*calc\(100vw - 32px\)\)/u,
    "模型菜单应使用统一 popover，并保留 16px 视口安全区"
  );
  assert.match(css, /\.agent-composer-popover\s*\{[^}]*bottom:\s*calc\(100% \+ 7px\)/u, "菜单应从 composer 向上展开");
  assert.match(css, /overflow-wrap:\s*anywhere/u, "模型名称应允许任意位置换行");
});

// ---------------------------------------------------------------------------
// 项目领域事实（ProjectAgent 之外的文件结果）
// ---------------------------------------------------------------------------

test("章节提交同时更新正式文件、索引、记忆与 checkpoint", async (t) => {
  const CHAPTER_CONTENT = `# 第一章 雨夜来信

雨夜，雨声突然变大。林深猛地推开门，冲进老宅的客厅。他浑身湿透，抹了一把脸，低声道：“信上说，老宅的钟会在午夜敲十三下。”烛光下，墙上的照片里竟是多年不见的父亲。他正要细看，门外却传来一阵急促的敲门声。`;
  const h = await openHarness(t, {
    project: { min_words_per_chapter: 50, target_words_per_chapter: 80 },
    gatewayScript: [
      async () => ({
        toolCalls: [tool("enter_workflow", { workflow: "chapter", reason: "用户要求正式写作第一章" })]
      }),
      async () => ({
        toolCalls: [
          tool("append_chapter_segment", {
            project_id: h.project.project_id ?? null,
            chapter_no: 1,
            segment_no: 1,
            content: CHAPTER_CONTENT
          })
        ]
      }),
      async () => ({
        toolCalls: [tool("commit_chapter", { project_id: h.project.project_id ?? null, chapter_no: 1 })]
      }),
      { reply: { text: "第一章已完成提交。" } }
    ]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "正式写第一章", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  assert.ok(
    eventsOfType(events, "tool_call_completed").some((event) => event.payload.name === "commit_chapter"),
    "commit_chapter 工具调用应完成"
  );
  assert.ok(eventsOfType(events, "checkpoint_linked").length >= 1, "提交必须链接 checkpoint");

  // 正式文件
  const finalPath = path.join(h.projectRoot, "chapters", "001.md");
  assert.equal(await pathExists(finalPath), true, "正式章节文件应存在");
  const finalContent = await fs.readFile(finalPath, "utf8");
  assert.ok(finalContent.includes("雨夜来信"), "正式文件应包含章节内容");

  // 章节索引
  const index = JSON.parse(await fs.readFile(path.join(h.projectRoot, "memory", "chapter_index.json"), "utf8"));
  const entry = index.chapters.find((chapter) => chapter.chapter_no === 1);
  assert.ok(entry, "章节索引应包含第 1 章");
  const normalizedFinalPath = String(entry.final_path ?? "").replaceAll("\\", "/");
  assert.ok(normalizedFinalPath.endsWith("chapters/001.md"), "索引应记录正式文件路径");
  assert.ok(Number(entry.actual_words) >= 50, "索引应记录真实字数");
  assert.ok(entry.checksum, "索引应记录校验和");

  // 章节记忆
  const memory = JSON.parse(await fs.readFile(path.join(h.projectRoot, "memory", "chapter_memory.json"), "utf8"));
  assert.ok(
    memory.chapters.some((chapter) => chapter.chapter_no === 1),
    "章节记忆应包含第 1 章"
  );

  // checkpoint：项目 checkpoints/ 下应出现正式 checkpoint 文件
  const checkpoints = await fs.readdir(path.join(h.projectRoot, "checkpoints"));
  assert.ok(checkpoints.some((name) => name.endsWith(".json")), "checkpoints 目录应出现 checkpoint 文件");

  // run_log 记录领域事实
  const runLog = await fs.readFile(path.join(h.projectRoot, "run_log.jsonl"), "utf8");
  assert.ok(runLog.trim().length > 0, "章节提交应在 run_log 记录领域事实");
});

test("自然语言审核：模型用 read_file/edit_file 直接修正，工作流保持 general，无 reviewProject", async (t) => {
  // Task 10：程序化审稿已删除。用户用自然语言提出审核要求，模型在普通工作区
  // 用通用读取/编辑工具完成，journal workflow 全程 general，绝不出现 reviewProject。
  const ORIGINAL = "雨夜，林深推开门。他低声说：\"信上说，老宅的钟会在午夜敲十三下。\"\n";
  const h = await openPlainFolderHarness({
    gatewayScript: [
      async (request) => {
        const system = (request.messages ?? []).find((m) => m.role === "system")?.content ?? "";
        assert.ok(
          system.includes("用户要求审核时直接读取相关文件、判断并按要求修改，不进入专门 workflow"),
          "general 政策应写明自然语言审核路径"
        );
        return { toolCalls: [tool("read_file", { path: "正文/第001章.md" })] };
      },
      async () => ({
        toolCalls: [tool("edit_file", { path: "正文/第001章.md", find: "他低声说", replace: "他猛地抬头，低声说" })]
      }),
      { reply: { text: "已检查第 1 章：人物动作与后文紧张情绪不一致，已把'他低声说'改为'他猛地抬头，低声说'。" } }
    ]
  });
  t.after(() => h.cleanup());
  await fs.mkdir(path.join(h.projectRoot, "正文"), { recursive: true });
  await fs.writeFile(path.join(h.projectRoot, "正文", "第001章.md"), ORIGINAL, "utf8");
  await h.agent.open({ projectRoot: h.projectRoot });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "检查第 1 章人物前后是否一致并直接修正", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  // workflow 全程 general：没有任何 workflow_changed 事件
  assert.equal(eventsOfType(events, "workflow_changed").length, 0, "自然语言审核不得切换工作流");
  // 模型通过普通工具完成：read_file 读取、edit_file 直接修正
  assert.ok(
    eventsOfType(events, "tool_call_completed").some((event) => event.payload.name === "read_file"),
    "模型应调用 read_file 读取章节"
  );
  assert.ok(
    eventsOfType(events, "tool_call_completed").some((event) => event.payload.name === "edit_file"),
    "模型应调用 edit_file 直接修正"
  );
  // 删除契约：任何事件都不得引用 reviewProject / review workflow
  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes("reviewProject"), "不得出现 reviewProject 工具调用");
  assert.ok(!serialized.includes("workflow_changed"), "不得写入 review workflow 切换事件");
  const content = await fs.readFile(path.join(h.projectRoot, "正文", "第001章.md"), "utf8");
  assert.ok(content.includes("他猛地抬头，低声说"), "直接修正应落盘");
  assert.equal(eventsOfType(events, "run_completed").length, 1, "普通 Agent 一轮完成审核");
  assertActivityClosure(events);
});

test("新项目不创建旧状态文件", async (t) => {
  const h = await openHarness(t, {
    gatewayScript: [{ reply: { text: "好。" } }]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "你好", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  for (const name of [
    LEGACY_STATE_FILE,
    LEGACY_CHAT_HISTORY_FILE,
    LEGACY_TASK_QUEUE_FILE,
    LEGACY_FAILURES_FILE
  ]) {
    assert.equal(
      await pathExists(path.join(h.projectRoot, name)),
      false,
      `新项目不得创建 ${name}`
    );
  }
});

test("旧项目把 blueprint_status 迁入 project.yaml 且不再写旧状态文件", async (t) => {
  const h = await createProjectAgentHarness({ legacy: true });
  t.after(() => h.cleanup());
  const statePath = path.join(h.projectRoot, LEGACY_STATE_FILE);
  const stateBefore = await fs.readFile(statePath, "utf8");
  assert.ok(stateBefore.length > 0, "旧项目夹具应存在旧状态文件");

  await h.agent.open({ projectRoot: h.projectRoot });
  const yaml = await fs.readFile(path.join(h.projectRoot, "project.yaml"), "utf8");
  assert.match(yaml, /blueprint_status:\s*["']?complete["']?/u, "blueprint_status 应迁入 project.yaml");

  const migrationPath = path.join(h.agentRoot, "migration.json");
  assert.equal(await pathExists(migrationPath), true, "迁移完成后应写入 migration.json");
  const migration = JSON.parse(await fs.readFile(migrationPath, "utf8"));
  assert.equal(migration.legacy_imported, true, "migration.json 应标记 legacy_imported");

  // 第二次 open 幂等：不产生重复 session_created
  await h.agent.open({ projectRoot: h.projectRoot });
  const events = await readEvents(h.agent, h.projectRoot);
  assert.equal(eventsOfType(events, "session_created").length, 1, "第二次 open 不得重复创建 session");

  // 完整跑一轮后旧状态文件不得再被写入
  await h.agent.submit({ projectRoot: h.projectRoot, text: "继续写作", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const stateAfter = await fs.readFile(statePath, "utf8");
  assert.equal(stateAfter, stateBefore, "legacy 导入后不得再写入旧状态文件");
  assertActivityClosure(await readEvents(h.agent, h.projectRoot));
});
