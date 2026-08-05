import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { createComposer } from "../../src/app-shell/composer.js";

// ---------------------------------------------------------------------------
// 视口夹具：document / window mock（模型菜单钳制测试用，无 JSDOM）
// 约定：.model-popover 宽 = min(420px, 100vw - 32px)，默认 left: 12px（相对 composer）；
// getBoundingClientRect 按当前视口与 style.left 动态推导，模拟真实布局。
// ---------------------------------------------------------------------------

const registry = new Map();        // id → element
const docListeners = new Map();
const winListeners = new Map();
let viewport = { width: 1440, height: 900 };
const POPOVER_CSS_LEFT = 12;       // .mode-popover 默认 left
const POPOVER_CSS_WIDTH = 420;     // width: min(420px, 100vw - 32px) 的 420 上限

class MockEl {
  constructor(tag) {
    this.tagName = tag;
    this.hidden = false;
    this.style = {};
    this.dataset = {};
    this.children = [];
    this._text = "";
    this._attrs = {};
    this._listeners = new Map();
    this._rect = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    const classSet = new Set();
    const self = this;
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
      toggle: (c, force) => {
        if (force === undefined) {
          if (classSet.has(c)) { classSet.delete(c); return false; }
          classSet.add(c); return true;
        }
        if (force) classSet.add(c); else classSet.delete(c);
        return force;
      },
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

  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(name, value) {
    this._attrs[name] = String(value);
    if (name === "id") registry.set(this._attrs.id, this);
  }
  getAttribute(name) { return this._attrs[name] ?? null; }
  removeAttribute(name) { delete this._attrs[name]; }
  get title() { return this._attrs.title ?? ""; }
  set title(value) { this._attrs.title = String(value); }
  get id() { return this._attrs.id ?? ""; }
  set id(value) { this._attrs.id = String(value); registry.set(this._attrs.id, this); }
  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }

  // 模型菜单挂在 composer（position: relative）下，offsetParent 即 #composer。
  get offsetParent() { return registry.get("composer") ?? null; }

  getBoundingClientRect() {
    // 普通元素（composer 等锚点）返回预置 rect；
    // 仅 .model-popover 按 CSS 规则（width: min(420px, 100vw-32px)）+ style.left 动态推导。
    if (!this.classList.contains("model-popover")) return { ...this._rect };
    const parent = this.offsetParent;
    const parentLeft = parent ? parent._rect.left : 0;
    const rawLeft = this.style.left;
    const cssLeft = (rawLeft !== undefined && rawLeft !== "")
      ? Number.parseFloat(rawLeft)
      : POPOVER_CSS_LEFT;
    const width = Math.min(POPOVER_CSS_WIDTH, viewport.width - 32);
    const height = this._rect.height || 200;
    const left = parentLeft + cssLeft;
    return { left, top: 0, width, height, right: left + width, bottom: height };
  }

  _matches(selector) {
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    const presenceSel = selector.match(/^\[data-([\w-]+)\]$/);
    if (presenceSel) {
      const key = presenceSel[1].replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
      return this.dataset[key] !== undefined;
    }
    const dataSel = selector.match(/^\[data-([\w-]+)="?([^"\]]*)"?\]$/);
    if (dataSel) {
      const key = dataSel[1].replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
      return String(this.dataset[key] ?? "") === dataSel[2];
    }
    return String(this.tagName).toLowerCase() === selector.toLowerCase();
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (!(child instanceof MockEl)) continue;
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
        if (!(child instanceof MockEl)) continue;
        if (child._matches(selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
}

const realDoc = globalThis.document;
const realWin = globalThis.window;

// 每个用例前重置夹具：全局 mock 与 registry 都重新安装，避免弹层状态跨用例残留。
beforeEach(() => {
  registry.clear();
  docListeners.clear();
  winListeners.clear();
  viewport = { width: 1440, height: 900 };
  globalThis.document = {
    createElement: (tag) => new MockEl(tag),
    getElementById: (id) => registry.get(id) ?? null,
    addEventListener: (type, handler) => {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(handler);
    },
    removeEventListener: (type, handler) => {
      const list = docListeners.get(type) ?? [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
  };
  globalThis.window = {
    get innerWidth() { return viewport.width; },
    get innerHeight() { return viewport.height; },
    addEventListener: (type, handler) => {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(handler);
    },
    removeEventListener: (type, handler) => {
      const list = winListeners.get(type) ?? [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
  };
});

after(() => {
  if (realDoc === undefined) delete globalThis.document;
  else globalThis.document = realDoc;
  if (realWin === undefined) delete globalThis.window;
  else globalThis.window = realWin;
});

function makeComposer() {
  return createComposer({
    refs: {},
    getCurrentProjectRoot: () => "D:\\novels\\demo",
    getDashboard: () => ({}),
    loadDashboard: async () => {},
    openDrawer: () => {},
    openSettingsModal: () => {},
    openCreateModal: () => {},
    showToast: () => {},
    showActionError: () => {},
    threadRenderer: {},
    getAskEntries: () => new Map(),
    ensureRefreshLoop: () => {}
  });
}

test("/model with a model id is parsed as a model switch command", () => {
  const composer = makeComposer();
  assert.deepEqual(
    composer.parseUserCommand("/model mimo-v2.5-pro", "main"),
    {
      type: "model",
      content: "mimo-v2.5-pro",
      raw: "/model mimo-v2.5-pro",
      shouldAffectMainTask: false
    }
  );
});

test("/model without an id is parsed as a model picker command", () => {
  const composer = makeComposer();
  assert.deepEqual(
    composer.parseUserCommand("/model", "main"),
    {
      type: "model",
      content: "",
      raw: "/model",
      shouldAffectMainTask: false
    }
  );
});

// ---------------------------------------------------------------------------
// Task 11：模型菜单视口钳制 + 长名称 title
// ---------------------------------------------------------------------------

function makeModelComposer(models) {
  return createComposer({
    refs: {},
    getCurrentProjectRoot: () => "D:\\novels\\demo",
    getDashboard: () => ({ available_models: models }),
    loadDashboard: async () => {},
    openDrawer: () => {},
    openSettingsModal: () => {},
    openCreateModal: () => {},
    showToast: () => {},
    showActionError: () => {},
    threadRenderer: {},
    getAskEntries: () => new Map(),
    ensureRefreshLoop: () => {}
  });
}

// 预建静态 DOM：composer（菜单的 offsetParent）+ 模型药丸，注册进 registry。
function installComposerAnchor(composerLeft) {
  const composerEl = new MockEl("div");
  composerEl.id = "composer";
  composerEl._rect = { left: composerLeft, top: 0, width: 900, height: 60, right: composerLeft + 900, bottom: 60 };
  const pill = new MockEl("button");
  pill.id = "status-pill-model";
  return { composerEl, pill };
}

test("模型菜单打开后左右边界钳制在 16px 安全区内（窄窗不溢出）", () => {
  viewport.width = 500;
  viewport.height = 720;
  installComposerAnchor(60);
  const composer = makeModelComposer([{
    id: "mimo-v2.5-pro", display: "Mimo 2.5 Pro", provider: "Moonshot", api_key_saved: true, active: false,
  }]);

  const ok = composer.openModelPopover();
  assert.equal(ok, true, "有模型时打开弹层应返回 true");
  const popover = registry.get("model-popover");
  assert.ok(popover, "应构建 #model-popover");
  assert.equal(popover.hidden, false, "弹层应可见");
  assert.ok(popover.className.includes("model-popover"), "弹层应带 model-popover 类");

  // 默认 left 12px 会让右缘超出 500 - 16 = 484 → 应钳到 64（视口左 16 起，宽 420）
  const clamped = Number.parseFloat(popover.style.left);
  assert.ok(clamped < POPOVER_CSS_LEFT, "左缘应被钳制（小于 CSS 默认 12px）");
  const rect = popover.getBoundingClientRect();
  assert.ok(rect.left >= 16, `菜单左缘 ${rect.left} 应在 16px 安全区内`);
  assert.ok(rect.right <= viewport.width - 16, `菜单右缘 ${rect.right} 不应超出 ${viewport.width - 16}`);
  // 右缘恰贴安全边界：64 + 420 === 484
  assert.equal(rect.left, 64, "左缘应为 64");
  assert.equal(rect.right, viewport.width - 16, "右缘应恰在安全边界 484");
});

test("视口 resize 时菜单打开状态重新钳制", () => {
  viewport.width = 1440;
  viewport.height = 900;
  installComposerAnchor(240);
  const composer = makeModelComposer([{
    id: "mimo-v2.5-pro", display: "Mimo 2.5 Pro", provider: "Moonshot", api_key_saved: true, active: false,
  }]);

  composer.openModelPopover();
  const popover = registry.get("model-popover");
  // 宽窗 1440：默认 left 12px 不越界 → 保持 CSS 默认
  assert.equal(popover.style.left, `${POPOVER_CSS_LEFT}px`, "宽窗不应钳制，保持 CSS 默认 left");

  // 收窄到 500：右缘 252 + 420 = 672 > 484 → 应重新钳制到 64（相对 composer: 64 - 240 = -176）
  viewport.width = 500;
  viewport.height = 720;
  for (const fn of [...(winListeners.get("resize") ?? [])]) fn();

  const rect = popover.getBoundingClientRect();
  assert.ok(rect.left >= 16 && rect.right <= viewport.width - 16, "resize 后菜单应在 16px 安全区内");
  assert.equal(Number.parseFloat(popover.style.left), 64 - 240, "resize 后 left 应相对 composer 重算为 -176px");
});

test("模型菜单长名称的主/副名称节点都带完整 title", () => {
  viewport.width = 1440;
  viewport.height = 900;
  installComposerAnchor(240);
  const longName = "Mistral Large 2407 — a very long extended display name to verify wrapping";
  const composer = makeModelComposer([{
    id: "mistral-large-2407", display: longName, provider: "Mistral AI", api_key_saved: true, active: true,
  }]);

  composer.openModelPopover();
  const popover = registry.get("model-popover");
  const item = popover.querySelector(".mode-popover-item");
  assert.ok(item, "弹层应含模型条目");
  const strong = item.querySelector("strong");
  const small = item.querySelector("small");
  assert.ok(strong && small, "条目应含主/副名称节点");
  assert.equal(strong.textContent, longName, "主名称应为完整显示名");
  assert.equal(strong.title, longName, "主名称 title 应为完整值");
  assert.equal(small.title, longName, "副名称 title 应为完整值");
});
