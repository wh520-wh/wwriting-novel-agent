import assert from "node:assert/strict";
import test from "node:test";

import { testModelConnection } from "../../src/core/model-connection-test.mjs";
import { ProviderTransportError } from "../../src/core/model/openai-compatible.mjs";

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
  // Task 11/B6 回归：内部探测超时（timeoutMs 注入小值触发真实定时器路径）必须
  // 分类为 request_timeout，而不是被误判成调用方取消（AbortError 逃逸 → HTTP 499）。
  // 注入的 complete 模拟传输层对信号中止的真实反应（以 AbortError 形态拒绝）——
  // 探测级定时器中止合并信号后，网关正是这样抛错的。
  const result = await testModelConnection({
    config: {
      provider: "openai-compatible",
      model_name: "mimo-v2.5-pro",
      base_url: "https://api.example.test/v1",
      api_key_env: "XIAOMI_MIMO_API_KEY",
    },
    secrets: { XIAOMI_MIMO_API_KEY: "test-key" },
    timeoutMs: 20,
    complete: ({ signal }) => new Promise((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "request_timeout");
  assert.match(result.message, /超时/u);
});

test("ProviderTransportError(reason=timeout) 直达也分类为 request_timeout", async () => {
  // 覆盖网关 attempt 看门狗路径：空闲超时抛 ProviderTransportError(reason="timeout")
  //（探测级定时器未必先到，timeoutSignal 未中止）——分类必须仍然落到 request_timeout。
  const result = await testModelConnection({
    config: {
      provider: "openai-compatible",
      model_name: "mimo-v2.5-pro",
      base_url: "https://api.example.test/v1",
      api_key_env: "XIAOMI_MIMO_API_KEY",
    },
    secrets: { XIAOMI_MIMO_API_KEY: "test-key" },
    complete: async () => {
      throw new ProviderTransportError("Request timed out.", { reason: "timeout" });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "request_timeout");
});

test("调用方取消仍抛 AbortError 且不重试", async () => {
  // 外部 signal 中止 → 原样抛 AbortError（HTTP 层映射 499 client_closed_request），
  // 且不得触发探测重试（attempts 恒为 1）。
  const controller = new AbortController();
  const started = Promise.withResolvers();
  let attempts = 0;
  const pending = testModelConnection({
    config: {
      provider: "openai-compatible",
      model_name: "mimo-v2.5-pro",
      base_url: "https://api.example.test/v1",
      api_key_env: "XIAOMI_MIMO_API_KEY",
    },
    secrets: { XIAOMI_MIMO_API_KEY: "test-key" },
    signal: controller.signal,
    timeoutMs: 5000,
    complete: async ({ signal }) => {
      attempts += 1;
      started.resolve();
      await new Promise((resolve, reject) => {
        signal?.addEventListener(
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
  assert.equal(attempts, 1, "调用方取消不得触发探测重试");
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

// ---------------------------------------------------------------------------
// Task 7：探测判定修复——思考型模型只回 reasoning（正文为空）也判成功；
// 正文与 reasoning 都为空才判 response_incompatible，且错误消息带 raw 摘要
// 与可操作方向（借鉴 Claude Code「明确告知」模式）。
// ---------------------------------------------------------------------------

test("思考型模型仅返回 reasoning（正文为空）：探测成功", async () => {
  // 走真实 probe（默认 complete=completeOpenAICompatibleProbe），用桩 fetch 模拟
  // deepseek-reasoner 把 token 额度全花在 reasoning_content 上、正文 content 为空。
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({ choices: [{ message: { content: "", reasoning_content: "思考过程" } }] });
    }
  });
  try {
    const result = await testModelConnection({
      config: {
        provider: "openai-compatible",
        model_name: "deepseek-reasoner",
        base_url: "https://api.deepseek.com",
        api_key_env: "TEST_KEY"
      },
      secrets: { TEST_KEY: "k" }
    });
    assert.equal(result.ok, true, "正文为空但 reasoning 非空应视为响应成功");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("正文与 reasoning 均为空：探测失败且消息带 raw 摘要与可操作方向", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({ choices: [{ message: {} }] });
    }
  });
  try {
    const result = await testModelConnection({
      config: {
        provider: "openai-compatible",
        model_name: "empty-model",
        base_url: "https://api.example.com/v1",
        api_key_env: "TEST_KEY"
      },
      secrets: { TEST_KEY: "k" }
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "response_incompatible");
    // 错误消息给出可操作方向 + raw 摘要（消息最终要能到达用户 UI）。
    assert.match(result.message, /思考/u, "消息应提示思考型/思考未落正文等可能原因");
    assert.match(result.message, /choices\[0\]\.message 字段/u, "消息应带 raw 摘要（summarizeResponseForDiagnostics）");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
