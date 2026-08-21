// tests/app-shell/drawer-panels.test.mjs
// Round10：抽屉面板 DOM 行为——资料表单两行、记忆 Markdown 安全渲染
// （script 转义、链接带 data-external-link）与外部链接委托（交给系统浏览器）。
import assert from "node:assert/strict";
import test from "node:test";

import { createDrawerPanels } from "../../src/app-shell/drawer-panels.js";

// ---------------------------------------------------------------------------
// 最小 DOM 桩（createElement/createElementNS/事件冒泡 + closest）
// ---------------------------------------------------------------------------

class MockElement {
  constructor(tag) {
    this.tagName = String(tag).toLowerCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this._attrs = {};
    this._listeners = new Map();
    this._classes = new Set();
    this._text = "";
    this._html = "";
    this.parentNode = null;
    this.disabled = false;
    this.hidden = false;
    this.title = "";
    this.type = "";
    this.value = "";
  }
  get className() {
    return [...this._classes].join(" ");
  }
  set className(value) {
    this._classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }
  get classList() {
    return {
      add: (...cs) => cs.forEach((c) => this._classes.add(c)),
      remove: (...cs) => cs.forEach((c) => this._classes.delete(c)),
      contains: (c) => this._classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !this._classes.has(c) : Boolean(force);
        if (on) this._classes.add(c);
        else this._classes.delete(c);
        return on;
      }
    };
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent ?? "").join("");
  }
  set textContent(value) {
    this._text = String(value ?? "");
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
      if (node && typeof node === "object") node.parentNode = this;
      this.children.push(node);
    }
  }
  appendChild(node) {
    this.append(node);
    return node;
  }
  after(...nodes) {
    const siblings = this.parentNode?.children;
    if (!siblings) return;
    const index = siblings.indexOf(this);
    for (const node of nodes) {
      if (node && typeof node === "object") node.parentNode = this.parentNode;
    }
    siblings.splice(index + 1, 0, ...nodes);
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }
  setAttribute(key, value) {
    this._attrs[key] = String(value);
  }
  getAttribute(key) {
    return this._attrs[key] ?? null;
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  closest(selector) {
    const matches = (el) => el._attrs["data-external-link"] !== undefined && selector === "[data-external-link]";
    let node = this;
    while (node) {
      if (matches(node)) return node;
      node = node.parentNode;
    }
    return null;
  }
  dispatch(type, event = {}) {
    const ev = {
      type,
      target: this,
      preventDefault() { this._prevented = true; },
      stopPropagation() { this._stopped = true; },
      ...event
    };
    let node = this;
    while (node) {
      for (const fn of node._listeners.get(type) ?? []) fn(ev);
      if (ev._stopped) break;
      node = node.parentNode;
    }
    return ev;
  }
  querySelector(selector) {
    for (const child of this.children) {
      if (this._matches(child, selector)) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = (el) => {
      for (const child of el.children) {
        if (this._matches(child, selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  _matches(el, selector) {
    if (selector.startsWith(".")) return el.classList.contains(selector.slice(1));
    const dataSel = selector.match(/^\[data-([\w-]+)(?:="?([^"\]]*)"?)?\]$/);
    if (dataSel) {
      const key = dataSel[1].replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
      const expected = dataSel[2];
      if (expected === undefined) return el.dataset[key] !== undefined;
      return String(el.dataset[key] ?? "") === expected;
    }
    return el.tagName === selector.toLowerCase();
  }
}

const realDoc = globalThis.document;
const realFetch = globalThis.fetch;

function makeDoc() {
  return {
    createElement: (tag) => new MockElement(tag),
    createElementNS: (_ns, tag) => new MockElement(tag),
    createTextNode: (text) => {
      const node = new MockElement("#text");
      node.textContent = text;
      return node;
    }
  };
}

function dashboard(overrides = {}) {
  return {
    ok: true,
    hasProject: true,
    summary: { targetChapters: 10, completedChapters: 2, modelCalls: 3, maxModelCalls: 100, costAvailable: false },
    projectRoot: "D:/novel",
    sources: { latest: [{ kind: "web", title: "来源一", untrusted: true }], count: 1 },
    ...overrides
  };
}

function makeHarness({ data, memoryContent = {}, doc = makeDoc() }) {
  globalThis.document = doc;
  const drawerBody = doc.createElement("div");
  const ctx = {
    refs: { drawerBody },
    getDrawerTab: () => "chapters",
    getDashboard: () => data,
    openReader: () => {},
    openSettingsModal: () => {},
    showToast: () => {},
    showActionError: () => {},
    loadDashboard: async () => {},
    closeDrawer: () => {}
  };
  const panels = createDrawerPanels(ctx);
  const fetchCalls = [];
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    const file = String(url).match(/file=([a-z_]+)/u)?.[1] ?? "";
    return {
      ok: true,
      text: async () => JSON.stringify({ ok: true, content: memoryContent[file] ?? "" })
    };
  };
  return { panels, ctx, drawerBody, doc, fetchCalls };
}

test("round10 drawer research：资料表单两行（每行 输入 + 按钮），untrusted 来源 amber badge", async () => {
  const h = makeHarness({ data: dashboard() });
  try {
    h.ctx.getDrawerTab = () => "research";
    await h.panels.renderDrawerBody();
    const form = h.drawerBody.querySelector(".research-form");
    const rows = form.querySelectorAll(".research-row");
    assert.equal(rows.length, 2, "两行资料表单");
    for (const row of rows) {
      assert.equal(row.querySelectorAll("input").length, 1, "每行一个输入");
      assert.equal(row.querySelectorAll("button").length, 1, "每行一个按钮");
    }
    const untrusted = h.drawerBody.querySelector(".source-untrusted");
    assert.ok(untrusted, "untrusted 来源 amber badge");
    assert.equal(untrusted.textContent, "不可信");
  } finally {
    globalThis.document = realDoc;
    globalThis.fetch = realFetch;
  }
});

test("round10 drawer memory：安全 Markdown 渲染——script 转义、链接 data-external-link、三张卡", async () => {
  const h = makeHarness({
    data: dashboard(),
    memoryContent: {
      book_summary: "# 摘要\n<script>alert(1)</script>\n[链接](https://example.com/x)",
      worklog: "普通工作日志",
      continuity: "设定档案"
    }
  });
  try {
    h.ctx.getDrawerTab = () => "memory";
    await h.panels.renderDrawerBody();
    const cards = h.drawerBody.querySelectorAll(".memory-card");
    assert.equal(cards.length, 3, "故事摘要 + 工作日志 + 设定档案三张卡");
    const first = cards[0].querySelector(".memory-card-content");
    assert.ok(first.className.includes("agent-markdown"), "正文使用 .agent-markdown 子集");
    assert.ok(!first.innerHTML.includes("<script"), "script 不进入 innerHTML（被转义）");
    assert.ok(first.innerHTML.includes("&lt;script&gt;"), "script 显示为转义文本");
    assert.ok(first.innerHTML.includes('data-external-link'), "链接带外部委托标记");
    assert.ok(first.innerHTML.includes("https://example.com/x"), "http 链接保留");
    assert.ok(h.fetchCalls.some((u) => u.includes("file=continuity")), "continuity 同样走内容接口");
  } finally {
    globalThis.document = realDoc;
    globalThis.fetch = realFetch;
  }
});

test("round10 drawer memory：外部链接点击交给 openExternalUrl，不默认导航", async () => {
  const h = makeHarness({
    data: dashboard(),
    memoryContent: { book_summary: "正文", worklog: "日志", continuity: "设定" }
  });
  const opened = [];
  const prevDesktop = globalThis.wwritingDesktop;
  globalThis.wwritingDesktop = {
    openExternalUrl: async (url) => {
      opened.push(url);
    }
  };
  try {
    h.ctx.getDrawerTab = () => "memory";
    await h.panels.renderDrawerBody();
    // 真实 DOM 中链接由 innerHTML 解析；桩里手工创建等价锚点并派发冒泡点击。
    const anchor = h.doc.createElement("a");
    anchor.setAttribute("href", "https://example.com/x");
    anchor.setAttribute("data-external-link", "");
    h.drawerBody.append(anchor);
    const ev = anchor.dispatch("click", {});
    assert.equal(ev._prevented, true, "默认导航被阻止");
    assert.deepEqual(opened, ["https://example.com/x"], "链接交给系统浏览器");
  } finally {
    globalThis.document = realDoc;
    globalThis.fetch = realFetch;
    if (prevDesktop === undefined) delete globalThis.wwritingDesktop;
    else globalThis.wwritingDesktop = prevDesktop;
  }
});

test("章节历史按钮连续点击只创建一个面板并复用同一次加载", async () => {
  const h = makeHarness({
    data: dashboard({
      chapters: [{ chapter_no: 1, status: "completed", actual_words: 120 }],
      cost: null
    })
  });
  let requests = 0;
  let resolveResponse;
  const previousWindow = globalThis.window;
  globalThis.window = globalThis;
  globalThis.fetch = async () => {
    requests += 1;
    return new Promise((resolve) => { resolveResponse = resolve; });
  };
  try {
    await h.panels.renderDrawerBody();
    const row = h.drawerBody.querySelector(".chrow");
    const history = h.drawerBody.querySelector(".chrow-history");
    assert.equal(row.tagName, "div", "章节行不得嵌套交互按钮");
    assert.equal(row.getAttribute("role"), "button");
    history.dispatch("click");
    history.dispatch("click");
    assert.equal(h.drawerBody.querySelectorAll(".version-panel").length, 1);
    assert.equal(requests, 1);
    resolveResponse({ ok: true, text: async () => JSON.stringify({ versions: [] }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    globalThis.document = realDoc;
    globalThis.fetch = realFetch;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("round10 drawer memory：占位 H1 不重复显示，空正文使用明确空态", async () => {
  const h = makeHarness({
    data: dashboard(),
    memoryContent: {
      book_summary: "# 全书摘要\n\n",
      worklog: "# WORKLOG\n",
      continuity: "# 设定档案\n\n"
    }
  });
  try {
    h.ctx.getDrawerTab = () => "memory";
    await h.panels.renderDrawerBody();
    const contents = h.drawerBody.querySelectorAll(".memory-card-content");

    assert.deepEqual(
      contents.map((el) => el.textContent),
      ["暂无故事摘要", "暂无工作日志", "暂无设定档案"]
    );
    assert.ok(contents.every((el) => el.className.includes("memory-card-content--empty")));
    assert.ok(contents.every((el) => !el.innerHTML.includes("<h1")));
  } finally {
    globalThis.document = realDoc;
    globalThis.fetch = realFetch;
  }
});

test("round10 drawer memory：去掉重复 H1 后继续安全渲染正文", async () => {
  const h = makeHarness({
    data: dashboard(),
    memoryContent: {
      book_summary: "# 全书摘要\n\n雨夜来信已经完成。",
      worklog: "# WORKLOG\n\n- 已完成：第一章",
      continuity: "# 设定档案\n\n林深害怕钟声。"
    }
  });
  try {
    h.ctx.getDrawerTab = () => "memory";
    await h.panels.renderDrawerBody();
    const contents = h.drawerBody.querySelectorAll(".memory-card-content");

    assert.ok(contents[0].innerHTML.includes("雨夜来信已经完成"));
    assert.ok(contents[1].innerHTML.includes("已完成：第一章"));
    assert.ok(contents[2].innerHTML.includes("林深害怕钟声"));
    assert.ok(contents.every((el) => !el.innerHTML.includes("<h1")));
  } finally {
    globalThis.document = realDoc;
    globalThis.fetch = realFetch;
  }
});

test("第十一轮 M1：模型面板渲染 resolution_note（模型被静默替换时有可见提示）", async () => {
  const profile = { model_name: "deepseek-chat", display: "DeepSeek · deepseek-chat", endpoint: "https://api.example.com/v1", api_key_saved: true };
  const h = makeHarness({
    data: dashboard({
      model_profile: profile,
      config: { effective: { tool_permissions: {}, resolution_note: "原模型已不存在，已换成默认模型 deepseek-chat" } }
    })
  });
  try {
    h.ctx.getDrawerTab = () => "model";
    await h.panels.renderDrawerBody();
    assert.ok(h.drawerBody.textContent.includes("模型提示：原模型已不存在"), "降级说明必须可见");
    assert.ok(h.drawerBody.textContent.includes("deepseek-chat"), "说明包含兜底模型名");
  } finally {
    globalThis.document = realDoc;
    globalThis.fetch = realFetch;
  }
  const h2 = makeHarness({
    data: dashboard({ model_profile: profile, config: { effective: { tool_permissions: {} } } })
  });
  try {
    h2.ctx.getDrawerTab = () => "model";
    await h2.panels.renderDrawerBody();
    assert.ok(!h2.drawerBody.textContent.includes("模型提示"), "无 note 时不渲染提示行");
  } finally {
    globalThis.document = realDoc;
    globalThis.fetch = realFetch;
  }
});

test("第十三轮 F6：抽屉模型面板显示「上下文 · 最大输出」参数行（同源缺省口径）", async () => {
  const profile = {
    model_name: "deepseek-chat", display: "DeepSeek 官方 / deepseek-chat",
    endpoint: "https://api.example.com/v1", api_key_saved: true,
    context_window: 256_000, max_output_tokens: 64_000
  };
  const h = makeHarness({ data: dashboard({ model_profile: profile, config: { effective: { tool_permissions: {} } } }) });
  try {
    h.ctx.getDrawerTab = () => "model";
    await h.panels.renderDrawerBody();
    assert.ok(h.drawerBody.textContent.includes("上下文 256k · 最大输出 64k"), "参数行与运行时缺省口径同源");
    const hMissing = makeHarness({
      data: dashboard({ model_profile: { model_name: "plain", display: "Plain / plain", api_key_saved: false }, config: { effective: { tool_permissions: {} } } })
    });
    hMissing.ctx.getDrawerTab = () => "model";
    await hMissing.panels.renderDrawerBody();
    assert.ok(!hMissing.drawerBody.textContent.includes("上下文"), "缺窗口字段的档案不渲染参数行");
  } finally {
    globalThis.document = realDoc;
    globalThis.fetch = realFetch;
  }
});
