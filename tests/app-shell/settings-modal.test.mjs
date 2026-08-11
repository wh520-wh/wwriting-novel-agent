// Settings modal: pure helpers (formatConnectionStatus + submitModelConnectionTest) +
// DOM-level behavior of createSettingsModal (model save without a project).
// The exported helpers must work without a DOM so they can be exercised in node:test;
// the modal tests use a minimal DOM mock (no JSDOM), mirroring activity-strip-render.test.mjs.
import assert from "node:assert/strict";
import test from "node:test";

import {
  formatConnectionStatus,
  submitModelConnectionTest,
} from "../../src/app-shell/settings-connection.mjs";

// ---------------------------------------------------------------------------
// Minimal DOM mock (no JSDOM)
// ---------------------------------------------------------------------------

class MockElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.attributes = new Map();
    this._listeners = new Map();
    this.className = "";
    this.isConnected = true;
    this.innerHTML = "";
    this.classList = {
      _classes: new Set(),
      add: (...names) => { for (const n of names) this.classList._classes.add(n); },
      remove: (...names) => { for (const n of names) this.classList._classes.delete(n); },
      toggle: (name, force) => {
        if (force === undefined) {
          if (this.classList._classes.has(name)) { this.classList._classes.delete(name); return false; }
          this.classList._classes.add(name); return true;
        }
        if (force) this.classList._classes.add(name); else this.classList._classes.delete(name);
        return force;
      },
      has: (name) => this.classList._classes.has(name),
      contains: (name) => this.classList._classes.has(name),
      toString: () => [...this.classList._classes].join(" ")
    };
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }

  append(...nodes) { this.children.push(...nodes); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...nodes) {
    this.children.length = 0;
    for (const node of nodes) {
      // 与真实 DOM 一致：replaceChildren(fragment) 会把 fragment 的子节点移入父节点。
      if (node instanceof MockElement && node.tagName === "DOCUMENT-FRAGMENT") {
        this.children.push(...node.children);
        node.children.length = 0;
      } else {
        this.children.push(node);
      }
    }
  }

  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }

  /** Fire all handlers registered for `type`, forwarding extra args. */
  _fire(type, ...args) {
    // 真实 DOM 的 click 事件总是带 event 对象；无参触发时补一个假事件，
    // 让带 e.stopPropagation() 的处理器在 mock 里也能跑。
    const evt = { target: this, stopPropagation() {}, preventDefault() {} };
    const pass = args.length ? args : [evt];
    for (const fn of this._listeners.get(type) ?? []) fn(...pass);
  }

  /** 与真实 DOM 的 HTMLElement.click() 一致：派发 click 事件。 */
  click() { this._fire("click"); }

  focus() {}
  closest() { return null; }
}

// Browser-ish globals so vendor/gsap (UMD) and motion-runtime can load in Node.
globalThis.self = globalThis;
globalThis.window = globalThis.window ?? {};
globalThis.window.setTimeout ??= (handler, timeout, ...args) => setTimeout(handler, timeout, ...args);
globalThis.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

/** @type {MockElement[]} */
let domRegistry = [];
function installDomMock() {
  domRegistry = [];
  const docListeners = new Map();
  globalThis.document = {
    createElement(tag) {
      const el = new MockElement(tag);
      domRegistry.push(el);
      return el;
    },
    createElementNS(_ns, tag) { return globalThis.document.createElement(tag); },
    createDocumentFragment() { return new MockElement("document-fragment"); },
    getElementById() { return null; },
    querySelector() { return null; },
    activeElement: null,
    // Task 13：嵌套层（添加菜单 / 清空确认）的文档级 Esc/click 监听需要可注册与触发。
    addEventListener(type, handler) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const list = docListeners.get(type) ?? [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    _fire(type, ...args) {
      for (const fn of docListeners.get(type) ?? []) fn(...args);
    }
  };
}
installDomMock();

// settings-modal.js pulls in motion-runtime (and vendor/gsap), so import it
// dynamically after the browser-ish globals are in place.
const { createSettingsModal } = await import("../../src/app-shell/settings-modal.js");

// ---------------------------------------------------------------------------
// Modal harness
// ---------------------------------------------------------------------------

// Task 7：内存版 localStorage 桩——草稿持久化按注入的 storage 实现，
// 每个测试用独立实例避免跨测试污染。
function createMockStorage() {
  const map = new Map();
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
    _keys() { return [...map.keys()]; }
  };
}

function createSettingsModalForTest(overrides = {}) {
  domRegistry = [];
  // refs 单独解构：partial refs 只覆盖对应字段，不会被 ...overrides 整体替换 ctx.refs。
  const { refs: refsOverride = {}, ...rest } = overrides;
  const refs = {
    settingsSearch: new MockElement("input"),
    settingsSave: new MockElement("button"),
    settingsScrim: new MockElement("div"),
    settingsDetail: new MockElement("div"),
    settingsProviderList: new MockElement("div"),
    ...refsOverride
  };
  const ctx = {
    refs,
    getDashboard: () => ({}),
    getCurrentProjectRoot: () => "",
    loadDashboard: async () => {},
    showToast: () => {},
    getLastFocused: () => null,
    setLastFocused: () => {},
    ...rest
  };
  return createSettingsModal(ctx, {
    getJsonImpl: overrides.getJsonImpl ?? (async () => ({ ok: true, default_model: null, models: [] })),
    postJsonImpl: overrides.postJsonImpl ?? (async () => ({ ok: true })),
    deleteJsonImpl: overrides.deleteJsonImpl ?? (async () => ({ ok: true })),
    // 模型切换确认函数：显式注入（默认 window.confirm，node 测试环境不可用）。
    confirmImpl: overrides.confirmImpl ?? (() => true),
    // 表单草稿的 localStorage 注入：默认给独立的内存桩。
    storage: overrides.storage ?? createMockStorage()
  });
}

function findElementByLabel(label) {
  return domRegistry.find((el) => el.getAttribute("aria-label") === label) ?? null;
}

// ---------------------------------------------------------------------------
// Pure helper tests (existing)
// ---------------------------------------------------------------------------

test("test connection posts the unsaved MiMo candidate", async () => {
  const calls = [];
  const controller = new AbortController();
  const result = await submitModelConnectionTest({
    postJsonImpl: async (pathname, body, options) => {
      calls.push({ pathname, body, signal: options.signal });
      return {
        ok: true,
        provider: "openai-compatible",
        model_name: "mimo-v2.5-pro",
        latency_ms: 48,
      };
    },
    projectRoot: "D:\\novels\\demo",
    active_model: {
      provider: "openai-compatible",
      model_name: "mimo-v2.5-pro",
      base_url: "https://api.xiaomimimo.com/v1",
      api_key_env: "XIAOMI_MIMO_API_KEY",
    },
    apiKey: "temporary-key",
    signal: controller.signal,
  });

  assert.equal(calls[0].pathname, "/api/settings/test-connection");
  assert.equal(calls[0].body.active_model.model_name, "mimo-v2.5-pro");
  assert.equal(calls[0].body.active_model.api_key, "temporary-key");
  assert.equal(calls[0].signal, controller.signal);
  assert.equal(formatConnectionStatus(result), "连接成功 · 48 ms");
});

test("connection failure keeps the actionable provider message", () => {
  assert.equal(formatConnectionStatus({
    ok: false,
    code: "authentication_failed",
    message: "API Key 无效或无权限",
  }), "API Key 无效或无权限");
});

test("test connection propagates AbortSignal", async () => {
  const controller = new AbortController();
  const pending = submitModelConnectionTest({
    postJsonImpl: async (pathname, body, { signal }) => {
      await new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      });
    },
    projectRoot: "D:\\novels\\demo",
    active_model: {
      provider: "openai-compatible",
      model_name: "mimo-v2.5-pro",
      base_url: "https://api.xiaomimimo.com/v1",
      api_key_env: "XIAOMI_MIMO_API_KEY",
    },
    apiKey: "temporary-key",
    signal: controller.signal,
  });

  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
});

// ---------------------------------------------------------------------------
// 模型分区（Task 8 过渡期）：模型配置迁往新的供应商管理页面（Task 12 建新页并改
// 入口）。旧弹窗模型区块改为只读占位——显示迁移提示、禁用保存，不再渲染模型表单 /
// 已配置清单 / 测试连接，也不向模型 API 发写请求。旧模型表单/草稿/切换确认行为
// 随旧实现一并撤下（新页面的交互测试由 Task 12-16 建立）。
// ---------------------------------------------------------------------------

test("模型分区为只读占位：显示迁移提示，禁用保存，不渲染模型表单", async () => {
  const saveButton = new MockElement("button");
  const modal = createSettingsModalForTest({
    refs: { settingsSave: saveButton },
    getCurrentProjectRoot: () => ""
  });
  await modal.openSettingsModal();

  assert.equal(saveButton.disabled, true, "模型分区保存按钮应禁用");
  assert.equal(saveButton.textContent, "无需保存");
  // 迁移提示文本。
  const hint = modal.getSettingsDetailForTest().children.find((el) => String(el.className ?? "") === "spd-hint");
  assert.ok(hint, "模型分区应渲染迁移提示");
  assert.ok(hint.textContent.includes("模型设置已迁移到新的供应商管理页面"), "提示应指向新的供应商管理页面");
  // 不渲染模型表单字段与测试连接。
  for (const label of ["模型", "API 地址 · 基础 URL", "API Key", "提供商"]) {
    assert.equal(findElementByLabel(label), null, `模型分区占位不得渲染 ${label}`);
  }
  assert.equal(domRegistry.find((el) => el.id === "settings-test-connection"), undefined, "不得渲染测试连接按钮");
});

test("模型分区占位：保存/重置自定义均为 no-op，不发模型请求，左栏清单置空", async () => {
  const calls = [];
  const modal = createSettingsModalForTest({
    getCurrentProjectRoot: () => "",
    postJsonImpl: async (url, body) => { calls.push({ url, body }); return { ok: true }; }
  });
  await modal.openSettingsModal();
  await modal.saveSettingsForTest();
  modal.resetToCustom();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls.map((c) => c.url), [], "占位期模型分区不得发出 model-profile / update / test-connection 请求");
  assert.equal(modal.getSavedModelItems().length, 0, "左栏不残留「已配置」/「新增供应商」交互入口");
});


// ---------------------------------------------------------------------------
// Task 14：普通文件夹（hasProject:false）下写作参数/项目管理分区只显示说明，
// 保存禁用，绝不向 /api/settings/update 发旧版小说项目专属的写请求。
// ---------------------------------------------------------------------------

test("普通文件夹下写作参数分区显示说明且保存按钮禁用", async () => {
  const saveButton = new MockElement("button");
  const postCalls = [];
  const modal = createSettingsModalForTest({
    refs: { settingsSave: saveButton },
    getDashboard: () => ({ hasProject: false, project: null, projectRoot: "D:/plain/folder" }),
    getCurrentProjectRoot: () => "D:/plain/folder",
    postJsonImpl: async (url, body) => {
      postCalls.push({ url, body });
      return { ok: true };
    }
  });
  await modal.openSettingsModal("writing");

  const hints = domRegistry.filter((el) => el.className === "spd-hint");
  assert.ok(
    hints.some((h) => h.textContent.includes("仅旧版小说项目可用")),
    "普通文件夹应显示旧版小说项目专属说明"
  );
  assert.equal(saveButton.disabled, true, "普通文件夹下保存按钮应禁用");
  assert.equal(saveButton.textContent, "无需保存");
  assert.equal(domRegistry.some((el) => el.id === "settings-output-style"), false, "不应渲染输出风格下拉");

  await modal.saveSettingsForTest();
  assert.equal(postCalls.some((c) => c.url === "/api/settings/update"), false, "保存不得向 /api/settings/update 发请求");
});

test("普通文件夹下项目管理分区显示说明且无归档按钮", async () => {
  const saveButton = new MockElement("button");
  const modal = createSettingsModalForTest({
    refs: { settingsSave: saveButton },
    getDashboard: () => ({ hasProject: false, project: null, projectRoot: "D:/plain/folder" }),
    getCurrentProjectRoot: () => "D:/plain/folder"
  });
  await modal.openSettingsModal("danger");

  const hints = domRegistry.filter((el) => el.className === "spd-hint");
  assert.ok(
    hints.some((h) => h.textContent.includes("仅旧版小说项目可用")),
    "普通文件夹应显示旧版小说项目专属说明"
  );
  assert.equal(domRegistry.some((el) => el.id === "settings-archive-trigger"), false, "不应渲染归档按钮");
  assert.equal(domRegistry.some((el) => el.id === "settings-unarchive-trigger"), false, "不应渲染解除归档按钮");
  assert.equal(saveButton.disabled, true, "保存按钮保持禁用");
});

// ---------------------------------------------------------------------------
// 「Agent 技能」分区（Task 13）：segmented control / 技能列表 / 来源标签 /
// 覆盖说明 / 打开目录 / 添加菜单（文件夹/ZIP）/ 删除；无任何启停控件。
// ---------------------------------------------------------------------------

const SKILLS_CATALOG = {
  ok: true,
  has_project: true,
  project_root: "D:/novels/demo",
  active: [
    { name: "suspense-chapter-end", source: "builtin", description: "章节结尾悬念", path: "D:/builtin/suspense-chapter-end" },
    { name: "my-style", source: "global", description: "我的文风", path: "D:/home/.wwriting/skills/my-style" },
    { name: "project-voice", source: "project", description: "项目语感", path: "D:/novels/demo/skills/project-voice" }
  ],
  shadowed: [
    { name: "my-style", source: "bundled", description: "随应用分发的旧版本", path: "D:/bundled/my-style" }
  ],
  migration_errors: []
};

// catalog 桩：/api/skills/catalog 返回给定数据，其余走默认空模型清单。
function catalogJsonImpl(data) {
  return async (url) => {
    if (url.startsWith("/api/skills/catalog")) return data;
    return { ok: true, default_model: null, models: [] };
  };
}

function findElementById(id) {
  return domRegistry.find((el) => el.id === id) ?? null;
}

test("「Agent 技能」分区：segmented control、技能列表与来源标签，无启停控件", async () => {
  const modal = createSettingsModalForTest({
    getCurrentProjectRoot: () => "D:/novels/demo",
    getJsonImpl: catalogJsonImpl(SKILLS_CATALOG)
  });
  await modal.openSettingsModal("skills");
  await modal.waitForSkillsCatalog();

  assert.equal(modal.getSkillsScope(), "global", "默认管理全局目录");
  const globalBtn = findElementById("skills-scope-global");
  const projectBtn = findElementById("skills-scope-project");
  assert.ok(globalBtn, "应有「全局」segmented 按钮");
  assert.ok(projectBtn, "应有「项目」segmented 按钮");
  assert.equal(projectBtn.disabled, false, "有项目时项目 segment 可用");

  const rows = modal.getSkillsRowsForTest();
  assert.equal(rows.length, 3);
  const myStyle = rows.find((r) => r.name === "my-style");
  assert.equal(myStyle.source, "global");
  assert.equal(myStyle.deletable, true, "全局来源技能在全局 scope 下可删除");
  const suspense = rows.find((r) => r.name === "suspense-chapter-end");
  assert.equal(suspense.source, "builtin");
  assert.equal(suspense.deletable, false, "内置技能不可删除");
  const projectVoice = rows.find((r) => r.name === "project-voice");
  assert.equal(projectVoice.deletable, false, "项目来源技能在全局 scope 下不可删除");

  // 无任何启停控件 / 批量启用
  assert.equal(domRegistry.some((el) => el.textContent === "启用" || el.textContent === "禁用"), false);
  assert.equal(domRegistry.some((el) => el.textContent === "全部" + "启用"), false);
});

test("「Agent 技能」分区：切到项目 scope 后只有项目来源技能可删除", async () => {
  const modal = createSettingsModalForTest({
    getCurrentProjectRoot: () => "D:/novels/demo",
    getJsonImpl: catalogJsonImpl(SKILLS_CATALOG)
  });
  await modal.openSettingsModal("skills");
  await modal.waitForSkillsCatalog();

  modal.setSkillsScopeForTest("project");
  assert.equal(modal.getSkillsScope(), "project");
  const rows = modal.getSkillsRowsForTest();
  const projectVoice = rows.find((r) => r.name === "project-voice");
  assert.equal(projectVoice.deletable, true, "项目 scope 下项目来源技能可删除");
  const myStyle = rows.find((r) => r.name === "my-style");
  assert.equal(myStyle.deletable, false, "全局来源技能在项目 scope 下不可删除");
});

test("无项目时「项目」segment 禁用，仍可浏览全局技能", async () => {
  const modal = createSettingsModalForTest({
    getCurrentProjectRoot: () => "",
    getJsonImpl: catalogJsonImpl({ ...SKILLS_CATALOG, has_project: false, project_root: null })
  });
  await modal.openSettingsModal("skills");
  await modal.waitForSkillsCatalog();

  const projectBtn = findElementById("skills-scope-project");
  assert.equal(projectBtn.disabled, true, "无项目时项目 segment 禁用");
  assert.equal(modal.getSkillsScope(), "global");
  assert.ok(modal.getSkillsRowsForTest().some((r) => r.name === "my-style"));
});

test("添加技能：选择文件夹导入；重名 409 二次确认后带 replace 重试", async () => {
  const calls = [];
  const confirms = [];
  globalThis.window.wwritingDesktop = { selectSkillFolder: async () => "D:/skills/my-style" };
  try {
    const modal = createSettingsModalForTest({
      getCurrentProjectRoot: () => "D:/novels/demo",
      getJsonImpl: catalogJsonImpl(SKILLS_CATALOG),
      confirmImpl: (message) => { confirms.push(message); return true; },
      postJsonImpl: async (url, body) => {
        calls.push({ url, body });
        if (url === "/api/skills/import" && !body.replace) {
          throw Object.assign(new Error("技能已存在: my-style"), { status: 409, code: "skill_exists" });
        }
        return { ok: true, skill: "my-style", scope: body.scope, source: body.scope };
      }
    });
    await modal.openSettingsModal("skills");
    await modal.waitForSkillsCatalog();

    const addBtn = findElementById("skills-add");
    assert.ok(addBtn, "应有「添加技能」按钮");
    addBtn._fire("click");
    const folderOpt = findElementById("skills-add-folder");
    assert.ok(folderOpt, "添加菜单应包含「从文件夹导入」");
    folderOpt._fire("click");
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(confirms.length, 1, "重名应弹一次二次确认");
    assert.ok(calls.some((c) => c.url === "/api/skills/import" && c.body.scope === "global" && !c.body.replace),
      "第一次导入不带 replace");
    assert.ok(calls.some((c) => c.url === "/api/skills/import" && c.body.scope === "global" && c.body.replace === true),
      "确认后带 replace:true 重试");
  } finally {
    delete globalThis.window.wwritingDesktop;
  }
});

test("删除技能：确认后 DELETE /api/skills/:name 并携带当前 scope", async () => {
  const calls = [];
  const confirms = [];
  const modal = createSettingsModalForTest({
    getCurrentProjectRoot: () => "D:/novels/demo",
    getJsonImpl: catalogJsonImpl(SKILLS_CATALOG),
    confirmImpl: (message) => { confirms.push(message); return true; },
    deleteJsonImpl: async (url, body) => {
      calls.push({ url, body });
      return { ok: true, removed: true };
    }
  });
  await modal.openSettingsModal("skills");
  await modal.waitForSkillsCatalog();

  const myStyle = modal.getSkillsRowsForTest().find((r) => r.name === "my-style");
  assert.ok(myStyle.del, "全局来源技能应有删除按钮");
  myStyle.del._fire("click");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(confirms.length, 1, "删除前应确认");
  assert.ok(calls.some((c) => c.url === "/api/skills/my-style" && c.body.scope === "global"),
    "DELETE 应携带当前 scope");
});

test("打开技能目录：调用 revealSkillDirectory(scope, projectRoot)，不传任意路径", async () => {
  const reveals = [];
  globalThis.window.wwritingDesktop = {
    revealSkillDirectory: async (scope, projectRoot) => { reveals.push({ scope, projectRoot }); return true; }
  };
  try {
    const modal = createSettingsModalForTest({
      getCurrentProjectRoot: () => "D:/novels/demo",
      getJsonImpl: catalogJsonImpl(SKILLS_CATALOG)
    });
    await modal.openSettingsModal("skills");
    await modal.waitForSkillsCatalog();

    const openDir = findElementById("skills-open-dir");
    assert.ok(openDir, "应有打开目录 icon button");
    openDir._fire("click");
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(reveals.length, 1);
    assert.equal(reveals[0].scope, "global");
    assert.equal(reveals[0].projectRoot, "D:/novels/demo");
  } finally {
    delete globalThis.window.wwritingDesktop;
  }
});

// ---------------------------------------------------------------------------
// Task 8：「内置写作风格」无框只读分区
// ---------------------------------------------------------------------------

const STYLE_NAMES = new Set(["balanced", "fast-readable", "psychological-literary"]);

const STYLE_SKILLS_CATALOG = {
  ok: true,
  has_project: true,
  project_root: "D:/novels/demo",
  active: [
    { name: "suspense-chapter-end", source: "builtin", description: "章节结尾悬念" },
    { name: "my-style", source: "global", description: "我的文风" },
    { name: "balanced", source: "builtin", description: "在情节、人物、描写与可读性之间保持均衡；生成、续写、改写、润色或审核中文小说正文时使用。", readonly: true, protected: true, category: "writing-style", display_name: "均衡" },
    { name: "fast-readable", source: "builtin", description: "用清楚因果、直接冲突和易扫读段落写快节奏中文网文正文。", readonly: true, protected: true, category: "writing-style", display_name: "快节奏易读" },
    { name: "psychological-literary", source: "builtin", description: "在大众网文可读性内加强人物动机、心理变化与潜台词，不写晦涩意识流。", readonly: true, protected: true, category: "writing-style", display_name: "心理文学" }
  ],
  shadowed: [
    { name: "balanced", source: "project", description: "项目伪造版本", shadow_reason: "reserved_builtin" }
  ],
  migration_errors: []
};

// catalog 桩 + 技能详情桩：/api/skills/:name 返回给定 content。
function styleCatalogJsonImpl(detailContents = {}) {
  return async (url) => {
    if (url.startsWith("/api/skills/catalog")) return STYLE_SKILLS_CATALOG;
    const match = /\/api\/skills\/([^/?]+)/u.exec(url);
    if (match && detailContents[match[1]] !== undefined) {
      return { ok: true, name: match[1], content: detailContents[match[1]] };
    }
    return { ok: true, default_model: null, models: [] };
  };
}

test("「内置写作风格」分区：三个只读分隔行，无删除/编辑/启用控件，不进入普通技能列表", async () => {
  const modal = createSettingsModalForTest({
    getCurrentProjectRoot: () => "D:/novels/demo",
    getJsonImpl: styleCatalogJsonImpl()
  });
  await modal.openSettingsModal("skills");
  await modal.waitForSkillsCatalog();

  const styleRows = modal.getBuiltinStyleRowsForTest();
  assert.equal(styleRows.length, 3, "应渲染三个内置写作风格行");
  assert.deepEqual(
    styleRows.map((r) => r.name).sort(),
    ["balanced", "fast-readable", "psychological-literary"]
  );
  for (const row of styleRows) {
    assert.equal(row.readonly, true, `${row.name} 行应标记只读`);
    assert.equal(row.hasDelete, false, `${row.name} 行不得有删除按钮`);
  }
  // 普通技能列表不得包含三个风格（避免重复展示）。
  const regular = modal.getSkillsRowsForTest();
  assert.ok(!regular.some((r) => STYLE_NAMES.has(r.name)), "风格技能不得出现在普通技能列表");
  // 三个风格行均无删除按钮（只读，无编辑/启停/覆盖控件）。
  assert.ok(styleRows.every((r) => !r.hasDelete), "风格行不得有任何删除按钮");
});

test("点击内置写作风格行：GET /api/skills/:name 并在设置详情区展开完整只读正文", async () => {
  const detailCalls = [];
  const content = "---\nname: balanced\ndescription: 均衡描述\n---\n\n# 均衡\n\n只在生成、续写、改写、润色或审核中文小说正文时使用本技能。\n\n## 写法\n\n- 心理描写落在具体刺激上。";
  const modal = createSettingsModalForTest({
    getCurrentProjectRoot: () => "D:/novels/demo",
    getJsonImpl: async (url) => {
      if (url.startsWith("/api/skills/catalog")) return STYLE_SKILLS_CATALOG;
      if (url.includes("/api/skills/balanced")) {
        detailCalls.push(url);
        return { ok: true, name: "balanced", content };
      }
      return { ok: true, default_model: null, models: [] };
    }
  });
  await modal.openSettingsModal("skills");
  await modal.waitForSkillsCatalog();

  const row = modal.getBuiltinStyleRowsForTest().find((r) => r.name === "balanced");
  assert.ok(row, "应渲染 balanced 只读行");
  row.click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(detailCalls.length, 1, "点击行应请求一次技能详情");
  assert.ok(detailCalls[0].includes("/api/skills/balanced"), "详情请求应命中 /api/skills/balanced");
  assert.ok(detailCalls[0].includes("projectRoot"), "详情请求应携带项目作用域");
  const body = domRegistry.find((el) => el.className === "spd-skill-detail-body agent-markdown");
  assert.ok(body, "详情区应渲染技能正文容器");
  assert.ok(
    body.innerHTML.includes("只在生成、续写、改写、润色或审核中文小说正文时使用本技能。"),
    "详情应展示完整只读正文"
  );
  assert.ok(!body.innerHTML.includes("name: balanced"), "详情正文不应包含 frontmatter");
});

test("保留名称 shadowed 项显示专属说明且不可删除", async () => {
  const modal = createSettingsModalForTest({
    getCurrentProjectRoot: () => "D:/novels/demo",
    getJsonImpl: styleCatalogJsonImpl()
  });
  await modal.openSettingsModal("skills");
  await modal.waitForSkillsCatalog();

  const shadowedRows = domRegistry.filter((el) => el.className === "spd-skill-row shadowed");
  const reservedRow = shadowedRows.find((r) => r.dataset.skillName === "balanced");
  assert.ok(reservedRow, "保留名称的项目同名项应出现在被覆盖区");
  assert.equal(reservedRow.dataset.shadowReason, "reserved_builtin");
  const shadowMain = reservedRow.children.find((c) => c.className === "spd-skill-main");
  const desc = shadowMain?.children.find((c) => c.className === "spd-skill-desc");
  assert.ok(desc, "shadowed 行应包含说明文本");
  assert.ok(desc.textContent.includes("保留名称"), "保留名称 shadowed 应显示专属说明");
  assert.equal(
    [...reservedRow.children].some((c) => c.className === "spd-skill-del"),
    false,
    "shadowed 行不得有删除按钮"
  );
});

// ---------------------------------------------------------------------------
// Task 12：设置技能分区无卡片行契约 + 内置风格只读展示（不破坏自定义技能管理）
// ---------------------------------------------------------------------------

test("技能分区 CSS 契约：无卡片行、详情可滚动、来源用 muted 短标签", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const styles = await fs.readFile(path.join(here, "..", "..", "src", "app-shell", "styles.css"), "utf8");
  // brief Step 6 verbatim：无框分隔行（透明、border 0、radius 0、仅下细分隔线）。
  assert.match(
    styles,
    /\.spd-skill-row\s*\{[^}]*border:\s*0[^}]*border-bottom:\s*1px\s+solid\s+var\(--line\)[^}]*border-radius:\s*0[^}]*background:\s*transparent/u,
    ".spd-skill-row 应为无框分隔行"
  );
  assert.match(
    styles,
    /\.spd-skill-detail-body\s*\{[^}]*max-height:\s*min\(52vh,\s*520px\)[^}]*overflow(?:-y)?:\s*auto/u,
    "内置风格详情应在 min(52vh, 520px) 内滚动"
  );
  // 「内置」来源使用 muted 短标签，不用 accent pill。
  assert.match(styles, /\.spd-skill-source\s*\{[^}]*color:\s*var\(--text-muted\)/u, "来源标签应为 muted 短标签");
  assert.doesNotMatch(styles, /\.spd-skill-source\s*\{[^}]*background:\s*var\(--accent-soft\)/u, "来源标签不得使用 accent pill");
  assert.doesNotMatch(styles, /\.spd-skill-row\s*\{[^}]*background:\s*var\(--surface\)/u, "技能行不得是卡片底");
});

test("内置风格行只读展示：无 toggle/edit/delete 控件；自定义技能管理能力仍存在", async () => {
  const modal = createSettingsModalForTest({
    getCurrentProjectRoot: () => "D:/novels/demo",
    getJsonImpl: styleCatalogJsonImpl()
  });
  await modal.openSettingsModal("skills");
  await modal.waitForSkillsCatalog();

  const styleRows = modal.getBuiltinStyleRowsForTest();
  assert.equal(styleRows.length, 3);
  for (const row of styleRows) {
    assert.equal(row.hasDelete, false, `${row.name} 行不得有删除按钮`);
  }
  // 只读行内部不得出现任何 toggle/edit/delete 类子控件。
  // domRegistry 会累积多次渲染的元素（replaceChildren 不清理注册表），
  // 因此只要求 ≥3 且逐个校验无子控件。
  const readonlyEls = domRegistry.filter((el) => String(el.className).includes("spd-skill-row--readonly"));
  assert.ok(readonlyEls.length >= 3, "应渲染至少三个只读风格行元素");
  for (const rowEl of readonlyEls) {
    const hasChildControls = rowEl.children.some(
      (c) => c.tagName === "BUTTON" || /spd-skill-(?:del|edit)|toggle|switch/u.test(String(c.className ?? ""))
    );
    assert.equal(hasChildControls, false, "内置风格行内不得出现任何 toggle/edit/delete 控件");
  }
  // 自定义技能管理能力仍存在：添加/打开目录入口保留。
  assert.ok(domRegistry.some((el) => el.id === "skills-add"), "「添加技能」入口应保留");
  assert.ok(domRegistry.some((el) => el.id === "skills-open-dir"), "「打开技能目录」入口应保留");
  assert.ok(domRegistry.some((el) => el.id === "skills-scope-project"), "项目 scope 切换应保留");
});

// ---------------------------------------------------------------------------
// Task 13：对话历史导出与清空确认（项目管理分区）
// ---------------------------------------------------------------------------

function tickAsync() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// 项目管理分区需要 hasProject:true 的项目 + 项目根目录（活动 Run 门禁依赖根目录）。
function dangerHarness(overrides = {}) {
  return createSettingsModalForTest({
    getDashboard: () => ({ hasProject: true, project: { archived_at: null } }),
    getCurrentProjectRoot: () => "D:/novels/demo",
    ...overrides
  });
}

// 活动 Run 门禁快照（任务空闲判定用）：running 态禁用清空按钮，idle 态放行。
const RUNNING_SNAPSHOT = {
  ok: true,
  session: {
    schema_version: 1,
    session_id: "s1",
    status: "running",
    active_run: { id: "r1", status: "running" },
    queued_inputs: [],
    last_seq: 0,
    updated_at: new Date().toISOString()
  },
  events: []
};

const IDLE_SNAPSHOT = {
  ok: true,
  session: {
    schema_version: 1,
    session_id: "s1",
    status: "idle",
    active_run: { id: "r1", status: "completed" },
    queued_inputs: [],
    last_seq: 0,
    updated_at: new Date().toISOString()
  },
  events: []
};

function snapshotJsonImpl(snapshot) {
  return async (url) => {
    if (url.startsWith("/api/agent/snapshot")) return snapshot;
    return { ok: true, default_model: null, models: [] };
  };
}

test("项目管理分区：有「导出对话历史」和「清空对话历史」按钮", async () => {
  const modal = dangerHarness();
  await modal.openSettingsModal("danger");
  await tickAsync();

  const exportBtn = findElementById("export-history-trigger");
  const clearBtn = findElementById("clear-history-trigger");
  assert.ok(exportBtn, "应有「导出对话历史」按钮");
  assert.ok(clearBtn, "应有「清空对话历史」按钮");
  assert.equal(exportBtn.textContent, "导出对话历史");
  assert.equal(clearBtn.textContent, "清空对话历史");
});

test("点击清空先出现二次确认：正文含「不可恢复」与「不影响章节、总纲、设定与 WWRITING.md」", async () => {
  const modal = dangerHarness();
  await modal.openSettingsModal("danger");
  await tickAsync();

  findElementById("clear-history-trigger")._fire("click");
  const layer = findElementById("clear-history-confirm");
  assert.ok(layer, "点击清空应出现二次确认层");

  const copy = domRegistry.find((el) => String(el.className).includes("spd-confirm-copy"));
  assert.ok(copy, "确认层应包含说明正文");
  assert.match(copy.textContent, /不可恢复/u);
  assert.match(copy.textContent, /不影响章节、总纲、设定与 WWRITING\.md/u);

  // 取消按钮可关闭确认层
  findElementById("clear-history-cancel")._fire("click");
  assert.equal(findElementById("clear-history-confirm").hidden, true, "取消后确认层应关闭");
});

test("未勾选确认时不发请求；勾选后才调用 clearAgentHistory({ confirm_irreversible: true })", async () => {
  const clearCalls = [];
  const modal = dangerHarness({
    clearAgentHistory: async (options) => {
      clearCalls.push(options);
      return { ok: true, session_id: "sess-new" };
    }
  });
  await modal.openSettingsModal("danger");
  await tickAsync();

  findElementById("clear-history-trigger")._fire("click");
  const confirmBtn = findElementById("clear-history-confirm-btn");
  const ack = findElementById("clear-history-ack");
  assert.equal(confirmBtn.disabled, true, "未勾选时确认按钮应禁用");

  confirmBtn._fire("click");
  await tickAsync();
  assert.equal(clearCalls.length, 0, "未勾选确认时不得发起清空请求");

  ack.checked = true;
  ack._fire("change");
  assert.equal(confirmBtn.disabled, false, "勾选后确认按钮应可用");
  confirmBtn._fire("click");
  await tickAsync();

  assert.deepEqual(clearCalls, [{ confirm_irreversible: true }], "应携带 confirm_irreversible: true");
});

test("确认清空成功：关闭确认层、提示创作文件未改动；导出是可选动作且无其他请求", async () => {
  const clearCalls = [];
  const exportCalls = [];
  const toasts = [];
  const postCalls = [];
  const modal = dangerHarness({
    clearAgentHistory: async (options) => {
      clearCalls.push(options);
      return { ok: true, session_id: "sess-new" };
    },
    exportAgentHistory: async () => {
      exportCalls.push(1);
      return { text: "line1\nline2\n", status: 200 };
    },
    showToast: (message, kind) => toasts.push({ message, kind }),
    postJsonImpl: async (url, body) => {
      postCalls.push({ url, body });
      return { ok: true };
    }
  });
  await modal.openSettingsModal("danger");
  await tickAsync();

  findElementById("clear-history-trigger")._fire("click");
  const ack = findElementById("clear-history-ack");
  ack.checked = true;
  ack._fire("change");
  findElementById("clear-history-confirm-btn")._fire("click");
  await tickAsync();

  assert.equal(clearCalls.length, 1);
  assert.deepEqual(clearCalls[0], { confirm_irreversible: true });
  assert.equal(findElementById("clear-history-confirm").hidden, true, "成功后确认层关闭");
  assert.equal(exportCalls.length, 0, "清空不要求先导出（导出是可选动作）");
  assert.equal(postCalls.length, 0, "清空不向任何文件/设置接口发请求");
  assert.ok(toasts.some((t) => t.message === "对话历史已清空，创作文件未改动。"), "应提示创作文件未改动");
});

test("清空失败：保留确认层和错误文案，可重试", async () => {
  let fail = true;
  const modal = dangerHarness({
    clearAgentHistory: async () => {
      if (fail) {
        fail = false;
        const error = new Error("Agent 正在运行，无法清空历史。");
        error.code = "history_busy";
        error.status = 409;
        throw error;
      }
      return { ok: true, session_id: "sess-new" };
    }
  });
  await modal.openSettingsModal("danger");
  await tickAsync();

  findElementById("clear-history-trigger")._fire("click");
  const ack = findElementById("clear-history-ack");
  ack.checked = true;
  ack._fire("change");
  findElementById("clear-history-confirm-btn")._fire("click");
  await tickAsync();

  assert.equal(findElementById("clear-history-confirm").hidden, false, "失败后确认层应保留");
  const errorEl = findElementById("clear-history-error");
  assert.equal(errorEl.hidden, false, "失败后应显示错误文案");
  assert.match(errorEl.textContent, /无法清空历史/u);

  // 勾选状态保留，可直接重试；重试成功关闭确认层
  findElementById("clear-history-confirm-btn")._fire("click");
  await tickAsync();
  assert.equal(findElementById("clear-history-confirm").hidden, true, "重试成功后确认层关闭");
});

test("清空确认打开时 ESC 只关闭确认层：不关设置弹窗、不停止 Run", async () => {
  const scrim = new MockElement("div");
  const modal = dangerHarness({ refs: { settingsScrim: scrim } });
  await modal.openSettingsModal("danger");
  await tickAsync();

  findElementById("clear-history-trigger")._fire("click");
  assert.equal(findElementById("clear-history-confirm").hidden, false, "确认层应打开");

  let stopped = false;
  let prevented = false;
  document._fire("keydown", {
    key: "Escape",
    stopImmediatePropagation: () => { stopped = true; },
    preventDefault: () => { prevented = true; }
  });

  assert.equal(findElementById("clear-history-confirm").hidden, true, "ESC 应关闭确认层");
  assert.equal(scrim.classList.contains("show"), true, "ESC 不得关闭设置弹窗");
  assert.equal(stopped, true, "ESC 应被嵌套层消费（阻断弹窗级与 Run 停止路由）");
  assert.equal(prevented, true, "ESC 应阻止默认行为");
});

test("活动 Run 时清空按钮禁用并提示先停止任务", async () => {
  const modal = dangerHarness({
    getJsonImpl: snapshotJsonImpl(RUNNING_SNAPSHOT)
  });
  await modal.openSettingsModal("danger");
  await tickAsync();

  const clearBtn = findElementById("clear-history-trigger");
  assert.equal(clearBtn.disabled, true, "活动 Run 时清空按钮应禁用");
  const hint = findElementById("clear-history-run-hint");
  assert.equal(hint.hidden, false, "活动 Run 时应显示提示");
  assert.match(hint.textContent, /先停止任务/u);
});

test("任务空闲时清空按钮可用且无先停止任务提示", async () => {
  const modal = dangerHarness({
    getJsonImpl: snapshotJsonImpl(IDLE_SNAPSHOT)
  });
  await modal.openSettingsModal("danger");
  await tickAsync();

  const clearBtn = findElementById("clear-history-trigger");
  assert.equal(clearBtn.disabled, false, "空闲时清空按钮应可用");
  assert.equal(findElementById("clear-history-run-hint").hidden, true, "空闲时不显示先停止任务提示");
});

test("导出对话历史：调用注入的 exportAgentHistory 并提示已导出", async () => {
  const exportCalls = [];
  const toasts = [];
  const modal = dangerHarness({
    exportAgentHistory: async () => {
      exportCalls.push(1);
      return { text: "line1\nline2\n", status: 200 };
    },
    showToast: (message, kind) => toasts.push({ message, kind })
  });
  await modal.openSettingsModal("danger");
  await tickAsync();

  findElementById("export-history-trigger")._fire("click");
  await tickAsync();

  assert.equal(exportCalls.length, 1, "点击导出应调用 exportAgentHistory");
  assert.ok(toasts.some((t) => t.message === "对话历史已导出。"), "导出成功应提示");
});

// ---------------------------------------------------------------------------
// Task 10：设置页「已归档对话」分类（项目管理分区）
// 数据源 = dashboard.sessions（含归档会话）；分类仅在有归档会话时渲染，
// 按归档时间倒序；行 = 标题 + 归档时间 + 「恢复」/「永久删除」。
// ---------------------------------------------------------------------------

const ARCHIVED_SESSIONS = [
  { session_id: "active-1", title: "当前对话", archived_at: null, updated_at: "2026-08-09T00:00:00.000Z" },
  { session_id: "s1", title: "主线大纲讨论", archived_at: "2026-07-01T08:00:00.000Z", updated_at: "2026-07-01T08:00:00.000Z" },
  { session_id: "s2", title: "角色设定头脑风暴", archived_at: "2026-08-02T10:00:00.000Z", updated_at: "2026-08-02T10:00:00.000Z" }
];

function archivedDashboard(sessions) {
  return { hasProject: true, project: { archived_at: null }, sessions, active_session_id: "active-1" };
}

function archivedRowEls() {
  return domRegistry.filter((el) => el.className === "spd-archived-row");
}

test("「已归档对话」分类：列出归档会话（标题 + 归档时间），按归档时间倒序，未归档不出现", async () => {
  const modal = createSettingsModalForTest({
    getDashboard: () => archivedDashboard(ARCHIVED_SESSIONS),
    getCurrentProjectRoot: () => "D:/novels/demo"
  });
  await modal.openSettingsModal("danger");
  await tickAsync();

  assert.ok(
    domRegistry.some((el) => el.className === "spd-section" && el.textContent === "已归档对话"),
    "存在归档会话时应渲染「已归档对话」分类标题"
  );
  const rows = archivedRowEls();
  assert.equal(rows.length, 2, "只列出归档会话，未归档会话不出现");
  assert.deepEqual(rows.map((r) => r.dataset.sessionId), ["s2", "s1"], "分类内按归档时间倒序");

  // 条目标题 + 归档时间（行内主区块 = 标题行 + 时间行）。
  const s2Main = rows[0].children.find((c) => c.className === "spd-archived-main");
  assert.ok(s2Main, "归档行应包含标题/时间主区块");
  const s2Title = s2Main.children.find((c) => c.className === "spd-archived-title");
  assert.equal(s2Title.textContent, "角色设定头脑风暴");
  const s2When = s2Main.children.find((c) => c.className === "spd-archived-when");
  assert.match(s2When.textContent, /归档于 \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/, "应展示归档时间");

  assert.equal(rows.some((r) => r.dataset.sessionId === "active-1"), false, "未归档会话不得出现在分类里");
});

test("无归档会话时「已归档对话」分类不渲染", async () => {
  const modal = createSettingsModalForTest({
    getDashboard: () => archivedDashboard([{ session_id: "active-1", title: "当前对话", archived_at: null }]),
    getCurrentProjectRoot: () => "D:/novels/demo"
  });
  await modal.openSettingsModal("danger");
  await tickAsync();

  assert.equal(archivedRowEls().length, 0, "无归档会话时不得渲染归档行");
  assert.equal(
    domRegistry.some((el) => el.className === "spd-section" && el.textContent === "已归档对话"),
    false,
    "无归档会话时不得显示分类标题"
  );
});

test("点击恢复：调用注入 restoreSession 并提示已恢复对话", async () => {
  const restores = [];
  const toasts = [];
  const modal = createSettingsModalForTest({
    getDashboard: () => archivedDashboard(ARCHIVED_SESSIONS),
    getCurrentProjectRoot: () => "D:/novels/demo",
    restoreSession: async (sessionId) => {
      restores.push(sessionId);
      return { ok: true };
    },
    loadDashboard: async () => {},
    showToast: (message, kind) => toasts.push({ message, kind })
  });
  await modal.openSettingsModal("danger");
  await tickAsync();

  const restoreBtn = findElementById("archived-restore-s1");
  assert.ok(restoreBtn, "归档行应有「恢复」按钮");
  restoreBtn._fire("click");
  await tickAsync();

  assert.deepEqual(restores, ["s1"], "点击恢复应调用注入的 restoreSession");
  assert.ok(toasts.some((t) => t.message === "已恢复对话 主线大纲讨论"), "恢复成功应提示");
});

test("永久删除：确认文案固定，确认后调用注入 deleteSession", async () => {
  const deletes = [];
  const confirms = [];
  const toasts = [];
  const modal = createSettingsModalForTest({
    getDashboard: () => archivedDashboard(ARCHIVED_SESSIONS),
    getCurrentProjectRoot: () => "D:/novels/demo",
    deleteSession: async (sessionId) => {
      deletes.push(sessionId);
      return { ok: true };
    },
    loadDashboard: async () => {},
    showToast: (message, kind) => toasts.push({ message, kind }),
    confirmImpl: (message) => {
      confirms.push(message);
      return true;
    }
  });
  await modal.openSettingsModal("danger");
  await tickAsync();

  const deleteBtn = findElementById("archived-delete-s1");
  assert.ok(deleteBtn, "归档行应有「永久删除」按钮");
  deleteBtn._fire("click");
  await tickAsync();

  assert.deepEqual(
    confirms,
    ["永久删除后不可恢复，该对话的全部历史将被移除。确认？"],
    "永久删除必须触发固定文案的二次确认"
  );
  assert.deepEqual(deletes, ["s1"], "确认后应调用注入的 deleteSession");
  assert.ok(toasts.some((t) => t.message === "已永久删除对话 主线大纲讨论"), "删除成功应提示");
});

test("永久删除：取消确认则不调用 deleteSession", async () => {
  const deletes = [];
  const modal = createSettingsModalForTest({
    getDashboard: () => archivedDashboard(ARCHIVED_SESSIONS),
    getCurrentProjectRoot: () => "D:/novels/demo",
    deleteSession: async (sessionId) => {
      deletes.push(sessionId);
      return { ok: true };
    },
    confirmImpl: () => false
  });
  await modal.openSettingsModal("danger");
  await tickAsync();

  findElementById("archived-delete-s1")._fire("click");
  await tickAsync();

  assert.deepEqual(deletes, [], "取消确认后不得调用 deleteSession");
});

test("恢复失败：提示错误 toast，不刷新分区", async () => {
  const toasts = [];
  let loadCalls = 0;
  const modal = createSettingsModalForTest({
    getDashboard: () => archivedDashboard(ARCHIVED_SESSIONS),
    getCurrentProjectRoot: () => "D:/novels/demo",
    restoreSession: async () => {
      throw new Error("恢复失败：会话不存在。");
    },
    loadDashboard: async () => { loadCalls += 1; },
    showToast: (message, kind) => toasts.push({ message, kind })
  });
  await modal.openSettingsModal("danger");
  await tickAsync();

  findElementById("archived-restore-s1")._fire("click");
  await tickAsync();

  assert.ok(
    toasts.some((t) => t.kind === "error" && t.message === "恢复失败：会话不存在。"),
    "恢复失败应提示服务端/错误文案"
  );
  assert.equal(loadCalls, 0, "恢复失败不得重拉 dashboard");
});

test("永久删除成功：列表刷新，归档行消失", async () => {
  let currentSessions = ARCHIVED_SESSIONS.slice();
  const modal = createSettingsModalForTest({
    getDashboard: () => archivedDashboard(currentSessions),
    getCurrentProjectRoot: () => "D:/novels/demo",
    deleteSession: async (sessionId) => {
      currentSessions = currentSessions.filter((s) => s.session_id !== sessionId);
      return { ok: true };
    },
    loadDashboard: async () => {},
    showToast: () => {},
    confirmImpl: () => true
  });
  await modal.openSettingsModal("danger");
  await tickAsync();

  findElementById("archived-delete-s1")._fire("click");
  await tickAsync();

  // 重渲后的当前挂载列表只含剩余归档会话（domRegistry 累积旧元素，用挂载树断言）。
  const detail = modal.getSettingsDetailForTest();
  const list = detail.children.find((el) => el.id === "archived-sessions-list");
  assert.ok(list, "仍有归档会话时分类应保留");
  assert.deepEqual(
    list.children.map((row) => row.dataset.sessionId),
    ["s2"],
    "删除 s1 后只剩 s2"
  );
});

test("恢复请求 in-flight：按钮禁用、完成后复位", async () => {
  let resolveRestore;
  const restorePromise = new Promise((resolve) => { resolveRestore = resolve; });
  const modal = createSettingsModalForTest({
    getDashboard: () => archivedDashboard(ARCHIVED_SESSIONS),
    getCurrentProjectRoot: () => "D:/novels/demo",
    restoreSession: () => restorePromise,
    loadDashboard: async () => {},
    showToast: () => {}
  });
  await modal.openSettingsModal("danger");
  await tickAsync();

  const restoreBtn = findElementById("archived-restore-s1");
  restoreBtn._fire("click");
  assert.equal(restoreBtn.disabled, true, "请求进行中恢复按钮应禁用（防双击双调）");

  resolveRestore({ ok: true });
  await tickAsync();
  await tickAsync();
  assert.equal(restoreBtn.disabled, false, "请求完成后按钮应复位");
});

test("恢复 in-flight 期间切到其他分区：完成时不重渲当前分区", async () => {
  let resolveRestore;
  const restorePromise = new Promise((resolve) => { resolveRestore = resolve; });
  const modal = createSettingsModalForTest({
    getDashboard: () => archivedDashboard(ARCHIVED_SESSIONS),
    getCurrentProjectRoot: () => "D:/novels/demo",
    restoreSession: () => restorePromise,
    loadDashboard: async () => {},
    showToast: () => {}
  });
  await modal.openSettingsModal("danger");
  await tickAsync();

  findElementById("archived-restore-s1")._fire("click");
  await tickAsync(); // restore 请求 in-flight

  // 用户切到模型分区（Task 8 过渡期：只读占位，不再渲染模型表单）。
  await modal.openSettingsModal("model");
  resolveRestore({ ok: true });
  await tickAsync();
  await tickAsync();

  // 完成时不得把当前模型分区整体替换成项目管理内容（占位内容不丢）。
  // 用 detail 直接层 className 区分：model 分区有迁移提示 spd-hint，danger 分区有
  // spd-archived-list（子元素的 id 在更深层，不适合直接层断言）。
  const detail = modal.getSettingsDetailForTest();
  const classes = detail.children.map((el) => String(el.className ?? ""));
  assert.ok(classes.includes("spd-hint"), "模型分区占位内容应保留");
  assert.equal(classes.includes("spd-archived-list"), false, "不得重渲为项目管理分区");
});
