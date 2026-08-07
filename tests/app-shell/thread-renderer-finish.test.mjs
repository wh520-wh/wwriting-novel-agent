// AgentSurface 终态渲染契约（统一 Agent 内核计划 Task 9 改写）。
//
// 原 thread-renderer-finish 测试的仍然有效行为迁移到 AgentSurface：
//   - 终态（completed/cancelled）每活动只渲染一次标记，不重复播报；
//   - Run 完成后不再有第二个状态横幅；停止不产生重复的已停止横幅；
//   - 终态活动折叠在 details 内（native details/summary），无手动编辑入口。
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

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
    return this._text + this.children
      .map((c) => (typeof c.textContent === "string" ? c.textContent : ""))
      .join("");
  }
  set textContent(value) {
    this._text = String(value);
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

let seqCounter = 1000;
function ev(type, payload = {}, extra = {}) {
  seqCounter += 1;
  return {
    seq: seqCounter,
    event_id: `evt-${seqCounter}`,
    session_id: "sess-test",
    run_id: "run-1",
    type,
    payload,
    at: "2026-08-06T00:00:00.000Z",
    ...extra
  };
}

function session(overrides = {}) {
  return {
    schema_version: 1,
    session_id: "sess-test",
    project_root: "D:\\novel",
    status: "idle",
    active_run: null,
    queued_inputs: [],
    last_seq: 0,
    updated_at: "2026-08-06T00:00:00.000Z",
    ...overrides
  };
}

function activeRun(overrides = {}) {
  return {
    id: "run-1",
    status: "running",
    workflow: "general",
    active_input_id: "in-1",
    visible_plan: null,
    active_grants: [],
    started_at: "2026-08-06T00:00:00.000Z",
    ...overrides
  };
}

function snapshotOf(s) {
  return { ok: true, session: s, events: [] };
}

function makeFakeApi() {
  return {
    openProject: async () => {},
    submit: async () => ({ ok: true }),
    promote: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
    retry: async () => ({ ok: true }),
    decide: async () => ({ ok: true }),
    fetchSnapshot: async () => null,
    connectEvents: () => {},
    destroy: () => {}
  };
}

async function makeSurface() {
  const root = new MockElement("div");
  const { createAgentSurface } = await import("../../src/app-shell/agent/index.js");
  const surface = createAgentSurface({ root, api: makeFakeApi() });
  return { root, surface };
}

test("Run 完成后只渲染一次终态：无重复状态横幅，活动终态标记单次", async () => {
  const { root, surface } = await makeSurface();
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("tool_call_started", {
    tool_call_id: "tc-1",
    activity_id: "act-1",
    name: "shell",
    args: { command: "npm test" }
  }));
  surface.applyEvent(ev("tool_output_delta", {
    tool_call_id: "tc-1", activity_id: "act-1", name: "shell", stream: "stdout", text: "ok"
  }));
  surface.applyEvent(ev("tool_call_completed", {
    tool_call_id: "tc-1", activity_id: "act-1", name: "shell", args: { command: "npm test" }, exit_code: 0
  }));
  surface.applyEvent(ev("assistant_message_completed", { input_id: "in-1" }));
  surface.applyEvent(ev("run_completed", {}));
  surface.applySnapshot(snapshotOf(session({ status: "idle", active_run: activeRun({ status: "completed" }) })));

  // 活动行只有一条，且终态标记只出现一次（活动行已插入 messages 时间线）
  const activityRows = root.querySelectorAll(".agent-activity-item");
  assert.equal(activityRows.length, 1, "同一活动只渲染一行");
  assert.equal(activityRows[0].dataset.state, "completed");
  const completedMarks = activityRows[0].querySelectorAll(".agent-activity-mark");
  assert.equal(completedMarks.length, 1);
  assert.equal(completedMarks[0].textContent, "✓");
});

test("停止不产生第二个已停止横幅：终态只渲染一次", async () => {
  const { root, surface } = await makeSurface();
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("tool_call_started", {
    tool_call_id: "tc-2",
    activity_id: "act-2",
    name: "shell",
    args: { command: "node slow.js" }
  }));
  surface.applyEvent(ev("run_status_changed", { status: "stopping", reason: "user_stop" }));
  // 停止时在途 Shell 被中止：shell runtime 以 shell_cancelled 闭合该活动（终态 cancelled）
  surface.applyEvent(ev("tool_call_failed", {
    tool_call_id: "tc-2", activity_id: "act-2", name: "shell", error: "shell_cancelled", message: "命令已停止。"
  }));
  surface.applyEvent(ev("input_cancelled", { input_id: "in-1" }));
  surface.applyEvent(ev("run_cancelled", { reason: "user_stop" }));
  surface.applySnapshot(snapshotOf(session({ status: "idle", active_run: activeRun({ status: "cancelled" }) })));
  // 再次推送同样的终态快照（轮询重放）：不得重复渲染横幅
  surface.applySnapshot(snapshotOf(session({ status: "idle", active_run: activeRun({ status: "cancelled" }) })));

  const activityRows = root.querySelectorAll(".agent-activity-item");
  assert.equal(activityRows.length, 1, "停止后仍只有一条活动行");
  assert.equal(activityRows[0].dataset.state, "cancelled");
  const cancelledMarks = activityRows[0].querySelectorAll(".agent-activity-mark");
  assert.equal(cancelledMarks.length, 1);
  assert.equal(cancelledMarks[0].textContent, "已停止");
  // 终态 Run 头部不再有停止按钮
  assert.equal(root.querySelector("[data-testid='agent-stop']"), null);
});

test("终态活动折叠在原生 details 内（无手动编辑入口）", async () => {
  const { root, surface } = await makeSurface();
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("tool_call_started", {
    tool_call_id: "tc-3",
    activity_id: "act-3",
    name: "shell",
    args: { command: "echo done", purpose: "测试" }
  }));
  surface.applyEvent(ev("tool_call_completed", {
    tool_call_id: "tc-3", activity_id: "act-3", name: "shell", args: { command: "echo done" }, exit_code: 0
  }));
  surface.applyEvent(ev("run_completed", {}));
  surface.applySnapshot(snapshotOf(session({ status: "idle", active_run: activeRun({ status: "completed" }) })));

  const row = root.querySelector(".agent-activity-item");
  assert.ok(row, "活动行应存在");
  const details = row.querySelector("details");
  assert.ok(details, "活动行应使用原生 details 折叠");
  const detailFields = details.querySelector(".agent-activity-fields");
  assert.ok(detailFields, "详情字段应折叠在 details 内");
});

test("重放快照后工作组按时间线落位：最终回复位于 work group 之后", async () => {
  const { root, surface } = await makeSurface();
  surface.applySnapshot({
    ok: true,
    session: session({ status: "idle", active_run: activeRun({ status: "completed", active_elapsed_ms: 3000 }) }),
    events: [
      { ...ev("input_queued", { input_id: "in-1", text: "继续写", source: "chat" }), seq: 1 },
      { ...ev("run_started", { workflow: "general", input_id: "in-1" }), seq: 2 },
      { ...ev("tool_call_started", { tool_call_id: "tc-1", activity_id: "act-1", name: "shell", args: { command: "npm test" } }), seq: 3 },
      { ...ev("tool_call_completed", { tool_call_id: "tc-1", activity_id: "act-1", name: "shell", exit_code: 0 }), seq: 4 },
      { ...ev("assistant_message_completed", { input_id: "in-1", text: "全部通过" }), seq: 5 },
      { ...ev("run_completed", {}), seq: 6 }
    ]
  });
  const group = root.querySelector(".agent-work-group");
  const assistant = root.querySelector('[data-testid="agent-assistant-message"]');
  assert.ok(group, "重放应渲染工作组");
  assert.ok(assistant, "重放应渲染最终回复");
  assert.ok(group._parent === assistant._parent, "工作组与最终回复同属时间线");
  const index = (el) => el._parent.children.indexOf(el);
  assert.ok(index(group) < index(assistant), "最终回复位于 work group 之后");
});
