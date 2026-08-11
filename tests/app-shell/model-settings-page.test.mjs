// tests/app-shell/model-settings-page.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { pickProvider, visibleModels, buildPageState, createModelSettingsPage } from "../../src/app-shell/model-settings-page.js";

const providers = [
  { id: "deepseek", name: "DeepSeek 官方", status: "enabled", base_url: "https://api.deepseek.com/v1", api_format: "openai-chat-completions", api_key_env: "DEEPSEEK_API_KEY", models: [
    { id: "m1", model_name: "deepseek-v4-pro", enabled: true },
    { id: "m2", model_name: "deepseek-v4-flash", enabled: false }
  ]},
  // mimo 未配置 api_key_env：拉取前置检查「无密钥环境名」分支的测试载体
  { id: "mimo", name: "小米 MiMo 官方", status: "disabled", models: [
    { id: "m3", model_name: "mimo-v2.5", enabled: true }
  ]}
];

test("pickProvider 按 id 选中", () => {
  assert.equal(pickProvider(providers, "mimo")?.id, "mimo");
  assert.equal(pickProvider(providers, "ghost"), null);
});

test("visibleModels 只显启用模型", () => {
  assert.deepEqual(visibleModels(providers[0]).map((m) => m.id), ["m1"]);
});

test("buildPageState 默认选中第一个", () => {
  const state = buildPageState(providers, null);
  assert.equal(state.selected?.id, "deepseek");
  const second = buildPageState(providers, "mimo");
  assert.equal(second.selected?.id, "mimo");
});

test("buildPageState 找不到所选 id 时回退到第一个供应商", () => {
  const state = buildPageState(providers, "ghost");
  assert.equal(state.selected?.id, "deepseek");
});

test("visibleModels(null/undefined) 返回空数组", () => {
  assert.deepEqual(visibleModels(null), []);
  assert.deepEqual(visibleModels(undefined), []);
});

test("pickProvider 空列表返回 null", () => {
  assert.equal(pickProvider([], "x"), null);
});

// ---------------------------------------------------------------------------
// 最小 DOM mock（仿 settings-modal.test.mjs 的 MockElement；此处经 documentRef 注入）
// ---------------------------------------------------------------------------

class MockElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this._listeners = new Map();
    this.className = "";
    this.value = "";
    this.type = "";
    this.disabled = false;
    this.textContent = "";
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...nodes) { this.children.length = 0; this.children.push(...nodes); }
  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }
  /** 触发注册在 `type` 上的处理器（mock 的 dispatchEvent 等价物）。 */
  _fire(type, ...args) {
    for (const fn of this._listeners.get(type) ?? []) fn(...args);
  }
  click() { this._fire("click"); }
  /** 简易选择器匹配：仅支持 [data-x] 与 .class（renderCandidateList 的 querySelector 用）。 */
  matchesSelector(selector) {
    if (selector.startsWith("[")) {
      const attr = selector.slice(1, -1);
      return this.getAttribute(attr) !== null;
    }
    if (selector.startsWith(".")) return this.className.split(/\s+/u).includes(selector.slice(1));
    return false;
  }
}

// 全局元素注册表：documentRef.querySelector 从其中按顺序找首个匹配（renderCandidateList
// 的容器/箭头查找依赖它）。测试在渲染前 mockElements.length = 0 以隔离历史元素。
const mockElements = [];
const mockDocument = {
  createElement(tag) { const node = new MockElement(tag); mockElements.push(node); return node; },
  createTextNode(text) { return { nodeType: 3, textContent: String(text) }; },
  querySelector(selector) {
    for (const node of mockElements) {
      if (node.matchesSelector?.(selector)) return node;
    }
    return null;
  }
};

function tickAsync() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 收集 root 下所有后代元素（含 root 自身子层级的递归）。 */
function descendants(root) {
  const out = [];
  const walk = (nodes) => {
    for (const node of nodes) {
      out.push(node);
      if (node.children?.length) walk(node.children);
    }
  };
  walk(root.children);
  return out;
}

// ---------------------------------------------------------------------------
// Task 13：供应商级交互——失焦保存 / 启停 / 删除二次确认 / 连接信息自动保存
// ---------------------------------------------------------------------------

test("供应商失焦保存与启停切换调用 PATCH", async () => {
  const calls = [];
  const page = createModelSettingsPage({
    fetchImpl: async (url, options = {}) => {
      if (options?.method === "PATCH") calls.push({ url, options });
      return { ok: true, json: async () => ({ providers: [], default_model: null }) };
    },
    documentRef: mockDocument
  });
  await page._handlers.saveProviderPatch("deepseek", { status: "disabled" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/settings/providers/deepseek");
  assert.deepEqual(JSON.parse(calls[0].options.body), { status: "disabled" });
  assert.equal(await page._handlers.saveProviderPatch("deepseek", { status: "disabled" }), true, "保存成功应返回 true");
});

test("保存失败：saveProviderPatch 返回 false", async () => {
  const page = createModelSettingsPage({
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ message: "服务器错误" }) }),
    documentRef: mockDocument
  });
  assert.equal(await page.saveProviderPatch("deepseek", { name: "x" }), false, "保存失败应返回 false");
  assert.equal(await page.saveModelPatch("deepseek", "m1", { model_name: "x" }), false, "模型保存失败也应返回 false");
});

test("删除供应商前需要二次确认（confirm 返回 false 不发请求）", async () => {
  const calls = [];
  const page = createModelSettingsPage({
    fetchImpl: async () => { calls.push("called"); return { ok: true, json: async () => ({ providers: [], default_model: null }) }; },
    documentRef: mockDocument,
    confirmImpl: () => false
  });
  await page.removeProviderWithConfirm("deepseek");
  assert.deepEqual(calls, []);
});

test("确认删除后 POST /remove 并刷新列表、触发 onChanged", async () => {
  let removed = false;
  let changed = 0;
  const page = createModelSettingsPage({
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith("/remove")) {
        removed = true;
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: true, json: async () => ({ providers: removed ? [] : providers, default_model: null }) };
    },
    documentRef: mockDocument,
    confirmImpl: () => true,
    onChanged: () => { changed += 1; }
  });
  await page.open();
  const ok = await page.removeProviderWithConfirm("deepseek");
  assert.equal(ok, true);
  assert.equal(removed, true);
  assert.equal(changed, 1);
  assert.equal(page.getState().providers.length, 0, "refresh 后被删供应商应从列表移除");
});

test("renderDetail 交互接线：改名 / Base URL 校验 / 启停 / 协议回退 / 密钥两模式", async () => {
  const patches = [];
  const toasts = [];
  const fetchImpl = async (url, options = {}) => {
    if (options?.method === "PATCH") patches.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ providers, default_model: null }) };
  };
  const page = createModelSettingsPage({
    fetchImpl,
    documentRef: mockDocument,
    showToast: (message, kind) => toasts.push({ message, kind })
  });
  await page.open();
  const container = new MockElement("div");
  page.renderDetail(container);
  const els = descendants(container);
  const lastPatch = () => patches[patches.length - 1] ?? null;

  // 供应商名：失焦（change）→ PATCH { name }
  const nameInput = els.find((el) => el.getAttribute?.("data-field") === "name");
  assert.ok(nameInput, "详情应渲染供应商名输入框");
  nameInput.value = "DeepSeek 新名";
  nameInput._fire("change");
  await tickAsync();
  assert.deepEqual(lastPatch(), { url: "/api/settings/providers/deepseek", body: { name: "DeepSeek 新名" } });
  nameInput.value = "   ";
  nameInput._fire("change");
  await tickAsync();
  assert.equal(patches.length, 1, "空供应商名不应发起保存");

  // Base URL：非 http(s) 不保存；合法地址失焦保存
  const baseUrlInput = els.find((el) => el.getAttribute?.("data-field") === "base_url");
  baseUrlInput.value = "not-a-url";
  baseUrlInput._fire("change");
  await tickAsync();
  assert.equal(patches.length, 1, "非法 Base URL 不应发起保存");
  baseUrlInput.value = "https://api.deepseek.com/v2";
  baseUrlInput._fire("change");
  await tickAsync();
  assert.deepEqual(lastPatch(), { url: "/api/settings/providers/deepseek", body: { base_url: "https://api.deepseek.com/v2" } });

  // 状态切换：enabled 供应商按钮文案「禁用」，点击保存相反状态
  const statusToggle = els.find((el) => el.className === "provider-status-toggle");
  assert.equal(statusToggle.textContent, "禁用");
  statusToggle.click();
  await tickAsync();
  assert.deepEqual(lastPatch(), { url: "/api/settings/providers/deepseek", body: { status: "disabled" } });

  // 协议：非 openai-chat-completions 回退当前值并提示，不保存
  const formatSelect = els.find((el) => el.getAttribute?.("data-field") === "api_format");
  formatSelect.value = "anthropic-messages";
  formatSelect._fire("change");
  await tickAsync();
  assert.equal(formatSelect.value, "openai-chat-completions", "非法协议应回退到当前值");
  assert.ok(toasts.some((t) => /协议/u.test(t.message)), "应提示当前仅支持 OpenAI Chat Completions");
  formatSelect.value = "openai-chat-completions";
  formatSelect._fire("change");
  await tickAsync();
  assert.deepEqual(lastPatch(), { url: "/api/settings/providers/deepseek", body: { api_format: "openai-chat-completions" } });

  // 密钥双模式：明文 → api_key 且清空回显；环境变量名 → api_key_env
  const keyInput = els.find((el) => el.getAttribute?.("data-field") === "api_key");
  keyInput.value = "sk-abc123";
  keyInput._fire("change");
  await tickAsync();
  assert.deepEqual(lastPatch(), { url: "/api/settings/providers/deepseek", body: { api_key: "sk-abc123" } });
  assert.equal(keyInput.value, "", "明文密钥保存后应清空回显");
  keyInput.value = "DEEPSEEK_API_KEY";
  keyInput._fire("change");
  await tickAsync();
  assert.deepEqual(lastPatch(), { url: "/api/settings/providers/deepseek", body: { api_key_env: "DEEPSEEK_API_KEY" } });
  assert.equal(keyInput.value, "DEEPSEEK_API_KEY", "环境变量名模式保留输入值");
});

test("明文密钥保存失败：保留输入回显并提示先填环境变量名", async () => {
  const toasts = [];
  const page = createModelSettingsPage({
    fetchImpl: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      if (options?.method === "PATCH" && body?.api_key) {
        // 模拟后端对无 api_key_env bucket 的明文密钥 PATCH 返回 400
        return { ok: false, status: 400, json: async () => ({ message: "请先填写 API 密钥环境变量名。" }) };
      }
      return { ok: true, json: async () => ({ providers, default_model: null }) };
    },
    documentRef: mockDocument,
    showToast: (message, kind) => toasts.push({ message, kind })
  });
  await page.open();
  const container = new MockElement("div");
  page.renderDetail(container);
  const keyInput = descendants(container).find((el) => el.getAttribute?.("data-field") === "api_key");
  keyInput.value = "sk-abc123";
  keyInput._fire("change");
  await tickAsync();
  assert.equal(keyInput.value, "sk-abc123", "保存失败不应清空回显，避免丢失已键入的密钥");
  assert.ok(
    toasts.some((t) => t.message.includes("先填写 API 密钥环境变量名") && t.kind === "error"),
    "应给出「先填写环境变量名」的明确引导"
  );
  assert.ok(toasts.every((t) => !t.message.startsWith("保存失败：")), "该场景不应再出现通用失败文案");
});

// ---------------------------------------------------------------------------
// Task 14：模型级交互——启停/设默认走对应端点、删除二次确认
// ---------------------------------------------------------------------------

test("模型启停与设默认走对应端点", async () => {
  const calls = [];
  const page = createModelSettingsPage({
    fetchImpl: async (url, options = {}) => {
      if (options?.method === "PATCH" || url.endsWith("/default")) calls.push({ url, options });
      return { ok: true, json: async () => ({ providers: [], default_model: null }) };
    },
    documentRef: mockDocument
  });
  await page._handlers.saveModelPatch("deepseek", "m1", { enabled: false });
  await page.setDefaultModel("deepseek", "m1");
  assert.equal(calls[0].url, "/api/settings/providers/deepseek/models/m1");
  assert.equal(calls[1].url, "/api/settings/providers/deepseek/models/m1/default");
});

test("模型删除需要二次确认", async () => {
  const calls = [];
  const page = createModelSettingsPage({
    fetchImpl: async () => { calls.push("called"); return { ok: true, json: async () => ({ providers: [], default_model: null }) }; },
    documentRef: mockDocument,
    confirmImpl: () => false
  });
  await page.removeModelWithConfirm("deepseek", "m1");
  assert.deepEqual(calls, []);
});

test("列表点击切换供应商不丢失 default_model（「默认」角标回归）", async () => {
  const page = createModelSettingsPage({
    fetchImpl: async () => ({ ok: true, json: async () => ({ providers, default_model: { provider_id: "deepseek", model_id: "m1" } }) }),
    documentRef: mockDocument
  });
  await page.open();
  assert.deepEqual(page.getState().default_model, { provider_id: "deepseek", model_id: "m1" });

  const list = new MockElement("div");
  page.renderList(list);
  // 点击 deepseek 项（本就选中）：旧实现会用 buildPageState 重建 state 丢掉 default_model
  const deepseekItem = descendants(list).find((el) => el.getAttribute?.("data-provider-id") === "deepseek");
  assert.ok(deepseekItem, "列表应渲染 deepseek 项");
  deepseekItem.click();
  assert.deepEqual(page.getState().default_model, { provider_id: "deepseek", model_id: "m1" }, "列表点击后 default_model 应保留");

  // 切到 mimo 再切回：default_model 全程保留
  const mimoItem = descendants(list).find((el) => el.getAttribute?.("data-provider-id") === "mimo");
  mimoItem.click();
  assert.equal(page.getState().selected?.id, "mimo");
  assert.deepEqual(page.getState().default_model, { provider_id: "deepseek", model_id: "m1" });

  // 渲染详情：默认模型行仍带「默认」角标
  deepseekItem.click();
  const detail = new MockElement("div");
  page.renderDetail(detail);
  const m1Row = descendants(detail).find((el) => el.className === "model-row" && el.getAttribute?.("data-model-id") === "m1");
  assert.ok(m1Row, "详情应渲染默认模型行");
  assert.ok(
    descendants(m1Row).some((el) => el.className === "default-badge"),
    "默认模型行应渲染「默认」角标"
  );
});

test("停用模型的「设为默认」按钮置灰并提示", async () => {
  const page = createModelSettingsPage({
    fetchImpl: async () => ({ ok: true, json: async () => ({ providers, default_model: null }) }),
    documentRef: mockDocument
  });
  await page.open();
  const container = new MockElement("div");
  page.renderDetail(container);

  // m2 为停用模型：按钮 disabled + title 提示
  const m2Row = descendants(container).find((el) => el.className === "model-row" && el.getAttribute?.("data-model-id") === "m2");
  assert.ok(m2Row, "详情应渲染停用模型行");
  const disabledButton = descendants(m2Row).find((el) => el.className === "model-set-default");
  assert.ok(disabledButton, "停用模型行应渲染「设为默认」按钮");
  assert.equal(disabledButton.disabled, true, "停用模型的设为默认按钮应置灰");
  assert.ok(/已停用/u.test(disabledButton.getAttribute("title") ?? ""), "按钮应有停用提示");

  // m1 为启用模型：按钮保持可点
  const m1Row = descendants(container).find((el) => el.className === "model-row" && el.getAttribute?.("data-model-id") === "m1");
  const enabledButton = descendants(m1Row).find((el) => el.className === "model-set-default");
  assert.equal(enabledButton.disabled, false, "启用模型的设为默认按钮不应置灰");
});

// ---------------------------------------------------------------------------
// Task 15：拉取模型 + 测试连接交互 + 添加供应商表单
// ---------------------------------------------------------------------------

test("拉取前置检查：无密钥环境名时提示且不发请求", async () => {
  const calls = [];
  const toasts = [];
  const page = createModelSettingsPage({
    fetchImpl: async (url) => { calls.push(url); return { ok: true, json: async () => ({ providers, default_model: null }) }; },
    documentRef: mockDocument,
    showToast: (message) => toasts.push(message)
  });
  await page.open();
  calls.length = 0; // 清掉 open() 的 GET 记录，只看 pullModels 是否发请求
  // mimo 未配置 api_key_env → 不发请求，仅提示
  const result = await page._handlers.pullModels("mimo");
  assert.deepEqual(calls, []);
  assert.equal(result, false);
  assert.ok(toasts.some((t) => t.includes("请先填写接口地址和 API 密钥")), "应提示先填写接口地址和 API 密钥");
});

test("拉取候选展开后逐条添加", async () => {
  const addCalls = [];
  const page = createModelSettingsPage({
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith("/pull-models")) {
        return { ok: true, json: async () => ({ models: ["new-model-a", "new-model-b"] }) };
      }
      if (options.method === "POST" && url.endsWith("/models")) {
        addCalls.push(url);
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: true, json: async () => ({ providers, default_model: null }) };
    },
    documentRef: mockDocument
  });
  await page.open();
  const ok = await page._handlers.pullModels("deepseek");
  assert.equal(ok, true, "拉取成功应返回 true");
  await page._handlers.addPulledModel("deepseek", "new-model-a");
  assert.deepEqual(addCalls, ["/api/settings/providers/deepseek/models"]);
});

test("拉取候选渲染：成功展开候选行并同步箭头，空结果显示空态", async () => {
  const addCalls = [];
  let empty = false;
  const page = createModelSettingsPage({
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith("/pull-models")) {
        return { ok: true, json: async () => ({ models: empty ? [] : ["candidate-x", "candidate-y"] }) };
      }
      if (options?.method === "POST" && url.endsWith("/models")) {
        addCalls.push(url);
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: true, json: async () => ({ providers, default_model: null }) };
    },
    documentRef: mockDocument
  });
  await page.open();

  // 渲染详情：候选容器默认收起、箭头为收起态
  mockElements.length = 0; // 只保留本次渲染的元素，避免 querySelector 命中旧容器
  const container = new MockElement("div");
  page.renderDetail(container);
  const holder = descendants(container).find((el) => el.getAttribute?.("data-candidate-list") === "true");
  const toggle = descendants(container).find((el) => el.className === "candidate-toggle");
  assert.ok(holder, "应渲染候选容器");
  assert.ok(toggle, "应渲染候选折叠按钮");
  assert.equal(holder.hidden, true, "初始候选容器应收起");
  assert.equal(toggle.textContent, "拉取候选 ▸");

  // 拉取成功：容器展开、箭头同步为 ▾（修复箭头/展开态脱同步）、候选行逐条渲染
  assert.equal(await page._handlers.pullModels("deepseek"), true);
  assert.equal(holder.hidden, false, "拉取成功后容器应展开");
  assert.equal(toggle.textContent, "拉取候选 ▾", "自动展开后箭头应同步");
  const names = descendants(holder)
    .filter((el) => el.className === "candidate-row")
    .map((row) => row.getAttribute("data-candidate-name"));
  assert.deepEqual(names, ["candidate-x", "candidate-y"], "候选行应逐条渲染");
  // 行内「添加」按钮应接线到 addPulledModel（发 POST .../models）
  const addButton = descendants(holder).find((el) => el.className === "candidate-add");
  assert.ok(addButton, "候选行应渲染添加按钮");
  addButton.click();
  await tickAsync();
  assert.deepEqual(addCalls, ["/api/settings/providers/deepseek/models"], "候选「添加」应发创建请求");

  // 空拉取：容器同样展开并显示空态文案（修复「静默空拉取」）
  empty = true;
  mockElements.length = 0;
  const container2 = new MockElement("div");
  page.renderDetail(container2);
  const holder2 = descendants(container2).find((el) => el.getAttribute?.("data-candidate-list") === "true");
  const toggle2 = descendants(container2).find((el) => el.className === "candidate-toggle");
  await page._handlers.pullModels("deepseek");
  assert.equal(holder2.hidden, false, "空结果也应展开容器显示空态");
  assert.equal(toggle2.textContent, "拉取候选 ▾", "空结果展开后箭头同样同步");
  assert.ok(descendants(holder2).some((el) => el.className === "candidate-empty"), "应渲染空态文案");
});

test("测试连接：请求体形态、行内结果与缺密钥提示", async () => {
  const bodies = [];
  const toasts = [];
  const page = createModelSettingsPage({
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith("/test-connection")) {
        const body = JSON.parse(options.body);
        bodies.push(body);
        if (body.model.model_name === "deepseek-v4-pro") {
          return { ok: true, json: async () => ({ ok: true, code: null, message: "连接成功", latency_ms: 42 }) };
        }
        if (body.model.model_name === "mimo-v2.5") {
          return { ok: true, json: async () => ({ ok: false, code: "authentication_failed", message: "API Key 无效或无权限" }) };
        }
        return { ok: false, status: 400, json: async () => ({ ok: false, code: "configuration_missing", message: "请先在 Windows 环境变量中配置 API Key" }) };
      }
      return { ok: true, json: async () => ({ providers, default_model: null }) };
    },
    documentRef: mockDocument,
    showToast: (message, kind) => toasts.push({ message, kind })
  });

  const slot = new MockElement("div");
  const pro = await page._handlers.testConnection(providers[0], providers[0].models[0], slot);
  assert.equal(pro.ok, true);
  assert.deepEqual(bodies[0], {
    provider: { base_url: "https://api.deepseek.com/v1", api_key_env: "DEEPSEEK_API_KEY" },
    model: { model_name: "deepseek-v4-pro" }
  });
  let resultEl = descendants(slot)[0];
  assert.ok(resultEl.className.includes("connection-result ok"), "成功应渲染绿勾结果");
  assert.ok(resultEl.textContent.includes("连接成功"), "成功结果应含连接成功文案");

  const fail = await page._handlers.testConnection(providers[1], providers[1].models[0], slot);
  assert.equal(fail.ok, false);
  resultEl = descendants(slot)[0];
  assert.ok(resultEl.className.includes("connection-result error"), "失败应渲染红字结果");
  assert.ok(resultEl.textContent.includes("API Key 无效或无权限"), "失败结果应含后端错误文案");

  const miss = await page._handlers.testConnection(providers[0], { id: "x", model_name: "no-such", enabled: true }, slot);
  assert.equal(miss.ok, false);
  assert.ok(toasts.some((t) => t.message.includes("API 密钥")), "缺密钥（configuration_missing）应提示补密钥");
});

test("添加供应商：POST 创建 + 有密钥时 PATCH 落盘 + 表单开关", async () => {
  const calls = [];
  const toasts = [];
  let providersState = [...providers];
  const page = createModelSettingsPage({
    fetchImpl: async (url, options = {}) => {
      const method = options?.method ?? "GET";
      const body = options.body ? JSON.parse(options.body) : null;
      if (method === "POST" && url === "/api/settings/providers") {
        calls.push({ url, method, body });
        const provider = {
          id: "newp", name: body.name, base_url: body.base_url, api_format: body.api_format,
          api_key_env: body.api_key_env, status: "enabled", models: []
        };
        providersState = [provider, ...providersState];
        return { ok: true, json: async () => ({ ok: true, provider, store: { providers: providersState } }) };
      }
      if (method === "PATCH") {
        calls.push({ url, method, body });
        return { ok: true, json: async () => ({ ok: true, provider: {}, store: { providers: providersState } }) };
      }
      return { ok: true, json: async () => ({ providers: providersState, default_model: null }) };
    },
    documentRef: mockDocument,
    showToast: (message, kind) => toasts.push({ message, kind })
  });
  await page.open();

  // 必填缺失 / Base URL 非 http(s) / 密钥环境变量名非法：校验不过不发请求
  assert.equal(await page._handlers.addProvider({ name: "", base_url: "https://x.test", api_key_env: "K" }), false);
  assert.equal(await page._handlers.addProvider({ name: "X", base_url: "ftp://x.test", api_key_env: "K" }), false);
  assert.equal(await page._handlers.addProvider({ name: "X", base_url: "https://x.test", api_key_env: "1BAD" }), false);
  assert.equal(await page._handlers.addProvider({ name: "X", base_url: "https://x.test", api_key_env: "BAD NAME" }), false);
  assert.equal(calls.length, 0, "校验失败不应发请求");

  const ok = await page._handlers.addProvider({
    name: "新供应商", base_url: "https://new.example.com/v1", api_key_env: "NEW_KEY", api_key: "sk-new"
  });
  assert.equal(ok, true);
  assert.deepEqual(calls[0], {
    url: "/api/settings/providers", method: "POST",
    body: { name: "新供应商", base_url: "https://new.example.com/v1", api_format: "openai-chat-completions", api_key_env: "NEW_KEY" }
  });
  assert.deepEqual(calls[1], { url: "/api/settings/providers/newp", method: "PATCH", body: { api_key: "sk-new" } });
  assert.equal(page.getState().providers[0].id, "newp", "refresh 后新供应商应出现在列表首位");
  assert.ok(toasts.some((t) => t.message === "供应商已添加"), "成功应提示供应商已添加");

  // 表单交互：按钮可用 → 点击展开内联表单 → 取消收起
  const list = new MockElement("div");
  page.renderList(list);
  const addBtn = descendants(list).find((el) => el.className === "add-provider");
  assert.equal(addBtn.disabled, false, "「+ 添加供应商」按钮应可用");
  addBtn.click();
  const form = descendants(list).find((el) => el.getAttribute?.("data-add-provider-form") === "true");
  assert.ok(form, "列表应渲染内联添加表单");
  assert.equal(form.hidden, false, "点击后应展开内联表单");
  const cancel = descendants(list).find((el) => el.className === "provider-form-cancel");
  assert.ok(cancel, "表单应有取消按钮");
  cancel.click();
  assert.equal(form.hidden, true, "取消应收起表单");
});
