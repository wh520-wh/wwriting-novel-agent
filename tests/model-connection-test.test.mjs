import assert from "node:assert/strict";
import test from "node:test";

import { testModelConnection } from "../src/core/model-connection-test.mjs";

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
