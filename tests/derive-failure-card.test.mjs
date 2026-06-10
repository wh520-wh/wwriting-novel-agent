import test from "node:test";
import assert from "node:assert/strict";
import { deriveFailureCard } from "../src/core/derive-failure-card.mjs";

test("words-short 卡读取 min_words 并产出扁平 action", () => {
  const card = deriveFailureCard({
    id: "f1",
    ts: "2026-06-10T00:00:00Z",
    type: "quality_gate_failed",
    message: "word-count gate failed",
    chapter_no: 3,
    data: { gate: "word-count", status: "failed", actual_words: 2380, min_words: 3200, shortfall: 820 }
  }, { current_chapter_no: 3 });
  assert.equal(card.kind, "words-short");
  assert.ok(card.body.includes("3200"), `body 应包含门槛字数: ${card.body}`);
  assert.equal(card.actions[0].command, "fill-words");
  assert.equal(card.actions[0].args.targetWords, 820);
  for (const action of card.actions) {
    assert.equal(typeof action.command, "string", "action.command 必须是命令名字符串");
    assert.equal(typeof action.args, "object");
  }
});

test("budget 卡读取 max_model_calls/model_calls 并按真实预算翻倍", () => {
  const card = deriveFailureCard({
    id: "f2",
    ts: "2026-06-10T00:00:00Z",
    type: "project_blocked",
    message: "model_call_budget_exhausted",
    chapter_no: 5,
    data: { model_calls: 120, max_model_calls: 120 }
  }, {});
  assert.equal(card.kind, "budget-exhausted");
  assert.ok(card.body.includes("120 / 120"), `body: ${card.body}`);
  assert.equal(card.actions[0].command, "raise-budget");
  assert.equal(card.actions[0].args.newMaxModelCalls, 240);
});

test("provider-error 卡的 switch-model 文案引导去设置", () => {
  const card = deriveFailureCard({
    id: "f3",
    ts: "2026-06-10T00:00:00Z",
    type: "project_blocked",
    message: "No provider adapter configured for foo",
    data: {}
  }, {});
  assert.equal(card.kind, "provider-error");
  const switchAction = card.actions.find((a) => a.command === "switch-model");
  assert.equal(switchAction.label, "去设置切换模型");
});
