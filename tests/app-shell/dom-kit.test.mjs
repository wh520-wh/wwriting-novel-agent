// createToaster 钉测试（Task 13 评审补丁）：堆叠模式连续两条 toast 各自独立
// 消失——上一条的移除调度不得被下一条的 showToast 清除（修复前：showToast 开头
// 无条件 clearTimer，B 会把 A 的 timer 取消，A 永久滞留；本用例最后一条断言红）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createToaster } from "../../src/app-shell/dom-kit.js";

class MockElement {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this._attrs = {};
    this.className = "";
    this._text = null; // null = 未直接赋值，聚合 children 文本（真实 DOM 语义）
  }
  setAttribute(k, v) { this._attrs[k] = String(v); }
  append(...nodes) { for (const n of nodes) { n._parent = this; this.children.push(n); } }
  remove() { if (this._parent) { const i = this._parent.children.indexOf(this); if (i >= 0) this._parent.children.splice(i, 1); this._parent = null; } }
  get textContent() {
    if (this._text !== null) return this._text;
    return this.children.map((c) => c.textContent ?? "").join("");
  }
  set textContent(v) { this._text = String(v); }
}

class MockTextNode {
  constructor(text) { this.text = String(text); }
  get textContent() { return this.text; }
  set textContent(v) { this.text = String(v); }
}

// 手动推进的 scheduler：与 view.js scheduler 注入同语义（node:test 无真实计时）。
function makeScheduler() {
  let now = 0;
  let nextId = 1;
  const timers = new Map(); // id -> { at, fn }
  return {
    setTimeout(fn, ms) { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      now += ms;
      const due = [...timers.entries()].filter(([, t]) => t.at <= now);
      for (const [id, t] of due) { timers.delete(id); t.fn(); }
    }
  };
}

function makeStackedToaster() {
  const root = new MockElement("div");
  const scheduler = makeScheduler();
  const doc = {
    createElement: (tag) => new MockElement(tag),
    createTextNode: (text) => new MockTextNode(text)
  };
  const toaster = createToaster(() => root, {
    doc,
    scheduler,
    className: "toast",
    iconFor: () => null,
    timeoutFor: (type) => (type === "error" ? 5200 : 3200)
  });
  return { root, scheduler, ...toaster };
}

test("堆叠模式：连续两条 toast 各自到期独立移除，互不清除对方定时器", () => {
  const { root, showToast, scheduler } = makeStackedToaster();
  showToast("A", "error");
  showToast("B");
  assert.equal(root.children.length, 2, "两条 toast 同时可见");
  scheduler.advance(3200); // B（info）到期
  assert.equal(root.children.length, 1, "B 到期移除");
  assert.equal(root.children[0].textContent, "A", "A 不受 B 的调度影响");
  scheduler.advance(2000); // A（error，5200ms）到期
  assert.equal(root.children.length, 0, "A 到期移除（修复前此处红：A 被 B 清除定时器永久滞留）");
});
