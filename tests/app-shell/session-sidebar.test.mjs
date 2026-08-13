// 左侧栏两级树（Task 9）——session-sidebar.mjs 行为测试。
//
// 无 JSDOM：最小 DOM 桩 + 注入假 surface（spy 记录调用），直接驱动
// createSessionSidebar（app.js 的薄接线层在这里用假依赖替换）。
// 覆盖：dashboard 会话渲染与活跃高亮、折叠/展开 + localStorage、
// 点击会话/改名/归档、其他项目懒加载与缓存、draft 占位过滤与切走收尾、
// busy 复位（run_status 联动）、项目行点击折叠/展开、跨项目会话委托。
import assert from "node:assert/strict";
import test from "node:test";

import { createSessionSidebar, createSessionRemovalResolver } from "../../src/app-shell/session-sidebar.mjs";

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
  querySelector(selector) {
    // 最小实现：仅支持类选择器（.cls），匹配后代中的首个元素（Task 2 的
    // decorateRow 与测试均用 .proj 定位行内主体按钮）。
    const cls = selector.startsWith(".") ? selector.slice(1) : null;
    if (!cls) return null;
    const find = (node) => {
      for (const child of node.children) {
        if (child.classList.contains(cls)) return child;
        const hit = find(child);
        if (hit) return hit;
      }
      return null;
    };
    return find(this);
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

function makeFixture({ projects = [], selectedProjectRoot = null, currentProjectRoot = null, sessionData = {}, initialStorage = {}, timers = null, fetchSessionsOverride = null, openProjectAndSession = null, onArchiveSession = null } = {}) {
  const doc = makeDocument();
  const listEl = doc.createElement("div");
  const countEl = doc.createElement("span");
  const filterEl = doc.createElement("input");
  const scrollEl = doc.createElement("div");
  const storage = makeStorage();
  for (const [key, value] of Object.entries(initialStorage)) storage.setItem(key, value);
  const surface = makeSurface();
  const fetchCalls = [];
  const openProjectCalls = [];
  // 默认注入定时器记录器：测试绝不启动真实 setInterval（避免悬挂）
  const timerRecorder = timers ?? makeTimerRecorder();
  // 跨项目会话切换的委托记录（app.js 侧注入 openProjectAndSession）
  const delegated = openProjectAndSession ?? (async (root, sid) => openProjectCalls.push([root, sid]));
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
      row.append(btn);
      return row;
    },
    surface,
    showToast: (message, type) => surface.toasts.push([message, type]),
    promptDialog: () => "新标题",
    storage,
    setIntervalFn: timerRecorder.setInterval.bind(timerRecorder),
    clearIntervalFn: timerRecorder.clearInterval.bind(timerRecorder),
    openProjectAndSession: delegated,
    onArchiveSession,
    doc
  });
  return { sidebar, listEl, countEl, filterEl, scrollEl, storage, surface, fetchCalls, openProjectCalls, doc, timers: timerRecorder };
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
  assert.equal(groups[0].children[0].dataset.sessionId, "s1", "会话组以会话行开始（「对话」组头已移除）");

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

test("点击项目行 .proj 按钮 → 折叠/展开会话列表，不再触发项目切换", () => {
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
  row2.querySelector(".proj").dispatch("click", {});
  assert.deepEqual(f.openProjectCalls, [], "项目行点击不再触发项目打开/切换");
  assert.equal(groupsOf(f.listEl).length, 2, "点击 .proj 后 P2 展开");
  assert.equal(chevronOf(f.listEl.children[2]).getAttribute("aria-expanded"), "true");

  f.listEl.children[2].querySelector(".proj").dispatch("click", {});
  assert.equal(groupsOf(f.listEl).length, 1, "再点 .proj 收起");
});

// ---------------------------------------------------------------------------
// 3) 会话操作：切换 / 新建 / 改名 / 归档
// ---------------------------------------------------------------------------

test("点击会话 → surface.switchSession + 切换后 refreshSessions", async () => {
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
});

test("点击其他项目的会话行 → 委托 openProjectAndSession(ownerRoot, sessionId)", async () => {
  const P1 = "D:/projects/p1";
  const P2 = "D:/projects/p2";
  const f = makeFixture({
    projects: [
      { projectRoot: P1, title: "小说一" },
      { projectRoot: P2, title: "小说二" }
    ],
    selectedProjectRoot: P1,
    currentProjectRoot: P1,
    sessionData: { [P2]: { sessions: [{ session_id: "s2", title: "对话二", run_status: "idle" }], active_session_id: "s2" } }
  });
  f.sidebar.seedSessions(P1, [{ session_id: "s1", title: "对话一", run_status: "idle" }], "s1");
  f.sidebar.render();
  await f.sidebar.switchSession("s2", P2);
  assert.deepEqual(f.openProjectCalls, [[P2, "s2"]], "跨项目会话切换走 openProjectAndSession");
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

test("Task 5：归档委托注入的 onArchiveSession（app.js 归档切走编排入口），不直连 surface", async () => {
  // 缺陷 B（归档活跃会话后消息写进隐藏归档会话）的修复入口：归档成功后若被归档的是
  // 当前活跃会话 → 切走（后端 last-active 解析）→ 无其他可用会话则占位。切走编排在
  // app.js（resolveActiveAfterSessionRemoval，与删除共用），sidebar 只负责把归档动作
  // 委托给它；未注入时保持直连 surface 的旧行为。
  const P = "D:/projects/p1";
  const onArchiveCalls = [];
  const f = makeFixture({
    projects: [{ projectRoot: P, title: "小说一" }],
    selectedProjectRoot: P,
    currentProjectRoot: P,
    onArchiveSession: async (session) => { onArchiveCalls.push(session.session_id); }
  });
  f.sidebar.seedSessions(P, [{ session_id: "s1", title: "对话一", run_status: "idle" }], "s1");
  f.sidebar.render();

  const row = rowsOf(f.listEl)[0];
  const ops = menuOf(row).children;
  ops[1].dispatch("click", {});
  await flush();
  assert.deepEqual(onArchiveCalls, ["s1"], "归档走注入的 onArchiveSession（app.js 切走处理入口）");
  assert.deepEqual(f.surface.calls.archiveSession, [], "注入 handler 时 sidebar 不再直连 surface.archiveSession");
  assert.ok(f.surface.toasts.some(([m]) => m.includes("已归档对话 对话一")), "归档 toast 文案保留");
});

// ---------------------------------------------------------------------------
// Task 5：移除后解析（createSessionRemovalResolver）行为级测试
// ---------------------------------------------------------------------------

test("Task 5：移除后解析——无其他可用会话进占位（占位分支可达）", async () => {
  // 评审 Important 2 的行为级测试：直接驱动 app.js 编排层的依赖注入纯函数。关键
  // 场景 = 归档/删除最后一个未归档会话：切走（last-active 解析）后必须按新代次
  // 重拉列表并等待落盘（模拟 surface.refreshSessions → handleSessionsChanged 同步
  // 更新缓存），被移除会话的 archived_at 才会进入缓存 → usable=0 → 占位可达。
  // 若解析器跳过 await refreshSessions 直接读缓存，仍拿到操作前快照（s1 未归档），
  // usable 恒 ≥ 1，占位分支不可达、本断言失败。
  const calls = [];
  let cache = {
    sessions: [{ session_id: "s1", title: "对话一", run_status: "idle", archived_at: null }],
    activeSessionId: "s1"
  };
  const resolve = createSessionRemovalResolver({
    getSessions: () => cache,
    switchSession: async (id) => { calls.push(["switchSession", id]); },
    refreshSessions: async () => {
      calls.push(["refreshSessions"]);
      // 模拟切走后以新代次重拉的权威列表：s1 已归档 → 无未归档会话、活跃指针 null
      cache = {
        sessions: [{ session_id: "s1", title: "对话一", run_status: "idle", archived_at: "2026-08-10" }],
        activeSessionId: null
      };
    },
    newSessionPlaceholder: () => { calls.push(["newSessionPlaceholder"]); return "draft-x"; }
  });

  await resolve("s1");
  assert.deepEqual(calls, [
    ["switchSession", null],
    ["refreshSessions"],
    ["newSessionPlaceholder"]
  ], "归档/删除最后一个可用会话：切走 → 新代次重拉落盘 → 进占位");
});

test("Task 5：移除后解析——仍有其他可用会话不进占位；移除非活跃会话不动作", async () => {
  let cache = {
    sessions: [
      { session_id: "s1", title: "对话一", run_status: "idle", archived_at: null },
      { session_id: "s2", title: "对话二", run_status: "idle", archived_at: null }
    ],
    activeSessionId: "s1"
  };
  const calls = [];
  const resolve = createSessionRemovalResolver({
    getSessions: () => cache,
    switchSession: async (id) => { calls.push(["switchSession", id]); },
    refreshSessions: async () => {
      calls.push(["refreshSessions"]);
      cache = {
        sessions: [
          { session_id: "s1", title: "对话一", run_status: "idle", archived_at: "2026-08-10" },
          { session_id: "s2", title: "对话二", run_status: "idle", archived_at: null }
        ],
        activeSessionId: "s2"
      };
    },
    newSessionPlaceholder: () => { calls.push(["newSessionPlaceholder"]); return "draft-x"; }
  });

  await resolve("s1");
  assert.deepEqual(calls, [
    ["switchSession", null],
    ["refreshSessions"]
  ], "仍有其他未归档会话：切走后重拉落盘，不进占位");

  // 移除非活跃会话：无任何动作（不切走、不重拉、不占位）
  const calls2 = [];
  const resolve2 = createSessionRemovalResolver({
    getSessions: () => ({
      sessions: [{ session_id: "s1", title: "对话一", run_status: "idle", archived_at: null }],
      activeSessionId: "s1"
    }),
    switchSession: async (id) => { calls2.push(["switchSession", id]); },
    refreshSessions: async () => { calls2.push(["refreshSessions"]); },
    newSessionPlaceholder: () => { calls2.push(["newSessionPlaceholder"]); }
  });
  await resolve2("s2");
  assert.deepEqual(calls2, [], "移除非活跃会话：切走/刷新/占位均不触发");
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
// 6) draft 占位过滤（渲染层排除，双保险）
// ---------------------------------------------------------------------------

test("draft 占位不渲染：缓存中的 draft 项被过滤，列表只含真实会话；仅占位时显示空态", async () => {
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
  assert.equal(rows.length, 1, "draft 占位不渲染，列表只含真实会话");
  assert.equal(rows[0].dataset.sessionId, "s1", "真实会话正常渲染");
  assert.ok(!rows.some((r) => r.dataset.sessionId === "draft-x"), "渲染出的会话行列表不含 draft 行");

  // 只有占位（新项目点「+」，尚无真实会话）：显示空态而非幽灵项
  f.sidebar.handleSessionsChanged(P, [
    { session_id: "draft-x", title: "新对话", status: "draft" }
  ], "draft-x");
  f.sidebar.render();
  const empty = f.listEl.querySelector(".session-empty");
  assert.ok(empty, "仅占位时显示空态行");
  assert.match(empty.textContent, /还没有对话/u);
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

// ---------------------------------------------------------------------------
// 11) draft→真实过渡：draft 不进缓存 → leavingDraft 恒 false → 续作刷新如实发生
// ---------------------------------------------------------------------------

test("切走 draft 占位：draft 不进缓存，leavingDraft 恒 false，模块续作刷新 1 次（幂等，可接受）", async () => {
  const P = "D:/projects/p1";
  const f = makeFixture({
    projects: [{ projectRoot: P, title: "小说一" }],
    selectedProjectRoot: P,
    currentProjectRoot: P
  });
  // Task 3 生产形状：占位期间 surface 只透出真实会话列表 + draft id 活跃指针
  //（draft 永不进缓存 sessions）。故 leavingDraft（按 activeSessionId 匹配缓存中
  // 的 draft 项）恒为 false，模块续作必然 surface.refreshSessions() 一次——与
  // agent/index.js 的 prevDraft 收尾（switchSession 内部刷新）构成两次幂等刷新，
  // 结果一致、无副作用。leavingDraft 分支按任务要求保留作防御，不删除。
  f.sidebar.handleSessionsChanged(P, [
    { session_id: "s1", title: "对话一", run_status: "idle" }
  ], "draft-x");
  f.sidebar.render();
  rowsOf(f.listEl)[0].dispatch("click", {}); // 点真实会话 s1
  await flush();
  assert.deepEqual(f.surface.calls.switchSession, ["s1"]);
  assert.equal(f.surface.calls.refreshSessions.length, 1, "draft 不进缓存 → 续作刷新 1 次（如实反映双刷，幂等可接受）");
});

// ---------------------------------------------------------------------------
// Task 16（B13）：移除项目清理——缓存/DOM 引用/折叠记录清空 + removed 守卫
// ---------------------------------------------------------------------------

test("Task 16 B13：移除项目后清空缓存/DOM 引用/折叠记录；迟到 seed/变更不再响应；重新出现可恢复", async () => {
  const P1 = "D:/projects/p1";
  const P2 = "D:/projects/p2";
  const projects = [
    { projectRoot: P1, title: "小说一" },
    { projectRoot: P2, title: "小说二" }
  ];
  const f = makeFixture({
    projects,
    selectedProjectRoot: P1,
    currentProjectRoot: P1,
    sessionData: { [P2]: { sessions: [{ session_id: "x1", title: "另一对话", run_status: "idle" }], active_session_id: "x1" } },
    initialStorage: { [COLLAPSED_KEY]: JSON.stringify({ [P2]: true }) }
  });
  f.sidebar.seedSessions(P1, [{ session_id: "s1", title: "对话一", run_status: "idle" }], "s1");
  f.sidebar.render();

  // 展开 P2 → 懒拉缓存 + DOM 组引用
  chevronOf(f.listEl.children[2]).dispatch("click", {});
  await flush();
  assert.equal(f.sidebar.getSessions(P2)?.sessions?.length, 1, "P2 懒拉已缓存");
  assert.deepEqual(
    f.sidebar.getProjectStateForTest(P2),
    { cached: true, pending: false, failed: false, groupHeld: true, collapsed: false, removed: false },
    "移除前 P2 持有缓存与组引用"
  );
  // 折叠 P2 产生折叠记录（collapsed 清理断言对象）
  chevronOf(f.listEl.children[2]).dispatch("click", {});
  assert.equal(JSON.parse(f.storage.getItem(COLLAPSED_KEY))[P2], true, "折叠状态已持久化");

  // 模拟 forgetProject：列表移除 P2 → removeProject + 整表重渲
  projects.splice(0, projects.length, { projectRoot: P1, title: "小说一" });
  f.sidebar.removeProject(P2);
  f.sidebar.render();

  assert.deepEqual(
    f.sidebar.getProjectStateForTest(P2),
    { cached: false, pending: false, failed: false, groupHeld: false, collapsed: false, removed: true },
    "移除后内部状态全部清空（缓存/引用/折叠/移除标记）"
  );
  assert.equal(f.sidebar.getSessions(P2), null, "移除后会话缓存不可读");
  assert.equal(JSON.parse(f.storage.getItem(COLLAPSED_KEY))[P2], undefined, "折叠记录同步清除");
  assert.equal(groupsOf(f.listEl).some((g) => g.dataset.projectRoot === P2), false, "P2 组不再挂载");

  // 迟到的 seed / 会话变更不再响应（removed 守卫）：不重建缓存
  f.sidebar.seedSessions(P2, [{ session_id: "x1", title: "另一对话", run_status: "idle" }], "x1");
  f.sidebar.handleSessionsChanged(P2, [{ session_id: "x1", title: "另一对话", run_status: "idle" }], "x1");
  assert.equal(f.sidebar.getSessions(P2), null, "移除后迟到事件不重建缓存");

  // 项目重新出现在列表（重新打开同一文件夹）：render 解除移除标记，缓存恢复可用
  projects.splice(0, projects.length,
    { projectRoot: P1, title: "小说一" },
    { projectRoot: P2, title: "小说二" }
  );
  f.sidebar.render();
  assert.equal(f.sidebar.getProjectStateForTest(P2).removed, false, "重新出现后移除标记解除");
  f.sidebar.seedSessions(P2, [{ session_id: "x1", title: "另一对话", run_status: "idle" }], "x1");
  assert.ok(f.sidebar.getSessions(P2), "重新出现后可再次缓存");
});

test("Task 16 B13：移除当前项目停止 busy 周期刷新并复位发送键", async () => {
  const P1 = "D:/projects/p1";
  const f = makeFixture({
    projects: [{ projectRoot: P1, title: "小说一" }],
    selectedProjectRoot: P1,
    currentProjectRoot: P1
  });
  f.sidebar.seedSessions(P1, [
    { session_id: "s1", title: "对话一", run_status: "idle" },
    { session_id: "s2", title: "对话二", run_status: "running" }
  ], "s1");
  assert.deepEqual(f.surface.calls.setBusy, [true], "其他会话运行中 → busy(true)");
  assert.equal(f.timers.activeIds().length, 1, "busy 周期刷新定时器运行中");

  f.sidebar.removeProject(P1);
  assert.deepEqual(f.surface.calls.setBusy, [true, false], "移除当前项目后 busy 复位");
  assert.equal(f.timers.activeIds().length, 0, "周期刷新定时器停止（listener 清理）");
});
