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
