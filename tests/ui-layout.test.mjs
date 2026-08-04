// Task 8: UI 优化 - 按钮布局 + 底部栏分区 + 文案（spec §2.3-U4/U5）。
//
// U4 按钮布局：
//   - 「复制」「重新发送」灰显时带 title tooltip（禁用原因）+ aria-disabled="true"；
//   - 「写大纲」类动作已内联在对话流末尾（建议动作卡 deriveSuggestions 的「帮我完善大纲」），
//     无孤立悬浮按钮（Task 8 调查结论：全库无悬浮按钮，内联建议卡即终态）。
// U5 底部输入区：
//   - 底部栏左（模型选择器）/ 中（输入区）/ 右（发送）三区；
//   - placeholder 精简为一句核心提示（<40 字符），示例移到折叠提示；
//   - 「全程自动」（yolo）仅在设置弹窗「权限与确认」分区可选，composer 弹层不再提供。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, "..", "src", "app-shell");

const indexSource = await fs.readFile(path.join(srcDir, "index.html"), "utf8");
const appSource = await fs.readFile(path.join(srcDir, "app.js"), "utf8");
const cssSource = await fs.readFile(path.join(srcDir, "styles.css"), "utf8");
const composerSource = await fs.readFile(path.join(srcDir, "composer.js"), "utf8");
const settingsSource = await fs.readFile(path.join(srcDir, "settings-modal.js"), "utf8");
const threadRendererSource = await fs.readFile(path.join(srcDir, "thread-renderer.js"), "utf8");
const chatDeriveSource = await fs.readFile(path.join(srcDir, "chat-derive.mjs"), "utf8");

const CONCISE_PLACEHOLDER = "输入指令，或 /write 开始写作";

// composer 弹层行为测试用：id 注册表（document.getElementById 的 mock 后端）
// + document 级事件处理器（openModePopover 会挂 keydown/pointerdown）。
let domRegistry = new Map();
const docListeners = new Map();

// ---------------------------------------------------------------------------
// 最小 DOM mock（复用 thread-renderer.test.mjs 的模式，无 JSDOM）
// ---------------------------------------------------------------------------

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
  insertBefore(node, ref) {
    const index = this.children.indexOf(ref);
    if (index >= 0) this.children.splice(index, 0, node);
    else this.children.push(node);
  }
  setAttribute(name, value) {
    this._attrs[name] = String(value);
    // 与真实 DOM 一致：id 设置后即可通过 document.getElementById 找到。
    if (name === "id") domRegistry.set(this._attrs.id, this);
  }
  getAttribute(name) { return this._attrs[name] ?? null; }
  removeAttribute(name) { delete this._attrs[name]; }
  // 真实 DOM 中 title / id 是属性的反射属性。
  get title() { return this._attrs.title ?? ""; }
  set title(value) { this._attrs.title = String(value); }
  get id() { return this._attrs.id ?? ""; }
  set id(value) { this._attrs.id = String(value); domRegistry.set(this._attrs.id, this); }
  focus() {}
  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }
  _fire(type, ...args) {
    for (const fn of this._listeners.get(type) ?? []) fn(...args);
  }

  _matches(selector) {
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    // 属性存在选择器 [data-key]（无值）
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
const realRaf = globalThis.requestAnimationFrame;
const realSelf = globalThis.self;

before(async () => {
  globalThis.self = globalThis;
  globalThis.document = {
    createElement: (tag) => new MockElement(tag),
    createElementNS: (_ns, tag) => new MockElement(tag),
    createDocumentFragment: () => new MockElement("fragment"),
    getElementById: (id) => domRegistry.get(id) ?? null,
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
  globalThis.requestAnimationFrame = (cb) => { cb(); return 1; };
});

after(() => {
  if (realDoc === undefined) delete globalThis.document;
  else globalThis.document = realDoc;
  if (realRaf === undefined) delete globalThis.requestAnimationFrame;
  else globalThis.requestAnimationFrame = realRaf;
  if (realSelf === undefined) delete globalThis.self;
  else globalThis.self = realSelf;
});

function makeHarness() {
  const refs = { thread: new MockElement("div"), threadWrap: new MockElement("div") };
  const renderedKeys = new Set();
  const askEntries = new Map();
  const toasts = [];
  const submitted = [];
  const ctx = {
    refs,
    renderedKeys,
    askEntries,
    getLiveBlock: () => null,
    setLiveBlock: () => {},
    getCurrentProjectRoot: () => "D:\\novel-a",
    getDashboard: () => ({ project: {}, summary: {}, chapters: [] }),
    announce: () => {},
    handleQuick: () => {},
    openReader: () => {},
    handleStop: () => {},
    handleRetry: () => {},
    showToast: (msg) => toasts.push(String(msg)),
    showActionError: () => {},
    isChatBusy: () => false,
    submitText: (text) => submitted.push(String(text)),
  };
  return { refs, ctx, toasts, submitted };
}

// ---------------------------------------------------------------------------
// U4：灰显按钮带 title tooltip + aria-disabled
// ---------------------------------------------------------------------------

function userBubble(renderer, content) {
  return renderer.renderChatMessage({ role: "user", content, ts: "2026-08-04T10:00:00.000Z" });
}

test("U4 灰显复制按钮：无可复制内容时带 title tooltip + aria-disabled", async () => {
  const { createThreadRenderer } = await import("../src/app-shell/thread-renderer.js");
  const { ctx } = makeHarness();
  const renderer = createThreadRenderer(ctx);
  const bubble = userBubble(renderer, "");
  assert.ok(bubble, "空内容用户消息应仍渲染气泡（便于展示禁用态）");
  const copy = bubble.querySelector('[data-testid="msg-copy"]');
  assert.ok(copy, "气泡应含复制按钮");
  assert.equal(copy.title, "无可复制内容", "灰显复制按钮 title 应说明禁用原因");
  assert.equal(copy.getAttribute("aria-disabled"), "true", "灰显复制按钮应带 aria-disabled");
});

test("U4 灰显重新发送按钮：无可重发内容时带 title tooltip + aria-disabled", async () => {
  const { createThreadRenderer } = await import("../src/app-shell/thread-renderer.js");
  const { ctx } = makeHarness();
  const renderer = createThreadRenderer(ctx);
  const bubble = userBubble(renderer, "");
  const resend = bubble.querySelector('[data-testid="msg-resend"]');
  assert.ok(resend, "用户气泡应含重新发送按钮");
  assert.equal(resend.title, "无可重发内容", "灰显重发按钮 title 应说明禁用原因");
  assert.equal(resend.getAttribute("aria-disabled"), "true", "灰显重发按钮应带 aria-disabled");
});

test("U4 灰显按钮点击不触发动作（复制不写剪贴板、重发不提交）", async () => {
  const { createThreadRenderer } = await import("../src/app-shell/thread-renderer.js");
  const { ctx, toasts, submitted } = makeHarness();
  const renderer = createThreadRenderer(ctx);
  const bubble = userBubble(renderer, "");
  const copy = bubble.querySelector('[data-testid="msg-copy"]');
  copy._fire("click");
  assert.equal(toasts.length, 0, "灰显复制按钮点击不得弹 toast");
  const resend = bubble.querySelector('[data-testid="msg-resend"]');
  resend._fire("click");
  assert.equal(submitted.length, 0, "灰显重发按钮点击不得提交内容");
});

test("U4 有内容的按钮不灰显：无 aria-disabled 且无禁用 title", async () => {
  const { createThreadRenderer } = await import("../src/app-shell/thread-renderer.js");
  const { ctx } = makeHarness();
  const renderer = createThreadRenderer(ctx);
  const bubble = userBubble(renderer, "继续写第 5 章");
  const copy = bubble.querySelector('[data-testid="msg-copy"]');
  assert.equal(copy.getAttribute("aria-disabled"), null, "有内容时复制按钮不得灰显");
  assert.equal(copy.title, "", "有内容时复制按钮不得带禁用原因");
  const resend = bubble.querySelector('[data-testid="msg-resend"]');
  assert.equal(resend.getAttribute("aria-disabled"), null, "有内容时重发按钮不得灰显");
});

// ---------------------------------------------------------------------------
// U4：写大纲类动作内联在对话流末尾（建议动作卡；全库无孤立悬浮按钮）
// ---------------------------------------------------------------------------

test("U4 大纲动作内联在对话流末尾：appendSuggestionCards 追加含「大纲」的建议卡", async () => {
  const { createThreadRenderer } = await import("../src/app-shell/thread-renderer.js");
  const { refs, ctx } = makeHarness();
  const renderer = createThreadRenderer(ctx);
  renderer.appendSuggestionCards({ project: {}, summary: {}, chapters: [] });
  const cards = refs.thread.querySelectorAll(".suggestion-card");
  assert.ok(cards.length >= 3, "空对话态应渲染建议动作卡");
  const last = cards[cards.length - 1];
  assert.ok(last.textContent.includes("大纲"), "对话流末尾建议卡应含大纲动作（帮我完善大纲）");
  assert.ok(chatDeriveSource.includes("大纲"), "大纲建议应来自 deriveSuggestions");
});

// ---------------------------------------------------------------------------
// U5：placeholder 精简
// ---------------------------------------------------------------------------

test("U5 placeholder 精简为一句（<40 字符），示例移到折叠提示", () => {
  assert.ok(CONCISE_PLACEHOLDER.length < 40, "placeholder 应少于 40 字符");
  const m = indexSource.match(/<textarea id="composer-input"[\s\S]*?placeholder="([^"]*)"/);
  assert.ok(m, "index.html 应含 #composer-input textarea");
  assert.equal(m[1], CONCISE_PLACEHOLDER, "index.html 默认 placeholder 应为精简文案");
  assert.ok(appSource.includes(CONCISE_PLACEHOLDER), "app.js 应使用同一精简 placeholder");
  assert.ok(!indexSource.includes("跟我说：开始写作"), "旧长 placeholder 不得残留在 index.html");
  assert.ok(!appSource.includes("跟我说：开始写作"), "旧长 placeholder 不得残留在 app.js");
  // 示例移到折叠提示（composer-hint 为可折叠 details，含示例文案）
  assert.match(indexSource, /<details class="composer-hint"[\s\S]*?<summary[\s\S]*?Enter 发送/, "composer-hint 应为可折叠提示");
  assert.match(indexSource, /composer-hint[\s\S]*?(开始写作|写下一章|调整方向)/, "折叠提示应承载示例文案");
});

// ---------------------------------------------------------------------------
// U5：底部栏左（模型选择器）/ 中（输入区）/ 右（发送）三区
// ---------------------------------------------------------------------------

test("U5 底部栏三区：模型选择器在左、输入区居中、发送在右", () => {
  // composer-bar 内三区按左 → 中 → 右顺序出现
  const leftIdx = indexSource.indexOf('class="composer-left"');
  const centerIdx = indexSource.indexOf('class="composer-center"');
  const rightIdx = indexSource.indexOf('class="composer-right"');
  assert.ok(leftIdx >= 0 && centerIdx >= 0 && rightIdx >= 0, "composer-bar 应含左中右三区");
  assert.ok(leftIdx < centerIdx && centerIdx < rightIdx, "三区顺序应为 左 → 中 → 右");
  // 模型选择器（mode-pill 及其后的 status-pills 挂点）在 composer-left
  assert.match(indexSource, /class="composer-left"[\s\S]*?id="mode-pill"/, "composer-left 应含模型/权限选择器");
  // 输入区在 composer-center
  assert.match(indexSource, /class="composer-center"[\s\S]*?<textarea id="composer-input"/, "composer-center 应含输入区");
  // 发送按钮在 composer-right
  assert.match(indexSource, /class="composer-right"[\s\S]*?id="composer-submit"/, "composer-right 应含发送按钮");
  // 三区都在 composer-bar 内
  assert.match(indexSource, /class="composer-bar"[\s\S]*?class="composer-left"/, "三区应位于 composer-bar 内");
});

test("U5 styles.css 提供三区布局与灰显按钮样式", () => {
  assert.match(cssSource, /\.composer-left\s*\{/, "styles.css 应定义 .composer-left");
  assert.match(cssSource, /\.composer-center\s*\{/, "styles.css 应定义 .composer-center");
  assert.match(cssSource, /\.composer-right\s*\{/, "styles.css 应定义 .composer-right");
  assert.match(cssSource, /\.msg-action\[aria-disabled="true"\]/, "styles.css 应定义灰显按钮样式");
});

// ---------------------------------------------------------------------------
// U5：全程自动（yolo）仅在设置弹窗可选
// ---------------------------------------------------------------------------

test("U5 全程自动移到设置弹窗：composer 弹层不再渲染 yolo 档", () => {
  assert.match(composerSource, /filter\(\s*\(?\s*[a-z]\s*\)?\s*=>\s*[a-z]\.id\s*!==\s*["']yolo["']/, "composer 弹层应按 id 过滤掉 yolo");
  assert.ok(!composerSource.includes("mode-popover-item--yolo"), "composer 弹层不得再渲染 yolo 条目样式");
  assert.ok(!composerSource.includes("mode-popover-warn"), "yolo 警告提示应从 composer 弹层移除");
});

test("U5 设置弹窗保留全程自动（权限与确认分区）", () => {
  assert.match(settingsSource, /tier\.id === "yolo"/, "设置弹窗权限分区应保留 yolo 处理");
  assert.match(settingsSource, /spd-radio-option--yolo/, "设置弹窗 yolo 选项样式应保留");
  assert.match(settingsSource, /全程自动模式会自动执行/, "设置弹窗应保留全程自动警告文案");
});

// ---------------------------------------------------------------------------
// U5 行为测试：mode pill 显示 / 键盘选档（composer.js onModePopoverKeydown）
// 覆盖评审 Important #2：Enter/ArrowUp/ArrowDown 选档索引映射（POPOVER_TIERS）、
// yolo 档打开弹层的回退行为、mode pill 在 yolo 档的显示。
// ---------------------------------------------------------------------------

function installComposerDom() {
  domRegistry = new Map();
  docListeners.clear();
  const posted = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    posted.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
    return { ok: true, text: async () => JSON.stringify({ ok: true }) };
  };
  const realStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  return {
    posted,
    fireKeydown: (event) => {
      for (const fn of [...(docListeners.get("keydown") ?? [])]) fn(event);
    },
    restore: () => {
      globalThis.fetch = realFetch;
      if (realStorage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = realStorage;
    },
  };
}

function makeComposerForPopover(createComposer, toolPermissions) {
  // mode-pill 在真实 index.html 里静态存在；这里预建并注册进 domRegistry。
  const pill = new MockElement("button");
  pill.setAttribute("id", "mode-pill");
  const refs = {
    thread: new MockElement("div"),
    threadWrap: new MockElement("div"),
    composer: new MockElement("div"),
  };
  const ctx = {
    refs,
    getCurrentProjectRoot: () => "D:\\novel-a",
    getDashboard: () => ({ project: { tool_permissions: toolPermissions }, summary: {}, chapters: [] }),
    loadDashboard: async () => {},
    openDrawer: () => {},
    openSettingsModal: () => {},
    openCreateModal: () => {},
    showToast: () => {},
    showActionError: () => {},
    threadRenderer: { scrollThreadToBottom: () => {} },
    getAskEntries: () => new Map(),
    ensureRefreshLoop: () => {},
  };
  const composer = createComposer(ctx);
  composer.initModePill();
  composer.updateModePill();
  return composer;
}

function popoverItems() {
  return [...(domRegistry.get("mode-popover")?.querySelectorAll("[data-tier-id]") ?? [])];
}

test("U5 mode pill 在 yolo 档显示「全程自动」+ cbar-pill--yolo（yolo 仅设置里可选，pill 仍如实显示）", async () => {
  const { createComposer } = await import("../src/app-shell/composer.js");
  const env = installComposerDom();
  try {
    makeComposerForPopover(createComposer, { yolo: true, auto_edit: true, safe_edit: true, read_only: false });
    const pill = domRegistry.get("mode-pill");
    assert.ok(pill, "mode-pill 应存在");
    assert.equal(pill.textContent, "全程自动", "yolo 档 pill 文案");
    assert.ok(pill.className.includes("cbar-pill--yolo"), "yolo 档 pill 应带 cbar-pill--yolo 样式");
    assert.equal(pill.getAttribute("data-tier"), "yolo", "pill 应带 data-tier=yolo");
  } finally {
    env.restore();
  }
});

test("U5 yolo 档打开弹层：回退高亮相邻 auto 档，Enter 提交 auto 而非 yolo（索引不越界）", async () => {
  const { createComposer } = await import("../src/app-shell/composer.js");
  const env = installComposerDom();
  try {
    const composer = makeComposerForPopover(createComposer, { yolo: true, auto_edit: true, safe_edit: true, read_only: false });
    composer.openModePopover();
    const items = popoverItems();
    assert.equal(items.length, 3, "弹层只含 3 档（无 yolo）");
    assert.ok(items.every((el) => el.getAttribute("aria-checked") === "false"), "yolo 档打开时无任何档被勾选");
    const activeIdx = items.findIndex((el) => el.classList.contains("active"));
    assert.equal(activeIdx, 2, "回退高亮应落在相邻的 auto 档（索引 2）");
    assert.equal(items[activeIdx].dataset.tierId, "auto", "回退档应为 auto");

    env.fireKeydown({ key: "Enter", preventDefault() {}, stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(env.posted.length, 1, "Enter 应触发一次 applyTier");
    assert.equal(env.posted[0].url, "/api/settings/update", "applyTier 应 POST settings/update");
    assert.deepEqual(env.posted[0].body.tool_permissions, {
      read_only: false, safe_edit: true, auto_edit: true, yolo: false,
    }, "Enter 提交的应为 auto 档 combo，而非 yolo");
  } finally {
    env.restore();
  }
});

test("U5 键盘选档（非 yolo）：ArrowDown/ArrowUp/Enter 按 POPOVER_TIERS 映射提交", async () => {
  const { createComposer } = await import("../src/app-shell/composer.js");
  const env = installComposerDom();
  try {
    const composer = makeComposerForPopover(createComposer, { yolo: false, auto_edit: false, safe_edit: true, read_only: false });
    composer.openModePopover();
    let items = popoverItems();
    assert.equal(items[1].getAttribute("aria-checked"), "true", "confirm 档应被勾选");
    assert.ok(items[1].classList.contains("active"), "confirm 档应高亮（索引 1）");

    // ArrowDown → auto（索引 2），Enter 提交 auto
    env.fireKeydown({ key: "ArrowDown", preventDefault() {}, stopPropagation() {} });
    assert.ok(items[2].classList.contains("active"), "ArrowDown 应高亮 auto（索引 2）");
    env.fireKeydown({ key: "Enter", preventDefault() {}, stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(env.posted.at(-1).body.tool_permissions.auto_edit, true, "Enter 应提交 auto 档");

    // 重开弹层：ArrowUp 从 confirm（索引 1）→ read_only（索引 0），Enter 提交 read_only
    composer.openModePopover();
    items = popoverItems();
    env.fireKeydown({ key: "ArrowUp", preventDefault() {}, stopPropagation() {} });
    assert.ok(items[0].classList.contains("active"), "ArrowUp 应高亮 read_only（索引 0）");
    env.fireKeydown({ key: "Enter", preventDefault() {}, stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(env.posted.at(-1).body.tool_permissions.read_only, true, "Enter 应提交 read_only 档");

    // 边界：read_only 上再 ArrowUp 环绕回 auto（索引 2），Enter 提交 auto；全程不得出现 yolo
    composer.openModePopover();
    items = popoverItems();
    env.fireKeydown({ key: "ArrowUp", preventDefault() {}, stopPropagation() {} });
    env.fireKeydown({ key: "ArrowUp", preventDefault() {}, stopPropagation() {} });
    assert.ok(items[2].classList.contains("active"), "越界 ArrowUp 应环绕回 auto（索引 2）");
    env.fireKeydown({ key: "Enter", preventDefault() {}, stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 10));

    assert.ok(env.posted.every((p) => p.body?.tool_permissions?.yolo !== true), "任何提交都不得是 yolo 档");
    assert.equal(env.posted.length, 3, "三次 Enter 共提交三档");
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// 回归：既有契约不受影响（verify:app-shell 依赖的稳定标记）
// ---------------------------------------------------------------------------

test("回归：既有 UI 稳定标记保留（composer/textarea/send/hint）", () => {
  assert.ok(indexSource.includes('id="composer"'), "composer 容器 id 保留");
  assert.ok(indexSource.includes('<textarea id="composer-input"'), "composer-input textarea 保留");
  assert.ok(indexSource.includes("composer-submit"), "发送按钮保留");
  assert.ok(indexSource.includes("Enter 发送"), "快捷键提示保留");
  assert.ok(indexSource.includes("slash-menu"), "斜杠命令菜单保留");
});
