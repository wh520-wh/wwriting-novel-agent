// Task 11: 一轮状态机渲染（思考→工具→段落→完成态）契约测试。
//
// 1) renderErrorCard 是 thread-renderer.js 导出的纯函数（规格书 5.9）：
//    标题+时间戳 / 人话+错误码徽章 / 可选提示行 / 操作按钮含手动重试；
//    禁止"不会自动重试"这类策略性说教文案。
// 2) live turn 状态机：user_instruction_received 开轮 → 思考块 → 工具行 →
//    正文流式 → 段落标记 → project_run_finished 清过程区、完成态淡入；
//    无头像、无署名行；历史轮保持折叠终态。
// 3) 项目归属守卫：切换项目/无项目后，旧项目的 SSE 事件不得串入当前线程渲染。
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

// ---------------------------------------------------------------------------
// Minimal DOM mock (no JSDOM) — 覆盖 live turn 渲染路径所需接口
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

function makeHarness(initialProject = "D:\\novel-a") {
  const refs = {
    thread: new MockElement("div"),
    threadWrap: new MockElement("div"),
  };
  const renderedKeys = new Set();
  const askEntries = new Map();
  const announced = [];
  let liveBlock = null;
  let projectRoot = initialProject;
  let dashboardChapters = [];
  const ctx = {
    refs,
    renderedKeys,
    askEntries,
    getLiveBlock: () => liveBlock,
    setLiveBlock: (block) => { liveBlock = block; },
    getCurrentProjectRoot: () => projectRoot,
    getDashboard: () => ({ project: {}, summary: {}, chapters: dashboardChapters }),
    announce: (msg) => announced.push(String(msg)),
    handleQuick: () => {},
    openReader: () => {},
    handleStop: () => {},
    handleRetry: () => {},
    showToast: () => {},
    showActionError: () => {},
    isChatBusy: () => false,
  };
  return {
    refs, ctx, announced,
    switchProject: (root) => { projectRoot = root; },
    setDashboardChapters: (chapters) => { dashboardChapters = chapters; },
  };
}

function userEvent(message = "继续写第 5 章") {
  return {
    type: "user_instruction_received",
    timestamp: "2026-08-03T10:00:00.000Z",
    message,
    data: { source: "task_queue", mode: "write", task_id: "t1" },
  };
}

function runStartedEvent() {
  return {
    type: "project_run_started",
    timestamp: "2026-08-03T10:00:01.000Z",
    chapter_no: 5,
    stage: "planning",
    message: "写作任务已由命令栏启动。",
  };
}

function planningEvent() {
  return {
    type: "stage_started",
    timestamp: "2026-08-03T10:00:02.000Z",
    chapter_no: 5,
    stage: "planning",
    message: "chapter planning started",
  };
}

function draftingCallEvent() {
  return {
    type: "model_call_started",
    timestamp: "2026-08-03T10:00:03.000Z",
    chapter_no: 5,
    stage: "drafting",
    message: "model gateway call started",
    data: { request_kind: "write_chapter", attempt: 1 },
  };
}

function chapterDoneEvent(chapterNo = 5) {
  return {
    type: "chapter_completed",
    timestamp: "2026-08-03T10:00:10.000Z",
    chapter_no: chapterNo,
    stage: "completed",
    message: "chapter completed",
  };
}

function runFinishedEvent(message = "写作任务已完成。") {
  return {
    type: "project_run_finished",
    timestamp: "2026-08-03T10:00:20.000Z",
    stage: "run",
    message,
  };
}

// ---------------------------------------------------------------------------
// Step 1 失败测试：renderErrorCard（规格书 5.9 结构断言）
// ---------------------------------------------------------------------------

test("错误卡片含手动重试按钮与错误码徽章", async () => {
  const { renderErrorCard } = await import("../../src/app-shell/thread-renderer.js");
  const card = renderErrorCard({
    title: "模型调用失败 · 401",
    body: "API Key 无效或已过期。",
    code: "401 Unauthorized · invalid_api_key",
    note: null,
    actions: [{ label: "↻ 重试", retry: true }]
  });
  assert.match(card, /↻ 重试/);
  assert.match(card, /401 Unauthorized · invalid_api_key/);
  assert.doesNotMatch(card, /不会自动重试/); // 策略说教禁止
  // 结构断言：错误码进徽章，时间戳存在，note 为空不渲染提示行，重试按钮带 data-retry
  assert.match(card, /class="e-code"/);
  assert.match(card, /class="e-time"/);
  assert.doesNotMatch(card, /class="e-note"/);
  assert.match(card, /data-retry="1"/);
  assert.match(card, /class="msg-error"/);
});

test("错误卡片 note 非空时渲染提示行，静态按钮不挂 data-retry", async () => {
  const { renderErrorCard } = await import("../../src/app-shell/thread-renderer.js");
  const card = renderErrorCard({
    title: "网络请求失败 · 已自动重试 5 次",
    body: "仍无法连接模型服务（连接超时）。",
    code: "network_retry_exhausted · ETIMEDOUT",
    note: "已保留当前进度。",
    actions: ["↻ 继续写作", { label: "↻ 重试", retry: true }]
  });
  assert.match(card, /class="e-note">已保留当前进度/);
  assert.match(card, /↻ 继续写作/);
  assert.doesNotMatch(card, /策略/);
  // 只有带 retry 标记的按钮才有 data-retry
  const retryMarks = card.match(/data-retry="1"/g) ?? [];
  assert.equal(retryMarks.length, 1, "仅手动重试按钮携带 data-retry");
});

// ---------------------------------------------------------------------------
// live turn 状态机：正常流（思考→工具→正文→段落→完成态）
// ---------------------------------------------------------------------------

test("live turn 正常流：一轮渲染到完成态，过程区清空、无头像无署名", async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx, announced, setDashboardChapters } = makeHarness();
  const renderer = createThreadRenderer(ctx);
  const thread = refs.thread;
  setDashboardChapters([{ chapter_no: 5, actual_words: 98 }]);

  // 开轮：用户气泡 + turn-agent
  renderer.onRunEvent(userEvent("继续写第 5 章，主角要发现真相。"));
  const userWrap = thread.children.find((c) => c.classList?.contains("msg-user"));
  assert.ok(userWrap, "user_instruction_received 应渲染用户气泡");
  assert.ok(userWrap.textContent.includes("继续写第 5 章"), "用户气泡带指令原文");
  const turn = thread.children.find((c) => c.classList?.contains("turn-agent"));
  assert.ok(turn, "应渲染 turn-agent 轮容器");

  // 无头像、无署名行（P6：Agent 消息直接以内容开始）
  assert.equal(turn.querySelector(".agent-avatar"), null, "turn 内不得出现头像");
  assert.equal(turn.querySelector(".agent-name"), null, "turn 内不得出现署名行");
  assert.equal(turn.querySelector(".agent-tag"), null, "turn 内不得出现 agent-tag");

  // 思考块：规划阶段可见（思考中…）
  renderer.onRunEvent(planningEvent());
  const think = turn.querySelector(".think-block");
  assert.ok(think, "planning 阶段应渲染思考块");
  assert.ok(!think.classList.contains("hidden"), "思考块应可见");
  assert.ok(think.textContent.includes("思考中"), "思考块头部显示思考中");

  // 思考流式：planning 阶段 model_delta 进思考块
  renderer.onModelDelta("先铺氛围，再抛照片。");
  assert.ok(think.textContent.includes("先铺氛围，再抛照片。"), "planning 阶段 delta 追加进思考块");

  // 起草：思考合拢（可点开）、工具行出现
  renderer.onRunEvent(draftingCallEvent());
  assert.ok(!think.classList.contains("open"), "起草开始后思考块合拢（收起展开态）");
  assert.ok(think.textContent.includes("已思考"), "思考块合拢态标题为已思考");
  const tool = turn.querySelector(".tool-card");
  assert.ok(tool && !tool.classList.contains("hidden"), "起草开始后工具行可见");
  assert.ok(tool.textContent.includes("正在撰写 第 5 章"), "工具行文案带章节号");
  assert.ok(tool.textContent.includes("进行中"), "工具行状态进行中");

  // 正文流式：drafting 阶段 model_delta 进正文区（衬线 para + 光标）
  renderer.onModelDelta("他推开门，灯光从背后漏进来。");
  const streamArea = turn.querySelector(".stream-area");
  const para = turn.querySelector(".para");
  assert.ok(streamArea, "应渲染正文流式区");
  assert.ok(para, "正文区应有流式 para");
  assert.ok(streamArea.children.includes(para), "para 应位于流式正文区内");
  assert.ok(para.textContent.includes("他推开门，灯光从背后漏进来。"), "delta 追加进正文");
  const cursor = para.querySelector(".cursor");
  assert.ok(cursor, "流式正文应带光标");

  // 段落折叠：chapter_completed → 文字标记
  renderer.onRunEvent(chapterDoneEvent(5));
  const chips = turn.querySelector(".para-chips");
  assert.ok(chips && !chips.classList.contains("hidden"), "段落标记排可见");
  const chip = turn.querySelector(".p-chip");
  assert.ok(chip, "段落完成后应追加 p-chip");
  assert.ok(chip.textContent.includes("第 5 章"), "p-chip 带章节号");
  assert.ok(chip.textContent.includes("字"), "p-chip 带实时字数");
  const toolStatus = tool.textContent;
  assert.ok(toolStatus.includes("完成"), "工具行状态转完成");

  // 完成态：project_run_finished → 过程区清空、完成卡淡入
  renderer.onRunEvent(runFinishedEvent("第 5 章已完成。"));
  assert.ok(think.classList.contains("hidden"), "完成后思考块隐藏");
  assert.ok(tool.classList.contains("hidden"), "完成后工具行隐藏");
  assert.ok(chips.classList.contains("hidden"), "完成后段落标记排隐藏");
  const done = turn.querySelector(".done-card");
  assert.ok(done && !done.classList.contains("hidden"), "完成卡应可见（淡入）");
  assert.ok(done.classList.contains("enter"), "完成卡应带入场动画类");
  const doneHead = done.querySelector(".done-head");
  assert.ok(doneHead, "完成卡带头部");
  assert.ok(doneHead.textContent.includes("第 5 章"), "完成卡标题带章节号");
  const doneFull = done.querySelector(".full-text");
  assert.ok(doneFull && doneFull.textContent.includes("他推开门，灯光从背后漏进来。"), "展开全文含正文");
  const doneMeta = done.querySelector(".done-meta");
  assert.ok(doneMeta, "完成卡带摘要");
  assert.ok(doneMeta.textContent.includes("字"), "摘要带实时字数");
  assert.ok(announced.some((m) => m.includes("第 5 章已完成")), "完成播报应 announce");
  // 已完成的轮不再接受流式（done 后 delta 丢弃）
  renderer.onModelDelta("不应出现的尾巴");
  assert.ok(!doneFull.textContent.includes("不应出现的尾巴"), "done 后 delta 应丢弃");
});

test("project_run_started 由 live turn 认领，轮询 syncThread 不再渲染旧式 agent 块", async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx } = makeHarness();
  const renderer = createThreadRenderer(ctx);

  renderer.onRunEvent(userEvent());
  renderer.onRunEvent(runStartedEvent());
  renderer.onRunEvent(planningEvent());

  // 轮询兜底到达：同一批事件（指纹去重），不应出现第二份用户气泡或旧式 .msg-agent 运行块。
  const dashboard = {
    project: { title: "测试小说" },
    projectRoot: "D:\\novel-a",
    summary: {
      currentStage: "planning",
      projectStatus: "running",
      currentChapterNo: 5,
      totalWords: 0,
      costAvailable: false,
    },
    events: [
      userEvent(),
      runStartedEvent(),
      planningEvent(),
      chapterDoneEvent(5),
      runFinishedEvent(),
    ],
  };
  renderer.syncThread(dashboard, false);

  const userWraps = refs.thread.querySelectorAll(".msg-user");
  assert.equal(userWraps.length, 1, "用户气泡不得重复渲染");
  const oldAgentBlocks = refs.thread.querySelectorAll(".msg-agent");
  assert.equal(oldAgentBlocks.length, 0, "live turn 期间轮询不得渲染旧式 agent 运行块");
  const turns = refs.thread.querySelectorAll(".turn-agent");
  assert.equal(turns.length, 1, "live turn 唯一");
});

test("项目归属守卫：切换项目/无项目后，旧项目事件不得串入渲染", async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx, switchProject } = makeHarness("D:\\novel-a");
  const renderer = createThreadRenderer(ctx);

  renderer.onRunEvent(userEvent("写 A 项目第 1 章"));
  renderer.onRunEvent(draftingCallEvent());
  renderer.onModelDelta("A 项目的正文。");

  // 切到无项目（SSE 旧连接未关的已知问题场景）
  switchProject(null);
  renderer.onModelDelta("串台尾巴 1");
  renderer.onRunEvent(chapterDoneEvent(1));
  const turnA = refs.thread.querySelector(".turn-agent");
  assert.ok(turnA, "A 项目 turn 仍在（历史 DOM）");
  assert.ok(!turnA.textContent.includes("串台尾巴 1"), "无项目后旧 SSE delta 应被丢弃");
  assert.equal(turnA.querySelectorAll(".p-chip").length, 0, "无项目后旧 SSE 事件不得追加段落标记");

  // 切到 B 项目：旧项目事件同样丢弃
  switchProject("D:\\novel-b");
  renderer.onModelDelta("串台尾巴 2");
  renderer.onRunEvent(runFinishedEvent());
  assert.ok(!turnA.textContent.includes("串台尾巴 2"), "切项目后旧 SSE delta 应被丢弃");
  const doneInTurnA = turnA.querySelector(".done-card");
  assert.ok(!doneInTurnA || doneInTurnA.classList.contains("hidden"), "切项目后旧 SSE 完成事件不得驱动旧 turn 完成态");
});
