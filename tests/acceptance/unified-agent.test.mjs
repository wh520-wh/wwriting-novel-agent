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
//   - 事件类型必须来自 FIXED_EVENT_TYPES（计划固定的事件类型清单）
//
// 当前状态：本文件场景已全部转绿（Task 8 实现 AgentSurface、Task 12/13 以负向
// 断言关闭旧持久字段与旧聊天迁移场景）；后续改动必须保持全绿。
// Task 9 cutover 后本文件必须全部通过。
// Task 12：旧事件类型 workflow_changed 已随工作流概念删除（不再产生、不再投影），
// FIXED_EVENT_TYPES 清单同步删除；旧持久字段的迁移断言改为负向断言（旧项目导入
// 后 project.yaml 也不得写入该字段）。
// Task 13：旧聊天迁移路径（runLegacyImport 等）已整体删除——旧项目的聊天数据
// 不再导入任何接口，migration.json 的 legacy_imported 标记恒为 false；下方旧项目
// 场景改为"不导入"负向断言（旧文件只读、旧文本不进入 snapshot/导出/模型请求）。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
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

// 计划固定的 journal 事件类型（Task 6/9 新输入生命周期事件并入；legacy 事件
// input_promoted/input_consumed/input_cancelled 仍由旧路径（promote/停止/恢复）
// 产生，保留在清单内）。
const FIXED_EVENT_TYPES = [
  "session_created",
  "run_started",
  "run_status_changed",
  "input_queued",
  "input_started",
  "input_completed",
  "input_interrupted",
  "input_withdrawn",
  "priority_input_requested",
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
  "plan_updated",
  "reasoning_completed",
  "reasoning_delta",
  "history_compacted",
  "checkpoint_linked",
  "context_usage_updated",
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
const PLAN_STATUSES = ["pending", "in_progress", "completed"];

const EXTREME_COMMANDS =
  process.platform === "win32"
    ? ["del /f /s /q C:\\*.*", "format D:"]
    : ["rm -rf /", "rm -rf $HOME"];

// ---------------------------------------------------------------------------
// Task 1 复现夹具回放用的最小 DOM mock（与 thread-renderer-finish.test.mjs 同一
// 行为）。Task 10 起 mock 解析 innerHTML（与 agent-surface.test.mjs 同口径）：
// view.js 用 text.innerHTML = renderMarkdown(...) 写入助手正文，textContent 必须
// 把 HTML 标签剥掉后计入，否则助手正文在断言里为空——这是「正文缺失」在纯 DOM
// mock 下的伪缺陷，生产行为本就正确。
// ---------------------------------------------------------------------------

class TextNode {
  constructor(text) {
    this.text = String(text);
  }
  get textContent() {
    return this.text;
  }
  set textContent(value) {
    this.text = String(value);
  }
}

class MockElement {
  constructor(tag) {
    this.tagName = tag;
    this.hidden = false;
    this.style = {};
    this.dataset = {};
    this.children = [];
    this._parent = null;
    this._text = "";
    this._html = "";
    this._attrs = {};
    this._listeners = new Map();
    this._value = "";
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    const classSet = new Set();
    Object.defineProperty(this, "className", {
      get() { return [...classSet].join(" "); },
      set(value) {
        classSet.clear();
        for (const c of String(value).split(/\s+/)) if (c) classSet.add(c);
      },
      enumerable: true,
      configurable: true,
    });
    this.classList = {
      add: (...cs) => cs.forEach((c) => classSet.add(c)),
      remove: (...cs) => cs.forEach((c) => classSet.delete(c)),
      contains: (c) => classSet.has(c),
      has: (c) => classSet.has(c),
      toggle: (c, force) => {
        if (force === undefined) {
          if (classSet.has(c)) { classSet.delete(c); return false; }
          classSet.add(c); return true;
        }
        if (force) classSet.add(c); else classSet.delete(c);
        return force;
      },
      toString: () => [...classSet].join(" "),
    };
  }

  get value() {
    return this._value;
  }
  set value(v) {
    this._value = String(v ?? "");
  }

  get textContent() {
    // Task 10：mock 解析 innerHTML（与 agent-surface.test.mjs 同口径）——
    // view.js 用 text.innerHTML = renderMarkdown(...) 写入助手正文，textContent
    // 必须把 HTML 标签剥掉后计入，否则助手正文在断言里为空（正文缺失伪缺陷）。
    return this._text +
      (this._html ? this._html.replace(/<[^>]*>/g, "") : "") +
      this.children
        .map((c) => (typeof c.textContent === "string" ? c.textContent : ""))
        .join("");
  }
  set textContent(value) {
    this._text = String(value);
    this._html = "";
    this.children = [];
  }

  get innerHTML() {
    return this._html;
  }
  set innerHTML(value) {
    this._html = String(value ?? "");
    this._text = "";
    this.children = [];
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node instanceof MockElement) node._parent = this;
      this.children.push(node);
    }
  }
  appendChild(node) {
    if (node instanceof MockElement) node._parent = this;
    this.children.push(node);
    return node;
  }
  replaceChildren(...nodes) {
    for (const child of this.children) {
      if (child instanceof MockElement) child._parent = null;
    }
    this.children = [...nodes];
    for (const node of nodes) {
      if (node instanceof MockElement) node._parent = this;
    }
  }
  remove() {
    if (this._parent) {
      const index = this._parent.children.indexOf(this);
      if (index >= 0) this._parent.children.splice(index, 1);
      this._parent = null;
    }
  }
  setAttribute(name, value) {
    this._attrs[name] = String(value);
  }
  getAttribute(name) {
    return this._attrs[name] ?? null;
  }
  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }
  _fire(type, ...args) {
    for (const fn of this._listeners.get(type) ?? []) fn(...args);
  }

  static _dataKey(name) {
    return name.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
  }

  _matches(selector) {
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    const presenceSel = selector.match(/^\[data-([\w-]+)\]$/);
    if (presenceSel) {
      const key = MockElement._dataKey(presenceSel[1]);
      return this.dataset[key] !== undefined && this.dataset[key] !== "";
    }
    const dataSel = selector.match(/^\[data-([\w-]+)="?([^"\]]*)"?\]$/);
    if (dataSel) {
      const key = MockElement._dataKey(dataSel[1]);
      return String(this.dataset[key] ?? "") === dataSel[2];
    }
    return String(this.tagName).toLowerCase() === selector.toLowerCase();
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (!(child instanceof MockElement)) continue;
      if (child._matches(selector)) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  querySelectorAll(selector) {
    const out = [];
    const walk = (el) => {
      for (const child of el.children) {
        if (!(child instanceof MockElement)) continue;
        if (child._matches(selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
}

const realDoc = globalThis.document;

before(() => {
  globalThis.document = {
    createElement: (tag) => new MockElement(tag),
    createElementNS: (_ns, tag) => new MockElement(tag),
    createTextNode: (text) => new TextNode(text),
    createDocumentFragment: () => new MockElement("fragment"),
  };
});

after(() => {
  if (realDoc === undefined) delete globalThis.document;
  else globalThis.document = realDoc;
});

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
    assert.equal(session.active_run.workflow, undefined, "Task 12：Run projection 不再存储 workflow");
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

// 活动闭环不变量：每个 input/tool/decision 都必须收敛到终态。input 终态集合
//（Task 9 新生命周期 + legacy）：input_completed/input_interrupted/input_withdrawn/
// input_consumed/input_cancelled。
function assertActivityClosure(events) {
  const openInputs = new Map();
  const openTools = new Map();
  const openDecisions = new Map();
  for (const event of events) {
    if (event.type === "input_queued") {
      openInputs.set(event.payload.input_id, event);
    } else if (
      event.type === "input_consumed" ||
      event.type === "input_cancelled" ||
      event.type === "input_completed" ||
      event.type === "input_interrupted" ||
      event.type === "input_withdrawn"
    ) {
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
    "每个 input 都必须收敛（completed/interrupted/withdrawn/cancelled）"
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
  assert.equal(running.active_run.workflow, undefined, "Task 12：Run projection 不再存储 workflow");

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
  assert.equal(running.active_run.workflow, undefined, "Task 12：Run projection 不再存储 workflow");
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
  assert.equal(eventsOfType(events, "input_completed").length, 1, "空闲提交的输入以 input_completed 终结");
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
  const activated = eventsOfType(await readEvents(h.agent, h.projectRoot), "input_started");
  assert.equal(activated.length, 2, "两条输入都应以 input_started 激活");
  assert.equal(activated[0].payload.input_id, queuedEvents[0].payload.input_id);
  assert.equal(activated[1].payload.input_id, queuedEvents[1].payload.input_id);
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
  const activated = eventsOfType(events, "input_started");
  assert.equal(queued.length, 3);
  assert.equal(activated.length, 3);
  assert.deepEqual(
    activated.map((event) => event.payload.input_id),
    queued.map((event) => event.payload.input_id),
    "input_started 顺序必须与 input_queued 顺序一致（FIFO）"
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

test("Task 10 验收：A 运行时 B/C/D 排队，D 点「立即」后 D 下一条开始、B/C 顺序不变（spec 6.2）", async (t) => {
  // 子场景一：模型在途点「立即」→ 当前模型请求完整返回；普通最终文本 →
  // A input_completed（不得错误显示 interrupted），随后立即开始 D
  {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const h = await openHarness(t, {
      gatewayScript: [
        async () => {
          await gate;
          return { text: "A 完整答复。" };
        },
        { reply: { text: "D 答复。" } },
        { reply: { text: "B 答复。" } },
        { reply: { text: "C 答复。" } }
      ],
      gatewayDelayMs: 0
    });
    const a = await h.agent.submit({ projectRoot: h.projectRoot, text: "A 任务", source: "chat" });
    const b = await h.agent.submit({ projectRoot: h.projectRoot, text: "B 任务", source: "chat" });
    const c = await h.agent.submit({ projectRoot: h.projectRoot, text: "C 任务", source: "chat" });
    const d = await h.agent.submit({ projectRoot: h.projectRoot, text: "D 任务", source: "chat" });
    await waitFor(h.agent, h.projectRoot, (_session, snap) => eventsOfType(snap.events, "model_turn_started").length >= 1);
    const pri = await h.agent.requestPriority({ projectRoot: h.projectRoot, inputId: d.input_id });
    assert.equal(pri.priority_pending, true);
    release();
    await waitForIdle(h.agent, h.projectRoot);
    const events = await readEvents(h.agent, h.projectRoot);
    const started = eventsOfType(events, "input_started").map((event) => event.payload.input_id);
    assert.deepEqual(started, [a.input_id, d.input_id, b.input_id, c.input_id], "D 下一条开始，B/C 顺序不变");
    assert.equal(
      eventsOfType(events, "input_completed").filter((event) => event.payload.input_id === a.input_id).length,
      1,
      "A 以 input_completed 终结"
    );
    assert.equal(eventsOfType(events, "input_interrupted").length, 0, "A 自然完成不得错误显示 interrupted");
    assert.equal(
      eventsOfType(events, "input_started").filter((event) => event.payload.input_id === a.input_id).length,
      1,
      "A 不回队、不自动重跑"
    );
    assert.equal(eventsOfType(events, "run_completed").length, 1, "全程同一 Run");
    assertActivityClosure(events);
  }

  // 子场景二：模型返回 tool calls 时点「立即」→ 未开始工具全部不执行，
  // 实际被截断的 A 终态为 input_interrupted，D 下一条开始
  {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const h = await openHarness(t, {
      gatewayScript: [
        async () => {
          await gate;
          return {
            toolCalls: [
              tool("read_file", { path: "OUTLINE.md" }),
              tool("list_files", { path: "." })
            ]
          };
        },
        { reply: { text: "D 答复。" } },
        { reply: { text: "B 答复。" } }
      ],
      gatewayDelayMs: 0
    });
    const a = await h.agent.submit({ projectRoot: h.projectRoot, text: "A 任务", source: "chat" });
    const b = await h.agent.submit({ projectRoot: h.projectRoot, text: "B 任务", source: "chat" });
    const d = await h.agent.submit({ projectRoot: h.projectRoot, text: "D 任务", source: "chat" });
    await waitFor(h.agent, h.projectRoot, (_session, snap) => eventsOfType(snap.events, "model_turn_started").length >= 1);
    await h.agent.requestPriority({ projectRoot: h.projectRoot, inputId: d.input_id });
    release();
    await waitForIdle(h.agent, h.projectRoot);
    const events = await readEvents(h.agent, h.projectRoot);
    assert.equal(eventsOfType(events, "tool_call_started").length, 0, "未开始工具不执行");
    assert.equal(
      eventsOfType(events, "input_interrupted").filter((event) => event.payload.input_id === a.input_id).length,
      1,
      "实际被截断的 A 终态为 input_interrupted"
    );
    const started = eventsOfType(events, "input_started").map((event) => event.payload.input_id);
    assert.deepEqual(started, [a.input_id, d.input_id, b.input_id], "D 下一条开始，B 顺序不变");
    assert.equal(eventsOfType(events, "run_completed").length, 1);
    assertActivityClosure(events);
  }
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

test("先写章节再问普通问题：同一 Run 完成写作与回答，不切换工作流", async (t) => {
  // Task 7 行为验收：写章节不需要进入 chapter 工作流；提交后同一 Run 继续消费
  // 普通问题并直接回答，全程无 workflow_changed。
  const h = await openHarness(t, {
    project: { min_words_per_chapter: 50, target_words_per_chapter: 80 },
    gatewayScript: [
      async () => ({
        toolCalls: [
          tool("append_chapter_segment", {
            project_id: h.project.project_id ?? null,
            chapter_no: 1,
            segment_no: 1,
            content: "雨夜，林深推开门。他低声说：\"信上说，老宅的钟会在午夜敲十三下。\"\n"
          })
        ]
      }),
      async () => ({
        toolCalls: [tool("commit_chapter", { project_id: h.project.project_id ?? null, chapter_no: 1 })]
      }),
      async () => ({ text: "第一章已提交。" }),
      async () => ({ text: "我是一个本地小说写作助手。" })
    ]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "正式写第一章", source: "chat" });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "你是做什么的？", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  assert.equal(eventsOfType(events, "run_started").length, 1, "写作与普通问题共用同一 Run");
  assert.equal(eventsOfType(events, "workflow_changed").length, 0, "统一模式不再切换工作流");
  assert.ok(
    eventsOfType(events, "tool_call_completed").some((event) => event.payload.name === "commit_chapter"),
    "章节应提交"
  );
  assert.equal(await pathExists(path.join(h.projectRoot, "chapters", "001.md")), true, "正式章节文件应落盘");
  assert.ok(
    eventsOfType(events, "assistant_message_completed").some((event) => (event.payload?.text ?? "").includes("本地小说写作助手")),
    "普通问题应得到文本回答"
  );
  assertActivityClosure(events);
});

test("自然语言审核：模型用 read_file/edit_file 直接修正，无 workflow 切换，无 reviewProject", async (t) => {
  // Task 10：程序化审稿已删除。Task 7：统一任务政策不再有 workflow。用户用自然
  // 语言提出审核要求，模型在统一模式下用通用读取/编辑工具完成，绝不出现
  // reviewProject 或任何 workflow 切换。
  const ORIGINAL = "雨夜，林深推开门。他低声说：\"信上说，老宅的钟会在午夜敲十三下。\"\n";
  const h = await openPlainFolderHarness({
    gatewayScript: [
      async (request) => {
        const system = (request.messages ?? []).find((m) => m.role === "system")?.content ?? "";
        assert.ok(
          system.includes("用户要求审核时直接读取相关文件、判断并按用户要求修改"),
          "统一任务政策应写明自然语言审核路径"
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
  // 统一模式没有工作流切换：没有任何 workflow_changed 事件
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
  // 删除契约：任何事件都不得引用 reviewProject / workflow_changed
  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes("reviewProject"), "不得出现 reviewProject 工具调用");
  assert.ok(!serialized.includes("workflow_changed"), "不得写入 workflow_changed 事件");
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

test("旧项目聊天数据不再导入：旧文件只读、旧文本不进入任何接口、标记保持未导入", async (t) => {
  const h = await createProjectAgentHarness({ legacy: true });
  t.after(() => h.cleanup());
  const statePath = path.join(h.projectRoot, LEGACY_STATE_FILE);
  const historyPath = path.join(h.projectRoot, LEGACY_CHAT_HISTORY_FILE);
  const stateBefore = await fs.readFile(statePath, "utf8");
  const historyBefore = await fs.readFile(historyPath, "utf8");
  assert.ok(stateBefore.length > 0, "旧项目夹具应存在旧状态文件");

  // Task 13：旧聊天迁移路径已整体删除——open/submit 都不再导入，不产生会话条目
  await h.agent.open({ projectRoot: h.projectRoot });
  const { sessions } = await h.agent.sessions({ projectRoot: h.projectRoot });
  assert.equal(sessions.length, 0, "旧聊天数据不得产生会话条目（不再导入）");

  // 首次 submit 物化全新会话（旧数据零影响）
  await h.agent.submit({ projectRoot: h.projectRoot, text: "继续写作", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  // Task 12：旧持久字段概念已删除——旧状态里显式存在该字段也不得写入 project.yaml
  const yaml = await fs.readFile(path.join(h.projectRoot, "project.yaml"), "utf8");
  assert.doesNotMatch(yaml, /blueprint_status:\s*["']?complete["']?/u, "旧状态字段不得迁入 project.yaml");

  // 旧聊天文本不进入用户接口（snapshot 投影与事件流）与模型请求
  const snapshot = await h.agent.snapshot({ projectRoot: h.projectRoot, afterSeq: 0, limit: 100000 });
  assert.ok(!JSON.stringify(snapshot).includes("旧对话第一条"), "旧聊天文本不得出现在 snapshot");
  for (const call of h.gateway.calls) {
    assert.ok(!JSON.stringify(call.request).includes("旧对话第一条"), "旧聊天文本不得进入模型请求");
  }
  const exported = [];
  for await (const line of h.agent.exportHistory({ projectRoot: h.projectRoot })) exported.push(line);
  assert.ok(!JSON.stringify(exported).includes("旧对话第一条"), "旧聊天文本不得出现在历史导出");

  // 迁移标记保持未导入：migration.json 仍由 journal 维护，legacy_imported 恒为 false
  const { active_session_id } = await h.agent.sessions({ projectRoot: h.projectRoot });
  const migrationPath = path.join(h.agentRoot, "sessions", active_session_id, "migration.json");
  assert.equal(await pathExists(migrationPath), true, "新会话仍维护 journal 级 migration.json");
  const migration = JSON.parse(await fs.readFile(migrationPath, "utf8"));
  assert.equal(migration.legacy_imported, false, "legacy_imported 必须保持 false（聊天迁移已删除）");

  // 第二次 open 幂等：不产生重复 session_created
  await h.agent.open({ projectRoot: h.projectRoot });
  const events = await readEvents(h.agent, h.projectRoot);
  assert.equal(eventsOfType(events, "session_created").length, 1, "第二次 open 不得重复创建 session");

  // 旧文件完全只读：字节不变（不删除/不重命名/不覆盖）
  assert.equal(await fs.readFile(statePath, "utf8"), stateBefore, "旧状态文件不得被改写");
  assert.equal(await fs.readFile(historyPath, "utf8"), historyBefore, "旧聊天文件不得被改写");
  assertActivityClosure(events);
});

// ---------------------------------------------------------------------------
// Task 1 复现夹具：tool-before-answer 经生产入口回放
// ---------------------------------------------------------------------------

// 快照只返回服务端权威会话投影；事件全部经 SSE 增量路径逐条 applyEvent，
// 与生产「打开项目拿快照 + 长连接推送增量」一致，不直接调用 insertTimeline()。
function makeFixtureApi(fixture) {
  return {
    openProject: async () => {},
    submit: async () => ({ ok: true }),
    promote: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
    retry: async () => ({ ok: true }),
    decide: async () => ({ ok: true }),
    fetchSnapshot: async ({ tail }) =>
      tail ? { ok: true, session: fixture.session, events: [] } : null,
    connectEvents: () => {},
    destroy: () => {}
  };
}

test("生产入口回放 tool-before-answer：工具活动节点 DOM 顺序早于助手最终答案正文", async () => {
  const fixture = JSON.parse(
    await fs.readFile(path.join(ROOT, "tests", "fixtures", "agent-ui", "tool-before-answer.json"), "utf8")
  );
  const root = new MockElement("div");
  const { createAgentSurface } = await import("../../src/app-shell/agent/index.js");
  const surface = createAgentSurface({ root, api: makeFixtureApi(fixture) });
  await surface.openProject("D:\\novel");
  for (const event of fixture.events) surface.applyEvent(event);

  const group = root.querySelector(".agent-work-group");
  assert.ok(group, "回放应渲染 completed 工作组");
  assert.equal(group.open, false, "completed 工作组应自动折叠为关闭态");

  const assistant = root.querySelector(".agent-message--assistant");
  assert.ok(assistant, "折叠工作组时 .agent-message--assistant 节点仍应存在");
  // 正文缺失缺陷复现：纯 DOM mock 不解析 innerHTML，助手正文 textContent 为空
  // → 该断言失败（正文缺失）。Task 10 修复后必须转绿。
  assert.match(
    root.querySelector(".agent-message--assistant")?.textContent ?? "",
    /默认可见的最终答案/u,
    "助手最终答案正文不得为空，必须保持默认可见"
  );

  // 工具顺序契约：真实 list_files 一类的工具工作项必须位于助手正文之前。
  const toolItem = [...root.querySelectorAll(".agent-work-item")].find((el) => el.dataset.kind === "tool");
  const assistantBubble = root.querySelector('[data-testid="agent-assistant-message"]');
  assert.ok(toolItem, "回放应渲染工具工作项");
  assert.ok(assistantBubble, "回放应渲染助手最终答案气泡");
  const timelineIndex = (el) => el._parent.children.indexOf(el);
  assert.ok(
    timelineIndex(group) < timelineIndex(assistantBubble),
    "工具工作项所在工作组必须位于助手最终答案之前（工具顺序早于正文）"
  );
});

// ---------------------------------------------------------------------------
// Task 14：Journal 上下文与压缩流端到端验收（百万窗口完整链 + 取消/失败/ESC）
// ---------------------------------------------------------------------------

// 结构化压缩摘要（compaction-prompt 契约的 13 字段；schema_version 必须为 1）。
const VALID_COMPACTION_SUMMARY = {
  schema_version: 1,
  current_task: "完成第三章初稿",
  user_confirmed_decisions: ["主角改名为林默"],
  verified_facts: ["林默 17 岁"],
  files_and_artifacts: ["chapters/003.md"],
  completed_steps: ["拟定第三章大纲"],
  pending_steps: ["写完第三章结尾"],
  pending_decisions: ["第三章是否保留梦境场景"],
  failures_and_recovery: [],
  open_tool_calls: [],
  recent_user_intent: "继续写第三章",
  omitted_information: ["第三章早期删改记录"],
  reload_from_workspace: ["WWRITING.md"]
};

// 256k 档发送前压缩阈值（204,800）且低于硬窗口（224,000）的大输入。
const AUTO_COMPACT_INPUT_256K = "汉".repeat(195_000);

function abortError() {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

// 压缩感知 gateway 条目：压缩调用返回摘要，普通调用返回正文。
function compactionAwareEntry(compactionReply, normalReply) {
  return (request) =>
    request.metadata?.stage === "context_compaction"
      ? { text: JSON.stringify(compactionReply) }
      : { text: normalReply };
}

// 在压缩调用上挂起（等 AbortSignal），供取消路径稳定观测。
function compactionHoldEntry() {
  return (request, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(abortError()), { once: true });
    });
}

// 逐轮播种历史（每次 submit 等 idle；文本带路径无关标记，避免与绝对项目根字母混淆）。
async function seedTask14Turns(agent, projectRoot, count) {
  for (let i = 0; i < count; i += 1) {
    await agent.submit({ projectRoot, text: `T14_SEED_${i}_7f2a 第 ${i} 轮`, source: "chat" });
    await waitForIdle(agent, projectRoot);
  }
}

// ---------------------------------------------------------------------------
// 完整链（brief Step 3 主链）：
//   配置 model[1M][foo] → provider 捕获基础 ID model → context ring 分母 1,000,000
//   → 待发送输入把估算推到 967,000 → 先出现压缩事件，不调用普通 turn
//   → 压缩候选成功、active checkpoint 切换 → 原输入再发送 → 原始旧消息仍可向上分页查看
// ---------------------------------------------------------------------------
test("1M 窗口端到端：model[1M] 基础 ID 剥离 → 预检推到压缩点 → 压缩先于普通轮 → checkpoint 切换 → 原输入发送 → 旧历史可上翻", async (t) => {
  const PROJECT_OPTIONS = { active_model: { provider: "mock", model_name: "model[1M][foo]" } };
  const SEEDS = 13; // 12 轮受保护窗口之外至少 1 轮进入摘要 → 压缩非 noop

  // ---- 探测项目：同配置、同历史深度，捕获一次普通请求做自校准 ----
  // 预检估算 = runtime 的 context_usage_updated（同一装配完成的请求估算一次）。
  // 历史与系统层开销在同一仓库同一夹具下确定，用探测请求实测，再反推让大输入
  // 落在 [967,000, 968,000) 的长度（避免硬编码受技能目录/系统提示词漂移影响）。
  let probeCaptured = null;
  const probe = await createProjectAgentHarness({
    project: PROJECT_OPTIONS,
    gatewayScript: [
      ...Array.from({ length: SEEDS }, (_, i) => () => ({ text: `探测回复 ${i}` })),
      (request) => {
        probeCaptured = request;
        return { text: "探测完成。" };
      }
    ],
    gatewayDelayMs: 0
  });
  t.after(() => probe.cleanup());
  await probe.agent.open({ projectRoot: probe.projectRoot });
  await seedTask14Turns(probe.agent, probe.projectRoot, SEEDS);
  await probe.agent.submit({ projectRoot: probe.projectRoot, text: "T14_PROBE_x1", source: "chat" });
  await waitForIdle(probe.agent, probe.projectRoot);
  assert.ok(probeCaptured, "探测请求必须被捕获");
  // 自校准：探测请求（同历史深度）的预检估算读取 runtime 的 context_usage_updated
  //（公共 seam 可观测；依赖规则只允许 acceptance 从 src/core/agent/index.mjs 导入）。
  const probeUsageEvents = eventsOfType(await readEvents(probe.agent, probe.projectRoot), "context_usage_updated");
  const usedProbe = probeUsageEvents.at(-1).payload.usage.used_tokens;
  // 大输入估算 ≈ usedProbe + 1.08 × (N − 1)；目标 967,400（[967,000, 967,999] 中段）
  const N = Math.max(1, Math.ceil((967_400 - usedProbe) / 1.08) + 2);
  const bigInput = "汉".repeat(N);

  // ---- 主项目：同一配置与历史深度，跑完整链 ----
  const h = await createProjectAgentHarness({
    project: PROJECT_OPTIONS,
    gatewayScript: [
      ...Array.from({ length: SEEDS }, (_, i) => () => ({ text: `回复 ${i}` })),
      compactionAwareEntry(VALID_COMPACTION_SUMMARY, "压缩后继续完成原输入。"),
      () => ({ text: "压缩后继续完成原输入。" })
    ],
    gatewayDelayMs: 0
  });
  t.after(() => h.cleanup());
  await h.agent.open({ projectRoot: h.projectRoot });
  await seedTask14Turns(h.agent, h.projectRoot, SEEDS);
  await h.agent.submit({ projectRoot: h.projectRoot, text: bigInput, source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);

  const events = await readEvents(h.agent, h.projectRoot);
  const session = await readSession(h.agent, h.projectRoot);

  // 1) 压缩事件顺序：started → running → completed（恰好一次）
  const compactions = events.filter((event) => event.type.startsWith("context_compaction"));
  assert.deepEqual(
    compactions.map((event) => event.type),
    ["context_compaction_started", "context_compaction_running", "context_compaction_completed"],
    "自动压缩事件顺序必须严格为 started → running → completed"
  );

  // 2) 压缩先于普通 turn：原输入排队与压缩开始之间不得出现普通模型/工具事件
  const bigQueued = eventsOfType(events, "input_queued").find((event) => event.payload.text === bigInput);
  assert.ok(bigQueued, "原输入必须排队");
  const beforeCompaction = events.filter(
    (event) => event.seq > bigQueued.seq && event.seq < compactions[0].seq
  );
  assert.ok(
    !beforeCompaction.some((event) => event.type === "model_turn_started" || event.type === "tool_call_started"),
    "压缩开始前不得调用普通 turn 或启动工具"
  );
  const firstNormalTurn = eventsOfType(events, "model_turn_started")[SEEDS];
  assert.ok(firstNormalTurn && firstNormalTurn.seq > compactions.at(-1).seq, "普通轮必须在压缩完成之后");

  // 3) provider 捕获基础 ID model（configured_model_id 保留原文）
  const compactionCall = h.gateway.calls.find((call) => call.request.metadata?.stage === "context_compaction");
  assert.ok(compactionCall, "必须有一次压缩模型调用");
  assert.equal(compactionCall.request.modelConfig.model_name, "model", "压缩调用携带剥离尾标后的基础 ID");
  assert.equal(compactionCall.request.modelConfig.configured_model_id, "model[1M][foo]", "configured_model_id 保留原文");
  assert.equal(compactionCall.request.modelConfig.effective_context_window, 1_000_000);
  assert.equal(compactionCall.request.stream, false, "压缩调用是非流式");

  // 4) context ring 分母 1,000,000 + 预检估算到达 967,000（且低于硬窗口）
  const bigUsage = eventsOfType(events, "context_usage_updated").filter(
    (event) => event.payload.usage?.used_tokens >= 900_000
  );
  assert.ok(bigUsage.length >= 1, "大输入应产生超过 90 万估算的预检事件");
  const preflight = bigUsage[0].payload.usage;
  assert.equal(preflight.effective_context_window, 1_000_000, "圆环分母必须为 effective_context_window=1M");
  assert.equal(preflight.window_source, "model_id_1m");
  assert.equal(preflight.model, "model", "预检 payload 携带模型基础 ID");
  assert.ok(preflight.used_tokens >= 967_000, `预检估算应达到 1M 档压缩点，实际 ${preflight.used_tokens}`);
  assert.ok(preflight.used_tokens + 32_000 < 1_000_000, `预检估算应低于硬窗口，实际 ${preflight.used_tokens}`);
  assert.equal(session.context_usage.effective_context_window, 1_000_000, "session 投影 ring 分母为 1M");

  // 5) 普通模型调用 = 13 播种 + 1 原输入；压缩调用恰好 1 次（不调用普通 turn 提前发生）
  const normalCalls = h.gateway.calls.filter((call) => call.request.metadata?.stage !== "context_compaction");
  assert.equal(normalCalls.length, SEEDS + 1, "压缩完成后原输入只发送一次");
  assert.equal(h.gateway.calls.filter((call) => call.request.metadata?.stage === "context_compaction").length, 1);

  // 6) 压缩候选成功：active checkpoint 切换 + 正式文件落盘 + 投影
  const completed = compactions.at(-1);
  assert.equal(session.active_context_checkpoint_id, completed.payload.checkpoint_id, "completed 必须切换 active 指针");
  assert.equal(session.compaction.state, "completed");
  assert.equal(session.compaction.trigger, "automatic");
  const checkpointFile = path.join(h.agentRoot, "sessions", session.session_id, "checkpoints", `context-${completed.payload.checkpoint_id}.json`);
  assert.equal(await pathExists(checkpointFile), true, "checkpoint 正式文件必须落盘");

  // 7) 原输入再发送：最后一次普通调用携带大输入原文
  const lastNormal = normalCalls.at(-1);
  assert.equal(lastNormal.request.modelConfig.model_name, "model", "普通轮同样携带基础 ID");
  assert.ok(
    JSON.stringify(lastNormal.request.messages).includes("汉".repeat(64)),
    "原输入必须在压缩完成后发送给 provider"
  );
  assert.equal(eventsOfType(events, "input_started").length, SEEDS + 1, "原输入必须被消费");

  // 8) 原始旧消息仍可向上分页查看（beforeSeq 分页回到最早的播种轮）
  let beforeSeq = events.at(-1).seq;
  let paged = [];
  for (let page = 0; page < 30 && beforeSeq > 1; page += 1) {
    const snap = await h.agent.snapshot({ projectRoot: h.projectRoot, beforeSeq, limit: 200 });
    if (snap.events.length === 0) break;
    paged.unshift(...snap.events);
    beforeSeq = snap.events[0].seq;
  }
  assert.ok(
    paged.some((event) => event.type === "input_queued" && event.payload.text?.includes("T14_SEED_0_")),
    "压缩后原始旧消息必须仍可向上分页查看"
  );
  assertActivityClosure(events);
});

// ---------------------------------------------------------------------------
// 256k 自动取消 → 下一次发送重新触发压缩门禁
// ---------------------------------------------------------------------------
test("256k 自动压缩取消后，下一次发送重新触发压缩门禁", async (t) => {
  const script = [];
  for (let i = 0; i < 13; i += 1) script.push(() => ({ text: `回复 ${i}` }));
  script.push(compactionHoldEntry()); // 第一次压缩：挂起供取消
  script.push(compactionAwareEntry(VALID_COMPACTION_SUMMARY, "重触发后完成。")); // 第二次压缩：成功
  script.push(() => ({ text: "重触发后完成。" }));
  const h = await createProjectAgentHarness({ gatewayScript: script, gatewayDelayMs: 0 });
  t.after(() => h.cleanup());
  await h.agent.open({ projectRoot: h.projectRoot });
  await seedTask14Turns(h.agent, h.projectRoot, 13);

  // 第一次发送：自动压缩启动 → ESC/按钮取消
  await h.agent.submit({ projectRoot: h.projectRoot, text: AUTO_COMPACT_INPUT_256K, source: "chat" });
  await waitFor(h.agent, h.projectRoot, (_s, snap) =>
    eventsOfType(snap.events, "context_compaction_running").length > 0,
    { describe: "第一次压缩进行中" }
  );
  const started1 = (await readEvents(h.agent, h.projectRoot)).find(
    (event) => event.type === "context_compaction_started"
  );
  await h.agent.cancelCompaction({ projectRoot: h.projectRoot, compactionId: started1.payload.compaction_id });
  await waitForIdle(h.agent, h.projectRoot);
  let events = await readEvents(h.agent, h.projectRoot);
  assert.equal(
    eventsOfType(events, "input_cancelled").filter((event) => event.payload.reason === "compaction_cancelled").length,
    1,
    "取消必须终结该输入"
  );
  assert.equal(eventsOfType(events, "run_cancelled").length, 1);
  let session = await readSession(h.agent, h.projectRoot);
  assert.equal(session.status, "idle");
  assert.equal(session.active_context_checkpoint_id, null, "取消不切换 active 指针");

  // 下一次发送：重新触发压缩门禁 → 压缩成功 → 原输入发送
  await h.agent.submit({ projectRoot: h.projectRoot, text: AUTO_COMPACT_INPUT_256K, source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  events = await readEvents(h.agent, h.projectRoot);
  const compactions = events.filter((event) => event.type.startsWith("context_compaction"));
  assert.equal(
    compactions.filter((event) => event.type === "context_compaction_started").length,
    2,
    "下一次发送必须重新触发压缩门禁"
  );
  const secondCompleted = compactions.filter((event) => event.type === "context_compaction_completed").at(-1);
  assert.ok(secondCompleted, "第二次压缩必须成功");
  assert.equal(secondCompleted.payload.attempt, 1, "新输入触发的是全新 attempt");
  session = await readSession(h.agent, h.projectRoot);
  assert.equal(session.status, "idle");
  assert.equal(session.active_run.status, "completed", "第二次发送的 Run 必须完成");
  assert.equal(
    session.active_context_checkpoint_id,
    secondCompleted.payload.checkpoint_id,
    "第二次压缩成功后 active 指针切换"
  );
  assertActivityClosure(events);
});

// ---------------------------------------------------------------------------
// 手动 /compact 压缩中取消 → 会话 idle → composer 可发
// ---------------------------------------------------------------------------
test("手动 /compact 压缩中取消后会话 idle，composer 立即可发", async (t) => {
  const script = [];
  for (let i = 0; i < 13; i += 1) script.push(() => ({ text: `回复 ${i}` }));
  script.push(compactionHoldEntry()); // 手动压缩挂起供取消
  script.push(() => ({ text: "取消后正常回复。" }));
  const h = await createProjectAgentHarness({ gatewayScript: script, gatewayDelayMs: 0 });
  t.after(() => h.cleanup());
  await h.agent.open({ projectRoot: h.projectRoot });
  await seedTask14Turns(h.agent, h.projectRoot, 13);

  await h.agent.submit({ projectRoot: h.projectRoot, text: "/compact", source: "chat" });
  await waitFor(h.agent, h.projectRoot, (_s, snap) =>
    eventsOfType(snap.events, "context_compaction_running").length > 0,
    { describe: "手动压缩进行中" }
  );
  const started = (await readEvents(h.agent, h.projectRoot)).find(
    (event) => event.type === "context_compaction_started"
  );
  assert.equal(started.payload.trigger, "manual");
  await h.agent.cancelCompaction({ projectRoot: h.projectRoot, compactionId: started.payload.compaction_id });
  await waitForIdle(h.agent, h.projectRoot);
  let session = await readSession(h.agent, h.projectRoot);
  assert.equal(session.status, "idle", "取消后会话必须 idle（composer 可发）");
  assert.equal(session.active_context_checkpoint_id, null, "取消不切换 active 指针");
  const eventsAfterCancel = await readEvents(h.agent, h.projectRoot);
  assert.ok(
    eventsOfType(eventsAfterCancel, "context_compaction_cancelled").length >= 1,
    "应追加 context_compaction_cancelled"
  );

  // composer 可发：取消后立即普通提交并完成
  await h.agent.submit({ projectRoot: h.projectRoot, text: "取消后继续写作", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  session = await readSession(h.agent, h.projectRoot);
  assert.equal(session.active_run.status, "completed", "取消后 composer 立即可发并完成");
  assertActivityClosure(await readEvents(h.agent, h.projectRoot));
});

// ---------------------------------------------------------------------------
// 自动压缩两次网络失败：failed 投影（失败行）可重试/取消，旧 checkpoint 不变
// ---------------------------------------------------------------------------
test("自动压缩两次网络失败后 failed：失败行可重试或取消，旧 checkpoint 不变", async (t) => {
  const script = [];
  for (let i = 0; i < 13; i += 1) script.push(() => ({ text: `回复 ${i}` }));
  const transportError = (reason) => {
    const error = new Error(`网络错误：${reason}`);
    error.code = "provider_transport_error";
    return error;
  };
  script.push({ error: transportError("一") });
  script.push({ error: transportError("二") });
  const h = await createProjectAgentHarness({ gatewayScript: script, gatewayDelayMs: 0 });
  t.after(() => h.cleanup());
  await h.agent.open({ projectRoot: h.projectRoot });
  await seedTask14Turns(h.agent, h.projectRoot, 13);

  await h.agent.submit({ projectRoot: h.projectRoot, text: AUTO_COMPACT_INPUT_256K, source: "chat" });
  const failed = await waitFor(
    h.agent,
    h.projectRoot,
    (session) => session.compaction?.state === "failed" && session.active_run?.status === "waiting_user",
    { describe: "两次失败后压缩 failed 且 Run waiting_user" }
  );
  assert.equal(failed.session.status, "waiting_user", "失败后发送门禁保持禁用（等待用户 retry/cancel）");
  const failedEvent = (await readEvents(h.agent, h.projectRoot)).find(
    (event) => event.type === "context_compaction_failed"
  );
  assert.equal(failedEvent.payload.error_code, "provider_transport_error");
  assert.equal(failedEvent.payload.attempt, 1, "两次瞬时失败属于同一 attempt（自动重试一次后熔断）");
  assert.equal(h.gateway.calls.length, 15, "13 播种 + 2 次失败压缩请求，熔断后不再自动请求");

  // 失败行可取消：cancel → input_cancelled + run_cancelled → idle
  await h.agent.cancelCompaction({ projectRoot: h.projectRoot, compactionId: failedEvent.payload.compaction_id });
  await waitForIdle(h.agent, h.projectRoot);
  let events = await readEvents(h.agent, h.projectRoot);
  assert.equal(
    eventsOfType(events, "input_cancelled").filter((event) => event.payload.reason === "compaction_cancelled").length,
    1
  );
  assert.equal(eventsOfType(events, "run_cancelled").length, 1);
  let session = await readSession(h.agent, h.projectRoot);
  assert.equal(session.active_context_checkpoint_id, null, "失败/取消不切换 active 指针");

  // 失败行可重试：重新触发（新 attempt）→ 压缩成功 → 原输入发送
  script.push(compactionAwareEntry(VALID_COMPACTION_SUMMARY, "重试后完成。"));
  script.push(() => ({ text: "重试后完成。" }));
  await h.agent.submit({ projectRoot: h.projectRoot, text: AUTO_COMPACT_INPUT_256K, source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  events = await readEvents(h.agent, h.projectRoot);
  const compactions = events.filter((event) => event.type.startsWith("context_compaction"));
  assert.equal(compactions.filter((event) => event.type === "context_compaction_completed").length, 1, "重试后压缩成功");
  session = await readSession(h.agent, h.projectRoot);
  assert.equal(session.active_run.status, "completed");
  assert.equal(
    session.active_context_checkpoint_id,
    compactions.find((event) => event.type === "context_compaction_completed").payload.checkpoint_id
  );
  assertActivityClosure(events);
});

// ---------------------------------------------------------------------------
// ESC 停止普通 Run（Task 12 统一 ESC 路由的下层语义：普通运行中停止）
// ---------------------------------------------------------------------------
test("ESC 停止普通 Run：run_cancelled 收敛、排队输入取消、会话 idle", async (t) => {
  const h = await createProjectAgentHarness({
    gatewayScript: [
      { reply: { toolCalls: [tool("shell", { command: "stub", timeout_ms: 30000 })] } },
      { reply: { text: "不会被到达。" } }
    ],
    gatewayDelayMs: 0
  });
  t.after(() => h.cleanup());
  await h.agent.open({ projectRoot: h.projectRoot });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "普通任务", source: "chat" });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "排队任务", source: "chat" });
  await waitFor(h.agent, h.projectRoot, (_s, snap) =>
    eventsOfType(snap.events, "tool_call_started").length >= 1,
    { describe: "普通 Run 工具启动" }
  );
  const runId = (await readSession(h.agent, h.projectRoot)).active_run.id;
  // ESC 停止普通 Run（与前端 handleEscape 的 run 分支同一下层方法）
  const stopped = await h.agent.stop({ projectRoot: h.projectRoot, reason: "user_stop" });
  assert.equal(stopped.run_id, runId);
  assert.equal(stopped.cancelled, true);
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  assert.equal(eventsOfType(events, "run_cancelled").length, 1, "ESC 必须取消当前普通 Run");
  assert.equal(eventsOfType(events, "run_cancelled")[0].run_id, runId);
  assert.ok(eventsOfType(events, "input_cancelled").length >= 2, "活动与排队输入都应取消");
  assert.equal(eventsOfType(events, "run_completed").length, 0, "ESC 后不得出现 run_completed");
  assertActivityClosure(events);
});
