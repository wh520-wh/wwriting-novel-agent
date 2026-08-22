// Settings modal: pure helper (formatConnectionStatus) + DOM-level behavior of
// createSettingsModal (writing/skills/danger sections; model section removed in
// Task 17 cutover — model config lives in the model-settings-page).
// The exported helpers must work without a DOM so they can be exercised in node:test;
// the modal tests use a minimal DOM mock (no JSDOM), mirroring activity-strip-render.test.mjs.
import assert from "node:assert/strict";
import test from "node:test";

import {
  formatConnectionStatus,
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
    // 与真实 DOM 一致：监听器注册期间派发的事件不再回调本次派发的监听器
    //（快照迭代），且 stopImmediatePropagation 终止同节点其余监听器。
    const first = pass[0];
    let immediateStopped = false;
    if (first && typeof first === "object") {
      const original = first.stopImmediatePropagation ?? (() => {});
      first.stopImmediatePropagation = () => { immediateStopped = true; original(); };
    }
    for (const fn of [...(this._listeners.get(type) ?? [])]) {
      fn(...pass);
      if (immediateStopped) break;
    }
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
    // 与真实 document 一致：按 id 找挂载节点（renderSectionNav 用 #settings-section-nav）。
    getElementById(id) {
      let hit = null;
      for (const el of domRegistry) { if (el.id === id) hit = el; }
      return hit;
    },
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
      // 与 MockElement._fire 同语义：快照迭代 + stopImmediatePropagation 终止。
      const first = args[0];
      let immediateStopped = false;
      if (first && typeof first === "object") {
        const original = first.stopImmediatePropagation ?? (() => {});
        first.stopImmediatePropagation = () => { immediateStopped = true; original(); };
      }
      for (const fn of [...(docListeners.get(type) ?? [])]) {
        fn(...args);
        if (immediateStopped) break;
      }
    }
  };
}
installDomMock();

// settings-modal.js pulls in motion-runtime (and vendor/gsap). 测试环境不调用
// setupMotion()（那是 app.js 的初始化职责），motion-runtime 的 _gsapLoaded 恒为
// false → closeModal 走同步分支直接回调 onComplete——「关闭恢复原焦点」等行为可
// 确定性断言，无需等待真实 gsap 时间线。
const { createSettingsModal } = await import("../../src/app-shell/settings-modal.js");

// ---------------------------------------------------------------------------
// Modal harness
// ---------------------------------------------------------------------------

function createSettingsModalForTest(overrides = {}) {
  domRegistry = [];
  // refs 单独解构：partial refs 只覆盖对应字段，不会被 ...overrides 整体替换 ctx.refs。
  const { refs: refsOverride = {}, ...rest } = overrides;
  const refs = {
    settingsSave: new MockElement("button"),
    settingsSaveStatus: new MockElement("p"),
    settingsScrim: new MockElement("div"),
    settingsDetail: new MockElement("div"),
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
    // Task A3：model 分区渲染依赖注入（attach/open）。测试可经 overrides 覆盖成 spy。
    modelSettings: modelSettingsFake(),
    ...rest
  };
  return createSettingsModal(ctx, {
    getJsonImpl: overrides.getJsonImpl ?? (async () => ({ ok: true, default_model: null, models: [] })),
    postJsonImpl: overrides.postJsonImpl ?? (async () => ({ ok: true })),
    deleteJsonImpl: overrides.deleteJsonImpl ?? (async () => ({ ok: true })),
    // 确认函数：显式注入（默认 window.confirm，node 测试环境不可用）。
    confirmImpl: overrides.confirmImpl ?? (() => true)
  });
}

function findElementByLabel(label) {
  return domRegistry.find((el) => el.getAttribute("aria-label") === label) ?? null;
}

// 深度查找子树中首个指定 class 的后代（DOM mock 无 querySelector）。
function findDescendantByClassName(node, className) {
  for (const child of node.children) {
    if (child.className === className) return child;
    const hit = findDescendantByClassName(child, className);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pure helper tests (existing)
// ---------------------------------------------------------------------------

test("connection failure keeps the actionable provider message", () => {
  assert.equal(formatConnectionStatus({
    ok: false,
    code: "authentication_failed",
    message: "API Key 无效或无权限",
  }), "API Key 无效或无权限");
});

test("connection success with latency formats the status string", () => {
  assert.equal(formatConnectionStatus({ ok: true, latency_ms: 48 }), "连接成功 · 48 ms");
  assert.equal(formatConnectionStatus({ ok: true }), "连接成功");
  assert.equal(formatConnectionStatus(null), "");
});

// ---------------------------------------------------------------------------
// Task A3：model 分区集成——model 为 SETTINGS_SECTIONS 首位，openSettingsModal()
// 缺省打开模型设置；writing/skills/danger 保留。模型 DOM 随 replaceChildren 丢弃，
// 无整页宿主、无 restore 逻辑。
// ---------------------------------------------------------------------------

// modelSettings fake：记录 attach/open 调用（inject 供 modal 渲染 model 分区时调用）。
// isDirty 默认返回 false（clean），测试可覆写为固定值或断言调用。
function modelSettingsFake({ isDirty = () => false } = {}) {
  const calls = { attach: [], open: 0, isDirty: 0 };
  return {
    calls,
    attach: (targets) => { calls.attach.push(targets); },
    open: () => { calls.open += 1; },
    isDirty: () => { calls.isDirty += 1; return isDirty(); }
  };
}

// 创建 #settings-section-nav 挂载节点（renderSectionNav 用它渲染分区按钮）。
// 真实 index.html 静态包含该元素；测试经 document.createElement 注册进 domRegistry。
function installSectionNav() {
  const nav = document.createElement("nav");
  nav.id = "settings-section-nav";
  return nav;
}

test("currentSettingsSection 反映当前分区（缺省为第一个 = model）", async () => {
  const modal = createSettingsModalForTest({ modelSettings: modelSettingsFake() });
  await modal.openSettingsModal(); // 缺省分区 = 第一个（model）
  assert.equal(modal.currentSettingsSection(), "model");
  await modal.openSettingsModal("writing");
  assert.equal(modal.currentSettingsSection(), "writing");
  await modal.openSettingsModal("skills");
  assert.equal(modal.currentSettingsSection(), "skills");
  await modal.openSettingsModal("danger");
  assert.equal(modal.currentSettingsSection(), "danger");
  // 非法值回落第一个分区（model）。
  await modal.openSettingsModal("bogus");
  assert.equal(modal.currentSettingsSection(), "model");
});

// ---------------------------------------------------------------------------
// Task A3：openSettingsModal() 缺省打开 model 分区——nav 高亮、settingsDetail 含
// .model-section 结构、保存按钮「无需保存」disabled，modelSettings attach/open 被调用。
// ---------------------------------------------------------------------------

test("openSettingsModal()（无参）缺省打开 model 分区并注入渲染目标", async () => {
  const saveButton = new MockElement("button");
  const saveStatus = new MockElement("p");
  const fake = modelSettingsFake();
  const modal = createSettingsModalForTest({
    refs: { settingsSave: saveButton, settingsSaveStatus: saveStatus },
    modelSettings: fake
  });
  installSectionNav();
  await modal.openSettingsModal(); // 缺省 = model

  assert.equal(modal.currentSettingsSection(), "model", "无参缺省应为 model");

  // nav：模型设置项 aria-current=true
  const navItems = domRegistry.filter((el) => String(el.className ?? "").split(/\s+/u).includes("sp-section-item"));
  const modelNav = navItems.find((b) => b.dataset.section === "model");
  assert.ok(modelNav, "nav 应渲染模型设置项");
  assert.equal(modelNav.className.includes("on"), true, "模型设置项应高亮");
  assert.equal(modelNav.getAttribute("aria-current"), "true", "模型设置项 aria-current=true");

  // SETTINGS_SECTIONS 首位 = model（nav 顺序：模型设置/写作参数/Agent 技能/项目管理）
  assert.equal(navItems[0].dataset.section, "model", "nav 第一个分区应为 model");
  assert.deepEqual(navItems.map((b) => b.dataset.section), ["model", "writing", "skills", "danger"], "四分区 nav 顺序");

  // settingsDetail 内含 .model-section（h2/lead）与供应商列表/详情容器
  const detail = modal.getSettingsDetailForTest();
  const section = detail.children.find((el) => el.className === "model-section");
  assert.ok(section, "settingsDetail 应包含 .model-section");
  assert.ok(
    descendants(section).some((el) => el.tagName === "H2" && el.textContent === "模型设置"),
    ".model-section 应含「模型设置」h2"
  );
  assert.ok(
    descendants(section).some((el) => el.className === "model-section-lead"),
    ".model-section 应含 lead 说明"
  );
  assert.ok(
    descendants(section).some((el) => el.getAttribute?.("data-provider-list") !== null),
    "应渲染 [data-provider-list]"
  );
  assert.ok(
    descendants(section).some((el) => el.getAttribute?.("data-provider-detail") !== null),
    "应渲染 [data-provider-detail]"
  );

  // Round10：model 分区动作即时生效 → footer 显示状态文字，保存按钮隐藏
  assert.equal(saveButton.hidden, true, "model 分区保存按钮应隐藏");
  assert.equal(saveStatus.hidden, false, "状态槽应可见");
  assert.equal(saveStatus.textContent, "更改即时生效");

  // modelSettings.attach 收到注入的 list/detail 目标
  assert.equal(fake.calls.attach.length, 1, "modelSettings.attach 应被调用一次");
  const targets = fake.calls.attach[0];
  assert.ok(targets.list, "attach 应收到 list 目标");
  assert.ok(targets.detail, "attach 应收到 detail 目标");
  assert.equal(targets.list.getAttribute("data-provider-list"), "", "attach 的 list 应为 [data-provider-list] 容器");
  assert.equal(targets.detail.getAttribute("data-provider-detail"), "", "attach 的 detail 应为 [data-provider-detail] 容器");
  assert.equal(fake.calls.open, 1, "modelSettings.open 应被调用一次");
});

test("round10 footer: immediate sections show status text instead of a disabled primary button", async () => {
  installSectionNav();
  const settingsSave = new MockElement("button");
  const settingsSaveStatus = new MockElement("p");
  const modal = createSettingsModalForTest({
    refs: { settingsSave, settingsSaveStatus }
  });
  await modal.openSettingsModal("model");
  assert.equal(settingsSave.hidden, true);
  assert.equal(settingsSaveStatus.hidden, false);
  assert.equal(settingsSaveStatus.textContent, "更改即时生效");
});

test("round10 footer: 保存在途切分区再回来，按钮保持禁用与「保存中...」", async () => {
  const saveButton = new MockElement("button");
  const saveStatus = new MockElement("p");
  let releaseSave;
  const gate = new Promise((resolve) => { releaseSave = resolve; });
  const modal = createSettingsModalForTest({
    refs: { settingsSave: saveButton, settingsSaveStatus: saveStatus },
    getDashboard: () => ({ hasProject: true, project: { target_chapters: 5 } }),
    getCurrentProjectRoot: () => "D:/novels/demo",
    postJsonImpl: async () => gate
  });
  await modal.openSettingsModal("writing");
  const p = modal.saveSettingsForTest();
  await tickAsync();
  // 保存在途 → 切到 model 再切回 writing：setFooterMode 不得把在途按钮重新启用
  await modal.openSettingsModal("model");
  await modal.openSettingsModal("writing");
  assert.equal(saveButton.hidden, false, "writing 分区保存按钮可见");
  assert.equal(saveButton.disabled, true, "保存在途切回后按钮仍禁用");
  assert.equal(saveButton.textContent, "保存中...", "在途文案保留");
  // 保存完成 → 恢复可用
  releaseSave({ ok: true });
  await tickAsync();
  await tickAsync();
  assert.equal(saveButton.disabled, false, "保存完成后按钮恢复");
  await p;
});

test("model 分区切到 writing：detail 内容替换（无模型容器），modelSettings 不重复 attach", async () => {
  const saveButton = new MockElement("button");
  const fake = modelSettingsFake();
  const modal = createSettingsModalForTest({
    refs: { settingsSave: saveButton },
    modelSettings: fake,
    getDashboard: () => ({ hasProject: true, project: { target_chapters: 5 } }),
    getCurrentProjectRoot: () => "D:/novels/demo"
  });
  await modal.openSettingsModal("model");
  await tickAsync();
  assert.equal(fake.calls.attach.length, 1, "打开 model 后 attach 一次");

  // 切到 writing：detail 内容被替换，不再含 [data-provider-list]，保存按钮恢复
  await modal.openSettingsModal("writing");
  await tickAsync();
  const detail = modal.getSettingsDetailForTest();
  assert.equal(
    descendants(detail).some((el) => el.getAttribute?.("data-provider-list") !== null),
    false,
    "切到 writing 后 detail 不应再含模型容器"
  );
  assert.ok(
    descendants(detail).some((el) => el.className === "spd-field"),
    "writing 分区应正常渲染字段"
  );
  assert.equal(saveButton.disabled, false, "writing 分区保存按钮应恢复");
  assert.equal(fake.calls.attach.length, 1, "切到 writing 不应重复 attach modelSettings");
});

test("writing 切回 model：再次 attach + open；模型容器重建", async () => {
  const fake = modelSettingsFake();
  const modal = createSettingsModalForTest({
    modelSettings: fake,
    getDashboard: () => ({ hasProject: true, project: { target_chapters: 5 } }),
    getCurrentProjectRoot: () => "D:/novels/demo"
  });
  await modal.openSettingsModal("writing");
  await tickAsync();
  assert.equal(fake.calls.attach.length, 0, "writing 不 attach");

  await modal.openSettingsModal("model");
  await tickAsync();
  assert.equal(fake.calls.attach.length, 1, "切回 model 再次 attach");
  assert.equal(fake.calls.open, 1, "切回 model 再次 open");
  const detail = modal.getSettingsDetailForTest();
  assert.ok(
    descendants(detail).some((el) => el.getAttribute?.("data-provider-list") !== null),
    "切回 model 后应重建模型容器"
  );
});

test("openSettingsModal('writing') 显式打开 writing 分区不受影响", async () => {
  const fake = modelSettingsFake();
  const modal = createSettingsModalForTest({
    modelSettings: fake,
    getDashboard: () => ({ hasProject: true, project: { target_chapters: 5 } }),
    getCurrentProjectRoot: () => "D:/novels/demo"
  });
  await modal.openSettingsModal("writing");
  await tickAsync();
  assert.equal(modal.currentSettingsSection(), "writing");
  assert.equal(fake.calls.attach.length, 0, "显式 writing 不触达 modelSettings");
  assert.ok(
    descendants(modal.getSettingsDetailForTest()).some((el) => el.className === "spd-field"),
    "writing 分区正常渲染"
  );
});

test("closeSettingsModal 后无 restore 行为：模型 DOM 随 replaceChildren 丢弃，下次进入重建", async () => {
  const scrim = new MockElement("div");
  const fake = modelSettingsFake();
  const modal = createSettingsModalForTest({
    refs: { settingsScrim: scrim },
    modelSettings: fake
  });
  await modal.openSettingsModal("model");
  assert.equal(fake.calls.attach.length, 1);

  // 关闭（clean：model 分区无可挂起表单）应直接关闭，无 restore 钩子。
  const detailAfterClose = modal.getSettingsDetailForTest();
  modal.closeSettingsModal();
  assert.equal(scrim.classList.contains("show"), false, "model 分区 clean 关闭应直接生效");

  // 再次进入 model：attach 重建（无已脱离目标残留 restore）。
  await modal.openSettingsModal("model");
  assert.equal(fake.calls.attach.length, 2, "再次进入 model 应重新 attach");
  assert.equal(fake.calls.open, 2, "再次进入 model 应重新 open");
});

test("model 分区 dirty：isDirty 为 true 时关闭先弹确认层（复用 openDirtyCloseConfirm）", async () => {
  const scrim = new MockElement("div");
  const fake = modelSettingsFake({ isDirty: () => true });
  const modal = createSettingsModalForTest({
    refs: { settingsScrim: scrim },
    modelSettings: fake
  });
  await modal.openSettingsModal("model"); // 缺省分区 = model，open() 被调用

  modal.closeSettingsModal();
  assert.equal(fake.calls.isDirty >= 1, true, "model 分区关闭时应调用 modelSettings.isDirty()");
  assert.equal(scrim.classList.contains("show"), true, "model 分区 dirty 时关闭不应直接生效");
  const layer = findElementById("close-dirty-confirm");
  assert.ok(layer, "应出现「放弃未保存修改」确认层");
  assert.equal(layer.hidden, false, "确认层应可见");
  const copy = domRegistry.find((el) => String(el.className).includes("spd-confirm-copy"));
  assert.match(copy.textContent, /未保存的修改/u, "确认文案应说明未保存修改会丢失");

  // 取消：确认层关闭，弹窗保持打开
  findElementById("close-dirty-cancel")._fire("click");
  assert.equal(findElementById("close-dirty-confirm").hidden, true, "取消后确认层关闭");
  assert.equal(scrim.classList.contains("show"), true, "取消后弹窗保持打开");

  // 再次关闭：确认放弃后真正关闭
  modal.closeSettingsModal();
  findElementById("close-dirty-confirm-btn")._fire("click");
  assert.equal(scrim.classList.contains("show"), false, "模型 dirty 确认放弃后弹窗关闭");
});

test("model 分区 clean：isDirty 为 false 时关闭直接生效，不弹确认层", async () => {
  const scrim = new MockElement("div");
  const fake = modelSettingsFake({ isDirty: () => false });
  const modal = createSettingsModalForTest({
    refs: { settingsScrim: scrim },
    modelSettings: fake
  });
  await modal.openSettingsModal("model");

  modal.closeSettingsModal();
  assert.equal(fake.calls.isDirty >= 1, true, "model 分区关闭时应调用 modelSettings.isDirty()");
  assert.equal(findElementById("close-dirty-confirm"), null, "clean 关闭不应出现确认层");
  assert.equal(scrim.classList.contains("show"), false, "model 分区 clean 关闭应直接生效");
});

test("modelSettings 无 isDirty 时 model 分区关闭直接生效（回退 clean）", async () => {
  const scrim = new MockElement("div");
  // 显式不提供 isDirty（旧版注入形态）：
  const fake = {
    calls: { attach: [], open: 0 },
    attach: () => {},
    open: () => {}
  };
  const modal = createSettingsModalForTest({
    refs: { settingsScrim: scrim },
    modelSettings: fake
  });
  await modal.openSettingsModal("model");
  modal.closeSettingsModal();
  assert.equal(findElementById("close-dirty-confirm"), null, "无 isDirty 时不判脏");
  assert.equal(scrim.classList.contains("show"), false, "model 分区关闭应直接生效");
});

test("幂等性：连续两次 openSettingsModal('model') 不产生重复挂载", async () => {
  const fake = modelSettingsFake();
  const modal = createSettingsModalForTest({ modelSettings: fake });
  await modal.openSettingsModal("model");
  await modal.openSettingsModal("model");
  const detail = modal.getSettingsDetailForTest();
  const lists = descendants(detail).filter((el) => el.getAttribute?.("data-provider-list") !== null);
  assert.equal(lists.length, 1, "model 分区只应挂载一个 [data-provider-list]");
  const sections = detail.children.filter((el) => el.className === "model-section");
  assert.equal(sections.length, 1, "model 分区只应有一个 .model-section");
  assert.equal(fake.calls.attach.length, 2, "每次进入 model 各 attach 一次（无重复 DOM 挂载）");
});

// 辅助：root 下递归收集（model 分区断言用，替代 domRegistry 的累积语义）。
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
// Task 14：普通文件夹（hasProject:false）下写作参数/项目管理分区只显示说明，
// 保存禁用，绝不向 /api/settings/update 发旧版小说项目专属的写请求。
// ---------------------------------------------------------------------------

test("普通文件夹下写作参数分区显示说明且保存按钮禁用", async () => {
  const saveButton = new MockElement("button");
  const saveStatus = new MockElement("p");
  const postCalls = [];
  const modal = createSettingsModalForTest({
    refs: { settingsSave: saveButton, settingsSaveStatus: saveStatus },
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
  assert.equal(saveButton.hidden, true, "普通文件夹下保存按钮应隐藏");
  assert.equal(saveStatus.textContent, "此分区无需保存", "footer 状态槽显示无需保存");

  await modal.saveSettingsForTest();
  assert.equal(postCalls.some((c) => c.url === "/api/settings/update"), false, "保存不得向 /api/settings/update 发请求");
});

test("普通文件夹下项目管理分区显示说明且无归档按钮", async () => {
  const saveButton = new MockElement("button");
  const saveStatus = new MockElement("p");
  const modal = createSettingsModalForTest({
    refs: { settingsSave: saveButton, settingsSaveStatus: saveStatus },
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
  assert.equal(saveButton.hidden, true, "保存按钮保持隐藏");
  assert.equal(saveStatus.textContent, "此分区无需保存");
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

// 返回最后匹配：domRegistry 累积历史元素（replaceChildren 不清注册表），
// 后创建的元素 ≈ 当前仍挂载（与 model-settings-page.test.mjs 的 mock 约定一致）。
function findElementById(id) {
  let hit = null;
  for (const el of domRegistry) {
    if (el.id === id) hit = el;
  }
  return hit;
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
// F2：内置写作风格技能——普通行（含「内置」来源标签），无只读分区
// ---------------------------------------------------------------------------

const STYLE_NAMES = new Set(["balanced", "fast-readable", "psychological-literary"]);

const STYLE_SKILLS_CATALOG = {
  ok: true,
  has_project: true,
  project_root: "D:/novels/demo",
  active: [
    { name: "suspense-chapter-end", source: "builtin", description: "章节结尾悬念" },
    { name: "my-style", source: "global", description: "我的文风" },
    { name: "balanced", source: "builtin", description: "在情节、人物、描写与可读性之间保持均衡；生成、续写、改写、润色或审核中文小说正文时使用。", category: "writing-style", display_name: "均衡" },
    { name: "fast-readable", source: "builtin", description: "用清楚因果、直接冲突和易扫读段落写快节奏中文网文正文。", category: "writing-style", display_name: "快节奏易读" },
    { name: "psychological-literary", source: "builtin", description: "在大众网文可读性内加强人物动机、心理变化与潜台词，不写晦涩意识流。", category: "writing-style", display_name: "心理文学" }
  ],
  shadowed: [
    { name: "balanced", source: "project", description: "项目伪造版本", shadow_reason: "shadowed_by_project" }
  ],
  migration_errors: []
};

test("内置写作风格技能显示为普通行（含「内置」来源标签），无删除按钮", async () => {
  const modal = createSettingsModalForTest({
    getCurrentProjectRoot: () => "D:/novels/demo",
    getJsonImpl: catalogJsonImpl(STYLE_SKILLS_CATALOG)
  });
  await modal.openSettingsModal("skills");
  await modal.waitForSkillsCatalog();

  const styleRows = modal.getSkillsRowsForTest().filter((r) => STYLE_NAMES.has(r.name));
  assert.equal(styleRows.length, 3, "三个内置写作风格都应进入普通技能列表");
  for (const row of styleRows) {
    assert.equal(row.source, "builtin", `${row.name} 来源应标记为 builtin`);
    assert.equal(row.deletable, false, `${row.name} 行不得有删除按钮`);
  }
  // 行上应有「内置」来源标签（SKILL_SOURCE_LABELS 映射）。
  const list = findElementById("skills-list");
  for (const name of STYLE_NAMES) {
    const rowEl = list.children.find((el) => el.className === "spd-skill-row" && el.dataset.skillName === name);
    assert.ok(rowEl, `${name} 应渲染为普通技能行`);
    const src = findDescendantByClassName(rowEl, "spd-skill-source");
    assert.ok(src, `${name} 行应渲染来源标签`);
    assert.equal(src.textContent, "内置", `${name} 行来源标签应为「内置」`);
  }
});

test("shadowed 项显示通用优先级覆盖说明且不可删除", async () => {
  const modal = createSettingsModalForTest({
    getCurrentProjectRoot: () => "D:/novels/demo",
    getJsonImpl: catalogJsonImpl(STYLE_SKILLS_CATALOG)
  });
  await modal.openSettingsModal("skills");
  await modal.waitForSkillsCatalog();

  const shadowedRows = domRegistry.filter((el) => el.className === "spd-skill-row shadowed");
  const shadowedRow = shadowedRows.find((r) => r.dataset.skillName === "balanced");
  assert.ok(shadowedRow, "被覆盖副本应出现在被覆盖区");
  assert.equal(shadowedRow.dataset.shadowReason, "shadowed_by_project");
  const shadowMain = shadowedRow.children.find((c) => c.className === "spd-skill-main");
  const desc = shadowMain?.children.find((c) => c.className === "spd-skill-desc");
  assert.ok(desc, "shadowed 行应包含说明文本");
  assert.ok(desc.textContent.includes("被更高优先级同名技能覆盖"), "shadowed 应显示通用优先级覆盖说明");
  assert.ok(!desc.textContent.includes("保留名称"), "shadowed 不得再显示保留名称专有文案");
  assert.equal(
    [...shadowedRow.children].some((c) => c.className === "spd-skill-del"),
    false,
    "shadowed 行不得有删除按钮"
  );
});

// ---------------------------------------------------------------------------
// Task 12：设置技能分区无卡片行契约 + 内置风格普通行（不破坏自定义技能管理）
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

test("内置技能普通行：无删除/编辑/启停控件；自定义技能管理能力仍存在", async () => {
  const modal = createSettingsModalForTest({
    getCurrentProjectRoot: () => "D:/novels/demo",
    getJsonImpl: catalogJsonImpl(STYLE_SKILLS_CATALOG)
  });
  await modal.openSettingsModal("skills");
  await modal.waitForSkillsCatalog();

  // F2：内置技能与项目技能一样走普通行渲染（来源标签区分），无独立只读分区。
  const rows = modal.getSkillsRowsForTest();
  const builtinRows = rows.filter((r) => r.source === "builtin");
  assert.equal(builtinRows.length, 4, "四个内置技能（三个风格 + suspense-chapter-end）都应进入普通列表");
  for (const row of builtinRows) {
    assert.equal(row.deletable, false, `${row.name} 内置技能行不得有删除按钮`);
  }
  // 内置行内部不得出现任何 toggle/edit/delete 类子控件（普通行只有名称/说明文本）。
  const list = findElementById("skills-list");
  const builtinEls = list.children.filter(
    (el) => el.className === "spd-skill-row" && el.dataset.skillSource === "builtin"
  );
  for (const rowEl of builtinEls) {
    const hasChildControls = rowEl.children.some(
      (c) => c.tagName === "BUTTON" || /spd-skill-(?:del|edit)|toggle|switch/u.test(String(c.className ?? ""))
    );
    assert.equal(hasChildControls, false, "内置技能行内不得出现任何 toggle/edit/delete 控件");
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

  // 用户切到技能分区（Task 13：异步 catalog 渲染，是另一种非模型分区）。
  await modal.openSettingsModal("skills");
  await modal.waitForSkillsCatalog();
  resolveRestore({ ok: true });
  await tickAsync();
  await tickAsync();

  // 完成时不得把当前技能分区整体替换成项目管理内容（技能分区内容不丢）。
  const detail = modal.getSettingsDetailForTest();
  const classes = detail.children.map((el) => String(el.className ?? ""));
  assert.ok(classes.includes("spd-head"), "技能分区内容应保留");
  assert.equal(classes.includes("spd-archived-list"), false, "不得重渲为项目管理分区");
});

// ---------------------------------------------------------------------------
// Task 16：runSave 保存序号条件化收尾（B18）
// ---------------------------------------------------------------------------

test("B18：连续两次保存——旧 save 的迟到失败不得恢复按钮/提示（save sequence 条件化收尾）", async () => {
  const saveButton = new MockElement("button");
  const toasts = [];
  let releaseFirst, releaseSecond;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  let postCalls = 0;
  const modal = createSettingsModalForTest({
    refs: { settingsSave: saveButton },
    getDashboard: () => ({ hasProject: true, project: { target_chapters: 5 } }),
    getCurrentProjectRoot: () => "D:/novels/demo",
    loadDashboard: async () => {},
    showToast: (message, kind) => toasts.push({ message, kind }),
    postJsonImpl: async () => {
      postCalls += 1;
      return postCalls === 1 ? firstGate : secondGate;
    }
  });
  await modal.openSettingsModal("writing");
  await tickAsync();

  const p1 = modal.saveSettingsForTest(); // save 1：慢（deferred）
  await tickAsync();
  assert.equal(saveButton.disabled, true, "save 1 在途：按钮禁用");
  assert.equal(saveButton.textContent, "保存中...");

  const p2 = modal.saveSettingsForTest(); // save 2：同样慢（deferred）
  await tickAsync();

  // save 1 迟到失败：不得恢复按钮/覆盖文案/弹错误 toast（save 2 仍拥有按钮）
  releaseFirst(Promise.reject(new Error("网络错误")));
  await tickAsync();
  await tickAsync();
  assert.equal(saveButton.disabled, true, "旧 save 的 finally 不得恢复按钮（新 save 仍在途）");
  assert.equal(saveButton.textContent, "保存中...", "旧 save 的 catch 不得覆盖按钮文案");
  assert.deepEqual(toasts, [], "旧 save 的迟到失败不弹 toast");

  // save 2 成功：正常显示已保存反馈
  releaseSecond({ ok: true });
  await tickAsync();
  await tickAsync();
  assert.equal(saveButton.textContent, "已保存", "新 save 成功反馈不被旧 save 干扰");
  await p1;
  await p2;
});

// ---------------------------------------------------------------------------
// Task 22：可访问性（焦点管理 + popover ARIA）与关闭保护（dirty 先确认）
// ---------------------------------------------------------------------------

test("打开设置弹窗：焦点移入弹窗内首个可聚焦元素（§6.5 键盘焦点顺序）", async () => {
  const scrim = new MockElement("div");
  const firstFocusable = new MockElement("button");
  let focusCalls = 0;
  firstFocusable.focus = () => { focusCalls += 1; };
  scrim.querySelectorAll = () => [firstFocusable];
  const modal = createSettingsModalForTest({ refs: { settingsScrim: scrim } });
  await modal.openSettingsModal("writing");
  assert.equal(focusCalls, 1, "打开后应聚焦弹窗内首个可聚焦元素（否则焦点停留在触发按钮，Tab 可逃出弹窗）");
});

test("打开设置弹窗：隐藏/禁用的首元素不接收焦点（Minor 4：窄窗 .sp-side 隐藏场景）", async () => {
  const scrim = new MockElement("div");
  const hiddenFirst = new MockElement("button");
  hiddenFirst.offsetParent = null; // 隐藏元素（真实 DOM offsetParent === null）
  const disabledSecond = new MockElement("button");
  disabledSecond.disabled = true;
  const visibleThird = new MockElement("button");
  let focusCalls = 0;
  visibleThird.focus = () => { focusCalls += 1; };
  scrim.querySelectorAll = () => [hiddenFirst, disabledSecond, visibleThird];
  const modal = createSettingsModalForTest({ refs: { settingsScrim: scrim } });
  await modal.openSettingsModal("writing");
  assert.equal(focusCalls, 1, "焦点应落在第一个可见且可用的元素（跳过隐藏/禁用）");
});

test("Tab 在设置弹窗内循环：首末元素回绕（focus trap）", async () => {
  const scrim = new MockElement("div");
  scrim.classList.add("show");
  const first = new MockElement("button");
  const last = new MockElement("button");
  let firstFocused = 0;
  let lastFocused = 0;
  first.focus = () => { firstFocused += 1; };
  last.focus = () => { lastFocused += 1; };
  scrim.querySelectorAll = () => [first, last];
  createSettingsModalForTest({ refs: { settingsScrim: scrim } });

  // 正向：焦点在最后一个元素 → Tab 回绕到第一个
  globalThis.document.activeElement = last;
  let prevented = 0;
  scrim._fire("keydown", { key: "Tab", shiftKey: false, preventDefault: () => { prevented += 1; } });
  assert.equal(prevented, 1, "末元素正向 Tab 应被拦截");
  assert.equal(firstFocused, 1, "焦点应回绕到第一个元素");

  // 反向：焦点在第一个元素 → Shift+Tab 回绕到最后一个
  globalThis.document.activeElement = first;
  scrim._fire("keydown", { key: "Tab", shiftKey: true, preventDefault: () => { prevented += 1; } });
  assert.equal(prevented, 2, "首元素反向 Tab 应被拦截");
  assert.equal(lastFocused, 1, "焦点应回绕到最后一个元素");

  // 弹窗关闭（非 show）时不拦截
  scrim.classList.remove("show");
  scrim._fire("keydown", { key: "Tab", shiftKey: false, preventDefault: () => { prevented += 1; } });
  assert.equal(prevented, 2, "弹窗未打开时 Tab 不应被拦截");
});

test("写作参数有未保存修改：关闭先确认（现有确认控件，不调用 window.confirm）", async () => {
  const scrim = new MockElement("div");
  const confirms = [];
  const modal = createSettingsModalForTest({
    refs: { settingsScrim: scrim },
    getDashboard: () => ({ hasProject: true, project: { target_chapters: 5 } }),
    getCurrentProjectRoot: () => "D:/novels/demo",
    confirmImpl: (message) => { confirms.push(message); return true; }
  });
  await modal.openSettingsModal("writing");
  await tickAsync();

  // 修改目标章节数字段的值（不触发 change，模拟「编辑了但未保存」）。
  const detail = modal.getSettingsDetailForTest();
  const targetField = detail.children.find((el) => String(el.className).includes("spd-field"));
  const targetInput = targetField.children.find((c) => c.tagName === "INPUT");
  targetInput.value = "99";

  modal.closeSettingsModal();
  assert.equal(scrim.classList.contains("show"), true, "有未保存修改时关闭不应直接生效");
  const layer = findElementById("close-dirty-confirm");
  assert.ok(layer, "应出现「放弃未保存修改」确认层");
  assert.equal(layer.hidden, false, "确认层应可见");
  assert.deepEqual(confirms, [], "关闭确认不得使用 window.confirm（confirmImpl 不被调用）");
  const copy = domRegistry.find((el) => String(el.className).includes("spd-confirm-copy"));
  assert.match(copy.textContent, /未保存的修改/u, "确认文案应说明未保存修改会丢失");

  // 取消：确认层关闭，弹窗保持打开
  findElementById("close-dirty-cancel")._fire("click");
  assert.equal(findElementById("close-dirty-confirm").hidden, true, "取消后确认层关闭");
  assert.equal(scrim.classList.contains("show"), true, "取消后弹窗保持打开");

  // 再次关闭：确认放弃后真正关闭
  modal.closeSettingsModal();
  assert.equal(findElementById("close-dirty-confirm").hidden, false, "仍有未保存修改时再次弹出确认");
  findElementById("close-dirty-confirm-btn")._fire("click");
  assert.equal(scrim.classList.contains("show"), false, "确认放弃后弹窗关闭");
});

test("Escape 对 dirty 状态先确认：先弹确认层，二次 Esc 只关确认层", async () => {
  const scrim = new MockElement("div");
  const modal = createSettingsModalForTest({
    refs: { settingsScrim: scrim },
    getDashboard: () => ({ hasProject: true, project: { target_chapters: 5 } }),
    getCurrentProjectRoot: () => "D:/novels/demo"
  });
  await modal.openSettingsModal("writing");
  await tickAsync();
  const targetField = modal.getSettingsDetailForTest().children.find((el) => String(el.className).includes("spd-field"));
  const targetInput = targetField.children.find((c) => c.tagName === "INPUT");
  targetInput.value = "99";

  let prevented = 0;
  scrim._fire("keydown", { key: "Escape", stopPropagation: () => {}, preventDefault: () => { prevented += 1; } });
  assert.equal(prevented, 1, "弹窗级 Esc 应被设置弹窗消费（阻断全局路由）");
  assert.equal(findElementById("close-dirty-confirm").hidden, false, "Esc 应先弹出确认层");
  assert.equal(scrim.classList.contains("show"), true, "确认前弹窗不关闭");

  // 二次 Esc：确认层是当前最上层 → 只关确认层，不关弹窗
  let stopped = 0;
  document._fire("keydown", {
    key: "Escape",
    stopImmediatePropagation: () => { stopped += 1; },
    preventDefault: () => {}
  });
  assert.equal(stopped, 1, "确认层的 Esc 应被嵌套层消费");
  assert.equal(findElementById("close-dirty-confirm").hidden, true, "二次 Esc 关闭确认层");
  assert.equal(scrim.classList.contains("show"), true, "弹窗保持打开");
});

test("无未保存修改时 Esc 直接关闭弹窗并恢复原焦点", async () => {
  const scrim = new MockElement("div");
  const restoreSpy = new MockElement("button");
  let restoreCalls = 0;
  restoreSpy.focus = () => { restoreCalls += 1; };
  restoreSpy.isConnected = true;
  let captured = null;
  const modal = createSettingsModalForTest({
    refs: { settingsScrim: scrim },
    getLastFocused: () => captured,
    setLastFocused: (el) => { captured = el; }
  });
  // 模拟打开前焦点在触发按钮上：打开时应记录为原焦点。
  globalThis.document.activeElement = restoreSpy;
  await modal.openSettingsModal("writing");
  assert.equal(captured, restoreSpy, "打开时应记录原焦点（setLastFocused(document.activeElement)）");
  assert.equal(findElementById("close-dirty-confirm"), null, "无修改时不应出现确认层");

  scrim._fire("keydown", { key: "Escape", stopPropagation: () => {}, preventDefault: () => {} });
  assert.equal(scrim.classList.contains("show"), false, "clean 状态 Esc 直接关闭弹窗");
  assert.equal(scrim.getAttribute("inert"), "", "关闭后弹窗应置 inert");
  assert.equal(restoreCalls, 1, "关闭动画完成后应恢复原焦点");
  assert.equal(captured, null, "恢复焦点后应清空记录");
});

test("添加技能菜单：role=menu/menuitem、aria-expanded 同步，Esc 只关菜单（popover 键盘/ARIA）", async () => {
  const scrim = new MockElement("div");
  const modal = createSettingsModalForTest({
    refs: { settingsScrim: scrim },
    getCurrentProjectRoot: () => "D:/novels/demo",
    getJsonImpl: catalogJsonImpl(SKILLS_CATALOG)
  });
  await modal.openSettingsModal("skills");
  await modal.waitForSkillsCatalog();

  const addBtn = findElementById("skills-add");
  const menuEl = domRegistry.find((el) => el.className === "spd-addmenu-pop");
  assert.ok(addBtn, "应有「添加技能」触发按钮");
  assert.ok(menuEl, "应有添加菜单 popover");
  assert.equal(addBtn.getAttribute("aria-haspopup"), "menu", "触发按钮应声明菜单 popover");
  assert.equal(addBtn.getAttribute("aria-expanded"), "false", "菜单收起时 aria-expanded=false");
  assert.equal(menuEl.getAttribute("role"), "menu", "popover 应有 role=menu");
  for (const item of menuEl.children) {
    assert.equal(item.getAttribute("role"), "menuitem", "菜单项应有 role=menuitem");
  }

  // 点击展开：aria-expanded 同步
  addBtn._fire("click");
  assert.equal(addBtn.getAttribute("aria-expanded"), "true", "展开后 aria-expanded=true");
  const addWrap = domRegistry.find((el) => el.className === "spd-addmenu");
  assert.equal(addWrap.classList.contains("open"), true, "点击后菜单应展开");

  // Esc 只关菜单，不关弹窗（popover 键盘关闭）
  let stopped = 0;
  document._fire("keydown", {
    key: "Escape",
    stopImmediatePropagation: () => { stopped += 1; },
    preventDefault: () => {}
  });
  assert.equal(stopped, 1, "菜单的 Esc 应被消费（阻断弹窗级关闭）");
  assert.equal(addBtn.getAttribute("aria-expanded"), "false", "Esc 关闭菜单后 aria-expanded=false");
  assert.equal(scrim.classList.contains("show"), true, "Esc 不得关闭设置弹窗");
});
