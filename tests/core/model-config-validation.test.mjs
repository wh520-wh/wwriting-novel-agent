import assert from "node:assert/strict";
import test from "node:test";

import {
  ModelConfigValidationError,
  validateModelConfig,
} from "../../src/core/model-config-validation.mjs";

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

test("timeout_ms/total_deadline_ms：合法正整数透传", () => {
  const config = validateModelConfig({
    provider: "openai-compatible",
    model_name: "writer",
    base_url: "https://api.example.test/v1",
    api_key_env: "WRITER_KEY",
    timeout_ms: 300000,
    total_deadline_ms: 1800000
  });
  assert.equal(config.timeout_ms, 300000);
  assert.equal(config.total_deadline_ms, 1800000);
});

test("timeout_ms/total_deadline_ms：负数/非整数/零/非数字拒绝并报字段名", () => {
  for (const [field, value] of [
    ["timeout_ms", -5],
    ["timeout_ms", 1.5],
    ["timeout_ms", "abc"],
    ["timeout_ms", 0],
    ["total_deadline_ms", -1],
    ["total_deadline_ms", "3.5"]
  ]) {
    assert.throws(() => validateModelConfig({
      provider: "openai-compatible", model_name: "x",
      base_url: "https://api.example.com", api_key_env: "K",
      [field]: value
    }), (e) => {
      assert.equal(typeof e.fields?.[field], "string", `${field} 应在 fields 报错`);
      assert.match(e.fields[field], /正整数/);
      return true;
    });
  }
});

test("api_format 默认 openai-chat-completions，白名单外拒绝", () => {
  const config = validateModelConfig({
    provider: "openai-compatible", model_name: "deepseek-v4-pro",
    base_url: "https://api.deepseek.com", api_key_env: "DEEPSEEK_API_KEY"
  });
  assert.equal(config.api_format, "openai-chat-completions");
  assert.throws(
    () => validateModelConfig({
      provider: "openai-compatible", model_name: "x", base_url: "https://x.test",
      api_key_env: "X", api_format: "anthropic-messages"
    }),
    (error) => error instanceof ModelConfigValidationError && error.fields.api_format === "本轮仅支持 OpenAI Chat Completions 协议"
  );
});
