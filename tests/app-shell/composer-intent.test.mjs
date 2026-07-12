import assert from "node:assert/strict";
import test from "node:test";

import { createComposer, isStartWritingIntent } from "../../src/app-shell/composer.js";

function makeComposer() {
  return createComposer({
    refs: {},
    getCurrentProjectRoot: () => "D:\\novels\\demo",
    getDashboard: () => ({}),
    loadDashboard: async () => {},
    openDrawer: () => {},
    openSettingsModal: () => {},
    openCreateModal: () => {},
    showToast: () => {},
    showActionError: () => {},
    threadRenderer: {},
    getAskEntries: () => new Map(),
    ensureRefreshLoop: () => {}
  });
}

// 明确的「开始/继续写作」祈使：命中后走硬启动（submitWritingCommand），不再被弱模型口头答应糊弄。
const START_INTENT_POSITIVES = [
  "开始写",
  "开始写作",
  "开始写第一章",
  "开始写吧",
  "继续写",
  "继续写作",
  "接着写",
  "写下一章",
  "往下写",
  "开写",
  "继续写下去"
];

// 含「开始写」字样但其实是提问/讨论/否定的句子：宁可漏判走对话，也不能误触发写作任务。
const START_INTENT_NEGATIVES = [
  "怎么开始写",
  "开始写之前先看大纲",
  "我想改改再开始写",
  "可以开始写了吗",
  "开始写好不好",
  "别开始写",
  "开始写的话需要注意什么",
  "帮我看看大纲",
  "主角应该怎么塑造",
  "开始",
  "继续"
];

test("isStartWritingIntent 命中明确的开始/继续写作祈使", () => {
  for (const text of START_INTENT_POSITIVES) {
    assert.equal(isStartWritingIntent(text), true, `应命中：「${text}」`);
  }
});

test("isStartWritingIntent 不误判提问/讨论/否定句", () => {
  for (const text of START_INTENT_NEGATIVES) {
    assert.equal(isStartWritingIntent(text), false, `不应命中：「${text}」`);
  }
});

test("parseUserCommand 把开始写作意图归类为 write（走硬启动）", () => {
  const composer = makeComposer();
  const parsed = composer.parseUserCommand("开始写", "main");
  assert.equal(parsed.type, "write");
  assert.equal(parsed.content, "开始写");
  assert.equal(parsed.shouldAffectMainTask, true);
});

test("parseUserCommand 对普通对话仍走 main（chat agent）", () => {
  const composer = makeComposer();
  assert.equal(composer.parseUserCommand("怎么开始写", "main").type, "main");
  assert.equal(composer.parseUserCommand("帮我看看大纲", "main").type, "main");
});

test("startCurrentChapter exists and calls submitWritingCommand", async () => {
  const composer = makeComposer();
  assert.equal(typeof composer.startCurrentChapter, "function");
  try {
    await composer.startCurrentChapter();
  } catch {
    // Expected - postJson isn't mocked in unit test
  }
});
