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
      toggle(name, force) {
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
  replaceChildren(...nodes) { this.children.length = 0; this.children.push(...nodes); }

  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }

  /** Fire all handlers registered for `type`, forwarding extra args. */
  _fire(type, ...args) {
    for (const fn of this._listeners.get(type) ?? []) fn(...args);
  }

  focus() {}
  closest() { return null; }
}

// Browser-ish globals so vendor/gsap (UMD) and motion-runtime can load in Node.
globalThis.self = globalThis;
globalThis.window = globalThis.window ?? {};
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
  const refs = {
    settingsSearch: new MockElement("input"),
    settingsSave: new MockElement("button"),
    settingsScrim: new MockElement("div"),
    settingsDetail: new MockElement("div"),
    settingsProviderList: new MockElement("div")
  };
  const ctx = {
    refs,
    getDashboard: () => ({}),
    getCurrentProjectRoot: () => "",
    loadDashboard: async () => {},
    showToast: () => {},
    getLastFocused: () => null,
    setLastFocused: () => {},
    ...overrides
  };
  return createSettingsModal(ctx, {
    getJsonImpl: overrides.getJsonImpl ?? (async () => ({ ok: true, default_model: null, models: [] })),
    postJsonImpl: overrides.postJsonImpl ?? (async () => ({ ok: true }))
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

test("有项目时保存模型：模型走全局路由，项目专属设置仍走项目路由", async () => {
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
  assert.equal(urls.includes("/api/settings/update"), true);
  // 模型信息不能再混在项目设置请求里
  const projectCall = calls.find((c) => c.url === "/api/settings/update");
  assert.equal(projectCall.body.active_model, undefined);
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

  // 第二次：校验通过，完整走完保存流程（含项目设置 update）
  await modal.saveSettingsForTest();
  assert.equal(calls.filter((c) => c.url === "/api/settings/model-profile").length, 2);
  assert.equal(calls.filter((c) => c.url === "/api/settings/update").length, 1);
});
