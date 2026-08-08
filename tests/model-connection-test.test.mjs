import assert from "node:assert/strict";
import test from "node:test";

import { testModelConnection } from "../src/core/model-connection-test.mjs";
import { ProviderTransportError } from "../src/core/model/openai-compatible.mjs";

test("successful probe returns latency and provider identity", async () => {
  const result = await testModelConnection({
    config: {
      provider: "openai-compatible",
      model_name: "mimo-v2.5-pro",
      base_url: "https://api.xiaomimimo.com/v1",
      api_key_env: "XIAOMI_MIMO_API_KEY",
    },
    secrets: { XIAOMI_MIMO_API_KEY: "test-key" },
    now: (() => {
      const values = [1000, 1125];
      return () => values.shift();
    })(),
    complete: async () => ({ text: "OK" }),
  });

  assert.deepEqual(result, {
    ok: true,
    provider: "openai-compatible",
    model_name: "mimo-v2.5-pro",
    latency_ms: 125,
  });
});

test("authentication failure is actionable and does not expose the key", async () => {
  const result = await testModelConnection({
    config: {
      provider: "openai-compatible",
      model_name: "mimo-v2.5-pro",
      base_url: "https://api.xiaomimimo.com/v1",
      api_key_env: "XIAOMI_MIMO_API_KEY",
    },
    secrets: { XIAOMI_MIMO_API_KEY: "secret-value" },
    complete: async () => {
      const error = new Error("401 secret-value");
      error.status = 401;
      throw error;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "authentication_failed");
  assert.match(result.message, /API Key/);
  assert.equal(JSON.stringify(result).includes("secret-value"), false);
});

test("missing secret is rejected before making a network request", async () => {
  let calls = 0;
  const result = await testModelConnection({
    config: {
      provider: "openai-compatible",
      model_name: "mimo-v2.5-pro",
      base_url: "https://api.xiaomimimo.com/v1",
      api_key_env: "XIAOMI_MIMO_API_KEY",
    },
    secrets: {},
    complete: async () => {
      calls += 1;
      return { text: "OK" };
    },
  });

  assert.equal(result.code, "configuration_missing");
  assert.equal(calls, 0);
});

test("connection probe retries on transport error", async () => {
  let attempts = 0;
  const result = await testModelConnection({
    config: {
      provider: "openai-compatible",
      model_name: "mimo-v2.5-pro",
      base_url: "https://api.xiaomimimo.com/v1",
      api_key_env: "XIAOMI_MIMO_API_KEY",
    },
    secrets: { XIAOMI_MIMO_API_KEY: "test-key" },
    complete: async () => {
      attempts++;
      if (attempts === 1) {
        throw new ProviderTransportError("503 Service Unavailable", { status: 503 });
      }
      return { text: "OK" };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(attempts, 2, "should retry once after 503");
});

test("connection probe does not retry on auth error", async () => {
  let attempts = 0;
  const result = await testModelConnection({
    config: {
      provider: "openai-compatible",
      model_name: "mimo-v2.5-pro",
      base_url: "https://api.xiaomimimo.com/v1",
      api_key_env: "XIAOMI_MIMO_API_KEY",
    },
    secrets: { XIAOMI_MIMO_API_KEY: "test-key" },
    complete: async () => {
      attempts++;
      const error = new Error("401 Unauthorized");
      error.status = 401;
      throw error;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(attempts, 1, "auth errors should NOT be retried");
});

test("connection probe propagates caller cancellation", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers();
  const pending = testModelConnection({
    config: {
      provider: "openai-compatible",
      model_name: "mimo-v2.5-pro",
      base_url: "https://api.xiaomimimo.com/v1",
      api_key_env: "XIAOMI_MIMO_API_KEY",
    },
    secrets: { XIAOMI_MIMO_API_KEY: "test-key" },
    signal: controller.signal,
    complete: async ({ signal }) => {
      started.resolve();
      await new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      });
    },
  });

  await started.promise;
  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
});

test("network unreachable is classified as network error", async () => {
  const error = new Error("connect failed");
  error.code = "ECONNREFUSED";
  const result = await testModelConnection({
    config: {
      provider: "openai-compatible",
      model_name: "mimo-v2.5-pro",
      base_url: "https://api.xiaomimimo.com/v1",
      api_key_env: "XIAOMI_MIMO_API_KEY",
    },
    secrets: { XIAOMI_MIMO_API_KEY: "test-key" },
    complete: async () => { throw error; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "network_unreachable");
  assert.match(result.message, /无法连接/);
});

test("HTTP 404 is classified as model_not_found", async () => {
  const error = new Error("not found");
  error.status = 404;
  const result = await testModelConnection({
    config: {
      provider: "openai-compatible",
      model_name: "unknown-model",
      base_url: "https://api.example.com/v1",
      api_key_env: "TEST_KEY",
    },
    secrets: { TEST_KEY: "test-key" },
    complete: async () => { throw error; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "model_not_found");
});

test("HTTP 429 is classified as provider_error", async () => {
  const error = new Error("rate limited");
  error.status = 429;
  const result = await testModelConnection({
    config: {
      provider: "openai-compatible",
      model_name: "mimo-v2.5-pro",
      base_url: "https://api.xiaomimimo.com/v1",
      api_key_env: "XIAOMI_MIMO_API_KEY",
    },
    secrets: { XIAOMI_MIMO_API_KEY: "test-key" },
    complete: async () => { throw error; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "provider_error");
});

test("empty response is classified as response_incompatible", async () => {
  const error = new Error("Provider returned empty or unparseable response");
  error.code = "response_incompatible";
  const result = await testModelConnection({
    config: {
      provider: "openai-compatible",
      model_name: "mimo-v2.5-pro",
      base_url: "https://api.xiaomimimo.com/v1",
      api_key_env: "XIAOMI_MIMO_API_KEY",
    },
    secrets: { XIAOMI_MIMO_API_KEY: "test-key" },
    complete: async () => { throw error; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "response_incompatible");
});

test("timeout is classified as request_timeout", async () => {
  const result = await testModelConnection({
    config: {
      provider: "openai-compatible",
      model_name: "mimo-v2.5-pro",
      base_url: "https://api.xiaomimimo.com/v1",
      api_key_env: "XIAOMI_MIMO_API_KEY",
    },
    secrets: { XIAOMI_MIMO_API_KEY: "test-key" },
    complete: async ({ signal }) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new DOMException("probe timeout", "TimeoutError")), 50);
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("aborted", "AbortError")); }, { once: true });
      });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "request_timeout");
});

test("probe 展示保留 configured ID、gateway 收到剥离尾标后的基础 ID", async () => {
  // 走真实 probe（默认 complete=completeOpenAICompatibleProbe），用桩 fetch
  // 捕获发给 gateway 的请求体：model[1m][foo] 尾标只在传输边界剥离。
  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ choices: [{ message: { content: "OK" } }] });
      },
    };
  };
  try {
    const result = await testModelConnection({
      config: {
        provider: "openai-compatible",
        model_name: "model[1m][foo]",
        base_url: "https://api.example.com/v1",
        api_key_env: "TEST_KEY",
      },
      secrets: { TEST_KEY: "k" },
    });
    assert.equal(result.ok, true);
    assert.equal(result.model_name, "model[1m][foo]", "响应展示保留 configured model id");
    assert.equal(captured.model, "model", "gateway 发送剥离尾标后的基础 ID");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("completeOpenAICompatibleProbe 对思考模型不注入 temperature", async () => {
  // 走真实 probe（默认 complete=completeOpenAICompatibleProbe），
  // 用桩 fetch 捕获发给 deepseek-v4-pro（思考模型）的请求体，
  // 断言 body 不含 temperature 字段（thinking 模型忽略采样参数，不应注入）。
  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ choices: [{ message: { content: "OK" } }] });
      },
    };
  };
  try {
    const result = await testModelConnection({
      config: {
        provider: "openai-compatible",
        base_url: "https://api.deepseek.com/v1",
        model_name: "deepseek-v4-pro",
        api_key_env: "TEST_KEY",
      },
      secrets: { TEST_KEY: "k" },
    });
    assert.equal(result.ok, true);
    assert.equal(captured.temperature, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider error message containing the key is redacted", async () => {
  const result = await testModelConnection({
    config: {
      provider: "openai-compatible",
      model_name: "mimo-v2.5-pro",
      base_url: "https://api.xiaomimimo.com/v1",
      api_key_env: "XIAOMI_MIMO_API_KEY",
    },
    secrets: { XIAOMI_MIMO_API_KEY: "secret-value" },
    complete: async () => {
      const error = new Error("500 secret-value leaked");
      error.status = 500;
      throw error;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "provider_error");
  assert.equal(result.message.includes("secret-value"), false);
  assert.match(result.message, /\[REDACTED\]/);
});
