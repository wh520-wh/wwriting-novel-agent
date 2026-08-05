// /init 用户触发入口测试（spec §1.4 P1 修复）：
// 1) parseUserCommand 把 "/init [题材]" 归类为 init（显式触发蓝图初始化）
// 2) submitBlueprintInit 调 POST /api/projects/init-blueprint，成功刷新、失败保留草稿
// 3) /init 已注册进 slash 命令注册表（可被斜杠菜单唤起）
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { createComposer } from "../../src/app-shell/composer.js";
import { getCommand, listCommands } from "../../src/app-shell/command-registry.mjs";

function makeComposer(refs = {}) {
  return createComposer({ ...makeComposerContext(), refs });
}

let calls = [];
let failNext = false;
let toasts = [];

beforeEach(() => {
  calls = [];
  failNext = false;
  toasts = [];
  ctxState.loaded = 0;
  ctxState.refreshed = 0;
  ctxState.errors = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    const ok = !failNext;
    return {
      ok,
      status: ok ? 200 : 400,
      text: async () => JSON.stringify(ok
        ? { ok: true, blueprint_status: "complete" }
        : { ok: false, code: "blueprint_init_failed", message: "生成失败" }),
    };
  };
});

afterEach(() => {
  delete globalThis.fetch;
});

function makeRefs() {
  return {
    composerInput: { value: "", style: {}, scrollHeight: 48, setAttribute() {}, removeAttribute() {}, focus() {} },
    composerSubmit: { disabled: false, setAttribute() {}, removeAttribute() {} },
    slashMenu: { hidden: true, replaceChildren() {} },
  };
}

test("parseUserCommand 把 /init 归类为 init（题材作为参数）", () => {
  const composer = makeComposer();
  const parsed = composer.parseUserCommand("/init 玄幻小说", "main");
  assert.equal(parsed.type, "init");
  assert.equal(parsed.content, "玄幻小说");
  assert.equal(parsed.shouldAffectMainTask, true);

  assert.equal(composer.parseUserCommand("/init", "main").type, "init");
  assert.equal(composer.parseUserCommand("/init", "main").content, "");
  assert.equal(composer.parseUserCommand("/初始化 仙侠", "main").content, "仙侠");
});

test("/init 已注册进 slash 命令注册表", () => {
  const cmd = getCommand("init");
  assert.ok(cmd, "应有 init 命令");
  assert.equal(cmd.slashKey, "/init");
  assert.equal(cmd.userInvocable, true);
  const invocable = listCommands({ userInvocable: true }).map((c) => c.name);
  assert.ok(invocable.includes("init"), "init 应出现在可唤起命令列表");
});

test("submitBlueprintInit 调 POST /api/projects/init-blueprint，成功后清空输入并刷新", async () => {
  const ctx = makeComposerContext();
  const refs = makeRefs();
  const composer = createComposer({ ...ctx, refs });

  await composer.submitBlueprintInit("玄幻小说");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/projects/init-blueprint");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.projectRoot, "D:\\novels\\demo");
  assert.equal(body.requirements, "玄幻小说");
  assert.equal(refs.composerInput.value, "", "成功后清空输入框");
  assert.equal(ctxState.loaded, 1, "成功后刷新 dashboard");
  assert.equal(ctxState.refreshed, 1, "成功后开启刷新循环");
  assert.equal(refs.composerSubmit.disabled, true, "输入清空后提交按钮随输入态置灰");
});

test("submitBlueprintInit 空 requirements 也发送（服务端走默认玄幻模板兜底）", async () => {
  const refs = makeRefs();
  const composer = createComposer({ ...makeComposerContext(), refs });

  await composer.submitBlueprintInit("");

  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].options.body).requirements, "");
});

test("submitBlueprintInit 空 requirements 提示默认方向（文案含「从故事设定推断」，不硬编码必然玄幻）", async () => {
  const composer = createComposer({ ...makeComposerContext(), refs: makeRefs() });
  await composer.submitBlueprintInit("");

  const toast = toasts.find((t) => t.msg.includes("从故事设定推断"));
  assert.ok(toast, "空需求应弹出默认方向提示");
  assert.equal(toast.level, "info");
  assert.ok(toast.msg.includes("东方玄幻"), "文案说明推断不到时的兜底方向");
});

test("submitBlueprintInit 非空 requirements 不弹默认方向提示", async () => {
  const composer = createComposer({ ...makeComposerContext(), refs: makeRefs() });
  await composer.submitBlueprintInit("都市");

  assert.ok(!toasts.some((t) => t.msg.includes("从故事设定推断")), "显式题材时不提示默认方向");
});

test("submitBlueprintInit 失败：报错保留输入，不刷新", async () => {
  failNext = true;
  const ctx = makeComposerContext();
  const refs = makeRefs();
  refs.composerInput.value = "/init 玄幻";
  const composer = createComposer({ ...ctx, refs });

  await assert.rejects(() => composer.submitBlueprintInit("玄幻"), /生成失败/);
  assert.equal(refs.composerInput.value, "/init 玄幻", "失败时保留输入内容");
  assert.equal(ctxState.loaded, 0);
  assert.ok(ctxState.errors.length >= 1, "失败走 showActionError");
  assert.equal(refs.composerSubmit.disabled, false, "恢复提交按钮");
});

function makeComposerContext() {
  return {
    getCurrentProjectRoot: () => "D:\\novels\\demo",
    getDashboard: () => ({}),
    loadDashboard: async () => { ctxState.loaded += 1; },
    openDrawer: () => {},
    openSettingsModal: () => {},
    openCreateModal: () => {},
    showToast: (msg, level) => { toasts.push({ msg, level }); },
    showActionError: (err) => { ctxState.errors.push(err.message); },
    threadRenderer: {},
    getAskEntries: () => new Map(),
    ensureRefreshLoop: () => { ctxState.refreshed += 1; },
  };
}

const ctxState = { loaded: 0, refreshed: 0, errors: [] };
