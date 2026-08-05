// Task 9: 聊天区实时活动视图契约测试。
// chat_activity SSE 事件 → createChatActivityView.consume：
//  1) 同一 activity_id 合并到同一行，output_delta 只追加文本不重建 DOM；
//  2) thinking 阶段的 output_delta（隐藏推理）不渲染；
//  3) 状态标记映射（running=• / succeeded=✓ / failed=✗ / cancelled=已停止）；
//  4) 停止按钮只在 running / requested 可见，终态隐藏；
//  5) 行结构用原生 details/summary（键盘可展开），输出是唯一的 .chat-activity-output；
//  6) clear() 清空全部行。
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createChatActivityView } from "../../src/app-shell/chat-activity-view.js";

// ---------------------------------------------------------------------------
// Minimal DOM mock (no JSDOM) — 与 thread-renderer.test.mjs 同风格
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
    this.isConnected = false;
    this._text = "";
    this._attrs = {};
    this._listeners = new Map();
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
    const dataSel = selector.match(/^\[data-([\w-]+)="?([^"\]]*)"?\]$/);
    if (dataSel) return String(this.dataset[MockElement._dataKey(dataSel[1])] ?? "") === dataSel[2];
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

// ---------------------------------------------------------------------------
// Install / restore global DOM mock（模块默认参数 document 需要）
// ---------------------------------------------------------------------------

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
// Test fixture
// ---------------------------------------------------------------------------

function makeHarness() {
  const root = new MockElement("div");
  const view = createChatActivityView({ root, document });
  return { root, view };
}

function commandEvent(overrides = {}) {
  return {
    type: "chat_activity",
    turn_id: "t1",
    activity_id: "a1",
    phase: "command",
    state: "running",
    label: "运行测试",
    command: "npm test",
    cwd: "D:\\Book",
    ...overrides,
  };
}

function tick() { return new Promise((resolve) => setTimeout(resolve, 0)); }

test("同一 activity_id 合并输出且不重复创建行", () => {
  const root = new MockElement("div");
  const view = createChatActivityView({ root, document });
  view.consume({
    type: "chat_activity", turn_id: "t1", activity_id: "a1", phase: "command", state: "running",
    label: "运行测试", command: "npm test", cwd: "D:\\Book", output_delta: "one\n",
  });
  view.consume({
    type: "chat_activity", turn_id: "t1", activity_id: "a1", phase: "command", state: "running",
    label: "运行测试", command: "npm test", cwd: "D:\\Book", output_delta: "two\n",
  });
  view.consume({
    type: "chat_activity", turn_id: "t1", activity_id: "a1", phase: "command", state: "succeeded",
    label: "测试完成", exit_code: 0, duration_ms: 35,
  });
  assert.equal(root.querySelectorAll('[data-activity-id="a1"]').length, 1);
  assert.match(root.textContent, /one\ntwo/u);
  assert.match(root.textContent, /退出码0/u);
});

test("思考状态不渲染隐藏推理文本", () => {
  const { root, view } = makeHarness();
  view.consume({
    type: "chat_activity", turn_id: "t1", activity_id: "a1", phase: "thinking",
    state: "running", label: "思考中", output_delta: "private reasoning",
  });
  assert.match(root.textContent, /思考中/u);
  assert.doesNotMatch(root.textContent, /private reasoning/u);
});

test("不同 activity_id 分别成行；clear 清空全部行", () => {
  const { root, view } = makeHarness();
  view.consume(commandEvent({ activity_id: "a1" }));
  view.consume(commandEvent({ activity_id: "a2", label: "另一条" }));
  assert.equal(root.querySelectorAll('[data-activity-id="a1"]').length, 1);
  assert.equal(root.querySelectorAll('[data-activity-id="a2"]').length, 1);
  assert.equal(root.querySelectorAll(".chat-activity-item").length, 2);
  view.clear();
  assert.equal(root.querySelectorAll(".chat-activity-item").length, 0);
  // clear 后同 id 可重新建行（无残留 Map 状态）
  view.consume(commandEvent({ activity_id: "a1" }));
  assert.equal(root.querySelectorAll('[data-activity-id="a1"]').length, 1);
});

test("停止按钮只在 running / requested 可见，终态隐藏", () => {
  const { root, view } = makeHarness();
  view.consume(commandEvent({ state: "running" }));
  const row = root.querySelector('[data-activity-id="a1"]');
  const stop = row.querySelector(".chat-stop-btn");
  assert.ok(stop, "running 行应有停止按钮");
  assert.equal(stop.hidden, false, "running 时停止按钮可见");
  view.consume(commandEvent({ state: "succeeded", exit_code: 0 }));
  assert.equal(stop.hidden, true, "succeeded 终态隐藏停止按钮");
  view.consume(commandEvent({ activity_id: "a9", state: "requested" }));
  assert.equal(root.querySelector('[data-activity-id="a9"]').querySelector(".chat-stop-btn").hidden, false, "requested 时停止按钮可见");
});

test("状态标记映射：succeeded=✓ / failed=✗ / cancelled=已停止 / running=•", () => {
  const { root, view } = makeHarness();
  view.consume(commandEvent({ state: "running" }));
  assert.equal(root.querySelector(".chat-activity-mark").textContent, "•");
  view.consume(commandEvent({ state: "succeeded", exit_code: 0 }));
  assert.equal(root.querySelector(".chat-activity-mark").textContent, "✓");
  view.consume(commandEvent({ activity_id: "a2", state: "failed", error: "boom" }));
  assert.equal(root.querySelector('[data-activity-id="a2"]').querySelector(".chat-activity-mark").textContent, "✗");
  view.consume(commandEvent({ activity_id: "a3", state: "cancelled" }));
  assert.equal(root.querySelector('[data-activity-id="a3"]').querySelector(".chat-activity-mark").textContent, "已停止");
});

test("行结构：details/summary 原生可键盘展开，输出是唯一 .chat-activity-output", () => {
  const { root, view } = makeHarness();
  view.consume(commandEvent({ output_delta: "line1\n" }));
  const row = root.querySelector('[data-activity-id="a1"]');
  const details = row.querySelector("details");
  assert.ok(details, "活动行应使用 <details>（原生键盘可展开）");
  assert.ok(details.querySelector("summary"), "details 内应有 summary");
  const outputs = row.querySelectorAll(".chat-activity-output");
  assert.equal(outputs.length, 1, "输出是唯一 .chat-activity-output");
  assert.equal(outputs[0].textContent, "line1\n");
  assert.match(row.textContent, /运行测试/u);
  assert.match(row.textContent, /npm test/u);
  assert.match(row.textContent, /D:\\Book/u);
});

test("非 chat_activity 事件被忽略；点击停止触发 onStop", () => {
  const root = new MockElement("div");
  let stopped = 0;
  const view = createChatActivityView({ root, document, onStop: () => { stopped += 1; } });
  view.consume({ type: "model_delta", text: "ignored" });
  assert.equal(root.querySelectorAll(".chat-activity-item").length, 0);
  view.consume(commandEvent({ state: "running" }));
  const stop = root.querySelector(".chat-stop-btn");
  stop._fire("click");
  assert.equal(stopped, 1, "点击停止应触发 onStop");
});

// ---------------------------------------------------------------------------
// I-2: 行数与输出上限（长会话防无限累积）
// ---------------------------------------------------------------------------

test("I-2 输出上限：超过 64KB 截断保留尾部，前置「输出过长已截断」提示，后续增量继续追加", () => {
  const { root, view } = makeHarness();
  const big = "y".repeat(70 * 1024) + "TAIL-END-123";
  view.consume(commandEvent({ output_delta: big }));
  const output = root.querySelector(".chat-activity-output");
  assert.match(output.textContent, /输出过长已截断/u, "超限后应出现截断提示");
  assert.ok(output.textContent.endsWith("TAIL-END-123"), "截断保留尾部内容");
  assert.ok(output.textContent.length <= 64 * 1024 + 40, "总长不超过上限 + 提示长度");
  view.consume(commandEvent({ output_delta: "more-tail" }));
  assert.ok(output.textContent.endsWith("more-tail"), "后续增量继续追加在尾部");
  assert.match(output.textContent, /输出过长已截断/u, "截断提示持续存在");
  // 再灌 66KB：保留窗口整体前移，最老的 TAIL-END-123 被挤出。
  view.consume(commandEvent({ output_delta: "z".repeat(66000) }));
  assert.ok(!output.textContent.includes("TAIL-END-123"), "超限后最老内容被挤掉");
  assert.ok(output.textContent.endsWith("z"), "保留窗口始终是最新尾部");
});

test("I-2 行数上限：超限裁剪最早的终态行，运行中的行保留", () => {
  const { root, view } = makeHarness();
  for (let i = 1; i <= 19; i += 1) {
    view.consume(commandEvent({ activity_id: `a${i}`, state: "succeeded", exit_code: 0 }));
  }
  view.consume(commandEvent({ activity_id: "r1", state: "running" }));
  view.consume(commandEvent({ activity_id: "r2", state: "running" }));
  assert.equal(root.querySelectorAll(".chat-activity-item").length, 20, "行数被裁剪到上限 20");
  assert.equal(root.querySelector('[data-activity-id="a1"]'), null, "最早的终态行被移除");
  assert.ok(root.querySelector('[data-activity-id="a2"]'), "较新的终态行保留");
  assert.ok(root.querySelector('[data-activity-id="r1"]'), "运行中的行保留");
  assert.ok(root.querySelector('[data-activity-id="r2"]'), "运行中的行保留");
});

test("I-2 行数上限：全部运行中时不裁剪（运行中的行不删）", () => {
  const { root, view } = makeHarness();
  for (let i = 1; i <= 21; i += 1) {
    view.consume(commandEvent({ activity_id: `live${i}`, state: "running" }));
  }
  assert.equal(root.querySelectorAll(".chat-activity-item").length, 21, "运行中的行不删（允许短暂超限）");
});

// ---------------------------------------------------------------------------
// M-2: 停止按钮防重
// ---------------------------------------------------------------------------

test("M-2 停止按钮防重：点击即禁用，连点只触发一次 onStop；终态事件后恢复", () => {
  const root = new MockElement("div");
  let stopped = 0;
  const view = createChatActivityView({ root, document, onStop: () => { stopped += 1; } });
  view.consume(commandEvent({ state: "running" }));
  const stop = root.querySelector(".chat-stop-btn");
  stop._fire("click");
  stop._fire("click");
  stop._fire("click");
  assert.equal(stopped, 1, "连点只触发一次 onStop");
  assert.equal(stop.disabled, true, "点击后禁用");
  view.consume(commandEvent({ state: "succeeded", exit_code: 0 }));
  assert.equal(stop.disabled, false, "终态事件后恢复");
  assert.equal(stop.hidden, true, "终态隐藏按钮");
});

test("M-2 停止按钮：onStop 失败（拒绝）时按钮恢复可点", async () => {
  const root = new MockElement("div");
  let stopped = 0;
  const view = createChatActivityView({
    root, document,
    onStop: () => { stopped += 1; return Promise.reject(new Error("409")); },
  });
  view.consume(commandEvent({ state: "running" }));
  const stop = root.querySelector(".chat-stop-btn");
  stop._fire("click");
  await tick();
  assert.equal(stop.disabled, false, "失败后恢复可点（可重试停止）");
  assert.equal(stopped, 1, "仍只触发一次 onStop");
});
