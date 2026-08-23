// Task 15（第十五轮）：view/timeline.mjs 分区契约测试。
//
// 覆盖：
//   - F17：timelineSeqs 索引随节点移除同步收缩（removeNode 收口）——消息事件
//     注入 + removeFailedBubble/通知行移除/流式终止/重置路径；
//   - seam 薄测：syncMessages 修订号早退与 event_key 去重、syncStream 裁剪路径、
//     syncGaps 去重插入、syncCompactionRows 行形状与移除/重锚、历史缺口提示
//     生命周期、maybeLoadEarlier 触发条件与防重入。
// 全部直接构造 createTimelineView(ctx)（不经 view.js 壳），ctx 模拟壳的共享状态。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTimelineView } from "../../src/app-shell/agent/view/timeline.mjs";

// ---------------------------------------------------------------------------
// 最小 DOM mock（与 agent-surface.test.mjs 同风格，裁剪到时间线分区所需）
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
    this.dataset = {};
    this.children = [];
    this.isConnected = false;
    this._text = "";
    this._html = "";
    this._attrs = {};
    this._listeners = new Map();
    this._parent = null;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    const classSet = new Set();
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
      toString: () => [...classSet].join(" "),
    };
  }

  get textContent() {
    return this._text +
      (this._html ? this._html.replace(/<[^>]*>/g, "") : "") +
      this.children
        .map((c) => (typeof c.textContent === "string" ? c.textContent : ""))
        .join("");
  }
  set textContent(value) {
    this._text = String(value);
    this._html = "";
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
      if (node instanceof MockElement) node.remove();
      node._parent = this;
      this.children.push(node);
    }
  }
  insertBefore(node, refNode) {
    if (node instanceof MockElement) node.remove();
    let index = refNode == null ? this.children.length : this.children.indexOf(refNode);
    if (index < 0) index = this.children.length;
    this.children.splice(index, 0, node);
    node._parent = this;
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
    const dataSel = selector.match(/^\[data-([\w-]+)="?([^"\]]*)"?\]$/);
    if (dataSel) {
      const key = MockElement._dataKey(dataSel[1]);
      return String(this.dataset[key] ?? "") === dataSel[2];
    }
    const presenceSel = selector.match(/^\[data-([\w-]+)\]$/);
    if (presenceSel) {
      const key = MockElement._dataKey(presenceSel[1]);
      return this.dataset[key] !== undefined && this.dataset[key] !== "";
    }
    return false;
  }
  static _dataKey(name) {
    return name.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
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
// 夹具：按壳的接线方式构造 ctx（共享引用 + 活绑定 getter）
// ---------------------------------------------------------------------------

function makeTimeline({ scheduleFrame = (cb) => cb() } = {}) {
  const doc = {
    createElement: (tag) => new MockElement(tag),
    createTextNode: (text) => new TextNode(text)
  };
  const messages = new MockElement("div");
  const conv = new MockElement("div");
  const timelineSeqs = new Map();
  const messageNodes = new Map();
  const pendingSubmissions = [];
  const failedSubmissions = [];
  const compactionRowNodes = new Map();
  const rendered = {
    messages: -1, run: -1, queue: -1, decisions: -1, errors: -1,
    runId: null, runStatus: null, context: -1, notices: -1
  };
  const shared = { currentState: null, actions: {}, viewGeneration: 0, followLatest: true };
  const ctx = {
    doc,
    messages,
    conv,
    scheduleFrame,
    showToast: () => {},
    timelineSeqs,
    messageNodes,
    pendingSubmissions,
    failedSubmissions,
    compactionRowNodes,
    rendered,
    get currentState() { return shared.currentState; },
    get actions() { return shared.actions; },
    get viewGeneration() { return shared.viewGeneration; },
    get followLatest() { return shared.followLatest; }
  };
  return { timeline: createTimelineView(ctx), ctx, shared, messages, conv, timelineSeqs, messageNodes, pendingSubmissions, failedSubmissions };
}

test("F17：移除路径清空 timelineSeqs 索引（removeNode 收口）", () => {
  const { timeline, timelineSeqs, messages, failedSubmissions, messageNodes } = makeTimeline();

  // 注入 3 条消息事件（2 user + 1 assistant）→ 全部入 seq 索引。
  timeline.syncMessages({
    conversation: [
      { role: "user", text: "甲", seq: 1, event_key: "e1" },
      { role: "user", text: "乙", seq: 2, event_key: "e2" },
      { role: "assistant", text: "丙", seq: 3, event_key: "e3" }
    ],
    revisions: { messages: 1 }
  });
  assert.equal(timelineSeqs.size, 3, "3 条消息事件全部入 seq 索引");
  assert.equal(messages.children.length, 3);

  // removeFailedBubble 触发路径：失败气泡由壳直接 append（不入 seq 索引），
  // 移除后索引不得误删、节点必须摘除（removeNode 对未入索引节点幂等）。
  const failedNode = new MockElement("div");
  messages.append(failedNode);
  failedSubmissions.push({ text: "乙", node: failedNode });
  timeline.removeFailedBubble("乙");
  assert.equal(timelineSeqs.size, 3, "不在索引中的失败气泡移除不误删索引");
  assert.equal(messages.children.length, 3, "失败气泡已摘除");

  // 时间线节点移除路径（syncNotices 通知行同款：insertTimeline 入索引 →
  // removeNode 摘除并清索引；修复前该路径只 remove() 不 delete——索引泄漏）。
  const notice = timeline.createMessageBubble("assistant", "通知", { markdown: true });
  timeline.insertTimeline(notice, 9, "notice:1");
  assert.equal(timelineSeqs.size, 4, "通知行节点入索引");
  assert.equal(messageNodes.has("notice:1"), true, "带 eventKey 节点登记键映射");
  timeline.removeNode(notice);
  assert.equal(timelineSeqs.size, 3, "移除路径同步清空索引（F17 核心断言）");
  assert.equal(messageNodes.has("notice:1"), false, "移除路径同步清除键映射（removeNode 收口）");

  // 流式终止路径（syncStream 裁剪）：流式气泡不入 seq 索引（直接 append），
  // 终止移除后索引不变——防御性 delete 空操作，不误伤、不泄漏。
  timeline.syncStream({ assistantStream: { text: "流式" } });
  assert.equal(timelineSeqs.size, 3, "流式气泡不占 seq 索引");
  timeline.syncStream({ assistantStream: { text: "" } });
  assert.equal(timelineSeqs.size, 3, "流式终止后索引不变");
  assert.equal(messages.children.length, 3, "流式气泡已摘除");

  // reset：整体清空，索引归零。
  timeline.reset();
  assert.equal(timelineSeqs.size, 0, "reset 清空索引");
  assert.equal(messages.children.length, 0, "reset 清空消息容器");
});

test("seam：syncMessages 修订号早退与 event_key 去重（增量 reconcile 契约不变）", () => {
  const { timeline, messages } = makeTimeline();
  const entry = [{ role: "user", text: "甲", seq: 1, event_key: "e1" }];
  timeline.syncMessages({ conversation: entry, revisions: { messages: 5 } });
  assert.equal(messages.children.length, 1, "首次渲染 1 条");

  timeline.syncMessages({ conversation: entry, revisions: { messages: 5 } });
  assert.equal(messages.children.length, 1, "同修订号早退，不重复插入");

  // 真·修订号早退：同修订号但内容/event_key 变了（新消息），早退仍拦截——
  // 与 event_key 去重区分开：若早退失效，这里会插入第 2 条。
  timeline.syncMessages({
    conversation: [{ role: "user", text: "新消息", seq: 2, event_key: "e2" }],
    revisions: { messages: 5 }
  });
  assert.equal(messages.children.length, 1, "同修订号下新 event_key 亦不插入（修订号早退拦截）");

  timeline.syncMessages({ conversation: entry, revisions: { messages: 6 } });
  assert.equal(messages.children.length, 1, "修订号前进但 event_key 相同：稳定 key 去重");
});

test("seam：syncStream 裁剪路径与 seq 索引一致（F17 收口范围）", () => {
  const { timeline, timelineSeqs, messages, shared } = makeTimeline();
  shared.currentState = { assistantStream: { text: "流式正文" } };
  timeline.syncStream(shared.currentState);
  assert.equal(messages.children.length, 1, "流式气泡已创建");
  assert.equal(timelineSeqs.size, 0, "流式气泡不占 seq 索引");

  timeline.syncStream(shared.currentState);
  assert.equal(messages.children.length, 1, "同文本早退不重建");

  shared.currentState = { assistantStream: { text: "" } };
  timeline.syncStream(shared.currentState);
  assert.equal(messages.children.length, 0, "终态/切换立即移除流式气泡");
  assert.equal(timelineSeqs.size, 0, "移除后索引不变");
});

test("seam：syncGaps 按 event_key 去重插入 gap 节点", () => {
  const { timeline, timelineSeqs, messages } = makeTimeline();
  const state = (gaps) => ({ historyGaps: gaps });
  const gaps = [
    { event_key: "gap:1", start_seq: 10 },
    { event_key: "gap:2", start_seq: 20 }
  ];
  timeline.syncGaps(state(gaps));
  assert.equal(messages.children.length, 2, "2 条 gap 插入");
  assert.equal(timelineSeqs.size, 2, "gap 节点入 seq 索引");
  assert.equal(messages.children[0].dataset.testid, "agent-history-gap");

  timeline.syncGaps(state(gaps));
  assert.equal(messages.children.length, 2, "同 event_key 不重复插入");

  timeline.syncGaps(state([...gaps, { event_key: "gap:3", start_seq: 30 }]));
  assert.equal(messages.children.length, 3, "增量新增 1 条");
});

test("seam：syncCompactionRows 行形状与移除/重锚路径同步索引", () => {
  const { timeline, timelineSeqs, messages } = makeTimeline();
  const mkState = (rows) => ({ compactionRows: new Map(rows.map((r) => [r.compaction_id, r])) });
  const rows = [
    { compaction_id: "c1", state: "running", seq: 40, event_key: "ck1" },
    { compaction_id: "c2", state: "completed", seq: 41, event_key: "ck2" }
  ];
  timeline.syncCompactionRows(mkState(rows));
  assert.equal(messages.children.length, 2, "2 行压缩状态行插入");
  assert.equal(timelineSeqs.size, 2, "压缩行入 seq 索引");
  assert.equal(messages.children[0].className, "agent-compaction");
  assert.ok(messages.children[0].querySelector('[data-testid="agent-compaction-row"]'), "行结构 testid");
  assert.match(messages.children[0].textContent, /压缩进行中/u, "running 文案");
  assert.equal(messages.children[0].dataset.state, "running");

  // state 层移除的行：同步摘除 DOM 与索引。
  timeline.syncCompactionRows(mkState(rows.slice(0, 1)));
  assert.equal(messages.children.length, 1, "state 层移除的行同步摘除");
  assert.equal(timelineSeqs.size, 1, "索引同步收缩");

  // 重建后锚点前移（seq 变化）：重插路径索引不重复/不泄漏。
  timeline.syncCompactionRows(mkState([{ compaction_id: "c1", state: "running", seq: 39, event_key: "ck1" }]));
  assert.equal(messages.children.length, 1, "重插后仍 1 行");
  assert.equal(timelineSeqs.size, 1, "重插后索引仍 1 条");
  assert.equal(messages.children[0].dataset.seq, "39", "新锚点已生效");
});

test("seam：历史缺口提示 show→clear 与 seq 索引同生命周期", () => {
  const { timeline, timelineSeqs, messages } = makeTimeline();
  timeline.showHistoryLoadError(100);
  assert.equal(messages.children.length, 1);
  assert.equal(messages.children[0].dataset.testid, "agent-history-gap-error", "错误提示节点形状");
  assert.equal(timelineSeqs.size, 1, "错误提示节点入索引");

  timeline.clearHistoryLoadError();
  assert.equal(messages.children.length, 0, "清除后节点摘除");
  assert.equal(timelineSeqs.size, 0, "清除后索引归零");
});

test("seam：maybeLoadEarlier 触发条件与防重入（setLoadingEarlier 接口）", () => {
  const { timeline, shared, conv } = makeTimeline();
  const calls = [];
  shared.currentState = { hasEarlier: true, minSeq: 50 };
  shared.actions = { loadEarlier: (seq) => calls.push(seq) };
  conv.scrollTop = 10; // ≤240 触发区
  timeline.maybeLoadEarlier();
  assert.deepEqual(calls, [50], "距顶 ≤240 且有更早历史时触发 loadEarlier");

  timeline.maybeLoadEarlier();
  assert.deepEqual(calls, [50], "loadingEarlier 防重入（index.js 恢复前不重复触发）");

  timeline.setLoadingEarlier(false);
  timeline.maybeLoadEarlier();
  assert.deepEqual(calls, [50, 50], "setLoadingEarlier(false) 恢复后再次触发");

  conv.scrollTop = 500;
  timeline.maybeLoadEarlier();
  assert.deepEqual(calls, [50, 50], "距顶 >240 不触发");
});
