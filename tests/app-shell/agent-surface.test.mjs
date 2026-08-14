// Task 8: AgentSurface 契约测试（无旧 renderer，纯新 surface）。
//
// 覆盖（Task 8 Step 6 + 从 chat-activity-view.test.mjs 迁移的全部仍然有效断言）：
//   - 空闲发送 / 运行中排队发送 / 立即 / 同一 run id / 停止 / 重试 / 项目切换；
//   - /settings、/model 无 Run 时导航；/init、/review、/write 作为普通文本提交；
//   - 工具：同 activity_id 合并到同一工作项、整行点击展开详情（R1，div +
//     角色按钮，去 details/summary）、字段顺序、64 KiB 输出尾 +
//     「输出过长已截断」；
//   - 停止防连点（点击即禁用、失败恢复、终态后不再有第二个横幅）；
//   - 计划：活动展开/终态折叠、无手动编辑入口；
//   - 确认：普通三选、extreme 精确文字前禁用、终态 decision 锁定；
//   - reasoning 不进入 Assistant 正文，但进入 reasoning 工作项；思考标签可见；
//   - 滚动锁：显式 follow 状态（距底部 ≤48px 跟随）、上滚后保持 scrollTop +
//     「回到最新」按钮、点击恢复 follow；重建后不打断阅读更早内容；
//   - 模型菜单视口钳制与内容列 CSS 基线（agent.css 断言）。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildModelPickerOptions, handleDashboardMigrationNotice } from "../../src/app-shell/settings-connection.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 最小 DOM mock（无 JSDOM）——沿用 chat-activity-view.test.mjs 风格，
// 增加 textarea value 与滚动容器 scrollTop/scrollHeight/clientHeight。
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
    this._html = "";
    this._attrs = {};
    this._listeners = new Map();
    this._value = "";
    this._focusCount = 0;
    this._focused = false;
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

  get value() {
    return this._value;
  }
  set value(v) {
    this._value = String(v ?? "");
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
  get parentElement() {
    return this._parent;
  }
  contains(node) {
    if (node === this) return true;
    return this.children.some((child) => child instanceof MockElement && child.contains(node));
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
  focus() {
    this._focused = true;
    this._focusCount += 1;
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

before(() => {
  globalThis.document = {
    createElement: (tag) => new MockElement(tag),
    createElementNS: (_ns, tag) => new MockElement(tag),
    createTextNode: (text) => new TextNode(text),
    createDocumentFragment: () => new MockElement("fragment"),
    // Task 11：圆环/composer 的 doc 级 pointerdown/keydown 监听（外部关闭/ESC）。
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
});

after(() => {
  if (realDoc === undefined) delete globalThis.document;
  else globalThis.document = realDoc;
});

// ---------------------------------------------------------------------------
// 事件 / session 构造器
// ---------------------------------------------------------------------------

let seqCounter = 1000;

function ev(type, payload = {}, extra = {}) {
  seqCounter += 1;
  return {
    seq: seqCounter,
    event_id: `evt-${seqCounter}`,
    session_id: "sess-test",
    run_id: "run-1",
    type,
    payload,
    at: "2026-08-06T00:00:00.000Z",
    ...extra
  };
}

function session(overrides = {}) {
  return {
    schema_version: 1,
    session_id: "sess-test",
    project_root: "D:\\novel",
    status: "idle",
    active_run: null,
    queued_inputs: [],
    last_seq: 0,
    updated_at: "2026-08-06T00:00:00.000Z",
    ...overrides
  };
}

function activeRun(overrides = {}) {
  return {
    id: "run-1",
    status: "running",
    workflow: "general",
    active_input_id: "in-1",
    visible_plan: null,
    active_grants: [],
    started_at: "2026-08-06T00:00:00.000Z",
    ...overrides
  };
}

function toolStarted(activityId, name, args = {}, extra = {}) {
  return ev("tool_call_started", {
    tool_call_id: `tc-${activityId}`,
    activity_id: activityId,
    name,
    args,
    action: null
  }, extra);
}

function outputDelta(activityId, text) {
  return ev("tool_output_delta", {
    tool_call_id: `tc-${activityId}`,
    activity_id: activityId,
    name: "shell",
    stream: "stdout",
    text
  });
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitUntil(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitUntil 超时");
}

// ---------------------------------------------------------------------------
// 测试夹具：fake transport + 挂载 surface
// ---------------------------------------------------------------------------

function makeFakeApi(overrides = {}) {
  const calls = [];
  const api = {
    calls,
    openProject: async (root) => { calls.push(["openProject", root]); },
    submit: async (text) => { calls.push(["submit", text]); return { ok: true, status: "running" }; },
    requestPriority: async (inputId) => { calls.push(["requestPriority", inputId]); return { ok: true, priority_pending: true }; },
    withdrawInput: async (inputId) => {
      calls.push(["withdrawInput", inputId]);
      return { ok: true, withdrawn: true, draft_text: `撤回的 ${inputId}` };
    },
    stop: async (runId) => { calls.push(["stop", runId]); return { ok: true }; },
    retry: async (runId) => { calls.push(["retry", runId]); return { ok: true }; },
    decide: async (decisionId, choice) => { calls.push(["decide", decisionId, choice]); return { ok: true }; },
    retryCompaction: async (compactionId) => { calls.push(["retryCompaction", compactionId]); return { ok: true }; },
    cancelCompaction: async (compactionId) => { calls.push(["cancelCompaction", compactionId]); return { ok: true, status: "cancelled" }; },
    fetchSnapshot: async () => { calls.push(["fetchSnapshot"]); return null; },
    connectEvents: () => { calls.push(["connectEvents"]); },
    destroy: () => { calls.push(["destroy"]); },
    ...overrides
  };
  return api;
}

async function makeSurface({ apiOverrides = {}, callbacks = {}, useRealTransport = false, requestFrame = null } = {}) {
  const root = new MockElement("div");
  const api = useRealTransport ? null : makeFakeApi(apiOverrides);
  const opened = [];
  const chapters = [];
  const projectActions = [];
  const { createAgentSurface } = await import("../../src/app-shell/agent/index.js");
  const surface = createAgentSurface({
    root,
    api,
    requestFrame,
    onOpenSettings: (section) => opened.push(section),
    onOpenChapter: (chapterNo) => chapters.push(chapterNo),
    onCreateProject: callbacks.onCreateProject ?? (() => projectActions.push("create")),
    onOpenProjectFolder: callbacks.onOpenProjectFolder ?? (() => projectActions.push("open")),
    onSessionsChanged: callbacks.onSessionsChanged ?? (() => {}),
    // Task 16（R5-12）：Run 终态回调透出（app.js 据此刷新 dashboard/会话列表）。
    onRunTerminal: callbacks.onRunTerminal ?? (() => {})
  });
  return { root, api, surface, opened, chapters, projectActions };
}

function snapshotOf(state, events = []) {
  return { session: state, events };
}

test("首次快照以服务端 session 为准，早期事件不能把终态回放成 running", async () => {
  const { root, surface } = await makeSurface();
  const authoritative = session({
    status: "idle",
    last_seq: 400,
    active_run: activeRun({ status: "completed", active_input_id: null })
  });
  surface.applySnapshot(snapshotOf(authoritative, [
    { ...ev("run_started", { workflow: "general", input_id: "in-1" }), seq: 1 },
    { ...ev("model_turn_started"), seq: 2 }
  ]));
  assert.equal(root.querySelector('[data-testid="agent-stop"]'), null, "权威终态下不得显示停止按钮");
  assert.equal(root.querySelector('[data-testid="agent-retry"]'), null, "权威终态下不得显示重试按钮");
  assert.equal(root.querySelector(".agent-work-group"), null, "权威终态下早期 run_started 不渲染工作中工作组");
  assert.equal(authoritative.status, "idle", "reducer 不应修改调用方传入的 projection");
  assert.equal(authoritative.active_run.status, "completed");
});

test("首次打开：openProject 以 tail 语义拉取尾部 200 条并渲染，不再分页补齐全量", async () => {
  const opts = [];
  const finalSession = session({
    status: "idle",
    last_seq: 4,
    active_run: activeRun({ status: "completed", active_input_id: null })
  });
  const { root, surface } = await makeSurface({
    apiOverrides: {
      fetchSnapshot: async (options) => {
        opts.push(options);
        if (options.tail) {
          return snapshotOf(finalSession, [
            { ...ev("run_started", { workflow: "general", input_id: "in-1" }), seq: 1 },
            { ...ev("input_queued", { input_id: "in-1", text: "长会话消息", source: "chat" }), seq: 2 },
            { ...ev("input_started", { input_id: "in-1" }), seq: 3 },
            { ...ev("run_completed", {}), seq: 4 }
          ]);
        }
        return snapshotOf(finalSession, []);
      }
    }
  });
  await surface.openProject("D:\\novel");
  assert.deepEqual(opts, [{ tail: true, limit: 200 }], "首次调用使用 tail 语义，不再分页补齐全量");
  assert.ok(root.textContent.includes("长会话消息"));
});

// ===========================================================================
// 用户行为：发送 / 排队 / 立即 / 停止 / 重试 / 项目切换 / 斜杠输入
// ===========================================================================

test("空闲发送：输入文本后发送按钮提交到 api，输入框清空", async () => {
  const { root, api, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  input.value = "继续写第一章";
  const send = root.querySelector('[data-testid="agent-send"]');
  send._fire("click");
  assert.deepEqual(api.calls.filter((c) => c[0] === "submit").map((c) => c[1]), ["继续写第一章"]);
  assert.equal(input.value, "", "发送后输入框应清空");
});

test("提交失败：保留用户消息、恢复输入并显示可见错误", async () => {
  const { root, surface } = await makeSurface({
    apiOverrides: {
      submit: async () => { throw new Error("项目状态目录不可写"); }
    }
  });
  await surface.openProject("D:\\novel");
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  input.value = "继续写第一章";
  root.querySelector('[data-testid="agent-send"]')._fire("click");
  await tick();

  const messages = root.querySelectorAll('[data-testid="agent-user-message"]');
  assert.equal(messages.length, 1, "请求失败也不能让用户输入凭空消失");
  assert.match(messages[0].textContent, /继续写第一章/u);
  assert.equal(input.value, "继续写第一章", "失败后应恢复原输入，方便重试");
  assert.match(root.querySelector('[data-testid="agent-submit-error"]')?.textContent ?? "", /项目状态目录不可写/u);
});

test("提交成功：主动补快照并把即时消息收敛为「接下来」排队行（queued 不生成正式气泡）", async () => {
  let snapshotCalls = 0;
  const { root, api, surface } = await makeSurface({
    apiOverrides: {
      submit: async (text) => {
        api.calls.push(["submit", text]);
        return { ok: true, input_id: "in-refresh", run_id: "run-refresh", status: "running" };
      },
      fetchSnapshot: async ({ afterSeq = 0 } = {}) => {
        snapshotCalls += 1;
        api.calls.push(["fetchSnapshot", afterSeq]);
        if (snapshotCalls === 1) return null;
        return snapshotOf(session({
          last_seq: 1,
          queued_inputs: [{ id: "in-refresh", text: "继续写第一章", status: "queued", queued_at: "2026-08-06T00:00:00.000Z" }]
        }), [
          { ...ev("input_queued", { input_id: "in-refresh", text: "继续写第一章", source: "chat" }), seq: 1 }
        ]);
      }
    }
  });
  await surface.openProject("D:\\novel");
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  input.value = "继续写第一章";
  root.querySelector('[data-testid="agent-send"]')._fire("click");

  await waitUntil(() => snapshotCalls === 2);
  // queued 只出现在「接下来」区域：即时气泡收敛为排队行，不生成正式对话气泡
  assert.equal(root.querySelectorAll('[data-testid="agent-user-message"]').length, 0, "queued 不生成正式对话气泡");
  assert.equal(root.querySelector('[data-testid="agent-submit-error"]'), null);
  const items = root.querySelectorAll('[data-testid="agent-queue-item"]');
  assert.equal(items.length, 1, "确认送达后收敛为「接下来」排队行");
  assert.match(items[0].textContent, /继续写第一章/u);
  assert.equal(root.querySelector('[data-testid="agent-queue-item"]').dataset.state, undefined, "排队行不带 pending 状态");
});

test("提交补快照迟到：切换项目后不得用旧项目会话覆盖新项目", async () => {
  let snapshotCalls = 0;
  let resolveOldSnapshot;
  const oldSnapshot = new Promise((resolve) => { resolveOldSnapshot = resolve; });
  const { root, api, surface } = await makeSurface({
    apiOverrides: {
      submit: async (text) => {
        api.calls.push(["submit", text]);
        return { ok: true, input_id: "in-a", run_id: "run-a", status: "running" };
      },
      fetchSnapshot: async ({ afterSeq = 0 } = {}) => {
        snapshotCalls += 1;
        api.calls.push(["fetchSnapshot", afterSeq]);
        if (snapshotCalls === 1) return null;
        if (snapshotCalls === 2) return oldSnapshot;
        return snapshotOf(session({
          session_id: "sess-b", project_root: "D:\\novel-b", last_seq: 2
        }), [
          { ...ev("input_queued", { input_id: "in-b", text: "B 项目消息", source: "chat" }, { session_id: "sess-b" }), seq: 1 },
          { ...ev("input_started", { input_id: "in-b" }, { session_id: "sess-b" }), seq: 2 }
        ]);
      }
    }
  });

  await surface.openProject("D:\\novel-a");
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  input.value = "A 项目消息";
  root.querySelector('[data-testid="agent-send"]')._fire("click");
  await waitUntil(() => snapshotCalls === 2);

  await surface.openProject("D:\\novel-b");
  assert.match(root.textContent, /B 项目消息/u, "切换完成后应显示 B 项目会话");

  resolveOldSnapshot(snapshotOf(session({
    session_id: "sess-a", project_root: "D:\\novel-a", last_seq: 2
  }), [
    { ...ev("input_queued", { input_id: "in-a", text: "A 项目消息", source: "chat" }, { session_id: "sess-a" }), seq: 1 },
    { ...ev("input_started", { input_id: "in-a" }, { session_id: "sess-a" }), seq: 2 }
  ]));
  await tick();
  await tick();

  assert.match(root.textContent, /B 项目消息/u, "A 的迟到快照不得清空 B 会话");
  assert.doesNotMatch(root.textContent, /A 项目消息/u, "A 的历史不得渲染进 B 项目");
});

test("提交失败迟到：切换项目后不得把旧文本恢复进新项目输入框", async () => {
  let rejectOldSubmit;
  const oldSubmit = new Promise((_resolve, reject) => { rejectOldSubmit = reject; });
  const { root, api, surface } = await makeSurface({
    apiOverrides: {
      submit: (text) => {
        api.calls.push(["submit", text]);
        return oldSubmit;
      }
    }
  });

  await surface.openProject("D:\\novel-a");
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  input.value = "只属于 A 的文本";
  root.querySelector('[data-testid="agent-send"]')._fire("click");
  await surface.openProject("D:\\novel-b");
  assert.equal(input.value, "", "B 项目的输入框初始为空");

  rejectOldSubmit(new Error("A 项目提交失败"));
  await tick();
  await tick();

  assert.equal(input.value, "", "旧项目失败回调不得改写 B 项目输入框");
  assert.equal(root.querySelectorAll('[data-testid="agent-user-message"]').length, 0, "B 对话不得出现 A 的失败消息");
  assert.equal(root.querySelector('[data-testid="agent-submit-error"]'), null, "B 对话不得出现 A 的错误提示");
});

// ===========================================================================
// Task 6：composer 草稿清理 / 失败气泡移除 / 提交后焦点
// ===========================================================================

test("重置视图清空 composer：未发送草稿不跨会话泄漏", async () => {
  const { root, surface } = await makeSurface({
    apiOverrides: {
      openProject: async () => {},
      fetchSnapshot: async (options) => {
        if (options?.sessionId === "sid-2") {
          return snapshotOf(session({ session_id: "sid-2", last_seq: 2 }), [
            { ...ev("input_queued", { input_id: "in-2", text: "B 会话消息", source: "chat" }, { session_id: "sid-2" }), seq: 1 },
            { ...ev("input_started", { input_id: "in-2" }, { session_id: "sid-2" }), seq: 2 }
          ]);
        }
        return null;
      }
    }
  });
  await surface.openProject("D:\\novel", "sid-1");
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  input.value = "未发送的草稿";
  await surface.switchSession("sid-2");
  assert.equal(input.value, "", "切换会话（reset）后未发送草稿不得带进新会话");
  assert.match(root.textContent, /B 会话消息/u, "新会话内容正常渲染");
});

test("提交失败气泡：重试成功后移除，不永久残留", async () => {
  let failFirst = true;
  const { root, surface } = await makeSurface({
    apiOverrides: {
      submit: async (text) => {
        if (failFirst) {
          failFirst = false;
          throw new Error("第一次提交失败");
        }
        return { ok: true, input_id: "in-ok", status: "running" };
      }
    }
  });
  await surface.openProject("D:\\novel");
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  const send = root.querySelector('[data-testid="agent-send"]');
  input.value = "重试的文本";
  send._fire("click");
  await tick();
  assert.ok(root.querySelector('[data-testid="agent-submit-error"]'), "第一次失败应显示错误提示");
  assert.equal(input.value, "重试的文本", "失败后文本回填 composer 便于重试");

  // 重试同一文本：成功后失败气泡与错误文案都应消失
  send._fire("click");
  await tick();
  await tick();
  assert.equal(root.querySelector('[data-testid="agent-submit-error"]'), null, "重试成功后失败气泡消失");
  assert.equal(root.querySelectorAll('[data-testid="agent-user-message"]').length, 1, "重试成功只保留一条用户消息");
});

test("提交失败气泡：排队行回放确认送达后移除（reconcile 路径）", async () => {
  const { root, surface } = await makeSurface({
    apiOverrides: {
      submit: async () => { throw new Error("网络抖动，实际已受理"); }
    }
  });
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  input.value = "送达确认的文本";
  root.querySelector('[data-testid="agent-send"]')._fire("click");
  await tick();
  assert.ok(root.querySelector('[data-testid="agent-submit-error"]'), "submit reject 应先显示失败气泡");

  // 后端实际已受理：同文本输入经事件流回放（input_queued → 「接下来」排队行 →
  // syncQueue reconcile），失败气泡应按文本一并移除。
  surface.applyEvent(ev("input_queued", { input_id: "in-delivered", text: "送达确认的文本", source: "chat" }));
  await tick();
  assert.equal(root.querySelector('[data-testid="agent-submit-error"]'), null, "排队行确认送达后失败气泡消失");
  assert.equal(root.querySelectorAll('[data-testid="agent-queue-item"]').length, 1, "确认送达后显示为排队行");
  assert.ok(root.querySelector('[data-input-id="in-delivered"]').textContent.includes("送达确认的文本"), "排队行保留原文");
});

test("click 提交成功后焦点回到 textarea", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  input.value = "发送后聚焦";
  root.querySelector('[data-testid="agent-send"]')._fire("click");
  await tick();
  await tick();
  assert.equal(input._focusCount, 1, "提交成功后焦点应回到输入框");
});

test("输入斜杠显示命令补全，可用键盘选择但不会立即提交", async () => {
  const { root, api, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  input.value = "/";
  input._fire("input");

  const menu = root.querySelector('[data-testid="agent-slash-menu"]');
  assert.ok(menu, "输入 / 后应出现命令菜单");
  assert.equal(menu.hidden, false);
  assert.equal(root.querySelectorAll('[data-testid="agent-slash-option"]').length, 5, "补全应为 /init /write /compact /model /settings 五项");
  assert.ok(menu.textContent.includes("/compact"), "/compact 应在补全列表中");
  assert.ok(menu.textContent.includes("压缩当前上下文"), "/compact 带中文标签");

  input.value = "/se";
  input._fire("input");
  assert.equal(root.querySelectorAll('[data-testid="agent-slash-option"]').length, 1, "前缀应筛选命令");
  let prevented = false;
  input._fire("keydown", { key: "ArrowDown", shiftKey: false, preventDefault: () => { prevented = true; } });
  input._fire("keydown", { key: "Enter", shiftKey: false, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(input.value, "/settings");
  assert.equal(menu.hidden, true);
  assert.equal(api.calls.filter((call) => call[0] === "submit").length, 0, "补全只填入命令，不应直接执行");
});

test("中文输入法组合态：Enter 与 keyCode 229 不得发送消息", async () => {
  const { root, api, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  input.value = "正在确认候选词";
  let prevented = 0;

  input._fire("keydown", {
    key: "Enter", shiftKey: false, isComposing: true, keyCode: 13,
    preventDefault: () => { prevented += 1; }
  });
  input._fire("keydown", {
    key: "Enter", shiftKey: false, isComposing: false, keyCode: 229,
    preventDefault: () => { prevented += 1; }
  });

  assert.equal(prevented, 0, "组合态按键应完全交给输入法处理");
  assert.equal(input.value, "正在确认候选词", "输入内容不得被提前清空");
  assert.equal(api.calls.filter((call) => call[0] === "submit").length, 0, "组合态 Enter 不得提交");
});

test("中文输入法组合态：斜杠菜单中的 Enter 与 Tab 不得选择命令", async () => {
  const { root, api, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  const menu = root.querySelector('[data-testid="agent-slash-menu"]');
  input.value = "/se";
  input._fire("input");
  let prevented = 0;

  input._fire("keydown", {
    key: "Enter", shiftKey: false, isComposing: true, keyCode: 13,
    preventDefault: () => { prevented += 1; }
  });
  input._fire("keydown", {
    key: "Tab", shiftKey: false, isComposing: false, keyCode: 229,
    preventDefault: () => { prevented += 1; }
  });

  assert.equal(prevented, 0, "组合态按键不应被命令菜单截获");
  assert.equal(input.value, "/se", "组合态不得把输入替换为命令");
  assert.equal(menu.hidden, false, "命令菜单保持原状，等待输入法结束");
  assert.equal(api.calls.filter((call) => call[0] === "submit").length, 0);
});

test("composer 是多行命令台：保留纯输入控制，发送按钮使用可访问图标", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");

  const shell = root.querySelector('[data-testid="agent-composer-shell"]');
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  const send = root.querySelector('[data-testid="agent-send"]');

  assert.ok(shell, "输入框和工具栏应收拢在同一个命令台内");
  assert.equal(input.rows, 3, "命令台默认应提供稳定的多行输入空间");
  assert.equal(root.querySelector('[data-testid="agent-command-trigger"]'), null, "不增加重复斜杠输入的按钮");
  assert.equal(send.getAttribute("aria-label"), "发送");
  assert.ok(send.querySelector("svg"), "发送应使用清晰图标而不是长文本按钮");
  assert.equal(send.textContent, "", "图标按钮不重复显示发送文字");
});

test("Enter 键发送（不带 Shift）", async () => {
  const { root, api, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  input.value = "改第三章";
  let prevented = false;
  input._fire("keydown", { key: "Enter", shiftKey: false, preventDefault: () => { prevented = true; } });
  assert.ok(prevented, "Enter 应阻止默认行为");
  assert.deepEqual(api.calls.filter((c) => c[0] === "submit").map((c) => c[1]), ["改第三章"]);
  assert.equal(input.value, "");
});

test("运行中发送进入队列：显示原文 + 排队 + 立即/取消；点击立即触发 requestPriority", async () => {
  const { root, api, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("input_queued", { input_id: "in-2", text: "先改第三章", source: "chat" }));
  const items = root.querySelectorAll('[data-testid="agent-queue-item"]');
  assert.equal(items.length, 1);
  assert.ok(items[0].textContent.includes("先改第三章"), "排队项应含原文");
  assert.ok(items[0].textContent.includes("排队"), "排队项应含「排队」");
  const promote = items[0].querySelector('[data-testid="agent-promote"]');
  assert.ok(promote, "排队项应有「立即」按钮");
  assert.equal(promote.disabled, false, "无优先在途时「立即」可点");
  const withdraw = items[0].querySelector('[data-testid="agent-withdraw"]');
  assert.ok(withdraw, "排队项应有「取消」（撤回）按钮");
  assert.equal(withdraw.textContent, "取消");
  promote._fire("click");
  assert.deepEqual(api.calls.filter((c) => c[0] === "requestPriority").map((c) => c[1]), ["in-2"]);
  assert.equal(api.calls.filter((c) => c[0] === "promote").length, 0, "旧 promote 不得再被调用");
});

test("同一 run id：优先切换批次（input_interrupted + input_started）不更换 Run；conversation 保留", async () => {
  const { root, api, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  // A 在跑，B 排队 → 用户点 B「立即」→ priority_input_requested →
  // 安全点批次 input_interrupted(A) + input_started(B)（同一 run id）
  surface.applyEvent(ev("input_queued", { input_id: "in-1", text: "第一条消息", source: "chat" }));
  surface.applyEvent(ev("input_started", { input_id: "in-1" }));
  surface.applyEvent(ev("input_queued", { input_id: "in-2", text: "先改第三章", source: "chat" }));
  surface.applyEvent(ev("priority_input_requested", { input_id: "in-2" }));
  surface.applyEvent(ev("input_interrupted", { input_id: "in-1" }));
  surface.applyEvent(ev("input_started", { input_id: "in-2" }));
  // 用户气泡：A、B 各一条（input_started 是用户文本进入对话的唯一边界）
  assert.equal(root.querySelectorAll('[data-testid="agent-user-message"]').length, 2);
  assert.equal(root.querySelectorAll('[data-testid="agent-queue-item"]').length, 0, "优先输入开始后队列清空");
  // 停止动作应针对当前 run id
  const stop = root.querySelector('[data-testid="agent-stop"]');
  assert.ok(stop, "活动 Run 应有停止按钮");
  stop._fire("click");
  await tick();
  assert.deepEqual(api.calls.filter((c) => c[0] === "stop").map((c) => c[1]), ["run-1"]);
});

test("停止防连点：点击即禁用，连点只触发一次；终态后按钮消失且被停止工具为 cancelled", async () => {
  const { root, api, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  const stop = root.querySelector('[data-testid="agent-stop"]');
  stop._fire("click");
  stop._fire("click");
  stop._fire("click");
  await tick();
  assert.equal(api.calls.filter((c) => c[0] === "stop").length, 1, "连点只触发一次 stop");
  // 停止路径：活动被取消 + Run 收敛 —— 不得出现第二个重复状态横幅
  surface.applyEvent(ev("run_status_changed", { status: "stopping", reason: "user_stop" }));
  surface.applyEvent(toolStarted("a9", "shell", { command: "npm test" }));
  surface.applyEvent(ev("tool_call_failed", {
    tool_call_id: "tc-a9", activity_id: "a9", name: "shell",
    error: "tool_cancelled", message: "操作已停止。"
  }));
  surface.applyEvent(ev("run_cancelled", { reason: "user_stop" }));
  assert.equal(root.querySelector('[data-testid="agent-stop"]'), null, "终态后停止按钮应消失");
  const cancelledTool = [...root.querySelectorAll(".agent-work-item")].find(
    (el) => el.dataset.kind === "tool" && el.dataset.state === "cancelled"
  );
  assert.ok(cancelledTool, "被停止的工具保留为 cancelled 工作项");
  assert.match(cancelledTool.querySelector(".agent-work-item__icon").textContent, /已停止/u, "工具标记 = 已停止");
});

test("停止失败（拒绝）时按钮恢复可点", async () => {
  const { root, api, surface } = await makeSurface({
    apiOverrides: {
      stop: async (runId) => { api.calls.push(["stop", runId]); throw new Error("409"); },
    }
  });
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  const stop = root.querySelector('[data-testid="agent-stop"]');
  stop._fire("click");
  await tick();
  assert.equal(stop.disabled, false, "stop 请求失败后按钮应恢复可点");
  assert.equal(api.calls.filter((c) => c[0] === "stop").length, 1);
});

test("retry 恢复同一 run 后停止按钮重新可点（stopPending 不被遗留）", async () => {
  const { root, api, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  // 停止请求在途（按钮已禁用）
  const stop = root.querySelector('[data-testid="agent-stop"]');
  stop._fire("click");
  await tick();
  assert.equal(stop.disabled, true, "停止请求在途时按钮禁用");
  // Run 失败（终态，出现重试按钮）
  surface.applyEvent(ev("run_failed", { error: "模型超时", code: "model_timeout", input_id: "in-1" }));
  assert.ok(root.querySelector('[data-testid="agent-retry"]'), "失败 Run 应显示重试按钮");
  assert.equal(root.querySelector('[data-testid="agent-stop"]'), null);
  // retry：同 run id 恢复 running
  surface.applyEvent(ev("run_started", { workflow: "general", input_id: "in-1" }, { run_id: "run-1" }));
  const resumed = root.querySelector('[data-testid="agent-stop"]');
  assert.ok(resumed, "恢复后应重新显示停止按钮");
  assert.equal(resumed.disabled, false, "retry 恢复同 run 后停止按钮应可再次点击");
  resumed._fire("click");
  await tick();
  assert.equal(api.calls.filter((c) => c[0] === "stop").length, 2, "应能对重试后的 Run 再次发起 stop");
});

test("失败 Run：显示错误卡与重试按钮；重试点击调用 api.retry（同一 run id）", async () => {
  const { root, api, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("run_failed", { error: "模型超时", code: "model_timeout", input_id: "in-1" }));
  const errorCards = root.querySelectorAll('[data-testid="agent-error"]');
  assert.equal(errorCards.length, 1);
  assert.match(errorCards[0].textContent, /模型超时/u);
  const retry = root.querySelector('[data-testid="agent-retry"]');
  assert.ok(retry, "失败 Run 应显示重试按钮");
  retry._fire("click");
  assert.deepEqual(api.calls.filter((c) => c[0] === "retry").map((c) => c[1]), ["run-1"]);
  // retry 恢复同一 run id：run_started 事件 → 回到运行中，错误卡清空
  surface.applyEvent(ev("run_started", { workflow: "general", input_id: "in-1" }, { run_id: "run-1" }));
  assert.equal(root.querySelector('[data-testid="agent-retry"]'), null);
  assert.equal(root.querySelectorAll('[data-testid="agent-error"]').length, 0, "新 Run 启动后错误卡清空");
});

test("项目切换：重新 openProject 重置对话与队列，transport 作用域更新", async () => {
  const { root, api, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("input_queued", { input_id: "in-2", text: "旧项目消息", source: "chat" }));
  surface.applyEvent(ev("input_started", { input_id: "in-2" }));
  assert.equal(root.querySelectorAll('[data-testid="agent-user-message"]').length, 1);
  await surface.openProject("D:\\novel-b");
  assert.ok(api.calls.some((c) => c[0] === "openProject" && c[1] === "D:\\novel-b"));
  assert.equal(root.querySelectorAll('[data-testid="agent-user-message"]').length, 0, "切项目后旧对话清空");
  assert.equal(root.querySelectorAll('[data-testid="agent-queue-item"]').length, 0);
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  assert.equal(input.disabled, false, "新项目 composer 可用");
});

test("无项目时隐藏 composer；打开项目后显示并可用", async () => {
  const { root, surface } = await makeSurface();
  const composer = root.querySelector('[data-testid="agent-composer"]');
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  const send = root.querySelector('[data-testid="agent-send"]');
  assert.equal(composer.hidden, true, "未打开项目时不应露出一套看似损坏的输入区");
  assert.equal(input.disabled, true, "未打开项目时输入框禁用");
  assert.equal(send.disabled, true);
  await surface.openProject("D:\\novel");
  assert.equal(composer.hidden, false, "打开项目后显示 composer");
  assert.equal(input.disabled, false, "打开项目后输入框可用");
  assert.equal(send.disabled, false);
});

test("无项目初始页：呈现 Codex 式起点，入口复用新建和打开项目流程", async () => {
  const { root, surface, projectActions } = await makeSurface();
  const empty = root.querySelector('[data-testid="agent-empty"]');
  const run = root.querySelector('[data-testid="agent-run"]');
  const create = root.querySelector('[data-testid="agent-empty-create"]');
  const open = root.querySelector('[data-testid="agent-empty-open"]');
  assert.ok(empty && create && open, "无项目时应渲染完整初始页与两个已有项目入口");
  assert.equal(empty.hidden, false, "无项目时初始页可见");
  assert.match(empty.textContent, /从一部小说开始/u);
  assert.match(empty.textContent, /新建小说/u);
  assert.match(empty.textContent, /打开本地文件夹/u);
  create._fire("click");
  open._fire("click");
  assert.deepEqual(projectActions, ["create", "open"], "初始页不应另造项目流程");
  assert.equal(run.hidden, true, "没有 Run 时不应留下空状态分隔线");
  await surface.openProject("D:\\novel");
  assert.equal(empty.hidden, true, "打开项目后初始页隐藏（有项目时为空会话，不显示欢迎词）");
  assert.equal(run.hidden, true, "项目已打开但尚未执行时仍保持干净");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  assert.equal(run.hidden, false, "有活动 Run 时才显示执行区域");
  await surface.openProject("D:\\novel-b");
  assert.equal(empty.hidden, true, "切换项目后仍隐藏");
});

test("运行中 composer 保持可用（普通发送排队）", async () => {
  const { root, api, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  const send = root.querySelector('[data-testid="agent-send"]');
  assert.equal(send.disabled, false, "运行中发送按钮不应禁用");
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  input.value = "排队任务";
  send._fire("click");
  assert.deepEqual(api.calls.filter((c) => c[0] === "submit").map((c) => c[1]), ["排队任务"]);
});

test("/settings 与 /model 精确输入：调用设置导航回调，不 POST Agent 输入", async () => {
  const { root, api, surface, opened } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session())); // 无 Run
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  input.value = "/settings";
  root.querySelector('[data-testid="agent-send"]')._fire("click");
  input.value = "/model";
  root.querySelector('[data-testid="agent-send"]')._fire("click");
  assert.deepEqual(opened, ["settings", "model"], "应调用设置导航回调");
  assert.equal(api.calls.filter((c) => c[0] === "submit").length, 0, "不得 POST Agent 输入");
});

test("/init、/review、/write、/compact 是普通 Agent 输入（/compact now 不带前缀判断）", async () => {
  const { root, api, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  for (const text of ["/init 了解我的项目", "/review", "/write 第三章", "/compact", "/compact now"]) {
    input.value = text;
    root.querySelector('[data-testid="agent-send"]')._fire("click");
  }
  assert.deepEqual(api.calls.filter((c) => c[0] === "submit").map((c) => c[1]), [
    "/init 了解我的项目", "/review", "/write 第三章", "/compact", "/compact now"
  ]);
});

// ===========================================================================
// Visible Plan：活动展开 / 终态折叠 / 无手动编辑
// ===========================================================================

test("Plan 作为工作组子项：全部任务可见、无编辑控件；终态后工作组自动折叠", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("run_started", { workflow: "general", input_id: "in-1" }));
  surface.applyEvent(ev("plan_updated", {
    explanation: "先核对已完成章节",
    items: [
      { id: "p1", step: "检查已有章节", status: "completed" },
      { id: "p2", step: "修正冲突", status: "in_progress" },
      { id: "p3", step: "验证修改", status: "pending" }
    ]
  }));
  assert.equal(root.querySelector('[data-testid="agent-plan-overlay"]'), null, "旧 plan overlay 已删除");
  const group = root.querySelector(".agent-work-group");
  assert.ok(group, "计划进入工作组");
  assert.equal(group.open, true, "运行中工作组展开");
  const planRow = group.querySelector('[data-kind="plan"]');
  assert.ok(planRow, "计划是工作组的一个子项");
  assert.match(planRow.querySelector(".agent-plan__title").textContent, /任务计划/u);
  assert.equal(planRow.querySelector(".agent-plan__count").textContent, "1/3", "进度计数 completed/total");
  const items = planRow.querySelectorAll(".agent-plan-item");
  assert.equal(items.length, 3, "计划展开显示全部任务");
  assert.deepEqual([...items].map((el) => el.dataset.status), ["completed", "in_progress", "pending"]);
  assert.match(planRow.textContent, /检查已有章节/u);
  assert.match(planRow.textContent, /先核对已完成章节/u, "explanation 可见");
  assert.equal(planRow.querySelectorAll("input, textarea, [contenteditable]").length, 0, "计划只读，无编辑控件");
  assert.equal(planRow.querySelectorAll("button").length, 0, "无最小化/折叠等显示控件");
  // 终态 → 工作组自动折叠（投影默认 expanded=false）
  surface.applyEvent(ev("run_completed", {}));
  assert.equal(group.open, false, "Run 完成后工作组折叠");
  assert.match(group.querySelector(".agent-work-status").textContent, /工作了/u, "终态状态行带耗时文案");
});

test("多 Run：首个完成组的终态耗时保持自身值，不被第二个 Run 的时钟覆盖", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  const T0 = "2026-08-06T00:00:00.000Z";
  const atSec = (s) => new Date(Date.parse(T0) + s * 1000).toISOString();
  // Run A：0→10s 完成（带一个 reasoning 项，工作组才会渲染）
  surface.applyEvent(ev("run_started", { workflow: "general", input_id: "in-1" }, { at: atSec(0) }));
  surface.applyEvent(ev("model_turn_started", { turn_id: "turn-a", input_id: "in-1", reasoning_capability: "supported" }, { at: atSec(5) }));
  surface.applyEvent(ev("reasoning_completed", { turn_id: "turn-a", input_id: "in-1", text: "分析完成", availability: "available" }, { at: atSec(5) }));
  surface.applyEvent(ev("run_completed", {}, { at: atSec(10) }));
  const groupA = root.querySelector(".agent-work-group");
  assert.ok(groupA, "Run A 工作组存在");
  assert.match(groupA.querySelector(".agent-work-status").textContent, /工作了 10 秒/u, "Run A 完成：自身 10 秒");
  // Run B 开始（运行中，快照级 active_elapsed_ms 为 0）—— 不得覆盖 Run A 的终态文案
  surface.applyEvent(ev("run_started", { workflow: "general", input_id: "in-2" }, { run_id: "run-2", at: atSec(20) }));
  surface.applyEvent(ev("model_turn_started", { turn_id: "turn-b", input_id: "in-2", reasoning_capability: "supported" }, { run_id: "run-2", at: atSec(20) }));
  const groups = [...root.querySelectorAll(".agent-work-group")];
  assert.equal(groups.length, 2, "两个工作组");
  assert.equal(groups[0].querySelector(".agent-work-status").textContent, "工作了 10 秒", "Run A 文案保持自身值");
  assert.equal(groups[1].querySelector(".agent-work-status").textContent, "工作中", "Run B 运行中文案");
  assert.equal(groups[1].open, true, "Run B 运行中展开");
});

test("计划子项只读展示：计数与全部任务都在工作组内", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("run_started", { workflow: "general", input_id: "in-1" }));
  surface.applyEvent(ev("plan_updated", {
    items: [
      { id: "p1", step: "准备素材", status: "completed" },
      { id: "p2", step: "撰写章节", status: "in_progress" },
      { id: "p3", step: "校对正文", status: "pending" },
      { id: "p4", step: "提交结果", status: "pending" }
    ]
  }));
  const group = root.querySelector(".agent-work-group");
  const planRow = group.querySelector('[data-kind="plan"]');
  assert.equal(planRow.querySelector(".agent-plan__count").textContent, "1/4");
  assert.equal(planRow.querySelectorAll(".agent-plan-item").length, 4, "全部任务始终可见");
});

test("计划子项显示全部任务（不再折叠裁剪），in_progress 项标记当前", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("run_started", { workflow: "general", input_id: "in-1" }));
  surface.applyEvent(ev("plan_updated", {
    items: [
      { id: "p1", step: "一", status: "completed" },
      { id: "p2", step: "二", status: "completed" },
      { id: "p3", step: "三", status: "in_progress" },
      { id: "p4", step: "四", status: "pending" },
      { id: "p5", step: "五", status: "pending" }
    ]
  }));
  const group = root.querySelector(".agent-work-group");
  const planRow = group.querySelector('[data-kind="plan"]');
  const items = [...planRow.querySelectorAll(".agent-plan-item")];
  assert.equal(items.length, 5, "全部 5 项都渲染");
  assert.deepEqual(
    items.map((el) => el.dataset.status),
    ["completed", "completed", "in_progress", "pending", "pending"]
  );
  assert.equal(items[2].dataset.status, "in_progress");
});

test("plan_updated 更新通过同一 DOM key 移动节点，不创建第二张卡", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("run_started", { workflow: "general", input_id: "in-1" }));
  surface.applyEvent(ev("plan_updated", {
    items: [
      { id: "t1", step: "任务一", status: "completed" },
      { id: "t2", step: "任务二", status: "in_progress" }
    ]
  }));
  const group = root.querySelector(".agent-work-group");
  assert.equal(group.querySelectorAll('[data-kind="plan"]').length, 1, "第一版计划只有一张卡");
  // 第二次更新：同 id 任务更新状态并移动到最新位置，不新增卡
  surface.applyEvent(ev("plan_updated", {
    items: [
      { id: "t2", step: "任务二", status: "completed" },
      { id: "t3", step: "任务三", status: "pending" }
    ]
  }));
  assert.equal(group.querySelectorAll('[data-kind="plan"]').length, 1, "计划更新不创建第二张卡");
  const planRow = group.querySelector('[data-kind="plan"]');
  const tasks = [...planRow.querySelectorAll(".agent-plan-item")];
  assert.deepEqual(tasks.map((el) => el.dataset.planId), ["t1", "t2", "t3"], "历史任务保留，新任务追加");
  assert.deepEqual(tasks.map((el) => el.dataset.status), ["completed", "completed", "pending"]);
  assert.equal(planRow.querySelector(".agent-plan__count").textContent, "2/3");
});

test("计划任务带 description 时展示补充说明", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("run_started", { workflow: "general", input_id: "in-1" }));
  surface.applyEvent(ev("plan_updated", {
    items: [
      { id: "a", step: "第一步", status: "in_progress", description: "补充说明文字" },
      { id: "b", step: "第二步", status: "pending" }
    ]
  }));
  const group = root.querySelector(".agent-work-group");
  const planRow = group.querySelector('[data-kind="plan"]');
  assert.match(planRow.textContent, /补充说明文字/u);
});

test("无计划事件的 Run 不渲染计划子项，也不渲染空工作组", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  assert.equal(root.querySelector('[data-testid="agent-plan-overlay"]'), null);
  assert.equal(root.querySelector(".agent-work-group"), null, "无工作事件不渲染工作组");
  surface.applyEvent(ev("run_completed", {}));
  assert.equal(root.querySelector(".agent-work-group"), null, "无子项的空组不渲染");
});


// ===========================================================================
// 工具工作项：合并 / details / 64 KiB / 标记 / reasoning 工作项分离
// ===========================================================================

test("同一 activity_id 合并输出到单个工具工作项，不重复创建行", () => {
  return (async () => {
    const { root, surface } = await makeSurface();
    await surface.openProject("D:\\novel");
    surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
    surface.applyEvent(toolStarted("a1", "shell", { command: "npm test" }));
    surface.applyEvent(outputDelta("a1", "one\n"));
    surface.applyEvent(outputDelta("a1", "two\n"));
    surface.applyEvent(ev("tool_call_completed", {
      tool_call_id: "tc-a1", activity_id: "a1", name: "shell",
      exit_code: 0, duration_ms: 35
    }));
    const toolRows = [...root.querySelectorAll(".agent-work-item")].filter((el) => el.dataset.kind === "tool");
    assert.equal(toolRows.length, 1, "同 activity_id 只渲染一个工具工作项");
    const row = toolRows[0];
    assert.equal(row.dataset.state, "completed");
    assert.match(row.textContent, /one\ntwo/u, "增量输出累积在同一工作项内");
    assert.match(row.textContent, /退出码0/u);
    assert.equal(row.querySelector(".agent-work-item__icon").textContent, "✓");
  })();
});

test("不同 activity_id 分别成项；openProject 后清空全部工作项", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(toolStarted("a1", "shell", { command: "npm test" }));
  surface.applyEvent(toolStarted("a2", "read_file", { path: "chapter.md" }));
  const toolRows = () => [...root.querySelectorAll(".agent-work-item")].filter((el) => el.dataset.kind === "tool");
  assert.equal(toolRows().length, 2);
  await surface.openProject("D:\\novel");
  assert.equal(toolRows().length, 0, "重新打开项目后工作项清空");
});

test("工具工作项标签：shell 正在运行命令→已运行命令、read_file 读取文件；reasoning 思考中→已完成思考", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  const toolLabel = (activityId) => {
    const row = root.querySelector(`[data-item-id="tool:${activityId}"]`);
    return row?.querySelector(".agent-work-item__label").textContent;
  };
  surface.applyEvent(toolStarted("a1", "shell", { command: "npm test" }));
  assert.match(toolLabel("a1"), /正在运行命令/u);
  surface.applyEvent(ev("tool_call_completed", {
    tool_call_id: "tc-a1", activity_id: "a1", name: "shell", exit_code: 0
  }));
  assert.match(toolLabel("a1"), /已运行命令/u);
  surface.applyEvent(toolStarted("a2", "read_file", { path: "chapter.md" }));
  assert.match(toolLabel("a2"), /正在读取文件/u);
  // reasoning 工作项：运行中 label 思考中；完成后变为已完成思考
  surface.applyEvent(ev("model_turn_started", { turn_id: "turn-1", input_id: "in-1", reasoning_capability: "supported" }));
  const group = root.querySelector(".agent-work-group");
  assert.ok(group, "有 reasoning 工作项时渲染工作组");
  const reasoningRow = group.querySelector('[data-kind="reasoning"]');
  const reasoningLabel = reasoningRow.querySelector(".agent-work-item__label");
  assert.match(reasoningLabel.textContent, /思考中/u);
  surface.applyEvent(ev("reasoning_completed", { turn_id: "turn-1", input_id: "in-1", text: "完成", availability: "available" }));
  surface.applyEvent(ev("model_turn_completed", { turn_id: "turn-1", input_id: "in-1", outcome: "completed" }));
  assert.match(reasoningRow.querySelector(".agent-work-item__label").textContent, /已完成思考/u);
  assert.equal(root.querySelector('[data-testid="agent-thinking"]'), null, "旧三点动画反馈已删除");
});

test("工具活动按 seq 位于 Assistant 正文之前（同一时间线）", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(toolStarted("a1", "list_files", { path: "D:\\novel" }, { seq: 2 }));
  surface.applyEvent(ev("tool_call_completed", {
    tool_call_id: "tc-a1", activity_id: "a1", name: "list_files", exit_code: 0, duration_ms: 12
  }, { seq: 3 }));
  surface.applyEvent(ev("assistant_message_completed", { input_id: "in-1", text: "文件清单如下" }, { seq: 4 }));
  // 时间线条目由工作组工具行承载（Task 1 后不再有独立活动行）
  const toolRow = root.querySelector(".agent-work-group");
  assert.ok(toolRow, "工作组承载工具标签行");
  const assistant = root.querySelector('[data-testid="agent-assistant-message"]');
  assert.ok(assistant, "Assistant 正文应渲染");
  const timeline = (node) => node._parent.children.indexOf(node);
  assert.ok(timeline(toolRow) < timeline(assistant), "完成态工具条目应位于 Assistant 正文之前");
  assert.equal(toolRow._parent, assistant._parent, "工作组与 Assistant 正文同属 messages 时间线");
  assert.match(toolRow.textContent, /查看文件列表/u, "工作组工具行保留工具摘要");
});

test("read_file 成功结果在消息流只渲染一次：工作组工具行保留，活动行省略（Task 1）", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(toolStarted("r1", "read_file", { path: "D:\\novel\\chapters\\001.md" }, { project_root: "D:\\novel" }));
  surface.applyEvent(outputDelta("r1", "# 第一章\n雨夜，老宅。"));
  surface.applyEvent(ev("tool_call_completed", {
    tool_call_id: "tc-r1", activity_id: "r1", name: "read_file", exit_code: 0
  }));
  // 消息流中 read_file 只出现一条：工作组工具标签行（已读取文件 + 相对路径）
  // MockElement 不支持组合选择器：用单类选择器 + dataset.kind 过滤（与既有用例同款）
  const toolRows = [...root.querySelectorAll(".agent-work-item")].filter((el) => el.dataset.kind === "tool");
  assert.equal(toolRows.length, 1, "工作组保留唯一的工具标签行");
  assert.match(toolRows[0].textContent, /已读取文件/u, "工具行显示完成态摘要");
  assert.match(toolRows[0].textContent, /chapters\/001\.md/u, "工具行展示项目相对路径");
});

// ===========================================================================
// 增量正文流（步骤7）：assistant_message_delta 累积渲染 + completed 终态对齐
// ===========================================================================

// MockElement 不支持组合属性选择器：用单选择器 + dataset 判定定位流式气泡。
function streamBubble(root) {
  const els = root.querySelectorAll('[data-testid="agent-assistant-message"]');
  return els.find((el) => el.dataset.streaming === "true") ?? null;
}

test("assistant_message_delta 累积渲染，completed 带全文时终态对齐", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("assistant_message_delta", { input_id: "in-1", text: "第一部分。" }));
  surface.applyEvent(ev("assistant_message_delta", { input_id: "in-1", text: "第二部分。" }));
  await tick();
  let stream = streamBubble(root);
  assert.ok(stream, "delta 期间应显示流式气泡");
  assert.match(stream.textContent, /第一部分。第二部分。/u, "流式气泡展示累积文本");
  // completed 带全文 → 终态气泡以全文对齐，流式气泡移除
  surface.applyEvent(ev("assistant_message_completed", { input_id: "in-1", text: "第一部分。第二部分。" }));
  assert.equal(streamBubble(root), null, "终态后流式气泡移除");
  const finals = root.querySelectorAll('[data-testid="agent-assistant-message"]');
  assert.equal(finals.length, 1, "只有一条终态助手消息");
  assert.match(finals[0].textContent, /第一部分。第二部分。/u);
});

test("新模型轮次清除工具轮次的临时正文，后续 token 从空白气泡开始", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));

  surface.applyEvent(ev("model_turn_started", {}));
  surface.applyEvent(ev("assistant_message_delta", { text: "正在读取资料……" }));
  await tick();
  assert.match(streamBubble(root).textContent, /正在读取资料/u);
  surface.applyEvent(ev("model_turn_completed", {}));

  surface.applyEvent(ev("model_turn_started", {}));
  assert.equal(streamBubble(root), null, "工具完成后的新模型轮次应移除上一轮临时正文");
  surface.applyEvent(ev("assistant_message_delta", { text: "最终答复" }));
  await tick();
  assert.equal(streamBubble(root).textContent, "最终答复");
});

test("assistant_message_completed 不带全文时以 delta 累积值为终态", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("assistant_message_delta", { text: "增量内容" }));
  await tick();
  surface.applyEvent(ev("assistant_message_completed", { input_id: "in-1" }));
  const finals = root.querySelectorAll('[data-testid="agent-assistant-message"]');
  assert.equal(finals.length, 1, "无全文的 completed 应以累积值产生终态气泡");
  assert.match(finals[0].textContent, /增量内容/u);
});

test("rAF 合帧节流：同一任务内多个 delta 只调度一帧渲染", async () => {
  const frames = [];
  const { root, surface } = await makeSurface({ requestFrame: (cb) => frames.push(cb) });
  await surface.openProject("D:\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("assistant_message_delta", { text: "a" }));
  surface.applyEvent(ev("assistant_message_delta", { text: "b" }));
  surface.applyEvent(ev("assistant_message_delta", { text: "c" }));
  assert.equal(frames.length, 1, "三个 delta 只调度一帧");
  assert.equal(streamBubble(root), null, "帧执行前不渲染");
  frames[0]();
  const stream = streamBubble(root);
  assert.ok(stream, "帧执行后渲染流式气泡");
  assert.match(stream.textContent, /abc/u, "帧渲染应取最新累积文本");
});

test("重连快照回放：投影含未达 delta 时回放不重复累积", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\novel");
  // 首次快照：应用 delta a、b（前端 lastSeq = 11）
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() }), [
    { ...ev("assistant_message_delta", { text: "a" }), seq: 10, event_id: "evt-10" },
    { ...ev("assistant_message_delta", { text: "b" }), seq: 11, event_id: "evt-11" }
  ]));
  await tick();
  // 断线重连快照：服务端投影已含 delta 1..3（assistant_text="abc"），回放 12..14
  surface.applySnapshot(snapshotOf(
    session({ status: "running", active_run: activeRun({ assistant_text: "abc" }) }),
    [
      { ...ev("assistant_message_delta", { text: "c" }), seq: 12, event_id: "evt-12" },
      { ...ev("assistant_message_delta", { text: "d" }), seq: 13, event_id: "evt-13" },
      { ...ev("assistant_message_completed", { input_id: "in-1", text: "abcd" }), seq: 14, event_id: "evt-14" }
    ]
  ));
  const finals = root.querySelectorAll('[data-testid="agent-assistant-message"]');
  assert.equal(finals.length, 1, "重连后终态气泡唯一");
  assert.match(finals[0].textContent, /abcd/u, "重放 delta 与实时一致，不与投影累积重复相加");
});

test("助手正文增量渲染 Markdown：粗体/代码/段落进入 innerHTML", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("assistant_message_delta", { text: "**重点** 与 `code`" }));
  await tick();
  const stream = streamBubble(root);
  assert.ok(stream, "delta 期间应显示流式气泡");
  assert.match(stream.querySelector(".agent-message-text").innerHTML, /<strong>重点<\/strong>/u, "粗体应渲染为 strong");
  assert.match(stream.querySelector(".agent-message-text").innerHTML, /<code>code<\/code>/u, "行内代码应渲染为 code");
  surface.applyEvent(ev("assistant_message_completed", { input_id: "in-1", text: "**重点** 与 `code`" }));
  const final = root.querySelector('[data-testid="agent-assistant-message"]');
  assert.match(final.querySelector(".agent-message-text").innerHTML, /<strong>重点<\/strong>/u, "终态消息同样渲染 Markdown");
});

test("assistant_message_completed 带 truncated → 消息卡渲染截断标记", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("assistant_message_completed", { input_id: "in-1", text: "半截正文", truncated: true }));
  const assistant = root.querySelector('[data-testid="agent-assistant-message"]');
  assert.ok(assistant, "Assistant 正文应渲染");
  assert.match(assistant.querySelector(".agent-message-text").textContent, /半截正文/u, "正文内容原样保留");
  const mark = root.querySelector('[data-testid="truncation-mark"]');
  assert.ok(mark, "截断标记元素应渲染");
  assert.match(mark.textContent, /输出被截断/u, "截断标记展示中文提示文案");
  assert.doesNotMatch(
    assistant.querySelector(".agent-message-text").textContent,
    /输出被截断/u,
    "标记文案不得混入正文文本区域"
  );
});

test("assistant_message_completed 无 truncated → 不渲染截断标记", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("assistant_message_completed", { input_id: "in-1", text: "完整正文" }));
  assert.ok(root.querySelector('[data-testid="agent-assistant-message"]'), "正文正常渲染");
  assert.equal(root.querySelector('[data-testid="truncation-mark"]'), null, "无 truncated 时不出现截断标记");
});

test("状态标记映射：running=• / completed=✓ / failed=✗ / cancelled=已停止", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  const iconOf = (activityId) => {
    const row = root.querySelector(`[data-item-id="tool:${activityId}"]`);
    return row?.querySelector(".agent-work-item__icon").textContent;
  };
  // running → •
  surface.applyEvent(toolStarted("a1", "shell", { command: "cmd" }));
  assert.equal(iconOf("a1"), "•", "运行中标记应为 •");
  surface.applyEvent(ev("tool_call_completed", {
    tool_call_id: "tc-a1", activity_id: "a1", name: "shell", exit_code: 0
  }));
  assert.equal(iconOf("a1"), "✓");
  // failed → ✗
  surface.applyEvent(toolStarted("a2", "shell", { command: "bad" }));
  surface.applyEvent(ev("tool_call_failed", {
    tool_call_id: "tc-a2", activity_id: "a2", name: "shell", error: "boom", message: "失败"
  }));
  assert.equal(iconOf("a2"), "✗");
  // cancelled（停止收敛）→ 已停止
  surface.applyEvent(toolStarted("a3", "shell", { command: "st" }));
  surface.applyEvent(ev("tool_call_failed", {
    tool_call_id: "tc-a3", activity_id: "a3", name: "shell", error: "tool_cancelled", message: "操作已停止。"
  }));
  assert.equal(iconOf("a3"), "已停止");
});

test("reasoning 不进入 Assistant 正文，但进入 reasoning 工作项", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("model_turn_started", { turn_id: "turn-1", input_id: "in-1", reasoning_capability: "supported" }));
  surface.applyEvent(ev("reasoning_delta", { turn_id: "turn-1", input_id: "in-1", text: "先检查事实，再回答。" }));
  surface.applyEvent(ev("reasoning_completed", {
    turn_id: "turn-1", input_id: "in-1",
    text: "先检查事实，再回答。", availability: "available"
  }));
  surface.applyEvent(ev("model_turn_completed", { turn_id: "turn-1", input_id: "in-1", outcome: "completed" }));
  surface.applyEvent(ev("assistant_message_completed", { input_id: "in-1", text: "最终回答" }));

  const assistantBodies = root.querySelectorAll('[data-testid="agent-assistant-message"]');
  assert.equal(assistantBodies.length, 1, "最终正文只渲染一条 Assistant 消息");
  assert.match(assistantBodies[0].textContent, /最终回答/u);
  assert.doesNotMatch(assistantBodies[0].textContent, /先检查事实/u, "reasoning 不得进入 Assistant 正文");

  // reasoning 必须进入独立 reasoning 工作项（Task 6 的 .agent-work-group 容器内）
  const workGroup = root.querySelector(".agent-work-group");
  assert.ok(workGroup, "应渲染工作组（reasoning 工作项所在容器）");
  assert.match(workGroup.textContent, /先检查事实，再回答。/u, "reasoning 全文进入 reasoning 工作项");
  // 最终回复位于 work group 之后（同一时间线容器）
  assert.ok(workGroup._parent === assistantBodies[0]._parent, "工作组与最终回复同属时间线");
  const timelineIndex = (el) => el._parent.children.indexOf(el);
  assert.ok(
    timelineIndex(workGroup) < timelineIndex(assistantBodies[0]),
    "最终回复位于 work group 之后"
  );
});

// ===========================================================================
// 工作组（Task 6）：reasoning/tool/plan 时间线 + Text Shimmer 唯一性
// ===========================================================================

test("reasoning 与 tool 同级；思考转工具时动效 class 转移", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("model_turn_started", { turn_id: "turn-1", input_id: "in-1", reasoning_capability: "supported" }));
  surface.applyEvent(ev("reasoning_delta", { turn_id: "turn-1", input_id: "in-1", text: "先检查事实。" }));
  const group = root.querySelector(".agent-work-group");
  let items = group.querySelectorAll(".agent-work-item");
  assert.equal(items.length, 1);
  assert.equal(items[0].dataset.kind, "reasoning");
  const reasoningRow = group.querySelector('[data-kind="reasoning"]');
  const reasoningLabel = reasoningRow.querySelector(".agent-work-item__label");
  assert.ok(reasoningLabel.classList.contains("agent-live-text"), "思考中 label 有动效");
  assert.match(reasoningRow.querySelector(".agent-reasoning-ticker").textContent, /先检查事实/u, "运行中摘要走 ticker");

  // 思考完成 → tool 开始：动效转移到 tool label，reasoning 展示持久化全文
  surface.applyEvent(ev("reasoning_completed", { turn_id: "turn-1", input_id: "in-1", text: "先检查事实。", availability: "available" }));
  assert.equal(reasoningLabel.classList.contains("agent-live-text"), false, "reasoning 完成后动效清零");
  assert.match(reasoningRow.querySelector(".agent-reasoning-detail").textContent, /先检查事实/u, "详情使用持久化全文");
  surface.applyEvent(toolStarted("t1", "read_file", { path: "chapter.md" }));
  items = group.querySelectorAll(".agent-work-item");
  assert.equal(items.length, 2, "tool 与 reasoning 同级（兄弟节点）");
  assert.deepEqual([...items].map((el) => el.dataset.kind), ["reasoning", "tool"], "无「思考」父容器");
  const toolRow = group.querySelector('[data-kind="tool"]');
  const toolLabel = toolRow.querySelector(".agent-work-item__label");
  assert.ok(toolLabel.classList.contains("agent-live-text"), "tool 运行中 label 有动效");
  assert.equal(group.querySelector(".agent-work-status").classList.contains("agent-live-text"), false, "展开时外层「工作中」静态");
  // tool 终态 → 动效清零
  surface.applyEvent(ev("tool_call_completed", { tool_call_id: "tc-t1", activity_id: "t1", name: "read_file" }));
  assert.equal(toolLabel.classList.contains("agent-live-text"), false, "tool 终态动效清零");
});

test("折叠工作组时隐藏子项失去动效，外层成为唯一代理；toggle 立即重应用", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(toolStarted("t1", "read_file", { path: "chapter.md" }));
  const group = root.querySelector(".agent-work-group");
  const status = group.querySelector(".agent-work-status");
  const toolRow = group.querySelector('[data-kind="tool"]');
  const label = toolRow.querySelector(".agent-work-item__label");
  assert.ok(label.classList.contains("agent-live-text"), "展开时开放子项有动效");
  assert.equal(status.classList.contains("agent-live-text"), false, "展开时外层静态");
  // 用户折叠（真实 DOM 由 details 原生 toggle）
  group.open = false;
  group._fire("toggle");
  assert.equal(label.classList.contains("agent-live-text"), false, "折叠后隐藏子项不动效");
  assert.ok(status.classList.contains("agent-live-text"), "折叠后外层成为唯一代理");
  // 展开恢复
  group.open = true;
  group._fire("toggle");
  assert.ok(label.classList.contains("agent-live-text"));
  assert.equal(status.classList.contains("agent-live-text"), false);
});

test("两个不同 activity_id 的开放 tool 才允许两个 label 同时动效", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(toolStarted("t1", "read_file", { path: "a.md" }));
  surface.applyEvent(toolStarted("t2", "shell", { command: "npm test" }));
  const group = root.querySelector(".agent-work-group");
  const labels = [...group.querySelectorAll('[data-kind="tool"]')]
    .map((row) => row.querySelector(".agent-work-item__label"));
  assert.equal(labels.length, 2, "两个真实 tool 行");
  assert.ok(labels.every((el) => el.classList.contains("agent-live-text")), "两个开放 tool 同时动效");
  assert.equal(group.querySelector(".agent-work-status").classList.contains("agent-live-text"), false, "展开时外层不动");
});

test("waiting_user 与 Run 终态时无任何动效 class", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(toolStarted("t1", "read_file", { path: "a.md" }));
  assert.equal(root.querySelectorAll(".agent-live-text").length, 1, "运行中恰好一个动效目标");
  surface.applyEvent(ev("run_status_changed", { status: "waiting_user" }));
  assert.equal(root.querySelectorAll(".agent-live-text").length, 0, "waiting_user 全部静态");
  surface.applyEvent(ev("run_status_changed", { status: "running" }));
  assert.equal(root.querySelectorAll(".agent-live-text").length, 1, "恢复 running 后重新动效");
  surface.applyEvent(ev("run_completed", {}));
  assert.equal(root.querySelectorAll(".agent-live-text").length, 0, "Run 终态全部静态");
});

test("interrupted 工作组显示英文终态文案 Interrupted by the user（Task 11）", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("run_started", { workflow: "general", input_id: "in-1" }));
  surface.applyEvent(ev("model_turn_started", { turn_id: "turn-1", input_id: "in-1", reasoning_capability: "supported" }));
  surface.applyEvent(ev("reasoning_completed", { turn_id: "turn-1", input_id: "in-1", text: "已完成的分析", availability: "available" }));
  surface.applyEvent(ev("run_interrupted", { reason: "recovery_dangling" }));
  const group = root.querySelector(".agent-work-group");
  assert.ok(group, "有 reasoning 工作项时渲染工作组");
  assert.equal(
    group.querySelector(".agent-work-status").textContent,
    "Interrupted by the user",
    "被截断的执行组显示英文固定文案"
  );
  assert.match(
    group.querySelector(".agent-reasoning-detail").textContent,
    /已完成的分析/u,
    "已完整返回的 reasoning 保持正常完成，不伪装中断"
  );
});

test("tool 失败：失败 icon 与「失败」短状态词独立着色，不落在整行", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(toolStarted("t1", "read_file", { path: "chapter.md" }));
  surface.applyEvent(ev("tool_call_failed", {
    tool_call_id: "tc-t1", activity_id: "t1", name: "read_file", error: "boom", message: "目录不存在"
  }));
  const row = root.querySelector('[data-kind="tool"]');
  assert.equal(row.dataset.state, "failed");
  assert.equal(row.querySelector(".agent-work-item__icon").textContent, "✗");
  assert.equal(row.querySelector(".agent-work-item__icon").dataset.state, "failed");
  const stateWord = row.querySelector(".agent-work-item__state");
  assert.ok(stateWord, "「失败」是独立短状态词 span");
  assert.equal(stateWord.textContent, "失败");
  assert.match(row.querySelector(".agent-work-item__meta").textContent, /目录不存在/u, "错误说明保留");
  assert.equal(row.querySelector(".agent-work-item__label").classList.contains("agent-live-text"), false, "终态无动效");
  assert.doesNotMatch(row.className, /--(success|danger)/u, "整行容器不承载状态色 class");
});

test("tool 成功：完成 icon 单独承载成功标记，label 恢复静态", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(toolStarted("t1", "read_file", { path: "chapter.md" }));
  surface.applyEvent(ev("tool_call_completed", { tool_call_id: "tc-t1", activity_id: "t1", name: "read_file", exit_code: 0 }));
  const row = root.querySelector('[data-kind="tool"]');
  assert.equal(row.querySelector(".agent-work-item__icon").textContent, "✓");
  assert.equal(row.querySelector(".agent-work-item__icon").dataset.state, "completed");
  assert.equal(row.querySelector(".agent-work-item__label").textContent, "已读取文件");
  assert.equal(row.querySelector(".agent-work-item__label").classList.contains("agent-live-text"), false);
});

test("reasoning 详情兜底：available 全文 / unsupported / empty 文案", async () => {
  const runScenario = async (availability, deltaText, finalText) => {
    const { root, surface } = await makeSurface();
    await surface.openProject("D:\\novel");
    surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
    surface.applyEvent(ev("model_turn_started", { turn_id: `turn-${availability}`, input_id: "in-1", reasoning_capability: "supported" }));
    if (deltaText) surface.applyEvent(ev("reasoning_delta", { turn_id: `turn-${availability}`, input_id: "in-1", text: deltaText }));
    surface.applyEvent(ev("reasoning_completed", { turn_id: `turn-${availability}`, input_id: "in-1", text: finalText ?? "", availability }));
    const detail = root.querySelector(".agent-reasoning-detail");
    assert.equal(detail.hidden, false, "完成后详情可见");
    return detail.textContent;
  };
  assert.match(await runScenario("available", "完整思考内容。", "完整思考内容。"), /完整思考内容。/u);
  assert.equal(await runScenario("unsupported", null, ""), "当前模型不支持查看");
  assert.equal(await runScenario("empty", null, ""), "本次没有可查看的思考内容");
});

test("工作组 duration 运行中由工作组投影时钟驱动，waiting_user 暂停", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  // 增量事件路径：run_started 增量投影不含 active_elapsed_ms/active_since（回归源），
  // 时钟必须来自事件 at 驱动的工作组投影（group.activeMs + (now - activeSince)）。
  const startAt = new Date(Date.now() - 3000).toISOString();
  surface.applyEvent(ev("run_started", { workflow: "general", input_id: "in-1" }, { at: startAt }));
  surface.applyEvent(ev("model_turn_started", { turn_id: "turn-1", input_id: "in-1", reasoning_capability: "supported" }, { at: startAt }));
  const duration = root.querySelector(".agent-work-duration");
  assert.match(duration.textContent, /3 秒/u, "运行中耗时 = 工作组时钟（now − activeSince ≈ 3 秒），不再是 0 秒");
  // waiting_user：离开 active → activeMs 冻结、activeSince 置空，不再增量
  surface.applyEvent(ev("run_status_changed", { status: "waiting_user" }, { at: new Date(Date.now() - 1000).toISOString() }));
  assert.equal(duration.textContent, "2 秒", "waiting_user 暂停在离开 active 时刻（2s = 3000ms − 1000ms）");
  // Task 8：waiting_user 工作组文案与侧边栏 RUN_STATUS_LABELS 口径一致（待命），
  // 不再是误导性的「工作中」
  assert.equal(
    root.querySelector(".agent-work-status").textContent,
    "待命",
    "waiting_user 工作组状态文案应为「待命」（与 session-sidebar RUN_STATUS_LABELS 统一）"
  );
});

test("工具详情行：整行可点击展开/收起，去掉独立「详情」summary", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(toolStarted("a1", "shell", {
    command: "npm test", cwd: "D:\\Book",
    timeout_ms: 120000, purpose: "跑测试"
  }));
  surface.applyEvent(outputDelta("a1", "line1\n"));
  const row = root.querySelector('[data-item-id="tool:a1"]');
  assert.ok(row, "工具工作项应存在");
  assert.equal(row.querySelector("details"), null, "不再使用 details/summary 控件");
  assert.equal(row.querySelector(".agent-tool-details").tagName, "div", "详情改为 div");
  assert.equal(row.getAttribute("role"), "button", "整行 role=button");
  assert.equal(row.getAttribute("aria-expanded"), "false", "默认收起");
  const output = row.querySelector(".agent-tool-output");
  assert.ok(output, "输出是唯一 .agent-tool-output");
  assert.equal(output.textContent, "line1\n");
  assert.match(row.textContent, /npm test/u);
  assert.match(row.textContent, /D:\\Book/u);
  assert.equal(output.hidden, true, "收起时输出不可见");
  row._fire("click");
  assert.equal(row.getAttribute("aria-expanded"), "true", "点击整行展开");
  assert.equal(output.hidden, false, "展开后输出可见");
  row._fire("keydown", { key: "Enter", preventDefault: () => {} });
  assert.equal(row.getAttribute("aria-expanded"), "false", "Enter 再次收起");
  assert.equal(output.hidden, true, "收起后输出隐藏");
  // 内容区（字段/输出）点击不触发收起：MockElement 无 closest，用假 target 驱动守卫
  row._fire("click", { target: { closest: () => row.querySelector(".agent-tool-details") } });
  assert.equal(row.getAttribute("aria-expanded"), "false", "点击详情区不切换折叠态");
});

test("工具详情字段顺序：参数 → 命令 → 目录 → 退出码 → 耗时；失败工具 → 错误 在最后", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  // 成功 shell 工具：参数/命令/目录（开始）→ 退出码/耗时（完成）
  surface.applyEvent(toolStarted("a1", "shell", { command: "npm test", cwd: "D:\\Book" }));
  surface.applyEvent(outputDelta("a1", "out\n"));
  surface.applyEvent(ev("tool_call_completed", {
    tool_call_id: "tc-a1", activity_id: "a1", name: "shell",
    exit_code: 0, duration_ms: 35
  }));
  // 失败工具：参数/命令/目录 → 耗时 → 错误（退出码不出现，错误排最后）
  surface.applyEvent(toolStarted("a2", "shell", { command: "bad cmd", cwd: "D:\\Book" }));
  surface.applyEvent(ev("tool_call_failed", {
    tool_call_id: "tc-a2", activity_id: "a2", name: "shell",
    error: "exit_nonzero", message: "命令退出码非 0", duration_ms: 42
  }));
  const namesOf = (activityId) => {
    const row = root.querySelector(`[data-item-id="tool:${activityId}"]`);
    return [...row.querySelectorAll(".agent-tool-field")].map((el) => el.querySelector("strong").textContent);
  };
  assert.deepEqual(namesOf("a1"), ["参数", "命令", "目录", "退出码", "耗时"], "成功工具字段顺序固定");
  assert.deepEqual(namesOf("a2"), ["参数", "命令", "目录", "耗时", "错误"], "失败工具错误字段排最后");
  const row2 = root.querySelector('[data-item-id="tool:a2"]');
  assert.match(row2.querySelector(".agent-work-item__icon").textContent, /✗/u);
  assert.match(row2.textContent, /命令退出码非 0/u);
});

test("I-2 输出上限：超过 64 KiB 截断保留尾部并前置提示，后续增量继续追加", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(toolStarted("a1", "shell", { command: "long run" }));
  const big = "y".repeat(70 * 1024) + "TAIL-END-123";
  surface.applyEvent(outputDelta("a1", big));
  const row = root.querySelector('[data-item-id="tool:a1"]');
  const output = row.querySelector(".agent-tool-output");
  assert.match(output.textContent, /输出过长已截断/u, "超限后应出现截断提示");
  assert.ok(output.textContent.endsWith("TAIL-END-123"), "截断保留尾部内容");
  assert.ok(output.textContent.length <= 64 * 1024 + 40, "总长不超过上限 + 提示长度");
  surface.applyEvent(outputDelta("a1", "more-tail"));
  assert.ok(output.textContent.endsWith("more-tail"), "后续增量继续追加在尾部");
  assert.match(output.textContent, /输出过长已截断/u, "截断提示持续存在");
  surface.applyEvent(outputDelta("a1", "z".repeat(66000)));
  assert.ok(!output.textContent.includes("TAIL-END-123"), "超限后最老内容被挤掉");
  assert.ok(output.textContent.endsWith("z"), "保留窗口始终是最新尾部");
});

test("非 Agent 事件类型被忽略（不崩溃、不渲染）", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applyEvent({ type: "bogus_event", seq: 1, payload: {} });
  surface.applyEvent(null);
  assert.equal(root.querySelectorAll(".agent-work-item").length, 0);
});

// ===========================================================================
// 确认：普通三选 / extreme 精确文字 / 终态锁定
// ===========================================================================

test("普通确认卡：一次允许 / 本条输入允许同类操作 / 拒绝", async () => {
  const { root, api, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("decision_requested", {
    decision_id: "dec-1", activity_id: "a1", input_id: "in-1",
    tool_call_id: "tc-a1", name: "write_file", kind: "normal",
    title: "写入文件", description: "修改 chapter.md",
    confirmation_text: null, fingerprint: "fp"
  }));
  const card = root.querySelector('[data-decision-id="dec-1"]');
  assert.ok(card, "应渲染决策卡");
  assert.match(card.textContent, /写入文件/u);
  assert.match(card.textContent, /修改 chapter.md/u);
  const choices = card.querySelectorAll('[data-testid="agent-decision-choice"]');
  assert.equal(choices.length, 3);
  assert.deepEqual([...choices].map((b) => b.textContent), ["一次允许", "本条输入允许同类操作", "拒绝"]);
  choices[0]._fire("click");
  choices[1]._fire("click");
  choices[2]._fire("click");
  assert.deepEqual(api.calls.filter((c) => c[0] === "decide").map((c) => c.slice(1)), [
    ["dec-1", "allow"],
    ["dec-1", "allow_input"],
    ["dec-1", "deny"]
  ]);
});

test("extreme 确认卡：红色、精确文字输入前执行禁用；输入精确文字后可执行", async () => {
  const { root, api, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("decision_requested", {
    decision_id: "dec-x", activity_id: "a1", input_id: "in-1",
    tool_call_id: "tc-a1", name: "shell", kind: "extreme",
    title: "删除项目外文件", description: null,
    confirmation_text: "强制继续 ABC12301", fingerprint: "fp"
  }));
  const card = root.querySelector('[data-decision-id="dec-x"]');
  assert.ok(card.className.includes("agent-decision--extreme"), "extreme 卡应有红色样式");
  assert.match(card.textContent, /强制继续 ABC12301/u, "应展示当前确认文字");
  const input = card.querySelector('[data-testid="agent-decision-input"]');
  const execute = card.querySelector('[data-testid="agent-decision-execute"]');
  assert.equal(execute.disabled, true, "未输入前执行按钮禁用");
  input.value = "强制继续 ABC12";
  input._fire("input");
  assert.equal(execute.disabled, true, "部分匹配仍禁用");
  input.value = "强制继续 ABC12301";
  input._fire("input");
  assert.equal(execute.disabled, false, "精确匹配后可执行");
  execute._fire("click");
  assert.deepEqual(api.calls.filter((c) => c[0] === "decide").map((c) => c.slice(1)), [
    ["dec-x", "强制继续 ABC12301"]
  ]);
  // 拒绝路径同样可用
  card.querySelector('[data-testid="agent-decision-deny"]')._fire("click");
  assert.deepEqual(api.calls.filter((c) => c[0] === "decide").map((c) => c.slice(1)), [
    ["dec-x", "强制继续 ABC12301"],
    ["dec-x", "deny"]
  ]);
});

test("终态 decision 锁定：resolved/superseded 后卡片消失，不再可操作", async () => {
  const { root, api, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("decision_requested", {
    decision_id: "dec-1", activity_id: "a1", input_id: "in-1",
    tool_call_id: "tc-a1", name: "write_file", kind: "normal",
    title: "写入文件", confirmation_text: null, fingerprint: "fp"
  }));
  surface.applyEvent(ev("decision_requested", {
    decision_id: "dec-2", activity_id: "a2", input_id: "in-2",
    tool_call_id: "tc-a2", name: "edit_file", kind: "normal",
    title: "修改文件", confirmation_text: null, fingerprint: "fp"
  }));
  assert.equal(root.querySelectorAll('[data-testid="agent-decision-card"]').length, 2);
  surface.applyEvent(ev("decision_resolved", {
    decision_id: "dec-1", activity_id: "a1", input_id: "in-1", choice: "superseded"
  }));
  assert.equal(root.querySelector('[data-decision-id="dec-1"]'), null, "终态 decision 卡应消失");
  assert.equal(root.querySelectorAll('[data-testid="agent-decision-card"]').length, 1);
  // 旧 decision id 不能应用到更新的待决动作：dec-1 已终态，仅 dec-2 可操作
  const card2 = root.querySelector('[data-decision-id="dec-2"]');
  card2.querySelector('[data-testid="agent-decision-choice"]')._fire("click");
  assert.deepEqual(api.calls.filter((c) => c[0] === "decide").map((c) => c.slice(1)), [
    ["dec-2", "allow"]
  ]);
  // Run 终态（stop 收敛 decision=已停止）：全部卡片下架
  surface.applyEvent(ev("decision_resolved", {
    decision_id: "dec-2", activity_id: "a2", input_id: "in-2", choice: "cancelled"
  }));
  surface.applyEvent(ev("run_cancelled", { reason: "user_stop" }));
  assert.equal(root.querySelectorAll('[data-testid="agent-decision-card"]').length, 0);
});

test("extreme 卡不被重建：兄弟 decision 终结后输入文字与执行状态保留", async () => {
  const { root, api, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  for (const [id, title, text] of [
    ["dec-x1", "删除项目外文件", "强制继续 AAA11101"],
    ["dec-x2", "删除备份", "强制继续 BBB22202"]
  ]) {
    surface.applyEvent(ev("decision_requested", {
      decision_id: id, activity_id: `a-${id}`, input_id: "in-1",
      tool_call_id: `tc-${id}`, name: "shell", kind: "extreme",
      title, description: null, confirmation_text: text, fingerprint: "fp"
    }));
  }
  // 用户在 dec-x2 输入精确确认文字（执行已可用）
  const card2 = root.querySelector('[data-decision-id="dec-x2"]');
  const input2 = card2.querySelector('[data-testid="agent-decision-input"]');
  input2.value = "强制继续 BBB22202";
  input2._fire("input");
  assert.equal(card2.querySelector('[data-testid="agent-decision-execute"]').disabled, false);
  // dec-x1 被终结（superseded）→ 触发 decisions revision 提升
  surface.applyEvent(ev("decision_resolved", {
    decision_id: "dec-x1", activity_id: "a-dec-x1", input_id: "in-1", choice: "superseded"
  }));
  assert.equal(root.querySelector('[data-decision-id="dec-x1"]'), null, "终态卡应消失");
  // dec-x2 的卡不得被重建：输入文字与执行状态保留
  const card2b = root.querySelector('[data-decision-id="dec-x2"]');
  const input2b = card2b.querySelector('[data-testid="agent-decision-input"]');
  assert.equal(input2b, input2, "未终结的 extreme 卡不应被重建");
  assert.equal(input2b.value, "强制继续 BBB22202", "输入文字应保留");
  assert.equal(card2b.querySelector('[data-testid="agent-decision-execute"]').disabled, false, "执行按钮仍可用");
  card2b.querySelector('[data-testid="agent-decision-execute"]')._fire("click");
  assert.deepEqual(api.calls.filter((c) => c[0] === "decide").map((c) => c.slice(1)), [
    ["dec-x2", "强制继续 BBB22202"]
  ]);
});

test("重试防连点：连点只触发一次；请求失败后恢复可点", async () => {
  const { root, api, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("run_failed", { error: "模型超时", code: "model_timeout", input_id: "in-1" }));
  const retry = root.querySelector('[data-testid="agent-retry"]');
  retry._fire("click");
  retry._fire("click");
  retry._fire("click");
  await tick();
  assert.equal(api.calls.filter((c) => c[0] === "retry").length, 1, "连点只触发一次 retry");
  assert.equal(retry.disabled, true, "点击后禁用（成功路径由 run_started 重建头部）");
  // 成功恢复同 run：重试按钮消失，Run 回到运行中
  surface.applyEvent(ev("run_started", { workflow: "general", input_id: "in-1" }, { run_id: "run-1" }));
  assert.equal(root.querySelector('[data-testid="agent-retry"]'), null);
});

test("重试失败（拒绝）时按钮恢复可点", async () => {
  const { root, api, surface } = await makeSurface({
    apiOverrides: {
      retry: async (runId) => { api.calls.push(["retry", runId]); throw new Error("409"); },
    }
  });
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("run_failed", { error: "模型超时", code: "model_timeout", input_id: "in-1" }));
  const retry = root.querySelector('[data-testid="agent-retry"]');
  retry._fire("click");
  await tick();
  assert.equal(retry.disabled, false, "retry 请求失败后按钮应恢复可点");
  assert.equal(api.calls.filter((c) => c[0] === "retry").length, 1);
});

test("search_files 工具工作项：query 不进入标签，仅泛化文案；非法 args 不崩溃", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  const toolLabel = () => {
    const row = [...root.querySelectorAll(".agent-work-item")].find((el) => el.dataset.kind === "tool");
    return row?.querySelector(".agent-work-item__label").textContent;
  };
  surface.applyEvent(toolStarted("a1", "search_files", { query: "雨夜" }));
  assert.equal(toolLabel(), "正在搜索文件", "query 细节不进入工具标签");
  // 非对象 args（旧字符串化摘要）由投影归一化为空对象：不崩溃、回退泛化标签
  surface.applyEvent(toolStarted("a2", "search_files", "{broken"));
  assert.equal(toolLabel(), "正在搜索文件");
});

test("对话容器带 aria-live 区域（可访问性）", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  const conv = root.querySelector('[data-testid="agent-conversation"]');
  assert.equal(conv.getAttribute("role"), "log");
  assert.equal(conv.getAttribute("aria-live"), "polite");
});

test("input_withdrawn 移除排队项；撤回输入在 UI 不可见", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("input_queued", { input_id: "in-2", text: "排队A", source: "chat" }));
  surface.applyEvent(ev("input_queued", { input_id: "in-3", text: "排队B", source: "chat" }));
  assert.equal(root.querySelectorAll('[data-testid="agent-queue-item"]').length, 2);
  assert.equal(root.querySelectorAll('[data-testid="agent-user-message"]').length, 0, "queued 不生成正式对话气泡");
  // 撤回排队输入：从「接下来」区域移除，不产生对话气泡、不进入历史
  surface.applyEvent(ev("input_withdrawn", { input_id: "in-2" }));
  assert.equal(root.querySelectorAll('[data-testid="agent-queue-item"]').length, 1);
  assert.ok(root.querySelector('[data-input-id="in-3"]').textContent.includes("排队B"));
  assert.equal(root.querySelectorAll('[data-testid="agent-user-message"]').length, 0, "撤回输入在 UI 不可见");
  surface.applyEvent(ev("input_withdrawn", { input_id: "in-3" }));
  assert.equal(root.querySelectorAll('[data-testid="agent-queue-item"]').length, 0);
  assert.equal(root.querySelector('[data-testid="agent-queue"]').textContent, "", "空队列不留占位文本");
  // 撤回不改动活动 Run：停止按钮保留
  assert.ok(root.querySelector('[data-testid="agent-stop"]'), "撤回排队输入后 Run 仍活动");
});

test("queued 只出现在「接下来」：input_queued 不生成正式对话气泡，input_started 才生成用户气泡", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("input_queued", { input_id: "in-2", text: "排队消息", source: "chat" }));
  assert.equal(root.querySelectorAll('[data-testid="agent-user-message"]').length, 0, "queued 不提前渲染为正式对话气泡");
  assert.equal(root.querySelectorAll('[data-testid="agent-queue-item"]').length, 1, "queued 只出现在「接下来」");
  assert.match(root.querySelector('[data-testid="agent-queue-item"]').textContent, /排队消息/u);
  surface.applyEvent(ev("input_started", { input_id: "in-2" }));
  assert.equal(root.querySelectorAll('[data-testid="agent-user-message"]').length, 1, "input_started 是用户文本进入对话的唯一边界");
  assert.match(root.querySelector('[data-testid="agent-user-message"]').textContent, /排队消息/u);
  assert.equal(root.querySelectorAll('[data-testid="agent-queue-item"]').length, 0, "开始后离开「接下来」");
});

test("priority pending 时所有「立即」禁用，目标项标为下一条；input_started 后恢复", async () => {
  const { root, api, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("input_queued", { input_id: "in-2", text: "排队A", source: "chat" }));
  surface.applyEvent(ev("input_queued", { input_id: "in-3", text: "排队B", source: "chat" }));
  const promoteOf = (inputId) =>
    root.querySelector(`[data-input-id="${inputId}"]`).querySelector('[data-testid="agent-promote"]');
  assert.equal(promoteOf("in-2").disabled, false);
  assert.equal(promoteOf("in-3").disabled, false);
  // 第一次「立即」被接受 → priority_input_requested（以事件为准，不做乐观第二请求）
  surface.applyEvent(ev("priority_input_requested", { input_id: "in-2" }));
  assert.equal(promoteOf("in-2").disabled, true, "目标项「立即」禁用（已在途）");
  assert.equal(promoteOf("in-3").disabled, true, "其余「立即」全部禁用");
  const row2 = root.querySelector('[data-input-id="in-2"]');
  assert.ok(row2.classList.contains("agent-queue-item--next"), "目标项标为下一条");
  assert.match(row2.textContent, /下一条/u);
  assert.doesNotMatch(root.querySelector('[data-input-id="in-3"]').textContent, /下一条/u);
  // 禁用期间点击不得发出第二请求
  promoteOf("in-2")._fire("click");
  assert.equal(api.calls.filter((c) => c[0] === "requestPriority").length, 0, "禁用期间点击不得发起请求");
  // priority 真正开始 → 恢复
  surface.applyEvent(ev("input_started", { input_id: "in-2" }));
  assert.equal(root.querySelectorAll('[data-testid="agent-queue-item"]').length, 1);
  assert.equal(promoteOf("in-3").disabled, false, "优先输入开始后其余「立即」恢复");
  assert.equal(root.querySelectorAll('[data-testid="agent-queue-item"]')[0].textContent.includes("排队B"), true);
});

test("快照投影 priority_input_id 同样驱动「立即」禁用（以 snapshot/event 为准）", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({
    status: "running",
    active_run: activeRun(),
    priority_input_id: "in-2",
    queued_inputs: [
      { id: "in-2", text: "目标", status: "queued", queued_at: "2026-08-06T00:00:00.000Z" },
      { id: "in-3", text: "其他", status: "queued", queued_at: "2026-08-06T00:00:00.000Z" }
    ]
  })));
  const buttons = [...root.querySelectorAll('[data-testid="agent-promote"]')];
  assert.equal(buttons.length, 2);
  assert.ok(buttons.every((b) => b.disabled === true), "快照 priority pending 时全部「立即」禁用");
  const nextRow = root.querySelector('[data-input-id="in-2"]');
  assert.ok(nextRow.classList.contains("agent-queue-item--next"), "快照同样标出目标项为下一条");
});

test("撤回成功：composer 为空时撤回文本直接填入", async () => {
  const { root, api, surface } = await makeSurface({
    apiOverrides: {
      withdrawInput: async (inputId) => {
        api.calls.push(["withdrawInput", inputId]);
        return { ok: true, withdrawn: true, draft_text: "被撤回的文本" };
      }
    }
  });
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("input_queued", { input_id: "in-2", text: "被撤回的文本", source: "chat" }));
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  assert.equal(input.value, "", "初始为空");
  root.querySelector('[data-testid="agent-withdraw"]')._fire("click");
  await tick();
  assert.deepEqual(api.calls.filter((c) => c[0] === "withdrawInput").map((c) => c[1]), ["in-2"]);
  assert.equal(input.value, "被撤回的文本", "composer 为空：撤回文本直接填入");
});

test("撤回成功：已有 draft 时以 draft + 换行 + 撤回文本追加，绝不覆盖", async () => {
  const { root, api, surface } = await makeSurface({
    apiOverrides: {
      withdrawInput: async (inputId) => {
        api.calls.push(["withdrawInput", inputId]);
        return { ok: true, withdrawn: true, draft_text: "被撤回的文本" };
      }
    }
  });
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("input_queued", { input_id: "in-2", text: "被撤回的文本", source: "chat" }));
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  input.value = "已有草稿";
  root.querySelector('[data-testid="agent-withdraw"]')._fire("click");
  await tick();
  assert.equal(input.value, "已有草稿\n被撤回的文本", "已有草稿时按换行追加，不得覆盖");
});

test("撤回失败：composer 草稿与排队 UI 保持原状，显示 toast", async () => {
  const { root, api, surface } = await makeSurface({
    apiOverrides: {
      withdrawInput: async (inputId) => {
        api.calls.push(["withdrawInput", inputId]);
        throw new Error("网络错误");
      }
    }
  });
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("input_queued", { input_id: "in-2", text: "排队消息", source: "chat" }));
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  input.value = "我的草稿";
  root.querySelector('[data-testid="agent-withdraw"]')._fire("click");
  await tick();
  assert.equal(input.value, "我的草稿", "撤回失败草稿保持原状");
  assert.equal(root.querySelectorAll('[data-testid="agent-queue-item"]').length, 1, "撤回失败排队项保持（以事件为准）");
  const toast = root.querySelector('[data-testid="agent-toast"]');
  assert.ok(toast, "撤回失败应显示 toast");
  assert.match(toast.textContent, /撤回失败/u);
  surface.destroy(); // toast 3s 计时器随 destroy 清理，不泄漏
});

test("requestPriority 失败（409 priority_pending）：显示 toast，无 unhandled rejection", async () => {
  const { root, api, surface } = await makeSurface({
    apiOverrides: {
      requestPriority: async (inputId) => {
        api.calls.push(["requestPriority", inputId]);
        const error = new Error("已有优先输入在途，请等待当前优先输入开始或撤回。");
        error.code = "priority_pending";
        error.status = 409;
        throw error;
      }
    }
  });
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("input_queued", { input_id: "in-2", text: "排队消息", source: "chat" }));
  root.querySelector('[data-testid="agent-promote"]')._fire("click");
  await tick();
  assert.deepEqual(api.calls.filter((c) => c[0] === "requestPriority").map((c) => c[1]), ["in-2"]);
  const toast = root.querySelector('[data-testid="agent-toast"]');
  assert.ok(toast, "优先请求失败应显示 toast（双击/双窗口竞态也有可见反馈）");
  assert.match(toast.textContent, /已在优先处理中/u);
  assert.equal(root.querySelectorAll('[data-testid="agent-queue-item"]').length, 1, "失败后排队项保持（以事件为准）");
  surface.destroy(); // toast 3s 计时器随 destroy 清理，不泄漏
});

test("撤回在途切走会话：迟到的撤回文本不得写入新项目 composer（viewGeneration 守卫）", async () => {
  let releaseWithdraw;
  const gate = new Promise((resolve) => { releaseWithdraw = resolve; });
  const { root, api, surface } = await makeSurface({
    apiOverrides: {
      withdrawInput: async () => {
        api.calls.push(["withdrawInput"]);
        return gate;
      }
    }
  });
  await surface.openProject("D:\\novel-a");
  surface.applySnapshot(snapshotOf(session({ session_id: "sess-a", status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("input_queued", { input_id: "in-2", text: "排队消息", source: "chat" }));
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  root.querySelector('[data-testid="agent-withdraw"]')._fire("click");
  await tick();
  // 撤回在途：切换到新会话（view.reset 递增 viewGeneration）
  await surface.switchSession("sess-b");
  assert.equal(input.value, "", "切走后输入框已重置");
  releaseWithdraw({ ok: true, withdrawn: true, draft_text: "旧项目的撤回文本" });
  await tick();
  await tick();
  assert.equal(input.value, "", "旧项目的撤回文本不得写入新项目 composer");
  assert.equal(root.querySelector('[data-testid="agent-toast"]'), null, "旧项目迟到成功不得弹 toast");
  surface.destroy();
});

test("撤回在途切走会话：迟到的失败不在新视图弹 toast（viewGeneration 守卫）", async () => {
  let rejectWithdraw;
  const gate = new Promise((_resolve, reject) => { rejectWithdraw = reject; });
  const { root, api, surface } = await makeSurface({
    apiOverrides: {
      withdrawInput: async () => {
        api.calls.push(["withdrawInput"]);
        return gate;
      }
    }
  });
  await surface.openProject("D:\\novel-a");
  surface.applySnapshot(snapshotOf(session({ session_id: "sess-a", status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("input_queued", { input_id: "in-2", text: "排队消息", source: "chat" }));
  root.querySelector('[data-testid="agent-withdraw"]')._fire("click");
  await tick();
  await surface.switchSession("sess-b");
  rejectWithdraw(new Error("网络错误"));
  await tick();
  await tick();
  assert.equal(root.querySelector('[data-testid="agent-toast"]'), null, "旧项目的迟到失败不得在新视图弹 toast");
  surface.destroy();
});

// ===========================================================================
// 滚动锁（Task 7）：显式 follow 状态 + 回到最新；重建不打断阅读更早内容
// ===========================================================================

test("滚动锁：距底部 ≤48px 时增量事件自动跟随到底部", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  const conv = root.querySelector('[data-testid="agent-conversation"]');
  const latest = root.querySelector('[data-testid="agent-scroll-latest"]');
  assert.ok(latest, "应有「回到最新」按钮");
  assert.equal(latest.hidden, true, "初始处于 follow 模式，按钮隐藏");
  conv.scrollHeight = 500;
  conv.clientHeight = 200;
  conv.scrollTop = 295; // 距底部 5px < 阈值
  conv._fire("scroll");
  assert.equal(latest.hidden, true, "近底部时按钮保持隐藏");
  surface.applyEvent(toolStarted("a1", "shell", { command: "npm test" }));
  assert.equal(conv.scrollTop, 300, "距底部 ≤48px 时新事件应跟随到底部");
});

test("滚动锁：用户上滚后保持 scrollTop 并出现「回到最新」", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  const conv = root.querySelector('[data-testid="agent-conversation"]');
  const latest = root.querySelector('[data-testid="agent-scroll-latest"]');
  conv.scrollHeight = 500;
  conv.clientHeight = 200;
  conv.scrollTop = 0; // 用户上滚阅读更早内容
  conv._fire("scroll");
  assert.equal(latest.hidden, false, "离开底部后应显示「回到最新」");
  assert.equal(conv.scrollTop, 0);
  surface.applyEvent(toolStarted("a1", "shell", { command: "npm test" }));
  assert.equal(conv.scrollTop, 0, "用户阅读更早内容时新事件不得抢滚动");
  assert.equal(latest.hidden, false, "按钮持续可见直到用户回到最新");
});

test("回到最新位于会话与输入框之间，不覆盖滚动内容", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  const conversation = root.querySelector('[data-testid="agent-conversation"]');
  const latest = root.querySelector('[data-testid="agent-scroll-latest"]');
  const composer = root.querySelector('[data-testid="agent-composer"]');
  const surfaceElement = root.children[0];

  assert.notEqual(latest._parent, conversation, "回到最新不能作为会话滚动内容的覆盖层");
  assert.ok(
    surfaceElement.children.indexOf(latest) < surfaceElement.children.indexOf(composer),
    "回到最新应放在会话和输入框之间"
  );
});

test("滚动锁：点击「回到最新」滚到底部并恢复 follow 模式", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  const conv = root.querySelector('[data-testid="agent-conversation"]');
  const latest = root.querySelector('[data-testid="agent-scroll-latest"]');
  conv.scrollHeight = 500;
  conv.clientHeight = 200;
  conv.scrollTop = 0;
  conv._fire("scroll");
  assert.equal(latest.hidden, false);
  latest._fire("click");
  assert.equal(conv.scrollTop, 300, "点击后应滚到底部");
  assert.equal(latest.hidden, true, "回到最新后按钮隐藏");
  surface.applyEvent(toolStarted("a2", "shell", { command: "npm test 2" }));
  assert.equal(conv.scrollTop, 300, "恢复 follow 后增量事件继续贴底");
});

test("重建对话 DOM：近底部时重新锚定末端；阅读更早内容时保持位置", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ session_id: "sess-a", status: "running", active_run: activeRun() }), [
    ev("input_queued", { input_id: "in-1", text: "旧会话消息", source: "chat" }, { session_id: "sess-a" })
  ]));
  const conv = root.querySelector('[data-testid="agent-conversation"]');
  conv.scrollHeight = 500;
  conv.clientHeight = 200;
  // 近底部：重建（新 session 快照）后应重新锚定到末端
  conv.scrollTop = 290;
  conv._fire("scroll");
  surface.applySnapshot(snapshotOf(session({ session_id: "sess-b", status: "running", active_run: activeRun() }), [
    ev("input_queued", { input_id: "in-1", text: "新会话消息", source: "chat" }, { session_id: "sess-b" })
  ]));
  assert.equal(conv.scrollTop, 300, "近底部重建后应锚定到末端");
  // 阅读更早内容：重建后保持位置，不打断
  conv.scrollTop = 0;
  conv._fire("scroll");
  surface.applySnapshot(snapshotOf(session({ session_id: "sess-c", status: "running", active_run: activeRun() }), [
    ev("input_queued", { input_id: "in-1", text: "第三条消息", source: "chat" }, { session_id: "sess-c" })
  ]));
  assert.equal(conv.scrollTop, 0, "阅读更早内容时重建不得抢滚动");
});

test("reasoning ticker：增量替换复用同一元素，高度锁定固定两行", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("run_started", { workflow: "general", input_id: "in-1" }));
  surface.applyEvent(ev("model_turn_started", { turn_id: "turn-1", input_id: "in-1", reasoning_capability: "supported" }));
  const group = root.querySelector(".agent-work-group");
  const reasoningRow = group.querySelector('[data-kind="reasoning"]');
  const ticker = reasoningRow.querySelector(".agent-reasoning-ticker");
  assert.ok(ticker, "运行中 reasoning 应显示 ticker");
  surface.applyEvent(ev("reasoning_delta", { turn_id: "turn-1", text: "第一段思考内容。" }));
  surface.applyEvent(ev("reasoning_delta", { turn_id: "turn-1", text: "第二段更长的思考内容。" }));
  assert.equal(reasoningRow.querySelector(".agent-reasoning-ticker"), ticker, "增量替换必须复用同一 ticker 元素，不重建 DOM");
  assert.equal(ticker.hidden, false, "运行中 ticker 可见");
  assert.ok(ticker.className.includes("agent-reasoning-ticker"), "ticker 样式 class 稳定");
  // 高度约束在 CSS：固定两行（min=max=2lh + line-clamp），文本替换不改变工作项高度。
  const css = await fs.readFile(path.join(here, "..", "..", "src", "app-shell", "agent", "agent.css"), "utf8");
  assert.match(
    css,
    /\.agent-reasoning-ticker\s*\{[^}]*min-height:\s*2lh[^}]*max-height:\s*2lh[^}]*line-clamp:\s*2/u,
    "ticker 高度锁定为固定两行（min=max=2lh），文本替换不得改变工作项高度"
  );
});

// ===========================================================================
// 布局基线：agent.css 保留 1040px 内容列与模型菜单视口钳制
// ===========================================================================

test("agent.css 保留 1040px 内容列、向上菜单与工作组/动效布局", async () => {
  const css = await fs.readFile(path.join(here, "..", "..", "src", "app-shell", "agent", "agent.css"), "utf8");
  const styles = await fs.readFile(path.join(here, "..", "..", "src", "app-shell", "styles.css"), "utf8");
  assert.match(css, /--content-column:\s*1040px/u, "根变量应定义 1040px 内容列");
  assert.match(css, /\.agent-conversation[\s\S]*max-width:\s*var\(--content-column\)/u, "对话共享内容列");
  assert.match(css, /\.agent-composer[\s\S]*max-width:\s*var\(--content-column\)/u, "composer 共享内容列");
  assert.match(
    css,
    /\.agent-composer-popover\s*\{[^}]*bottom:\s*calc\(100% \+ 7px\)[^}]*max-width:\s*min\(360px,\s*calc\(100vw - 32px\)\)/u,
    "composer 菜单应向上浮出并保留视口安全区"
  );
  assert.match(css, /overflow-wrap:\s*anywhere/u, "模型名称应允许任意位置换行");
  // 排队文本换行不遮「立即/取消」：grid 稳定轨道（minmax(0,1fr) + 三个 auto 列）
  assert.match(
    css,
    /\.agent-queue-item\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto\s+auto\s+auto/u,
    "排队行应为稳定 grid 轨道（状态 + 立即 + 取消 三列）"
  );
  // plan 行稳定轨道（标记列固定 18px，状态变化不推动文本列）
  assert.match(
    css,
    /\.agent-plan-item\s*\{[^}]*grid-template-columns:\s*18px\s+minmax\(0,\s*1fr\)/u,
    "plan 行应为稳定 grid 轨道"
  );
  // 按钮尺寸不随状态抖动（立即/撤回共用固定最小宽度）
  assert.match(css, /\.agent-stop-btn\s*,\s*\.agent-retry-btn\s*,\s*\.agent-promote[\s\S]*\.agent-withdraw[\s\S]*min-width/u, "控制按钮应有固定最小宽度");
  // 窄视口无重叠
  assert.match(css, /@media\s*\(max-width:\s*560px\)[\s\S]*\.agent-queue-item\s*\{/u, "窄视口应调整排队布局避免重叠");
  assert.match(
    css,
    /\.agent-composer-shell\s*\{[^}]*display:\s*grid[^}]*grid-template-rows:\s*minmax\(74px,\s*auto\)\s+42px[^}]*border:\s*1px\s+solid\s+var\(--agent-line\)[^}]*border-radius:\s*var\(--r-card\)[^}]*box-shadow:\s*var\(--shadow-sm\)/u,
    "composer 应是白底细边框圆角卡片，保留双行 grid 结构"
  );
  assert.match(
    css,
    /\.agent-message--assistant\s+\.agent-message-text\s*\{[^}]*background:\s*transparent[^}]*border:\s*0/u,
    "Agent 回复应使用安静的无框正文层级"
  );
  assert.match(css, /\.agent-queue:empty\s*\{[^}]*display:\s*none/u, "空队列不应留下分隔线");
  // 旧 Plan 悬浮层与三点思考动画已删除（Step 6）
  assert.doesNotMatch(css, /\.agent-plan-overlay/u, "旧 plan overlay CSS 已删除");
  assert.doesNotMatch(css, /agent-thinking-dot|agent-thinking-blink|agent-plan-mark|agent-plan-restore/u, "旧三点思考/悬浮层控件 CSS 已删除");
  assert.doesNotMatch(css, /@media\s*\(max-width:\s*720px\)/u, "旧窄窗口悬浮层降级规则已删除");
  // 工作组（Step 3/12）：details 容器 + 稳定选择器（不靠 nth-child/文案/内联 style）；
  // Codex 改版后为细边框圆角卡片，保留 1040px 内容轴。
  assert.match(
    css,
    /\.agent-work-group\s*\{[^}]*width:\s*min\(100%,\s*1040px\)[^}]*border:\s*1px\s+solid\s+var\(--agent-line\)[^}]*border-radius:\s*var\(--r-card\)[^}]*box-shadow:\s*var\(--shadow-xs\)/u,
    "工作组是细边框圆角卡片，保留 1040px 内容轴"
  );
  assert.match(
    css,
    /\.agent-work-item\s*\{[^}]*position:\s*relative[^}]*padding:\s*5px\s+0\s+5px\s+24px/u,
    "工作子项保留缩进（左侧时间线已随 Codex 改版移除）"
  );
  assert.doesNotMatch(css, /\.agent-work-item::before/u, "Codex 改版后工作项不得有左侧竖线");
  assert.match(
    css,
    /\.agent-work-status\s*\{[^}]*color:\s*var\(--agent-work-title-fg\)[^}]*font-weight:\s*var\(--weight-semibold\)/u,
    "工作组状态使用 title 色 + semibold"
  );
  assert.match(css, /\.agent-work-item__label\s*\{[^}]*color:\s*var\(--agent-work-label-fg\)/u, "子项 label 使用 label 色");
  assert.match(css, /\.agent-reasoning-ticker\s*\{[^}]*color:\s*var\(--text-muted\)/u, "ticker 使用 muted 色");
  assert.match(
    css,
    /\.agent-reasoning-detail\s*\{[^}]*color:\s*var\(--text-secondary\)[^}]*max-height:\s*320px[^}]*overflow-y:\s*auto/u,
    "reasoning 详情内部滚动（max-height 320px）"
  );
  // 计划三态字重：in_progress 唯一 semibold，completed/pending 为 regular
  assert.match(
    css,
    /\.agent-plan-item\s*\{[^}]*color:\s*var\(--agent-plan-rest-fg\)[^}]*font-weight:\s*var\(--weight-regular\)/u,
    "计划项默认 regular"
  );
  assert.match(
    css,
    /\.agent-plan-item\[data-status="in_progress"\]\s*\{[^}]*color:\s*var\(--agent-plan-current-fg\)[^}]*font-weight:\s*var\(--weight-semibold\)/u,
    "仅 in_progress 为 semibold"
  );
  assert.match(
    css,
    /\.agent-plan-item\[data-status="completed"\]\s*\{[^}]*color:\s*var\(--agent-plan-complete-fg\)[^}]*font-weight:\s*var\(--weight-regular\)/u,
    "completed 为 regular"
  );
  // 完成/失败状态色只落在 icon 或短状态词，不落在整行容器
  assert.match(
    css,
    /\.agent-work-item__icon\[data-state="completed"\]\s*\{[^}]*color:\s*var\(--text-success\)/u,
    "工具成功色只落在 icon"
  );
  assert.match(
    css,
    /\.agent-work-item__icon\[data-state="failed"\]\s*\{[^}]*color:\s*var\(--text-danger\)/u,
    "工具失败色只落在 icon"
  );
  assert.match(css, /\.agent-work-item__state\s*\{[^}]*color:\s*var\(--text-danger\)/u, "「失败」短状态词单独着色");
  assert.match(
    css,
    /\.agent-plan-item\[data-status="completed"\]\s+\.agent-plan-item__icon\s*\{[^}]*color:\s*var\(--text-success\)/u,
    "计划完成色只落在 icon"
  );
  assert.doesNotMatch(css, /\.agent-work-item\s*\{[^}]*--text-(success|danger)/u, "整行容器不得承载成功/失败色");
  // 统一 Text Shimmer（Step 7）：动效 class 与 reduced-motion 降级
  assert.match(css, /\.agent-live-text\s*\{[^}]*background-clip:\s*text/u, "统一 Text Shimmer 使用 background-clip: text");
  assert.match(css, /@keyframes\s+agent-text-shimmer/u, "shimmer 动画存在");
  assert.match(
    css,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.agent-live-text\s*\{[^}]*color:\s*var\(--muted\)[^}]*animation:\s*none/u,
    "reduced-motion 下 shimmer 降级为静态"
  );
  // 助手正文 Markdown 层次（步骤7）
  assert.match(css, /\.agent-message-text\.agent-markdown\s*\{[^}]*white-space:\s*normal/u, "Markdown 正文应切换为普通换行");
  assert.match(
    css,
    /\.agent-markdown-table-scroll\s*\{[^}]*max-width:\s*100%[^}]*overflow-x:\s*auto/u,
    "Markdown 表格应由独立包装层承载横向滚动"
  );
  assert.match(
    css,
    /\.agent-markdown-table-scroll table\s*\{[^}]*width:\s*min\(720px,\s*100%\)[^}]*min-width:\s*min\(720px,\s*100%\)[^}]*table-layout:\s*fixed/u,
    "表格应保持 720px 正文列，窄屏仅滚动包装层不压缩列"
  );
  assert.doesNotMatch(css, /\.agent-scroll-latest\s*\{[^}]*position:\s*sticky/u, "回到最新不得覆盖会话内容");
  // styles.css：2.6 semantic text / weight / agent component token 已声明（不重定义 primitive）
  assert.match(styles, /--text-primary:\s*var\(--ink\)/u, "semantic text token 使用现有 primitive 别名");
  assert.match(styles, /--text-danger:\s*var\(--red\)/u, "danger token 映射红色 primitive");
  assert.match(styles, /--weight-semibold:\s*650/u, "weight token 声明");
  assert.match(styles, /--agent-work-title-fg:\s*var\(--text-secondary\)/u, "agent component token 声明");
  assert.match(styles, /--agent-plan-complete-fg:\s*var\(--text-muted\)/u, "plan 终态色 token 声明");
});

// ===========================================================================
// 冻结布局约束（Task 7 Step 3）：固定宽度 + 响应式无横向溢出
// ===========================================================================

test("冻结布局约束：助手正文 720px / 工作组 1040px / 用户消息 min(800px,100%-32px) 靠右 / ticker 2lh / 详情 320px", async () => {
  const css = await fs.readFile(path.join(here, "..", "..", "src", "app-shell", "agent", "agent.css"), "utf8");
  assert.match(css, /\.agent-message--user\s*\{[^}]*align-self:\s*flex-end/u, "用户消息靠右");
  assert.match(css, /max-width:\s*min\(800px,\s*calc\(100% - 32px\)\)/u, "用户消息 max-width: min(800px, calc(100% - 32px))");
  assert.match(css, /width:\s*min\(100%,\s*720px\)/u, "助手 Markdown width: min(100%, 720px)");
  assert.match(css, /width:\s*min\(100%,\s*1040px\)/u, "工作组 width: min(100%, 1040px)");
  assert.match(
    css,
    /\.agent-reasoning-ticker\s*\{[^}]*min-height:\s*2lh[^}]*max-height:\s*2lh[^}]*line-clamp:\s*2/u,
    "reasoning ticker 固定两行（min=max=2lh）"
  );
  assert.match(css, /\.agent-reasoning-detail\s*\{[^}]*max-height:\s*320px[^}]*overflow-y:\s*auto/u, "详情 max-height 320px 内部滚动");
});

// ===========================================================================
// transport（agent/api.js）：经公共 seam 测试——stub 全局 fetch，surface 内部
// 创建真实 transport（依赖规则 B：agent/ 内部文件只能经 index.js 暴露）。
// ===========================================================================

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body)
  };
}

// 永不结束的空流：read() 一直挂起，不产生 timer，不触发重连。
function neverStream() {
  return new ReadableStream({ start() {} });
}

// 推送若干块后保持打开（read 挂起但无 timer）。
function streamThenHang(chunks) {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    start(controller) {
      const push = () => {
        if (i < chunks.length) {
          controller.enqueue(encoder.encode(chunks[i]));
          i += 1;
          setTimeout(push, 5);
        }
        // 末块发出后不再调度：流保持打开
      };
      setTimeout(push, 0);
    }
  });
}

// 立即报错的流（模拟网络中断/服务端重启）。
function errorStream() {
  return new ReadableStream({
    start(controller) {
      setTimeout(() => controller.error(new Error("stream-broken")), 0);
    }
  });
}

// 推送全部块后正常关闭（模拟服务端主动断开）。
function streamCloseAfter(chunks) {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    start(controller) {
      const push = () => {
        if (i >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(chunks[i]));
        i += 1;
        setTimeout(push, 5);
      };
      setTimeout(push, 0);
    }
  });
}

async function withFetch(stub, fn) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return stub(String(url), options, calls.length);
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

function snapshotResponse(sess) {
  return jsonResponse({ ok: true, session: sess, events: [] });
}

test("transport: submit/requestPriority/withdrawInput/stop/retry/decide 使用正确端点、作用域与 body", async () => {
  await withFetch((url) => {
    if (url.startsWith("/api/project/events")) return { ok: true, status: 200, body: neverStream() };
    if (url.startsWith("/api/agent/snapshot")) {
      return snapshotResponse(session({ status: "running", active_run: activeRun() }));
    }
    return jsonResponse({ ok: true });
  }, async (calls) => {
    const { root, surface } = await makeSurface({ useRealTransport: true });
    await surface.openProject("D:\\novel");
    // submit
    const input = root.querySelector('[data-testid="agent-composer-input"]');
    input.value = "继续写";
    root.querySelector('[data-testid="agent-send"]')._fire("click");
    // requestPriority（运行中排队 → 立即）
    surface.applyEvent(ev("input_queued", { input_id: "in-2", text: "排队消息", source: "chat" }));
    root.querySelector('[data-testid="agent-promote"]')._fire("click");
    // withdrawInput（撤回排队输入）
    surface.applyEvent(ev("input_queued", { input_id: "in-3", text: "撤回消息", source: "chat" }));
    const row3 = root.querySelector('[data-input-id="in-3"]');
    row3.querySelector('[data-testid="agent-withdraw"]')._fire("click");
    // stop
    root.querySelector('[data-testid="agent-stop"]')._fire("click");
    // decide（Run 仍活动）
    surface.applyEvent(ev("decision_requested", {
      decision_id: "dec-1", activity_id: "a1", input_id: "in-1",
      tool_call_id: "tc-a1", name: "write_file", kind: "normal",
      title: "写入文件", confirmation_text: null, fingerprint: "fp"
    }));
    const decCard = root.querySelector('[data-decision-id="dec-1"]');
    decCard.querySelector('[data-testid="agent-decision-choice"]')._fire("click");
    // retry（失败 Run）
    surface.applyEvent(ev("run_failed", { error: "模型超时", code: "model_timeout", input_id: "in-1" }));
    root.querySelector('[data-testid="agent-retry"]')._fire("click");

    const byUrl = (u) => calls.filter((c) => c.url === u);
    assert.equal(byUrl("/api/agent/input").length, 1);
    assert.deepEqual(JSON.parse(byUrl("/api/agent/input")[0].options.body), {
      projectRoot: "D:\\novel", text: "继续写"
    });
    assert.equal(byUrl("/api/agent/input/in-2/priority").length, 1);
    assert.deepEqual(JSON.parse(byUrl("/api/agent/input/in-2/priority")[0].options.body), { projectRoot: "D:\\novel" });
    assert.equal(byUrl("/api/agent/input/in-3/withdraw").length, 1);
    assert.deepEqual(JSON.parse(byUrl("/api/agent/input/in-3/withdraw")[0].options.body), { projectRoot: "D:\\novel" });
    assert.equal(byUrl("/api/agent/run/run-1/stop").length, 1);
    assert.equal(byUrl("/api/agent/run/run-1/retry").length, 1);
    assert.equal(byUrl("/api/agent/decision/dec-1").length, 1);
    assert.deepEqual(JSON.parse(byUrl("/api/agent/decision/dec-1")[0].options.body), {
      projectRoot: "D:\\novel", choice: "allow"
    });
    assert.ok(!calls.some((c) => c.url.includes("/promote")), "旧 promote 端点不得被调用");
    surface.destroy();
  });
});

test("transport: openProject 拉取带项目作用域的初始快照（tail 尾页）", async () => {
  await withFetch((url) => {
    if (url.startsWith("/api/project/events")) return { ok: true, status: 200, body: neverStream() };
    return snapshotResponse(null);
  }, async (calls) => {
    const { surface } = await makeSurface({ useRealTransport: true });
    await surface.openProject("D:\\novel");
    const snap = calls.find((c) => c.url.startsWith("/api/agent/snapshot?"));
    assert.ok(snap, "应请求 snapshot 端点");
    assert.equal(snap.url, "/api/agent/snapshot?projectRoot=D%3A%5Cnovel&tail=1&limit=200");
    surface.destroy();
  });
});

test("transport: openProject 中止旧项目仍在途的 HTTP 请求", async () => {
  let oldRequestSignal = null;
  await withFetch((url, options) => {
    if (url.startsWith("/api/project/events")) return { ok: true, status: 200, body: neverStream() };
    if (url === "/api/agent/input") {
      oldRequestSignal = options.signal;
      return new Promise((_resolve, reject) => {
        const abort = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (options.signal?.aborted) abort();
        else options.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    return snapshotResponse(null);
  }, async () => {
    const { root, surface } = await makeSurface({ useRealTransport: true });
    try {
      await surface.openProject("D:\\novel-a");
      const input = root.querySelector('[data-testid="agent-composer-input"]');
      input.value = "A 项目在途请求";
      root.querySelector('[data-testid="agent-send"]')._fire("click");
      await waitUntil(() => oldRequestSignal !== null);

      await surface.openProject("D:\\novel-b");
      assert.equal(oldRequestSignal.aborted, true, "切项目必须中止旧项目所有在途 HTTP 请求");
    } finally {
      surface.destroy();
      await tick();
    }
  });
});

test("transport: SSE 流按块解析 data 事件并渲染到视图", async () => {
  await withFetch((url) => {
    if (url.startsWith("/api/project/events")) {
      return {
        ok: true,
        status: 200,
        body: streamThenHang([
          ': connected\n\n',
          'data: {"seq":1,"type":"run_started","payload":{"workflow":"general","input_id":"in-1"},"run_id":"run-1"}\n\n',
          'data: {"seq":2,"type":"input_queued","payload":{"input_id":"in-1","text":"SSE 消息"},"run_id":"run-1"}\n\n',
          'data: {"seq":3,"type":"input_started","payload":{"input_id":"in-1"},"run_id":"run-1"}\n\n'
        ])
      };
    }
    return snapshotResponse(null);
  }, async (calls) => {
    const { root, surface } = await makeSurface({ useRealTransport: true });
    await surface.openProject("D:\\novel");
    await waitUntil(() =>
      root.querySelector('[data-testid="agent-user-message"]')?.textContent.includes("SSE 消息")
    );
    surface.destroy();
  });
});

test("transport: SSE 断线按指数退避重连，事件最终送达视图", async () => {
  let eventsFetches = 0;
  await withFetch((url) => {
    if (url.startsWith("/api/project/events")) {
      eventsFetches += 1;
      if (eventsFetches === 1) return { ok: true, status: 200, body: errorStream() };
      return {
        ok: true,
        status: 200,
        body: streamThenHang([
          'data: {"seq":1,"type":"input_queued","payload":{"input_id":"in-1","text":"重连后到达"},"run_id":"run-1"}\n\n',
          'data: {"seq":2,"type":"input_started","payload":{"input_id":"in-1"},"run_id":"run-1"}\n\n'
        ])
      };
    }
    return snapshotResponse(null);
  }, async (calls) => {
    const { root, surface } = await makeSurface({ useRealTransport: true });
    await surface.openProject("D:\\novel");
    await waitUntil(
      () => root.querySelector('[data-testid="agent-user-message"]')?.textContent.includes("重连后到达"),
      { timeoutMs: 5000 }
    );
    assert.ok(eventsFetches >= 2, "断线后应重连并收到后续事件");
    surface.destroy();
  });
});

test("transport: SSE 断线补齐（onReconnect 快照）后事件连续无缺口", async () => {
  let eventsFetches = 0;
  await withFetch((url) => {
    if (url.startsWith("/api/project/events")) {
      eventsFetches += 1;
      if (eventsFetches === 1) {
        // 第一次连接：收到 seq1-2 后服务端断开
        return {
          ok: true,
          status: 200,
          body: streamCloseAfter([
            'data: {"seq":1,"type":"input_queued","payload":{"input_id":"in-1","text":"第一条"},"run_id":"run-1"}\n\n',
            'data: {"seq":2,"type":"input_started","payload":{"input_id":"in-1"},"run_id":"run-1"}\n\n'
          ])
        };
      }
      // 重连流：补齐后的新事件（seq7-8）
      return {
        ok: true,
        status: 200,
        body: streamThenHang([
          'data: {"seq":7,"type":"input_queued","payload":{"input_id":"in-4","text":"第四条"},"run_id":"run-1"}\n\n',
          'data: {"seq":8,"type":"input_started","payload":{"input_id":"in-4"},"run_id":"run-1"}\n\n'
        ])
      };
    }
    if (url.startsWith("/api/agent/snapshot")) {
      // 初始快照（tail 尾页）为空；断线补齐（afterSeq=2）返回 seq3-6
      if (url.includes("tail=1")) return snapshotResponse(null);
      return jsonResponse({
        ok: true,
        session: null,
        events: [
          { seq: 3, event_id: "e3", session_id: "sess-test", run_id: "run-1", type: "input_queued", payload: { input_id: "in-2", text: "第二条" }, at: "x" },
          { seq: 4, event_id: "e4", session_id: "sess-test", run_id: "run-1", type: "input_started", payload: { input_id: "in-2" }, at: "x" },
          { seq: 5, event_id: "e5", session_id: "sess-test", run_id: "run-1", type: "input_queued", payload: { input_id: "in-3", text: "第三条" }, at: "x" },
          { seq: 6, event_id: "e6", session_id: "sess-test", run_id: "run-1", type: "input_started", payload: { input_id: "in-3" }, at: "x" }
        ]
      });
    }
    return jsonResponse({ ok: true });
  }, async (calls) => {
    const { root, surface } = await makeSurface({ useRealTransport: true });
    await surface.openProject("D:\\novel");
    // 断线 → 退避 → onReconnect 补齐 seq2-3 → 重连流送达 seq4
    await waitUntil(
      () => root.querySelectorAll('[data-testid="agent-user-message"]').length >= 4,
      { timeoutMs: 5000 }
    );
    const texts = [...root.querySelectorAll('[data-testid="agent-user-message"]')].map((el) => el.textContent);
    assert.deepEqual(texts, ["第一条", "第二条", "第三条", "第四条"], "补齐后事件应连续无缺口");
    surface.destroy();
  });
});

test("transport: destroy 停止重连（不再发起新请求）", async () => {
  let eventsFetches = 0;
  await withFetch((url) => {
    if (url.startsWith("/api/project/events")) {
      eventsFetches += 1;
      if (eventsFetches === 1) return { ok: true, status: 200, body: errorStream() };
      return { ok: true, status: 200, body: neverStream() }; // 重连流保持打开
    }
    return snapshotResponse(null);
  }, async (calls) => {
    const { surface } = await makeSurface({ useRealTransport: true });
    await surface.openProject("D:\\novel");
    await waitUntil(() => eventsFetches >= 2, { timeoutMs: 5000 });
    const countAfterReconnect = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls.length, countAfterReconnect, "重连流打开后不再发起新请求");
    surface.destroy();
    const countAfterDestroy = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(calls.length, countAfterDestroy, "destroy 后不得继续重连");
  });
});

// ===========================================================================
// 禁止文案（Task 10 Step 2）：UI Copy Audit 删除的旧教学/占位文案不得重新
// 出现在生产 UI 中。断言扫描 src/app-shell（vendor/ 除外）的全部生产文件；
// 字面量用片段拼接组装，避免本测试文件自身包含完整禁用文案。
// ===========================================================================

test("禁止文案：生产 UI 不含已删除的旧教学/占位文案", async () => {
  // 取舍：片段拼接避免完整字面量出现在本文件（全仓库 grep 禁用文案需零命中）。
  // 代价是前缀片段（如「继续思」「前面还」）可能命中未来合法文案——调整片段
  // 切分点即可放过，不要为了绕过断言而放宽扫描范围。
  // 每个条目 = 完整文案的两个片段（运行时拼接后再比对）。
  const PROHIBITED_PAIRS = [
    ["将在当前安全步骤后", "处理"],
    ["等待任务收", "尾"],
    ["继续思", "考"],
    ["前面还", "有"],
    ["下一个执", "行"],
    ["输入指令，或 ", "/write"],
    ["试试：", "开始写作"],
    ["蓝图已生成，可以开", "始写作"],
    ["故事正在落", "笔"],
    ["运行 /review 命令后生", "成"],
    ["发送指令后开", "始生成"]
  ];
  const root = path.join(here, "..", "..", "src", "app-shell");
  const files = [];
  const walk = async (dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "vendor") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (/\.(js|mjs|html)$/.test(entry.name)) {
        files.push(full);
      }
    }
  };
  await walk(root);
  assert.ok(files.length > 0, "应扫描到生产 UI 文件");
  const offenders = [];
  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    for (const [head, tail] of PROHIBITED_PAIRS) {
      const literal = head + tail;
      if (source.includes(literal)) {
        offenders.push(`${path.relative(here, file)}: ${literal}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "生产 UI 不得包含已删除的旧教学/占位文案");
});

// ===========================================================================
// 步骤2：工具工作项显示文件路径（tool_call_started args.path）
// ===========================================================================

test("工具工作项：read/write/edit 带 path 时标签与路径分离显示", async () => {
  const { root, surface } = await makeSurface();
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() }), [
    toolStarted("a1", "read_file", { path: "src/core/x.mjs" }),
    toolStarted("a2", "write_file", { path: "chapters/01.md" }),
    toolStarted("a3", "edit_file", { path: "docs/plan.md" })
  ]));
  const toolRows = () => [...root.querySelectorAll(".agent-work-item")].filter((el) => el.dataset.kind === "tool");
  const labels = toolRows().map((el) => el.querySelector(".agent-work-item__label").textContent);
  assert.deepEqual(labels, ["正在读取文件", "正在写入文件", "正在修改文件"]);
  const paths = toolRows().map((el) => el.querySelector(".agent-tool-path").textContent);
  assert.deepEqual(paths, ["src/core/x.mjs", "chapters/01.md", "docs/plan.md"]);
});

test("工具工作项：无 path 的工具回退泛化文案，不出现 undefined", async () => {
  const { root, surface } = await makeSurface();
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() }), [
    toolStarted("a1", "read_file", {}),
    toolStarted("a2", "edit_file", { file: "旧字段名" }),
    toolStarted("a3", "shell", { command: "npm test" }),
    toolStarted("a4", "read_file", JSON.stringify({ path: "str-json.md" }))
  ]));
  const toolRows = () => [...root.querySelectorAll(".agent-work-item")].filter((el) => el.dataset.kind === "tool");
  const labels = toolRows().map((el) => el.querySelector(".agent-work-item__label").textContent);
  assert.equal(labels[0], "正在读取文件");
  assert.equal(labels[1], "正在修改文件");
  assert.equal(labels[2], "正在运行命令");
  assert.equal(labels[3], "正在读取文件");
  // 无 path 时路径元素隐藏（不渲染空文本）
  assert.ok(toolRows().every((el) => el.querySelector(".agent-tool-path").hidden), "无 path 的路径元素应隐藏");
  // 无字段无输出时整个详情区隐藏；有命令字段时默认收起（点击整行展开）
  assert.ok(toolRows()[0].querySelector(".agent-tool-details").hidden, "无字段无输出时详情区隐藏");
  const row2 = toolRows()[2];
  const details2 = row2.querySelector(".agent-tool-details");
  assert.equal(details2.hidden, true, "有命令字段时默认收起");
  row2._fire("click");
  assert.equal(details2.hidden, false, "点击行后详情展开");
});

// ===========================================================================
// 步骤3：composer 三控件（模型 / 权限模式 / 思考强度）
// ===========================================================================

// v2 供应商清单里的模型条目（store 形态：id/model_name/enabled）。
function storeModel(modelId, modelName, { enabled = true } = {}) {
  return { id: modelId, model_name: modelName, enabled };
}

// Task 16：composer 三控件数据源 = 全局供应商清单 store + dashboard 有效配置
//（activeModel 引用形态 + activeModelCapabilities 服务端能力矩阵）。
function composerOptionsData(overrides = {}) {
  const dsId = "p-deepseek";
  const mimoId = "p-mimo";
  return {
    store: {
      providers: [
        {
          id: dsId,
          name: "DeepSeek 官方",
          status: "enabled",
          base_url: "https://api.deepseek.com",
          models: [
            storeModel("m-reasoner", "deepseek-reasoner"),
            storeModel("m-chat", "deepseek-chat", { enabled: false }) // 停用模型不进选择器
          ]
        },
        {
          id: mimoId,
          name: "小米 MiMo 官方",
          status: "enabled",
          base_url: "https://api.xiaomimimo.com/v1",
          models: [storeModel("m-mimo", "mimo-7b")]
        },
        {
          id: "p-off",
          name: "停用供应商",
          status: "disabled",
          base_url: "https://off.example.com",
          models: [storeModel("m-off", "off-model")]
        }
      ],
      default_model: { provider_id: dsId, model_id: "m-reasoner" }
    },
    activeModel: {
      provider: "openai-compatible",
      provider_id: dsId,
      model_id: "m-reasoner",
      model_name: "deepseek-reasoner",
      base_url: "https://api.deepseek.com"
    },
    activeModelCapabilities: { reasoningEffortLevels: ["low", "medium", "high"] },
    toolPermissions: { read_only: false, safe_edit: true, auto_edit: false, yolo: false },
    reasoningEffort: "auto",
    ...overrides
  };
}

// 空 store：无任何可用模型（未配置场景）。
function unconfiguredOptions(overrides = {}) {
  return composerOptionsData({
    store: { providers: [], default_model: null },
    activeModel: null,
    activeModelCapabilities: null,
    ...overrides
  });
}

function menuOption(root, testid, value) {
  return [...root.querySelectorAll(`[data-testid="${testid}"]`)]
    .find((option) => option.dataset.value === value);
}

test("composer 三控件：openProject 后加载选项并渲染（testid 齐全）", async () => {
  const { root, surface } = await makeSurface({
    apiOverrides: {
      fetchComposerOptions: async () => composerOptionsData({ reasoningEffort: "high" })
    }
  });
  // 未打开项目：三控件禁用
  const modelSel = root.querySelector('[data-testid="agent-model-select"]');
  const permSel = root.querySelector('[data-testid="agent-permission-select"]');
  const effortSel = root.querySelector('[data-testid="agent-effort-select"]');
  assert.ok(modelSel && permSel && effortSel, "三控件应有 testid");
  assert.equal(modelSel.disabled, true, "未打开项目时模型选择禁用");
  assert.equal(effortSel.disabled, true);

  await surface.openProject("D:\\novel");

  assert.equal(modelSel.disabled, false);
  assert.equal(modelSel.tagName, "button", "不得退回系统原生 select");
  assert.equal(modelSel.dataset.value, "p-deepseek/m-reasoner");
  assert.match(modelSel.textContent, /deepseek-reasoner/u);
  // Task 16：只列启用供应商的启用模型（停用模型 deepseek-chat 与停用供应商 p-off 不出现）
  assert.deepEqual(
    [...root.querySelectorAll('[data-testid="agent-model-option"]')].map((o) => o.textContent),
    ["deepseek-reasoner（DeepSeek 官方）", "mimo-7b（小米 MiMo 官方）"]
  );
  assert.equal(permSel.disabled, false);
  assert.equal(root.querySelectorAll('[data-testid="agent-permission-option"]').length, 4, "权限四档：只读/确认后修改/自动修改/YOLO");
  assert.equal(permSel.dataset.value, "confirm");
  assert.equal(effortSel.disabled, false, "DeepSeek thinking 模型提供思考强度档位");
  assert.deepEqual([...root.querySelectorAll('[data-testid="agent-effort-option"]')].map((o) => o.dataset.value), ["auto", "low", "medium", "high"]);
  assert.equal(effortSel.dataset.value, "high");

  modelSel._fire("click", { stopPropagation() {} });
  assert.equal(root.querySelector('[data-testid="agent-model-menu"]').hidden, false, "菜单应由触发按钮打开");
  assert.equal(modelSel.getAttribute("aria-expanded"), "true");
});

test("composer 思考强度能力来自服务端能力矩阵（dashboard 模型档案），不在前端猜测", async () => {
  const { root, surface } = await makeSurface({
    apiOverrides: {
      fetchComposerOptions: async () => composerOptionsData({
        activeModelCapabilities: { reasoningEffortLevels: ["low", "medium", "high"] },
        reasoningEffort: "medium"
      })
    }
  });

  await surface.openProject("D:\\novel");

  const effortSel = root.querySelector('[data-testid="agent-effort-select"]');
  assert.equal(effortSel.disabled, false);
  assert.deepEqual([...root.querySelectorAll('[data-testid="agent-effort-option"]')].map((option) => option.dataset.value), ["auto", "low", "medium", "high"]);
  assert.equal(effortSel.dataset.value, "medium");
});

test("composer 清单外字面模型（未迁移旧配置）：仍显示实际生效模型，只读不可切", async () => {
  const { root, surface } = await makeSurface({
    apiOverrides: {
      fetchComposerOptions: async () => composerOptionsData({
        store: { providers: [], default_model: null },
        activeModel: { provider: "openai-compatible", model_name: "legacy-model", base_url: "https://legacy.test/v1" },
        activeModelCapabilities: null
      })
    }
  });
  await surface.openProject("D:\\legacy-novel");

  const model = root.querySelector('[data-testid="agent-model-select"]');
  assert.equal(model.dataset.value, "legacy:legacy-model");
  assert.match(model.textContent, /legacy-model/u);
  assert.equal(model.disabled, true, "清单外的生效模型只展示事实，不伪装成可切换选项");
  assert.equal(root.querySelectorAll('[data-testid="agent-model-option"]').length, 1);
});

test("composer 未配置模型：无可用模型时「未配置」占位可点（开设置页）", async () => {
  // Task 16：activeModel 为空且清单无可用模型时，选择器唯一选项是「未配置」占位，
  // 触发器可点——点击打开新设置页（不再是旧版禁用的「未导入模型」）。
  const { root, surface, opened } = await makeSurface({
    apiOverrides: {
      fetchComposerOptions: async () => unconfiguredOptions()
    }
  });
  await surface.openProject("D:\\unconfigured-novel");

  const model = root.querySelector('[data-testid="agent-model-select"]');
  assert.equal(model.dataset.value, "");
  assert.match(model.textContent, /未配置/u);
  assert.equal(model.disabled, false, "未配置占位应可点（直达设置页）");
  assert.equal(root.querySelectorAll('[data-testid="agent-model-option"]').length, 1);
  const placeholder = menuOption(root, "agent-model-option", "");
  assert.equal(placeholder.textContent, "未配置");

  placeholder._fire("click", { stopPropagation() {} });
  assert.deepEqual(opened, ["model"], "点击「未配置」占位应打开新设置页（模型分区）");
});

test("composer 模型选择：选中写项目引用，响应更新控件与能力", async () => {
  const switched = [];
  const { root, surface } = await makeSurface({
    apiOverrides: {
      fetchComposerOptions: async () => composerOptionsData(),
      switchModel: async (modelId) => {
        switched.push(modelId);
        return {
          ok: true,
          active_model: { provider_id: "p-mimo", model_id: "m-mimo" },
          capabilities: {}, // mimo：无 reasoningEffortLevels
          project: { tool_permissions: { read_only: false, safe_edit: true, auto_edit: true, yolo: false } }
        };
      }
    }
  });
  await surface.openProject("D:\\novel");
  const modelSel = root.querySelector('[data-testid="agent-model-select"]');
  const effortSel = root.querySelector('[data-testid="agent-effort-select"]');
  assert.equal(effortSel.disabled, false, "切换前 DeepSeek 支持强度");

  menuOption(root, "agent-model-option", "p-mimo/m-mimo")._fire("click", { stopPropagation() {} });
  await tick();

  assert.deepEqual(switched, ["p-mimo/m-mimo"], "应调用 switchModel(引用 value)");
  assert.equal(modelSel.dataset.value, "p-mimo/m-mimo", "切换成功后菜单保持新模型");
  assert.equal(root.querySelectorAll('[data-testid="agent-effort-option"]').length, 1, "mimo 不支持思考强度，只剩「自动」");
  assert.equal(effortSel.disabled, true);
  assert.equal(effortSel.dataset.value, "auto");
});

test("composer 权限选择：所有档位直接落盘，YOLO 不弹确认", async () => {
  const updated = [];
  const realConfirm = globalThis.confirm;
  let confirmCalls = 0;
  globalThis.confirm = () => { confirmCalls += 1; return false; };
  try {
    const { root, surface } = await makeSurface({
      apiOverrides: {
        fetchComposerOptions: async () => unconfiguredOptions(),
        updatePermissions: async (combo) => {
          updated.push(combo);
          return { ok: true };
        }
      }
    });
    await surface.openProject("D:\\novel");
    const permSel = root.querySelector('[data-testid="agent-permission-select"]');

    menuOption(root, "agent-permission-option", "yolo")._fire("click", { stopPropagation() {} });
    await tick();
    assert.equal(updated.length, 1);
    assert.deepEqual(updated[0], { read_only: false, safe_edit: true, auto_edit: true, yolo: true });
    assert.equal(permSel.dataset.value, "yolo");
    assert.equal(confirmCalls, 0, "YOLO 是权限选择，不应打断用户要求二次确认");

    // 非 yolo 档：直接落盘，无确认
    menuOption(root, "agent-permission-option", "auto")._fire("click", { stopPropagation() {} });
    await tick();
    assert.equal(updated.length, 2);
    assert.deepEqual(updated[1], { read_only: false, safe_edit: true, auto_edit: true, yolo: false });
    assert.equal(permSel.dataset.value, "auto");
  } finally {
    globalThis.confirm = realConfirm;
  }
});

test("composer 思考强度：不支持模型仅「自动」且禁用；选择后调 updateReasoningEffort", async () => {
  const efforts = [];
  const { root, surface } = await makeSurface({
    apiOverrides: {
      fetchComposerOptions: async () => composerOptionsData({
        activeModelCapabilities: null,
        reasoningEffort: "medium"
      }),
      updateReasoningEffort: async (effort) => {
        efforts.push(effort);
        return { ok: true };
      }
    }
  });
  await surface.openProject("D:\\novel");
  const effortSel = root.querySelector('[data-testid="agent-effort-select"]');
  assert.equal(root.querySelectorAll('[data-testid="agent-effort-option"]').length, 1);
  assert.equal(effortSel.disabled, true, "不支持模型不得伪装低/中/高可用");
  assert.equal(effortSel.dataset.value, "auto", "不支持模型固定显示「自动」");

  // 换到支持的模型后恢复四档并落盘
  const { root: root2, surface: surface2 } = await makeSurface({
    apiOverrides: {
      fetchComposerOptions: async () => composerOptionsData(),
      updateReasoningEffort: async (effort) => {
        efforts.push(effort);
        return { ok: true };
      }
    }
  });
  await surface2.openProject("D:\\novel");
  const effortSel2 = root2.querySelector('[data-testid="agent-effort-select"]');
  assert.equal(effortSel2.disabled, false);
  menuOption(root2, "agent-effort-option", "high")._fire("click", { stopPropagation() {} });
  await tick();
  assert.deepEqual(efforts, ["high"], "应调用 updateReasoningEffort(high)");
  assert.equal(effortSel2.dataset.value, "high");
});

test("composer：Run 进行中切换模型/权限不报错、不改运行状态", async () => {
  const { root, surface } = await makeSurface({
    apiOverrides: {
      fetchComposerOptions: async () => composerOptionsData(),
      switchModel: async () => ({
        ok: true,
        active_model: { provider_id: "p-mimo", model_id: "m-mimo" },
        capabilities: { reasoningEffortLevels: ["low", "medium", "high"] },
        project: { tool_permissions: { read_only: false, safe_edit: true, auto_edit: true, yolo: false } }
      }),
      updatePermissions: async () => ({ ok: true })
    }
  });
  await surface.openProject("D:\\novel");
  surface.applyEvent(ev("run_started", { workflow: "general", input_id: "in-1" }));
  assert.equal(root.querySelector('[data-testid="agent-stop"]') !== null, true, "Run 启动后停止按钮存在");

  const modelSel = root.querySelector('[data-testid="agent-model-select"]');
  menuOption(root, "agent-model-option", "p-mimo/m-mimo")._fire("click", { stopPropagation() {} });
  const permSel = root.querySelector('[data-testid="agent-permission-select"]');
  menuOption(root, "agent-permission-option", "read_only")._fire("click", { stopPropagation() {} });
  await tick();

  assert.equal(root.querySelector('[data-testid="agent-error"]'), null, "切换不渲染错误卡");
  assert.equal(root.querySelector('[data-testid="agent-stop"]') !== null, true, "切换后停止按钮仍在");
});

test("composer 选项加载失败：控件保持禁用，不阻断对话", async () => {
  const { root, surface } = await makeSurface({
    apiOverrides: {
      fetchComposerOptions: async () => {
        throw new Error("network down");
      }
    }
  });
  await surface.openProject("D:\\novel");
  assert.equal(root.querySelector('[data-testid="agent-model-select"]').disabled, true);
  assert.equal(root.querySelector('[data-testid="agent-permission-select"]').disabled, true);
  assert.equal(root.querySelector('[data-testid="agent-effort-select"]').disabled, true);
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  input.value = "继续";
  root.querySelector('[data-testid="agent-send"]')._fire("click");
  await tick();
  assert.ok(root.querySelector('[data-testid="agent-user-message"]'), "对话发送不受选项加载失败影响");
});

test("transport: composer 选项读取与切换使用正确端点、作用域与 body", async () => {
    await withFetch((url, options) => {
      if (url.startsWith("/api/project/events")) return { ok: true, status: 200, body: neverStream() };
      if (url === "/api/settings/providers") {
        return jsonResponse({ ok: true, schema_version: 2, default_model: null, providers: [
          { id: "p-mimo", name: "小米 MiMo 官方", status: "enabled", base_url: "https://api.xiaomimimo.com/v1", models: [{ id: "m-mimo", model_name: "mimo-7b", enabled: true }] },
          { id: "p-ds", name: "DeepSeek 官方", status: "enabled", base_url: "https://api.deepseek.com", models: [{ id: "m-reasoner", model_name: "deepseek-reasoner", enabled: true }] }
        ] });
      }
      if (url.startsWith("/api/dashboard?")) {
        return jsonResponse({
          ok: true, hasProject: true, project: {}, model_profile: {
            model_name: "deepseek-reasoner",
            capabilities: { reasoningEffortLevels: ["low", "medium", "high"] }
          },
          config: {
            effective: {
              active_model: { provider: "openai-compatible", provider_id: "p-ds", model_id: "m-reasoner", model_name: "deepseek-reasoner", base_url: "https://api.deepseek.com" },
              tool_permissions: { read_only: false, safe_edit: true, auto_edit: false, yolo: false }
            }
          }
        });
      }
      if (url === "/api/settings/model-switch") {
        return jsonResponse({ ok: true, active_model: { provider_id: "p-mimo", model_id: "m-mimo" }, capabilities: {}, project: { tool_permissions: {} } });
      }
      if (url === "/api/settings/update") return jsonResponse({ ok: true });
      return snapshotResponse(null);
    }, async (calls) => {
      const { root, surface } = await makeSurface({ useRealTransport: true });
      await surface.openProject("D:\\novel");
      const urls = calls.map((c) => String(c.url));
      assert.ok(urls.includes("/api/settings/providers"), "应读取全局供应商清单");
      assert.ok(urls.some((u) => u.startsWith("/api/dashboard?projectRoot=")), "应读取带项目作用域的 dashboard");
      const modelSel = root.querySelector('[data-testid="agent-model-select"]');
      const effortSel = root.querySelector('[data-testid="agent-effort-select"]');
      assert.equal(root.querySelectorAll('[data-testid="agent-effort-option"]').length, 4, "初始加载应读取服务端模型能力");
      assert.equal(modelSel.dataset.value, "p-ds/m-reasoner");

      menuOption(root, "agent-model-option", "p-mimo/m-mimo")._fire("click", { stopPropagation() {} });
      await waitUntil(() => calls.some((c) => String(c.url) === "/api/settings/model-switch"));
      const sw = calls.find((c) => String(c.url) === "/api/settings/model-switch");
      assert.deepEqual(JSON.parse(sw.options.body), { projectRoot: "D:\\novel", provider_id: "p-mimo", model_id: "m-mimo" });
      await waitUntil(() => root.querySelectorAll('[data-testid="agent-effort-option"]').length === 1, { timeoutMs: 2000 });
      assert.equal(effortSel.disabled, true, "切换后以服务端 capabilities 为准（无强度档）");

      const permSel = root.querySelector('[data-testid="agent-permission-select"]');
      menuOption(root, "agent-permission-option", "yolo")._fire("click", { stopPropagation() {} });
      await waitUntil(() => calls.filter((c) => String(c.url) === "/api/settings/update").length === 1);
      const upd = calls.find((c) => String(c.url) === "/api/settings/update");
      assert.deepEqual(JSON.parse(upd.options.body), {
        projectRoot: "D:\\novel",
        tool_permissions: { read_only: false, safe_edit: true, auto_edit: true, yolo: true }
      });
      surface.destroy();
    });
});

// ===========================================================================
// Task 21（spec 4.3 #10）：三控件保存失败反馈——中文 error toast +
// 控件恢复最近 snapshot 的权威值；不静默回退、不残留错误乐观值。
// 每个 setter 都按「保存返回非 2xx」路径断言：toast 可见、中文文案、
// 控件值回到最近 snapshot 的权威值（而不是用户刚选的乐观值）。
// ===========================================================================

test("composer 模型切换失败（非 2xx）：中文 error toast，控件恢复最近 snapshot 权威值", async () => {
  const { root, api, surface } = await makeSurface({
    apiOverrides: {
      fetchComposerOptions: async () => composerOptionsData(),
      switchModel: async (modelId) => {
        api.calls.push(["switchModel", modelId]);
        const error = new Error("模型切换被拒绝");
        error.code = "model_switch_failed";
        error.status = 500;
        throw error;
      }
    }
  });
  await surface.openProject("D:\\novel");
  const modelSel = root.querySelector('[data-testid="agent-model-select"]');
  assert.equal(modelSel.dataset.value, "p-deepseek/m-reasoner", "初始值 = 最近 snapshot 权威值");

  menuOption(root, "agent-model-option", "p-mimo/m-mimo")._fire("click", { stopPropagation() {} });
  await tick();
  await tick();

  assert.deepEqual(api.calls.filter((c) => c[0] === "switchModel").map((c) => c[1]), ["p-mimo/m-mimo"]);
  const toast = root.querySelector('[data-testid="agent-toast"]');
  assert.ok(toast, "切换失败应显示 toast，不得静默回退");
  assert.match(toast.textContent, /模型切换失败/u);
  assert.equal(modelSel.dataset.value, "p-deepseek/m-reasoner", "控件恢复最近 snapshot 的权威值，不残留错误乐观值");
  surface.destroy(); // toast 3s 计时器随 destroy 清理，不泄漏
});

test("composer 权限保存失败（非 2xx）：中文 error toast，控件恢复最近 snapshot 权威值", async () => {
  const { root, api, surface } = await makeSurface({
    apiOverrides: {
      fetchComposerOptions: async () => composerOptionsData(),
      updatePermissions: async (combo) => {
        api.calls.push(["updatePermissions", combo]);
        const error = new Error("权限保存被拒绝");
        error.code = "permission_save_failed";
        error.status = 400;
        throw error;
      }
    }
  });
  await surface.openProject("D:\\novel");
  const permSel = root.querySelector('[data-testid="agent-permission-select"]');
  assert.equal(permSel.dataset.value, "confirm", "初始值 = 最近 snapshot 权威值");

  menuOption(root, "agent-permission-option", "yolo")._fire("click", { stopPropagation() {} });
  await tick();
  await tick();

  assert.deepEqual(api.calls.filter((c) => c[0] === "updatePermissions").map((c) => c[1]), [
    { read_only: false, safe_edit: true, auto_edit: true, yolo: true }
  ]);
  const toast = root.querySelector('[data-testid="agent-toast"]');
  assert.ok(toast, "保存失败应显示 toast，不得静默回退");
  assert.match(toast.textContent, /权限保存失败/u);
  assert.equal(permSel.dataset.value, "confirm", "控件恢复最近 snapshot 的权威值，不残留错误乐观值");
  surface.destroy();
});

test("composer 思考强度保存失败（非 2xx）：中文 error toast，控件恢复最近 snapshot 权威值", async () => {
  const { root, api, surface } = await makeSurface({
    apiOverrides: {
      fetchComposerOptions: async () => composerOptionsData(),
      updateReasoningEffort: async (effort) => {
        api.calls.push(["updateReasoningEffort", effort]);
        const error = new Error("思考强度保存被拒绝");
        error.code = "effort_save_failed";
        error.status = 422;
        throw error;
      }
    }
  });
  await surface.openProject("D:\\novel");
  const effortSel = root.querySelector('[data-testid="agent-effort-select"]');
  assert.equal(effortSel.dataset.value, "auto", "初始值 = 最近 snapshot 权威值");

  menuOption(root, "agent-effort-option", "high")._fire("click", { stopPropagation() {} });
  await tick();
  await tick();

  assert.deepEqual(api.calls.filter((c) => c[0] === "updateReasoningEffort").map((c) => c[1]), ["high"]);
  const toast = root.querySelector('[data-testid="agent-toast"]');
  assert.ok(toast, "保存失败应显示 toast，不得静默回退");
  assert.match(toast.textContent, /思考强度保存失败/u);
  assert.equal(effortSel.dataset.value, "auto", "控件恢复最近 snapshot 的权威值，不残留错误乐观值");
  surface.destroy();
});

// ===========================================================================
// Task 16：选择器选项派生与迁移提示（纯 helper）
// ===========================================================================

test("选择器过滤停用供应商与停用模型", () => {
  const options = buildModelPickerOptions({
    providers: [
      { id: "a", name: "A", status: "enabled", models: [{ id: "m1", model_name: "a1", enabled: true }, { id: "m2", model_name: "a2", enabled: false }] },
      { id: "b", name: "B", status: "disabled", models: [{ id: "m3", model_name: "b1", enabled: true }] }
    ],
    default_model: { provider_id: "a", model_id: "m1" }
  });
  assert.deepEqual(options.map((o) => o.value), ["a/m1"]);
  assert.equal(options[0].isDefault, true);
  assert.equal(options[0].label, "a1（A）");
});

test("无任何可用模型时首项为未配置占位", () => {
  const options = buildModelPickerOptions({ providers: [], default_model: null });
  assert.equal(options.length, 1);
  assert.equal(options[0].value, "");
  assert.equal(options[0].label, "未配置");
});

test("migration_notice 触发一次 toast", () => {
  const toasts = [];
  handleDashboardMigrationNotice({ migration_notice: true }, (m) => toasts.push(m));
  handleDashboardMigrationNotice({ migration_notice: true }, (m) => toasts.push(m));
  assert.deepEqual(toasts, ["旧配置已升级"]);
});

test("migration_notice 为 false / 无 toast 回调时不触发", () => {
  const toasts = [];
  handleDashboardMigrationNotice({ migration_notice: false }, (m) => toasts.push(m));
  assert.deepEqual(toasts, []);
});

// ===========================================================================
// Task 9：历史生命周期与压缩取消/重试 API
// ===========================================================================
// 按依赖规则 B（tests/architecture/dependency-rules.test.mjs），AgentSurface
// 只能经 src/app-shell/agent/index.js 暴露，测试不得直接 import api.js；因此
// 传输层经 surface 公共 seam 验证（fake transport 断言委托/状态行为 + 真实
// transport 断言端点/body/非 JSON 文本）。cancelCompaction/retryCompaction 尚无
// surface 入口（Task 12 的 handleEscape 接线），其 URL/body 契约由
// tests/http/agent-routes.test.mjs 的路径断言固定。

test("surface: exportHistory 只委托 transport，不改本地状态", async () => {
  const { api, surface } = await makeSurface({
    apiOverrides: {
      exportHistory: async () => {
        api.calls.push(["exportHistory"]);
        return { text: "line1\nline2\n", status: 200 };
      }
    }
  });
  await surface.openProject("D:\\novel");
  const result = await surface.exportHistory();
  assert.deepEqual(api.calls.at(-1), ["exportHistory"]);
  assert.equal(result.text, "line1\nline2\n");
});

test("surface: exportHistory 真实 transport 返回 NDJSON 原文（不按 JSON 解析）", async () => {
  const ndjson = '{"stream":"event","record":{}}\n{"stream":"transcript","record":{}}\n';
  await withFetch((url, options) => {
    if (url.startsWith("/api/project/events")) return { ok: true, status: 200, body: neverStream() };
    if (url.startsWith("/api/agent/history/export")) {
      assert.equal(options.method, "POST");
      return { ok: true, status: 200, text: async () => ndjson };
    }
    if (url.startsWith("/api/agent/snapshot")) return snapshotResponse(null);
    return jsonResponse({ ok: true });
  }, async (calls) => {
    const { surface } = await makeSurface({ useRealTransport: true });
    await surface.openProject("D:\\novel");
    const result = await surface.exportHistory();
    const exportCall = calls.find((c) => String(c.url) === "/api/agent/history/export");
    assert.ok(exportCall, "应调用 history/export 端点");
    assert.deepEqual(JSON.parse(exportCall.options.body), { projectRoot: "D:\\novel" });
    assert.equal(result.text, ndjson, "应原样返回 NDJSON 文本，而不是 JSON 解析结果");
    assert.equal(result.status, 200);
    surface.destroy();
  });
});

test("surface: clearHistory 成功后重置投影并重开当前项目（clear-reconnect）", async () => {
  const { root, api, surface } = await makeSurface({
    apiOverrides: {
      clearHistory: async (options) => {
        api.calls.push(["clearHistory", options]);
        return { ok: true, session_id: "sess-new", status: "idle", generation_id: "g2" };
      }
    }
  });
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("input_queued", { input_id: "in-1", text: "旧会话消息", source: "chat" }));
  assert.ok(root.textContent.includes("旧会话消息"));

  const result = await surface.clearHistory({ confirm_irreversible: true });
  assert.deepEqual(api.calls.filter((c) => c[0] === "clearHistory"), [
    ["clearHistory", { confirm_irreversible: true }]
  ]);
  assert.equal(result.session_id, "sess-new", "清空结果透传给调用方");
  assert.equal(api.calls.filter((c) => c[0] === "openProject").length, 2, "清空后重新打开项目（重连）");
  assert.equal(api.calls.filter((c) => c[0] === "connectEvents").length, 2, "清空后重建 SSE 连接");
  assert.doesNotMatch(root.textContent, /旧会话消息/u, "清空后旧消息不得残留");
});

test("surface: clearHistory 失败（409 history_busy）保留状态并向调用方抛错", async () => {
  const { root, api, surface } = await makeSurface({
    apiOverrides: {
      clearHistory: async () => {
        api.calls.push(["clearHistory"]);
        const error = new Error("Agent 正在运行，无法清空历史。");
        error.code = "history_busy";
        error.status = 409;
        throw error;
      }
    }
  });
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("input_queued", { input_id: "in-1", text: "保留消息", source: "chat" }));
  await assert.rejects(
    surface.clearHistory({ confirm_irreversible: true }),
    (error) => error.code === "history_busy"
  );
  assert.ok(root.textContent.includes("保留消息"), "失败后消息保留");
  assert.equal(api.calls.filter((c) => c[0] === "openProject").length, 1, "失败不重开项目");
});

test("transport surface: clearHistory 终止旧 SSE 并按新 session 重连（真实 transport）", async () => {
  let eventsFetches = 0;
  await withFetch((url) => {
    if (url.startsWith("/api/project/events")) {
      eventsFetches += 1;
      return { ok: true, status: 200, body: neverStream() };
    }
    if (url.startsWith("/api/agent/history/clear")) {
      return jsonResponse({ ok: true, session_id: "sess-new", status: "idle", generation_id: "g2" });
    }
    if (url.startsWith("/api/agent/snapshot")) {
      return jsonResponse({
        ok: true,
        session: session({ session_id: "sess-new" }),
        events: [],
        gaps: [],
        has_more: false
      });
    }
    return jsonResponse({ ok: true });
  }, async (calls) => {
    const { surface } = await makeSurface({ useRealTransport: true });
    await surface.openProject("D:\\novel");
    await surface.clearHistory({ confirm_irreversible: true });
    const clear = calls.find((c) => String(c.url) === "/api/agent/history/clear");
    assert.ok(clear, "应调用 history/clear 端点");
    assert.deepEqual(JSON.parse(clear.options.body), {
      projectRoot: "D:\\novel",
      confirm_irreversible: true
    });
    const snaps = calls.filter((c) => String(c.url).startsWith("/api/agent/snapshot?"));
    assert.ok(snaps.length >= 2, "初始 + 清空后各拉一次快照");
    assert.ok(eventsFetches >= 2, "清空后重建 SSE（旧连接被 transport.openProject 终止）");
    surface.destroy();
  });
});

// ===========================================================================
// Task 13：AgentSurface 公开 seam——Task 9 的历史生命周期方法始终可用
// ===========================================================================

test("surface: 未打开项目时 exportHistory/clearHistory 不抛错（公开 seam 方法）", async () => {
  const { api, surface } = await makeSurface();
  assert.equal(typeof surface.exportHistory, "function", "surface 应始终暴露 exportHistory");
  assert.equal(typeof surface.clearHistory, "function", "surface 应始终暴露 clearHistory");
  const exported = await surface.exportHistory();
  const cleared = await surface.clearHistory({ confirm_irreversible: true });
  assert.equal(exported, null, "无 transport 实现时导出返回 null");
  assert.equal(cleared, undefined, "无项目时清空返回 undefined（不发起请求）");
  assert.ok(!api.calls.some((c) => c[0] === "exportHistory" || c[0] === "clearHistory"),
    "未打开项目不得向 transport 发起历史请求");
});

// ===========================================================================
// Task 10：尾部首屏、前置分页与稳定时间线 key（brief Step 1-4 契约）
// ===========================================================================

const T10_T0 = "2026-08-06T00:00:00.000Z";

// 生成连续历史事件（seq 1..count）：单个 Run 内多轮「思考→工具→答复」。
// 每轮 6 个事件：model_turn_started / reasoning_completed / model_turn_completed /
// tool_call_started / tool_call_completed / assistant_message_completed。
function generateTurnHistory(count, { sessionId = "sess-test", runId = "run-1" } = {}) {
  const events = [];
  const push = (seq, type, payload, extra = {}) => {
    events.push({ seq, event_id: `evt-${seq}`, session_id: sessionId, run_id: runId, type, payload, at: T10_T0, ...extra });
  };
  push(1, "session_created", {});
  push(2, "input_queued", { input_id: "in-1", text: "继续", source: "chat" });
  push(3, "run_started", { workflow: "general", input_id: "in-1" });
  let seq = 4;
  let turn = 1;
  while (seq <= count) {
    const pad = (type, payload, extra = {}) => {
      if (seq <= count) push(seq, type, payload, extra);
      seq += 1;
    };
    pad("model_turn_started", { turn_id: `turn-${turn}`, input_id: "in-1", reasoning_capability: "supported" });
    pad("reasoning_completed", { turn_id: `turn-${turn}`, input_id: "in-1", text: "", availability: "empty" });
    pad("model_turn_completed", { turn_id: `turn-${turn}`, input_id: "in-1", outcome: "completed" });
    pad("tool_call_started", { tool_call_id: `tc-${turn}`, activity_id: `act-${turn}`, name: "list_files", args: { path: "D:\\novel" }, action: null });
    pad("tool_call_completed", { tool_call_id: `tc-${turn}`, activity_id: `act-${turn}`, name: "list_files", exit_code: 0, duration_ms: 5 });
    pad("assistant_message_completed", { input_id: "in-1", text: `第 ${turn} 轮答复` });
    turn += 1;
  }
  return events;
}

test("Task 10 首屏：openProject 以 tail 拉取最后 200 条；滚动到顶触发 beforeSeq 前置页且锚点不跳动", async () => {
  const allEvents = generateTurnHistory(1000); // seq 1..1000
  const tailEvents = allEvents.filter((e) => e.seq >= 801);
  const frontEvents = allEvents.filter((e) => e.seq >= 601 && e.seq <= 800);
  const apiCalls = [];
  let conv = null; // 前置页 stub 用它模拟「插入后内容高度增加」
  const { root, surface } = await makeSurface({
    apiOverrides: {
      fetchSnapshot: async (opts) => {
        apiCalls.push(["snapshot", opts]);
        if (opts.tail) {
          return {
            ok: true,
            session: session({ status: "running", last_seq: 1000, active_run: activeRun({ status: "running" }) }),
            events: tailEvents,
            gaps: [],
            has_more: true
          };
        }
        if (opts.beforeSeq === 801) {
          conv.scrollHeight += 400; // 模拟前置页插入后的内容高度增量
          return { ok: true, session: null, events: frontEvents, gaps: [], has_more: true };
        }
        return { ok: true, session: null, events: [], gaps: [], has_more: false };
      }
    }
  });
  await surface.openProject("D:\\novel");

  assert.deepEqual(apiCalls[0], ["snapshot", { tail: true, limit: 200 }], "首次调用必须是 tail 语义（不再分页补齐全量）");
  const keys = [...root.querySelectorAll("[data-event-key]")].map((el) => el.dataset.eventKey);
  assert.equal(keys.length, new Set(keys).size, "尾部页节点 event key 无重复");
  assert.ok(keys.length > 0, "尾部页应渲染消息/活动/工作组节点");

  // 滚动到顶 → 前置页；插入前记录 oldHeight/oldTop，插入后按差恢复 scrollTop（不跳动）
  conv = root.querySelector('[data-testid="agent-conversation"]');
  conv.scrollHeight = 600;
  conv.clientHeight = 200;
  conv.scrollTop = 0;
  const heightBefore = conv.scrollHeight;
  const topBefore = conv.scrollTop;
  conv._fire("scroll");
  await tick();
  await tick();

  assert.deepEqual(apiCalls.at(-1), ["snapshot", { beforeSeq: 801, limit: 200 }], "滚动到顶应触发 beforeSeq 前置页");
  const keysAfter = [...root.querySelectorAll("[data-event-key]")].map((el) => el.dataset.eventKey);
  assert.equal(keysAfter.length, new Set(keysAfter).size, "前置页合并后 event key 仍无重复");
  assert.ok(keysAfter.length > keys.length, "前置页应追加更早的消息节点");
  assert.equal(
    conv.scrollTop,
    topBefore + (conv.scrollHeight - heightBefore),
    "前置插入后按 oldHeight→newHeight 差恢复 scrollTop，原消息锚点不跳动"
  );
});

test("Task 10 去重：重复同一 seq 的 SSE 与重复前置页不重复生成消息", async () => {
  const allEvents = generateTurnHistory(400); // seq 1..400
  const tailEvents = allEvents.filter((e) => e.seq >= 201);
  const frontEvents = allEvents.filter((e) => e.seq >= 101 && e.seq <= 200);
  const apiCalls = [];
  const { root, surface } = await makeSurface({
    apiOverrides: {
      fetchSnapshot: async (opts) => {
        apiCalls.push(["snapshot", opts]);
        if (opts.tail) {
          return {
            ok: true,
            session: session({ status: "running", last_seq: 400, active_run: activeRun({ status: "running" }) }),
            events: tailEvents,
            gaps: [],
            has_more: true
          };
        }
        if (opts.beforeSeq === 201) {
          return { ok: true, session: null, events: frontEvents, gaps: [], has_more: true };
        }
        return { ok: true, session: null, events: [], gaps: [], has_more: false };
      }
    }
  });
  await surface.openProject("D:\\novel");
  const countKeys = () => [...root.querySelectorAll("[data-event-key]")].map((el) => el.dataset.eventKey);
  const afterTail = countKeys();
  assert.ok(afterTail.length > 0);

  // 重复 SSE：同一 seq 的同一事件再次推送 → 不新增节点
  surface.applyEvent({ ...tailEvents.at(-1) });
  assert.deepEqual(countKeys(), afterTail, "重复同一 seq 的 SSE 不得重复生成消息");

  // 滚动到顶 → 前置页
  const conv = root.querySelector('[data-testid="agent-conversation"]');
  conv.scrollHeight = 400;
  conv.clientHeight = 200;
  conv.scrollTop = 0;
  conv._fire("scroll");
  await tick();
  await tick();
  const afterFront = countKeys();
  assert.ok(afterFront.length > afterTail.length, "前置页应追加更早消息");
  assert.equal(afterFront.length, new Set(afterFront).size, "前置页与尾页合并后 key 无重复");

  // 重复前置页（同一页再次 applySnapshot）：merge 去重，不新增节点
  surface.applySnapshot({ ok: true, session: null, events: frontEvents, gaps: [], has_more: true });
  assert.deepEqual(countKeys(), afterFront, "重复前置页不得重复生成消息");
});

test("Task 10 跨页链：尾页先显示正文，前置页合并后工作项出现且不倒退为 running", async () => {
  const mk = (seq, type, payload, extra = {}) => ({
    seq, event_id: `evt-${seq}`, session_id: "sess-test", run_id: "run-1", type, payload, at: T10_T0, ...extra
  });
  // 尾页：只有 tool_call_completed（started 在前置页才加载）
  const tailEvents = [
    mk(801, "history_compacted", { reason: "seed", compacted_at: T10_T0, message_count: 1 }),
    mk(802, "tool_call_completed", { tool_call_id: "tc-1", activity_id: "act-1", name: "write_file", exit_code: 0, duration_ms: 12 }),
    mk(803, "assistant_message_completed", { input_id: "in-1", text: "这是默认可见的最终答案。" }),
    mk(804, "run_completed", {})
  ];
  const frontEvents = [
    mk(601, "run_started", { workflow: "general", input_id: "in-1" }),
    mk(602, "model_turn_started", { turn_id: "turn-1", input_id: "in-1", reasoning_capability: "supported" }),
    mk(603, "reasoning_completed", { turn_id: "turn-1", input_id: "in-1", text: "", availability: "empty" }),
    mk(604, "model_turn_completed", { turn_id: "turn-1", input_id: "in-1", outcome: "completed" }),
    mk(700, "tool_call_started", { tool_call_id: "tc-1", activity_id: "act-1", name: "write_file", args: { path: "D:\\novel" }, action: null })
  ];
  const apiCalls = [];
  const { root, surface } = await makeSurface({
    apiOverrides: {
      fetchSnapshot: async (opts) => {
        apiCalls.push(["snapshot", opts]);
        if (opts.tail) {
          return {
            ok: true,
            session: session({ status: "idle", last_seq: 804, active_run: activeRun({ status: "completed", active_input_id: null }) }),
            events: tailEvents,
            gaps: [],
            has_more: true
          };
        }
        if (opts.beforeSeq === 801) {
          return { ok: true, session: null, events: frontEvents, gaps: [], has_more: false };
        }
        return { ok: true, session: null, events: [], gaps: [], has_more: false };
      }
    }
  });
  await surface.openProject("D:\\novel");

  // 尾页阶段：started 未加载，投影不凭空创建工具工作项；正文默认可见
  assert.equal(root.querySelector(".agent-work-group"), null, "无 started 的工具不渲染占位工作项");
  assert.match(
    root.querySelector('[data-testid="agent-assistant-message"]')?.textContent ?? "",
    /默认可见的最终答案/u,
    "尾页正文默认可见"
  );

  // 前置页合并后：工作组出现，工具项保持 completed，不倒退为 running
  const conv = root.querySelector('[data-testid="agent-conversation"]');
  conv.scrollHeight = 400;
  conv.clientHeight = 200;
  conv.scrollTop = 0;
  conv._fire("scroll");
  await tick();
  await tick();

  assert.deepEqual(apiCalls.at(-1), ["snapshot", { beforeSeq: 801, limit: 200 }]);
  const group = root.querySelector(".agent-work-group");
  assert.ok(group, "前置页合并后应渲染工作组");
  assert.equal(group.dataset.seq, "601", "工作组定位到组的 firstSeq（组首事件）");
  const toolItem = [...root.querySelectorAll(".agent-work-item")].find((el) => el.dataset.kind === "tool");
  assert.ok(toolItem, "工具工作项存在");
  assert.equal(toolItem.dataset.state, "completed", "终态保持 completed，不得倒退为 running");
  const assistantAfter = root.querySelector('[data-testid="agent-assistant-message"]');
  const timelineIndex = (el) => el._parent.children.indexOf(el);
  assert.ok(timelineIndex(group) < timelineIndex(assistantAfter), "工作组仍位于助手正文之前");
});

test("pending 用户气泡在场时，带 seq 的工作组插在气泡之后，不得压到消息上方（B1 时间线修复）", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  // 先有已落定的 Assistant 正文（有 seq 节点），为「工作组夹在有 seq 节点与
  // 无 seq pending 气泡之间」提供场景。
  surface.applyEvent(ev("assistant_message_completed", { input_id: "in-0", text: "先前的回答" }, { seq: 2 }));

  const input = root.querySelector('[data-testid="agent-composer-input"]');
  input.value = "继续第十章";
  root.querySelector('[data-testid="agent-send"]')._fire("click");
  const pending = root.querySelectorAll('[data-testid="agent-user-message"]')
    .find((el) => el.dataset.state === "pending");
  assert.ok(pending, "提交后应出现 pending 用户气泡");

  // 工作组事件（run_started → 带 reasoning 的 model_turn_started），firstSeq=3
  surface.applyEvent(ev("run_started", {}, { seq: 3 }));
  surface.applyEvent(ev("model_turn_started", { turn_id: "turn-1", input_id: "in-1", reasoning_capability: "supported" }, { seq: 4 }));
  const group = root.querySelector(".agent-work-group");
  assert.ok(group, "应用工作组事件后应渲染工作组");
  assert.equal(group.dataset.seq, "3", "工作组 data-seq 保持 group.firstSeq（回归）");

  const timelineIndex = (el) => el._parent.children.indexOf(el);
  assert.ok(
    timelineIndex(pending) < timelineIndex(group),
    "pending 用户气泡必须位于工作组之前（工作组不得压到 pending 消息上方）"
  );

  // 正式用户消息（seq 更小）确认送达 → pending 移除，正式消息在工作组之前
  surface.applyEvent(ev("input_queued", { input_id: "in-1", text: "继续第十章" }, { seq: 1 }));
  surface.applyEvent(ev("input_started", { input_id: "in-1" }, { seq: 1 }));
  assert.equal(
    root.querySelectorAll('[data-testid="agent-user-message"]').find((el) => el.dataset.state === "pending"),
    undefined,
    "确认送达后 pending 气泡应移除"
  );
  const formal = root.querySelectorAll('[data-testid="agent-user-message"]')
    .find((el) => el.dataset.state !== "pending" && /继续第十章/u.test(el.textContent));
  assert.ok(formal, "正式用户消息应渲染");
  const groupAfter = root.querySelector(".agent-work-group");
  assert.ok(timelineIndex(formal) < timelineIndex(groupAfter), "正式用户消息应位于工作组之前");

  // 回归：工具活动仍按 seq 位于 Assistant 正文之前；工作组仍在已定正文之前
  const assistant = root.querySelectorAll('[data-testid="agent-assistant-message"]')
    .find((el) => /先前的回答/u.test(el.textContent));
  assert.ok(assistant, "Assistant 正文仍在");
  assert.ok(timelineIndex(formal) < timelineIndex(assistant), "正式用户消息位于早先正文之后（seq 递增）");
});

test("Task 10 SSE 游标：tail 快照推进 lastSeq，connectEvents 从已加载最大 seq 续流；乱序走重建、递增走增量", async () => {
  // 真实 transport（withFetch stub）：断言 openProject 后事件流 URL 的 afterSeq
  // 等于已加载尾页最大 seq（而非 0 从头重放全量）。
  const allEvents = generateTurnHistory(250); // seq 1..250
  const tailEvents = allEvents.filter((e) => e.seq >= 51); // 尾页 200 条，seq 51..250
  await withFetch((url) => {
    if (url.startsWith("/api/project/events")) return { ok: true, status: 200, body: neverStream() };
    if (url.startsWith("/api/agent/snapshot")) {
      return jsonResponse({
        ok: true,
        session: session({ status: "running", last_seq: 250, active_run: activeRun({ status: "running" }) }),
        events: tailEvents,
        gaps: [],
        has_more: true
      });
    }
    if (url.startsWith("/api/settings/providers")) return jsonResponse({ ok: true, providers: [], default_model: null });
    if (url.startsWith("/api/dashboard")) {
      return jsonResponse({ ok: true, hasProject: true, project: {}, config: { effective: {} } });
    }
    return jsonResponse({ ok: true });
  }, async (calls) => {
    const { root, surface } = await makeSurface({ useRealTransport: true });
    await surface.openProject("D:\\novel");
    await waitUntil(() => calls.some((c) => String(c.url).startsWith("/api/project/events?")));
    const eventsUrl = calls.find((c) => String(c.url).startsWith("/api/project/events?"));
    assert.match(
      String(eventsUrl.url),
      /afterSeq=250/,
      "SSE 应从已加载最大 seq 续流（lastSeq 已由 tail 快照推进），不得 afterSeq=0 重放全量"
    );

    // 严格递增事件：增量 fast path，正常渲染（queued → 「接下来」排队行）
    surface.applyEvent({
      seq: 251, event_id: "e251", session_id: "sess-test", run_id: "run-1",
      type: "input_queued", payload: { input_id: "in-new", text: "递增消息" }, at: T10_T0
    });
    assert.ok(
      root.querySelector('[data-input-id="in-new"]'),
      "严格递增事件应进入增量路径并渲染排队行"
    );

    // 乱序新事件（seq < lastSeq）：全集重建，排队行按 seq 重放、不重复、不丢旧行
    surface.applyEvent({
      seq: 30, event_id: "e30", session_id: "sess-test", run_id: "run-1",
      type: "input_queued", payload: { input_id: "in-old", text: "乱序旧消息" }, at: T10_T0
    });
    const keys = [...root.querySelectorAll("[data-event-key]")].map((el) => el.dataset.eventKey);
    assert.equal(keys.length, new Set(keys).size, "重建后 event key 仍无重复");
    const oldRow = root.querySelector('[data-input-id="in-old"]');
    const incrRow = root.querySelector('[data-input-id="in-new"]');
    assert.ok(oldRow && incrRow, "乱序与递增事件都渲染且互不丢失");
    const queueTexts = [...root.querySelectorAll('[data-testid="agent-queue-item"]')].map((el) => el.textContent);
    assert.ok(queueTexts.indexOf(oldRow.textContent) < queueTexts.indexOf(incrRow.textContent),
      "乱序旧排队行按 seq 位于递增新排队行之前");
    surface.destroy();
  });
});

// ===========================================================================
// Task 11：上下文圆环、压缩状态行与发送门禁
// ===========================================================================

test("项目打开后上下文圆环始终存在；未装配时 popover 显示「计算中」而不是假 0", async () => {
  const { root, surface } = await makeSurface();
  assert.equal(root.querySelector('[data-testid="agent-composer"]').hidden, true, "未打开项目时 composer 隐藏（圆环随 composer 不可见）");
  await surface.openProject("D:\novel");
  const ring = root.querySelector('[data-testid="agent-context-ring"]');
  assert.ok(ring, "项目打开后圆环始终存在（不只在运行/超阈值时）");
  const popover = root.querySelector('[data-testid="agent-context-popover"]');
  assert.ok(popover, "popover 应存在");
  ring._fire("click");
  assert.equal(popover.dataset.open, "true");
  assert.match(popover.textContent, /计算中|待校准/u, "未装配显示计算中");
  assert.doesNotMatch(popover.textContent, /0\s*(?:tokens|%)|0%/u, "计算中绝不显示假 0");
});

test("context_usage_updated 后 popover 显示已用 tokens、窗口、百分比与窗口来源", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\novel");
  surface.applyEvent(ev("context_usage_updated", {
    usage: {
      status: "ready", used_tokens: 163840, raw_tokens: 150000,
      effective_context_window: 256000, compaction_threshold: 204800,
      ratio: 0.64, window_source: "default_256k", estimator: "local",
      approximate: true, model: "deepseek-chat",
      updated_at: "2026-08-08T00:00:00.000Z"
    }
  }));
  const ring = root.querySelector('[data-testid="agent-context-ring"]');
  ring._fire("click");
  const popover = root.querySelector('[data-testid="agent-context-popover"]');
  assert.match(popover.textContent, /约.*163,840|163,840/u, "应显示已用 tokens（约 + 千分位）");
  assert.match(popover.textContent, /256,000/u, "应显示窗口大小");
  assert.match(popover.textContent, /64%/u, "应显示百分比");
  assert.match(popover.textContent, /256k|1M/u, "应显示窗口来源");
});

test("popover 点击固定、再次点击/外部点击/ESC 关闭", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\novel");
  const ring = root.querySelector('[data-testid="agent-context-ring"]');
  const popover = root.querySelector('[data-testid="agent-context-popover"]');
  ring._fire("click");
  assert.equal(popover.dataset.open, "true");
  assert.equal(ring.dataset.pinned, "true", "点击固定");
  ring._fire("click");
  assert.equal(popover.dataset.open, "false", "再次点击关闭");
  ring._fire("click");
  globalThis.document._fire("pointerdown", { target: root });
  assert.equal(popover.dataset.open, "false", "外部点击关闭");
  // Task 12：ESC 经 surface 统一路由（dismissTopLayer）关闭，圆环自身不再
  // 挂 document-level keydown，避免与全局路由重复执行。
  ring._fire("click");
  const unwire = wireEscRoute(surface);
  try {
    const event = fireEsc();
    assert.equal(popover.dataset.open, "false", "ESC 关闭（经 surface.handleEscape 统一路由）");
    assert.equal(event.defaultPrevented, true);
  } finally {
    unwire();
  }
});

test("压缩状态行：同一 compaction_id 单行顶替 开始压缩→压缩进行中→已压缩完成", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\novel");
  surface.applyEvent(ev("context_compaction_started", { compaction_id: "c-1", trigger: "automatic" }));
  let row = root.querySelector('[data-testid="agent-compaction-row"]');
  assert.ok(row, "started 后出现压缩状态行");
  assert.equal(row.textContent, "开始压缩");
  surface.applyEvent(ev("context_compaction_running", { compaction_id: "c-1" }));
  row = root.querySelector('[data-testid="agent-compaction-row"]');
  assert.equal(row.textContent, "压缩进行中");
  assert.ok(row.parentElement.querySelector('[data-testid="agent-compaction-cancel"]'), "running 显示取消按钮");
  surface.applyEvent(ev("context_compaction_completed", { compaction_id: "c-1", checkpoint_id: "cp-1" }));
  row = root.querySelector('[data-testid="agent-compaction-row"]');
  assert.equal(row.textContent, "已压缩完成");
  assert.equal(root.querySelectorAll('[data-testid="agent-compaction-row"]').length, 1, "同一 compaction_id 只有一行");
  assert.equal(row.parentElement.querySelector('[data-testid="agent-compaction-cancel"]'), null, "完成后移除按钮");
  assert.doesNotMatch(row.textContent, /token|模型|耗时|\d+\s*ms/u, "完成文案不显示 token/模型/耗时");
});

test("压缩失败：状态行「压缩失败」+ 重试/取消按钮，发送禁用直到用户操作", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\novel");
  const send = root.querySelector('[data-testid="agent-send"]');
  assert.equal(send.disabled, false, "无压缩时发送可用");
  surface.applyEvent(ev("context_compaction_started", { compaction_id: "c-2", trigger: "automatic" }));
  surface.applyEvent(ev("context_compaction_running", { compaction_id: "c-2" }));
  assert.equal(send.disabled, true, "压缩进行中发送禁用");
  surface.applyEvent(ev("context_compaction_failed", { compaction_id: "c-2", error_code: "model_error" }));
  const row = root.querySelector('[data-testid="agent-compaction-row"]');
  assert.equal(row.textContent, "压缩失败");
  assert.ok(row.parentElement.querySelector('[data-testid="agent-compaction-retry"]'), "失败显示重试按钮");
  assert.ok(row.parentElement.querySelector('[data-testid="agent-compaction-cancel"]'), "失败显示取消按钮");
  assert.equal(send.disabled, true, "失败后发送保持禁用（等待用户 重试/取消）");
});

test("压缩取消完成：发送恢复，draft 留在 textarea；无需压缩时发送正常", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\novel");
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  const send = root.querySelector('[data-testid="agent-send"]');
  input.value = "保留的草稿";
  surface.applyEvent(ev("context_compaction_started", { compaction_id: "c-3", trigger: "automatic" }));
  surface.applyEvent(ev("context_compaction_cancel_requested", { compaction_id: "c-3" }));
  assert.equal(root.querySelector('[data-testid="agent-compaction-row"]').textContent, "正在取消");
  assert.equal(send.disabled, true, "取消中发送禁用");
  surface.applyEvent(ev("context_compaction_cancelled", { compaction_id: "c-3", cancel_reason: "user" }));
  assert.equal(root.querySelector('[data-testid="agent-compaction-row"]').textContent, "已取消");
  assert.equal(send.disabled, false, "取消完成后发送恢复");
  assert.equal(input.value, "保留的草稿", "draft 留在 textarea，恢复后原样可发");
  surface.applyEvent(ev("context_compaction_noop", { compaction_id: "c-4", trigger: "automatic" }));
  const noopRow = [...root.querySelectorAll('[data-testid="agent-compaction-row"]')]
    .find((el) => el.parentElement.dataset.compactionId === "c-4");
  assert.equal(noopRow.textContent, "无需压缩");
  assert.equal(root.querySelector('[data-testid="agent-send"]').disabled, false, "noop 不阻塞发送");
});

test("压缩行动作按钮调用 retryCompaction / cancelCompaction", async () => {
  const { root, api, surface } = await makeSurface();
  await surface.openProject("D:\novel");
  surface.applyEvent(ev("context_compaction_started", { compaction_id: "c-5", trigger: "automatic" }));
  surface.applyEvent(ev("context_compaction_running", { compaction_id: "c-5" }));
  surface.applyEvent(ev("context_compaction_failed", { compaction_id: "c-5", error_code: "model_error" }));
  const row = root.querySelector('[data-testid="agent-compaction-row"]');
  row.parentElement.querySelector('[data-testid="agent-compaction-retry"]')._fire("click");
  row.parentElement.querySelector('[data-testid="agent-compaction-cancel"]')._fire("click");
  const calls = api.calls.filter((c) => c[0] === "retryCompaction" || c[0] === "cancelCompaction");
  assert.deepEqual(calls, [["retryCompaction", "c-5"], ["cancelCompaction", "c-5"]]);
});

test("不同 compaction_id 各行独立渲染，终态行保留在时间线", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\novel");
  surface.applyEvent(ev("context_compaction_started", { compaction_id: "c-1", trigger: "automatic" }));
  surface.applyEvent(ev("context_compaction_running", { compaction_id: "c-1" }));
  surface.applyEvent(ev("context_compaction_completed", { compaction_id: "c-1", checkpoint_id: "cp-1" }));
  surface.applyEvent(ev("context_compaction_started", { compaction_id: "c-2", trigger: "manual" }));
  surface.applyEvent(ev("context_compaction_running", { compaction_id: "c-2" }));
  const rows = root.querySelectorAll('[data-testid="agent-compaction-row"]');
  assert.equal(rows.length, 2, "两个 compaction_id 各一行");
  assert.equal(rows[0].textContent, "已压缩完成", "c-1 终态行保留");
  assert.equal(rows[1].textContent, "压缩进行中");
});


test("压缩投影与状态行在乱序全集重建后保持（增量 fast path 与 rebuild 一致）", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applyEvent(ev("context_compaction_started", { compaction_id: "c-1", trigger: "automatic" }));
  surface.applyEvent(ev("context_compaction_running", { compaction_id: "c-1" }));
  surface.applyEvent(ev("context_compaction_completed", { compaction_id: "c-1", checkpoint_id: "cp-1" }));
  // 乱序旧事件（seq < lastSeq）触发按已加载全集重建
  surface.applyEvent({ ...ev("input_queued", { input_id: "in-old", text: "旧消息", source: "chat" }), seq: 10 });
  const row = root.querySelector('[data-testid="agent-compaction-row"]');
  assert.equal(row.textContent, "已压缩完成", "重建后压缩行保持终态");
  assert.equal(root.querySelector('[data-testid="agent-send"]').disabled, false, "重建后发送门禁状态正确");
});

test("圆环活性：仅运行中/压缩进行中加 agent-context-ring--active，终态移除", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  const ring = root.querySelector('[data-testid="agent-context-ring"]');
  assert.equal(ring.classList.contains("agent-context-ring--active"), false, "空闲圆环无活性 class");
  surface.applyEvent(ev("run_started", { workflow: "general", input_id: "in-1" }));
  assert.equal(ring.classList.contains("agent-context-ring--active"), true, "运行中加活性 class");
  surface.applyEvent(ev("run_completed", {}));
  assert.equal(ring.classList.contains("agent-context-ring--active"), false, "运行终态移除活性 class");
  surface.applyEvent(ev("context_compaction_started", { compaction_id: "c-1", trigger: "automatic" }));
  surface.applyEvent(ev("context_compaction_running", { compaction_id: "c-1" }));
  assert.equal(ring.classList.contains("agent-context-ring--active"), true, "压缩进行中加活性 class");
  surface.applyEvent(ev("context_compaction_completed", { compaction_id: "c-1", checkpoint_id: "cp-1" }));
  assert.equal(ring.classList.contains("agent-context-ring--active"), false, "压缩终态移除活性 class");
});

test("reduced-motion 下圆环不加活性 class（无循环动画）", async () => {
  const realWindow = globalThis.window;
  globalThis.window = {
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} })
  };
  try {
    const { root, surface } = await makeSurface();
    await surface.openProject("D:\\novel");
    surface.applyEvent(ev("run_started", { workflow: "general", input_id: "in-1" }));
    const ring = root.querySelector('[data-testid="agent-context-ring"]');
    assert.equal(ring.classList.contains("agent-context-ring--active"), false, "reduced-motion 下圆环保持静态");
  } finally {
    if (realWindow === undefined) delete globalThis.window;
    else globalThis.window = realWindow;
  }
});

test("Task 11 CSS：popover 过渡、压缩行、主题 token 与 reduced-motion 降级", async () => {
  const css = await fs.readFile(path.join(here, "..", "..", "src", "app-shell", "agent", "agent.css"), "utf8");
  // popover 进入/退出：120–180ms opacity + transform translateY(2px) scale(.98)
  assert.match(
    css,
    /\.agent-context-popover\s*\{[^}]*transition:\s*[^}]*150ms[^}]*\}/u,
    "popover 过渡应为 150ms（120–180ms 区间）"
  );
  assert.match(
    css,
    /transform:\s*translate\(-50%,\s*2px\)\s*scale\(\.98\)/u,
    "popover 进入态 transform: translateY(2px) scale(.98)"
  );
  // 浅色/深色自适应：popover 背景由 theme token 驱动，无硬编码色值
  assert.match(
    css,
    /\.agent-context-popover\s*\{[^}]*background:\s*color-mix\([^}]*var\(--agent-panel-solid\)[^}]*\}/u,
    "popover 背景使用 theme token（浅色/深色自适应）"
  );
  assert.match(css, /\.agent-context-ring\s*\{[^}]*cursor:\s*pointer/u, "圆环按钮样式存在");
  assert.match(css, /\.agent-compaction-row\s*\{/u, "压缩行样式存在");
  assert.match(css, /\.agent-compaction-btn\s*\{/u, "压缩行动作按钮样式存在");
  // reduced-motion：popover 过渡关闭
  assert.match(
    css,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.agent-context-popover[\s\S]*transition:\s*none/u,
    "reduced-motion 下 popover 过渡关闭"
  );
  // 无框基线：消息/推理/工具详情/输出容器不得出现表面底色（输出用 --code-bg 而非面板底色）
  assert.doesNotMatch(css, /\.agent-tool-(?:details|fields|field|output)\s*\{[^}]*background:\s*var\(--(?:surface|accent)/u);
  assert.doesNotMatch(css, /\.agent-reasoning-(?:ticker|detail)\s*\{[^}]*background:\s*var\(--(?:surface|accent)/u);
});

// ===========================================================================
// Task 12：统一 ESC 路由（真实 document 事件顺序契约）
// ===========================================================================
// app.js 的 document keydown 是 ESC 唯一入口：先关 app 顶层（drawer/reader/
// settings/create/shortcuts），未消费时交给 agentSurface.handleEscape()。
// 这里用与 app.js 相同的接线把 surface 挂到 mock document 上，再用真实
// document 事件驱动，保证「一层 ESC 只执行第一项」的契约端到端成立。
// 覆盖（brief Step 1）：
//   - 菜单/弹层打开 + Run running → 只关闭最上层，不调用 stop；
//   - 无弹层 + compaction running → 只调用 cancelCompaction 一次；
//   - 无弹层 + 普通 Run running → 只调用 stop 一次；
//   - 空闲 → 不 preventDefault、不调用 API、不 Toast；
//   - 连按两次 ESC 只产生一个请求；请求失败或同 id 终态到达后才释放 latch。

function wireEscRoute(surface) {
  const handler = (event) => {
    if (event?.key !== "Escape") return;
    if (event.defaultPrevented) return; // 内层（textarea 关闭 slash menu 等）已消费
    const handled = surface.handleEscape();
    if (handled) event.preventDefault?.();
  };
  globalThis.document.addEventListener("keydown", handler);
  return () => globalThis.document.removeEventListener("keydown", handler);
}

function fireEsc() {
  const event = { key: "Escape", defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  globalThis.document._fire("keydown", event);
  return event;
}

function escCalls(api, name) {
  return api.calls.filter((c) => c[0] === name).map((c) => c[1]);
}

test("ESC：context popover 打开 + Run running → 只关闭弹层，不调用 stop/cancelCompaction", async () => {
  const { root, api, surface } = await makeSurface();
  const unwire = wireEscRoute(surface);
  try {
    await surface.openProject("D:\\novel");
    surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
    const ring = root.querySelector('[data-testid="agent-context-ring"]');
    const popover = root.querySelector('[data-testid="agent-context-popover"]');
    ring._fire("click");
    assert.equal(popover.dataset.open, "true", "弹层已打开");
    const event = fireEsc();
    assert.equal(popover.dataset.open, "false", "ESC 只关闭最上层弹层");
    assert.equal(event.defaultPrevented, true, "关闭弹层应消费 ESC");
    assert.equal(escCalls(api, "stop").length, 0, "不得调用 stop");
    assert.equal(escCalls(api, "cancelCompaction").length, 0, "不得调用 cancelCompaction");
  } finally {
    unwire();
  }
});

test("ESC：slash menu 打开 + Run running → textarea 只关闭菜单，全局路由不再停止 Run", async () => {
  const { root, api, surface } = await makeSurface();
  const unwire = wireEscRoute(surface);
  try {
    await surface.openProject("D:\\novel");
    surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
    const input = root.querySelector('[data-testid="agent-composer-input"]');
    input.value = "/";
    input._fire("input");
    const menu = root.querySelector('[data-testid="agent-slash-menu"]');
    assert.equal(menu.hidden, false, "slash menu 已打开");
    // textarea 自己的 keydown：只在此处消费 ESC 并 preventDefault（事件随后冒泡到 document）
    let prevented = false;
    input._fire("keydown", { key: "Escape", shiftKey: false, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true, "slash menu 打开时 textarea 消费 ESC");
    assert.equal(menu.hidden, true, "菜单已关闭");
    // 冒泡到 document：defaultPrevented → 全局路由不再处理 → Run 不被停止
    globalThis.document._fire("keydown", { key: "Escape", defaultPrevented: true, preventDefault() { this.defaultPrevented = true; } });
    assert.equal(escCalls(api, "stop").length, 0, "菜单已消费 ESC，不得再停止 Run");
    assert.equal(escCalls(api, "cancelCompaction").length, 0);
  } finally {
    unwire();
  }
});

test("ESC：composer 菜单打开 + Run running → 只关闭菜单，不调用 stop", async () => {
  await withFetch((url) => {
    if (url.startsWith("/api/project/events")) return { ok: true, status: 200, body: neverStream() };
    if (url === "/api/settings/providers") {
      return jsonResponse({ ok: true, providers: [
        { id: "p-1", name: "P1", status: "enabled", base_url: "https://x/v1", models: [{ id: "m-1", model_name: "m-1", enabled: true }] }
      ], default_model: null });
    }
    if (url.startsWith("/api/dashboard?")) {
      return jsonResponse({
        ok: true, hasProject: true, project: {}, model_profile: { model_name: "m-1", capabilities: null },
        config: {
          effective: {
            active_model: { provider: "openai-compatible", provider_id: "p-1", model_id: "m-1", model_name: "m-1", base_url: "https://x/v1" },
            tool_permissions: {}, reasoning_effort: "auto"
          }
        }
      });
    }
    if (url.startsWith("/api/agent/snapshot")) {
      return snapshotResponse(session({ status: "running", active_run: activeRun() }));
    }
    return jsonResponse({ ok: true });
  }, async (calls) => {
    const { root, surface } = await makeSurface({ useRealTransport: true });
    const unwire = wireEscRoute(surface);
    try {
      await surface.openProject("D:\\novel");
      const trigger = root.querySelector('[data-testid="agent-model-select"]');
      await waitUntil(() => trigger.disabled === false);
      const menu = root.querySelector('[data-testid="agent-model-menu"]');
      trigger._fire("click");
      assert.equal(menu.hidden, false, "模型菜单已打开");
      const event = fireEsc();
      assert.equal(menu.hidden, true, "ESC 只关闭菜单");
      assert.equal(event.defaultPrevented, true, "关闭菜单应消费 ESC");
      const stopCalls = calls.filter((c) => String(c.url).endsWith("/run/run-1/stop") && c.options.method === "POST");
      assert.equal(stopCalls.length, 0, "不得调用 stop");
    } finally {
      unwire();
      surface.destroy();
    }
  });
});

test("ESC：无弹层 + compaction running（同时 Run running）→ 只 cancelCompaction 一次，不 stop", async () => {
  const { api, surface } = await makeSurface();
  const unwire = wireEscRoute(surface);
  try {
    await surface.openProject("D:\\novel");
    surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
    surface.applyEvent(ev("context_compaction_started", { compaction_id: "c-1", trigger: "automatic" }));
    surface.applyEvent(ev("context_compaction_running", { compaction_id: "c-1" }));
    const event = fireEsc();
    assert.equal(event.defaultPrevented, true, "压缩取消请求消费 ESC");
    assert.deepEqual(escCalls(api, "cancelCompaction"), ["c-1"], "压缩优先于普通 Run");
    assert.equal(escCalls(api, "stop").length, 0, "压缩在途不得转而停止 Run");
  } finally {
    unwire();
  }
});

test("ESC：无弹层 + 普通 Run running → 只 stop 一次", async () => {
  const { api, surface } = await makeSurface();
  const unwire = wireEscRoute(surface);
  try {
    await surface.openProject("D:\\novel");
    surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
    const event = fireEsc();
    assert.equal(event.defaultPrevented, true, "停止请求消费 ESC");
    assert.deepEqual(escCalls(api, "stop"), ["run-1"]);
    assert.equal(escCalls(api, "cancelCompaction").length, 0);
  } finally {
    unwire();
  }
});

test("ESC：空闲 → 不 preventDefault、不调用 API", async () => {
  const { api, surface } = await makeSurface();
  const unwire = wireEscRoute(surface);
  try {
    await surface.openProject("D:\\novel");
    const before = api.calls.length; // openProject 自身产生的 openProject/fetchSnapshot/connectEvents
    const event = fireEsc();
    assert.equal(event.defaultPrevented, false, "空闲 ESC 不 preventDefault");
    assert.equal(api.calls.length, before, "空闲 ESC 不新增任何 API 调用");
  } finally {
    unwire();
  }
});

test("ESC 去重：压缩取消在途连按两次只发一次请求；cancelling 吞掉；同 id 终态释放 latch", async () => {
  const { api, surface } = await makeSurface();
  const unwire = wireEscRoute(surface);
  try {
    await surface.openProject("D:\\novel");
    surface.applyEvent(ev("context_compaction_started", { compaction_id: "c-1", trigger: "automatic" }));
    surface.applyEvent(ev("context_compaction_running", { compaction_id: "c-1" }));
    fireEsc();
    fireEsc();
    assert.equal(escCalls(api, "cancelCompaction").length, 1, "连按两次只发一次取消请求");
    // 后端确认进入 cancelling：后续 ESC 一律吞掉
    surface.applyEvent(ev("context_compaction_cancel_requested", { compaction_id: "c-1" }));
    fireEsc();
    assert.equal(escCalls(api, "cancelCompaction").length, 1, "cancelling 期间 ESC 吞掉");
    assert.equal(escCalls(api, "stop").length, 0, "cancelling 期间不得转而停止普通 Run");
    // 同 id 终态到达 → latch 释放；此后 ESC 不再产生新请求
    surface.applyEvent(ev("context_compaction_cancelled", { compaction_id: "c-1", cancel_reason: "user" }));
    fireEsc();
    assert.equal(escCalls(api, "cancelCompaction").length, 1, "终态后不再取消");
    assert.equal(escCalls(api, "stop").length, 0);
  } finally {
    unwire();
  }
});

test("ESC 去重：停止在途连按两次只发一次 stop；stopping 吞掉；同 id run 终态释放 latch", async () => {
  const { api, surface } = await makeSurface();
  const unwire = wireEscRoute(surface);
  try {
    await surface.openProject("D:\\novel");
    surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
    fireEsc();
    fireEsc();
    assert.equal(escCalls(api, "stop").length, 1, "连按两次只发一次 stop");
    // stopping 期间 ESC 吞掉，不得再次 stop
    surface.applyEvent(ev("run_status_changed", { status: "stopping", reason: "user_stop" }));
    fireEsc();
    assert.equal(escCalls(api, "stop").length, 1, "stopping 期间 ESC 吞掉");
    // 同 id run 终态 → latch 释放
    surface.applyEvent(ev("run_cancelled", { reason: "user_stop" }));
    fireEsc();
    assert.equal(escCalls(api, "stop").length, 1, "终态后不再 stop");
  } finally {
    unwire();
  }
});

test("ESC 去重：重连补齐快照里的同 id 终态必须释放 latch（I4，不得死锁 ESC）", async () => {
  const { api, surface } = await makeSurface();
  const unwire = wireEscRoute(surface);
  try {
    await surface.openProject("D:" + "\novel");
    surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
    fireEsc();
    assert.deepEqual(escCalls(api, "stop"), ["run-1"], "停止请求发出");
    // SSE 断线：cancel 已生效但 run_cancelled 事件从未经 applyEvent 送达——重连
    // 补齐快照（afterSeq 从合并后的 max seq 续读）把终态事件带回来了。
    surface.applySnapshot(snapshotOf(
      session({ status: "idle", last_seq: 9, active_run: activeRun({ status: "cancelled", active_input_id: null }) }),
      [{ ...ev("run_cancelled", { reason: "user_stop" }), seq: 9 }]
    ));
    // latch 必须已释放：压缩在途时 ESC 走 cancelCompaction 而不是被吞掉
    surface.applyEvent(ev("context_compaction_started", { compaction_id: "c-1", trigger: "automatic" }));
    surface.applyEvent(ev("context_compaction_running", { compaction_id: "c-1" }));
    fireEsc();
    assert.deepEqual(escCalls(api, "cancelCompaction"), ["c-1"], "快照终态释放 latch：ESC 可取消压缩");
    assert.equal(escCalls(api, "stop").length, 1, "不得重复 stop");
  } finally {
    unwire();
  }
});

test("ESC 去重：取消请求失败立即释放 latch，再次 ESC 可重试", async () => {
  const { api, surface } = await makeSurface({
    apiOverrides: {
      cancelCompaction: async (compactionId) => {
        api.calls.push(["cancelCompaction", compactionId]);
        throw new Error("compaction 已结束");
      }
    }
  });
  const unwire = wireEscRoute(surface);
  try {
    await surface.openProject("D:\\novel");
    surface.applyEvent(ev("context_compaction_started", { compaction_id: "c-1", trigger: "automatic" }));
    surface.applyEvent(ev("context_compaction_running", { compaction_id: "c-1" }));
    fireEsc();
    await tick();
    fireEsc();
    assert.equal(escCalls(api, "cancelCompaction").length, 2, "失败后 latch 释放，再次 ESC 可重试");
  } finally {
    unwire();
  }
});

test("transport surface: handleEscape 的 stop/cancelCompaction 使用正确端点、作用域与 body（真实 transport）", async () => {
  await withFetch((url) => {
    if (url.startsWith("/api/project/events")) return { ok: true, status: 200, body: neverStream() };
    if (url.startsWith("/api/agent/snapshot")) return snapshotResponse(session({ status: "running", active_run: activeRun() }));
    return jsonResponse({ ok: true });
  }, async (calls) => {
    const { surface } = await makeSurface({ useRealTransport: true });
    const unwire = wireEscRoute(surface);
    try {
      await surface.openProject("D:\\novel");
      fireEsc();
      await tick();
      const stopCalls = calls.filter((c) => String(c.url).endsWith("/api/agent/run/run-1/stop"));
      assert.equal(stopCalls.length, 1, "ESC 经真实 transport 调用 stop 端点");
      assert.deepEqual(JSON.parse(stopCalls[0].options.body), { projectRoot: "D:\\novel" });
      // 同 id run 终态释放 latch 后，压缩在途时 ESC 走 cancel 端点
      surface.applyEvent(ev("run_cancelled", { reason: "user_stop" }));
      surface.applyEvent(ev("context_compaction_started", { compaction_id: "c-1", trigger: "automatic" }));
      surface.applyEvent(ev("context_compaction_running", { compaction_id: "c-1" }));
      fireEsc();
      await tick();
      const cancelCalls = calls.filter((c) => String(c.url).endsWith("/api/agent/compaction/c-1/cancel"));
      assert.equal(cancelCalls.length, 1, "ESC 经真实 transport 调用 cancel 端点");
      assert.deepEqual(JSON.parse(cancelCalls[0].options.body), { projectRoot: "D:\\novel" });
    } finally {
      unwire();
      surface.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// Task 8 多会话：switchSession / 新对话占位 / busy / 会话代次守卫
// ---------------------------------------------------------------------------

test("switchSession：切换会话重拉快照并重置视图；新对话占位提交后回调会话列表", async () => {
  const calls = [];
  const sessions = [
    { session_id: "sid-1", title: "会话一", archived_at: null },
    { session_id: "sid-2", title: "会话二", archived_at: null }
  ];
  const sid1Snapshot = snapshotOf(session({ session_id: "sid-1", last_seq: 4 }), [
    { ...ev("input_queued", { input_id: "in-1", text: "会话一消息", source: "chat" }, { session_id: "sid-1" }), seq: 1 },
    { ...ev("input_started", { input_id: "in-1" }, { session_id: "sid-1" }), seq: 2 },
    { ...ev("run_started", { workflow: "general", input_id: "in-1" }, { session_id: "sid-1" }), seq: 3 },
    { ...ev("run_completed", {}), seq: 4 }
  ]);
  const sid2Snapshot = snapshotOf(session({ session_id: "sid-2", last_seq: 2 }), [
    { ...ev("input_queued", { input_id: "in-2", text: "会话二消息", source: "chat" }, { session_id: "sid-2" }), seq: 1 },
    { ...ev("input_started", { input_id: "in-2" }, { session_id: "sid-2" }), seq: 2 }
  ]);
  const sessionsChanged = [];
  const { root, surface } = await makeSurface({
    apiOverrides: {
      openProject: async (rootPath, sessionId) => { calls.push(["openProject", rootPath, sessionId ?? null]); },
      fetchSnapshot: async (options) => {
        calls.push(["fetchSnapshot", options]);
        if (options?.sessionId === "sid-1") return sid1Snapshot;
        if (options?.sessionId === "sid-2") return sid2Snapshot;
        return null;
      },
      submit: async (text) => { calls.push(["submit", text]); return { ok: true, session_id: "sid-3", input_id: "in-3" }; },
      createSession: async () => {
        const meta = { session_id: "sid-3", title: "新对话", archived_at: null };
        sessions.push(meta);
        return { session: meta };
      },
      sessions: async () => ({ sessions: [...sessions], active_session_id: null })
    },
    callbacks: {
      onSessionsChanged: (list, active) => sessionsChanged.push([list, active])
    }
  });

  await surface.openProject("D:\\novel", "sid-1");
  const snap1 = calls.findLast((c) => c[0] === "fetchSnapshot");
  assert.equal(snap1[1].sessionId, "sid-1", "openProject 按指定会话拉快照");
  assert.equal(snap1[1].tail, true, "首见会话用尾页语义");
  assert.match(root.textContent, /会话一消息/u);

  await surface.switchSession("sid-2");
  const snap2 = calls.findLast((c) => c[0] === "fetchSnapshot");
  assert.equal(snap2[1].sessionId, "sid-2", "switchSession 按新会话拉快照");
  assert.equal(snap2[1].tail, true, "首见会话用尾页语义");
  assert.match(root.textContent, /会话二消息/u);
  assert.doesNotMatch(root.textContent, /会话一消息/u, "切换会话必须清空旧会话消息（state 重置）");

  // 切回缓存会话：按已见游标增量补齐，不重拉全量
  await surface.switchSession("sid-1");
  const snap3 = calls.findLast((c) => c[0] === "fetchSnapshot");
  assert.equal(snap3[1].sessionId, "sid-1");
  assert.equal(snap3[1].afterSeq, 4, "缓存会话切回按已见游标增量补齐");
  assert.match(root.textContent, /会话一消息/u);

  // 新对话占位：本地未落盘，占位期间列表不出现 draft 项（发送首条消息前左侧
  // 不显示任何新项）；占位 id 仍是活跃会话指针（右侧空白对话 + composer 可输入）。
  const draftId = surface.newSessionPlaceholder();
  // 精确等待：最新一次通知的活跃指针为 draft id 且列表不含 draft 项（避免未来前置
  // 操作引入 emit 时取到旧条目——等待条件按「最新一次」而非「非空」判定）。
  await waitUntil(() => {
    const last = sessionsChanged[sessionsChanged.length - 1];
    return last != null && last[1] === draftId && !last[0].some((s) => String(s.session_id).startsWith("draft-"));
  });
  const draftNotice = sessionsChanged.findLast(([, active]) => active === draftId);
  assert.equal(draftNotice[1], draftId, "占位仍是当前活跃会话指针");
  assert.ok(
    !draftNotice[0].some((s) => String(s.session_id).startsWith("draft-")),
    "占位不进入会话列表（列表不含 draft 项）"
  );
  assert.deepEqual(draftNotice[0].map((s) => s.session_id), ["sid-1", "sid-2"], "列表为后端真实会话原样透传");
  assert.ok(
    calls.some((c) => c[0] === "openProject" && c[1] === "D:\\novel" && c[2] === null),
    "占位进入时中止旧 SSE 连接（transport.openProject 清请求作用域）"
  );

  // 占位提交：createSession 落盘 → 替换占位 → submit → 刷新列表
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  input.value = "新对话的第一条消息";
  root.querySelector('[data-testid="agent-send"]')._fire("click");
  await waitUntil(() => sessionsChanged.some(([list]) => list.some((s) => s.session_id === "sid-3")));
  assert.ok(
    calls.some((c) => c[0] === "openProject" && c[1] === "D:\\novel" && c[2] === "sid-3"),
    "占位提交后 transport 切到新会话"
  );
  assert.ok(calls.some((c) => c[0] === "submit" && c[1] === "新对话的第一条消息"), "输入提交到新会话");
  const finalList = sessionsChanged[sessionsChanged.length - 1][0];
  assert.ok(finalList.some((s) => s.session_id === "sid-3"), "刷新后列表含新会话");
  assert.ok(!finalList.some((s) => String(s.session_id).startsWith("draft-")), "提交后占位从列表消失");
});

test("setBusy：禁用发送键并提示另一个对话在运行，输入框不锁", async () => {
  const { root, api, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  const send = root.querySelector('[data-testid="agent-send"]');
  assert.equal(send.disabled, false);
  assert.equal(input.placeholder, "输入消息");

  surface.setBusy(true);
  assert.equal(send.disabled, true, "busy 时发送键禁用");
  assert.equal(input.disabled, false, "busy 时输入框不锁（草稿可继续编辑）");
  assert.equal(input.placeholder, "另一个对话正在运行");

  // 回车与发送键一致：busy 时不得提交，输入保留
  const submitsBefore = api.calls.filter((c) => c[0] === "submit").length;
  input.value = "回车提交文本";
  input._fire("keydown", { key: "Enter", shiftKey: false, isComposing: false, preventDefault: () => {} });
  assert.equal(api.calls.filter((c) => c[0] === "submit").length, submitsBefore, "busy 时回车不提交");
  assert.equal(input.value, "回车提交文本", "回车被拦截时输入保留");

  surface.setBusy(false);
  assert.equal(send.disabled, false, "busy 解除后发送恢复");
  assert.equal(input.placeholder, "输入消息");
});

test("迟到的会话快照不污染新会话：switchSession 后旧代次响应丢弃", async () => {
  let resolveOld;
  const oldSnapshot = new Promise((resolve) => { resolveOld = resolve; });
  let sid1Fetched = false;
  const { root, surface } = await makeSurface({
    apiOverrides: {
      openProject: async () => {},
      fetchSnapshot: async (options) => {
        if (options?.sessionId === "sid-1") {
          sid1Fetched = true;
          return oldSnapshot;
        }
        if (options?.sessionId === "sid-2") {
          return snapshotOf(session({ session_id: "sid-2", last_seq: 2 }), [
            { ...ev("input_queued", { input_id: "in-2", text: "B 会话消息", source: "chat" }, { session_id: "sid-2" }), seq: 1 },
            { ...ev("input_started", { input_id: "in-2" }, { session_id: "sid-2" }), seq: 2 }
          ]);
        }
        return null;
      }
    }
  });

  const p0 = surface.openProject("D:\\novel", "sid-1");
  await waitUntil(() => sid1Fetched);

  await surface.switchSession("sid-2");
  assert.match(root.textContent, /B 会话消息/u);

  resolveOld(snapshotOf(session({ session_id: "sid-1", last_seq: 2 }), [
    { ...ev("input_queued", { input_id: "in-1", text: "A 会话消息", source: "chat" }, { session_id: "sid-1" }), seq: 1 },
    { ...ev("input_started", { input_id: "in-1" }, { session_id: "sid-1" }), seq: 2 }
  ]));
  await p0;
  await tick();
  await tick();

  assert.match(root.textContent, /B 会话消息/u, "当前会话视图保持 B 内容");
  assert.doesNotMatch(root.textContent, /A 会话消息/u, "A 的迟到快照不得污染 B 会话");
});

test("submit 遇 project_busy：surface 自动置 busy、错误透出、草稿保留", async () => {
  const { root, surface } = await makeSurface({
    apiOverrides: {
      submit: async () => {
        const error = new Error("另一个对话正在运行，请稍候。");
        error.code = "project_busy";
        throw error;
      }
    }
  });
  await surface.openProject("D:\\novel");
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  const send = root.querySelector('[data-testid="agent-send"]');
  input.value = "排队中的文本";
  send._fire("click");
  await tick();

  assert.equal(input.value, "排队中的文本", "project_busy 时草稿保留在 composer");
  assert.equal(send.disabled, true, "surface 收到 project_busy 后自动置 busy（发送键禁用）");
  assert.equal(input.disabled, false, "busy 不锁输入框");
  assert.equal(input.placeholder, "另一个对话正在运行");
  assert.match(
    root.querySelector('[data-testid="agent-submit-error"]')?.textContent ?? "",
    /另一个对话正在运行/u,
    "错误消息透出"
  );
});

test("draft 提交竞态：createSession 在途时切走会话，不投递、不污染、草稿保留", async () => {
  let releaseCreate;
  const createGate = new Promise((resolve) => { releaseCreate = resolve; });
  let createCalled = false;
  const submitCalls = [];
  const sessions = [{ session_id: "sid-1", title: "会话一", archived_at: null }];
  const sid1Snapshot = snapshotOf(session({ session_id: "sid-1", last_seq: 2 }), [
    { ...ev("input_queued", { input_id: "in-1", text: "会话一消息", source: "chat" }, { session_id: "sid-1" }), seq: 1 },
    { ...ev("input_started", { input_id: "in-1" }, { session_id: "sid-1" }), seq: 2 }
  ]);
  const { root, surface } = await makeSurface({
    apiOverrides: {
      openProject: async () => {},
      fetchSnapshot: async (options) => {
        if (options?.sessionId === "sid-1") return sid1Snapshot;
        return null;
      },
      createSession: async () => {
        createCalled = true;
        await createGate;
        const meta = { session_id: "sid-new", title: "新对话", archived_at: null };
        sessions.push(meta);
        return { session: meta };
      },
      submit: async (text) => { submitCalls.push(text); return { ok: true }; },
      sessions: async () => ({ sessions: [...sessions], active_session_id: null })
    }
  });

  await surface.openProject("D:\\novel", "sid-1");
  surface.newSessionPlaceholder();
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  input.value = "竞态草稿";
  root.querySelector('[data-testid="agent-send"]')._fire("click");
  await waitUntil(() => createCalled);

  // createSession 落盘在途：用户切到已有会话
  await surface.switchSession("sid-1");
  releaseCreate();
  await tick();
  await tick();

  assert.deepEqual(submitCalls, [], "会话已切走，草稿不得投递到错误会话");
  assert.match(root.textContent, /会话一消息/u, "当前视图仍是切走后的会话内容（缓存未被污染）");
  assert.equal(input.value, "竞态草稿", "草稿回填到当前 composer，用户输入不丢");
});

test("draft 提交失败（createSession 被中止）：切走后草稿回填 composer，输入不丢", async () => {
  let rejectCreate;
  const createGate = new Promise((_resolve, reject) => { rejectCreate = reject; });
  let createCalled = false;
  const sessions = [{ session_id: "sid-1", title: "会话一", archived_at: null }];
  const sid1Snapshot = snapshotOf(session({ session_id: "sid-1", last_seq: 1 }), [
    { ...ev("input_queued", { input_id: "in-1", text: "会话一消息", source: "chat" }, { session_id: "sid-1" }), seq: 1 }
  ]);
  const { root, surface } = await makeSurface({
    apiOverrides: {
      openProject: async () => {},
      fetchSnapshot: async (options) => {
        if (options?.sessionId === "sid-1") return sid1Snapshot;
        return null;
      },
      // createSession 挂起模拟 POST 在途：切走时真实 transport 的 switchSession →
      // transport.openProject 会 abortPendingRequests 把 createSession 一并中止
      // （AbortError，不经代次守卫的直接失败）。fake 里以「切走后 gate reject」
      // 复现同一时序：代次已切走 + createSession 以失败结束。
      createSession: async () => {
        createCalled = true;
        await createGate;
      },
      submit: async () => ({ ok: true }),
      sessions: async () => ({ sessions: [...sessions], active_session_id: null })
    }
  });

  await surface.openProject("D:\\novel", "sid-1");
  surface.newSessionPlaceholder();
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  input.value = "失败草稿";
  root.querySelector('[data-testid="agent-send"]')._fire("click");
  await waitUntil(() => createCalled);

  // createSession 在途：用户切到已有会话（视图代次已切走，view 失败路径被
  // viewGeneration 守卫拦截，草稿只能由 surface 主动回填）
  await surface.switchSession("sid-1");
  const abortError = new Error("aborted");
  abortError.name = "AbortError";
  rejectCreate(abortError);
  await tick();
  await tick();

  assert.equal(input.value, "失败草稿", "切走后 createSession 被中止，草稿仍回填 composer，输入不丢");
});

// ---------------------------------------------------------------------------
// Task 5：会话活跃指针透传（启动 busy 误判根因）
// ---------------------------------------------------------------------------

test("Task 5：启动后 refreshSessions 透传后端 active_session_id（activeSessionId=null 兜底）", async () => {
  // 启动场景：openProject 未指定会话 → surface.activeSessionId = null（switchSession(null)
  // 由后端 last-active 决定）。任意一次 refreshSessions 若把活跃指针覆盖成 null，侧边栏
  // syncBusy 会把当前会话也当「其他会话」——正在展示的会话有 run 在跑时发送键被误禁
  // （"另一个对话正在运行"）。后端契约：GET /api/agent/sessions 返回
  // { sessions, active_session_id }（agent-routes.mjs）。
  const sessions = [
    { session_id: "S1", title: "会话一", archived_at: null, run_status: "running" },
    { session_id: "S2", title: "会话二", archived_at: null, run_status: "idle" }
  ];
  const sessionsChanged = [];
  const { surface } = await makeSurface({
    apiOverrides: {
      fetchSnapshot: async () => null,
      sessions: async () => ({ sessions: [...sessions], active_session_id: "S1" })
    },
    callbacks: {
      onSessionsChanged: (list, active) => sessionsChanged.push([list, active])
    }
  });

  await surface.openProject("D:\\novel", null); // 启动：未指定会话
  assert.equal(sessionsChanged.length, 0, "openProject 自身不拉会话列表");
  surface.refreshSessions();
  await waitUntil(() => sessionsChanged.length > 0);
  assert.equal(
    sessionsChanged[sessionsChanged.length - 1][1],
    "S1",
    "启动后首次 refreshSessions 的活跃指针应以后端 active_session_id 为准（否则当前会话被误判为其他会话）"
  );
  assert.deepEqual(
    sessionsChanged[sessionsChanged.length - 1][0].map((s) => s.session_id),
    ["S1", "S2"],
    "列表原样透传"
  );
});

test("Task 5：surface 显式活跃会话优先于后端 fallback（refreshSessions 不覆盖）", async () => {
  // 回归守卫：Task 3 契约（onSessionsChanged 第二参 = surface 当前活跃指针）保持不变，
  // 后端 active_session_id 只在 surface 指针为 null 时兜底。
  const sessions = [
    { session_id: "S1", title: "会话一", archived_at: null, run_status: "idle" },
    { session_id: "S2", title: "会话二", archived_at: null, run_status: "idle" }
  ];
  const sessionsChanged = [];
  const { surface } = await makeSurface({
    apiOverrides: {
      fetchSnapshot: async () => null,
      sessions: async () => ({ sessions: [...sessions], active_session_id: "S2" })
    },
    callbacks: {
      onSessionsChanged: (list, active) => sessionsChanged.push([list, active])
    }
  });

  await surface.openProject("D:\\novel", null);
  await surface.switchSession("S1"); // 显式切到 S1 → surface.activeSessionId = "S1"
  surface.refreshSessions();
  await waitUntil(() => sessionsChanged.length > 0);
  const last = sessionsChanged[sessionsChanged.length - 1];
  assert.equal(last[1], "S1", "surface 显式活跃会话优先，后端 active_session_id 只作 null 兜底");
  assert.deepEqual(last[0].map((s) => s.session_id), ["S1", "S2"], "列表原样透传");
});

test("Task 8：refreshSessions 新鲜度守卫——慢响应不覆盖更新发起的刷新结果", async () => {
  // 镜像 app.js dashboardRequestId 模式：同代次内并发刷新只允许最新一次生效。
  // 代次守卫（isCurrentProjectScope）管切项目/会话，本守卫管同代次内响应顺序。
  let resolveFirst = null;
  let resolveSecond = null;
  const firstSlow = new Promise((resolve) => { resolveFirst = resolve; });
  const secondFast = new Promise((resolve) => { resolveSecond = resolve; });
  let sessionsCall = 0;
  const sessionsChanged = [];
  const { surface } = await makeSurface({
    apiOverrides: {
      fetchSnapshot: async () => null,
      sessions: () => {
        sessionsCall += 1;
        return sessionsCall === 1 ? firstSlow : secondFast;
      }
    },
    callbacks: {
      onSessionsChanged: (list, active) => sessionsChanged.push([list, active])
    }
  });
  await surface.openProject("D:\\novel", null);

  // 并发两次刷新：第一次慢、第二次快。第二次先返回并生效。
  const p1 = surface.refreshSessions();
  const p2 = surface.refreshSessions();
  resolveSecond({ sessions: [{ session_id: "S2" }], active_session_id: null });
  await p2;
  await waitUntil(() => sessionsChanged.length === 1);
  assert.deepEqual(
    sessionsChanged[0][0].map((s) => s.session_id),
    ["S2"],
    "快响应（最新发起）先到并生效"
  );

  // 第一次（慢）响应迟到：必须被新鲜度守卫丢弃，不得覆盖第二次的结果。
  resolveFirst({ sessions: [{ session_id: "S1" }], active_session_id: null });
  await p1;
  await tick();
  assert.equal(sessionsChanged.length, 1, "慢响应被丢弃，不产生第二次 emit");
  assert.deepEqual(
    sessionsChanged[0][0].map((s) => s.session_id),
    ["S2"],
    "onSessionsChanged 结果仍是最新一次刷新的会话列表"
  );
});

// ---------------------------------------------------------------------------
// Task 16（R5-7/R5-9/R5-12）：canSubmit 集中门禁（needs_history_clear 禁发 +
// Enter 与按钮共用同一判定）+ Run 终态刷新入口
// ---------------------------------------------------------------------------

test("R5-9：Enter 与按钮共用 canSubmit——压缩进行中/失败时回车不得提交，取消完成后恢复", async () => {
  const { root, api, surface } = await makeSurface();
  await surface.openProject("D:\novel");
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  surface.applyEvent(ev("context_compaction_started", { compaction_id: "c-1", trigger: "automatic" }));
  surface.applyEvent(ev("context_compaction_running", { compaction_id: "c-1" }));
  assert.equal(root.querySelector('[data-testid="agent-send"]').disabled, true, "压缩进行中发送键禁用");
  input.value = "压缩期间的回车";
  const before = api.calls.filter((c) => c[0] === "submit").length;
  input._fire("keydown", { key: "Enter", shiftKey: false, isComposing: false, preventDefault: () => {} });
  assert.equal(api.calls.filter((c) => c[0] === "submit").length, before, "压缩进行中回车不提交");
  assert.equal(input.value, "压缩期间的回车", "回车被拦截时输入保留");

  // 压缩失败态同样阻塞（等待用户 重试/取消）
  surface.applyEvent(ev("context_compaction_failed", { compaction_id: "c-1", error_code: "model_error" }));
  input.value = "压缩失败后的回车";
  const before2 = api.calls.filter((c) => c[0] === "submit").length;
  input._fire("keydown", { key: "Enter", shiftKey: false, isComposing: false, preventDefault: () => {} });
  assert.equal(api.calls.filter((c) => c[0] === "submit").length, before2, "压缩失败态回车不提交");

  // 取消完成恢复：回车与按钮同时恢复提交
  surface.applyEvent(ev("context_compaction_cancelled", { compaction_id: "c-1", cancel_reason: "user" }));
  assert.equal(root.querySelector('[data-testid="agent-send"]').disabled, false, "取消完成后发送键恢复");
  input.value = "恢复后的回车";
  input._fire("keydown", { key: "Enter", shiftKey: false, isComposing: false, preventDefault: () => {} });
  assert.equal(api.calls.filter((c) => c[0] === "submit").length, before2 + 1, "取消完成后回车恢复提交");
});

test("R5-7：needs_history_clear 显示「此对话已损坏」，发送键与回车均不提交；快照更新后恢复", async () => {
  const { root, api, surface } = await makeSurface();
  await surface.openProject("D:\novel");
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  const send = root.querySelector('[data-testid="agent-send"]');
  // 后端退化投影：session 快照携带 needs_history_clear:true
  surface.applySnapshot(snapshotOf(session({ needs_history_clear: true }), []));

  const hint = root.querySelector('[data-testid="agent-history-clear-hint"]');
  assert.ok(hint, "应渲染「此对话已损坏」提示");
  assert.equal(hint.hidden, false, "损坏提示可见");
  assert.equal(hint.textContent, "此对话已损坏");
  assert.equal(send.disabled, true, "损坏对话发送键禁用");

  input.value = "损坏后的输入";
  const before = api.calls.filter((c) => c[0] === "submit").length;
  input._fire("keydown", { key: "Enter", shiftKey: false, isComposing: false, preventDefault: () => {} });
  assert.equal(api.calls.filter((c) => c[0] === "submit").length, before, "损坏对话回车不提交");
  assert.equal(input.value, "损坏后的输入", "输入保留");

  // 清空历史后（快照不再标记 needs_history_clear）发送恢复
  surface.applySnapshot(snapshotOf(session({}), []));
  assert.equal(root.querySelector('[data-testid="agent-send"]').disabled, false, "快照更新后发送恢复");
  assert.equal(root.querySelector('[data-testid="agent-history-clear-hint"]').hidden, true, "提示隐藏");
});

test("R5-12：Run 终态触发 onRunTerminal 并补拉权威快照（终态刷新入口）", async () => {
  const terminalTypes = [];
  let snapshotCalls = 0;
  const { root, surface } = await makeSurface({
    callbacks: { onRunTerminal: (event) => terminalTypes.push(event?.type) },
    apiOverrides: {
      fetchSnapshot: async () => { snapshotCalls += 1; return null; }
    }
  });
  await surface.openProject("D:\novel");
  const before = snapshotCalls; // openProject 自身会拉一次快照
  const terminal = ev("run_completed", {});
  surface.applyEvent(terminal);
  await tick();
  assert.deepEqual(terminalTypes, ["run_completed"], "终态事件应经 onRunTerminal 回调透出（app.js 刷新 dashboard/列表）");
  assert.equal(snapshotCalls, before + 1, "终态后补拉一次权威快照（journal 冻结字段）");
  // 同一终态重复送达（同 seq）：不重复回调、不重复补快照
  surface.applyEvent(terminal);
  await tick();
  assert.deepEqual(terminalTypes, ["run_completed"], "同 seq 终态不重复回调");
  assert.equal(snapshotCalls, before + 1, "同 seq 终态不重复补快照");
});
