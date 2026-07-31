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

test("agent_loop_exhausted 不再标 tool-rejected，归为 loop-exhausted 且改提示词重试置前", () => {
  const card = deriveFailureCard({
    id: "f4",
    ts: "2026-06-10T00:00:00Z",
    type: "project_blocked",
    message: "Output too short",
    chapter_no: 2,
    data: { tool: null, code: "agent_loop_exhausted" }
  }, { current_chapter_no: 2 });
  assert.equal(card.kind, "loop-exhausted");
  assert.equal(card.title, "多次尝试未成功");
  assert.ok(card.body.includes("多轮"), `body 应说明多轮未提交: ${card.body}`);
  // 已自动重试 N 次仍失败 -> 改提示词重试置前，简单重试降到第二
  assert.equal(card.actions[0].command, "retry-with-prompt");
  assert.equal(card.actions[1].command, "retry-segment");
});

test("model_output_invalid 也归为 loop-exhausted（不再标 tool-rejected 误导）", () => {
  const card = deriveFailureCard({
    id: "f5",
    ts: "2026-06-10T00:00:00Z",
    type: "project_blocked",
    message: "permission denied",
    chapter_no: 3,
    data: { tool: "edit_chapter", code: "model_output_invalid" }
  }, { current_chapter_no: 3 });
  assert.equal(card.kind, "loop-exhausted");
  assert.ok(card.body.includes("多次"), `body 应说明多次输出无效: ${card.body}`);
});

test("cost_budget_exhausted 事件产出可恢复的成本预算卡", () => {
  const card = deriveFailureCard({
    id: "e1", type: "project_blocked", message: "cost_budget_exhausted",
    chapter_no: 3, data: { estimated_cost: 1.21, max_cost: 1 }
  }, { current_chapter_no: 3 });
  assert.equal(card.kind, "budget-exhausted");
  assert.match(card.body, /1\.21/);
  assert.equal(card.actions[0].command, "raise-cost-budget");
  assert.equal(card.actions[0].args.newMaxCost, 2);
});
