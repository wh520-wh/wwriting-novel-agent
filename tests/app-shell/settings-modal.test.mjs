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
    postJsonImpl: overrides.postJsonImpl ?? (async () => ({ ok: true }))
  });
}

function findElementByLabel(label) {
  return domRegistry.find((el) => el.getAttribute("aria-label") === label) ?? null;
}

// 重渲染会新建一组表单元素，findElementByLabel 只找到第一组（旧元素）；
// 需要断言「最新渲染」时用这个反向查找（registry 末尾是最新元素）。
function findLatestElementByLabel(label) {
  return [...domRegistry].reverse().find((el) => el.getAttribute("aria-label") === label) ?? null;
}

// 输入/输出/缓存命中价三连断言。期望值统一按字符串比较，
// 兼容 mock 保留原始类型（真实 DOM 的 input.value 恒为字符串）。
function assertOfficialPriceFields(expected, find = findElementByLabel) {
  assert.equal(String(find("输入价（元/百万 token）").value), String(expected.input));
  assert.equal(String(find("输出价（元/百万 token）").value), String(expected.output));
  assert.equal(String(find("缓存命中价（元/百万 token，可选）").value), String(expected.cache));
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

// ---------------------------------------------------------------------------
// 选模型自动带出官方价（shared/official-pricing.mjs 预配置）
// ---------------------------------------------------------------------------

test("输入官方收录的模型名时，价格框自动带出官方价；切模型时官方价彼此替换", async () => {
  const modal = createSettingsModalForTest();
  await modal.openSettingsModal();

  modal.setModelFieldsForTest({ model_name: "deepseek-v4-flash" });
  findElementByLabel("模型")._fire("input");
  assertOfficialPriceFields({ input: 1, output: 2, cache: 0.02 });

  // 切换模型名（datalist 选择触发 change）：带出新模型官方价，不留旧模型的价格。
  modal.setModelFieldsForTest({ model_name: "deepseek-v4-pro" });
  findElementByLabel("模型")._fire("change");
  assertOfficialPriceFields({ input: 3, output: 6, cache: 0.025 });
});

test("改成未收录官方价的模型名时清空价格框，不残留上一模型的价", async () => {
  const modal = createSettingsModalForTest();
  await modal.openSettingsModal();
  // 打开设置默认已按预设模型带出官方价（deepseek-v4-pro: 3/6/0.025）。
  assert.equal(findElementByLabel("输入价（元/百万 token）").value, "3");

  modal.setModelFieldsForTest({ model_name: "deepseek-chat" });
  findElementByLabel("模型")._fire("input");
  assertOfficialPriceFields({ input: "", output: "", cache: "" });
});

test("打开设置无任何模型时，按默认预设模型带出官方价", async () => {
  const modal = createSettingsModalForTest();
  await modal.openSettingsModal();

  assert.equal(findElementByLabel("模型").value, "deepseek-v4-pro");
  assertOfficialPriceFields({ input: 3, output: 6, cache: 0.025 });
});

test("已保存价格不被初始带出覆盖，仅补空缺的缓存命中价", async () => {
  const modal = createSettingsModalForTest({
    getDashboard: () => ({ project: { active_model: {
      provider: "openai-compatible",
      model_name: "deepseek-v4-flash",
      base_url: "https://api.deepseek.com",
      api_key_env: "DEEPSEEK_API_KEY",
      pricing: { input_per_million: 3, output_per_million: 6 }
    } } })
  });
  await modal.openSettingsModal();

  assertOfficialPriceFields({ input: 3, output: 6, cache: 0.02 });
});

test("切供应商时价格跟随新预设模型，不带旧模型的价格", async () => {
  const modal = createSettingsModalForTest({
    getDashboard: () => ({ project: { active_model: {
      provider: "openai-compatible",
      model_name: "deepseek-v4-flash",
      base_url: "https://api.deepseek.com",
      api_key_env: "DEEPSEEK_API_KEY",
      pricing: { input_per_million: 1, output_per_million: 2, cache_hit_per_million: 0.02 }
    } } })
  });
  await modal.openSettingsModal();
  assert.equal(modal.getModelFieldValue("model_name"), "deepseek-v4-flash");
  assert.equal(findElementByLabel("输入价（元/百万 token）").value, 1);

  // 切到小米 MiMo 供应商：模型框切到预设 mimo-v2.5-pro，价格应带出 MiMo 官方价。
  // 每次渲染会新建一组表单元素，断言取最新渲染的那一组（registry 末尾）。
  const spItems = domRegistry.filter((el) => el.className.startsWith("sp-item"));
  spItems[1].click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(modal.getModelFieldValue("model_name"), "mimo-v2.5-pro");
  assertOfficialPriceFields({ input: 3, output: 6, cache: 0.025 }, findLatestElementByLabel);
});

test("无项目时，全局默认模型已保存的价格也回填进表单", async () => {
  const modal = createSettingsModalForTest({
    getJsonImpl: async () => ({
      ok: true,
      default_model: {
        provider: "openai-compatible",
        model_name: "deepseek-v4-flash",
        base_url: "https://api.deepseek.com",
        api_key_env: "DEEPSEEK_API_KEY",
        pricing: { input_per_million: 1, output_per_million: 2, cache_hit_per_million: 0.02 }
      },
      models: []
    })
  });
  await modal.openSettingsModal();
  // 回填路径直接放数字；真实 DOM 的 input.value 一律是字符串，这里 mock 保留原类型。
  assertOfficialPriceFields({ input: 1, output: 2, cache: 0.02 });
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
