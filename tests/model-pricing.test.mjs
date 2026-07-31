import assert from "node:assert/strict";
import test from "node:test";
import { buildPricingTable, fillOfficialPricing, isDeepSeekModel, normalizePricing, resolvePricing } from "../src/core/model-pricing.mjs";

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

test("fillOfficialPricing 为 v4-flash 补全官方人民币价（1.00/2.00/0.02）", () => {
  const filled = fillOfficialPricing("deepseek-v4-flash", "https://api.deepseek.com", {});
  assert.equal(filled.input_per_million, 1.0);
  assert.equal(filled.output_per_million, 2.0);
  assert.equal(filled.cache_hit_per_million, 0.02);
});

test("fillOfficialPricing 为 v4-pro 补全官方人民币价（3.00/6.00/0.025）", () => {
  const filled = fillOfficialPricing("deepseek-v4-pro", "https://api.deepseek.com", {});
  assert.equal(filled.input_per_million, 3.0);
  assert.equal(filled.output_per_million, 6.0);
  assert.equal(filled.cache_hit_per_million, 0.025);
});

test("fillOfficialPricing 为 mimo-v2.5 补全官方人民币价（与 flash 同档）", () => {
  const filled = fillOfficialPricing("mimo-v2.5", "https://api.xiaomimimo.com/v1", {});
  assert.equal(filled.input_per_million, 1.0);
  assert.equal(filled.output_per_million, 2.0);
  assert.equal(filled.cache_hit_per_million, 0.02);
});

test("fillOfficialPricing 为 mimo-v2.5-pro 补全官方人民币价（与 pro 同档）", () => {
  const filled = fillOfficialPricing("mimo-v2.5-pro", "https://api.xiaomimimo.com/v1", {});
  assert.equal(filled.input_per_million, 3.0);
  assert.equal(filled.output_per_million, 6.0);
  assert.equal(filled.cache_hit_per_million, 0.025);
});

test("fillOfficialPricing 为 mimo-v2.5-pro-ultraspeed 补全官方人民币价（9/18/0.075）", () => {
  const filled = fillOfficialPricing("mimo-v2.5-pro-ultraspeed", "https://api.xiaomimimo.com/v1", {});
  assert.equal(filled.input_per_million, 9.0);
  assert.equal(filled.output_per_million, 18.0);
  assert.equal(filled.cache_hit_per_million, 0.075);
});

test("fillOfficialPricing 为 mimo-v2.5-pro-ultraspeed 只补缺失字段，用户已填值不覆盖", () => {
  const filled = fillOfficialPricing("mimo-v2.5-pro-ultraspeed", "https://api.xiaomimimo.com/v1", {
    input_per_million: 8.5, cache_hit_per_million: 0.1
  });
  assert.equal(filled.input_per_million, 8.5);
  assert.equal(filled.output_per_million, 18.0);
  assert.equal(filled.cache_hit_per_million, 0.1);
});

test("fillOfficialPricing 只补缺失字段，用户已填的值绝不覆盖", () => {
  const filled = fillOfficialPricing("deepseek-v4-flash", "https://api.deepseek.com", { input_per_million: 0.5, cache_hit_per_million: 0.123 });
  assert.equal(filled.input_per_million, 0.5);
  assert.equal(filled.output_per_million, 2.0);
  assert.equal(filled.cache_hit_per_million, 0.123);
});

test("fillOfficialPricing 未收录的模型不补填（交给 ×2% 默认折算）", () => {
  const filled = fillOfficialPricing("deepseek-chat", "https://api.deepseek.com", { input_per_million: 1, output_per_million: 2 });
  assert.equal(filled.cache_hit_per_million, undefined);
});

test("fillOfficialPricing 非官方收录模型不补填", () => {
  const filled = fillOfficialPricing("custom-model", "https://example.com/v1", { input_per_million: 1, output_per_million: 2 });
  assert.equal(filled.cache_hit_per_million, undefined);
});

test("isDeepSeekModel 按模型前缀或 baseUrl 判断", () => {
  assert.equal(isDeepSeekModel("deepseek-v4-flash", ""), true);
  assert.equal(isDeepSeekModel("my-model", "https://api.deepseek.com/v1"), true);
  assert.equal(isDeepSeekModel("mimo-v2.5-pro", "https://api.xiaomimimo.com/v1"), false);
});
