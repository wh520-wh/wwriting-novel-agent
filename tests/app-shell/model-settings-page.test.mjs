// tests/app-shell/model-settings-page.test.mjs
// Task A3：渲染目标注入（attach）——render/refresh 只写 attach 进来的 { list, detail }
// 目标，不再依赖 document 全局 registry（querySelector 双路径已弃用）。mock 为
// 轻量 MockElement：createElement/createTextNode 只用于 el() 建 DOM；attach 目标可
// 在子树内 querySelector（renderCandidateList/testConnection 的挂载节点查找）。
import assert from "node:assert/strict";
import test from "node:test";
import { pickProvider, visibleModels, buildPageState, createModelSettingsPage, translateTechnicalError } from "../../src/app-shell/model-settings-page.js";

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
// 最小 DOM mock（仿 settings-modal.test.mjs 的 MockElement；无全局 registry）。
// createElement/createTextNode 只服务 el()；attach 目标（list/detail）是普通
// MockElement，render 通过子树 querySelector 做挂载节点查找。
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
    this.hidden = false;
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
  /** 简易属性/类查找：返回子树内第一个匹配（renderCandidateList 等在 attach 目标内查找）。 */
  querySelector(selector) {
    const walk = (node) => {
      for (const child of node.children ?? []) {
        if (child.matchesSelector?.(selector)) return child;
        const hit = walk(child);
        if (hit) return hit;
      }
      return null;
    };
    return walk(this);
  }
  /** 简易选择器匹配：支持 [data-x] / [data-x="value"] 与 .class（querySelector 用）。 */
  matchesSelector(selector) {
    if (selector.startsWith("[")) {
      const match = /^\[([A-Za-z0-9_-]+)(?:="([^"]*)")?\]$/u.exec(selector);
      if (!match) return false;
      const attr = match[1];
      const expected = match[2];
      return expected === undefined ? this.getAttribute(attr) !== null : this.getAttribute(attr) === expected;
    }
    if (selector.startsWith(".")) return this.className.split(/\s+/u).includes(selector.slice(1));
    return false;
  }
}

// 仅提供元素工厂（el() 用）。无全局 registry、无 querySelector——渲染目标经 attach 注入。
const mockDocument = {
  createElement(tag) { return new MockElement(tag); },
  createElementNS(_ns, tag) { return new MockElement(tag); },
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

/** 构造页面：注入 showToast/onChanged/documentRef。默认 attach 一个空 target。 */
function makePage(overrides = {}) {
  const page = createModelSettingsPage({
    documentRef: mockDocument,
    showToast: () => {},
    onChanged: () => {},
    ...overrides
  });
  return page;
}

function attachTargets(page) {
  const list = new MockElement("div");
  const detail = new MockElement("div");
  page.attach({ list, detail });
  return { list, detail };
}

// ---------------------------------------------------------------------------
// Task A3：attach 目标注入——render/refresh 只写注入目标，未 attach 安全跳过，
// 目标可切换；不再依赖 document 全局 registry。
// ---------------------------------------------------------------------------

test("attach({ list, detail }) 后 open()/render() 渲染到注入目标", async () => {
  const page = makePage({
    fetchImpl: async () => ({ ok: true, json: async () => ({ providers, default_model: null }) })
  });
  const { list, detail } = attachTargets(page);
  await page.open(); // refresh → render() → 写入 attach 目标
  assert.ok(
    descendants(list).some((el) => el.getAttribute?.("data-provider-id") === "deepseek"),
    "列表目标应渲染 deepseek 供应商条目"
  );
  assert.ok(
    descendants(detail).some((el) => el.getAttribute?.("data-model-id") === "m1"),
    "详情目标应渲染 deepseek 的模型行"
  );
  assert.ok(
    descendants(list).some((el) => el.className.includes("provider-item")),
    "列表目标应渲染供应商条目"
  );
});

test("未 attach 时 open()/render() 安全跳过：不抛错、不渲染", async () => {
  const page = makePage({
    fetchImpl: async () => ({ ok: true, json: async () => ({ providers, default_model: null }) })
  });
  // 不 attach：refresh/render 不应抛错
  await page.open();
  assert.ok(Array.isArray(page.getState().providers), "refresh 仍写 state（渲染跳过不影响数据加载）");
  // 再次 refresh（无目标）不应抛错（render 对未 attach 目标安全跳过）
  await page.refresh();
});

test("attach(null) / 重新 attach 新目标：渲染切换到新目标", async () => {
  const page = makePage({
    fetchImpl: async () => ({ ok: true, json: async () => ({ providers, default_model: null }) })
  });
  const { list: oldList, detail: oldDetail } = attachTargets(page);
  await page.open();
  assert.ok(descendants(oldDetail).length > 0, "旧目标应先渲染出内容");

  const newList = new MockElement("div");
  const newDetail = new MockElement("div");
  page.attach({ list: newList, detail: newDetail });
  await page.refresh(); // refresh → render() 重新渲染到新目标
  assert.ok(descendants(newDetail).length > 0, "新详情目标应渲染出内容");
  assert.ok(
    descendants(oldDetail).every((el) => el.getAttribute?.("data-provider-id") !== "deepseek"),
    "旧目标内容应被 replaceChildren 丢弃"
  );

  page.attach(null); // 解除
  await page.refresh(); // 解除后 refresh → render() 应为无害 no-op
  assert.ok(page.attach, "attach 应仍是页面公开 API");
});

test("attach 目标可由外部传入（settings-modal 用它构建 model 分区）：list/detail 是渲染容器", async () => {
  const page = makePage({
    fetchImpl: async () => ({ ok: true, json: async () => ({ providers, default_model: null }) })
  });
  const list = new MockElement("aside");
  const detail = new MockElement("section");
  list.setAttribute("data-provider-list", "");
  detail.setAttribute("data-provider-detail", "");
  page.attach({ list, detail });
  await page.refresh(); // refresh → render() 渲染到 attach 目标
  assert.ok(
    descendants(list).some((el) => el.className.includes("provider-item")),
    "供应商列表应渲染进注入的 aside"
  );
  assert.ok(
    descendants(detail).some((el) => el.className.includes("provider-detail-head")),
    "详情应渲染进注入的 section"
  );
});

// ---------------------------------------------------------------------------
// Task 13：供应商级交互——失焦保存 / 启停 / 删除二次确认 / 连接信息自动保存
// ---------------------------------------------------------------------------

test("供应商失焦保存与启停切换调用 PATCH", async () => {
  const calls = [];
  const page = makePage({
    fetchImpl: async (url, options = {}) => {
      if (options?.method === "PATCH") calls.push({ url, options });
      return { ok: true, json: async () => ({ providers: [], default_model: null }) };
    }
  });
  await page._handlers.saveProviderPatch("deepseek", { status: "disabled" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/settings/providers/deepseek");
  assert.deepEqual(JSON.parse(calls[0].options.body), { status: "disabled" });
  assert.equal(await page._handlers.saveProviderPatch("deepseek", { status: "disabled" }), true, "保存成功应返回 true");
});

test("保存失败：saveProviderPatch 返回 false", async () => {
  const page = makePage({
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ message: "服务器错误" }) })
  });
  assert.equal(await page.saveProviderPatch("deepseek", { name: "x" }), false, "保存失败应返回 false");
  assert.equal(await page.saveModelPatch("deepseek", "m1", { model_name: "x" }), false, "模型保存失败也应返回 false");
});

test("删除供应商前需要二次确认（confirm 返回 false 不发请求）", async () => {
  const calls = [];
  const page = makePage({
    fetchImpl: async () => { calls.push("called"); return { ok: true, json: async () => ({ providers: [], default_model: null }) }; },
    confirmImpl: () => false
  });
  await page.removeProviderWithConfirm("deepseek");
  assert.deepEqual(calls, []);
});

test("确认删除后 POST /remove 并刷新列表、触发 onChanged", async () => {
  let removed = false;
  let changed = 0;
  const page = makePage({
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith("/remove")) {
        removed = true;
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: true, json: async () => ({ providers: removed ? [] : providers, default_model: null }) };
    },
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
  const page = makePage({
    fetchImpl,
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
  // Task 20 #5：空值不得静默丢弃——保留编辑态并显示中文错误
  const nameErrorEl = els.find((el) => el.getAttribute?.("data-field-error") === "name");
  assert.ok(nameErrorEl, "应渲染供应商名错误行");
  assert.equal(nameErrorEl.textContent, "供应商名称不能为空", "空供应商名应显示中文错误");
  assert.equal(nameInput.value, "   ", "空供应商名保留编辑态（不回填旧值）");

  // Base URL：空值/非 http(s) 不发保存，行内中文错误；合法地址失焦保存
  const baseUrlInput = els.find((el) => el.getAttribute?.("data-field") === "base_url");
  const baseUrlErrorEl = els.find((el) => el.getAttribute?.("data-field-error") === "base_url");
  assert.ok(baseUrlErrorEl, "应渲染 Base URL 错误行");
  baseUrlInput.value = "";
  baseUrlInput._fire("change");
  await tickAsync();
  assert.equal(patches.length, 1, "空 Base URL 不应发起保存");
  assert.equal(baseUrlErrorEl.textContent, "Base URL 不能为空", "空 Base URL 应显示中文错误");
  assert.equal(baseUrlInput.value, "", "空 Base URL 保留编辑态");
  baseUrlInput.value = "not-a-url";
  baseUrlInput._fire("change");
  await tickAsync();
  assert.equal(patches.length, 1, "非法 Base URL 不应发起保存");
  assert.equal(baseUrlErrorEl.textContent, "Base URL 需以 http:// 或 https:// 开头", "非法 Base URL 应显示中文错误");
  baseUrlInput.value = "https://api.deepseek.com/v2";
  baseUrlInput._fire("change");
  await tickAsync();
  assert.deepEqual(lastPatch(), { url: "/api/settings/providers/deepseek", body: { base_url: "https://api.deepseek.com/v2" } });
  assert.equal(baseUrlErrorEl.textContent, "", "合法 Base URL 保存成功后错误应清空");

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

  // 密钥（Task 20 #14）：默认关闭「使用环境变量名」→ 一律按明文密钥提交，
  // 不猜字符串形状；打开开关后才按环境变量名提交
  const keyInput = els.find((el) => el.getAttribute?.("data-field") === "api_key");
  const envToggle = els.find((el) => el.getAttribute?.("data-field") === "api_key_env_toggle");
  const keyErrorEl = els.find((el) => el.getAttribute?.("data-field-error") === "api_key");
  const keyStatusEl = els.find((el) => el.getAttribute?.("data-api-key-status") === "true");
  assert.ok(envToggle, "应渲染「使用环境变量名」开关");
  assert.equal(envToggle.checked, false, "开关默认关闭（关闭时一律按明文）");
  assert.ok(keyStatusEl, "应渲染密钥状态标签");
  assert.ok(keyStatusEl.textContent.includes("已填环境变量名"), "已填环境变量名但未存密钥应显示中间状态");

  keyInput.value = "sk-abc123";
  keyInput._fire("change");
  await tickAsync();
  assert.deepEqual(lastPatch(), { url: "/api/settings/providers/deepseek", body: { api_key: "sk-abc123" } });
  assert.equal(keyInput.value, "", "明文密钥保存成功后应清空回显");

  // 形如环境变量名的明文：开关关闭仍按明文提交（后端不猜字符串形状）
  keyInput.value = "MY_API_KEY";
  keyInput._fire("change");
  await tickAsync();
  assert.deepEqual(lastPatch(), { url: "/api/settings/providers/deepseek", body: { api_key: "MY_API_KEY" } });

  // 打开开关后才按环境变量名提交
  envToggle.checked = true;
  envToggle._fire("change");
  keyInput.value = "MY_API_KEY";
  keyInput._fire("change");
  await tickAsync();
  assert.deepEqual(lastPatch(), { url: "/api/settings/providers/deepseek", body: { api_key_env: "MY_API_KEY" } });
  assert.equal(keyInput.value, "", "环境变量名保存成功后同样清空回显");

  // 开关打开 + 非法环境变量名：行内中文错误，不发请求，保留编辑态
  const patchesBeforeInvalidEnv = patches.length;
  keyInput.value = "1BAD";
  keyInput._fire("change");
  await tickAsync();
  assert.equal(patches.length, patchesBeforeInvalidEnv, "非法环境变量名不应发起保存");
  assert.equal(keyErrorEl.textContent, "API 密钥环境变量名只能包含字母、数字、下划线且不能以数字开头。", "非法环境变量名应显示中文错误");
  assert.equal(keyInput.value, "1BAD", "非法输入保留编辑态");

  // 模型名空值：不发请求 + 行内中文错误 + 保留编辑态（Task 20 #5）
  const m1Row = els.find((el) => el.className === "model-row" && el.getAttribute?.("data-model-id") === "m1");
  const modelNameInput = descendants(m1Row).find((el) => el.getAttribute?.("data-field") === "model_name");
  const modelNameErrorEl = descendants(m1Row).find((el) => el.getAttribute?.("data-field-error") === "model_name:m1");
  assert.ok(modelNameErrorEl, "模型行应渲染模型名错误行");
  const patchesBeforeEmptyModel = patches.length;
  modelNameInput.value = "   ";
  modelNameInput._fire("change");
  await tickAsync();
  assert.equal(patches.length, patchesBeforeEmptyModel, "空模型名不应发起保存");
  assert.equal(modelNameErrorEl.textContent, "模型名称不能为空", "空模型名应显示中文错误");
  assert.equal(modelNameInput.value, "   ", "空模型名保留编辑态");
});

test("明文密钥保存失败：保留输入回显并提示先填环境变量名", async () => {
  const toasts = [];
  const page = makePage({
    fetchImpl: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      if (options?.method === "PATCH" && body?.api_key) {
        // 模拟后端对无 api_key_env bucket 的明文密钥 PATCH 返回 400
        return { ok: false, status: 400, json: async () => ({ message: "请先填写 API 密钥环境变量名。" }) };
      }
      return { ok: true, json: async () => ({ providers, default_model: null }) };
    },
    showToast: (message, kind) => toasts.push({ message, kind })
  });
  await page.open();
  const container = new MockElement("div");
  page.renderDetail(container);
  const els = descendants(container);
  const keyInput = els.find((el) => el.getAttribute?.("data-field") === "api_key");
  const keyErrorEl = els.find((el) => el.getAttribute?.("data-field-error") === "api_key");
  keyInput.value = "sk-abc123";
  keyInput._fire("change");
  await tickAsync();
  assert.equal(keyInput.value, "sk-abc123", "保存失败不应清空回显，避免丢失已键入的密钥");
  assert.equal(keyErrorEl.textContent, "请先填写 API 密钥环境变量名。", "失败原因应行内回显中文错误");
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
  const page = makePage({
    fetchImpl: async (url, options = {}) => {
      if (options?.method === "PATCH" || url.endsWith("/default")) calls.push({ url, options });
      return { ok: true, json: async () => ({ providers: [], default_model: null }) };
    }
  });
  await page._handlers.saveModelPatch("deepseek", "m1", { enabled: false });
  await page.setDefaultModel("deepseek", "m1");
  assert.equal(calls[0].url, "/api/settings/providers/deepseek/models/m1");
  assert.equal(calls[1].url, "/api/settings/providers/deepseek/models/m1/default");
});

test("模型删除需要二次确认", async () => {
  const calls = [];
  const page = makePage({
    fetchImpl: async () => { calls.push("called"); return { ok: true, json: async () => ({ providers: [], default_model: null }) }; },
    confirmImpl: () => false
  });
  await page.removeModelWithConfirm("deepseek", "m1");
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// Task 22：#11 模型名称框「回车保存」——UI 文案承诺「改名后回车保存」，
// 真实行为必须一致；#2 图标按钮必须有 accessible name。
// ---------------------------------------------------------------------------

test("模型名称框回车保存（#11：提示文案与真实行为一致）", async () => {
  const patches = [];
  const page = makePage({
    fetchImpl: async (url, options = {}) => {
      if (options?.method === "PATCH") patches.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ providers, default_model: null }) };
    }
  });
  await page.open();
  const container = new MockElement("div");
  page.renderDetail(container);
  const els = descendants(container);
  const m1Row = els.find((el) => el.className === "model-row" && el.getAttribute?.("data-model-id") === "m1");
  const modelNameInput = descendants(m1Row).find((el) => el.getAttribute?.("data-field") === "model_name");

  modelNameInput.value = "deepseek-v4-pro-enter";
  modelNameInput._fire("keydown", { key: "Enter", preventDefault() {} });
  await tickAsync();
  assert.deepEqual(
    patches[patches.length - 1],
    { url: "/api/settings/providers/deepseek/models/m1", body: { model_name: "deepseek-v4-pro-enter" } },
    "模型名称框回车应保存（与失焦保存同一提交路径）"
  );

  // 空模型名回车：行内中文错误，不发请求（与失焦行为一致）。
  const patchesBefore = patches.length;
  modelNameInput.value = "   ";
  modelNameInput._fire("keydown", { key: "Enter", preventDefault() {} });
  await tickAsync();
  assert.equal(patches.length, patchesBefore, "空模型名回车不得保存");
  const modelNameErrorEl = descendants(m1Row).find((el) => el.getAttribute?.("data-field-error") === "model_name:m1");
  assert.equal(modelNameErrorEl.textContent, "模型名称不能为空", "空模型名回车应行内报错");
});

test("回车保存后输入框移除派发的挂起 change 不再重复 PATCH（Important 1 回归）", async () => {
  const patches = [];
  const page = makePage({
    fetchImpl: async (url, options = {}) => {
      if (options?.method === "PATCH") patches.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ providers, default_model: null }) };
    }
  });
  await page.open();
  const container = new MockElement("div");
  page.renderDetail(container);
  const els = descendants(container);
  const m1Row = els.find((el) => el.className === "model-row" && el.getAttribute?.("data-model-id") === "m1");
  const modelNameInput = descendants(m1Row).find((el) => el.getAttribute?.("data-field") === "model_name");

  // 真实 DOM 时序：Enter 提交在途时 refresh 重建详情，被替换的输入框（仍是焦点
  // 元素、带挂起 change）在移除时派发 change——同一值再触发一轮 run()。
  modelNameInput.value = "deepseek-v4-pro-enter";
  modelNameInput._fire("keydown", { key: "Enter", preventDefault() {} });
  // 提交在途（第一个 PATCH 已同步入列）立即模拟移除派发：同值 change 必须被跳过。
  modelNameInput._fire("change");
  await tickAsync();
  await tickAsync();
  assert.equal(patches.length, 1, "移除派发的同值 change 不得重复 PATCH");

  // 值变化后仍正常提交（去重不得吞掉新改动）。
  modelNameInput.value = "deepseek-v4-pro-next";
  modelNameInput._fire("change");
  await tickAsync();
  assert.equal(patches.length, 2, "值变化后的 change 应正常保存");
  assert.deepEqual(
    patches[patches.length - 1],
    { url: "/api/settings/providers/deepseek/models/m1", body: { model_name: "deepseek-v4-pro-next" } }
  );

  // 失败后同值可重试（lastCommitted 失败复位）。
  let fail = true;
  const page2 = makePage({
    fetchImpl: async (url, options = {}) => {
      if (options?.method === "PATCH") {
        if (fail) {
          fail = false;
          return { ok: false, status: 500, json: async () => ({ message: "HTTP 500" }) };
        }
        patches.push({ url, body: JSON.parse(options.body) });
      }
      return { ok: true, json: async () => ({ providers, default_model: null }) };
    },
    showToast: () => {}
  });
  await page2.open();
  const container2 = new MockElement("div");
  page2.renderDetail(container2);
  const m1Row2 = descendants(container2).find((el) => el.className === "model-row" && el.getAttribute?.("data-model-id") === "m1");
  const nameInput2 = descendants(m1Row2).find((el) => el.getAttribute?.("data-field") === "model_name");
  nameInput2.value = "deepseek-v4-pro-retry";
  nameInput2._fire("keydown", { key: "Enter", preventDefault() {} });
  await tickAsync();
  await tickAsync();
  assert.equal(patches.length, 2, "第一次保存失败不发成功记录");
  nameInput2._fire("keydown", { key: "Enter", preventDefault() {} });
  await tickAsync();
  await tickAsync();
  assert.equal(patches.length, 3, "失败后同值重试应正常保存");
});

test("图标按钮有 accessible name：删除供应商/显示隐藏密钥按钮带 aria-label（#2）", async () => {
  const page = makePage({
    fetchImpl: async () => ({ ok: true, json: async () => ({ providers, default_model: null }) })
  });
  await page.open();
  const container = new MockElement("div");
  page.renderDetail(container);
  const els = descendants(container);

  const deleteBtn = els.find((el) => el.className === "provider-delete");
  assert.ok(deleteBtn, "应渲染删除供应商按钮");
  assert.equal(deleteBtn.getAttribute("aria-label"), "删除供应商", "删除按钮应有 accessible name（aria-label）");

  const eyeBtn = els.find((el) => el.className === "api-key-eye");
  assert.ok(eyeBtn, "应渲染显示/隐藏密钥按钮");
  assert.equal(eyeBtn.getAttribute("aria-label"), "显示/隐藏密钥", "密钥切换按钮应有 accessible name（aria-label）");
});

test("列表点击切换供应商不丢失 default_model（「默认」角标回归）", async () => {
  const page = makePage({
    fetchImpl: async () => ({ ok: true, json: async () => ({ providers, default_model: { provider_id: "deepseek", model_id: "m1" } }) })
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
  const page = makePage({
    fetchImpl: async () => ({ ok: true, json: async () => ({ providers, default_model: null }) })
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

test("round10 model row: actions and connection result use separate stable rows", async () => {
  const page = makePage({
    fetchImpl: async () => ({ ok: true, json: async () => ({ providers, default_model: null }) })
  });
  const { detail } = attachTargets(page);
  await page.open();
  const row = descendants(detail).find((el) => el.className === "model-row");
  assert.ok(descendants(row).some((el) => el.className === "model-row-main"));
  assert.ok(descendants(row).some((el) => el.className === "model-row-actions"));
  assert.ok(descendants(row).some((el) => el.className === "model-connection-result"));
});

test("拉取前置检查：无密钥环境名时提示且不发请求", async () => {
  const calls = [];
  const toasts = [];
  const page = makePage({
    fetchImpl: async (url) => { calls.push(url); return { ok: true, json: async () => ({ providers, default_model: null }) }; },
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
  const page = makePage({
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith("/pull-models")) {
        return { ok: true, json: async () => ({ models: ["new-model-a", "new-model-b"] }) };
      }
      if (options.method === "POST" && url.endsWith("/models")) {
        addCalls.push(url);
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: true, json: async () => ({ providers, default_model: null }) };
    }
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
  const page = makePage({
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith("/pull-models")) {
        return { ok: true, json: async () => ({ models: empty ? [] : ["candidate-x", "candidate-y"] }) };
      }
      if (options?.method === "POST" && url.endsWith("/models")) {
        addCalls.push(url);
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: true, json: async () => ({ providers, default_model: null }) };
    }
  });
  await page.open();

  // 渲染详情：候选容器默认收起、箭头为收起态（渲染进 attach 目标，renderCandidateList
  // 经 detail 目标内 querySelector 查找，不再依赖全局 registry）
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
  const page = makePage({
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
    showToast: (message, kind) => toasts.push({ message, kind })
  });

  // 直调路径（详情未渲染）：currentDetail 为 null → resultSlot 重查询查不到（回退到
  // 传入的 slot），断言结果仍写入传入 slot——覆盖「未重渲染回退」分支。
  const slot = new MockElement("div");
  const pro = await page._handlers.testConnection(providers[0], providers[0].models[0], slot);
  assert.equal(pro.ok, true);
  assert.deepEqual(bodies[0], {
    provider: { base_url: "https://api.deepseek.com/v1", api_key_env: "DEEPSEEK_API_KEY" },
    model: { model_name: "deepseek-v4-pro" }
  });
  let resultEl = descendants(slot).find((el) => String(el.className).includes("connection-result"));
  assert.ok(resultEl, "结果应写入传入的 result slot（直调回退路径）");
  assert.ok(resultEl.className.includes("connection-result ok"), "成功应渲染绿勾结果");
  assert.ok(resultEl.textContent.includes("连接成功"), "成功结果应含连接成功文案");

  const fail = await page._handlers.testConnection(providers[1], providers[1].models[0], slot);
  assert.equal(fail.ok, false);
  resultEl = descendants(slot).find((el) => String(el.className).includes("connection-result"));
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
  const page = makePage({
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

// ---------------------------------------------------------------------------
// Task 20：密钥开关契约（#14）、draft-first 表单（#5/#8）、已配置状态（#3）、
// 技术错误中文映射（#15）、切换失败 toast（#10）
// ---------------------------------------------------------------------------

test("translateTechnicalError：英文技术错误映射中文，中文消息原样保留（#15）", () => {
  assert.equal(translateTechnicalError({ message: "fetch failed" }), "网络请求失败，请检查网络连接后重试");
  assert.equal(translateTechnicalError({ message: "Failed to fetch" }), "网络请求失败，请检查网络连接后重试");
  assert.equal(translateTechnicalError({ message: "HTTP 500" }), "服务器响应异常，请稍后重试");
  assert.equal(translateTechnicalError({ message: "The operation timed out" }), "请求超时，请稍后重试");
  assert.equal(translateTechnicalError({ message: "TypeError: Cannot read properties of undefined (reading 'x')" }), "请求格式错误，请刷新页面后重试");
  assert.equal(translateTechnicalError({ message: "" }), "未知错误，请稍后重试");
  assert.equal(translateTechnicalError({ message: "供应商名称已存在" }), "供应商名称已存在", "中文后端消息不得被改写");
});

test("密钥状态：已配置只显示状态不回显密钥（#3）", async () => {
  const withSaved = [
    { ...providers[0], api_key_saved: true },
    { ...providers[1], api_key_saved: false }
  ];
  const page = makePage({
    fetchImpl: async () => ({ ok: true, json: async () => ({ providers: withSaved, default_model: null }) }),
    showToast: () => {}
  });
  await page.open();
  const container = new MockElement("div");
  page.renderDetail(container);
  const els = descendants(container);
  const statusEl = els.find((el) => el.getAttribute?.("data-api-key-status") === "true");
  const keyInput = els.find((el) => el.getAttribute?.("data-field") === "api_key");
  assert.ok(statusEl.textContent.includes("已配置"), "已保存密钥的供应商应显示「已配置」状态");
  assert.ok(!statusEl.textContent.includes("sk-"), "状态文本不得包含密钥明文");
  assert.equal(keyInput.value, "", "密钥输入框不回显密钥");

  // 未配置状态
  const unconfigured = [{ id: "custom", name: "自建", status: "enabled", base_url: "https://x.test", api_format: "openai-chat-completions", api_key_env: "", models: [] }];
  const page2 = makePage({
    fetchImpl: async () => ({ ok: true, json: async () => ({ providers: unconfigured, default_model: null }) }),
    showToast: () => {}
  });
  await page2.open();
  const container2 = new MockElement("div");
  page2.renderDetail(container2);
  const status2 = descendants(container2).find((el) => el.getAttribute?.("data-api-key-status") === "true");
  assert.ok(status2.textContent.includes("未配置"), "未配置密钥的供应商应显示「未配置」");
});

test("test/pull 先提交并验证当前表单值（#8）：未失焦输入也会先保存", async () => {
  const patches = [];
  const testBodies = [];
  let pullCalls = 0;
  let current = JSON.parse(JSON.stringify(providers));
  const fetchImpl = async (url, options = {}) => {
    const method = options?.method ?? "GET";
    if (method === "PATCH") {
      const body = JSON.parse(options.body);
      patches.push({ url, body });
      const parts = url.split("/");
      const provider = current.find((p) => p.id === parts[4]);
      if (parts.length > 6) {
        const model = provider.models.find((m) => m.id === parts[6]);
        Object.assign(model, body);
        return { ok: true, json: async () => ({ ok: true, model, provider, store: { providers: current } }) };
      }
      Object.assign(provider, body);
      return { ok: true, json: async () => ({ ok: true, provider, store: { providers: current } }) };
    }
    if (url.endsWith("/test-connection")) {
      testBodies.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: true, message: "连接成功", latency_ms: 5 }) };
    }
    if (url.endsWith("/pull-models")) {
      pullCalls += 1;
      return { ok: true, json: async () => ({ models: [] }) };
    }
    return { ok: true, json: async () => ({ providers: current, default_model: null }) };
  };
  const page = makePage({ fetchImpl, showToast: () => {} });
  await page.open();
  const container = new MockElement("div");
  page.renderDetail(container);
  const els = descendants(container);

  // 改 Base URL 与模型名但不失焦（不触发 change）：点「测试连接」应先保存草稿再测试
  const baseUrlInput = els.find((el) => el.getAttribute?.("data-field") === "base_url");
  baseUrlInput.value = "https://new.example.com/v2";
  const m1Row = els.find((el) => el.className === "model-row" && el.getAttribute?.("data-model-id") === "m1");
  const modelNameInput = descendants(m1Row).find((el) => el.getAttribute?.("data-field") === "model_name");
  modelNameInput.value = "deepseek-v4-pro-new";
  const testButton = descendants(m1Row).find((el) => el.className === "model-test-connection");
  testButton.click();
  await tickAsync();

  assert.deepEqual(patches.map((p) => p.body), [
    { base_url: "https://new.example.com/v2" },
    { model_name: "deepseek-v4-pro-new" }
  ], "test 前应依次提交未保存的 provider 与 model 草稿");
  assert.deepEqual(testBodies[0], {
    provider: { base_url: "https://new.example.com/v2", api_key_env: "DEEPSEEK_API_KEY" },
    model: { model_name: "deepseek-v4-pro-new" }
  }, "测试请求必须使用提交后的权威值而非陈旧保存值");

  // 拉取模型：同样先提交未失焦草稿再请求
  const pullButton = els.find((el) => el.className === "pull-models");
  baseUrlInput.value = "https://pull.example.com/v1";
  pullButton.click();
  await tickAsync();
  assert.deepEqual(patches[patches.length - 1].body, { base_url: "https://pull.example.com/v1" }, "pull 前应先提交 Base URL 草稿");
  assert.equal(pullCalls, 1);
});

test("test/pull 被非法表单值阻断（#8）：不发请求且行内报错", async () => {
  let testCalls = 0;
  let pullCalls = 0;
  const page = makePage({
    fetchImpl: async (url, options = {}) => {
      if (options?.method === "PATCH") return { ok: true, json: async () => ({ ok: true }) };
      if (url.endsWith("/test-connection")) { testCalls += 1; return { ok: true, json: async () => ({ ok: true }) }; }
      if (url.endsWith("/pull-models")) { pullCalls += 1; return { ok: true, json: async () => ({ models: [] }) }; }
      return { ok: true, json: async () => ({ providers, default_model: null }) };
    },
    showToast: () => {}
  });
  await page.open();
  const container = new MockElement("div");
  page.renderDetail(container);
  const els = descendants(container);
  const baseUrlInput = els.find((el) => el.getAttribute?.("data-field") === "base_url");
  baseUrlInput.value = ""; // 清空但不失焦：commitCurrentDraft 必须拦住
  const m1Row = els.find((el) => el.className === "model-row" && el.getAttribute?.("data-model-id") === "m1");
  const testButton = descendants(m1Row).find((el) => el.className === "model-test-connection");
  const resultSlot = descendants(container).find((el) => el.getAttribute?.("data-model-connection-result") === "m1");
  testButton.click();
  await tickAsync();
  assert.equal(testCalls, 0, "空 Base URL 不得发起测试请求");
  const baseUrlErrorEl = els.find((el) => el.getAttribute?.("data-field-error") === "base_url");
  assert.equal(baseUrlErrorEl.textContent, "Base URL 不能为空", "应行内回显中文错误");
  const resultEl = descendants(resultSlot).find((el) => String(el.className).includes("connection-result"));
  assert.ok(resultEl, "结果槽应显示错误结果");
  assert.ok(resultEl.className.includes("connection-result error"), "结果槽应显示错误");
  assert.ok(resultEl.textContent.includes("Base URL 不能为空"), "结果槽错误文案应为中文");

  // 拉取同样被空 Base URL 阻断
  const pullButton = els.find((el) => el.className === "pull-models");
  pullButton.click();
  await tickAsync();
  assert.equal(pullCalls, 0, "空 Base URL 不得发起拉取请求");
});

test("启停切换失败：toast 提示且不回退旧 UI（#10）", async () => {
  const toasts = [];
  const page = makePage({
    fetchImpl: async (url, options = {}) => {
      if (options?.method === "PATCH") return { ok: false, status: 500, json: async () => ({ message: "HTTP 500" }) };
      return { ok: true, json: async () => ({ providers, default_model: null }) };
    },
    showToast: (message, kind) => toasts.push({ message, kind })
  });
  await page.open();
  const container = new MockElement("div");
  page.renderDetail(container);
  const els = descendants(container);

  // 供应商启停失败：toast + 按钮文案保持原状（不回退旧 UI）
  const statusToggle = els.find((el) => el.className === "provider-status-toggle");
  statusToggle.click();
  await tickAsync();
  assert.ok(toasts.some((t) => t.kind === "error" && t.message.startsWith("保存失败")), "供应商启停失败应弹 toast");
  assert.ok(toasts.some((t) => t.kind === "error" && t.message.includes("服务器响应异常")), "英文技术错误应映射为中文");
  assert.equal(statusToggle.textContent, "禁用", "失败后按钮文案保持原状");

  // 模型启停失败：toast + 文案不回退
  const m1Row = els.find((el) => el.className === "model-row" && el.getAttribute?.("data-model-id") === "m1");
  const modelToggle = descendants(m1Row).find((el) => el.className === "model-status-toggle");
  modelToggle.click();
  await tickAsync();
  assert.equal(modelToggle.textContent, "停用", "模型启停失败后文案不回退");
  assert.ok(toasts.filter((t) => t.kind === "error").length >= 2, "模型启停失败也应弹 toast");
});

test("测试连接：commit 重渲染后结果写入新渲染的 resultSlot（Critical 修复回归）", async () => {
  const patches = [];
  const testBodies = [];
  let current = JSON.parse(JSON.stringify(providers));
  const fetchImpl = async (url, options = {}) => {
    const method = options?.method ?? "GET";
    if (method === "PATCH") {
      const body = JSON.parse(options.body);
      patches.push({ url, body });
      const parts = url.split("/");
      const provider = current.find((p) => p.id === parts[4]);
      Object.assign(provider, body);
      return { ok: true, json: async () => ({ ok: true, provider, store: { providers: current } }) };
    }
    if (url.endsWith("/test-connection")) {
      testBodies.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: true, message: "连接成功", latency_ms: 5 }) };
    }
    return { ok: true, json: async () => ({ providers: current, default_model: null }) };
  };
  const page = makePage({ fetchImpl, showToast: () => {} });

  // 注入渲染目标：commit 触发 refresh → render() 重渲染 attach 的 detail 目标——
  // 旧 resultSlot 脱离 DOM 的真实路径（不再依赖全局 registry 命中）。
  const { detail: detailContainer } = attachTargets(page);
  await page.open(); // refresh → render() → 写入 attach 目标

  const els = descendants(detailContainer);
  const m1Row = els.find((el) => el.className === "model-row" && el.getAttribute?.("data-model-id") === "m1");
  const testButton = descendants(m1Row).find((el) => el.className === "model-test-connection");
  const oldSlot = descendants(m1Row).find((el) => el.getAttribute?.("data-model-connection-result") === "m1");
  const baseUrlInput = els.find((el) => el.getAttribute?.("data-field") === "base_url");
  baseUrlInput.value = "https://new.example.com/v2"; // 脏字段：未失焦改动

  testButton.click();
  await tickAsync();

  assert.deepEqual(patches.map((p) => p.body), [{ base_url: "https://new.example.com/v2" }], "test 前应先提交草稿");
  assert.deepEqual(testBodies[0], {
    provider: { base_url: "https://new.example.com/v2", api_key_env: "DEEPSEEK_API_KEY" },
    model: { model_name: "deepseek-v4-pro" }
  }, "测试请求应使用提交后的权威值");
  // commit 触发 refresh 重渲染：结果必须写入新渲染的 slot（用户可见），旧 slot 不接收
  const freshSlot = descendants(detailContainer).find((el) => el.getAttribute?.("data-model-connection-result") === "m1");
  assert.notEqual(freshSlot, oldSlot, "重渲染后 attach 目标内应有新的 result slot");
  const resultEl = descendants(freshSlot).find((el) => String(el.className).includes("connection-result"));
  assert.ok(resultEl, "测试结果应写入新渲染的 result slot（用户可见）");
  assert.ok(resultEl.className.includes("connection-result ok"), "成功结果应渲染绿勾");
  assert.ok(resultEl.textContent.includes("连接成功"), "结果文案应可见");
  assert.equal(descendants(oldSlot).length, 0, "已脱离的旧 slot 不应收到结果");
});

// ---------------------------------------------------------------------------
// Task A4（v4）：模型分区 dirty 关闭保护——isDirty() 判定「未失焦草稿 vs 保存态」。
// 表单 draft-first autosave（change 即 PATCH），此函数覆盖「输入未失焦」窗口
//（Esc 关闭裸奔路径）与「保存请求在途/失败」。字段清单对齐 freshDraftRefs。
// ---------------------------------------------------------------------------

test("isDirty：供应商名/Base URL/模型名与保存态不一致即 true，一致/未渲染为 false", async () => {
  // 保存态 = refresh 后的 state.selected（deepseek：name/ base_url / m1 model_name）。
  const page = makePage({
    fetchImpl: async () => ({ ok: true, json: async () => ({ providers, default_model: null }) })
  });
  await page.open();

  // attach 目标并渲染详情：isDirty 初始应为 false（草稿==保存态）。
  const { detail } = attachTargets(page);
  await page.refresh(); // render() 写入 attach 目标，activeDraftRefs 重建
  assert.equal(page.isDirty(), false, "attach 渲染后草稿与保存态一致 → isDirty() false");

  const els = descendants(detail);
  const nameInput = els.find((el) => el.getAttribute?.("data-field") === "name");
  const baseUrlInput = els.find((el) => el.getAttribute?.("data-field") === "base_url");
  const m1Row = els.find((el) => el.className === "model-row" && el.getAttribute?.("data-model-id") === "m1");
  const modelNameInput = descendants(m1Row).find((el) => el.getAttribute?.("data-field") === "model_name");
  assert.ok(nameInput && baseUrlInput && modelNameInput, "详情应渲染 name/base_url/model_name 输入框");

  // 供应商名未失焦改动 → dirty
  nameInput.value = "DeepSeek 改名"; // 不触发 change（焦点仍在框内，Esc 裸奔场景）
  assert.equal(page.isDirty(), true, "未失焦改动的供应商名应判脏");
  nameInput.value = "DeepSeek 官方"; // 还原
  assert.equal(page.isDirty(), false, "还原为保存态后不应判脏");

  // Base URL 未失焦改动 → dirty
  baseUrlInput.value = "https://new.example.com/v2";
  assert.equal(page.isDirty(), true, "未失焦改动的 Base URL 应判脏");
  baseUrlInput.value = "https://api.deepseek.com/v1";
  assert.equal(page.isDirty(), false, "还原为保存态后不应判脏");

  // 模型名未失焦改动 → dirty
  modelNameInput.value = "deepseek-v4-pro-x";
  assert.equal(page.isDirty(), true, "未失焦改动的模型名应判脏");
  modelNameInput.value = "deepseek-v4-pro";
  assert.equal(page.isDirty(), false, "还原为保存态后不应判脏");

  // 供应商名清空为空白（与保存态不一致）→ dirty
  nameInput.value = "   ";
  assert.equal(page.isDirty(), true, "供应商名被清空应判脏（行内校验错误但值未落盘）");
});

test("isDirty：密钥输入框非空（未失焦打码/明文密钥）判脏；已保存密钥时输入恒空不是脏", async () => {
  // deepseek 未存密钥（api_key_saved 缺失）→ 输入框的值纯用户键入。
  const page = makePage({
    fetchImpl: async () => ({ ok: true, json: async () => ({ providers, default_model: null }) })
  });
  await page.open();
  const { detail } = attachTargets(page);
  await page.refresh();
  const els = descendants(detail);
  const keyInput = els.find((el) => el.getAttribute?.("data-field") === "api_key");
  assert.ok(keyInput, "详情应渲染密钥输入框");
  assert.equal(keyInput.value, "", "密钥输入框初始不回显");
  assert.equal(page.isDirty(), false, "密钥框为空不应判脏");

  keyInput.value = "sk-abc123"; // 未触发 change（焦点仍在框内）
  assert.equal(page.isDirty(), true, "密钥框有未失焦键入值应判脏");
  keyInput.value = "";
  assert.equal(page.isDirty(), false, "清空密钥框后不应判脏");

  // 已保存密钥（api_key_saved: true）：输入框仍恒空（不回显），不是脏。
  const withSaved = [...providers].map((p) => (p.id === "deepseek" ? { ...p, api_key_saved: true } : p));
  const page2 = makePage({
    fetchImpl: async () => ({ ok: true, json: async () => ({ providers: withSaved, default_model: null }) })
  });
  await page2.open();
  const { detail: detail2 } = attachTargets(page2);
  await page2.refresh();
  const key2 = descendants(detail2).find((el) => el.getAttribute?.("data-field") === "api_key");
  assert.equal(key2.value, "", "已保存密钥的供应商密钥框仍不回显");
  assert.equal(page2.isDirty(), false, "已保存密钥但输入框恒空 → 不判脏（不是误报）");
});

test("isDirty：未渲染详情（无 activeDraftRefs）安全返回 false", async () => {
  const page = makePage({
    fetchImpl: async () => ({ ok: true, json: async () => ({ providers, default_model: null }) })
  });
  await page.open(); // refresh → 未 attach，render 跳过，activeDraftRefs 保持 freshDraftRefs
  assert.equal(page.isDirty(), false, "无渲染目标/无 activeDraftRefs 时 isDirty() 应为 false");
});
