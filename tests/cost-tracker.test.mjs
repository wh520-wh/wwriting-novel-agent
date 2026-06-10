import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CostTracker, estimateCost } from "../src/core/cost-tracker.mjs";

// --- estimateCost ---

test("estimateCost returns 0 when usage is zero", () => {
  assert.equal(
    estimateCost({ inputTokens: 0, outputTokens: 0 }, { input_per_million: 3, output_per_million: 15 }),
    0
  );
});

test("estimateCost computes input + output cost correctly", () => {
  // 1,000,000 input tokens at $3/M = $3; 500,000 output tokens at $15/M = $7.5
  const cost = estimateCost({ inputTokens: 1_000_000, outputTokens: 500_000 }, { input_per_million: 3, output_per_million: 15 });
  assert.equal(cost, 10.5);
});

test("estimateCost defaults pricing to 0 when missing", () => {
  const cost = estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.equal(cost, 0);
});

test("estimateCost rounds to 8 decimal places", () => {
  const cost = estimateCost({ inputTokens: 1, outputTokens: 1 }, { input_per_million: 3, output_per_million: 15 });
  // 3e-6 + 15e-6 = 1.8e-5
  assert.equal(cost, 0.000018);
});

// --- CostTracker construction ---

test("CostTracker initializes with zero summary by default", () => {
  const tracker = new CostTracker();
  const s = tracker.getSummary();
  assert.equal(s.calls, 0);
  assert.equal(s.inputTokens, 0);
  assert.equal(s.outputTokens, 0);
  assert.equal(s.totalTokens, 0);
  assert.equal(s.cachedTokens, 0);
  assert.equal(s.estimatedCost, 0);
  assert.deepEqual(s.byProvider, {});
  assert.deepEqual(s.byStage, {});
});

test("CostTracker accepts initial summary", () => {
  const initial = { calls: 5, inputTokens: 100, outputTokens: 200, totalTokens: 300, cachedTokens: 50, estimatedCost: 1.5, byProvider: {}, byStage: {} };
  const tracker = new CostTracker({ summary: initial });
  assert.equal(tracker.getSummary().calls, 5);
  assert.equal(tracker.getSummary().estimatedCost, 1.5);
});

// --- CostTracker.record ---

test("CostTracker.record accumulates usage across multiple calls", () => {
  const tracker = new CostTracker({ pricing: { openai: { input_per_million: 3, output_per_million: 15 } } });
  tracker.record({
    stage: "drafting",
    usageReport: { provider: "openai", inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cachedTokens: 100 }
  });
  tracker.record({
    stage: "drafting",
    usageReport: { provider: "openai", inputTokens: 2000, outputTokens: 1000, totalTokens: 3000, cachedTokens: 200 }
  });
  const s = tracker.getSummary();
  assert.equal(s.calls, 2);
  assert.equal(s.inputTokens, 3000);
  assert.equal(s.outputTokens, 1500);
  assert.equal(s.totalTokens, 4500);
  assert.equal(s.cachedTokens, 300);
  assert.ok(s.estimatedCost > 0);
});

test("CostTracker.record uses estimatedCost from usageReport when present", () => {
  const tracker = new CostTracker();
  tracker.record({ stage: "test", usageReport: { provider: "p", inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, estimatedCost: 42 } });
  assert.equal(tracker.getSummary().estimatedCost, 42);
});

test("CostTracker.record groups by provider and stage", () => {
  const tracker = new CostTracker();
  tracker.record({ stage: "planning", usageReport: { provider: "claude", inputTokens: 100, outputTokens: 50, totalTokens: 150, cachedTokens: 0, estimatedCost: 1 } });
  tracker.record({ stage: "drafting", usageReport: { provider: "claude", inputTokens: 200, outputTokens: 100, totalTokens: 300, cachedTokens: 0, estimatedCost: 2 } });
  tracker.record({ stage: "drafting", usageReport: { provider: "gpt", inputTokens: 300, outputTokens: 150, totalTokens: 450, cachedTokens: 0, estimatedCost: 3 } });
  const s = tracker.getSummary();
  assert.equal(s.byProvider.claude.calls, 2);
  assert.equal(s.byProvider.claude.estimatedCost, 3);
  assert.equal(s.byProvider.gpt.calls, 1);
  assert.equal(s.byProvider.gpt.estimatedCost, 3);
  assert.equal(s.byStage.planning.calls, 1);
  assert.equal(s.byStage.drafting.calls, 2);
  assert.equal(s.byStage.drafting.estimatedCost, 5);
});

test("CostTracker.record returns a deep copy of the summary", () => {
  const tracker = new CostTracker();
  const s1 = tracker.record({ stage: "x", usageReport: { provider: "p", inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedTokens: 0, estimatedCost: 0.1 } });
  const s2 = tracker.getSummary();
  assert.deepEqual(s1, s2);
  // mutating s1 should not affect tracker
  s1.calls = 999;
  assert.equal(tracker.getSummary().calls, 1);
});

// --- CostTracker.getSummary returns deep copy ---

test("CostTracker.getSummary returns a deep copy", () => {
  const tracker = new CostTracker();
  const s1 = tracker.getSummary();
  s1.calls = 999;
  assert.equal(tracker.getSummary().calls, 0);
});

// --- CostTracker.writeProjectReport ---

test("CostTracker.writeProjectReport writes JSON to cost.json", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-cost-"));
  try {
    const tracker = new CostTracker();
    tracker.record({ stage: "s", usageReport: { provider: "p", inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedTokens: 0, estimatedCost: 0.5 } });
    await tracker.writeProjectReport(tmpDir);
    const content = JSON.parse(await fs.readFile(path.join(tmpDir, "cost.json"), "utf8"));
    assert.equal(content.calls, 1);
    assert.equal(content.estimatedCost, 0.5);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// --- CostTracker with pricing ---

test("CostTracker computes cost from pricing when estimatedCost is absent", () => {
  const tracker = new CostTracker({ pricing: { myProvider: { input_per_million: 10, output_per_million: 20 } } });
  tracker.record({
    stage: "s",
    usageReport: { provider: "myProvider", inputTokens: 1_000_000, outputTokens: 500_000, totalTokens: 1_500_000, cachedTokens: 0 }
  });
  // 1M * 10/M = 10, 0.5M * 20/M = 10 => total 20
  assert.equal(tracker.getSummary().estimatedCost, 20);
});

test("CostTracker defaults unknown provider pricing to 0", () => {
  const tracker = new CostTracker({ pricing: {} });
  tracker.record({
    stage: "s",
    usageReport: { provider: "unknownProvider", inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000, cachedTokens: 0 }
  });
  assert.equal(tracker.getSummary().estimatedCost, 0);
});
