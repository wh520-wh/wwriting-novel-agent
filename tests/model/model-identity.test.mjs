// 模型 ID 尾标解析器测试（统一 Journal/上下文窗口/自动压缩计划 Task 2）。
//
// 契约：只剥离尾部连续 [tag]（基础 ID 中间允许出现中括号，如 mo[del]name）；
// 精确匹配 1m/1M 尾标 → 1M 有效上下文窗口，否则默认 256k。
import assert from "node:assert/strict";
import test from "node:test";

import { parseModelIdentity } from "../../src/core/model/model-identity.mjs";
import { resolveModelLimits, compactionThresholdOf } from "../../src/core/model/model-identity.mjs";

test("只剥离尾部连续中括号并识别精确 1m/1M", () => {
  assert.deepEqual(parseModelIdentity("vendor/model[1m][foo]"), {
    configured_model_id: "vendor/model[1m][foo]",
    provider_model_id: "vendor/model",
    trailing_tags: ["1m", "foo"],
    window_source: "model_id_1m",
    effective_context_window: 1_000_000,
    compaction_threshold: 967_000
  });
  assert.equal(parseModelIdentity("model[1m][1m]").provider_model_id, "model");
  assert.equal(parseModelIdentity("model[1M]").effective_context_window, 1_000_000);
  assert.equal(parseModelIdentity("model[1m ]").effective_context_window, 256_000);
  assert.equal(parseModelIdentity("model[foo]").provider_model_id, "model");
  assert.equal(parseModelIdentity("mo[del]name[foo]").provider_model_id, "mo[del]name");
  assert.equal(parseModelIdentity("model[1m]suffix").provider_model_id, "model[1m]suffix");
});

// -- 第十三轮（ADR 0004）：窗口/输出唯一解析点 --
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
