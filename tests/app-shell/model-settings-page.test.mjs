// tests/app-shell/model-settings-page.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { pickProvider, visibleModels, buildPageState, createModelSettingsPage } from "../../src/app-shell/model-settings-page.js";

const providers = [
  { id: "deepseek", name: "DeepSeek 官方", status: "enabled", base_url: "https://api.deepseek.com/v1", api_format: "openai-chat-completions", models: [
    { id: "m1", model_name: "deepseek-v4-pro", enabled: true },
    { id: "m2", model_name: "deepseek-v4-flash", enabled: false }
  ]},
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
}

const mockDocument = {
  createElement(tag) { return new MockElement(tag); },
  createTextNode(text) { return { nodeType: 3, textContent: String(text) }; }
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
