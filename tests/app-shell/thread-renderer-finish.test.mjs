// 历史轮完成卡渲染契约测试（规格书 P3/P6，2026-08-05 还债 defer 4）。
//
// 历史轮（轮询全量重放）不再使用旧式 buildAgentBlock 带头像/署名/步骤时间线，
// 而是 buildHistoryTurn 聚合本轮事件渲染完成卡（.turn-agent > .done-card）：
// 无头像、无署名、无文件卡（.filecard）、不重复播报 "已写入本地文件并通过校验"，
// 完成卡正文由 refreshDoneFromChapterFiles 从磁盘回填（artifact 是元数据对象，
// 不得显示为 "[object Object]"）。
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
    for (const node of nodes) {
      if (node instanceof MockElement) {
        node._parent = this;
        node.isConnected = this.isConnected;
      }
    }
    this.children.push(...nodes);
  }
  appendChild(node) {
    if (node instanceof MockElement) {
      node._parent = this;
      node.isConnected = this.isConnected;
    }
    this.children.push(node);
    return node;
  }
  replaceChildren(...nodes) {
    for (const node of nodes) {
      if (node instanceof MockElement) {
        node._parent = this;
        node.isConnected = this.isConnected;
      }
    }
    this.children = [...nodes];
  }
  insertBefore(node, ref) {
    if (node instanceof MockElement) {
      node._parent = this;
      node.isConnected = this.isConnected;
    }
    const index = this.children.indexOf(ref);
    if (index >= 0) this.children.splice(index, 0, node);
    else this.children.push(node);
  }
  remove() {
    /* 挂载关系由测试直接断言，无需维护 */
  }
  replaceWith(node) {
    // 真实 DOM 语义：在父元素的 children 中替换自身，并继承父的挂载状态（历史运行卡终态重建依赖）。
    if (this._parent) {
      const index = this._parent.children.indexOf(this);
      if (index >= 0) this._parent.children.splice(index, 1, node);
      if (node instanceof MockElement) {
        node._parent = this._parent;
        node.isConnected = this.isConnected;
      }
      return;
    }
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

test("历史轮完成卡：无头像无署名、不重复播报保存文案、无文件卡（规格书 P3/P6）", async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx, announced } = makeHarness();
  const renderer = createThreadRenderer(ctx);
  renderer.syncThread(makeDashboard(), true);

  // 历史轮渲染为完成卡（turn-agent），不得再出现旧式带头像 agent 气泡
  const agentRoot = refs.thread.children.find((c) => c.classList?.contains("msg-agent"));
  assert.equal(agentRoot, undefined, "历史轮不得再渲染旧式 .msg-agent（带头像/署名）");
  const turn = refs.thread.children.find((c) => c.classList?.contains("turn-agent"));
  assert.ok(turn, "历史轮应渲染 .turn-agent 完成卡");
  const done = turn.children.find((c) => c.classList?.contains("done-card"));
  assert.ok(done, "历史轮完成态应含 .done-card");

  // 1) 序列化文本不包含重复播报的保存确认文案
  const bodyText = done.textContent;
  assert.equal(bodyText.includes("已写入本地文件并通过校验"), false,
    "历史轮完成卡不得重复播报 '已写入本地文件并通过校验'");
  assert.ok(announced.every((m) => !m.includes("已写入本地文件并通过校验")),
    "announce 播报也不得包含重复的保存确认文案");

  // 2) 完成卡不得显示 "[object Object]"（artifact 是元数据对象，正文靠磁盘回填）
  assert.ok(!bodyText.includes("[object Object]"), "完成卡不得把 artifact 元数据当正文展示");
  assert.ok(done.textContent.includes("第 1 章 · 已完成"), "完成卡标题应为 '第 1 章 · 已完成'");
});

test("历史轮中断收尾：kindMap 识别 project_interrupted，标题带章号「已中断」（回归）", async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx } = makeHarness();
  const renderer = createThreadRenderer(ctx);
  const dash = makeDashboard();
  // 无 chapter_completed 事件：中断轮走 else 分支，标题用 startEvent.chapter_no 带章号；
  // 此前 kindMap 键名错写为 project_run_interrupted，导致 kind 被 ?? "finished" 回退成「已完成」。
  dash.events = [
    { type: "project_run_started", timestamp: "2026-07-31T10:00:00.000Z", chapter_no: 2, message: "开始写作" },
    { type: "project_interrupted", timestamp: "2026-07-31T10:06:00.000Z", message: "写作被中断" },
  ];
  renderer.syncThread(dash, true);

  const turn = refs.thread.children.find((c) => c.classList?.contains("turn-agent"));
  assert.ok(turn, "历史轮应渲染 .turn-agent 完成卡");
  const done = turn.children.find((c) => c.classList?.contains("done-card"));
  assert.ok(done, "中断历史轮同样折叠为完成卡");
  assert.ok(done.textContent.includes("第 2 章 · 已中断"),
    "中断收尾不得回退为「已完成」（kindMap 须识别 project_interrupted）");
});

test("历史轮 blocked 收尾：无章事件时标题带章号「需要处理」而非「已完成」（回归）", async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx } = makeHarness();
  const renderer = createThreadRenderer(ctx);
  const dash = makeDashboard();
  // 早期故障发出 blocked 通常无 chapter_completed（nums=0 → else 分支）；
  // 此前 else 分支缺 blocked 情形，被回退成「本轮写作已完成」。
  dash.events = [
    { type: "project_run_started", timestamp: "2026-07-31T10:00:00.000Z", chapter_no: 3, message: "开始写作" },
    { type: "project_blocked", timestamp: "2026-07-31T10:02:00.000Z", message: "配置缺失，需处理" },
  ];
  renderer.syncThread(dash, true);

  const turn = refs.thread.children.find((c) => c.classList?.contains("turn-agent"));
  assert.ok(turn, "历史轮应渲染 .turn-agent 完成卡");
  const done = turn.children.find((c) => c.classList?.contains("done-card"));
  assert.ok(done, "blocked 历史轮同样折叠为完成卡");
  assert.ok(done.textContent.includes("第 3 章 · 需要处理"),
    "blocked 收尾不得回退为「已完成」，标题应带章号「需要处理」");
});

test("运行中轮次（无终态）不折叠：终态到达后重建为无头像完成卡（真实刷新路径，key 一致）", async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx, announced } = makeHarness();
  refs.thread.isConnected = true; // 模拟真实挂载：updateLiveAgentBlock/reconcileLiveTurn 保留 liveTurn
  const renderer = createThreadRenderer(ctx);
  // data1：仅 project_run_started（chapter_no: 1），summary 运行中——刷新/重载后的首轮重放。
  const started = { type: "project_run_started", timestamp: "2026-07-31T10:00:00.000Z", chapter_no: 1, message: "开始写作" };
  const dash1 = makeDashboard();
  dash1.summary = { ...dash1.summary, projectStatus: "running", currentStage: "drafting" };
  dash1.events = [started];
  renderer.syncThread(dash1, true);

  // 运行中轮次不得折叠：渲染 .msg-agent 运行卡，且无 .turn-agent。
  const agent = refs.thread.children.find((c) => c.classList?.contains("msg-agent"));
  assert.ok(agent, "运行中轮次（无终态）应渲染 .msg-agent 运行卡");
  assert.equal(refs.thread.children.find((c) => c.classList?.contains("turn-agent")), undefined,
    "无终态事件不得折叠为 .turn-agent 完成卡");

  // data2：同一事件（eventKey 完全一致 → 增量路径；轮询每次返回全新序列化对象，
  // 用 started 的新副本模拟真实场景，验证重建按 eventKey 匹配而非对象引用）+ 终态事件。
  const dash2 = makeDashboard();
  dash2.events = [
    { ...started },
    { type: "chapter_completed", timestamp: "2026-07-31T10:05:00.000Z", chapter_no: 1 },
    { type: "project_run_finished", timestamp: "2026-07-31T10:06:00.000Z", message: "第 1 章已完成" },
  ];
  renderer.syncThread(dash2, false);

  // 历史运行卡被重建替换：.msg-agent 消失，.turn-agent > .done-card 出现，无文件卡。
  assert.equal(refs.thread.children.find((c) => c.classList?.contains("msg-agent")), undefined,
    "终态到达后 .msg-agent 运行卡应被重建替换（P3/P6：不留旧式带头像静态卡）");
  const turn = refs.thread.children.find((c) => c.classList?.contains("turn-agent"));
  assert.ok(turn, "终态到达后应折叠为 .turn-agent 完成卡");
  const done = turn.children.find((c) => c.classList?.contains("done-card"));
  assert.ok(done?.textContent.includes("第 1 章 · 已完成"), "完成卡标题应为 '第 1 章 · 已完成'");
  assert.equal(turn.querySelectorAll(".filecard").length, 0, "完成卡不得含文件卡（P6）");

  // 终态文案只播报一次（由重建路径负责）：刷新路径不得双重播报。
  assert.equal(announced.filter((m) => m.includes("第 1 章已完成")).length, 1,
    "终态文案 '第 1 章已完成' 应只播报一次（finishAgentBlock 静态化不得重复播报）");
});

test("运行卡增量契约：chapter_completed 挂文件卡，summary 终态兜底静态化（finishAgentBlock）", async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx } = makeHarness();
  refs.thread.isConnected = true;
  const renderer = createThreadRenderer(ctx);
  const started = { type: "project_run_started", timestamp: "2026-07-31T10:00:00.000Z", chapter_no: 1, message: "开始写作" };
  const dash1 = makeDashboard();
  dash1.summary = { ...dash1.summary, projectStatus: "running", currentStage: "drafting" };
  dash1.events = [started];
  renderer.syncThread(dash1, true);

  // chapter_completed → attachChapterCard 在运行卡上挂文件卡（旧契约增量路径）。
  const dash2 = makeDashboard();
  dash2.summary = { ...dash2.summary, projectStatus: "running", currentStage: "drafting" };
  dash2.events = [...dash1.events, { type: "chapter_completed", timestamp: "2026-07-31T10:05:00.000Z", chapter_no: 1 }];
  renderer.syncThread(dash2, false);
  const fileCards = refs.thread.querySelectorAll(".filecard");
  assert.equal(fileCards.length, 1, "chapter_completed 后运行卡应挂载一张文件卡");
  assert.ok(fileCards[0].textContent.includes("打开阅读"), "文件卡应含 '打开阅读' 入口");

  // summary 终态兜底（无终态事件，如 SSE 断流后轮询）：updateLiveAgentBlock → finishAgentBlock
  // 静态化带头像运行卡（无 _startEvent 可重建事件时保留；重建路径由测试 A 覆盖）。
  const dash3 = makeDashboard();
  dash3.events = [...dash2.events];
  renderer.syncThread(dash3, false);
  const agent = refs.thread.children.find((c) => c.classList?.contains("msg-agent"));
  assert.ok(agent, "无终态事件时运行卡保留（未被重建）");
  const body = agent.children.find((c) => c.classList?.contains("agent-body"));
  const quick = body.querySelector(".quick-row");
  assert.ok(quick, "finishAgentBlock 静态化应渲染 quick row");
  assert.deepEqual(quick.children.map((chip) => chip.textContent), ["续写下一章"],
    "quick row 应只含续写入口");
  // _startEvent 历史运行卡静态化不播报（播报由重建路径负责一次），say 文案仍在 DOM 中。
  const say = body.querySelector(".agent-say");
  assert.ok(say?.textContent.includes("本轮任务已完成。"), "静态化 say 文案应为 '本轮任务已完成。'");
});

test("缺终态但后面有新轮：折叠为「未完成」完成卡，不播报开始写作（P3 边界）", async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx, announced } = makeHarness();
  const renderer = createThreadRenderer(ctx);
  const dash = makeDashboard();
  // 轮 1：只有 project_run_started 无终态事件，但后面有轮 2（user_instruction_received + project_run_started）
  // → 轮 1 确实已结束（只是缺终态事件），折叠为「未完成」完成卡（P3 边界）。
  dash.events = [
    { type: "project_run_started", timestamp: "2026-07-31T10:00:00.000Z", chapter_no: 1, message: "开始写作" },
    { type: "user_instruction_received", timestamp: "2026-07-31T10:06:00.000Z", message: "继续下一章" },
    { type: "project_run_started", timestamp: "2026-07-31T10:07:00.000Z", chapter_no: 2, message: "开始写作" },
  ];
  renderer.syncThread(dash, true);

  const turn = refs.thread.children.find((c) => c.classList?.contains("turn-agent"));
  assert.ok(turn, "轮 1（缺终态但已过）应折叠为 .turn-agent 完成卡");
  const done = turn.children.find((c) => c.classList?.contains("done-card"));
  assert.ok(done?.textContent.includes("第 1 章 · 未完成"), "缺终态轮标题应为 '第 1 章 · 未完成'");
  assert.ok(announced.every((m) => !m.includes("开始写作")),
    "unfinished 折叠不得播报 startEvent 的 '开始写作' 文案");
});

test("REVIEW-A：历史运行卡被新轮追赶时折叠，R2 渲染运行卡，终态播报恢复且不重复", async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx, announced } = makeHarness();
  refs.thread.isConnected = true;
  const renderer = createThreadRenderer(ctx);
  // data1：R1 仅 project_run_started（chapter_no: 1，无终态）→ 早退渲染运行卡。
  const r1Started = { type: "project_run_started", timestamp: "2026-07-31T10:00:00.000Z", chapter_no: 1, message: "开始写作" };
  const dash1 = makeDashboard();
  dash1.summary = { ...dash1.summary, projectStatus: "running", currentStage: "drafting" };
  dash1.events = [r1Started];
  renderer.syncThread(dash1, true);
  assert.ok(refs.thread.children.find((c) => c.classList?.contains("msg-agent")), "R1 运行卡应渲染");
  assert.equal(refs.thread.children.find((c) => c.classList?.contains("turn-agent")), undefined,
    "R1 无终态不得折叠");

  // data2：R1 终态（key 副本）+ R2 开轮（user_instruction_received + project_run_started）同轮到达。
  const dash2 = makeDashboard();
  dash2.summary = { ...dash2.summary, projectStatus: "running", currentStage: "drafting" };
  dash2.events = [
    { ...r1Started },
    { type: "chapter_completed", timestamp: "2026-07-31T10:05:00.000Z", chapter_no: 1 },
    { type: "project_run_finished", timestamp: "2026-07-31T10:06:00.000Z", message: "第 1 章已完成" },
    { type: "user_instruction_received", timestamp: "2026-07-31T10:07:00.000Z", message: "继续下一章" },
    { type: "project_run_started", timestamp: "2026-07-31T10:08:00.000Z", chapter_no: 2, message: "开始写作" },
  ];
  renderer.syncThread(dash2, false);

  // R1 折叠为完成卡（.turn-agent > .done-card），旧运行卡消失。
  const turns = refs.thread.querySelectorAll(".turn-agent");
  assert.equal(turns.length, 1, "R1 应折叠为一张 .turn-agent 完成卡");
  const done = turns[0].children.find((c) => c.classList?.contains("done-card"));
  assert.ok(done?.textContent.includes("第 1 章 · 已完成"), "R1 完成卡标题应为 '第 1 章 · 已完成'");
  // R2 渲染为 .msg-agent 运行卡（无终态且是最后 → 早退）。
  const agents = refs.thread.querySelectorAll(".msg-agent");
  assert.equal(agents.length, 1, "R1 旧运行卡应消失，只剩 R2 运行卡");
  // R1 终态播报恢复且只播报一次。
  assert.equal(announced.filter((m) => m.includes("第 1 章已完成")).length, 1,
    "R1 终态播报应恢复且只播报一次（追赶折叠不得丢失或重复）");

  // 后续轮询（R2 仍在运行，events 历史含 R1 终态）：R2 运行卡不得被重复重建
  // （重建段须判断终态属于当前运行卡对应轮，events 历史终态不得触发误判）。
  const r2Agent = refs.thread.querySelector(".msg-agent");
  const dash3 = makeDashboard();
  dash3.summary = { ...dash3.summary, projectStatus: "running", currentStage: "drafting" };
  dash3.events = [...dash2.events.map((e) => ({ ...e }))];
  renderer.syncThread(dash3, false);
  assert.equal(refs.thread.querySelector(".msg-agent"), r2Agent,
    "R2 运行卡不得被 events 历史终态误判重建（DOM 引用应保持）");
});

test("REVIEW-B：R1 缺终态被 R2 追赶 → 折叠为未完成卡，R2 渲染运行卡", async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx } = makeHarness();
  refs.thread.isConnected = true;
  const renderer = createThreadRenderer(ctx);
  // data1：同 REVIEW-A。
  const r1Started = { type: "project_run_started", timestamp: "2026-07-31T10:00:00.000Z", chapter_no: 1, message: "开始写作" };
  const dash1 = makeDashboard();
  dash1.summary = { ...dash1.summary, projectStatus: "running", currentStage: "drafting" };
  dash1.events = [r1Started];
  renderer.syncThread(dash1, true);

  // data2：R1 无终态（key 副本）+ R2 开轮。
  const dash2 = makeDashboard();
  dash2.summary = { ...dash2.summary, projectStatus: "running", currentStage: "drafting" };
  dash2.events = [
    { ...r1Started },
    { type: "user_instruction_received", timestamp: "2026-07-31T10:07:00.000Z", message: "继续下一章" },
    { type: "project_run_started", timestamp: "2026-07-31T10:08:00.000Z", chapter_no: 2, message: "开始写作" },
  ];
  renderer.syncThread(dash2, false);

  // R1 折叠为「未完成」完成卡（无停止按钮残留的旧运行卡）。
  const turns = refs.thread.querySelectorAll(".turn-agent");
  assert.equal(turns.length, 1, "R1 应折叠为一张 .turn-agent 完成卡");
  const done = turns[0].children.find((c) => c.classList?.contains("done-card"));
  assert.ok(done?.textContent.includes("第 1 章 · 未完成"),
    "R1 缺终态被追赶应折叠为 '第 1 章 · 未完成'");
  // R2 渲染为运行卡，停止按钮只属于 R2。
  assert.equal(refs.thread.querySelectorAll(".msg-agent").length, 1, "只剩 R2 运行卡");
  assert.equal(refs.thread.querySelectorAll(".run-stop-btn").length, 1,
    "停止按钮只属于 R2 运行卡（R1 旧运行卡不得残留）");
});
