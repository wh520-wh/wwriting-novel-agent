import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CostTracker, estimateCost } from "../../src/core/cost-tracker.mjs";

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

test("estimateCost 没有价格表时返回 null 而不是 0", () => {
  assert.equal(estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }), null);
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

test("CostTracker.record 缺 token 字段时桶内不产生 NaN（回归：addToBucket ?? 0）", () => {
  const tracker = new CostTracker();
  tracker.record({
    stage: "drafting",
    usageReport: { provider: "p", failed: true, estimatedCost: 0 }
  });
  const s = tracker.getSummary();
  assert.equal(Number.isNaN(s.byProvider.p.inputTokens), false);
  assert.equal(Number.isNaN(s.byProvider.p.outputTokens), false);
  assert.equal(Number.isNaN(s.byProvider.p.totalTokens), false);
  assert.equal(Number.isNaN(s.byProvider.p.cachedTokens), false);
  assert.equal(s.byProvider.p.inputTokens, 0);
  assert.equal(s.byStage.drafting.inputTokens, 0);
  // 后续正常记录不会被 NaN 污染
  tracker.record({ stage: "drafting", usageReport: { provider: "p", inputTokens: 100, outputTokens: 50, totalTokens: 150, cachedTokens: 0, estimatedCost: 1 } });
  const s2 = tracker.getSummary();
  assert.equal(s2.byProvider.p.inputTokens, 100);
  assert.equal(s2.byProvider.p.outputTokens, 50);
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

test("CostTracker 未配置价格时累计 unpricedCalls 且 costAvailable=false", () => {
  const tracker = new CostTracker({ pricing: {} });
  tracker.record({
    stage: "s",
    usageReport: { provider: "p", model: "unknown-model", inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000, cachedTokens: 0 }
  });
  const s = tracker.getSummary();
  assert.equal(s.estimatedCost, 0);
  assert.equal(s.unpricedCalls, 1);
  assert.equal(s.costAvailable, false);
});

test("estimateCost 缓存命中按 cache_hit 价计费", () => {
  const cost = estimateCost(
    { inputTokens: 1_000_000, outputTokens: 0, cacheHitTokens: 400_000 },
    { input_per_million: 2, output_per_million: 8, cache_hit_per_million: 0.5 }
  );
  // 60 万未命中 ×2/M + 40 万命中 ×0.5/M = 1.2 + 0.2 = 1.4
  assert.equal(cost, 1.4);
});

test("CostTracker 按模型名解析价格并记 byModel", () => {
  const tracker = new CostTracker({ pricing: { "deepseek-v4": { input_per_million: 2, output_per_million: 8, currency: "CNY" } } });
  tracker.record({
    stage: "drafting",
    usageReport: { provider: "openai-compatible", model: "deepseek-v4-pro", inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000, cachedTokens: 0 }
  });
  const s = tracker.getSummary();
  assert.equal(s.estimatedCost, 2);
  assert.equal(s.costAvailable, true);
  assert.equal(s.byModel["deepseek-v4-pro"].calls, 1);
});

test("CostTracker 兼容缺新字段的旧 cost.json", () => {
  const tracker = new CostTracker({ summary: { calls: 5, inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedTokens: 0, estimatedCost: 0, byProvider: {}, byStage: {} } });
  const s = tracker.getSummary();
  assert.equal(s.unpricedCalls, 0);
  assert.deepEqual(s.byModel, {});
  assert.deepEqual(s.byChapter, {});
  assert.equal(s.cacheHitTokens, 0);
  assert.equal(s.hitRateInputTokens, 0);
});

test("CostTracker.recordRetry 累计 retries", () => {
  const tracker = new CostTracker();
  tracker.recordRetry();
  tracker.recordRetry();
  assert.equal(tracker.getSummary().retries, 2);
});

test("CostTracker 维护最近 20 次命中率滚动窗口", () => {
  const tracker = new CostTracker();
  for (let i = 0; i < 25; i += 1) {
    tracker.record({
      stage: "s",
      usageReport: { provider: "p", model: "m", inputTokens: 100, outputTokens: 1, totalTokens: 101, cachedTokens: 0, cacheHitRate: i / 100, estimatedCost: 0 }
    });
  }
  const s = tracker.getSummary();
  assert.equal(s.recentHitRates.length, 20);
  assert.equal(s.recentHitRates[0], 0.05);
  assert.equal(s.recentHitRates.at(-1), 0.24);
});

test("CostTracker 配置缓存命中价时累计 cacheSavedCost", () => {
  const tracker = new CostTracker({
    pricing: { m: { input_per_million: 2, output_per_million: 8, cache_hit_per_million: 0.5, currency: "CNY" } }
  });
  tracker.record({
    stage: "s",
    usageReport: { provider: "p", model: "m", inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000, cachedTokens: 400_000, cacheHitTokens: 400_000 }
  });
  // 40 万命中 × (2 − 0.5)/M = 0.6 元
  assert.equal(tracker.getSummary().cacheSavedCost, 0.6);
});

test("CostTracker 只有 cachedTokens（无 cacheHitTokens 字段，MiMo 风格）时按命中价计费并累计 cacheSavedCost", () => {
  const tracker = new CostTracker({
    pricing: { "mimo-v2.5-pro": { input_per_million: 3, output_per_million: 6, cache_hit_per_million: 0.025, currency: "CNY" } }
  });
  tracker.record({
    stage: "drafting",
    usageReport: { provider: "openai-compatible", model: "mimo-v2.5-pro", inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000, cachedTokens: 400_000 }
  });
  const s = tracker.getSummary();
  // 60 万未命中 ×3/M + 40 万命中 ×0.025/M = 1.8 + 0.01 = 1.81
  assert.equal(s.estimatedCost, 1.81);
  // 40 万命中 × (3 − 0.025)/M = 1.19
  assert.equal(s.cacheSavedCost, 1.19);
});

test("CostTracker 未配置 cache_hit_per_million 时按输入价×2% 默认折算缓存节省", () => {
  const tracker = new CostTracker({
    pricing: { m: { input_per_million: 2, output_per_million: 8 } }
  });
  tracker.record({
    stage: "s",
    usageReport: { provider: "p", model: "m", inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000, cachedTokens: 500_000, cacheHitTokens: 500_000 }
  });
  // 命中价按 2 × 0.02 = 0.04 折算，节省 = 50 万 × (2 − 0.04)/M = 0.98
  assert.equal(tracker.getSummary().cacheSavedCost, 0.98);
});

test("CostTracker 累计 cacheHitTokens 与命中率分母（token 加权）", () => {
  const tracker = new CostTracker();
  tracker.record({
    stage: "drafting",
    usageReport: { provider: "p", model: "m", inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000, cacheHitTokens: 0, cacheHitRate: 0, estimatedCost: 0 }
  });
  tracker.record({
    stage: "drafting",
    usageReport: { provider: "p", model: "m", inputTokens: 100_000, outputTokens: 0, totalTokens: 100_000, cacheHitTokens: 100_000, cacheHitRate: 1, estimatedCost: 0 }
  });
  const s = tracker.getSummary();
  // token 加权累计命中率 = 10 万 / 110 万 ≈ 9.09%，而非 per-call 平均 50%
  assert.equal(s.cacheHitTokens, 100_000);
  assert.equal(s.hitRateInputTokens, 1_100_000);
  assert.equal(Number((s.cacheHitTokens / s.hitRateInputTokens).toFixed(4)), 0.0909);
  assert.equal(s.recentHitRates.length, 2);
});

test("CostTracker 只有 cachedTokens（OpenAI 风格）时 cacheHitTokens 也累加", () => {
  const tracker = new CostTracker();
  tracker.record({
    stage: "drafting",
    usageReport: { provider: "p", model: "m", inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000, cachedTokens: 400_000, estimatedCost: 0 }
  });
  const s = tracker.getSummary();
  assert.equal(s.cacheHitTokens, 400_000);
  assert.equal(s.hitRateInputTokens, 1_000_000);
});

test("chat 调用不计入命中率统计但仍正常计费", () => {
  const tracker = new CostTracker();
  tracker.record({
    stage: "chat",
    usageReport: { provider: "p", model: "m", inputTokens: 50_000, outputTokens: 10_000, totalTokens: 60_000, cacheHitTokens: 50_000, cacheHitRate: 1, estimatedCost: 0.5 }
  });
  const s = tracker.getSummary();
  assert.equal(s.cacheHitTokens, 0);
  assert.equal(s.hitRateInputTokens, 0);
  assert.deepEqual(s.recentHitRates, []);
  // 计费路径不受影响
  assert.equal(s.calls, 1);
  assert.equal(s.inputTokens, 50_000);
  assert.equal(s.totalTokens, 60_000);
  assert.equal(s.estimatedCost, 0.5);
});

test("CostTracker 构造时保留 cost.json 里已有的 cacheHitTokens（跨会话持久）", () => {
  const tracker = new CostTracker({ summary: { calls: 3, cacheHitTokens: 700_000, hitRateInputTokens: 1_000_000 } });
  const s = tracker.getSummary();
  assert.equal(s.cacheHitTokens, 700_000);
  assert.equal(s.hitRateInputTokens, 1_000_000);
});

// §3.5: Failed call tracking
test("CostTracker.record with failed: true increments failedCalls", () => {
  const tracker = new CostTracker();
  tracker.record({
    stage: "drafting",
    usageReport: { provider: "p", model: "m", inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, estimatedCost: 0, failed: true }
  });
  const s = tracker.getSummary();
  assert.equal(s.calls, 1);
  assert.equal(s.failedCalls, 1);
});

test("CostTracker.record with failed: true still counts calls but skips cost", () => {
  const tracker = new CostTracker({ pricing: { p: { input_per_million: 3, output_per_million: 15 } } });
  tracker.record({
    stage: "drafting",
    usageReport: { provider: "p", model: "m", inputTokens: 100, outputTokens: 50, totalTokens: 150, cachedTokens: 0, estimatedCost: 0.001, failed: true }
  });
  const s = tracker.getSummary();
  assert.equal(s.calls, 1);
  assert.equal(s.failedCalls, 1);
  // price tracking still works even for failed calls with partial usage
  assert.equal(s.pricedCalls, 1);
  assert.ok(s.estimatedCost > 0);
});

test("CostTracker.getSummary includes failedCalls field", () => {
  const tracker = new CostTracker();
  const s = tracker.getSummary();
  assert.equal(typeof s.failedCalls, "number");
  assert.equal(s.failedCalls, 0);
});
