// Task 11 Step 1: 上下文圆环纯 DOM/可访问性模块契约测试（无 JSDOM，最小 mock）。
//
// 覆盖（brief Step 1）：
//   - role=button / tabindex=0 / aria-describedby / aria-expanded；
//   - 未装配（usage=null）时 popover 显示「计算中」而不是假 0，圆环无 dash；
//   - usage 就绪后 SVG circle stroke-dasharray 由 ratio 映射（不用 canvas）；
//   - hover/focus 打开、点击固定（data-pinned="true"）、再次点击/外部点击关闭；
//   - ESC 关闭经 surface 统一路由（dismissTopLayer → dismiss()），圆环不自挂 document keydown；
//   - popover 内容含已用 tokens、窗口、百分比、窗口来源；
//   - setActive 只在显式激活时加 agent-context-ring--active；reduced-motion 下不加；
//   - popover 不改变布局高度（绝对定位，不带布局位移的 transform/opacity 过渡）。
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createContextRing } from "../../src/app-shell/agent/context-ring.js";

// ---------------------------------------------------------------------------
// 最小 DOM mock（沿用 agent-surface.test.mjs 风格，补齐 contains / doc 事件）
// ---------------------------------------------------------------------------

class TextNode {
  constructor(text) {
    this.text = String(text);
  }
  get textContent() { return this.text; }
  set textContent(value) { this.text = String(value); }
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
    this._html = "";
    this._attrs = {};
    this._listeners = new Map();
    this._parent = null;
    const classSet = new Set();
    Object.defineProperty(this, "className", {
      get() { return [...classSet].join(" "); },
      set(value) {
        classSet.clear();
        for (const c of String(value).split(/\s+/)) if (c) classSet.add(c);
      },
      enumerable: true,
      configurable: true
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
      toString: () => [...classSet].join(" ")
    };
  }

  get textContent() {
    return this._text +
      (this._html ? this._html.replace(/<[^>]*>/g, "") : "") +
      this.children.map((c) => (typeof c.textContent === "string" ? c.textContent : "")).join("");
  }
  set textContent(value) {
    this._text = String(value);
    this._html = "";
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
  contains(node) {
    if (node === this) return true;
    return this.children.some((child) => child instanceof MockElement && child.contains(node));
  }
  setAttribute(name, value) { this._attrs[name] = String(value); }
  getAttribute(name) { return this._attrs[name] ?? null; }
  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }
  removeEventListener(type, handler) {
    const list = this._listeners.get(type) ?? [];
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
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

const realDoc = globalThis.document;
let doc;

before(() => {
  doc = {
    createElement: (tag) => new MockElement(tag),
    createElementNS: (_ns, tag) => new MockElement(tag),
    createTextNode: (text) => new TextNode(text),
    _listeners: new Map(),
    addEventListener(type, handler) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const list = this._listeners.get(type) ?? [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    _fire(type, ...args) {
      for (const fn of this._listeners.get(type) ?? []) fn(...args);
    }
  };
  globalThis.document = doc;
});

after(() => {
  if (realDoc === undefined) delete globalThis.document;
  else globalThis.document = realDoc;
  if (globalThis.window !== undefined) delete globalThis.window;
});

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const READY_USAGE = {
  status: "ready",
  used_tokens: 163840,
  raw_tokens: 150000,
  effective_context_window: 256000,
  compaction_threshold: 204800,
  ratio: 0.64,
  window_source: "default_256k",
  estimator: "local",
  approximate: true,
  model: "deepseek-chat",
  updated_at: "2026-08-08T00:00:00.000Z"
};

function makeRing({ onToggle = null, onDismiss = null } = {}) {
  const root = new MockElement("div");
  const ring = createContextRing({ document: doc, onToggle, onDismiss });
  root.append(ring.element);
  return { root, ring, onToggle: onToggle ?? (() => {}), onDismiss: onDismiss ?? (() => {}) };
}

// ===========================================================================
// 可访问性与结构
// ===========================================================================

test("圆环是按钮：role=button、tabindex=0、aria-expanded，并描述 popover", () => {
  const { root } = makeRing();
  const button = root.querySelector('[data-testid="agent-context-ring"]');
  assert.ok(button, "圆环按钮应存在");
  assert.equal(button.getAttribute("role"), "button");
  assert.equal(button.getAttribute("tabindex"), "0");
  assert.equal(button.getAttribute("aria-expanded"), "false", "初始未展开");
  const popover = root.querySelector('[data-testid="agent-context-popover"]');
  assert.ok(popover, "popover 应存在");
  assert.equal(button.getAttribute("aria-describedby"), popover.getAttribute("id"), "aria-describedby 指向 popover id");
  assert.ok(button.querySelector("svg"), "圆环使用 SVG，不使用 canvas");
});

test("未装配时 popover 显示「计算中」而不是假 0，圆环无 dash 值", () => {
  const { root, ring } = makeRing();
  ring.setUsage(null);
  const popover = root.querySelector('[data-testid="agent-context-popover"]');
  const button = root.querySelector('[data-testid="agent-context-ring"]');
  button._fire("click");
  assert.equal(popover.dataset.open, "true");
  assert.match(popover.textContent, /计算中|待校准/u);
  assert.doesNotMatch(popover.textContent, /0\s*(?:tokens|%)|0%/u, "计算中不得出现假 0");
  const value = button.querySelectorAll("circle").find((el) => el.classList.contains("agent-context-ring-value"));
  assert.ok(value, "应有 value 圆环");
  assert.match(value.getAttribute("stroke-dasharray") ?? "", /^0/u, "未装配时 value 圆环无 dash");
});

test("usage 就绪后：dasharray 按 ratio 映射，popover 含 tokens/窗口/百分比/来源", () => {
  const { root, ring } = makeRing();
  ring.setUsage(READY_USAGE);
  const button = root.querySelector('[data-testid="agent-context-ring"]');
  const value = button.querySelectorAll("circle").find((el) => el.classList.contains("agent-context-ring-value"));
  const C = 2 * Math.PI * 9;
  const dash = value.getAttribute("stroke-dasharray") ?? "";
  const [shown, total] = dash.split(/\s+/).map(Number);
  assert.ok(Math.abs(shown / total - 0.64) < 0.01, "dash 比例应映射 ratio 0.64");
  button._fire("click");
  const popover = root.querySelector('[data-testid="agent-context-popover"]');
  assert.match(popover.textContent, /约.*163,840|163,840/u, "应显示已用 tokens（约 + 千分位）");
  assert.match(popover.textContent, /256,000/u, "应显示窗口大小");
  assert.match(popover.textContent, /64%/u, "应显示百分比");
  assert.match(popover.textContent, /256k|1M/u, "应显示窗口来源");
});

test("1M 已配置窗口按实际大小显示", () => {
  const { root, ring } = makeRing();
  ring.setUsage({ ...READY_USAGE, effective_context_window: 1000000, window_source: "configured", ratio: 0.3 });
  const button = root.querySelector('[data-testid="agent-context-ring"]');
  button._fire("click");
  const popover = root.querySelector('[data-testid="agent-context-popover"]');
  assert.match(popover.textContent, /1M/u);
  assert.doesNotMatch(popover.textContent, /256k/u);
});

// ===========================================================================
// 打开/固定/关闭
// ===========================================================================

test("hover/focus 打开（不固定），blur/mouseleave 关闭；点击固定，再次点击关闭", () => {
  const { root } = makeRing();
  const button = root.querySelector('[data-testid="agent-context-ring"]');
  const popover = root.querySelector('[data-testid="agent-context-popover"]');

  button._fire("mouseenter");
  assert.equal(popover.dataset.open, "true", "hover 打开");
  assert.equal(button.dataset.pinned, undefined, "hover 打开不固定");
  button._fire("mouseleave");
  assert.equal(popover.dataset.open, "false", "未固定时离开关闭");

  button._fire("focus");
  assert.equal(popover.dataset.open, "true", "focus 打开");
  button._fire("blur");
  assert.equal(popover.dataset.open, "false", "未固定时失焦关闭");

  button._fire("click");
  assert.equal(popover.dataset.open, "true", "点击打开");
  assert.equal(button.dataset.pinned, "true", "点击固定");
  button._fire("mouseleave");
  button._fire("blur");
  assert.equal(popover.dataset.open, "true", "固定后 hover/blur 不关闭");

  button._fire("click");
  assert.equal(popover.dataset.open, "false", "再次点击关闭");
  assert.equal(button.dataset.pinned, undefined, "关闭后取消固定");
});

test("外部 pointerdown 关闭已固定 popover", () => {
  const { root } = makeRing();
  const button = root.querySelector('[data-testid="agent-context-ring"]');
  const popover = root.querySelector('[data-testid="agent-context-popover"]');
  button._fire("click");
  assert.equal(popover.dataset.open, "true");
  doc._fire("pointerdown", { target: root });
  assert.equal(popover.dataset.open, "false", "外部点击关闭");
  assert.equal(button.dataset.pinned, undefined);
});

test("popover 内部 pointerdown 不关闭", () => {
  const { root } = makeRing();
  const button = root.querySelector('[data-testid="agent-context-ring"]');
  const popover = root.querySelector('[data-testid="agent-context-popover"]');
  button._fire("click");
  doc._fire("pointerdown", { target: popover });
  assert.equal(popover.dataset.open, "true", "popover 内部点击保持打开");
});

test("ESC 经统一路由关闭（Task 12）：圆环不挂 document-level keydown，dismiss() 是关闭入口", () => {
  const { root, ring } = makeRing();
  const button = root.querySelector('[data-testid="agent-context-ring"]');
  const popover = root.querySelector('[data-testid="agent-context-popover"]');
  button._fire("click");
  assert.equal(popover.dataset.open, "true");
  // 圆环自身不再消费 document ESC（全局路由 app.js → surface.handleEscape →
  // dismissTopLayer → dismiss() 是唯一关闭路径），防止与全局路由重复执行。
  doc._fire("keydown", { key: "Escape", preventDefault: () => {} });
  assert.equal(popover.dataset.open, "true", "圆环不自行消费 document ESC");
  // surface 的 dismissTopLayer 调用 dismiss() 关闭并取消固定。
  ring.dismiss();
  assert.equal(popover.dataset.open, "false", "dismiss() 关闭 popover");
  assert.equal(button.dataset.pinned, undefined);
});

test("Enter/Space 键等价于点击（打开并固定，再次按下关闭）", () => {
  const { root } = makeRing();
  const button = root.querySelector('[data-testid="agent-context-ring"]');
  const popover = root.querySelector('[data-testid="agent-context-popover"]');
  button._fire("keydown", { key: "Enter", preventDefault: () => {} });
  assert.equal(popover.dataset.open, "true");
  assert.equal(button.dataset.pinned, "true");
  button._fire("keydown", { key: " ", preventDefault: () => {} });
  assert.equal(popover.dataset.open, "false");
});

test("onToggle/onDismiss 回调随开关触发", () => {
  const events = [];
  const { root } = makeRing({
    onToggle: (open) => events.push(["toggle", open]),
    onDismiss: () => events.push(["dismiss"])
  });
  const button = root.querySelector('[data-testid="agent-context-ring"]');
  button._fire("click");
  button._fire("click");
  assert.deepEqual(events, [["toggle", true], ["toggle", false], ["dismiss"]]);
});

// ===========================================================================
// 活性与 reduced-motion
// ===========================================================================

test("setActive(true) 加活性 class，setActive(false) 移除", () => {
  const { root, ring } = makeRing();
  const button = root.querySelector('[data-testid="agent-context-ring"]');
  ring.setActive(true);
  assert.ok(button.classList.contains("agent-context-ring--active"));
  ring.setActive(false);
  assert.equal(button.classList.contains("agent-context-ring--active"), false);
});

test("reduced-motion 下 setActive 不加循环动画 class（圆环保持静态）", () => {
  globalThis.window = {
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} })
  };
  try {
    const { root, ring } = makeRing();
    const button = root.querySelector('[data-testid="agent-context-ring"]');
    ring.setActive(true);
    assert.equal(button.classList.contains("agent-context-ring--active"), false, "reduced-motion 下不加活性 class");
  } finally {
    delete globalThis.window;
  }
});

test("destroy 后移除 doc 级监听，外部点击不再关闭（已无监听）", () => {
  const { root, ring } = makeRing();
  const button = root.querySelector('[data-testid="agent-context-ring"]');
  const popover = root.querySelector('[data-testid="agent-context-popover"]');
  button._fire("click");
  assert.equal(popover.dataset.open, "true");
  ring.destroy();
  doc._fire("pointerdown", { target: root });
  assert.equal(popover.dataset.open, "true", "destroy 后外部点击不再触发关闭");
});

// ===========================================================================
// 第九轮：缓存命中率常驻显示
// ===========================================================================

test("第九轮：popover 在 cache_hit_rate 可读时常驻显示「缓存命中率：X%」", () => {
  const { root, ring } = makeRing();
  ring.setUsage({
    status: "ready",
    used_tokens: 5000,
    effective_context_window: 100000,
    window_source: "default_256k",
    cache_hit_rate: 0.87
  });
  const button = root.querySelector('[data-testid="agent-context-ring"]');
  button._fire("mouseenter");
  const popover = root.querySelector('[data-testid="agent-context-popover"]');
  assert.match(popover.textContent, /缓存命中率：87%/u, "格式：缓存命中率：<整数>%（中文冒号）");
  assert.match(popover.textContent, /上下文用量/u, "原有用量信息保留");
});

test("第九轮：cache_hit_rate 缺失/不可读时不显示该行（不出现假 0）", () => {
  const { root, ring } = makeRing();
  ring.setUsage({ status: "ready", used_tokens: 5000, effective_context_window: 100000, window_source: "default_256k" });
  const button = root.querySelector('[data-testid="agent-context-ring"]');
  button._fire("mouseenter");
  const popover = root.querySelector('[data-testid="agent-context-popover"]');
  assert.doesNotMatch(popover.textContent, /缓存命中率/u, "无数据不显示");
});
