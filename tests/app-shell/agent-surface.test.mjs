// Task 8: AgentSurface 契约测试（无旧 renderer，纯新 surface）。
//
// 覆盖（Task 8 Step 6 + 从 chat-activity-view.test.mjs 迁移的全部仍然有效断言）：
//   - 空闲发送 / 运行中排队发送 / 立即 / 同一 run id / 停止 / 重试 / 项目切换；
//   - /settings、/model 无 Run 时导航；/init、/review、/write 作为普通文本提交；
//   - 活动：同 activity_id 合并、20 行保留（只裁最早终态、运行中不删）、
//     64 KiB 输出尾 + 「输出过长已截断」、details/summary 原生折叠、字段顺序；
//   - 停止防连点（点击即禁用、失败恢复、终态后不再有第二横幅）；
//   - 计划：活动展开/终态折叠、无手动编辑入口；
//   - 确认：普通三选、extreme 精确文字前禁用、终态 decision 锁定；
//   - 不渲染私有推理；思考/活动标签可见；
//   - 近底部自动滚动、重建后不打断阅读更早内容；
//   - 模型菜单视口钳制与内容列 CSS 基线（agent.css 断言）。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

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
    this._attrs = {};
    this._listeners = new Map();
    this._value = "";
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
    promote: async (inputId) => { calls.push(["promote", inputId]); return { ok: true }; },
    stop: async (runId) => { calls.push(["stop", runId]); return { ok: true }; },
    retry: async (runId) => { calls.push(["retry", runId]); return { ok: true }; },
    decide: async (decisionId, choice) => { calls.push(["decide", decisionId, choice]); return { ok: true }; },
    fetchSnapshot: async () => { calls.push(["fetchSnapshot"]); return null; },
    connectEvents: () => { calls.push(["connectEvents"]); },
    destroy: () => { calls.push(["destroy"]); },
    ...overrides
  };
  return api;
}

async function makeSurface({ apiOverrides = {}, callbacks = {}, useRealTransport = false } = {}) {
  const root = new MockElement("div");
  const api = useRealTransport ? null : makeFakeApi(apiOverrides);
  const opened = [];
  const chapters = [];
  const { createAgentSurface } = await import("../../src/app-shell/agent/index.js");
  const surface = createAgentSurface({
    root,
    api,
    onOpenSettings: (section) => opened.push(section),
    onOpenChapter: (chapterNo) => chapters.push(chapterNo)
  });
  return { root, api, surface, opened, chapters };
}

function snapshotOf(state, events = []) {
  return { session: state, events };
}

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

test("运行中发送进入队列：显示原文 + 排队 + 立即；点击立即触发 promote", async () => {
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
  promote._fire("click");
  assert.deepEqual(api.calls.filter((c) => c[0] === "promote").map((c) => c[1]), ["in-2"]);
});

test("同一 run id：promote 与 stop 事件不更换 Run；conversation 保留", async () => {
  const { root, api, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("input_queued", { input_id: "in-2", text: "先改第三章", source: "chat" }));
  surface.applyEvent(ev("interrupt_requested", {}));
  surface.applyEvent(ev("input_promoted", { input_id: "in-2" }));
  surface.applyEvent(ev("interrupt_safe_point_reached", {}));
  // 用户气泡：两次输入都在对话里（同一会话连续对话）
  assert.equal(root.querySelectorAll('[data-testid="agent-user-message"]').length, 1);
  // 停止动作应针对当前 run id
  const stop = root.querySelector('[data-testid="agent-stop"]');
  assert.ok(stop, "活动 Run 应有停止按钮");
  stop._fire("click");
  await tick();
  assert.deepEqual(api.calls.filter((c) => c[0] === "stop").map((c) => c[1]), ["run-1"]);
});

test("停止防连点：点击即禁用，连点只触发一次；终态后按钮消失且只渲染一次状态", async () => {
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
  const statuses = root.querySelectorAll('[data-testid="agent-run-status"]');
  assert.equal(statuses.length, 1, "状态横幅只渲染一次");
  assert.match(statuses[0].textContent, /已停止/u);
  assert.equal(root.querySelectorAll('[data-activity-id="a9"]').length, 1);
  assert.match(root.querySelector('[data-activity-id="a9"]').textContent, /已停止/u, "活动标记 = 已停止");
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
  assert.equal(root.querySelectorAll('[data-testid="agent-user-message"]').length, 1);
  await surface.openProject("D:\\novel-b");
  assert.ok(api.calls.some((c) => c[0] === "openProject" && c[1] === "D:\\novel-b"));
  assert.equal(root.querySelectorAll('[data-testid="agent-user-message"]').length, 0, "切项目后旧对话清空");
  assert.equal(root.querySelectorAll('[data-testid="agent-queue-item"]').length, 0);
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  assert.equal(input.disabled, false, "新项目 composer 可用");
});

test("无项目时 composer 禁用；打开项目后可用", async () => {
  const { root, surface } = await makeSurface();
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  const send = root.querySelector('[data-testid="agent-send"]');
  assert.equal(input.disabled, true, "未打开项目时输入框禁用");
  assert.equal(send.disabled, true);
  await surface.openProject("D:\\novel");
  assert.equal(input.disabled, false, "打开项目后输入框可用");
  assert.equal(send.disabled, false);
});

test("空会话提示：无项目时显示「新建或打开项目」，打开项目后隐藏", async () => {
  const { root, surface } = await makeSurface();
  const empty = root.querySelector('[data-testid="agent-empty"]');
  assert.ok(empty, "无项目时应渲染空会话提示");
  assert.equal(empty.hidden, false, "无项目时提示可见");
  assert.match(empty.textContent, /新建或打开项目/u);
  await surface.openProject("D:\\novel");
  assert.equal(empty.hidden, true, "打开项目后提示隐藏（有项目时为空会话，不显示欢迎词）");
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

test("/init、/review、/write 是普通 Agent 输入", async () => {
  const { root, api, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  const input = root.querySelector('[data-testid="agent-composer-input"]');
  for (const text of ["/init 了解我的项目", "/review", "/write 第三章"]) {
    input.value = text;
    root.querySelector('[data-testid="agent-send"]')._fire("click");
  }
  assert.deepEqual(api.calls.filter((c) => c[0] === "submit").map((c) => c[1]), [
    "/init 了解我的项目", "/review", "/write 第三章"
  ]);
});

// ===========================================================================
// Visible Plan：活动展开 / 终态折叠 / 无手动编辑
// ===========================================================================

test("Plan：活动 Run 展开、终态后折叠；计划项只读（无编辑控件）", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("plan_updated", {
    explanation: "先核对已完成章节",
    items: [
      { step: "检查已有章节", status: "completed" },
      { step: "修正冲突", status: "in_progress" },
      { step: "验证修改", status: "pending" }
    ]
  }));
  const plan = root.querySelector('[data-testid="agent-plan"]');
  assert.ok(plan, "应渲染 Plan");
  assert.equal(plan.open, true, "活动 Run 的 Plan 应展开");
  const items = plan.querySelectorAll(".agent-plan-item");
  assert.equal(items.length, 3);
  assert.equal(items[0].dataset.status, "completed");
  assert.equal(items[1].dataset.status, "in_progress");
  assert.equal(items[2].dataset.status, "pending");
  assert.match(plan.textContent, /检查已有章节/u);
  assert.match(plan.textContent, /先核对已完成章节/u);
  // 无任何编辑入口
  assert.equal(plan.querySelectorAll("input, textarea, [contenteditable]").length, 0, "Plan 不得有编辑控件");
  assert.equal(plan.querySelectorAll("button").length, 0, "Plan 不得有操作按钮");
  // 终态 → 折叠
  surface.applyEvent(ev("run_cancelled", { reason: "user_stop" }));
  assert.equal(plan.open, false, "Run 终态后 Plan 应折叠");
  assert.equal(plan.querySelectorAll(".agent-plan-item").length, 3, "折叠后计划内容仍在（可展开回看）");
});

// ===========================================================================
// 活动流：合并 / 20 行 / 64 KiB / details / 标记 / 不渲染私有推理
// ===========================================================================

test("同一 activity_id 合并输出且不重复创建行", () => {
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
    assert.equal(root.querySelectorAll('[data-activity-id="a1"]').length, 1, "同 activity_id 只渲染一行");
    const row = root.querySelector('[data-activity-id="a1"]');
    assert.match(row.textContent, /one\ntwo/u);
    assert.match(row.textContent, /退出码0/u);
    assert.match(row.querySelector(".agent-activity-mark").textContent, /✓/u);
  })();
});

test("不同 activity_id 分别成行；openProject 后清空全部行", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(toolStarted("a1", "shell", { command: "npm test" }));
  surface.applyEvent(toolStarted("a2", "read_file", { path: "chapter.md" }));
  assert.equal(root.querySelectorAll('[data-activity-id="a1"]').length, 1);
  assert.equal(root.querySelectorAll('[data-activity-id="a2"]').length, 1);
  assert.equal(root.querySelectorAll(".agent-activity-item").length, 2);
  await surface.openProject("D:\\novel");
  assert.equal(root.querySelectorAll(".agent-activity-item").length, 0, "重新打开项目后活动流清空");
});

test("活动标签映射：shell→运行命令、read_file→读取文件；thinking 标签显示", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(toolStarted("a1", "shell", { command: "npm test" }));
  assert.match(root.querySelector('[data-activity-id="a1"]').textContent, /运行命令/u);
  surface.applyEvent(toolStarted("a2", "read_file", { path: "chapter.md" }));
  assert.match(root.querySelector('[data-activity-id="a2"]').textContent, /读取文件/u);
  // 思考标签：model turn 未闭合 → 状态行显示思考中
  surface.applyEvent(ev("model_turn_started", {}));
  assert.match(root.querySelector('[data-testid="agent-run-status"]').textContent, /思考中/u);
  surface.applyEvent(ev("model_turn_completed", {}));
  assert.doesNotMatch(root.querySelector('[data-testid="agent-run-status"]').textContent, /思考中/u);
});

test("状态标记映射：running=• / completed=✓ / failed=✗ / cancelled=已停止", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  const markOf = (activityId) => {
    const row = root.querySelector(`[data-activity-id="${activityId}"]`);
    return row.querySelector(".agent-activity-mark").textContent;
  };
  // running → •
  surface.applyEvent(toolStarted("a1", "shell", { command: "cmd" }));
  assert.equal(markOf("a1"), "•", "运行中标记应为 •");
  surface.applyEvent(ev("tool_call_completed", {
    tool_call_id: "tc-a1", activity_id: "a1", name: "shell", exit_code: 0
  }));
  assert.equal(markOf("a1"), "✓");
  // failed → ✗
  surface.applyEvent(toolStarted("a2", "shell", { command: "bad" }));
  surface.applyEvent(ev("tool_call_failed", {
    tool_call_id: "tc-a2", activity_id: "a2", name: "shell", error: "boom", message: "失败"
  }));
  assert.equal(markOf("a2"), "✗");
  // cancelled（停止收敛）→ 已停止
  surface.applyEvent(toolStarted("a3", "shell", { command: "st" }));
  surface.applyEvent(ev("tool_call_failed", {
    tool_call_id: "tc-a3", activity_id: "a3", name: "shell", error: "tool_cancelled", message: "操作已停止。"
  }));
  assert.equal(markOf("a3"), "已停止");
});

test("思考状态不渲染隐藏推理文本（私有 reasoning 字段绝不显示）", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("model_turn_started", { reasoning: "private chain-of-thought", hidden_tokens: "xyz" }));
  assert.match(root.textContent, /思考中/u);
  assert.doesNotMatch(root.textContent, /private chain-of-thought/u);
  assert.doesNotMatch(root.textContent, /hidden_tokens|xyz/u);
  surface.applyEvent(ev("tool_call_started", {
    tool_call_id: "tc-a1", activity_id: "a1", name: "read_file",
    args: { path: "chapter.md" },
    reasoning_content: "secret"
  }));
  assert.doesNotMatch(root.textContent, /secret/u);
});

test("行结构：details/summary 原生可键盘展开，输出是唯一 .agent-activity-output", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(toolStarted("a1", "shell", {
    command: "npm test", cwd: "D:\\Book",
    timeout_ms: 120000, purpose: "跑测试"
  }));
  surface.applyEvent(outputDelta("a1", "line1\n"));
  const row = root.querySelector('[data-activity-id="a1"]');
  const details = row.querySelector("details");
  assert.ok(details, "活动行应使用 <details>（原生键盘可展开）");
  assert.ok(details.querySelector("summary"), "details 内应有 summary");
  const outputs = row.querySelectorAll(".agent-activity-output");
  assert.equal(outputs.length, 1, "输出是唯一 .agent-activity-output");
  assert.equal(outputs[0].textContent, "line1\n");
  assert.match(row.textContent, /npm test/u);
  assert.match(row.textContent, /D:\\Book/u);
});

test("详情字段顺序：参数 → 命令 → 目录 → 退出码 → 耗时；失败活动 → 错误 在最后", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  // 成功 shell 活动：参数/命令/目录（开始）→ 退出码/耗时（完成）
  surface.applyEvent(toolStarted("a1", "shell", { command: "npm test", cwd: "D:\\Book" }));
  surface.applyEvent(outputDelta("a1", "out\n"));
  surface.applyEvent(ev("tool_call_completed", {
    tool_call_id: "tc-a1", activity_id: "a1", name: "shell",
    exit_code: 0, duration_ms: 35
  }));
  // 失败活动：参数/命令/目录 → 耗时 → 错误（退出码不出现，错误排最后）
  surface.applyEvent(toolStarted("a2", "shell", { command: "bad cmd", cwd: "D:\\Book" }));
  surface.applyEvent(ev("tool_call_failed", {
    tool_call_id: "tc-a2", activity_id: "a2", name: "shell",
    error: "exit_nonzero", message: "命令退出码非 0", duration_ms: 42
  }));
  const namesOf = (activityId) => {
    const row = root.querySelector(`[data-activity-id="${activityId}"]`);
    return [...row.querySelectorAll(".agent-activity-field")].map((el) => el.querySelector("strong").textContent);
  };
  assert.deepEqual(namesOf("a1"), ["参数", "命令", "目录", "退出码", "耗时"], "成功活动字段顺序固定");
  assert.deepEqual(namesOf("a2"), ["参数", "命令", "目录", "耗时", "错误"], "失败活动错误字段排最后");
  const row2 = root.querySelector('[data-activity-id="a2"]');
  assert.match(row2.querySelector(".agent-activity-mark").textContent, /✗/u);
  assert.match(row2.textContent, /命令退出码非 0/u);
});

test("I-2 输出上限：超过 64 KiB 截断保留尾部并前置提示，后续增量继续追加", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(toolStarted("a1", "shell", { command: "long run" }));
  const big = "y".repeat(70 * 1024) + "TAIL-END-123";
  surface.applyEvent(outputDelta("a1", big));
  const row = root.querySelector('[data-activity-id="a1"]');
  const output = row.querySelector(".agent-activity-output");
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

test("I-2 行数上限：超限裁剪最早的终态行，运行中的行保留", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  for (let i = 1; i <= 19; i += 1) {
    surface.applyEvent(toolStarted(`a${i}`, "read_file", { path: `f${i}` }));
    surface.applyEvent(ev("tool_call_completed", {
      tool_call_id: `tc-a${i}`, activity_id: `a${i}`, name: "read_file", exit_code: 0
    }));
  }
  surface.applyEvent(toolStarted("r1", "shell", { command: "cmd1" }));
  surface.applyEvent(toolStarted("r2", "shell", { command: "cmd2" }));
  assert.equal(root.querySelectorAll(".agent-activity-item").length, 20, "行数被裁剪到上限 20");
  assert.equal(root.querySelector('[data-activity-id="a1"]'), null, "最早的终态行被移除");
  assert.ok(root.querySelector('[data-activity-id="a2"]'), "较新的终态行保留");
  assert.ok(root.querySelector('[data-activity-id="r1"]'), "运行中的行保留");
  assert.ok(root.querySelector('[data-activity-id="r2"]'), "运行中的行保留");
});

test("I-2 行数上限：全部运行中时不裁剪（运行中的行不删）", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  for (let i = 1; i <= 21; i += 1) {
    surface.applyEvent(toolStarted(`live${i}`, "shell", { command: `c${i}` }));
  }
  assert.equal(root.querySelectorAll(".agent-activity-item").length, 21, "运行中的行不删（允许短暂超限）");
});

test("I-2 长流有界：reducer 封顶（20 终态 + 运行中）后 DOM 行数与输出仍有界", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  // 30 个终态活动，每个带 1 KiB 输出
  for (let i = 1; i <= 30; i += 1) {
    surface.applyEvent(toolStarted(`t${i}`, "shell", { command: `c${i}` }));
    surface.applyEvent(outputDelta(`t${i}`, "x".repeat(1024)));
    surface.applyEvent(ev("tool_call_completed", {
      tool_call_id: `tc-t${i}`, activity_id: `t${i}`, name: "shell", exit_code: 0
    }));
  }
  // 2 个运行中活动 + 大量增量
  surface.applyEvent(toolStarted("r1", "shell", { command: "r1" }));
  surface.applyEvent(toolStarted("r2", "shell", { command: "r2" }));
  for (let i = 0; i < 50; i += 1) surface.applyEvent(outputDelta("r1", "y"));
  // 最早的终态活动被 state 封顶丢弃（t1..t12 均不可见），运行中的行保留且输出完整
  assert.equal(root.querySelector('[data-activity-id="t1"]'), null, "最早的终态行被丢弃");
  assert.equal(root.querySelector('[data-activity-id="t12"]'), null, "超出 20 终态窗口的行被丢弃");
  assert.ok(root.querySelector('[data-activity-id="t13"]'), "最新的终态行保留");
  const r1row = root.querySelector('[data-activity-id="r1"]');
  assert.ok(r1row, "运行中的行保留");
  assert.equal(r1row.querySelector(".agent-activity-output").textContent, "y".repeat(50), "运行中输出完整保留");
  const r2row = root.querySelector('[data-activity-id="r2"]');
  assert.ok(r2row, "第二条运行中的行保留");
  assert.ok(root.querySelectorAll(".agent-activity-item").length <= 20, "DOM 行数不得超过 20");
});

test("非 Agent 事件类型被忽略（不崩溃、不渲染）", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applyEvent({ type: "bogus_event", seq: 1, payload: {} });
  surface.applyEvent(null);
  assert.equal(root.querySelectorAll(".agent-activity-item").length, 0);
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

test("活动标签处理字符串化 args（parseArgs 兼容旧摘要格式）", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(toolStarted("a1", "search_files", JSON.stringify({ query: "雨夜" })));
  assert.match(root.querySelector('[data-activity-id="a1"]').textContent, /搜索「雨夜」/u);
  // 非法 JSON 字符串不崩溃，回退到通用标签
  surface.applyEvent(toolStarted("a2", "search_files", "{broken"));
  assert.ok(root.querySelector('[data-activity-id="a2"]').textContent.includes("搜索文件"));
});

test("对话容器带 aria-live 区域（可访问性）", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  const conv = root.querySelector('[data-testid="agent-conversation"]');
  assert.equal(conv.getAttribute("role"), "log");
  assert.equal(conv.getAttribute("aria-live"), "polite");
});

test("input_consumed / input_cancelled 移除排队项；workflow_changed 保持 Run 活动", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  surface.applyEvent(ev("input_queued", { input_id: "in-2", text: "排队A", source: "chat" }));
  surface.applyEvent(ev("input_queued", { input_id: "in-3", text: "排队B", source: "chat" }));
  assert.equal(root.querySelectorAll('[data-testid="agent-queue-item"]').length, 2);
  // 排队输入被消费（切换活动输入）
  surface.applyEvent(ev("input_consumed", { input_id: "in-2" }));
  assert.equal(root.querySelectorAll('[data-testid="agent-queue-item"]').length, 1);
  assert.ok(root.querySelector('[data-input-id="in-3"]').textContent.includes("排队B"));
  // 排队输入被取消（停止路径收敛）
  surface.applyEvent(ev("input_cancelled", { input_id: "in-3" }));
  assert.equal(root.querySelectorAll('[data-testid="agent-queue-item"]').length, 0);
  // workflow 切换：Run 仍活动，停止按钮保留
  surface.applyEvent(ev("workflow_changed", { workflow: "chapter", reason: "正式写作" }));
  assert.ok(root.querySelector('[data-testid="agent-stop"]'), "workflow 切换后 Run 仍活动");
});

// ===========================================================================
// 状态文案：简洁
// ===========================================================================

test("状态文案简洁：等待确认 / 已停止 / 操作失败 / 已完成", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  const cases = [
    [{ status: "waiting_user" }, /等待确认/u],
    [{ status: "cancelled" }, /已停止/u],
    [{ status: "failed" }, /操作失败/u],
    [{ status: "completed" }, /已完成/u],
  ];
  for (const [runOverrides, re] of cases) {
    surface.applySnapshot(snapshotOf(session({ status: "idle", active_run: activeRun(runOverrides) })));
    const status = root.querySelector('[data-testid="agent-run-status"]');
    assert.match(status.textContent, re, `状态 ${runOverrides.status}`);
    assert.ok(status.textContent.length <= 6, "状态文案应在 2-6 字以内");
  }
});

// ===========================================================================
// 自动滚动：仅近底部跟随；重建不打断阅读更早内容
// ===========================================================================

test("近底部自动滚动：增量事件到达时跟随到底部", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  const conv = root.querySelector('[data-testid="agent-conversation"]');
  conv.scrollHeight = 500;
  conv.clientHeight = 200;
  conv.scrollTop = 295; // 距底部 5px < 阈值
  surface.applyEvent(toolStarted("a1", "shell", { command: "npm test" }));
  assert.equal(conv.scrollTop, 300, "近底部时增量事件应跟随到底部");
});

test("阅读更早内容时不自动滚动", async () => {
  const { root, surface } = await makeSurface();
  await surface.openProject("D:\\novel");
  surface.applySnapshot(snapshotOf(session({ status: "running", active_run: activeRun() })));
  const conv = root.querySelector('[data-testid="agent-conversation"]');
  conv.scrollHeight = 500;
  conv.clientHeight = 200;
  conv.scrollTop = 0; // 用户在顶部阅读更早内容
  surface.applyEvent(toolStarted("a1", "shell", { command: "npm test" }));
  assert.equal(conv.scrollTop, 0, "用户不在底部时不得抢滚动");
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
  surface.applySnapshot(snapshotOf(session({ session_id: "sess-b", status: "running", active_run: activeRun() }), [
    ev("input_queued", { input_id: "in-1", text: "新会话消息", source: "chat" }, { session_id: "sess-b" })
  ]));
  assert.equal(conv.scrollTop, 300, "近底部重建后应锚定到末端");
  // 阅读更早内容：重建后保持位置，不打断
  conv.scrollTop = 0;
  surface.applySnapshot(snapshotOf(session({ session_id: "sess-c", status: "running", active_run: activeRun() }), [
    ev("input_queued", { input_id: "in-1", text: "第三条消息", source: "chat" }, { session_id: "sess-c" })
  ]));
  assert.equal(conv.scrollTop, 0, "阅读更早内容时重建不得抢滚动");
});

// ===========================================================================
// 布局基线：agent.css 保留 900px 内容列与模型菜单视口钳制
// ===========================================================================

test("agent.css 保留 900px 内容列与模型菜单视口钳制（Task 11 基线）", async () => {
  const css = await fs.readFile(path.join(here, "..", "..", "src", "app-shell", "agent", "agent.css"), "utf8");
  assert.match(css, /--content-column:\s*900px/u, "根变量应定义 900px 内容列");
  assert.match(css, /\.agent-conversation[\s\S]*max-width:\s*var\(--content-column\)/u, "对话共享内容列");
  assert.match(css, /\.agent-composer[\s\S]*max-width:\s*var\(--content-column\)/u, "composer 共享内容列");
  assert.match(
    css,
    /width:\s*min\(420px,\s*calc\(100vw - 32px\)\)/u,
    "模型菜单宽度应为 min(420px, 100vw - 32px)"
  );
  assert.match(css, /overflow-wrap:\s*anywhere/u, "模型名称应允许任意位置换行");
  // 排队文本换行不遮「立即」：grid 稳定轨道（minmax(0,1fr) + auto 按钮列）
  assert.match(
    css,
    /\.agent-queue-item\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto\s+auto/u,
    "排队行应为稳定 grid 轨道"
  );
  // plan 行稳定轨道（标记列固定 18px，状态变化不推动文本列）
  assert.match(
    css,
    /\.agent-plan-item\s*\{[^}]*grid-template-columns:\s*18px\s+minmax\(0,\s*1fr\)/u,
    "plan 行应为稳定 grid 轨道"
  );
  // 按钮尺寸不随状态抖动
  assert.match(css, /\.agent-stop-btn\s*,\s*\.agent-retry-btn\s*,\s*\.agent-promote[\s\S]*min-width/u, "控制按钮应有固定最小宽度");
  // 窄视口无重叠
  assert.match(css, /@media\s*\(max-width:\s*560px\)[\s\S]*\.agent-queue-item\s*\{/u, "窄视口应调整排队布局避免重叠");
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

test("transport: submit/promote/stop/retry/decide 使用正确端点、作用域与 body", async () => {
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
    // promote（运行中排队 → 立即）
    surface.applyEvent(ev("input_queued", { input_id: "in-2", text: "排队消息", source: "chat" }));
    root.querySelector('[data-testid="agent-promote"]')._fire("click");
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
    assert.equal(byUrl("/api/agent/input/in-2/promote").length, 1);
    assert.deepEqual(JSON.parse(byUrl("/api/agent/input/in-2/promote")[0].options.body), { projectRoot: "D:\\novel" });
    assert.equal(byUrl("/api/agent/run/run-1/stop").length, 1);
    assert.equal(byUrl("/api/agent/run/run-1/retry").length, 1);
    assert.equal(byUrl("/api/agent/decision/dec-1").length, 1);
    assert.deepEqual(JSON.parse(byUrl("/api/agent/decision/dec-1")[0].options.body), {
      projectRoot: "D:\\novel", choice: "allow"
    });
    surface.destroy();
  });
});

test("transport: openProject 拉取带项目作用域的初始快照（afterSeq=0）", async () => {
  await withFetch((url) => {
    if (url.startsWith("/api/project/events")) return { ok: true, status: 200, body: neverStream() };
    return snapshotResponse(null);
  }, async (calls) => {
    const { surface } = await makeSurface({ useRealTransport: true });
    await surface.openProject("D:\\novel");
    const snap = calls.find((c) => c.url.startsWith("/api/agent/snapshot?"));
    assert.ok(snap, "应请求 snapshot 端点");
    assert.equal(snap.url, "/api/agent/snapshot?projectRoot=D%3A%5Cnovel&afterSeq=0&limit=200");
    surface.destroy();
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
          'data: {"seq":2,"type":"input_queued","payload":{"input_id":"in-1","text":"SSE 消息"},"run_id":"run-1"}\n\n'
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
          'data: {"seq":1,"type":"input_queued","payload":{"input_id":"in-1","text":"重连后到达"},"run_id":"run-1"}\n\n'
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
        // 第一次连接：收到 seq1 后服务端断开
        return {
          ok: true,
          status: 200,
          body: streamCloseAfter([
            'data: {"seq":1,"type":"input_queued","payload":{"input_id":"in-1","text":"第一条"},"run_id":"run-1"}\n\n'
          ])
        };
      }
      // 重连流：补齐后的新事件（seq4）
      return {
        ok: true,
        status: 200,
        body: streamThenHang([
          'data: {"seq":4,"type":"input_queued","payload":{"input_id":"in-4","text":"第四条"},"run_id":"run-1"}\n\n'
        ])
      };
    }
    if (url.startsWith("/api/agent/snapshot")) {
      // 初始快照（afterSeq=0）为空；断线补齐（afterSeq=1）返回 seq2-3
      if (url.includes("afterSeq=0")) return snapshotResponse(null);
      return jsonResponse({
        ok: true,
        session: null,
        events: [
          { seq: 2, event_id: "e2", session_id: "sess-test", run_id: "run-1", type: "input_queued", payload: { input_id: "in-2", text: "第二条" }, at: "x" },
          { seq: 3, event_id: "e3", session_id: "sess-test", run_id: "run-1", type: "input_queued", payload: { input_id: "in-3", text: "第三条" }, at: "x" }
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
