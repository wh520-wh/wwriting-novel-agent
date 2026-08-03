import assert from "node:assert/strict";
import test from "node:test";

import {
  ModelConfigValidationError,
  validateModelConfig,
} from "../src/core/model-config-validation.mjs";

test("openai-compatible requires base_url and api_key_env", () => {
  assert.throws(
    () => validateModelConfig({
      provider: "openai-compatible",
      model_name: "mimo-v2.5-pro",
      base_url: "",
      api_key_env: "",
    }),
    (error) => {
      assert.equal(error instanceof ModelConfigValidationError, true);
      assert.deepEqual(error.fields, {
        base_url: "请输入兼容接口地址",
        api_key_env: "请输入 API Key 环境变量名",
      });
      return true;
    },
  );
});

test("MiMo compatible configuration is normalized", () => {
  const config = validateModelConfig({
    provider: "openai-compatible",
    model_name: "mimo-v2.5-pro",
    base_url: "https://api.xiaomimimo.com/v1/",
    api_key_env: "XIAOMI_MIMO_API_KEY",
  });

  assert.equal(config.base_url, "https://api.xiaomimimo.com/v1");
  assert.equal(config.api_key_env, "XIAOMI_MIMO_API_KEY");
});

test("model validation preserves supported runtime and pricing fields", () => {
  const config = validateModelConfig({
    provider: "openai-compatible",
    model_name: "writer",
    base_url: "https://api.example.test/v1",
    api_key_env: "WRITER_KEY",
    pricing: { input_per_million: 1, output_per_million: 2, cache_hit_per_million: 0.2 },
    stream: true,
    cache_mode: "prefix",
    max_context_tokens: 8192,
    max_output_tokens: 2048,
  });

  assert.deepEqual(config.pricing, { input_per_million: 1, output_per_million: 2, cache_hit_per_million: 0.2, currency: "CNY" });
  assert.equal(config.stream, true);
  assert.equal(config.cache_mode, "prefix");
  assert.equal(config.max_context_tokens, 8192);
  assert.equal(config.max_output_tokens, 2048);
});

test("temperature：合法值 0–2 通过并保留", () => {
  const config = validateModelConfig({
    provider: "openai-compatible", model_name: "deepseek-chat",
    base_url: "https://api.deepseek.com", api_key_env: "DEEPSEEK_API_KEY",
    temperature: 1.2
  });
  assert.equal(config.temperature, 1.2);
});

test("temperature：缺省不携带（厂商默认）", () => {
  const config = validateModelConfig({
    provider: "openai-compatible", model_name: "deepseek-chat",
    base_url: "https://api.deepseek.com", api_key_env: "DEEPSEEK_API_KEY"
  });
  assert.equal(config.temperature, undefined);
});

test("temperature：越界/非数字报错", () => {
  assert.throws(() => validateModelConfig({
    provider: "openai-compatible", model_name: "x",
    base_url: "https://api.example.com", api_key_env: "K",
    temperature: 3
  }), (e) => {
    assert.equal(typeof e.fields?.temperature, "string");
    return true;
  });
  assert.throws(() => validateModelConfig({
    provider: "openai-compatible", model_name: "x",
    base_url: "https://api.example.com", api_key_env: "K",
    temperature: "hot"
  }), (e) => {
    assert.equal(typeof e.fields?.temperature, "string");
    return true;
  });
});

test("api_key_env rejects shell expressions", () => {
  assert.throws(
    () => validateModelConfig({
      provider: "openai-compatible",
      model_name: "mimo-v2.5-pro",
      base_url: "https://api.xiaomimimo.com/v1",
      api_key_env: "XIAOMI_MIMO_API_KEY;Remove-Item",
    }),
    /环境变量名/,
  );
});
