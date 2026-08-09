// 左侧栏两级树（Task 9）——session-sidebar.mjs 行为测试。
//
// 无 JSDOM：最小 DOM 桩 + 注入假 surface（spy 记录调用），直接驱动
// createSessionSidebar（app.js 的薄接线层在这里用假依赖替换）。
// 覆盖：dashboard 会话渲染与活跃高亮、折叠/展开 + localStorage、
// 点击会话/「+」/改名/归档、其他项目懒加载与缓存、draft 占位特判、
// busy 复位（run_status 联动）、项目行点击展开。
import assert from "node:assert/strict";
import test from "node:test";

import { createSessionSidebar } from "../../src/app-shell/session-sidebar.mjs";

const COLLAPSED_KEY = "wwriting:projects:collapsed";

// ---------------------------------------------------------------------------
// 最小 DOM 桩（含事件冒泡 + stopPropagation）
// ---------------------------------------------------------------------------

class MockElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this._attrs = {};
    this._listeners = new Map();
    this._classes = new Set();
    this._text = "";
    this.parentNode = null;
    this.disabled = false;
    this.title = "";
    this.type = "";
    this.value = "";
    this.scrollTop = 0;
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
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  setAttribute(key, value) {
    this._attrs[key] = String(value);
  }
  getAttribute(key) {
    return this._attrs[key] ?? null;
  }
  removeAttribute(key) {
    delete this._attrs[key];
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  dispatch(type, event = {}) {
    let stopped = false;
    const ev = {
      type,
      target: this,
      key: null,
      preventDefault() {},
      stopPropagation() {
        stopped = true;
      },
      ...event
    };
    let node = this;
    while (node) {
      ev.currentTarget = node;
      for (const fn of node._listeners.get(type) ?? []) {
        fn(ev);
        if (stopped) break;
      }
      if (stopped) break;
      node = node.parentNode;
    }
    return ev;
  }
}

function makeDocument() {
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

function makeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key)
  };
}

function makeSurface() {
  const calls = {
    switchSession: [],
    newSessionPlaceholder: [],
    refreshSessions: [],
    setBusy: [],
    renameSession: [],
    archiveSession: []
  };
  const toasts = [];
  return {
    calls,
    toasts,
    switchSession: (id) => {
      calls.switchSession.push(id);
      return Promise.resolve({ session_id: id });
    },
    newSessionPlaceholder: () => {
      calls.newSessionPlaceholder.push(1);
      return "draft-x";
    },
    refreshSessions: () => {
      calls.refreshSessions.push(1);
      return Promise.resolve();
    },
    setBusy: (busy) => calls.setBusy.push(busy === true),
    renameSession: async (id, title) => {
      calls.renameSession.push([id, title]);
      return { session_id: id, title };
    },
    archiveSession: async (id) => {
      calls.archiveSession.push(id);
      return { session_id: id };
    }
  };
}

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

function makeTimerRecorder() {
  const active = new Map();
  let nextId = 1;
  return {
    setInterval(callback, ms) {
      const id = nextId++;
      active.set(id, { callback, ms });
      return id;
    },
    clearInterval(id) {
      active.delete(id);
    },
    fire(id) {
      const entry = active.get(id);
      if (entry) entry.callback();
    },
    activeIds() {
      return [...active.keys()];
    }
  };
}

// ---------------------------------------------------------------------------
// 夹具：真实 DOM 元素由桩 document 创建，注入假依赖
// ---------------------------------------------------------------------------

function makeFixture({ projects = [], selectedProjectRoot = null, currentProjectRoot = null, sessionData = {}, initialStorage = {}, timers = null, fetchSessionsOverride = null } = {}) {
  const doc = makeDocument();
  const listEl = doc.createElement("div");
  const countEl = doc.createElement("span");
  const filterEl = doc.createElement("input");
  const scrollEl = doc.createElement("div");
  const storage = makeStorage();
  for (const [key, value] of Object.entries(initialStorage)) storage.setItem(key, value);
  const surface = makeSurface();
  const fetchCalls = [];
  const openCalls = [];
  // 默认注入定时器记录器：测试绝不启动真实 setInterval（避免悬挂）
  const timerRecorder = timers ?? makeTimerRecorder();
  const sidebar = createSessionSidebar({
    listEl,
    countEl,
    filterEl,
    scrollEl,
    getProjectListData: () => ({ projects, selectedProjectRoot }),
    getCurrentProjectRoot: () => currentProjectRoot,
    fetchSessions: fetchSessionsOverride ?? (async (root) => {
      fetchCalls.push(root);
      return sessionData[root] ?? { sessions: [], active_session_id: null };
    }),
    renderProjectRow: (project) => {
      const row = doc.createElement("div");
      row.className = "proj-row";
      const btn = doc.createElement("button");
      btn.className = "proj";
      btn.append(doc.createTextNode(project.title ?? ""));
      btn.addEventListener("click", () => openCalls.push(project.projectRoot));
      row.append(btn);
      return row;
    },
    surface,
    showToast: (message, type) => surface.toasts.push([message, type]),
    promptDialog: () => "新标题",
    storage,
    setIntervalFn: timerRecorder.setInterval.bind(timerRecorder),
    clearIntervalFn: timerRecorder.clearInterval.bind(timerRecorder),
    doc
  });
  return { sidebar, listEl, countEl, filterEl, scrollEl, storage, surface, fetchCalls, openCalls, doc, timers: timerRecorder };
}

function allDescendants(el) {
  return el.children.flatMap((child) => [child, ...allDescendants(child)]);
}
function rowsOf(listEl) {
  // session-row 嵌在 .session-group 内，需递归收集
  return allDescendants(listEl).filter((c) => c.classList.contains("session-row"));
}
function groupsOf(listEl) {
  return listEl.children.filter((c) => c.classList.contains("session-group"));
}
function chevronOf(row) {
  return row.children.find((c) => c.classList.contains("proj-chevron"));
}
function addOf(group) {
  return group.children[0].children[1];
}
function menuOf(row) {
  return row.children.find((c) => c.classList.contains("session-menu"));
}

// ---------------------------------------------------------------------------
// 1) dashboard 会话渲染 + 活跃高亮 + 状态点
// ---------------------------------------------------------------------------

test("渲染当前项目会话列表：标题正确、s1 活跃、状态点按 run_status", () => {
  const P = "D:/projects/p1";
  const f = makeFixture({
    projects: [{ projectRoot: P, title: "小说一" }],
    selectedProjectRoot: P,
    currentProjectRoot: P
  });
  f.sidebar.seedSessions(P, [
    { session_id: "s1", title: "对话一", run_status: "idle" },
    { session_id: "s2", title: "对话二", run_status: "running" }
  ], "s1");
  f.sidebar.render();

  const groups = groupsOf(f.listEl);
  assert.equal(groups.length, 1, "当前项目渲染一个会话组");
  assert.equal(groups[0].dataset.projectRoot, P);
  assert.equal(groups[0].children[0].className.includes("session-group-head"), true);
  assert.equal(groups[0].children[0].children[0].textContent, "对话");

  const rows = rowsOf(f.listEl);
  assert.equal(rows.length, 2, "两个 session-row");
  assert.equal(rows[0].dataset.sessionId, "s1");
  assert.equal(rows[0].classList.contains("active"), true, "s1 活跃高亮");
  assert.equal(rows[1].classList.contains("active"), false);
  assert.equal(rows[0].children[1].textContent, "对话一", "标题正确");
  assert.equal(rows[1].children[1].textContent, "对话二");

  const dot1 = rows[0].children[0];
  const dot2 = rows[1].children[0];
  assert.equal(dot1.dataset.status, "idle");
  assert.equal(dot2.dataset.status, "running", "运行中会话状态点 running");

  assert.equal(f.countEl.textContent, "1", "项目计数");
});

// ---------------------------------------------------------------------------
// 2) 折叠/展开 + localStorage
// ---------------------------------------------------------------------------

test("点击箭头折叠/展开：会话行消失/恢复，折叠状态写 localStorage，aria-expanded 同步", () => {
  const P = "D:/projects/p1";
  const f = makeFixture({
    projects: [{ projectRoot: P, title: "小说一" }],
    selectedProjectRoot: P,
    currentProjectRoot: P
  });
  f.sidebar.seedSessions(P, [{ session_id: "s1", title: "对话一", run_status: "idle" }], "s1");
  f.sidebar.render();
  assert.equal(rowsOf(f.listEl).length, 1);

  const row = f.listEl.children[0];
  const chevron = chevronOf(row);
  assert.ok(chevron, "项目行带折叠箭头");
  assert.equal(chevron.getAttribute("role"), "button");
  assert.equal(chevron.getAttribute("aria-expanded"), "true", "默认展开");

  chevron.dispatch("click", {});
  assert.equal(rowsOf(f.listEl).length, 0, "折叠后会话行消失");
  assert.equal(groupsOf(f.listEl).length, 0);
  assert.deepEqual(JSON.parse(f.storage.getItem(COLLAPSED_KEY)), { [P]: true }, "折叠状态写入 localStorage");
  const chevronAfter = chevronOf(f.listEl.children[0]);
  assert.equal(chevronAfter.getAttribute("aria-expanded"), "false");

  chevronAfter.dispatch("click", {});
  assert.equal(rowsOf(f.listEl).length, 1, "再点恢复");
  assert.equal(groupsOf(f.listEl).length, 1);
  assert.deepEqual(JSON.parse(f.storage.getItem(COLLAPSED_KEY)), {}, "展开后折叠记录清除");
  assert.equal(chevronOf(f.listEl.children[0]).getAttribute("aria-expanded"), "true");
});

test("点击项目行主体（非箭头）→ 展开项目", () => {
  const P1 = "D:/projects/p1";
  const P2 = "D:/projects/p2";
  const f = makeFixture({
    projects: [
      { projectRoot: P1, title: "小说一" },
      { projectRoot: P2, title: "小说二" }
    ],
    selectedProjectRoot: P1,
    currentProjectRoot: P1,
    initialStorage: { [COLLAPSED_KEY]: JSON.stringify({ [P2]: true }) } // 预折叠 P2（localStorage 恢复路径）
  });
  f.sidebar.seedSessions(P1, [{ session_id: "s1", title: "对话一", run_status: "idle" }], "s1");
  f.sidebar.render();
  assert.equal(groupsOf(f.listEl).length, 1, "P2 折叠时不渲染会话组");

  const row2 = f.listEl.children[2];
  const btn2 = row2.children[0];
  btn2.dispatch("click", {});
  assert.deepEqual(f.openCalls, [P2], "行主体点击触发 renderProjectRow 内部切换（app.js openProject）");
  assert.equal(groupsOf(f.listEl).length, 2, "点击行主体后 P2 展开");
  assert.equal(chevronOf(f.listEl.children[2]).getAttribute("aria-expanded"), "true");
});

// ---------------------------------------------------------------------------
// 3) 会话操作：切换 / 新建 / 改名 / 归档
// ---------------------------------------------------------------------------

test("点击会话 → surface.switchSession + 切换后 refreshSessions；「+」→ newSessionPlaceholder", async () => {
  const P = "D:/projects/p1";
  const f = makeFixture({
    projects: [{ projectRoot: P, title: "小说一" }],
    selectedProjectRoot: P,
    currentProjectRoot: P
  });
  f.sidebar.seedSessions(P, [
    { session_id: "s1", title: "对话一", run_status: "idle" },
    { session_id: "s2", title: "对话二", run_status: "idle" }
  ], "s1");
  f.sidebar.render();

  const rows = rowsOf(f.listEl);
  rows[1].dispatch("click", {});
  await flush();
  assert.deepEqual(f.surface.calls.switchSession, ["s2"], "点击 s2 → switchSession(s2)");
  assert.ok(f.surface.calls.refreshSessions.length >= 1, "切换后刷新列表（活跃高亮 + busy 复位）");

  addOf(groupsOf(f.listEl)[0]).dispatch("click", {});
  assert.deepEqual(f.surface.calls.newSessionPlaceholder, [1], "「+」→ newSessionPlaceholder");
});

test("会话操作：改名走 prompt + renameSession + toast；归档直接 archiveSession + toast", async () => {
  const P = "D:/projects/p1";
  const f = makeFixture({
    projects: [{ projectRoot: P, title: "小说一" }],
    selectedProjectRoot: P,
    currentProjectRoot: P
  });
  f.sidebar.seedSessions(P, [{ session_id: "s1", title: "对话一", run_status: "idle" }], "s1");
  f.sidebar.render();

  const row = rowsOf(f.listEl)[0];
  const ops = menuOf(row).children;
  assert.equal(ops.length, 2, "hover 操作：改名 + 归档");
  ops[0].dispatch("click", {});
  await flush();
  assert.deepEqual(f.surface.calls.renameSession, [["s1", "新标题"]], "改名 → renameSession(id, prompt 结果)");
  assert.ok(f.surface.toasts.some(([m]) => m.includes("新标题")), "改名后 toast");

  ops[1].dispatch("click", {});
  await flush();
  assert.deepEqual(f.surface.calls.archiveSession, ["s1"], "归档 → archiveSession(id)");
  assert.ok(f.surface.toasts.some(([m]) => m.includes("已归档对话 对话一")), "归档 toast 文案");
});

// ---------------------------------------------------------------------------
// 4) 懒加载：展开未缓存项目 → 拉取并缓存
// ---------------------------------------------------------------------------

test("展开未缓存项目懒调 sessions 并渲染；缓存命中不重复拉", async () => {
  const P1 = "D:/projects/p1";
  const P2 = "D:/projects/p2";
  const f = makeFixture({
    projects: [
      { projectRoot: P1, title: "小说一" },
      { projectRoot: P2, title: "小说二" }
    ],
    selectedProjectRoot: P1,
    currentProjectRoot: P1,
    sessionData: {
      [P2]: { sessions: [{ session_id: "x1", title: "另一对话", run_status: "failed" }], active_session_id: "x1" }
    },
    initialStorage: { [COLLAPSED_KEY]: JSON.stringify({ [P2]: true }) }
  });
  f.sidebar.seedSessions(P1, [{ session_id: "s1", title: "对话一", run_status: "idle" }], "s1");
  f.sidebar.render();
  assert.deepEqual(f.fetchCalls, [], "折叠中的项目不拉取");

  // 展开 P2 → 懒拉取
  const row2 = f.listEl.children[2];
  chevronOf(row2).dispatch("click", {});
  assert.deepEqual(f.fetchCalls, [P2], "展开未缓存项目发出 sessions 拉取");
  await flush();

  const groups = groupsOf(f.listEl);
  assert.equal(groups.length, 2, "P2 会话组渲染");
  const rowsP2 = rowsOf(f.listEl).filter((r) => r.parentNode === groups[1]);
  assert.equal(rowsP2.length, 1);
  assert.equal(rowsP2[0].children[1].textContent, "另一对话");
  assert.equal(rowsP2[0].children[0].dataset.status, "failed", "懒加载数据含 run_status");

  // 缓存：整表重渲不重复拉
  f.sidebar.render();
  assert.deepEqual(f.fetchCalls, [P2], "本次会话内缓存命中，不重复拉");
});

// ---------------------------------------------------------------------------
// 5) busy 复位（Task 8 遗留契约）
// ---------------------------------------------------------------------------

test("busy 复位：其他会话 running → setBusy(true)；全部非 running → setBusy(false)；当前会话运行不置忙", () => {
  const P = "D:/projects/p1";
  const f = makeFixture({
    projects: [{ projectRoot: P, title: "小说一" }],
    selectedProjectRoot: P,
    currentProjectRoot: P
  });
  f.sidebar.seedSessions(P, [
    { session_id: "s1", title: "对话一", run_status: "idle" },
    { session_id: "s2", title: "对话二", run_status: "running" }
  ], "s1");
  assert.deepEqual(f.surface.calls.setBusy, [true], "其他会话运行中 → busy(true)");

  // 终态后刷新（surface.refreshSessions → onSessionsChanged → handleSessionsChanged）
  f.sidebar.handleSessionsChanged(P, [
    { session_id: "s1", title: "对话一", run_status: "idle" },
    { session_id: "s2", title: "对话二", run_status: "idle" }
  ], "s1");
  assert.deepEqual(f.surface.calls.setBusy, [true, false], "全部非 running → busy(false) 复位");

  // 当前会话运行中不阻塞发送键（同会话 submit 走 FIFO 队列）
  f.sidebar.handleSessionsChanged(P, [
    { session_id: "s1", title: "对话一", run_status: "running" }
  ], "s1");
  assert.deepEqual(f.surface.calls.setBusy, [true, false, false], "当前会话运行不置忙");
});

// ---------------------------------------------------------------------------
// 6) draft 占位特判
// ---------------------------------------------------------------------------

test("draft 占位项：显示「新对话」、禁用会话操作、点击不切会话", async () => {
  const P = "D:/projects/p1";
  const f = makeFixture({
    projects: [{ projectRoot: P, title: "小说一" }],
    selectedProjectRoot: P,
    currentProjectRoot: P
  });
  f.sidebar.handleSessionsChanged(P, [
    { session_id: "draft-x", title: "新对话", status: "draft" },
    { session_id: "s1", title: "对话一", run_status: "idle" }
  ], "draft-x");
  f.sidebar.render();

  const rows = rowsOf(f.listEl);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].classList.contains("session-draft"), true);
  assert.equal(rows[0].children[1].textContent, "新对话", "draft 显示「新对话」");

  const ops = menuOf(rows[0]).children;
  assert.equal(ops[0].disabled, true, "draft 禁用改名");
  assert.equal(ops[1].disabled, true, "draft 禁用归档");

  rows[0].dispatch("click", {});
  await flush();
  assert.deepEqual(f.surface.calls.switchSession, [], "点击占位项留在占位视图，不切会话");
});

// ---------------------------------------------------------------------------
// 7) busy 周期刷新（规格审查修复）：其他会话终态不达本会话 SSE 流，busy=true 时
//    由 5s 周期刷新兜底复位
// ---------------------------------------------------------------------------

test("busy 周期刷新：运行中启动定时器，tick 重拉，终态后复位并清除定时器", async () => {
  const P = "D:/projects/p1";
  const f = makeFixture({
    projects: [{ projectRoot: P, title: "小说一" }],
    selectedProjectRoot: P,
    currentProjectRoot: P
  });
  f.sidebar.seedSessions(P, [
    { session_id: "s1", title: "对话一", run_status: "idle" },
    { session_id: "s2", title: "对话二", run_status: "running" }
  ], "s1");
  assert.deepEqual(f.surface.calls.setBusy, [true], "其他会话运行中 → busy(true)");
  assert.equal(f.timers.activeIds().length, 1, "busy=true 时启动周期刷新定时器");

  // tick：重拉会话列表（数据未变 → busy 保持、定时器保留）
  const timerId = f.timers.activeIds()[0];
  f.timers.fire(timerId);
  await flush();
  assert.ok(f.surface.calls.refreshSessions.length >= 1, "tick 触发 refreshSessions 重拉");
  assert.deepEqual(f.surface.calls.setBusy, [true], "数据未变 busy 保持");
  assert.equal(f.timers.activeIds().length, 1, "仍运行中定时器保留");

  // 模拟重拉返回后其他会话已终态（idle）→ handleSessionsChanged → busy 复位 + 定时器清除
  f.sidebar.handleSessionsChanged(P, [
    { session_id: "s1", title: "对话一", run_status: "idle" },
    { session_id: "s2", title: "对话二", run_status: "idle" }
  ], "s1");
  assert.deepEqual(f.surface.calls.setBusy, [true, false], "全部非 running → busy(false) 复位");
  assert.equal(f.timers.activeIds().length, 0, "busy 复位后定时器清除");
});

test("busy 周期刷新：在途刷新跳过重叠 tick；invalidateProject 清除定时器", async () => {
  const P = "D:/projects/p1";
  const f = makeFixture({
    projects: [{ projectRoot: P, title: "小说一" }],
    selectedProjectRoot: P,
    currentProjectRoot: P
  });
  let releaseRefresh;
  const refreshCalls = [];
  f.surface.refreshSessions = () => {
    refreshCalls.push(1);
    return new Promise((resolve) => {
      releaseRefresh = resolve;
    });
  };
  f.sidebar.seedSessions(P, [
    { session_id: "s1", title: "对话一", run_status: "idle" },
    { session_id: "s2", title: "对话二", run_status: "running" }
  ], "s1");
  const timerId = f.timers.activeIds()[0];
  assert.ok(timerId, "busy=true 定时器启动");

  f.timers.fire(timerId); // tick 1：refresh 在途
  await flush();
  f.timers.fire(timerId); // tick 2：在途 → 跳过
  await flush();
  assert.deepEqual(refreshCalls, [1], "在途刷新期间跳过 tick，不重叠");
  releaseRefresh();
  await flush();

  // invalidateProject（项目切换）清除定时器
  assert.equal(f.timers.activeIds().length, 1, "复位前定时器仍在");
  f.sidebar.invalidateProject();
  assert.equal(f.timers.activeIds().length, 0, "invalidateProject 清除定时器");
});

// ---------------------------------------------------------------------------
// 8) dashboard seed 失败降级（规格审查修复）：当前项目「加载中…」→ 可重试失败行
// ---------------------------------------------------------------------------

test("dashboard seed 失败：当前项目组降级为失败行，点击重试恢复", async () => {
  const P = "D:/projects/p1";
  const calls = [];
  const f = makeFixture({
    projects: [{ projectRoot: P, title: "小说一" }],
    selectedProjectRoot: P,
    currentProjectRoot: P,
    fetchSessionsOverride: async (root) => {
      calls.push(root);
      return { sessions: [{ session_id: "s1", title: "对话一", run_status: "idle" }], active_session_id: "s1" };
    }
  });
  f.sidebar.render();
  assert.equal(allDescendants(f.listEl).filter((c) => c.classList.contains("session-loading")).length, 1, "未 seed 时加载中");

  // app.js renderError 路径 → markSessionsFailed
  f.sidebar.markSessionsFailed(P);
  const failed = allDescendants(f.listEl).filter((c) => c.classList.contains("session-retry"));
  assert.equal(failed.length, 1, "当前项目组降级显示失败行");
  assert.equal(failed[0].textContent.includes("会话加载失败"), true);

  failed[0].dispatch("click", {});
  await flush();
  assert.deepEqual(calls, [P], "点击重试重新拉取");
  assert.equal(rowsOf(f.listEl).length, 1, "重试成功后渲染会话行");
});

// ---------------------------------------------------------------------------
// 9) 懒加载健壮性：并发展开去重 / 失败降级与重试 / 防串场丢弃
// ---------------------------------------------------------------------------

test("并发去重：同一项目快速展开两次只发一个拉取请求", async () => {
  const P1 = "D:/projects/p1";
  const P2 = "D:/projects/p2";
  const calls = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = makeFixture({
    projects: [
      { projectRoot: P1, title: "小说一" },
      { projectRoot: P2, title: "小说二" }
    ],
    selectedProjectRoot: P1,
    currentProjectRoot: P1,
    initialStorage: { [COLLAPSED_KEY]: JSON.stringify({ [P2]: true }) },
    fetchSessionsOverride: async (root) => {
      calls.push(root);
      await gate;
      return { sessions: [{ session_id: "x1", title: "另一对话", run_status: "idle" }], active_session_id: "x1" };
    }
  });
  f.sidebar.seedSessions(P1, [{ session_id: "s1", title: "对话一", run_status: "idle" }], "s1");
  f.sidebar.render();

  chevronOf(f.listEl.children[2]).dispatch("click", {}); // 第一次展开：拉取在途
  await flush();
  chevronOf(f.listEl.children[2]).dispatch("click", {}); // 折叠
  chevronOf(f.listEl.children[2]).dispatch("click", {}); // 在途期间再展开
  await flush();
  assert.deepEqual(calls, [P2], "pending 中的拉取被复用，不重复请求");

  release();
  await flush();
  const groups = groupsOf(f.listEl);
  const rowsP2 = rowsOf(f.listEl).filter((r) => r.parentNode === groups[1]);
  assert.equal(rowsP2.length, 1, "拉取完成后渲染");
});

test("懒拉失败降级：reject → 失败行，点击重试 / 再次展开可恢复", async () => {
  const P1 = "D:/projects/p1";
  const P2 = "D:/projects/p2";
  const calls = [];
  let fail = true;
  const f = makeFixture({
    projects: [
      { projectRoot: P1, title: "小说一" },
      { projectRoot: P2, title: "小说二" }
    ],
    selectedProjectRoot: P1,
    currentProjectRoot: P1,
    initialStorage: { [COLLAPSED_KEY]: JSON.stringify({ [P2]: true }) },
    fetchSessionsOverride: async (root) => {
      calls.push(root);
      if (fail) throw new Error("网络错误");
      return { sessions: [{ session_id: "x1", title: "另一对话", run_status: "idle" }], active_session_id: "x1" };
    }
  });
  f.sidebar.seedSessions(P1, [{ session_id: "s1", title: "对话一", run_status: "idle" }], "s1");
  f.sidebar.render();
  chevronOf(f.listEl.children[2]).dispatch("click", {}); // 展开 → 懒拉
  await flush();
  let failed = allDescendants(f.listEl).filter((c) => c.classList.contains("session-retry"));
  assert.equal(failed.length, 1, "懒拉失败显示失败行");
  assert.equal(failed[0].textContent.includes("会话加载失败"), true);

  // 再次展开可重试：折叠 → 展开 → 重新拉取
  chevronOf(f.listEl.children[2]).dispatch("click", {}); // 折叠
  chevronOf(f.listEl.children[2]).dispatch("click", {}); // 展开（清除失败标记）
  await flush();
  assert.equal(calls.length, 2, "再次展开重新拉取");
  failed = allDescendants(f.listEl).filter((c) => c.classList.contains("session-retry"));
  assert.equal(failed.length, 1, "仍失败 → 失败行保持");

  // 点击失败行重试 → 成功
  fail = false;
  failed[0].dispatch("click", {});
  await flush();
  assert.equal(calls.length, 3, "点击重试重新拉取");
  const groups = groupsOf(f.listEl);
  const rowsP2 = rowsOf(f.listEl).filter((r) => r.parentNode === groups[1]);
  assert.equal(rowsP2.length, 1, "重试成功后渲染");
});

test("防串场：慢切换在途切走 → 迟到回调丢弃（不刷新错误项目）", async () => {
  const P = "D:/projects/p1";
  let releaseSwitch;
  const switches = [];
  const f = makeFixture({
    projects: [{ projectRoot: P, title: "小说一" }],
    selectedProjectRoot: P,
    currentProjectRoot: P
  });
  f.sidebar.seedSessions(P, [
    { session_id: "s1", title: "对话一", run_status: "idle" },
    { session_id: "s2", title: "对话二", run_status: "idle" }
  ], "s1");
  // 慢切换：switchSession 返回可控 pending
  f.surface.switchSession = (id) => {
    switches.push(id);
    return new Promise((resolve) => {
      releaseSwitch = resolve;
    });
  };
  f.sidebar.render();
  rowsOf(f.listEl)[1].dispatch("click", {}); // 点击 s2 → 慢切换在途
  await flush();
  assert.deepEqual(switches, ["s2"], "切换请求已发出");

  // 用户在途切走（项目切换 → invalidateProject 推进代次）
  f.sidebar.invalidateProject();
  releaseSwitch();
  await flush();
  assert.equal(f.surface.calls.refreshSessions.length, 0, "迟到切换续作被代次守卫丢弃，不刷新");
});

// ---------------------------------------------------------------------------
// 10) 可访问铁律：会话行键盘可达（role=button + tabindex + Enter/Space）
// ---------------------------------------------------------------------------

test("会话行键盘可达：Enter/Space 触发 switchSession，子按钮 keydown 不误触发", async () => {
  const P = "D:/projects/p1";
  const f = makeFixture({
    projects: [{ projectRoot: P, title: "小说一" }],
    selectedProjectRoot: P,
    currentProjectRoot: P
  });
  f.sidebar.seedSessions(P, [
    { session_id: "s1", title: "对话一", run_status: "idle" },
    { session_id: "s2", title: "对话二", run_status: "idle" }
  ], "s1");
  f.sidebar.render();
  const rows = rowsOf(f.listEl);
  assert.equal(rows[1].getAttribute("role"), "button", "会话行 role=button");
  assert.equal(rows[1].getAttribute("tabindex"), "0", "会话行可聚焦");

  // Enter → switchSession
  rows[1].dispatch("keydown", { key: "Enter" });
  await flush();
  assert.deepEqual(f.surface.calls.switchSession, ["s2"], "Enter 触发 switchSession");

  // Space → 第二次切换（preventDefault 防滚动）
  rows[0].dispatch("keydown", { key: " ", preventDefault() { this._prevented = true; } });
  await flush();
  assert.deepEqual(f.surface.calls.switchSession, ["s2", "s1"], "Space 触发 switchSession");

  // 子按钮 keydown 冒泡到行 → 守卫忽略（event.target !== row），不误触发
  const before = f.surface.calls.switchSession.length;
  const renameBtn = menuOf(rows[0]).children[0];
  renameBtn.dispatch("keydown", { key: "Enter" });
  await flush();
  assert.equal(f.surface.calls.switchSession.length, before, "操作按钮上的 Enter 不触发会话切换");
});

test("draft 占位行不可交互：aria-disabled + 移出 Tab 序，Enter 不切会话", async () => {
  const P = "D:/projects/p1";
  const f = makeFixture({
    projects: [{ projectRoot: P, title: "小说一" }],
    selectedProjectRoot: P,
    currentProjectRoot: P
  });
  f.sidebar.handleSessionsChanged(P, [
    { session_id: "draft-x", title: "新对话", status: "draft" },
    { session_id: "s1", title: "对话一", run_status: "idle" }
  ], "draft-x");
  f.sidebar.render();
  const draftRow = rowsOf(f.listEl)[0];
  assert.equal(draftRow.getAttribute("aria-disabled"), "true");
  assert.equal(draftRow.getAttribute("tabindex"), "-1");
  draftRow.dispatch("keydown", { key: "Enter" });
  await flush();
  assert.deepEqual(f.surface.calls.switchSession, [], "draft 占位 Enter 不切会话");
});

// ---------------------------------------------------------------------------
// 11) draft→真实过渡：surface 内部已刷新，commitSessionSwitch 续作去重
// ---------------------------------------------------------------------------

test("切走 draft 占位：surface 内部已刷新，模块续作跳过 refreshSessions（无双刷）", async () => {
  const P = "D:/projects/p1";
  const f = makeFixture({
    projects: [{ projectRoot: P, title: "小说一" }],
    selectedProjectRoot: P,
    currentProjectRoot: P
  });
  f.sidebar.handleSessionsChanged(P, [
    { session_id: "draft-x", title: "新对话", status: "draft" },
    { session_id: "s1", title: "对话一", run_status: "idle" }
  ], "draft-x");
  f.sidebar.render();
  rowsOf(f.listEl)[1].dispatch("click", {}); // 点真实会话 s1
  await flush();
  assert.deepEqual(f.surface.calls.switchSession, ["s1"]);
  assert.equal(f.surface.calls.refreshSessions.length, 0, "draft→真实由 surface 内部刷新，模块不重复刷");
});
