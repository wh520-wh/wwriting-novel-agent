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
    activeElement: null
  };
}
installDomMock();

// settings-modal.js pulls in motion-runtime (and vendor/gsap), so import it
// dynamically after the browser-ish globals are in place.
const { createSettingsModal } = await import("../../src/app-shell/settings-modal.js");

// ---------------------------------------------------------------------------
// Modal harness
// ---------------------------------------------------------------------------

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
    confirmImpl: overrides.confirmImpl ?? (() => true)
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
// Model save without a project (Task 9: 模型配置与项目解耦)
// ---------------------------------------------------------------------------

test("没有项目时保存模型：走全局路由，不再提示先新建小说", async () => {
  const calls = [];
  const toasts = [];
  const modal = createSettingsModalForTest({
    getCurrentProjectRoot: () => "",           // 关键：没有打开任何项目
    showToast: (message, kind) => toasts.push({ message, kind }),
    postJsonImpl: async (url, body) => {
      calls.push({ url, body });
      return { ok: true, model_profile: { display: "DeepSeek 官方 / deepseek-chat" }, models: [] };
    }
  });
  await modal.openSettingsModal();
  modal.setModelFieldsForTest({
    model_name: "deepseek-chat",
    base_url: "https://api.deepseek.com",
    api_key: "sk-test-1234",
    api_key_env: "DEEPSEEK_API_KEY"
  });
  await modal.saveSettingsForTest();

  assert.equal(calls.some((c) => c.url === "/api/settings/model-profile"), true);
  assert.equal(calls.some((c) => c.url === "/api/settings/update"), false);
  assert.equal(toasts.some((t) => /先新建或打开一部小说/.test(t.message)), false);
});

test("有项目时保存模型：只更新全局模型，不暗改项目级专家配置", async () => {
  const calls = [];
  const modal = createSettingsModalForTest({
    getCurrentProjectRoot: () => "D:/novels/demo",
    postJsonImpl: async (url, body) => {
      calls.push({ url, body });
      return { ok: true, model_profile: { display: "DeepSeek 官方 / deepseek-chat" }, models: [] };
    }
  });
  await modal.openSettingsModal();
  modal.setModelFieldsForTest({
    model_name: "deepseek-chat",
    base_url: "https://api.deepseek.com",
    api_key: "sk-test-1234",
    api_key_env: "DEEPSEEK_API_KEY"
  });
  await modal.saveSettingsForTest();

  const urls = calls.map((c) => c.url);
  assert.equal(urls.includes("/api/settings/model-profile"), true);
  assert.equal(urls.includes("/api/settings/update"), false);
});

test("没有项目时表单显示全局默认模型，而不是预设默认值", async () => {
  const modal = createSettingsModalForTest({
    getCurrentProjectRoot: () => "",
    getJsonImpl: async () => ({
      ok: true,
      default_model: {
        id: "deepseek-chat",
        provider: "openai-compatible",
        model_name: "deepseek-chat",
        base_url: "https://api.deepseek.com",
        api_key_env: "DEEPSEEK_API_KEY",
        display: "DeepSeek 官方 / deepseek-chat"
      },
      models: []
    })
  });
  await modal.openSettingsModal();

  const modelInput = findElementByLabel("模型");
  assert.equal(modelInput.value, "deepseek-chat");
  const baseUrlInput = findElementByLabel("API 地址 · 基础 URL");
  assert.equal(baseUrlInput.value, "https://api.deepseek.com");
});

test("没有项目时测试连接不再拦截", async () => {
  const calls = [];
  const toasts = [];
  const modal = createSettingsModalForTest({
    getCurrentProjectRoot: () => "",
    showToast: (message, kind) => toasts.push({ message, kind }),
    postJsonImpl: async (url, body) => {
      calls.push({ url, body });
      return { ok: true, latency_ms: 42 };
    }
  });
  await modal.openSettingsModal();
  modal.setModelFieldsForTest({
    model_name: "deepseek-chat",
    base_url: "https://api.deepseek.com",
    api_key: "sk-test-1234",
    api_key_env: "DEEPSEEK_API_KEY"
  });
  const testBtn = domRegistry.find((el) => el.id === "settings-test-connection");
  assert.ok(testBtn, "设置面板应渲染「测试连接」按钮");
  testBtn._fire("click");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls.some((c) => c.url === "/api/settings/test-connection"), true);
  assert.equal(toasts.some((t) => /先新建或打开一部小说/.test(t.message)), false);
});

test("模型字段校验失败时逐项标红，且不发送项目设置请求", async () => {
  const calls = [];
  const toasts = [];
  const modal = createSettingsModalForTest({
    getCurrentProjectRoot: () => "D:/novels/demo",
    showToast: (message, kind) => toasts.push({ message, kind }),
    postJsonImpl: async (url, body) => {
      calls.push({ url, body });
      if (url === "/api/settings/model-profile") {
        // 服务端对 ModelConfigValidationError 回 400 + fields，postJson 抛错携带 error.fields
        throw Object.assign(new Error("模型信息不完整，请检查标红的字段。"), {
          fields: { model_name: "请输入模型名称" }
        });
      }
      return { ok: true };
    }
  });
  await modal.openSettingsModal();
  modal.setModelFieldsForTest({
    model_name: "",
    base_url: "https://api.deepseek.com",
    api_key: "sk-test-1234",
    api_key_env: "DEEPSEEK_API_KEY"
  });
  await modal.saveSettingsForTest();

  // 校验失败：不发项目设置请求
  assert.equal(calls.some((c) => c.url === "/api/settings/update"), false);
  // 只有模型名字段标红：错误提示可见且带服务端文案，其余字段隐藏
  const visibleErrors = domRegistry.filter((el) => el.className === "spd-field-error" && el.hidden === false);
  assert.deepEqual(visibleErrors.map((el) => el.textContent), ["请输入模型名称"]);
  // runSave 兜底 toast 展示服务端原文错误
  assert.equal(toasts.some((t) => t.message === "模型信息不完整，请检查标红的字段。"), true);
});

test("模型字段校验失败后再保存：成功路径仍正常工作", async () => {
  const calls = [];
  let failModelProfile = true;
  const modal = createSettingsModalForTest({
    getCurrentProjectRoot: () => "D:/novels/demo",
    postJsonImpl: async (url, body) => {
      calls.push({ url, body });
      if (url === "/api/settings/model-profile" && failModelProfile) {
        failModelProfile = false;
        throw Object.assign(new Error("模型信息不完整，请检查标红的字段。"), {
          fields: { model_name: "请输入模型名称" }
        });
      }
      return { ok: true, model_profile: { display: "DeepSeek 官方 / deepseek-chat" }, models: [] };
    }
  });
  await modal.openSettingsModal();
  modal.setModelFieldsForTest({
    model_name: "deepseek-chat",
    base_url: "https://api.deepseek.com",
    api_key: "sk-test-1234",
    api_key_env: "DEEPSEEK_API_KEY"
  });

  // 第一次：校验失败，只发 model-profile，不发 update
  await modal.saveSettingsForTest();
  assert.equal(calls.filter((c) => c.url === "/api/settings/model-profile").length, 1);
  assert.equal(calls.some((c) => c.url === "/api/settings/update"), false);

  // 第二次：校验通过，只完成模型保存，不产生隐式项目设置写入
  await modal.saveSettingsForTest();
  assert.equal(calls.filter((c) => c.url === "/api/settings/model-profile").length, 2);
  assert.equal(calls.filter((c) => c.url === "/api/settings/update").length, 0);
});

// ---------------------------------------------------------------------------
// 已配置模型清单（Task 10: 选用 / 删除已配模型）
// ---------------------------------------------------------------------------

test("设置里显示已配好的模型，可以点击选用或删除", async () => {
  const calls = [];
  // 有状态的桩：选用后全局默认模型随之变化（与服务端行为一致）。
  let models = [
    { id: "deepseek-chat", model_name: "deepseek-chat", display: "DeepSeek / deepseek-chat",
      base_url: "https://api.deepseek.com", api_key_env: "DEEPSEEK_API_KEY" },
    { id: "mimo-v1", model_name: "mimo-v1", display: "MiMo / mimo-v1",
      base_url: "https://api.mimo.example", api_key_env: "XIAOMI_MIMO_API_KEY" }
  ];
  let defaultModel = { ...models[0] };
  const modal = createSettingsModalForTest({
    getCurrentProjectRoot: () => "",
    // 清单来自 GET /api/settings/models（fetchGlobalModels 走 getJsonImpl）。
    getJsonImpl: async () => ({ ok: true, default_model: defaultModel, models }),
    postJsonImpl: async (url, body) => {
      calls.push({ url, body });
      if (url === "/api/settings/model-select") {
        defaultModel = models.find((m) => m.id === body.model_id) ?? null;
      }
      if (url === "/api/settings/model-remove") {
        models = models.filter((m) => m.id !== body.model_id);
        if (defaultModel?.id === body.model_id) defaultModel = null;
      }
      return { ok: true, models: [], default_model: null };
    }
  });
  await modal.openSettingsModal();

  const savedItems = modal.getSavedModelItems();
  assert.equal(savedItems.length, 2);
  assert.equal(savedItems.some((item) => item.modelName === "deepseek-chat"), true);
  assert.equal(savedItems.some((item) => item.modelName === "mimo-v1"), true);

  await modal.clickSavedModel("mimo-v1");
  assert.equal(calls.some((c) => c.url === "/api/settings/model-select" && c.body.model_id === "mimo-v1"), true);
  assert.equal(modal.getModelFieldValue("model_name"), "mimo-v1");

  await modal.deleteSavedModel("mimo-v1");
  assert.equal(calls.some((c) => c.url === "/api/settings/model-remove" && c.body.model_id === "mimo-v1"), true);
  // 删除当前展示的模型后，右侧表单同步刷新回预设默认值，不残留已删模型的字段。
  assert.equal(modal.getModelFieldValue("model_name"), "mimo-v2.5-pro");
});

test("模型设置只显示连接所需字段，不渲染价格、预算和运行参数", async () => {
  const modal = createSettingsModalForTest();
  await modal.openSettingsModal();

  for (const label of ["模型", "API 地址 · 基础 URL", "API Key"]) {
    assert.ok(findElementByLabel(label), `应保留 ${label}`);
  }
  for (const label of [
    "输入价（元/百万 token）",
    "输出价（元/百万 token）",
    "缓存命中价（元/百万 token，可选）",
    "模型调用上限",
    "成本上限（元，需先配置价格）",
    "token 总量上限",
    "写作温度（0–2，可选，留空用厂商默认）",
    "联网搜索/抓取权限",
    "密钥环境变量名（不是密钥本身）"
  ]) {
    assert.equal(findElementByLabel(label), null, `普通用户界面不应暴露 ${label}`);
  }
});

// ---------------------------------------------------------------------------
// 保存反馈（Task 10：成功不弹 Toast，保存按钮先显示「已保存」再关闭弹窗）
// ---------------------------------------------------------------------------

test("保存成功后按钮先显示「已保存」，不弹成功 Toast；短暂停留后弹窗关闭", async () => {
  const calls = [];
  const toasts = [];
  const saveButton = new MockElement("button");
  const scrim = new MockElement("div");
  const modal = createSettingsModalForTest({
    refs: { settingsSave: saveButton, settingsScrim: scrim },
    getCurrentProjectRoot: () => "D:/novels/demo",
    showToast: (message, kind) => toasts.push({ message, kind }),
    postJsonImpl: async (url, body) => {
      calls.push({ url, body });
      return { ok: true };
    }
  });
  await modal.openSettingsModal();
  modal.setModelFieldsForTest({
    model_name: "deepseek-chat",
    base_url: "https://api.deepseek.com",
    api_key: "sk-test-1234",
    api_key_env: "DEEPSEEK_API_KEY"
  });
  await modal.saveSettingsForTest();

  // 保存完成后、关闭定时器触发前：按钮显示「已保存」，弹窗仍在，且无成功 Toast。
  assert.equal(saveButton.textContent, "已保存", "保存成功后按钮应显示「已保存」");
  assert.equal(scrim.classList.contains("show"), true, "「已保存」可见期间弹窗尚未关闭");
  assert.equal(toasts.some((t) => t.kind === "success"), false, "保存成功不得弹成功 Toast");

  // 等待关闭定时器（700ms + 余量）：弹窗关闭、按钮文案恢复为「保存设置」。
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(scrim.classList.contains("show"), false, "短暂停留后弹窗应关闭");
  assert.equal(saveButton.textContent, "保存设置", "关闭后按钮文案应恢复为「保存设置」");
});

test("连续两次保存：旧关闭定时器失效，不关闭新弹窗", async () => {
  let failNextSave = false;
  const saveButton = new MockElement("button");
  const scrim = new MockElement("div");
  const modal = createSettingsModalForTest({
    refs: { settingsSave: saveButton, settingsScrim: scrim },
    getCurrentProjectRoot: () => "",
    postJsonImpl: async (url, body) => {
      if (url === "/api/settings/model-profile" && failNextSave) {
        throw Object.assign(new Error("模型信息不完整，请检查标红的字段。"), {
          fields: { model_name: "请输入模型名称" }
        });
      }
      return { ok: true };
    }
  });
  await modal.openSettingsModal();
  modal.setModelFieldsForTest({
    model_name: "deepseek-chat",
    base_url: "https://api.deepseek.com",
    api_key: "sk-test-1234",
    api_key_env: "DEEPSEEK_API_KEY"
  });

  // 第一次保存成功：调度 700ms 后关闭弹窗的定时器（seq=1）。
  await modal.saveSettingsForTest();
  assert.equal(saveButton.textContent, "已保存", "第一次保存成功后按钮应显示「已保存」");
  assert.equal(scrim.classList.contains("show"), true, "「已保存」展示期间弹窗仍在");
  // 第二次保存立刻失败（seq=2）：前一次的关闭定时器必须失效。
  failNextSave = true;
  await modal.saveSettingsForTest();
  assert.equal(saveButton.textContent, "保存设置", "失败后按钮文案应立即恢复为规范标签");
  // 等过前一次定时器窗口（700ms + 余量）。按钮文案在此场景无法区分守卫是否存在
  // （旧定时器恢复的正是同一文案）；唯一可区分的副作用是 closeSettingsModal 移除
  // scrim 的 show——必须断言它来锁住该回归。
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(saveButton.textContent, "保存设置", "旧关闭定时器不得覆盖按钮文案");
  assert.equal(scrim.classList.contains("show"), true, "旧关闭定时器不得关闭弹窗（失败后弹窗应保持打开供重试）");
});

// ---------------------------------------------------------------------------
// 模型切换确认（计划 UI Copy Audit 保留项，Task 11 最终审查修复）：
// 仅当「模型确有变更」且「任务进行中（active Run 或排队输入）」时弹确认，
// 取消则不保存；API Key/环境变量变更不算模型变更。
// ---------------------------------------------------------------------------

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

test("模型变更且任务进行中：保存前弹确认（精确文案），确认后保存", async () => {
  const calls = [];
  const toasts = [];
  let confirmMessage = null;
  const modal = createSettingsModalForTest({
    getCurrentProjectRoot: () => "D:/novels/demo",
    getJsonImpl: snapshotJsonImpl(RUNNING_SNAPSHOT),
    postJsonImpl: async (url, body) => {
      calls.push({ url, body });
      return { ok: true, model_profile: { display: "t" }, models: [] };
    },
    showToast: (message, kind) => toasts.push({ message, kind }),
    confirmImpl: (message) => {
      confirmMessage = message;
      return true;
    }
  });
  await modal.openSettingsModal();
  modal.setModelFieldsForTest({
    model_name: "deepseek-chat",
    base_url: "https://api.deepseek.com",
    api_key: "sk-test-1234",
    api_key_env: "DEEPSEEK_API_KEY"
  });
  await modal.saveSettingsForTest();

  assert.equal(confirmMessage, "切换后将由新模型继续，本章文风可能变化。继续？");
  assert.equal(calls.some((c) => c.url === "/api/settings/model-profile"), true, "确认后应保存模型");
});

test("模型变更且任务进行中：取消确认则不保存", async () => {
  const calls = [];
  const toasts = [];
  const modal = createSettingsModalForTest({
    getCurrentProjectRoot: () => "D:/novels/demo",
    getJsonImpl: snapshotJsonImpl(RUNNING_SNAPSHOT),
    postJsonImpl: async (url, body) => {
      calls.push({ url, body });
      return { ok: true, model_profile: { display: "t" }, models: [] };
    },
    showToast: (message, kind) => toasts.push({ message, kind }),
    confirmImpl: () => false
  });
  await modal.openSettingsModal();
  modal.setModelFieldsForTest({
    model_name: "deepseek-chat",
    base_url: "https://api.deepseek.com",
    api_key: "sk-test-1234",
    api_key_env: "DEEPSEEK_API_KEY"
  });
  await modal.saveSettingsForTest();

  assert.equal(calls.some((c) => c.url === "/api/settings/model-profile"), false, "取消后不得保存模型");
  assert.equal(calls.some((c) => c.url === "/api/settings/update"), false, "取消后不得发项目设置");
  assert.equal(toasts.some((t) => /已取消保存/.test(t.message)), true, "取消应给出提示");
});

test("模型未变更：任务进行中也不弹确认，直接保存", async () => {
  const calls = [];
  let confirmCalls = 0;
  const modal = createSettingsModalForTest({
    getDashboard: () => ({
      project: {
        active_model: {
          provider: "openai-compatible",
          model_name: "deepseek-chat",
          base_url: "https://api.deepseek.com",
          api_key_env: "DEEPSEEK_API_KEY"
        }
      }
    }),
    getCurrentProjectRoot: () => "D:/novels/demo",
    getJsonImpl: snapshotJsonImpl(RUNNING_SNAPSHOT),
    postJsonImpl: async (url, body) => {
      calls.push({ url, body });
      return { ok: true, model_profile: { display: "t" }, models: [] };
    },
    confirmImpl: () => {
      confirmCalls += 1;
      return true;
    }
  });
  await modal.openSettingsModal();
  modal.setModelFieldsForTest({
    model_name: "deepseek-chat",
    base_url: "https://api.deepseek.com",
    api_key: "sk-test-1234",
    api_key_env: "DEEPSEEK_API_KEY"
  });
  await modal.saveSettingsForTest();

  assert.equal(confirmCalls, 0, "模型未变更不得弹确认");
  assert.equal(calls.some((c) => c.url === "/api/settings/model-profile"), true, "直接保存");
});

test("任务空闲时模型变更：不弹确认，直接保存", async () => {
  const calls = [];
  let confirmCalls = 0;
  const modal = createSettingsModalForTest({
    getCurrentProjectRoot: () => "D:/novels/demo",
    getJsonImpl: snapshotJsonImpl(IDLE_SNAPSHOT),
    postJsonImpl: async (url, body) => {
      calls.push({ url, body });
      return { ok: true, model_profile: { display: "t" }, models: [] };
    },
    confirmImpl: () => {
      confirmCalls += 1;
      return true;
    }
  });
  await modal.openSettingsModal();
  modal.setModelFieldsForTest({
    model_name: "deepseek-chat",
    base_url: "https://api.deepseek.com",
    api_key: "sk-test-1234",
    api_key_env: "DEEPSEEK_API_KEY"
  });
  await modal.saveSettingsForTest();

  assert.equal(confirmCalls, 0, "空闲任务不得弹确认");
  assert.equal(calls.some((c) => c.url === "/api/settings/model-profile"), true, "直接保存");
});

test("排队输入非空也算任务进行中：模型变更需确认", async () => {
  const calls = [];
  let confirmCalls = 0;
  const queuedSnapshot = {
    ok: true,
    session: {
      schema_version: 1,
      session_id: "s1",
      status: "running",
      active_run: { id: "r1", status: "running" },
      queued_inputs: [{ id: "q1", text: "排队任务", status: "queued" }],
      last_seq: 0,
      updated_at: new Date().toISOString()
    },
    events: []
  };
  const modal = createSettingsModalForTest({
    getCurrentProjectRoot: () => "D:/novels/demo",
    getJsonImpl: snapshotJsonImpl(queuedSnapshot),
    postJsonImpl: async (url, body) => {
      calls.push({ url, body });
      return { ok: true, model_profile: { display: "t" }, models: [] };
    },
    confirmImpl: () => {
      confirmCalls += 1;
      return true;
    }
  });
  await modal.openSettingsModal();
  modal.setModelFieldsForTest({
    model_name: "deepseek-chat",
    base_url: "https://api.deepseek.com",
    api_key: "sk-test-1234",
    api_key_env: "DEEPSEEK_API_KEY"
  });
  await modal.saveSettingsForTest();

  assert.equal(confirmCalls, 1, "排队输入存在时应弹确认");
  assert.equal(calls.some((c) => c.url === "/api/settings/model-profile"), true, "确认后保存");
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
