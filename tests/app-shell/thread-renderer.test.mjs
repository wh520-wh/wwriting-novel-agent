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
    this.disabled = false; // 对齐真实 DOM：disabled 初始 false
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

  // innerHTML 只做原始字符串存储（不做解析）；querySelector/querySelectorAll 遇到
  // [data-retry] / [data-open-settings] 等 data-* 属性选择器时，若 markup 含对应
  // data-xxx="1"，惰性物化一个按钮子节点，使 live turn 的按钮绑定（failTurn）在
  // 无 jsdom 下可被真实点击验证。
  set innerHTML(html) {
    this._innerHTML = String(html);
  }
  get innerHTML() {
    return this._innerHTML ?? "";
  }

  _queryAttrFallback(selector) {
    const m = selector.match(/^\[data-([\w-]+)(?:="1")?\]$/);
    if (!m) return null;
    const attr = m[1];
    if (!this._innerHTML || !new RegExp(`data-${attr}="1"`).test(this._innerHTML)) return null;
    const key = `_attrNode_${attr}`;
    if (!this[key]) {
      const btn = new MockElement("button");
      btn.dataset[MockElement._dataKey(attr)] = "1";
      btn._text = `[data-${attr}]`;
      this[key] = btn;
      this.children.push(btn);
    }
    return this[key];
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node instanceof MockElement) {
        // 对齐真实 DOM：append 已挂载节点是「移动」而非复制（活动流重锚定依赖此语义，
        // 同父节点再 append 也移到末尾）。
        if (node._parent) {
          const idx = node._parent.children.indexOf(node);
          if (idx >= 0) node._parent.children.splice(idx, 1);
        }
        node._parent = this;
      }
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
  insertBefore(node, ref) {
    if (node instanceof MockElement) node._parent = this;
    const index = this.children.indexOf(ref);
    if (index >= 0) this.children.splice(index, 0, node);
    else this.children.push(node);
  }
  remove() {
    // Task 9: 活动流 clear() 依赖真实 detach 语义（线程重建/占位移除共用）。
    if (this._parent) {
      const index = this._parent.children.indexOf(this);
      if (index >= 0) this._parent.children.splice(index, 1);
      this._parent = null;
    }
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
    // M-7: 贴近真实浏览器——disabled 按钮不派发 click。
    // 之前 mock 不检查 disabled,「点过 once 后 task/reject 仍发请求」是测试假绿,
    // 真实浏览器中 disabled 按钮点击不触发任何监听器。
    if (type === "click" && this.disabled) return;
    for (const fn of this._listeners.get(type) ?? []) fn(...args);
  }

  // 真实 DOM 的 data-* 属性在 dataset 里是 camelCase 键（data-chapter-no → chapterNo）。
  static _dataKey(name) {
    return name.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
  }

  _matches(selector) {
    // 复合选择器 .class[data-attr] / .class[data-attr="value"]（如 .p-chip[data-chapter-no]）
    const compound = selector.match(/^\.([\w-]+)((?:\[data-[\w-]+(?:="[^"]*")?\])+)$/);
    if (compound) {
      if (!this.classList.contains(compound[1])) return false;
      for (const m of compound[2].matchAll(/\[data-([\w-]+)(?:="([^"]*)")?\]/g)) {
        const actual = this.dataset[MockElement._dataKey(m[1])] ?? "";
        if (m[2] === undefined ? actual === "" : String(actual) !== m[2]) return false;
      }
      return true;
    }
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    if (selector.startsWith("#")) return (this._attrs.id ?? "") === selector.slice(1);
    const dataSel = selector.match(/^\[data-([\w-]+)="?([^"\]]*)"?\]$/);
    if (dataSel) return String(this.dataset[MockElement._dataKey(dataSel[1])] ?? "") === dataSel[2];
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
    return this._queryAttrFallback(selector);
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
    const fallback = this._queryAttrFallback(selector);
    if (fallback) out.push(fallback);
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
    openSettingsModal: () => {},
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
// Task 12: 错误分级——重试行（琥珀 n/5）/ 恢复提示（绿字）/ 终态清理
// ---------------------------------------------------------------------------

test("renderRetryLine / renderRecoverLine 输出规格书文案（琥珀重试行 n/5、绿字恢复）", async () => {
  const { renderRetryLine, renderRecoverLine } = await import("../../src/app-shell/thread-renderer.js");
  const retry = renderRetryLine(2);
  assert.match(retry, /class="retry-line"/, "重试行容器");
  assert.match(retry, /class="pulse"/, "重试行带脉动圆点");
  assert.match(retry, /⚡ 网络波动，正在自动重试 <b>2<\/b>\/5 …/, "规格书 5.7 文案逐字（n/5）");
  const recover = renderRecoverLine(3);
  assert.match(recover, /class="recover-line"/, "恢复行容器");
  assert.match(recover, /✓ 连接已恢复（第 3 次重试成功），从断点继续写作/, "规格书 5.8 文案逐字");
});

function retryEvent(attempt, message = `模型调用重试 ${attempt}/5（network）`) {
  return {
    type: "model_retry",
    timestamp: `2026-08-03T10:00:0${attempt}.000Z`,
    severity: "warn",
    message,
    data: { attempt, maxAttempts: 5, delay: 1600, reason: "network", model: "test-model" },
  };
}

test("model_retry → 琥珀重试行 n/5 计数实时更新；恢复消息 → 绿字；终态随过程区清理", async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx } = makeHarness();
  const renderer = createThreadRenderer(ctx);

  renderer.onRunEvent(userEvent());
  renderer.onRunEvent(draftingCallEvent());

  const turn = refs.thread.querySelector(".turn-agent");
  const statusSlot = turn.querySelector(".status-slot");
  assert.ok(statusSlot, "turn 应渲染 status-slot");
  assert.ok(statusSlot.classList.contains("hidden"), "无重试时状态槽隐藏");

  // 第一次重试：1/5
  renderer.onRunEvent(retryEvent(1));
  assert.ok(!statusSlot.classList.contains("hidden"), "重试事件后状态槽可见");
  assert.match(statusSlot.innerHTML, /正在自动重试 <b>1<\/b>\/5/, "琥珀重试行 1/5");

  // 计数实时可见：第二次重试更新为 2/5，旧计数不残留
  renderer.onRunEvent(retryEvent(2));
  assert.match(statusSlot.innerHTML, /正在自动重试 <b>2<\/b>\/5/, "n/5 计数随事件实时更新");
  assert.doesNotMatch(statusSlot.innerHTML, /<b>1<\/b>\/5/, "旧计数不得残留");

  // 恢复消息（status_message 含「恢复」）→ 绿字恢复行
  renderer.onRunEvent({
    type: "status_message",
    timestamp: "2026-08-03T10:00:04.000Z",
    message: "连接已恢复（第 2 次重试成功），继续写作。",
    data: { attempt: 2 },
  });
  assert.match(statusSlot.innerHTML, /✓ 连接已恢复（第 2 次重试成功），从断点继续写作/, "恢复提示绿字文案");

  // 最终成功：过程区清理（R5：重试/恢复提示属过程态，随过程区整体消失）
  renderer.onRunEvent(runFinishedEvent("第 5 章已完成。"));
  assert.ok(statusSlot.classList.contains("hidden"), "终态后状态槽随过程区隐藏");
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

// ---------------------------------------------------------------------------
// Fix round 1: 完成态磁盘回填（Critical 1 — getJson 导入缺失会静默失效）
// 写作主调用为非流式 + 工具调用，delta 流为空；完成态正文/字数/预览必须由
// GET /api/chapters/read 从磁盘回填。此前 getJson 未导入，ReferenceError 被
// catch{} 吞掉，完成卡显示「0 字」+ 空预览 + 空展开全文。
// ---------------------------------------------------------------------------

const DISK_TEXT = "磁盘上保存的真实正文。窗外雨声渐歇，他合上笔记本，望向窗外泛白的天际。";

test("完成态从磁盘回填真实正文：getJson 回填 doneFull/预览/字数（非流式写作）", async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx } = makeHarness();
  const renderer = createThreadRenderer(ctx);
  const realFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url, _options) => {
    requested.push(String(url));
    return { ok: true, text: async () => JSON.stringify({ ok: true, content: DISK_TEXT }) };
  };
  try {
    // 无任何 model_delta：完成卡初始为「0 字」+ 空预览，只能靠磁盘回填恢复。
    renderer.onRunEvent(userEvent());
    renderer.onRunEvent(runStartedEvent());
    renderer.onRunEvent(draftingCallEvent());
    renderer.onRunEvent(chapterDoneEvent(5));
    renderer.onRunEvent(runFinishedEvent());
    await new Promise((r) => setTimeout(r, 10));

    const turn = refs.thread.querySelector(".turn-agent");
    const done = turn.querySelector(".done-card");
    assert.ok(
      requested.some((u) => u.includes("/api/chapters/read?chapter=5")),
      "完成态应请求磁盘章节正文接口"
    );
    const doneFull = done.querySelector(".full-text");
    assert.equal(doneFull.textContent, DISK_TEXT, "展开全文应从磁盘回填真实正文");
    const expectedWords = DISK_TEXT.replace(/\s/g, "").length;
    assert.ok(done.textContent.includes(`${expectedWords} 字`), "完成卡字数应更新为磁盘真实字数");
    const preview = done.querySelector(".done-preview");
    assert.equal(preview.textContent, `“${DISK_TEXT.trim().slice(0, 24)}……”`, "预览应取磁盘正文前 24 字");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// Fix round 1: 失败/中断路径覆盖（Important 2 — 此前零测试）
// ---------------------------------------------------------------------------

function runFailedEvent() {
  return {
    type: "project_run_failed",
    timestamp: "2026-08-03T10:00:25.000Z",
    stage: "run",
    message: "模型调用失败：401 Unauthorized，API Key 无效或已过期。",
    data: { status: 401, reason: "invalid_api_key", name: "AuthenticationError" },
  };
}

test("project_run_failed → 红卡挂载 + data-retry 手动重试 + 「已保留当前进度」", async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx } = makeHarness();
  const renderer = createThreadRenderer(ctx);
  let retried = 0;
  ctx.handleRetry = () => { retried += 1; };
  let settingsOpened = 0;
  ctx.openSettingsModal = () => { settingsOpened += 1; };

  renderer.onRunEvent(userEvent());
  renderer.onRunEvent(runStartedEvent());
  renderer.onRunEvent(draftingCallEvent());
  renderer.onRunEvent(runFailedEvent());

  const turn = refs.thread.querySelector(".turn-agent");
  const errSlot = turn.querySelector(".error-slot");
  assert.ok(errSlot, "失败轮应渲染 error-slot");
  assert.ok(!errSlot.classList.contains("hidden"), "失败后红卡槽应可见");
  const card = errSlot.children[0];
  assert.ok(card, "errorSlot 应挂载错误卡");
  // 红卡结构（规格书 5.9）：标题+时间戳 / 人话+错误码徽章 / 后果提示 / 手动重试按钮
  assert.match(card.innerHTML, /class="msg-error"/, "红卡容器");
  assert.match(card.innerHTML, /模型调用失败 · 401/, "标题带状态码");
  assert.match(card.innerHTML, /401 · invalid_api_key/, "错误码徽章");
  assert.match(card.innerHTML, /已保留当前进度/, "提示行只放用户需要知道的后果");
  assert.match(card.innerHTML, /↻ 重试/, "手动重试按钮文案");
  assert.doesNotMatch(card.innerHTML, /继续写作/, "鉴权类红卡不提供「↻ 继续写作」（规格书 6.3：配置/鉴权错误流手动「↻ 重试」）");
  assert.match(card.innerHTML, /data-retry="1"/, "手动重试按钮带 data-retry 标记");
  // 鉴权/配置类（HTTP 4xx）红卡提供「打开设置」修复入口（Task 3）
  assert.match(card.innerHTML, /打开设置/, "鉴权/配置类红卡提供「打开设置」按钮");
  assert.match(card.innerHTML, /data-open-settings="1"/, "打开设置按钮带 data-open-settings 标记");
  // data-retry 绑定真实可点：点击应回调 ctx.handleRetry
  const retryBtn = card.querySelector("[data-retry]");
  assert.ok(retryBtn, "红卡内应存在 data-retry 按钮节点");
  retryBtn._fire("click");
  assert.equal(retried, 1, "点击手动重试应触发 ctx.handleRetry");
  // data-open-settings 绑定真实可点：点击应打开设置弹窗（ctx.openSettingsModal）
  const settingsBtn = card.querySelector("[data-open-settings]");
  assert.ok(settingsBtn, "红卡内应存在 data-open-settings 按钮节点");
  settingsBtn._fire("click");
  assert.equal(settingsOpened, 1, "点击打开设置应触发 ctx.openSettingsModal");
  // 失败即终态：后续收尾事件不得再驱动完成态
  renderer.onRunEvent(runFinishedEvent());
  assert.ok(!errSlot.classList.contains("hidden"), "失败后红卡保持可见");
  const done = turn.querySelector(".done-card");
  assert.ok(done.classList.contains("hidden"), "失败轮不得再显示完成卡");
});

test("project_run_failed HTTP 500：5xx 归网络类（ProviderTransportError 也带 status），红卡不含「打开设置」（Task 3）", async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx } = makeHarness();
  const renderer = createThreadRenderer(ctx);
  let settingsOpened = 0;
  ctx.openSettingsModal = () => { settingsOpened += 1; };

  renderer.onRunEvent(userEvent());
  renderer.onRunEvent(runStartedEvent());
  renderer.onRunEvent(draftingCallEvent());
  renderer.onRunEvent({
    type: "project_run_failed",
    timestamp: "2026-08-03T10:00:25.000Z",
    stage: "run",
    message: "模型调用失败：500 Internal Server Error。",
    data: { status: 500, reason: "server_error", name: "ProviderTransportError" },
  });

  const turn = refs.thread.querySelector(".turn-agent");
  const errSlot = turn.querySelector(".error-slot");
  assert.ok(errSlot && !errSlot.classList.contains("hidden"), "失败轮应渲染可见 error-slot");
  const card = errSlot.children[0];
  assert.doesNotMatch(card.innerHTML, /打开设置/, "5xx 归网络类，红卡不含「打开设置」");
  assert.equal(card.querySelector("[data-open-settings]"), null, "5xx 红卡无 data-open-settings 按钮节点");
  assert.match(card.innerHTML, /↻ 继续写作/, "5xx 归网络类，提供「↻ 继续写作」");
  assert.match(card.innerHTML, /复制错误详情/, "5xx 归网络类，提供「复制错误详情」");
  assert.equal(settingsOpened, 0, "5xx 红卡点击不到设置入口，openSettingsModal 不应被调用");
});

test("project_run_failed HTTP 429（字符串 status）：限流归网络类（engine server-retryable），红卡不含「打开设置」（Task 3 审查修正）", async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx } = makeHarness();
  const renderer = createThreadRenderer(ctx);
  let settingsOpened = 0;
  ctx.openSettingsModal = () => { settingsOpened += 1; };

  renderer.onRunEvent(userEvent());
  renderer.onRunEvent(runStartedEvent());
  renderer.onRunEvent(draftingCallEvent());
  renderer.onRunEvent({
    type: "project_run_failed",
    timestamp: "2026-08-03T10:00:25.000Z",
    stage: "run",
    message: "模型调用失败：429 Too Many Requests，请求过于频繁。",
    data: { status: "429", reason: "rate_limit_exceeded", name: "ProviderTransportError" },
  });

  const turn = refs.thread.querySelector(".turn-agent");
  const errSlot = turn.querySelector(".error-slot");
  assert.ok(errSlot && !errSlot.classList.contains("hidden"), "失败轮应渲染可见 error-slot");
  const card = errSlot.children[0];
  assert.doesNotMatch(card.innerHTML, /打开设置/, "429 限流归网络类，红卡不含「打开设置」（限流不是设置能修的）");
  assert.equal(card.querySelector("[data-open-settings]"), null, "429 红卡无 data-open-settings 按钮节点");
  assert.match(card.innerHTML, /↻ 继续写作/, "429 归网络类，提供「↻ 继续写作」");
  assert.match(card.innerHTML, /复制错误详情/, "429 归网络类，提供「复制错误详情」");
  assert.equal(settingsOpened, 0, "429 红卡无设置入口，openSettingsModal 不应被调用");
  // 字符串 status 也按 4xx 判定（title/code 逻辑不受 Number 转换影响）
  assert.match(card.innerHTML, /模型调用失败 · 429/, "标题带状态码（字符串原样透传）");
  assert.match(card.innerHTML, /429 · rate_limit_exceeded/, "错误码徽章带状态码");
});

test("project_run_failed 且已有流式残段：残段折叠为（未完成）标记 + 工具行红色已中断（规格书 6.2/5.3）", async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx } = makeHarness();
  const renderer = createThreadRenderer(ctx);

  renderer.onRunEvent(userEvent());
  renderer.onRunEvent(runStartedEvent());
  renderer.onRunEvent(draftingCallEvent());
  renderer.onModelDelta("残段正文：他推开门，灯光漏进来。");

  renderer.onRunEvent(runFailedEvent());

  const turn = refs.thread.querySelector(".turn-agent");
  // 残段收成（未完成）文字标记
  const residue = turn.querySelectorAll(".p-chip").find((c) => c.classList.contains("unfinished"));
  assert.ok(residue, "失败后残段应收成（未完成）标记");
  assert.ok(residue.textContent.includes("（未完成）"), "残段标记带（未完成）标注");
  assert.ok(residue.textContent.includes("第 5 章"), "残段标记带章节号");
  assert.ok(residue.textContent.includes("字"), "残段标记带实时字数（JS 统计，禁止写死）");
  // 流式正文区：para 已进入折叠动画（0.38s 后移除），不再累积新文本
  const streamPara = turn.querySelector(".para");
  assert.ok(streamPara && streamPara.classList.contains("folding"), "残段正文进入折叠动画（折叠即不再占位）");
  // 工具行状态变红「已中断」
  const tool = turn.querySelector(".tool-card");
  assert.ok(tool, "工具行仍在（过程态）");
  assert.ok(tool.textContent.includes("已中断"), "工具行状态显示已中断");
  const status = tool.querySelector(".status");
  assert.ok(status.classList.contains("bad"), "工具行状态带红色 bad 类（规格书 5.3 失败中断红色）");
});

test("project_cancelled 折叠终态标题：「第 N 章 · 已停止」", async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx } = makeHarness();
  const renderer = createThreadRenderer(ctx);

  renderer.onRunEvent(userEvent());
  renderer.onRunEvent(runStartedEvent());
  renderer.onRunEvent(draftingCallEvent());
  renderer.onRunEvent(chapterDoneEvent(5));
  renderer.onRunEvent({
    type: "project_cancelled",
    timestamp: "2026-08-03T10:00:25.000Z",
    chapter_no: 5,
    stage: "run",
    message: "写作任务已停止。",
  });

  const turn = refs.thread.querySelector(".turn-agent");
  const done = turn.querySelector(".done-card");
  assert.ok(done && !done.classList.contains("hidden"), "cancelled 应收进折叠终态（完成卡可见）");
  const head = done.querySelector(".done-head");
  assert.ok(head.textContent.includes("第 5 章 · 已停止"), "cancelled 变体标题为「第 N 章 · 已停止」");
  const chips = turn.querySelector(".para-chips");
  assert.ok(chips.classList.contains("hidden"), "终态后段落标记排隐藏");
});

test("reconcileLiveTurn 轮询兜底：SSE 断流时按 dashboard 终态收尾 + 段落字数回填", async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx } = makeHarness();
  const renderer = createThreadRenderer(ctx);

  // SSE 侧只到段落完成，project_run_finished 未送达（断流/重连窗口）。
  renderer.onRunEvent(userEvent());
  renderer.onRunEvent(runStartedEvent());
  renderer.onRunEvent(chapterDoneEvent(5));

  // 轮询兜底：dashboard 已是终态（cancelled），且章节真实字数可回填段落标记。
  renderer.syncThread({
    project: { title: "测试小说" },
    projectRoot: "D:\\novel-a",
    summary: { projectStatus: "cancelled", currentChapterNo: 5, totalWords: 88, costAvailable: false },
    chapters: [{ chapter_no: 5, actual_words: 88 }],
    events: [],
  }, false);

  const turn = refs.thread.querySelector(".turn-agent");
  const chip = turn.querySelector(".p-chip");
  assert.ok(chip, "段落标记应在对账前存在");
  assert.ok(chip.textContent.includes("📖 第 5 章 · 88 字"), "轮询对账应回填段落标记真实字数");
  const done = turn.querySelector(".done-card");
  assert.ok(done && !done.classList.contains("hidden"), "SSE 断流时轮询兜底应收尾完成态");
  const head = done.querySelector(".done-head");
  assert.ok(head.textContent.includes("第 5 章 · 已停止"), "轮询兜底按 dashboard 终态定标题");
});

// ---------------------------------------------------------------------------
// Fix round 2 (Task 13 审查 Important 1)：失败红卡按失败类型区分动作集。
// 规格书 6.2 耗尽场景「↻ 继续写作」/ 6.3 鉴权场景「↻ 重试 + 打开设置」；定稿原型 S4 动作数组
// [{ ↻ 重试(retry) }, "↻ 继续写作", "复制错误详情"] 两按钮并存。
// 判别依据（Task 3 · Codex 审查修正）：鉴权/配置类 = HTTP 4xx 且非 429（status ∈ [400, 500) 且 ≠ 429）；
// 429 限流（engine 判 server-retryable，自动重试 5 次后耗尽）、无 status（reason:"timeout"）与
// 5xx（ProviderTransportError 对 500 也带 status）均归网络类。
// 两个按钮点击行为都走 ctx.handleRetry（内部 POST /api/run/retry = 从保存状态创建 recovery task）。
// ---------------------------------------------------------------------------

function runFailedExhaustedEvent() {
  return {
    type: "project_run_failed",
    timestamp: "2026-08-03T10:00:25.000Z",
    stage: "run",
    message: "仍无法连接模型服务（连接超时）。",
    data: { status: null, reason: "timeout", name: "ProviderTransportError" },
  };
}

test("project_run_failed 网络耗尽（无 status）：红卡含「↻ 继续写作」+「↻ 重试」+「复制错误详情」，按钮均触发 handleRetry（规格书 6.2 + 定稿原型 S4）", async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx } = makeHarness();
  const renderer = createThreadRenderer(ctx);
  let retried = 0;
  ctx.handleRetry = () => { retried += 1; };

  renderer.onRunEvent(userEvent());
  renderer.onRunEvent(runStartedEvent());
  renderer.onRunEvent(draftingCallEvent());
  renderer.onRunEvent(runFailedExhaustedEvent());

  const turn = refs.thread.querySelector(".turn-agent");
  const errSlot = turn.querySelector(".error-slot");
  assert.ok(errSlot && !errSlot.classList.contains("hidden"), "失败轮应渲染可见 error-slot");
  const card = errSlot.children[0];
  assert.match(card.innerHTML, /↻ 继续写作/, "网络耗尽红卡应提供「↻ 继续写作」（规格书 6.2：提示进度已保留，提供继续写作按钮）");
  assert.match(card.innerHTML, /↻ 重试/, "网络耗尽红卡保留「↻ 重试」（定稿原型 S4：两按钮并存）");
  assert.match(card.innerHTML, /复制错误详情/, "网络耗尽红卡提供「复制错误详情」（定稿原型 S4）");
  // 引擎错误形态如实透传（标题 写作任务失败 · ProviderTransportError / 徽章 timeout）——登记偏差，前端不修（Minor 6）。
  assert.match(card.innerHTML, /写作任务失败 · ProviderTransportError/, "标题如实透传引擎错误形态");
  assert.match(card.innerHTML, /timeout/, "错误码徽章如实透传 reason");
  const retryMarks = card.innerHTML.match(/data-retry="1"/g) ?? [];
  assert.equal(retryMarks.length, 2, "「↻ 重试」与「↻ 继续写作」均带 data-retry（点击都走 ctx.handleRetry）");
  // 网络耗尽（无 status）：不属于鉴权/配置类，红卡不得出现「打开设置」修复入口（Task 3）
  assert.doesNotMatch(card.innerHTML, /打开设置/, "网络耗尽红卡不含「打开设置」");
  assert.equal(card.querySelector("[data-open-settings]"), null, "网络耗尽红卡无 data-open-settings 按钮节点");
  const retryBtn = card.querySelector("[data-retry]");
  assert.ok(retryBtn, "红卡内应存在 data-retry 按钮节点");
  retryBtn._fire("click");
  assert.equal(retried, 1, "点击按钮应触发 ctx.handleRetry");
});

// ---------------------------------------------------------------------------
// Fix round 2 (Task 13 审查 Minor 5)：greeting / side bubble 去头像去署名行。
// 规格书 P6：Agent 消息不带头像、不带署名行，直接以内容开始；历史轮（defer 4）不动。
// ---------------------------------------------------------------------------

test("greeting 无头像无署名行：Agent 消息直接以内容开始（规格书 P6）", async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx } = makeHarness();
  const renderer = createThreadRenderer(ctx);
  renderer.renderEmptyThread();
  const greeting = refs.thread.querySelector(".msg-agent");
  assert.ok(greeting, "greeting 应渲染（msg-agent 容器）");
  assert.equal(greeting.querySelector(".agent-avatar"), null, "greeting 不得渲染头像");
  assert.equal(greeting.querySelector(".agent-name"), null, "greeting 不得渲染署名行");
  assert.ok(greeting.textContent.includes("我已就绪"), "greeting 直接以内容开始");
});

test("side bubble 无头像：旁路问答直接以内容开始（规格书 P6）", async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx } = makeHarness();
  const renderer = createThreadRenderer(ctx);
  const bubble = renderer.buildSideBubble({
    question: "旁路问题示例",
    answer: "旁路回答示例",
    mainTaskAffecting: false,
    promoted: false,
  });
  assert.equal(bubble.querySelector(".agent-avatar"), null, "side bubble 不得渲染头像");
  assert.ok(bubble.textContent.includes("旁路问题示例"), "side bubble 直接以内容开始");
});

// ---------------------------------------------------------------------------
// Task 3: SKIPPED 中性灰渲染（spec §2.3-U1/U6 —— SKIPPED 不归红色系，用「·」代替红 X）。
// 数据协议：后端聚合落盘为一条 batch_skipped（tool + result_summary 含「跳过」），
// 旧式逐条 SKIPPED（summary 以 SKIPPED 开头）同样按中性灰处理。
// renderToolCard 内部走 applyFold → localStorage，这里局部 mock 掉。
// ---------------------------------------------------------------------------

function withLocalStorage(fn) {
  return async () => {
    const real = globalThis.localStorage;
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };
    try {
      await fn();
    } finally {
      if (real === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = real;
    }
  };
}

test("batch_skipped 聚合消息渲染中性灰：tool-skipped-neutral + 「·」标记，不加 fail 红色系", withLocalStorage(async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { ctx } = makeHarness();
  const renderer = createThreadRenderer(ctx);
  const node = renderer.renderChatMessage({
    id: "skp1", role: "tool", tool: "batch_skipped", ok: false,
    result_summary: "3 个后续操作已跳过（待前序确认）：list_chapters, read_chapter, get_status"
  });
  assert.ok(node, "应渲染工具行");
  const row = node.querySelector(".tool-inline-row");
  assert.ok(row, "应有 tool-inline-row");
  assert.ok(row.classList.contains("tool-skipped-neutral"), "SKIPPED 行应带 tool-skipped-neutral");
  assert.ok(!row.classList.contains("fail"), "SKIPPED 行不得带 fail（红色系）");
  const mark = row.querySelector(".tool-inline-mark");
  assert.equal(mark.textContent, "·", "SKIPPED 标记应为中性「·」而非红色 ✗");
  assert.ok(!mark.classList.contains("fail"), "SKIPPED 标记不得带 fail 类");
  assert.ok(mark.classList.contains("skipped"), "SKIPPED 标记应带 skipped 状态类");
  const label = row.querySelector(".tool-inline-label");
  assert.ok(label.textContent.includes("3 个操作已跳过"), "聚合行标签展示「N 个操作已跳过」");
}));

test("旧式逐条 SKIPPED 消息（summary 以 SKIPPED 开头）同样渲染中性灰", withLocalStorage(async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { ctx } = makeHarness();
  const renderer = createThreadRenderer(ctx);
  const node = renderer.renderChatMessage({
    id: "skp2", role: "tool", tool: "list_chapters", ok: false,
    result_summary: "SKIPPED: 前序操作已落待确认，此工具不执行。"
  });
  const row = node.querySelector(".tool-inline-row");
  assert.ok(row.classList.contains("tool-skipped-neutral"), "旧式 SKIPPED 行也应带 tool-skipped-neutral");
  assert.ok(!row.classList.contains("fail"), "旧式 SKIPPED 行不得带 fail 类");
  assert.equal(row.querySelector(".tool-inline-mark").textContent, "·", "旧式 SKIPPED 标记为「·」");
}));

test("非 SKIPPED 的失败工具消息保持红色系（fail + ✗，不受降级影响）", withLocalStorage(async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { ctx } = makeHarness();
  const renderer = createThreadRenderer(ctx);
  const node = renderer.renderChatMessage({
    id: "fail1", role: "tool", tool: "edit_chapter", ok: false,
    error: "run_busy", result_summary: "写作任务进行中"
  });
  const row = node.querySelector(".tool-inline-row");
  assert.ok(row.classList.contains("fail"), "真失败仍应带 fail 类");
  assert.ok(!row.classList.contains("tool-skipped-neutral"), "真失败不得误标中性灰");
  assert.equal(row.querySelector(".tool-inline-mark").textContent, "✗", "真失败标记仍为 ✗");
}));

// ---------------------------------------------------------------------------
// Task 7: 中断横幅降级 + 步骤中文说明（spec §2.3-U1/U3/U6）。
// U1：中断横幅从红色虚线框降级为中性灰细条（不带 err/红色系），
//     文案「上一轮被中断」改「上次对话未完成，可继续」。
// U3：工具结果行旁有中文说明（toolLabel 翻译，read_blueprint/update_blueprint 不落回退）。
// 横幅经 syncChatThread 触发（最后一条消息是 status:"generating" 占位）。
// ---------------------------------------------------------------------------

function renderInterruptedBanner(renderer, refs) {
  renderer.syncChatThread({
    messages: [
      { id: "u1", role: "user", content: "继续写第 5 章", ts: "2026-08-03T10:00:00.000Z" },
      { id: "a1", role: "assistant", status: "generating", ts: "2026-08-03T10:00:01.000Z" },
    ],
  });
  return refs.thread.querySelector(".chat-interrupted-card");
}

test("中断横幅降级：chat-interrupted-card 带 neutral class，不带 err/fail 红色系", withLocalStorage(async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx } = makeHarness();
  const renderer = createThreadRenderer(ctx);
  const card = renderInterruptedBanner(renderer, refs);
  assert.ok(card, "应渲染中断横幅");
  assert.ok(card.classList.contains("neutral"), "中断横幅应带 neutral 中性灰标记 class");
  assert.ok(!card.classList.contains("err"), "中断横幅不得带 err（红色系）class");
  assert.ok(!card.classList.contains("fail"), "中断横幅不得带 fail class");
}));

test("中断横幅文案改为「上次对话未完成，可继续」（U2 术语）", withLocalStorage(async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx } = makeHarness();
  const renderer = createThreadRenderer(ctx);
  const card = renderInterruptedBanner(renderer, refs);
  assert.ok(card, "应渲染中断横幅");
  assert.ok(card.textContent.includes("上次对话未完成"), "应展示「上次对话未完成」新文案");
  assert.ok(card.textContent.includes("可继续"), "应含「可继续」");
  assert.ok(!card.textContent.includes("上一轮被中断"), "不得再出现旧文案「上一轮被中断」");
}));

test("步骤中文说明：read_blueprint 显示「读取蓝图」而非回退「工具 read_blueprint」", withLocalStorage(async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { ctx } = makeHarness();
  const renderer = createThreadRenderer(ctx);
  const node = renderer.renderChatMessage({
    id: "t1", role: "tool", tool: "read_blueprint", ok: true,
    result_summary: "OUTLINE.md/SETTING.md 已读取",
  });
  const row = node.querySelector(".tool-inline-row");
  assert.ok(row, "应有工具行");
  const label = row.querySelector(".tool-inline-label");
  assert.ok(label.textContent.includes("读取蓝图"), "read_blueprint 行应显示中文「读取蓝图」");
  assert.ok(!label.textContent.includes("工具 read_blueprint"), "不得回退成「工具 read_blueprint」");
  assert.equal(row.querySelector(".tool-inline-mark").textContent, "✓", "成功标记为 ✓");
}));

test("步骤中文说明：update_blueprint 显示「更新蓝图」", withLocalStorage(async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { ctx } = makeHarness();
  const renderer = createThreadRenderer(ctx);
  const node = renderer.renderChatMessage({
    id: "t2", role: "tool", tool: "update_blueprint", ok: true,
    args: '{"file":"outline","mode":"extend"}',
    result_summary: "蓝图已追加",
  });
  const label = node.querySelector(".tool-inline-label");
  assert.ok(label.textContent.includes("更新蓝图"), "update_blueprint 行应显示中文「更新蓝图」");
  assert.ok(!label.textContent.includes("工具 update_blueprint"), "不得回退成「工具 update_blueprint」");
}));

test("空态建议卡：blueprint none 也发送普通聊天指令", withLocalStorage(async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx } = makeHarness();
  const submitted = [];
  ctx.submitText = (text) => { submitted.push(text); };
  const renderer = createThreadRenderer(ctx);

  renderer.appendSuggestionCards({
    project: {}, summary: { completedChapters: 0, targetChapters: 10 }, chapters: [],
    state: { blueprint_status: "none" },
  });

  const cards = refs.thread.querySelectorAll(".suggestion-card");
  assert.ok(cards.length >= 1, "应有建议卡");
  const initCard = cards.find((c) => c.textContent.includes("检查项目结构"));
  assert.ok(initCard, "blueprint none 时应出现普通 /init 建议卡");
  initCard._fire("click");
  assert.deepEqual(submitted, ["/init"]);
}));

// ---------------------------------------------------------------------------
// Task 9: 确认卡改造 —— 普通确认 3 按钮（once/task/reject）+ 极端确认 force 解锁
// ---------------------------------------------------------------------------

function normalPending(overrides = {}) {
  return {
    id: "pa-1",
    created_at: "2026-08-05T10:00:00.000Z",
    status: "pending",
    tool: "shell",
    args: { command: "npm test", purpose: "运行测试" },
    description: "运行项目测试以确认改动无回归",
    action: {
      category: "process", scope: "project", risk: "normal",
      title: "运行命令", description: "运行项目测试以确认改动无回归",
      command: "npm test", cwd: "D:\\Book", targets: ["D:\\Book"], preview: null,
    },
    command: "npm test",
    cwd: "D:\\Book",
    targets: ["D:\\Book"],
    preview: null,
    confirmation_kind: "normal",
    confirmation_text: null,
    ...overrides,
  };
}

function stubFetch() {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: JSON.parse(options.body ?? "{}") });
    return { ok: true, text: async () => JSON.stringify({ ok: true }) };
  };
  return calls;
}

function tick() { return new Promise((resolve) => setTimeout(resolve, 0)); }

test("普通确认卡：3 按钮 once/task/reject，各自发 decision 契约；点击后整卡按钮禁用", async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx } = makeHarness();
  const renderer = createThreadRenderer(ctx);
  const calls = stubFetch();
  try {
    renderer.syncChatThread({
      messages: [],
      pendingAction: normalPending({
        id: "pa-1",
        targets: ["D:\\Book\\tmp\\a.txt", "D:\\Book\\tmp\\b.txt"],
        action: {
          ...normalPending().action,
          targets: ["D:\\Book\\tmp\\a.txt", "D:\\Book\\tmp\\b.txt"],
        },
      }),
    });
    const card = refs.thread.querySelector('[data-pending-id="pa-1"]');
    assert.ok(card, "普通确认卡应渲染 .chat-confirm-card");
    assert.match(card.textContent, /待确认：运行命令/, "shell 标题走 tool-labels 人话");
    assert.match(card.textContent, /运行项目测试以确认改动无回归/, "description 应展示");
    assert.match(card.textContent, /npm test/, "命令应展示");
    assert.match(card.textContent, /D:\\Book/, "目录应展示");
    assert.match(card.textContent, /tmp\\a\.txt/, "删除目标应完整展示");
    const buttons = card.querySelectorAll("button");
    assert.equal(buttons.length, 3, "普通确认恰好 3 个按钮");
    assert.deepEqual(
      buttons.map((b) => b.textContent),
      ["仅允许这一次", "本次任务允许同类操作", "拒绝"],
      "按钮文案：仅本次 / 本次任务同类 / 拒绝"
    );
    // once 决策在独立卡上验证（M-7：mock 的 _fire 尊重 disabled，点过 once 后
    // 同卡 task/reject 在真实浏览器中不可达，须用新卡分别验证映射）。
    card.querySelector('[data-testid="chat-confirm-once"]')._fire("click");
    await tick();
    assert.deepEqual(calls[0].body, { decision: "once", confirmationText: "", projectRoot: "D:\\novel-a" });
    assert.ok(card.classList.contains("chat-confirm-card--resolved"), "once 后卡片 resolved");
    for (const b of card.querySelectorAll("button")) {
      assert.equal(b.disabled, true, "once 后全部按钮禁用");
    }
    // task / reject：各自在独立新卡上验证 decision 映射。
    renderer.syncChatThread({ messages: [], pendingAction: normalPending({ id: "pa-2", created_at: "2026-08-05T10:00:01.000Z" }) });
    const card2 = refs.thread.querySelector('[data-pending-id="pa-2"]');
    assert.ok(card2, "新 pending 渲染第二张卡");
    card2.querySelector('[data-testid="chat-confirm-task"]')._fire("click");
    await tick();
    assert.equal(calls[1].body.decision, "task", "task 按钮发 decision=task");
    renderer.syncChatThread({ messages: [], pendingAction: normalPending({ id: "pa-3", created_at: "2026-08-05T10:00:02.000Z" }) });
    const card3 = refs.thread.querySelector('[data-pending-id="pa-3"]');
    assert.ok(card3, "新 pending 渲染第三张卡");
    card3.querySelector('[data-testid="chat-confirm-reject"]')._fire("click");
    await tick();
    assert.equal(calls[2].body.decision, "reject", "reject 按钮发 decision=reject");
    assert.ok(card3.classList.contains("chat-confirm-card--rejected"), "reject 后卡片 rejected");
  } finally {
    delete globalThis.fetch;
  }
});

test("I-1 确认卡 supersede：新 pending(id 变化)后旧卡加 superseded 类、按钮禁用、点击不发请求", async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx } = makeHarness();
  const renderer = createThreadRenderer(ctx);
  const calls = stubFetch();
  try {
    renderer.syncChatThread({ messages: [], pendingAction: normalPending({ id: "pa-A" }) });
    const cardA = refs.thread.querySelector('[data-pending-id="pa-A"]');
    assert.ok(cardA, "pending A 渲染确认卡");
    assert.ok(!cardA.classList.contains("chat-confirm-card--superseded"), "当前 pending 卡不带 superseded");
    const onceA = cardA.querySelector('[data-testid="chat-confirm-once"]');
    assert.equal(onceA.disabled, false, "A 卡按钮初始可点");

    renderer.syncChatThread({ messages: [], pendingAction: normalPending({ id: "pa-B", created_at: "2026-08-05T10:00:01.000Z" }) });
    const cardB = refs.thread.querySelector('[data-pending-id="pa-B"]');
    assert.ok(cardB, "pending B 渲染新卡");
    assert.ok(cardA.classList.contains("chat-confirm-card--superseded"), "旧卡 A 标记 superseded");
    assert.equal(onceA.disabled, true, "旧卡按钮禁用");
    onceA._fire("click");
    await tick();
    assert.equal(calls.length, 0, "旧卡点击不再发请求（disabled 不派发 + 守卫）");
    assert.ok(!cardB.classList.contains("chat-confirm-card--superseded"), "新卡 B 不带 superseded");
    assert.equal(cardB.querySelector('[data-testid="chat-confirm-once"]').disabled, false, "新卡按钮可点");
  } finally {
    delete globalThis.fetch;
  }
});

test("I-1 确认卡 supersede：pending 回到已渲染 id 时未定论旧卡恢复可交互", async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx } = makeHarness();
  const renderer = createThreadRenderer(ctx);
  const calls = stubFetch();
  try {
    renderer.syncChatThread({ messages: [], pendingAction: normalPending({ id: "pa-A" }) });
    const cardA = refs.thread.querySelector('[data-pending-id="pa-A"]');
    renderer.syncChatThread({ messages: [], pendingAction: normalPending({ id: "pa-B", created_at: "2026-08-05T10:00:01.000Z" }) });
    assert.ok(cardA.classList.contains("chat-confirm-card--superseded"), "A 卡已被 B 追赶");
    // pending 重置回 A（同 id，renderedKeys 已有指纹，不新建卡，恢复旧卡）。
    renderer.syncChatThread({ messages: [], pendingAction: normalPending({ id: "pa-A" }) });
    assert.ok(!cardA.classList.contains("chat-confirm-card--superseded"), "pending 回到 A 后旧卡恢复");
    assert.equal(cardA.querySelector('[data-testid="chat-confirm-once"]').disabled, false, "按钮恢复可点");
    const cardB = refs.thread.querySelector('[data-pending-id="pa-B"]');
    assert.ok(cardB.classList.contains("chat-confirm-card--superseded"), "B 卡被反向追赶标记 superseded");
    cardA.querySelector('[data-testid="chat-confirm-once"]')._fire("click");
    await tick();
    assert.equal(calls[0].body.decision, "once", "恢复后的 A 卡可正常提交决策");
  } finally {
    delete globalThis.fetch;
  }
});

test("I-1 确认卡 supersede：pending 清空后旧卡 superseded、按钮禁用", async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx } = makeHarness();
  const renderer = createThreadRenderer(ctx);
  const calls = stubFetch();
  try {
    renderer.syncChatThread({ messages: [], pendingAction: normalPending({ id: "pa-A" }) });
    const cardA = refs.thread.querySelector('[data-pending-id="pa-A"]');
    // 决策被消费/超时：后续轮询不带 pendingAction。
    renderer.syncChatThread({ messages: [] });
    assert.ok(cardA.classList.contains("chat-confirm-card--superseded"), "pending 清空后旧卡 superseded");
    cardA.querySelector('[data-testid="chat-confirm-task"]')._fire("click");
    await tick();
    assert.equal(calls.length, 0, "pending 已清空时旧卡点击不发请求");
  } finally {
    delete globalThis.fetch;
  }
});

test("极端危险确认卡：独立红色结构 + force 需输入确认文字（trim 完全匹配）解锁", async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx } = makeHarness();
  const renderer = createThreadRenderer(ctx);
  const calls = stubFetch();
  try {
    renderer.syncChatThread({
      messages: [],
      pendingAction: normalPending({
        id: "pa-x1",
        command: "rm -rf /",
        cwd: "C:\\",
        targets: ["C:\\"],
        description: "清空系统盘根目录",
        action: { ...normalPending().action, command: "rm -rf /", cwd: "C:\\", targets: ["C:\\"] },
        confirmation_kind: "extreme",
        confirmation_text: "强制继续 3FA9C2",
      }),
    });
    const card = refs.thread.querySelector('[data-pending-id="pa-x1"]');
    assert.ok(card, "极端确认应渲染独立 .chat-danger-confirm");
    assert.match(card.textContent, /极端危险操作/, "标题");
    assert.match(card.textContent, /可能破坏磁盘、系统或大范围用户数据，且无法自动恢复/, "明确后果区");
    assert.match(card.textContent, /rm -rf \//, "后果区展示命令");
    assert.match(card.textContent, /C:\\/, "后果区展示目标");
    const force = card.querySelector('[data-testid="chat-danger-force"]');
    assert.ok(force, "应有强制继续按钮");
    assert.equal(force.disabled, true, "初始 disabled");
    const input = card.querySelector(".chat-danger-input");
    assert.equal(input.placeholder, "强制继续 3FA9C2", "placeholder 展示确认文字");
    assert.equal(input.getAttribute("aria-label"), "输入页面显示的确认文字以解锁强制继续", "M-3 输入框有 aria-label");
    input.value = "强制继续 WRONG";
    input._fire("input");
    assert.equal(force.disabled, true, "文字不匹配仍 disabled");
    input.value = "  强制继续 3FA9C2  ";
    input._fire("input");
    assert.equal(force.disabled, false, "trim 后完全匹配解锁");
    force._fire("click");
    await tick();
    assert.equal(calls[0].body.decision, "force", "force 发 decision=force");
    assert.equal(calls[0].body.confirmationText, "强制继续 3FA9C2", "confirmationText 原样带回（trim 后）");
    assert.equal(calls[0].body.projectRoot, "D:\\novel-a");
    // reject 逃生门：force 已点过的卡按钮禁用（M-7 真实语义），在独立新极端卡上验证。
    renderer.syncChatThread({
      messages: [],
      pendingAction: normalPending({
        id: "pa-x2",
        created_at: "2026-08-05T10:00:01.000Z",
        command: "rm -rf /",
        cwd: "C:\\",
        targets: ["C:\\"],
        action: { ...normalPending().action, command: "rm -rf /", cwd: "C:\\", targets: ["C:\\"] },
        confirmation_kind: "extreme",
        confirmation_text: "强制继续 3FA9C2",
      }),
    });
    const card2 = refs.thread.querySelector('[data-pending-id="pa-x2"]');
    card2.querySelector('[data-testid="chat-confirm-reject"]')._fire("click");
    await tick();
    assert.equal(calls[1].body.decision, "reject", "极端卡提供拒绝逃生门");
  } finally {
    delete globalThis.fetch;
  }
});

test("M-4 极端确认卡：confirmation_text 为空时 force 永不解锁", async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx } = makeHarness();
  const renderer = createThreadRenderer(ctx);
  renderer.syncChatThread({
    messages: [],
    pendingAction: normalPending({
      id: "pa-empty",
      confirmation_kind: "extreme",
      confirmation_text: "",
      command: "dd if=/dev/zero of=/dev/sda",
    }),
  });
  const card = refs.thread.querySelector('[data-pending-id="pa-empty"]');
  const force = card.querySelector('[data-testid="chat-danger-force"]');
  const input = card.querySelector(".chat-danger-input");
  assert.equal(force.disabled, true, "初始 disabled");
  input.value = "";
  input._fire("input");
  assert.equal(force.disabled, true, "expected 为空时空输入也不解锁");
  input.value = "任意文字";
  input._fire("input");
  assert.equal(force.disabled, true, "expected 为空时任何输入都不解锁");
});

test("Task 9 活动流：chat_activity 经 onChatActivity 渲染，线程重建后 reset 可再渲染", async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx } = makeHarness();
  const renderer = createThreadRenderer(ctx);
  renderer.onChatActivity({
    type: "chat_activity", turn_id: "t1", activity_id: "a1", phase: "command",
    state: "running", label: "运行测试", output_delta: "one\n",
  });
  assert.equal(refs.thread.querySelectorAll('[data-activity-id="a1"]').length, 1);
  assert.ok(refs.thread.querySelector(".chat-activity-stream"), "活动流容器应挂在线程内");
  renderer.onChatActivity({
    type: "chat_activity", turn_id: "t1", activity_id: "a1", phase: "command",
    state: "succeeded", label: "测试完成", exit_code: 0,
  });
  assert.equal(refs.thread.querySelectorAll('[data-activity-id="a1"]').length, 1, "同 id 不重复建行");
  renderer.resetChatActivity();
  assert.equal(refs.thread.querySelectorAll(".chat-activity-item").length, 0, "reset 后行清空");
  renderer.onChatActivity({
    type: "chat_activity", turn_id: "t1", activity_id: "a2", phase: "tool",
    state: "running", label: "读取章节",
  });
  assert.equal(refs.thread.querySelectorAll('[data-activity-id="a2"]').length, 1, "reset 后重建容器并可继续渲染");
});

test("I-3 活动流滚动：onChatActivity 近底部才滚，远离底部不打断回看", async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx } = makeHarness();
  const renderer = createThreadRenderer(ctx);
  const wrap = refs.threadWrap;
  wrap.scrollHeight = 1000;
  wrap.clientHeight = 100;
  wrap.scrollTop = 990; // 距底 10px < 80：应滚动到底
  renderer.onChatActivity({
    type: "chat_activity", turn_id: "t1", activity_id: "a1", phase: "command",
    state: "running", label: "运行测试",
  });
  assert.equal(wrap.scrollTop, 1000, "近底部时滚动到底");
  wrap.scrollTop = 400; // 距底 500px ≥ 80：不得滚动
  renderer.onChatActivity({
    type: "chat_activity", turn_id: "t1", activity_id: "a2", phase: "command",
    state: "running", label: "另一条",
  });
  assert.equal(wrap.scrollTop, 400, "远离底部时不无条件滚动（stick 策略）");
});

test("M-6 活动流锚定：syncChatThread 后 .chat-activity-stream 重新锚定到线程末尾", async () => {
  const { createThreadRenderer } = await import("../../src/app-shell/thread-renderer.js");
  const { refs, ctx } = makeHarness();
  const renderer = createThreadRenderer(ctx);
  renderer.onChatActivity({
    type: "chat_activity", turn_id: "t1", activity_id: "a1", phase: "command",
    state: "running", label: "运行测试",
  });
  const before = refs.thread.children;
  assert.ok(before[before.length - 1].classList.contains("chat-activity-stream"), "活动流初始在线程末尾");
  // 新消息与确认卡经 insertByTs 插入（容器无 data-ts，会落在容器之后），
  // syncChatThread 收尾应把容器重新锚定回末尾，保持 消息 → 确认卡 → 活动流。
  renderer.syncChatThread({
    messages: [{ id: "u1", role: "user", content: "继续", ts: "2026-08-05T10:00:00.000Z" }],
    pendingAction: normalPending({ id: "pa-1", created_at: "2026-08-05T10:00:01.000Z" }),
  });
  const after = refs.thread.children;
  const streamIdx = after.findIndex((c) => c.classList.contains("chat-activity-stream"));
  const msgIdx = after.findIndex((c) => c.classList.contains("chat-bubble-wrap--user"));
  const confirmIdx = after.findIndex((c) => c.classList.contains("chat-bubble-wrap--confirm"));
  assert.ok(streamIdx >= 0, "活动流容器仍在线程内");
  assert.ok(after[after.length - 1].classList.contains("chat-activity-stream"), "syncChatThread 后活动流回到末尾");
  assert.ok(msgIdx >= 0 && confirmIdx >= 0, "消息与确认卡均已渲染");
  assert.ok(msgIdx < streamIdx && confirmIdx < streamIdx, "消息与确认卡位于活动流之前");
  assert.equal(refs.thread.querySelectorAll(".chat-activity-stream").length, 1, "重锚定不复制容器");
});
