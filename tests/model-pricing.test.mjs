import assert from "node:assert/strict";
import test from "node:test";
import { buildPricingTable, normalizePricing, resolvePricing } from "../src/core/model-pricing.mjs";

test("normalizePricing 接受正数价格并保留币种", () => {
  const p = normalizePricing({ input_per_million: 2, output_per_million: 8, cache_hit_per_million: 0.5 });
  assert.deepEqual(p, { input_per_million: 2, output_per_million: 8, cache_hit_per_million: 0.5, currency: "CNY" });
});

test("normalizePricing 拒绝缺输入/输出价或非正数", () => {
  assert.equal(normalizePricing({ input_per_million: 2 }), null);
  assert.equal(normalizePricing({ input_per_million: -1, output_per_million: 8 }), null);
  assert.equal(normalizePricing(null), null);
});

test("resolvePricing 精确匹配优先，其次最长前缀", () => {
  const table = {
    "deepseek-v4": { input_per_million: 1, output_per_million: 2, currency: "CNY" },
    "deepseek-v4-pro": { input_per_million: 3, output_per_million: 6, currency: "CNY" }
  };
  assert.equal(resolvePricing("deepseek-v4-pro", table).input_per_million, 3);
  assert.equal(resolvePricing("deepseek-v4-pro-max", table).input_per_million, 3);
  assert.equal(resolvePricing("mimo-v2.5", table), null);
});

test("buildPricingTable 从 active_model 与启用的 stage_overrides 取价", () => {
  const table = buildPricingTable({
    active_model: { model_name: "mimo-v2.5-pro", pricing: { input_per_million: 1, output_per_million: 4 } },
    stage_overrides: {
      outline: { enabled: true, model_name: "deepseek-chat", pricing: { input_per_million: 2, output_per_million: 8 } },
      reviewing: { enabled: false, model_name: "x", pricing: { input_per_million: 9, output_per_million: 9 } }
    }
  });
  assert.ok(table["mimo-v2.5-pro"]);
  assert.ok(table["deepseek-chat"]);
  assert.equal(table["x"], undefined);
});
