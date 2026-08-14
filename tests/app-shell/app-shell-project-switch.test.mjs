// Project-switch isolation test.
// Asserts: after switching from project A to project B, A's late dashboard response
// does not mutate the DOM and toasts/thread state stay clean.
//
// Strategy: exercise createProjectScope + the dashboard gate factory (the piece
// extracted from app.js) with a controllable fetch stub and a minimal DOM that
// mirrors the elements app.js touches on a switch.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createProjectScope } from "../../src/app-shell/project-scope.mjs";
import { withProjectScope } from "../../src/app-shell/api-client.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const appJsPath = path.join(here, "..", "..", "src", "app-shell", "app.js");

// ---- minimal DOM mirroring the elements app.js touches on a switch ----
class MockElement {
  constructor(tag) {
    this.tagName = tag;
    this.className = "";
    this.textContent = "";
    this.hidden = false;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this._attrs = {};
    this.classList = {
      _set: new Set(),
      add: (c) => { this.classList._set.add(c); this._sync(); },
      remove: (c) => { this.classList._set.delete(c); this._sync(); },
      contains: (c) => this.classList._set.has(c),
      toggle: (c, on) => { if (on === undefined) { this.classList._set.has(c) ? this.classList._set.delete(c) : this.classList._set.add(c); } else if (on) this.classList._set.add(c); else this.classList._set.delete(c); this._sync(); return this.classList._set.has(c); },
      toString: () => [...this.classList._set].join(" "),
    };
    this._listeners = new Map();
  }
  _sync() { this.className = this.classList.toString(); }
  appendChild(c) { this.children.push(c); return c; }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this._listeners.get(type);
    if (list) this._listeners.set(type, list.filter((f) => f !== fn));
  }
  setAttribute(k, v) { this._attrs[k] = v; }
  getAttribute(k) { return this._attrs[k] ?? null; }
  removeAttribute(k) { delete this._attrs[k]; }
  querySelector(sel) {
    const tag = sel.replace(/^[.#\[][^.\#\[]*[\]=]?/, "").split(/[.#\[]/)[0];
    // very loose: any descendant whose tagName matches first alpha chunk
    for (const c of this.children) {
      if (typeof c.querySelector === "function") {
        if (sel.startsWith("#") && c._attrs?.id === sel.slice(1)) return c;
        if (sel.startsWith(".") && (c.classList?._set?.has(sel.slice(1)))) return c;
        if (sel.startsWith("[") && sel.includes("=")) {
          const m = sel.match(/^\[data-([\w-]+)(?:='([^']*)')?\]$/);
          if (m && c.dataset?.[m[1]] === (m[2] ?? "")) return c;
          const m2 = sel.match(/^\[([\w-]+)(?:='([^']*)')?\]$/);
          if (m2 && c._attrs?.[m2[1]] === (m2[2] ?? "")) return c;
        }
        const found = c.querySelector(sel);
        if (found) return found;
      }
    }
    return null;
  }
}

function makeRefs() {
  const title = new MockElement("h1"); title.id = "project-title";
  const sub = new MockElement("div"); sub.id = "topbar-sub";
  const thread = new MockElement("div"); thread.id = "thread";
  const threadStatus = new MockElement("div"); threadStatus.id = "thread-status";
  threadStatus.textContent = "announce-loaded";
  const toastStack = new MockElement("div"); toastStack.id = "toast-stack";
  toastStack.children = [];
  return { title, sub, thread, threadStatus, toastStack };
}

// ---- the gate factory (this is the shape extracted from app.js) ----
// The real app.js will eventually drive this with a real fetch and refs;
// here we hand-roll the gate logic to verify the contract, then assert the
// production modules provide equivalent primitives.
function createDashboardGate({ projectScope, fetchImpl, getCurrentProjectRoot, onFresh, onError }) {
  let requestId = 0;
  return {
    async loadDashboard(projectRoot) {
      const id = ++requestId;
      const token = projectScope.capture(projectRoot);
      try {
        const url = withProjectScope("/api/dashboard", projectRoot);
        const data = await fetchImpl(url);
        if (id !== requestId) return { status: "stale", token };
        if (!projectScope.isCurrent(token)) return { status: "stale", token };
        if (typeof onFresh === "function") onFresh(data, token);
        return { status: "fresh", token, data };
      } catch (error) {
        if (id !== requestId) return { status: "stale", token, error };
        if (!projectScope.isCurrent(token)) return { status: "stale", token, error };
        if (typeof onError === "function") onError(error, token);
        return { status: "fresh", token, error };
      }
    },
  };
}

// ---- a controllable fetch stub ----
// queue() MUST run before fetch() (so the entry exists when the loader hits
// the entry lookup). The test calls queue() before the corresponding
// loadDashboard to keep the contract clear.
function makeFetch() {
  const pending = new Map(); // projectRoot -> { payload, delay, settled }
  return {
    queue(projectRoot, payload, { delay = 0 } = {}) {
      pending.set(projectRoot, { payload, delay, settled: false });
    },
    async fetch(url) {
      const projectRoot = decodeURIComponent(new URL(url, "http://x").searchParams.get("projectRoot") ?? "");
      const entry = pending.get(projectRoot);
      if (!entry) throw new Error(`no stub for ${projectRoot}`);
      // delay first, then return the payload
      if (entry.delay) await new Promise((r) => setTimeout(r, entry.delay));
      return entry.payload;
    },
  };
}

function buildDashboard(projectRoot, projectName, chapterNo, chapterContent) {
  return {
    ok: true,
    hasProject: true,
    project: { projectRoot, title: projectName },
    summary: { modelCalls: 0, completedChapters: 1, targetChapters: 2, projectStatus: "running" },
    chapters: [{ chapter_no: chapterNo, title: `第 ${chapterNo} 章`, artifact: { state: "committed" } }],
    events: [{ id: `${projectName}-evt`, type: "chapter_completed", chapter_no: chapterNo, content: chapterContent }],
  };
}

test("integration: stale response from project A does not mutate the DOM after switching to B", async () => {
  const projectScope = createProjectScope();
  const fetchStub = makeFetch();
  const refs = makeRefs();
  const renderedKeys = new Set();
  const askEntries = new Map();

  let currentProjectRoot = null;
  const getCurrentProjectRoot = () => currentProjectRoot;

  // A switch-path callback: clear transient state, mark current root.
  function clearTransientState(root) {
    projectScope.activate(root);
    renderedKeys.clear();
    askEntries.clear();
    refs.thread.children = [];
    refs.threadStatus.textContent = "";
    refs.toastStack.children = [];
  }

  const onFresh = (data) => {
    currentProjectRoot = data.project.projectRoot;
    refs.title.textContent = data.project.title;
    // Mocked event render: append a paragraph with the chapter content.
    const p = new MockElement("p");
    p.dataset.chapter = String(data.chapters[0].chapter_no);
    p.textContent = `${data.project.title} - ${data.events[0].content}`;
    refs.thread.children.push(p);
  };

  const gate = createDashboardGate({ projectScope, fetchImpl: (u) => fetchStub.fetch(u), getCurrentProjectRoot, onFresh });

  // Step 1: switch to A (delayed)
  clearTransientState("D:\\projects\\a");
  const a = buildDashboard("D:\\projects\\a", "project-a", 1, "A 内容");
  fetchStub.queue("D:\\projects\\a", a, { delay: 80 });
  const aPromise = gate.loadDashboard("D:\\projects\\a");

  // Step 2: switch to B (fast) — must clear transient state, then B resolves
  await new Promise((r) => setTimeout(r, 10));
  clearTransientState("D:\\projects\\b");
  const b = buildDashboard("D:\\projects\\b", "project-b", 1, "B 内容");
  fetchStub.queue("D:\\projects\\b", b, { delay: 0 });
  const bResult = await gate.loadDashboard("D:\\projects\\b");
  assert.equal(bResult.status, "fresh");
  // DOM is B-only
  const chapterEl = refs.thread.children[0];
  assert.equal(chapterEl.dataset.chapter, "1");
  assert.equal(chapterEl.textContent.includes("A 内容"), false);
  assert.equal(chapterEl.textContent.includes("B 内容"), true);
  assert.equal(refs.title.textContent, "project-b");
  assert.deepEqual(refs.toastStack.children, [], "toast stack should be empty after switch");
  assert.equal(refs.threadStatus.textContent, "", "thread status announcement should be cleared");

  // Step 3: A's late response arrives — must NOT mutate the DOM
  const aResult = await aPromise;
  assert.equal(aResult.status, "stale", "late A response must be marked stale");

  // Re-verify: DOM is still B-only, title still project-b
  const chapterAfter = refs.thread.children[0];
  assert.equal(chapterAfter.textContent.includes("A 内容"), false);
  assert.equal(chapterAfter.textContent.includes("B 内容"), true);
  assert.equal(refs.title.textContent, "project-b");
  assert.equal(refs.threadStatus.textContent, "", "late A response must not write thread status");
  assert.equal(refs.toastStack.children.length, 0, "late A response must not produce toasts");
});

test("integration: two quick switches — the second wins, neither stale response mutates", async () => {
  const projectScope = createProjectScope();
  const fetchStub = makeFetch();
  const refs = makeRefs();

  let currentProjectRoot = null;
  const onFresh = (data) => {
    currentProjectRoot = data.project.projectRoot;
    const p = new MockElement("p");
    p.dataset.chapter = "1";
    p.textContent = `${data.project.title} - ${data.events[0].content}`;
    refs.thread.children = [p];
  };
  const gate = createDashboardGate({ projectScope, fetchImpl: (u) => fetchStub.fetch(u), getCurrentProjectRoot: () => currentProjectRoot, onFresh });

  function clearTransientState(root) {
    projectScope.activate(root);
    refs.thread.children = [];
    refs.threadStatus.textContent = "";
  }

  // Switch to A (slow)
  clearTransientState("D:\\projects\\a");
  const a = buildDashboard("D:\\projects\\a", "project-a", 1, "A 内容");
  fetchStub.queue("D:\\projects\\a", a, { delay: 60 });
  const aPromise = gate.loadDashboard("D:\\projects\\a");

  // Switch to C (medium) before A resolves
  await new Promise((r) => setTimeout(r, 5));
  clearTransientState("D:\\projects\\c");
  const c = buildDashboard("D:\\projects\\c", "project-c", 1, "C 内容");
  fetchStub.queue("D:\\projects\\c", c, { delay: 60 });
  const cPromise = gate.loadDashboard("D:\\projects\\c");

  // Switch to B (fast) before C resolves
  await new Promise((r) => setTimeout(r, 5));
  clearTransientState("D:\\projects\\b");
  const b = buildDashboard("D:\\projects\\b", "project-b", 1, "B 内容");
  fetchStub.queue("D:\\projects\\b", b, { delay: 0 });
  const bResult = await gate.loadDashboard("D:\\projects\\b");
  assert.equal(bResult.status, "fresh");

  // Wait for the stale C and A to land
  const cResult = await cPromise;
  const aResult = await aPromise;
  assert.equal(cResult.status, "stale");
  assert.equal(aResult.status, "stale");

  // DOM is B-only
  const chapterEl = refs.thread.children[0];
  assert.equal(chapterEl.textContent.includes("B 内容"), true);
  assert.equal(chapterEl.textContent.includes("A 内容"), false);
  assert.equal(chapterEl.textContent.includes("C 内容"), false);
});

// ---- reader gate（B7）：openReader 的守卫形状——捕获 {projectScope, chapterNo}，
// await 后校验项目 scope 与 readerChapterNo；慢旧章节响应不覆盖新章。app.js 是页面
// 组合根（不可直接 import），此处用可控 fetch 模拟守卫契约（与 dashboard gate 同款
// 测试策略），并另以静态断言确认生产 app.js 实现同款守卫。
function createReaderGate({ projectScope, fetchImpl, getChapterNo, onFresh, onError }) {
  return {
    async openReader(chapterNo) {
      const token = projectScope.capture();
      try {
        const data = await fetchImpl(chapterNo);
        if (!projectScope.isCurrent(token)) return { status: "stale", token };
        if (getChapterNo() !== chapterNo) return { status: "stale", token };
        if (typeof onFresh === "function") onFresh(data, chapterNo);
        return { status: "fresh", token, data };
      } catch (error) {
        if (!projectScope.isCurrent(token)) return { status: "stale", token, error };
        if (getChapterNo() !== chapterNo) return { status: "stale", token, error };
        if (typeof onError === "function") onError(error, chapterNo);
        return { status: "fresh", token, error };
      }
    },
  };
}

function makeReaderFetch() {
  const pending = new Map();
  return {
    queue(chapterNo, payload, { delay = 0 } = {}) {
      pending.set(chapterNo, { payload, delay, settled: false });
    },
    async fetch(chapterNo) {
      const entry = pending.get(chapterNo);
      if (!entry) throw new Error(`no stub for chapter ${chapterNo}`);
      if (entry.delay) await new Promise((r) => setTimeout(r, entry.delay));
      return entry.payload;
    },
  };
}

test("B7: 慢旧章节响应不覆盖新章（reader 守卫契约模拟）", async () => {
  const projectScope = createProjectScope();
  projectScope.activate("D:\\projects\\a");
  const fetchStub = makeReaderFetch();
  const rendered = [];
  let readerChapterNo = null;

  const gate = createReaderGate({
    projectScope,
    getChapterNo: () => readerChapterNo,
    fetchImpl: (c) => fetchStub.fetch(c),
    onFresh: (data, chapterNo) => { rendered.push(chapterNo); }
  });

  // 第 1 章响应很慢：请求发出后用户切到第 2 章
  fetchStub.queue(1, { title: "第 1 章", content: "旧正文" }, { delay: 60 });
  const slowPromise = gate.openReader(1);
  readerChapterNo = 2;
  fetchStub.queue(2, { title: "第 2 章", content: "新正文" }, { delay: 0 });
  const fastResult = await gate.openReader(2);
  assert.equal(fastResult.status, "fresh");
  assert.deepEqual(rendered, [2], "第 2 章应立即渲染");

  const slowResult = await slowPromise;
  assert.equal(slowResult.status, "stale", "旧章节响应必须被标记 stale");
  assert.deepEqual(rendered, [2], "慢旧章节响应不得覆盖新章");

  // 项目切换同样使在途 reader 响应失效（scope 校验）
  fetchStub.queue(3, { title: "第 3 章", content: "旧项目正文" }, { delay: 30 });
  const pendingPromise = gate.openReader(3);
  projectScope.activate("D:\\projects\\b");
  readerChapterNo = null; // clearTransientState 语义
  const pendingResult = await pendingPromise;
  assert.equal(pendingResult.status, "stale", "切项目后旧响应的 scope 失效");
  assert.deepEqual(rendered, [2], "切项目后旧响应不得渲染");
});

test("B7: app.js 在 openReader 中实现 await 后 scope/no 校验（静态契约）", async () => {
  const appSource = await fs.readFile(appJsPath, "utf8");
  // 无参 capture：openReader 捕获当前项目 scope token（loadDashboard 使用带参
  // capture(activeProjectRoot)，无参形式是本守卫的 reader 专属形状）。
  assert.match(appSource, /const\s+token\s*=\s*projectScope\.capture\s*\(\s*\)/u, "openReader 应捕获项目 scope token");
  assert.match(appSource, /projectScope\.isCurrent\s*\(\s*token\s*\)/u, "await 后必须校验项目 scope");
  assert.match(appSource, /readerChapterNo\s*!==\s*chapterNo/u, "await 后必须比对 readerChapterNo（慢旧章节不覆盖新章）");
});

test("R5-12：app.js 终态钩子统一刷新 dashboard 与会话列表；后台刷新失败只 toast（静态契约）", async () => {
  const appSource = await fs.readFile(appJsPath, "utf8");
  assert.match(appSource, /onRunTerminal\s*:\s*\(\s*\)\s*=>\s*\{/u, "app.js 应实现 onRunTerminal 钩子");
  assert.match(appSource, /agentSurface\.refreshSessions\s*\(\s*\)/u, "终态后刷新会话列表（busy 复位）");
  assert.match(appSource, /loadDashboard\s*\(\s*\{\s*background\s*:\s*true\s*\}\s*\)/u, "终态后以后台模式重拉 dashboard（顶栏进度/章节抽屉/成本面板）");
  assert.match(appSource, /options\?\.background\s*===\s*true/u, "loadDashboard 支持后台失败模式");
  assert.match(appSource, /showToast\(error/u, "后台刷新失败只 toast，不渲染错误页");
});

// ---- Task A1：设置入口统一（齿轮点击 / 抽屉模型配置 / 斜杠命令 → 弹窗）----
// openSettingsOrModelPage 与 closeAppTopLayer 是 app.js 组合根的产物（不可直接
// import）。沿用本文件 reader gate 的既有策略：先把简化契约抽成可注入工厂
// （createSettingsRouting），行为测试只针对该契约（齿轮点击 → settingsScrim 含
// "show"；弹窗打开时 closeAppTopLayer 返回 true 且调用 closeSettingsModal；
// model/settings/缺省回落 "model"），再用静态断言确认生产 app.js 提供等价接线
// （不再含整页 modelSettingsPage/closeModelSettingsPage 路径）。
function createSettingsRouting({ refs, openSettings, closeSettings }) {
  return {
    // 镜像 app.js 简化后的 openSettingsOrModelPage：model/settings/缺省 → "model"，
    // 其余分区原样透传；统一 await openSettingsModal(section)。
    async openSettingsOrModelPage(section) {
      if (!section || section === "model" || section === "settings") section = "model";
      await openSettings(section);
    },
    // 镜像 app.js closeAppTopLayer 的设置弹窗分支：弹窗开着 → 关闭并返回 true。
    closeAppTopLayer() {
      if (refs.settingsScrim.classList.contains("show")) { closeSettings(); return true; }
      return false;
    }
  };
}

// 设置弹窗的行为魔板：openSettings 添加 show（等价 createSettingsModal 的
// openSettingsModal 成功路径），closeSettings 移除 show。齿轮点击即
// openSettingsOrModelPage() 默认无参 → 弹窗打开后 settingsScrim 应含 "show"。
function makeSettingsHarness() {
  const refs = { settingsScrim: new MockElement("div") };
  const opened = [];
  const closed = [];
  const routing = createSettingsRouting({
    refs,
    openSettings: async (section) => {
      opened.push(section);
      refs.settingsScrim.classList.add("show");
    },
    closeSettings: () => {
      closed.push(true);
      refs.settingsScrim.classList.remove("show");
    }
  });
  return { refs, opened, closed, routing };
}

test("A1: 齿轮点击（缺省）→ 设置弹窗打开（scrim 含 show），弹窗打开时 closeAppTopLayer 返回 true 且调用 closeSettingsModal", async () => {
  const { refs, opened, closed, routing } = makeSettingsHarness();
  // 齿轮监听 = refs.openSettings.click → openSettingsOrModelPage()（无分区参数）。
  await routing.openSettingsOrModelPage();
  assert.ok(refs.settingsScrim.classList.contains("show"), "settingsScrim 应含 show（弹窗打开）");
  assert.deepEqual(opened, ["model"], "缺省入口应路由到 model 分区（A3 起生效，此前回落第一个分区）");
  // 弹窗打开时 ESC 顶层关闭：closeAppTopLayer 返回 true 且调用了 closeSettingsModal。
  assert.equal(routing.closeAppTopLayer(), true, "弹窗打开时 closeAppTopLayer 应返回 true");
  assert.equal(closed.length, 1, "closeAppTopLayer 应调用 closeSettingsModal");
  assert.ok(!refs.settingsScrim.classList.contains("show"), "关闭后 scrim 不应再含 show");
});

test("A1: 弹窗未打开时 closeAppTopLayer 返回 false 且不调用 closeSettingsModal", async () => {
  const { refs, closed, routing } = makeSettingsHarness();
  assert.equal(routing.closeAppTopLayer(), false, "弹窗未打开时 closeAppTopLayer 应返回 false");
  assert.equal(closed.length, 0, "不得在弹窗未打开时调用 closeSettingsModal");
});

test("A1: model/settings/缺省统一回落 model 分区，writing/skills/danger 原样透传", async () => {
  const { opened, routing } = makeSettingsHarness();
  for (const input of [undefined, null, "model", "settings"]) {
    await routing.openSettingsOrModelPage(input);
  }
  assert.deepEqual(opened, ["model", "model", "model", "model"], "model/settings/缺省均应路由到 model 分区");
  opened.length = 0;
  await routing.openSettingsOrModelPage("writing");
  await routing.openSettingsOrModelPage("skills");
  await routing.openSettingsOrModelPage("danger");
  assert.deepEqual(opened, ["writing", "skills", "danger"], "writing/skills/danger 应原样透传到弹窗分区");
});

test("A1: app.js 已退役整页模型页接线（无 modelSettingsPage/closeModelSettingsPage，入口统一 await openSettingsModal）", async () => {
  const appSource = await fs.readFile(appJsPath, "utf8");
  assert.doesNotMatch(
    appSource,
    /modelSettingsPage|closeModelSettingsPage|modelSettingsClose/u,
    "app.js 不得再引用整页模型页的标识符/refs 收集/监听"
  );
  assert.match(
    appSource,
    /function\s+openSettingsOrModelPage\s*\(\s*section\s*\)\s*\{/u,
    "openSettingsOrModelPage 应保留且接受 section 参数"
  );
  assert.match(appSource, /section\s*=\s*"model"/u, "model/settings/缺省分支只做 section = model");
  assert.match(appSource, /await\s+openSettingsModal\s*\(\s*section\s*\)/u, "开放入口统一 await openSettingsModal(section)");
  assert.doesNotMatch(appSource, /closeModelSettingsPage\s*\(/u, "不得含 closeModelSettingsPage 定义或调用");
});
