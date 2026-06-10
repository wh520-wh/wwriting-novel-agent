import test from "node:test";
import assert from "node:assert/strict";
import { CostTracker } from "../src/core/cost-tracker.mjs";
import { emit, CORE_EVENTS } from "../src/core/event-bus.mjs";

test("ModelCallComplete 事件不再把同一次调用二次记账", async () => {
  const tracker = new CostTracker();
  const usageReport = {
    provider: "deepseek",
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    cachedTokens: 0
  };
  // ModelClient.generate 内部的唯一一次记账
  tracker.record({ stage: "drafting", usageReport });
  // agent-engine 随后的事件广播——订阅者不得再次 record
  await emit(CORE_EVENTS.ModelCallComplete, {
    projectRoot: "unused",
    model: "deepseek-chat",
    usage: usageReport,
    costTracker: tracker,
    options: { stage: "drafting" }
  });
  const summary = tracker.getSummary();
  assert.equal(summary.calls, 1, `期望 1 次记账，实际 ${summary.calls}`);
  assert.equal(summary.totalTokens, 15);
  assert.equal(summary.byProvider["deepseek-chat"], undefined, "model 名不得污染 byProvider 桶");
});
