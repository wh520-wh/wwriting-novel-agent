// Task 9: 任务卡标题 — 显示"任务类型 · 章节"的人类语言，不再暴露单调递增内部编号。
//
// 真实 task 元素字段（src/core/task-queue.mjs enqueue/createRecoveryTask/normalizeTask）：
//   { id, index, instruction, contract, mode, status, ... }
// 类型与章节号不在顶层，而在 task.contract 内：
//   task.contract.kind          —— "write_chapter"（常规写作）/ "resume_chapter"（恢复续写）
//   task.contract.chapter_start —— 单章任务，chapter_start === chapter_end
// 断言：标题 textContent 不含 "任务 #" / "#N"，含 "写作 · 第 2 章" 等人类语言；
//       未知 kind → "后台任务"；无 contract / 无章节号 → 仅类型标签。
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

// ---------------------------------------------------------------------------
// Minimal DOM mock (no JSDOM) — 覆盖 buildTaskCard 渲染路径所需接口
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
    if (dataSel) {
      // 真实 DOM：data-task-card-id 属性 ↔ dataset.taskCardId（kebab → camel）。
      const kebab = dataSel[1];
      const camel = kebab.replace(/-([a-z])/gu, (_m, c) => c.toUpperCase());
      return String(this.dataset[kebab] ?? this.dataset[camel] ?? "") === dataSel[2];
    }
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
// Install / restore global DOM + localStorage mock（在动态 import thread-renderer 之前安装）
// ---------------------------------------------------------------------------

const realDoc = globalThis.document;
const realRaf = globalThis.requestAnimationFrame;
const realSelf = globalThis.self;
const realLocalStorage = globalThis.localStorage;
const realWindow = globalThis.window;

// gsap 模块级有 `_windowExists() && _wake()`（vendor/gsap.js:4133）：
// 若 import 时 window 已存在，ticker 会启动并经由同步 rAF mock 无限自递归。
// 因此必须先 import（window 不存在，ticker 永不启动），import 完成后再提供
// window（utils.cssEscape 运行时读 window.CSS.escape）。
let createThreadRenderer = null;
let computeSteps = null;

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
  // buildTaskCard 的折叠状态读写 localStorage。
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
  };
  // 先 import（无 window，gsap ticker 不启动），再补 window 供 cssEscape 使用。
  const mod = await import("../../src/app-shell/thread-renderer.js");
  createThreadRenderer = mod.createThreadRenderer;
  computeSteps = mod.computeSteps;
  globalThis.window = {};
});

after(() => {
  if (realDoc === undefined) delete globalThis.document;
  else globalThis.document = realDoc;
  if (realRaf === undefined) delete globalThis.requestAnimationFrame;
  else globalThis.requestAnimationFrame = realRaf;
  if (realSelf === undefined) delete globalThis.self;
  else globalThis.self = realSelf;
  if (realLocalStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = realLocalStorage;
  if (realWindow === undefined) delete globalThis.window;
  else globalThis.window = realWindow;
});

// ---------------------------------------------------------------------------
// Test fixture — 与真实 /api/dashboard 返回形状一致：queue: { tasks: [...] }
// ---------------------------------------------------------------------------

function makeHarness() {
  const refs = {
    thread: new MockElement("div"),
    threadWrap: new MockElement("div"),
  };
  const renderedKeys = new Set();
  const askEntries = new Map();
  let liveBlock = null;
  const ctx = {
    refs,
    renderedKeys,
    askEntries,
    getLiveBlock: () => liveBlock,
    setLiveBlock: (block) => { liveBlock = block; },
    getCurrentProjectRoot: () => "D:\\novel",
    getDashboard: () => ({}),
    announce: () => {},
    handleQuick: () => {},
    openReader: () => {},
    handleStop: () => {},
    handleRetry: () => {},
    showToast: () => {},
    showActionError: () => {},
    isChatBusy: () => false,
  };
  return { refs, ctx };
}

function makeDashboard(tasks) {
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
    chapters: [],
    queue: { tasks },
    events: [],
  };
}

function makeInterruptedDashboard() {
  return {
    project: { title: "测试小说" },
    projectRoot: "D:\\novel",
    summary: {
      currentStage: "drafting",
      projectStatus: "interrupted",
      currentChapterNo: 2,
      totalWords: 1234,
      costAvailable: true,
      estimatedCost: "0.02",
    },
    state: { interrupted_reason: "HTTP 400" },
    chapters: [],
    queue: { tasks: [] },
    events: [
      { type: "project_run_started", timestamp: "2026-08-01T01:00:00Z", stage: "drafting" },
      { type: "project_interrupted", timestamp: "2026-08-01T01:01:00Z", stage: "drafting", message: "HTTP 400" },
    ],
  };
}

function renderTaskCards(tasks) {
  const { refs, ctx } = makeHarness();
  createThreadRenderer(ctx).syncThread(makeDashboard(tasks), true);
  return refs.thread;
}

function titleOf(thread, taskId) {
  const card = thread.querySelector(`[data-task-card-id="${taskId}"]`);
  assert.ok(card, `任务卡应渲染（id=${taskId}）`);
  const num = card.querySelector(".task-num");
  assert.ok(num, "任务卡应包含 .task-num 标题元素");
  return num.textContent;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("buildTaskCard: 标题显示任务类型+章节（写作 · 第 2 章），不暴露内部编号", async () => {
  const task = {
    id: "task-write",
    index: 3,
    instruction: "写第2章",
    mode: "auto",
    status: "completed",
    contract: { version: 1, kind: "write_chapter", chapter_start: 2, chapter_end: 2 },
  };
  const thread = await renderTaskCards([task]);
  const title = titleOf(thread, "task-write");
  assert.equal(title, "写作 · 第 2 章");
  assert.ok(!title.includes("任务 #"), "标题不得暴露 '任务 #' 内部编号前缀");
  assert.ok(!title.includes("#3"), "标题不得包含单调递增的内部编号 #3");
});

test("buildTaskCard: resume_chapter 显示为续写类型", async () => {
  const task = {
    id: "task-resume",
    index: 5,
    instruction: "继续当前写作任务",
    mode: "write",
    status: "completed",
    contract: { version: 1, kind: "resume_chapter", chapter_start: 3, chapter_end: 3 },
  };
  const thread = await renderTaskCards([task]);
  assert.equal(titleOf(thread, "task-resume"), "续写 · 第 3 章");
});

test("buildTaskCard: 用户发起续写（续写第2章）显示「续写 · 第 2 章」而非「写作」", async () => {
  const task = {
    id: "task-continue",
    index: 6,
    instruction: "续写第2章",
    mode: "write",
    status: "queued",
    contract: { version: 1, kind: "resume_chapter", chapter_start: 2, chapter_end: 2 },
  };
  const thread = await renderTaskCards([task]);
  assert.equal(titleOf(thread, "task-continue"), "续写 · 第 2 章");
});

test("buildTaskCard: 无 contract（无类型无章节）→ 后台任务", async () => {
  const task = {
    id: "task-bare",
    index: 1,
    instruction: "旧格式任务",
    mode: "auto",
    status: "completed",
  };
  const thread = await renderTaskCards([task]);
  assert.equal(titleOf(thread, "task-bare"), "后台任务");
});

test("buildTaskCard: 未知 kind → 回退为后台任务（不显示原始内部值，保留章节信息）", async () => {
  const task = {
    id: "task-unknown",
    index: 7,
    instruction: "奇怪的任务",
    mode: "auto",
    status: "completed",
    contract: { version: 1, kind: "rewrite_all_night", chapter_start: 2, chapter_end: 2 },
  };
  const thread = await renderTaskCards([task]);
  const title = titleOf(thread, "task-unknown");
  assert.equal(title, "后台任务 · 第 2 章");
  assert.ok(!title.includes("rewrite_all_night"), "标题不得暴露原始 kind 内部值");
});

test("buildTaskCard: 有类型无章节号 → 仅显示类型标签", async () => {
  const task = {
    id: "task-no-chapter",
    index: 4,
    instruction: "无章节号的任务",
    mode: "auto",
    status: "completed",
    contract: { version: 1, kind: "write_chapter" },
  };
  const thread = await renderTaskCards([task]);
  assert.equal(titleOf(thread, "task-no-chapter"), "写作");
});

test("interrupted run renders terminal copy without writing spinner or duplicate retry", () => {
  const { refs, ctx } = makeHarness();
  createThreadRenderer(ctx).syncThread(makeInterruptedDashboard(), true);
  assert.match(refs.thread.textContent, /已中断/u);
  assert.doesNotMatch(refs.thread.textContent, /书写中/u);
  assert.equal(refs.thread.querySelector(".spin"), null);
  assert.equal(refs.thread.querySelectorAll(".task-action.retry").length, 0);
});

// ---------------------------------------------------------------------------
// Task 7: 步骤子步骤可见性 —— 写入章节 / 审稿 running 时展示小粒度进度
// （对照 Claude Code TodoWrite 三态模型的可见性思路；纯函数 computeSteps 直接断言）
// ---------------------------------------------------------------------------

test("computeSteps: 写入章节进行中时附带当前段号子步骤", () => {
  const steps = computeSteps({
    state: { current_stage: "drafting", current_segment_no: 1, active_budget: {} },
    summary: { projectStatus: "running", currentChapterNo: 1 }
  });
  const drafting = steps.find((s) => s.name.includes("写入"));
  assert.equal(drafting.status, "running");
  assert.equal(drafting.substep, "第 2 段"); // 已完成 1 段，正在写第 2 段
});

test("computeSteps: 审稿进行中且 fact-check 有轮次记录时附带子步骤（不暴露轮数）", () => {
  const steps = computeSteps({
    state: {
      current_stage: "reviewing", current_chapter_no: 1,
      active_budget: { fact_check_rounds_by_chapter: { "1": 1 }, max_fact_check_rounds_per_chapter: 3 }
    },
    summary: { projectStatus: "running", currentChapterNo: 1 }
  });
  const reviewing = steps.find((s) => s.name === "审稿");
  assert.equal(reviewing.status, "running");
  assert.equal(reviewing.substep, "正在事实核对");
});

test("computeSteps: 审稿进行中但 fact-check 无轮次记录时无子步骤", () => {
  const steps = computeSteps({
    state: { current_stage: "reviewing", current_chapter_no: 1, active_budget: {} },
    summary: { projectStatus: "running", currentChapterNo: 1 }
  });
  const reviewing = steps.find((s) => s.name === "审稿");
  assert.equal(reviewing.status, "running");
  assert.ok(!reviewing.substep, "无 fact-check 轮次记录时不应展示子步骤");
});
