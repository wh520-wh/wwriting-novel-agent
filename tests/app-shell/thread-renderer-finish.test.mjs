// Task 8: 章节完成消息去重 — finishAgentBlock 渲染契约测试。
//
// 章节完成后三处呈现各司其职（常驻完成卡 / 线程内文件卡 / 任务卡）：
// finishAgentBlock 不得重复播报 "已写入本地文件并通过校验"，
// quick row 只保留 "续写下一章"（删除与完成卡阅读入口重复的 "查看章节正文"），
// 文件卡（.filecard，foot 含 "打开阅读"）仍正常渲染。
//
// 通过 MockElement 脚手架驱动真实 createThreadRenderer().syncThread()，
// 事件序列：project_run_started → chapter_completed → project_run_finished。
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

// ---------------------------------------------------------------------------
// Minimal DOM mock (no JSDOM) — 覆盖 finishAgentBlock 渲染路径所需接口
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
    this.children.push(...nodes);
  }
  appendChild(node) {
    this.children.push(node);
    return node;
  }
  replaceChildren(...nodes) {
    this.children = [...nodes];
  }
  insertBefore(node, ref) {
    const index = this.children.indexOf(ref);
    if (index >= 0) this.children.splice(index, 0, node);
    else this.children.push(node);
  }
  remove() {
    /* 挂载关系由测试直接断言，无需维护 */
  }
  replaceWith(node) {
    this.replaceChildren(node);
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

  _matches(selector) {
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    if (selector.startsWith("#")) return (this._attrs.id ?? "") === selector.slice(1);
    const dataSel = selector.match(/^\[data-([\w-]+)="?([^"\]]*)"?\]$/);
    if (dataSel) return String(this.dataset[dataSel[1]] ?? "") === dataSel[2];
    const attrSel = selector.match(/^\[([\w-]+)="?([^"\]]*)"?\]$/);
    if (attrSel) return String(this._attrs[attrSel[1]] ?? "") === attrSel[2];
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
// Install / restore global DOM mock（在动态 import thread-renderer 之前安装）
// ---------------------------------------------------------------------------

const realDoc = globalThis.document;
const realRaf = globalThis.requestAnimationFrame;
const realSelf = globalThis.self;

before(async () => {
  // gsap 的 UMD 包裹在 ESM 严格模式下拿不到顶层 this，需要 self 兜底。
  globalThis.self = globalThis;
  globalThis.document = {
    createElement: (tag) => new MockElement(tag),
    createElementNS: (_ns, tag) => new MockElement(tag),
    createTextNode: (text) => new TextNode(text),
    createDocumentFragment: () => new MockElement("fragment"),
  };
  globalThis.requestAnimationFrame = (cb) => {
    cb();
    return 1;
  };
});

after(() => {
  if (realDoc === undefined) delete globalThis.document;
  else globalThis.document = realDoc;
  if (realRaf === undefined) delete globalThis.requestAnimationFrame;
  else globalThis.requestAnimationFrame = realRaf;
  if (realSelf === undefined) delete globalThis.self;
  else globalThis.self = realSelf;
});

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

function makeHarness() {
  const refs = {
    thread: new MockElement("div"),
    threadWrap: new MockElement("div"),
  };
  const renderedKeys = new Set();
  const askEntries = new Map();
  const announced = [];
  let liveBlock = null;
  const ctx = {
    refs,
    renderedKeys,
    askEntries,
    getLiveBlock: () => liveBlock,
    setLiveBlock: (block) => { liveBlock = block; },
    getCurrentProjectRoot: () => "D:\\novel",
    getDashboard: () => ({}),
    announce: (msg) => announced.push(String(msg)),
    handleQuick: () => {},
    openReader: () => {},
    handleStop: () => {},
    handleRetry: () => {},
    showToast: () => {},
    showActionError: () => {},
    isChatBusy: () => false,
  };
  return { refs, ctx, announced };
}

function makeDashboard() {
  return {
    project: { title: "测试小说" },
    projectRoot: "D:\\novel",
    summary: {
      currentStage: "summarizing",
      projectStatus: "completed",
      currentChapterNo: 1,
      totalWords: 1234,
      costAvailable: true,
      estimatedCost: "0.02",
    },
    chapters: [{ chapter_no: 1, title: "第 1 章", artifact: { state: "committed" } }],
    events: [
      { type: "project_run_started", timestamp: "2026-07-31T10:00:00.000Z", message: "开始写作" },
      { type: "chapter_completed", timestamp: "2026-07-31T10:05:00.000Z", chapter_no: 1 },
      { type: "project_run_finished", timestamp: "2026-07-31T10:06:00.000Z", message: "第 1 章已完成" },
    ],
  };
}

test("finishAgentBlock: 完成时不重复播报保存文案，quick row 只保留续写入口", async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx, announced } = makeHarness();
  const renderer = createThreadRenderer(ctx);
  renderer.syncThread(makeDashboard(), true);

  // 找到 agent 运行气泡：session-head 之后的 .msg-agent
  const agentRoot = refs.thread.children.find((c) => c.classList?.contains("msg-agent"));
  assert.ok(agentRoot, "project_run_started 应渲染 agent 气泡");
  const body = agentRoot.children.find((c) => c.classList?.contains("agent-body"));
  assert.ok(body, "agent 气泡应包含 agent-body");

  // 1) 序列化文本不包含重复播报的保存确认文案
  const bodyText = body.textContent;
  assert.equal(
    bodyText.includes("已写入本地文件并通过校验"),
    false,
    "finishAgentBlock 不得重复播报 '已写入本地文件并通过校验'（该信息由文件卡承载）"
  );
  assert.ok(
    announced.every((m) => !m.includes("已写入本地文件并通过校验")),
    "announce 播报也不得包含重复的保存确认文案"
  );

  // 2) 文件卡仍渲染：.filecard 存在，foot 含 "打开阅读"
  const fileCards = body.querySelectorAll(".filecard");
  assert.equal(fileCards.length, 1, "章节完成后应渲染一张文件卡");
  assert.ok(
    fileCards[0].textContent.includes("打开阅读"),
    "文件卡 foot 应保留 '打开阅读' 入口"
  );

  // 3) quick row 只保留 "续写下一章"（图标为 SVG，无文本，按现有实现断言）
  const quickRow = body.querySelector(".quick-row");
  assert.ok(quickRow, "完成后的 quick row 应渲染");
  const labels = quickRow.children.map((chip) => chip.textContent);
  assert.deepEqual(
    labels,
    ["续写下一章"],
    "quick row 应只包含续写入口，不得再有重复的查看正文入口"
  );
});
