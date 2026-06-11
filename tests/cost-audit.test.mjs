import assert from "node:assert/strict";
import test from "node:test";
import { analyzeCost } from "../src/core/cost-audit.mjs";

function usageEvent(chapter, { input, output, cached, hitRate }) {
  return {
    type: "model_usage_recorded",
    chapter_no: chapter,
    stage: "drafting",
    data: {
      usage_report: {
        provider: "openai-compatible",
        model: "deepseek-v4-pro",
        inputTokens: input,
        outputTokens: output,
        cachedTokens: cached,
        cacheHitTokens: cached,
        cacheMetricsAvailable: true,
        cacheHitRate: hitRate
      }
    }
  };
}

const events = [
  { type: "model_call_started", chapter_no: 1 },
  usageEvent(1, { input: 1000, output: 2000, cached: 400, hitRate: 0.4 }),
  { type: "model_retry", data: { reason: "timeout", model: "deepseek-v4-pro" } },
  { type: "model_call_started", chapter_no: 1 },
  usageEvent(1, { input: 1200, output: 1800, cached: 100, hitRate: 0.083 }),
  { type: "quality_gate_failed", chapter_no: 1, message: "word-count gate failed", data: {} },
  { type: "model_call_started", chapter_no: 2 },
  usageEvent(2, { input: 1500, output: 2500, cached: 0, hitRate: 0 }),
  { type: "model_call_started", chapter_no: 2 }
];

test("analyzeCost 按章聚合 token 与调用次数", () => {
  const report = analyzeCost({ events });
  assert.equal(report.byChapter["1"].calls, 2);
  assert.equal(report.byChapter["1"].inputTokens, 2200);
  assert.equal(report.byChapter["1"].outputTokens, 3800);
  assert.equal(report.byChapter["2"].calls, 1);
});

test("analyzeCost 统计重试、未完成调用与补写门禁", () => {
  const report = analyzeCost({ events });
  assert.equal(report.calls.started, 4);
  assert.equal(report.calls.completed, 3);
  assert.equal(report.calls.abandoned, 1);
  assert.equal(report.retries.count, 1);
  assert.equal(report.retries.byReason.timeout, 1);
  assert.equal(report.refills.gateFailures, 1);
  assert.equal(report.refills.byChapter["1"], 1);
});

test("analyzeCost 汇总缓存命中率与版本变化", () => {
  const report = analyzeCost({
    events,
    cacheReport: {
      entries: { "p:drafting.v1": { cacheVersion: 8 } },
      last_call: { cacheHitRate: 0.083, stableChanged: true }
    }
  });
  assert.equal(report.cache.samples.length, 3);
  assert.ok(Math.abs(report.cache.averageHitRate - (0.4 + 0.083 + 0) / 3) < 1e-9);
  assert.equal(report.cache.maxCacheVersion, 8);
  assert.equal(report.cache.lastStableChanged, true);
});

test("analyzeCost 容忍缺失输入", () => {
  const report = analyzeCost({});
  assert.equal(report.calls.started, 0);
  assert.deepEqual(report.byChapter, {});
  assert.equal(report.cache.maxCacheVersion, null);
});
