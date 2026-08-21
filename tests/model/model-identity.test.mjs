// 窗口/输出唯一解析点测试（第十三轮 ADR 0004）：显式字段优先、缺省 256k/64k、
// 非法值回缺省、压缩阈值 = 窗口八成。
import assert from "node:assert/strict";
import test from "node:test";
import { resolveModelLimits, compactionThresholdOf } from "../../src/core/model/model-identity.mjs";

test("resolveModelLimits：显式字段优先，缺省 256k/64k，非法值回缺省", () => {
  assert.deepEqual(resolveModelLimits({ context_window: 128_000, max_output_tokens: 8_000 }), {
    effective_context_window: 128_000,
    effective_max_output_tokens: 8_000,
    compaction_threshold: 102_400,
    window_source: "configured"
  });
  assert.deepEqual(resolveModelLimits({}), {
    effective_context_window: 256_000,
    effective_max_output_tokens: 64_000,
    compaction_threshold: 204_800,
    window_source: "default_256k"
  });
  assert.equal(resolveModelLimits({ context_window: 0, max_output_tokens: -5 }).window_source, "default_256k");
});

test("压缩阈值 = 窗口八成（256k 档与旧值 204_800 恰好同值）", () => {
  assert.equal(compactionThresholdOf(256_000), 204_800);
  assert.equal(compactionThresholdOf(1_000_000), 800_000);
  assert.equal(compactionThresholdOf(128_000), 102_400);
});