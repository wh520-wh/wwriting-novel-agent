// AgentSurface 终态渲染契约（统一 Agent 内核计划 Task 9 改写）。
//
// 原 thread-renderer-finish 测试的仍然有效行为迁移到 AgentSurface：
//   - 终态（completed/cancelled）每活动只渲染一次标记，不重复播报；
//   - Run 完成后不再有第二个状态横幅；停止不产生重复的已停止横幅；
//   - 终态活动折叠在 work-group 的 details 内；工具工作项详情为整行点击
//     （R1，div + 角色按钮，去 details/summary），无手动编辑入口。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

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
      // 第十二轮 F6：真实 DOM 语义——append 已挂载节点是「移动」而非复制。
      if (node instanceof MockElement) node.remove();
      node._parent = this;
      this.children.push(node);
    }
  }
  appendChild(node) {
    if (node instanceof MockElement) node.remove();
    node._parent = this;
    this.children.push(node);
    return node;
  }
  insertBefore(node, refNode) {
    // 第十二轮 F6：真实 DOM 语义——已在树的节点先移除再插入（移动）；
    // refNode 为 null 时等效 append。
    if (node instanceof MockElement) node.remove();
    let index = refNode == null ? this.children.length : this.children.indexOf(refNode);
    if (index < 0) index = this.children.length;
    this.children.splice(index, 0, node);
    node._parent = this;
    return node;
  }
  get lastElementChild() {
    return this.children.length > 0 ? this.children[this.children.length - 1] : null;
  }
  get nextSibling() {
    if (!this._parent) return null;
    const index = this._parent.children.indexOf(this);
    return index >= 0 && index + 1 < this._parent.children.length
      ? this._parent.children[index + 1]
      : null;
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

test("Run 完成后只渲染一次终态：无重复状态横幅，工具终态标记单次", async () => {
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

  // 工具工作项只有一条，且终态标记只出现一次（工作组已插入 messages 时间线）
  const toolRows = [...root.querySelectorAll(".agent-work-item")].filter((el) => el.dataset.kind === "tool");
  assert.equal(toolRows.length, 1, "同一活动只渲染一个工具工作项");
  assert.equal(toolRows[0].dataset.state, "completed");
  const completedMarks = toolRows[0].querySelectorAll(".agent-work-item__icon");
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

  const toolRows = [...root.querySelectorAll(".agent-work-item")].filter((el) => el.dataset.kind === "tool");
  assert.equal(toolRows.length, 1, "停止后仍只有一个工具工作项");
  assert.equal(toolRows[0].dataset.state, "cancelled");
  const cancelledMarks = toolRows[0].querySelectorAll(".agent-work-item__icon");
  assert.equal(cancelledMarks.length, 1);
  assert.equal(cancelledMarks[0].textContent, "已停止");
  // 终态 Run 头部不再有停止按钮
  assert.equal(root.querySelector("[data-testid='agent-stop']"), null);
});

test("终态工具工作项折叠为整行点击（div 详情区，无手动编辑入口）", async () => {
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

  const row = [...root.querySelectorAll(".agent-work-item")].find((el) => el.dataset.kind === "tool");
  assert.ok(row, "工具工作项应存在");
  assert.equal(row.querySelector("details"), null, "工具详情不再使用原生 details");
  const details = row.querySelector(".agent-tool-details");
  assert.equal(details.tagName, "div", "详情区改为 div");
  assert.ok(details.querySelector(".agent-tool-fields"), "详情字段在详情区内");
  assert.equal(details.hidden, true, "终态工具默认收起");
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

// ---------------------------------------------------------------------------
// Task 1 复现夹具：真实事件链经生产入口回放（openProject → snapshot → 逐条 SSE）。
// 只通过 createAgentSurface().openProject() 与 applyEvent() 驱动，不直接调用
// insertTimeline()。夹具见 tests/fixtures/agent-ui/*.json（计划 Task 1 Step 1）。
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));

async function loadAgentUiFixture(name) {
  return JSON.parse(await fs.readFile(path.join(here, "..", "fixtures", "agent-ui", name), "utf8"));
}

// 快照只返回服务端权威会话投影；事件全部经 SSE 增量路径逐条 applyEvent，
// 与生产「打开项目拿快照 + 长连接推送增量」一致。
function makeFixtureApi(fixture) {
  return {
    openProject: async () => {},
    submit: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
    retry: async () => ({ ok: true }),
    decide: async () => ({ ok: true }),
    fetchSnapshot: async ({ tail }) =>
      tail ? { ok: true, session: fixture.session, events: [] } : null,
    connectEvents: () => {},
    destroy: () => {}
  };
}

async function replayFixture(fixture) {
  const root = new MockElement("div");
  const { createAgentSurface } = await import("../../src/app-shell/agent/index.js");
  const surface = createAgentSurface({ root, api: makeFixtureApi(fixture) });
  await surface.openProject("D:\\novel");
  for (const event of fixture.events) surface.applyEvent(event);
  return { root, surface };
}

test("生产入口回放 final-answer-hidden：折叠工作组后助手最终答案正文仍存在且非空", async () => {
  const fixture = await loadAgentUiFixture("final-answer-hidden.json");
  const { root } = await replayFixture(fixture);

  const group = root.querySelector(".agent-work-group");
  assert.ok(group, "回放应渲染 completed 工作组");
  assert.equal(group.open, false, "completed 工作组应自动折叠为关闭态");

  const assistant = root.querySelector(".agent-message--assistant");
  assert.ok(assistant, "折叠工作组时 .agent-message--assistant 节点仍应存在");
  // 正文缺失缺陷复现：纯 DOM mock 不解析 innerHTML，markdown 渲染的助手正文
  // textContent 为空 → 该断言失败（正文缺失）。Task 10 修复后必须转绿。
  assert.match(
    root.querySelector(".agent-message--assistant")?.textContent ?? "",
    /默认可见的最终答案/u,
    "助手最终答案正文不得为空，必须保持默认可见"
  );
});

test("Task 12 全中文文案：回放 Task 1 夹具，界面无 Worked for / નિર્ણ / 英文 running 文案", async () => {
  for (const name of ["final-answer-hidden.json", "tool-before-answer.json"]) {
    const fixture = await loadAgentUiFixture(name);
    const { root } = await replayFixture(fixture);
    const text = root.textContent;
    assert.doesNotMatch(text, /Worked for/u, `${name} 不得出现英文耗时文案`);
    assert.doesNotMatch(text, /નિર્ણ/u, `${name} 不得出现 Gujarati 乱码`);
    assert.doesNotMatch(text, /\b(?:Running|Thinking|waiting_user|interrupting|stopping)\b/u, `${name} 状态文本应为全中文`);
    assert.match(text, /工作中|工作了/u, `${name} 工作组状态行使用中文文案`);
  }
});
