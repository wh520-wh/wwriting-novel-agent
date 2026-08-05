// /init 用户触发入口测试（spec §1.4 P1 修复）：
// 1) parseUserCommand 把 "/init [题材]" 归类为 init（显式触发蓝图初始化）
// 2) /init 已注册进 slash 命令注册表（可被斜杠菜单唤起）
// 3) /init 通过普通 chat/send 提交，保留命令和自然语言要求
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { createComposer } from "../../src/app-shell/composer.js";
import { getCommand, listCommands } from "../../src/app-shell/command-registry.mjs";

function makeComposer(refs = {}) {
  return createComposer({ ...makeComposerContext(), refs });
}

let calls = [];

beforeEach(() => {
  calls = [];
  ctxState.loaded = 0;
  ctxState.refreshed = 0;
  ctxState.errors = [];
  globalThis.window = { setInterval: () => 0, clearInterval() {}, setTimeout };
  globalThis.document = {
    createElement: () => ({
      dataset: {}, append() {}, appendChild() {}, remove() {}, setAttribute() {},
      addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} }
    }),
    getElementById: () => null,
    addEventListener() {}, removeEventListener() {}
  };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
  };
});

afterEach(() => {
  delete globalThis.fetch;
  delete globalThis.window;
  delete globalThis.document;
});

function makeRefs() {
  const thread = { append() {} };
  return {
    composerInput: { value: "", style: {}, scrollHeight: 48, setAttribute() {}, removeAttribute() {}, focus() {} },
    composerSubmit: { disabled: false, setAttribute() {}, removeAttribute() {} },
    slashMenu: { hidden: true, replaceChildren() {} },
    thread,
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

test("/init 通过普通 chat/send 提交，保留命令和自然语言要求", async () => {
  const refs = makeRefs();
  refs.composerInput.value = "/init 重点核对人物关系";
  const composer = createComposer({ ...makeComposerContext(), refs });
  await composer.submitText(refs.composerInput.value);
  assert.equal(calls[0].url, "/api/chat/send");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    projectRoot: "D:\\novels\\demo",
    message: "/init 重点核对人物关系",
    command: "init",
    commandArgs: "重点核对人物关系"
  });
});

function makeComposerContext() {
  return {
    getCurrentProjectRoot: () => "D:\\novels\\demo",
    getDashboard: () => ({}),
    loadDashboard: async () => { ctxState.loaded += 1; },
    openDrawer: () => {},
    openSettingsModal: () => {},
    openCreateModal: () => {},
    showToast: () => {},
    showActionError: (err) => { ctxState.errors.push(err.message); },
    threadRenderer: {
      renderChatMessage: () => ({ dataset: {}, isConnected: false, remove() {} }),
      scrollThreadToBottom() {},
    },
    getAskEntries: () => new Map(),
    ensureRefreshLoop: () => { ctxState.refreshed += 1; },
  };
}

const ctxState = { loaded: 0, refreshed: 0, errors: [] };
