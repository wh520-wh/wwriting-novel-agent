// 第十六轮 T12：view/cards.mjs 分区行为测试（唯一零覆盖分区）。
// 覆盖：决策卡三按钮/精确文字确认、错误卡连接中断与模型未配置分支、
// 排队行下一条标记与「立即」禁用、终态 Run 决策卡全下架。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCardsView } from "../../src/app-shell/agent/view/cards.mjs";
import { TERMINAL_RUN_STATUSES } from "../../src/app-shell/agent/state.js";

class MockElement {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this._text = "";
    this.disabled = false;
    this._listeners = new Map();
    this._attrs = {};
    this.parent = null;
    this.classList = {
      add: (...xs) => { this._classes = [...new Set([...(this._classes ?? []), ...xs])]; },
      toggle: (x, on) => {
        this._classes = this._classes ?? [];
        if (on) this._classes = [...new Set([...this._classes, x])];
        else this._classes = this._classes.filter((c) => c !== x);
      },
      contains: (x) => (this._classes ?? []).includes(x)
    };
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  get value() { return this._value ?? ""; }
  set value(v) { this._value = String(v); }
  append(...nodes) {
    for (const n of nodes) { n.parent = this; this.children.push(n); }
  }
  replaceChildren() { this.children = []; }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
  }
  setAttribute(k, v) { this._attrs[k] = v; }
  getAttribute(k) { return this._attrs[k]; }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  dispatch(type, evt = {}) {
    for (const fn of this._listeners.get(type) ?? []) fn({ target: this, ...evt });
  }
  // 测试辅助：按 data-testid 深度找第一个
  query(testid) {
    if (this.dataset.testid === testid) return this;
    for (const c of this.children) { const hit = c.query?.(testid); if (hit) return hit; }
    return null;
  }
}

function makeCtx() {
  const doc = { createElement: (tag) => new MockElement(tag) };
  return {
    doc,
    decisionsSlot: new MockElement("div"),
    errorsSlot: new MockElement("div"),
    queueSlot: new MockElement("div"),
    decisionCards: new Map(),
    rendered: {},
    timeline: { afterRender() {}, reconcilePendingSubmission() {} },
    showToast() {},
    input: new MockElement("textarea"),
    actions: { decide() { this.decided = [...(this.decided ?? []), arguments]; } },
    viewGeneration: 1
  };
}

function stateWithRun(overrides = {}) {
  return {
    revisions: { decisions: {}, errors: {}, queue: {}, ...overrides.revisions },
    session: {
      active_run: { id: "run-1", status: "running", ...(overrides.run ?? {}) },
      queued_inputs: overrides.queued_inputs ?? [],
      priority_input_id: overrides.priority_input_id ?? null,
      ...(overrides.session ?? {})
    },
    decisions: overrides.decisions ?? new Map(),
    errors: overrides.errors ?? []
  };
}

test("syncDecisions: pending 普通决策渲染三选择按钮，decide 回调带 id", () => {
  const ctx = makeCtx();
  const view = createCardsView(ctx);
  const decisions = new Map([["d1", { decision_id: "d1", run_id: "run-1", status: "pending", kind: "normal", title: "允许写入" }]]);
  view.syncDecisions(stateWithRun({ decisions, revisions: { decisions: { v: 1 } } }));
  const card = ctx.decisionsSlot.query("agent-decision-card");
  assert.ok(card, "决策卡已挂载");
  const choice = ctx.decisionsSlot.query("agent-decision-choice");
  assert.ok(choice, "普通决策有选择按钮");
  choice.dispatch("click");
  assert.equal(ctx.actions.decided[0][0], "d1");
});

test("syncDecisions: extreme 精确文字确认——输入不符执行禁用", () => {
  const ctx = makeCtx();
  const view = createCardsView(ctx);
  const decisions = new Map([["d2", { decision_id: "d2", run_id: "run-1", status: "pending", kind: "extreme", title: "删除章节", confirmation_text: "我确认删除" }]]);
  view.syncDecisions(stateWithRun({ decisions, revisions: { decisions: { v: 1 } } }));
  const input = ctx.decisionsSlot.query("agent-decision-input");
  const execute = ctx.decisionsSlot.query("agent-decision-execute");
  assert.equal(execute.disabled, true);
  input.value = "我确认删除";
  input.dispatch("input");
  assert.equal(execute.disabled, false);
});

test("syncDecisions: Run 终态时全部决策卡下架", () => {
  const ctx = makeCtx();
  const view = createCardsView(ctx);
  const decisions = new Map([["d3", { decision_id: "d3", run_id: "run-1", status: "pending", kind: "normal", title: "x" }]]);
  view.syncDecisions(stateWithRun({ decisions, revisions: { decisions: { v: 1 } } }));
  assert.ok(ctx.decisionsSlot.query("agent-decision-card"));
  const terminal = [...TERMINAL_RUN_STATUSES][0];
  view.syncDecisions(stateWithRun({
    decisions,
    run: { status: terminal },
    revisions: { decisions: { v: 2 } }
  }));
  assert.equal(ctx.decisionCards.size, 0);
  assert.equal(ctx.decisionsSlot.query("agent-decision-card"), null);
});

test("syncErrors: 连接中断标题与模型未配置恢复按钮", () => {
  const ctx = makeCtx();
  const view = createCardsView(ctx);
  view.syncErrors({
    revisions: { errors: { v: 1 } },
    errors: [
      { code: "event_stream_fatal", message: "SSE 断开" },
      { code: "provider_configuration_error", message: "no model" }
    ]
  });
  const titles = [...ctx.errorsSlot.children].map((c) => c.query("agent-error-title")?._text ?? c.children[0]?._text);
  assert.ok(titles.some((t) => t === "连接中断"));
  assert.ok(ctx.errorsSlot.query("agent-error-settings"), "模型未配置有「打开模型设置」按钮");
});

test("syncQueue: 排队行渲染、优先输入禁用全部「立即」、目标项标下一条", () => {
  const ctx = makeCtx();
  const view = createCardsView(ctx);
  view.syncQueue(stateWithRun({
    queued_inputs: [{ id: "q1", text: "先写这个" }, { id: "q2", text: "再写那个" }],
    priority_input_id: "q2",
    revisions: { queue: { v: 1 } }
  }));
  const rows = ctx.queueSlot.children.filter((c) => c.dataset.testid === "agent-queue-item");
  assert.equal(rows.length, 2);
  const badges = rows.map((r) => r.children.find((c) => c.className === "agent-queue-state")._text);
  // 顺序由 queued_inputs 保持（getQueuedInputs 原样透出）：rows[0]=q1、rows[1]=q2。
  // 按行关联精确断言，不 sort——sort 会放过「总是第一行标下一条」的回归。
  assert.deepEqual(badges, ["排队", "下一条"]);
  const promote = rows[0].query("agent-promote");
  assert.equal(promote.disabled, true, "优先输入在途时「立即」全部禁用");
});