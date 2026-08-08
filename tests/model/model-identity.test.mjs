// 模型 ID 尾标解析器测试（统一 Journal/上下文窗口/自动压缩计划 Task 2）。
//
// 契约：只剥离尾部连续 [tag]（基础 ID 中间允许出现中括号，如 mo[del]name）；
// 精确匹配 1m/1M 尾标 → 1M 有效上下文窗口，否则默认 256k。
import assert from "node:assert/strict";
import test from "node:test";

import { parseModelIdentity } from "../../src/core/model/model-identity.mjs";

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
