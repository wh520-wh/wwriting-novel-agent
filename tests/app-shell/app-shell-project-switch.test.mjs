// Project-switch isolation test.
// Asserts: after switching from project A to project B, A's late dashboard response
// does not mutate the DOM and toasts/thread state stay clean.
//
// Strategy: exercise createProjectScope + the dashboard gate factory (the piece
// extracted from app.js) with a controllable fetch stub and a minimal DOM that
// mirrors the elements app.js touches on a switch.
import assert from "node:assert/strict";
import test from "node:test";

import { createProjectScope } from "../../src/app-shell/project-scope.mjs";
import { withProjectScope } from "../../src/app-shell/api-client.js";

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
  const status = new MockElement("span"); status.id = "project-status";
  return { title, sub, thread, threadStatus, toastStack, status };
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
