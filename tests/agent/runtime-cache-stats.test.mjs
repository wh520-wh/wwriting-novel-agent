// 第九轮：会话级缓存命中率累计纯函数（runtime.mjs 导出）单测。
import assert from "node:assert/strict";
import { test } from "node:test";
import { accumulateCacheStats, cacheHitRateOf } from "../../src/core/agent/runtime.mjs";

test("累计：多调用 token 加权，命中 token 不超过输入 token（clamp 与 cost-tracker 一致）", () => {
  const stats = { hitTokens: 0, inputTokens: 0 };
  accumulateCacheStats(stats, { cacheHitTokens: 800, inputTokens: 1000 });  // +800 hit, +1000 input
  accumulateCacheStats(stats, { cacheHitTokens: 2000, inputTokens: 1000 }); // clamp: min(2000,1000)=1000 hit
  assert.equal(stats.hitTokens, 1800, "800 + clamp(2000,1000)=1800");
  assert.equal(stats.inputTokens, 2000);
  assert.equal(cacheHitRateOf(stats), 0.9);
});

test("非法/缺失 usage：不改变累计（undefined 字段、非数字、零输入）", () => {
  const stats = { hitTokens: 0, inputTokens: 0 };
  accumulateCacheStats(stats, null);
  accumulateCacheStats(stats, {});
  accumulateCacheStats(stats, { cacheHitTokens: 5, inputTokens: 0 });
  assert.deepEqual(stats, { hitTokens: 0, inputTokens: 0 });
  assert.equal(cacheHitRateOf(stats), null, "无累计 → null，前端不显示");
});

test("cacheHitRateOf：空统计返回 null，不返回假 0", () => {
  assert.equal(cacheHitRateOf(null), null);
  assert.equal(cacheHitRateOf({ hitTokens: 0, inputTokens: 0 }), null);
});
