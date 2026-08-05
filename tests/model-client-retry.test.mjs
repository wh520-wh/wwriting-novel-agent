import assert from "node:assert/strict";
import test from "node:test";
import { ModelClient } from "../src/core/model-client.mjs";
import { ProviderTransportError } from "../src/core/provider-adapters.mjs";

// -- Helpers --

function makeClient(adapter, overrides = {}) {
  return new ModelClient({
    adapters: { mock: adapter },
    activeModel: { provider: "mock", model_name: "test-model" },
    retryBaseDelayMs: 10,
    retryMaxDelayMs: 10,
    ...overrides
  });
}

class HangingAdapter {
  constructor() {
    this.callIndex = 0;
  }
  async generate(request) {
    this.callIndex++;
    await new Promise((resolve, reject) => {
      request.signal?.addEventListener(
        "abort",
        () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        },
        { once: true }
      );
    });
  }
}

// -- Tests --

test("succeed on first try — no retry needed", async () => {
  let calls = 0;
  const adapter = {
    async generate() {
      calls++;
      return { text: "hello", usage: {} };
    }
  };
  const client = makeClient(adapter);
  const result = await client.generate({ prompt: "hi" });
  assert.equal(result.text, "hello");
  assert.equal(calls, 1);
});

test("retry on 429 — fail twice, succeed third time", async () => {
  let calls = 0;
  const adapter = {
    async generate() {
      calls++;
      if (calls <= 2) {
        throw new ProviderTransportError("Rate limited", { status: 429 });
      }
      return { text: "ok", usage: {} };
    }
  };
  const client = makeClient(adapter, { retryMax: 3 });
  const result = await client.generate({ prompt: "hi" });
  assert.equal(result.text, "ok");
  assert.equal(calls, 3);
});

test("NOT retry on 400 — client error, fail immediately", async () => {
  let calls = 0;
  const adapter = {
    async generate() {
      calls++;
      throw new ProviderTransportError("Bad request", { status: 400 });
    }
  };
  const client = makeClient(adapter, { retryMax: 3 });
  await assert.rejects(() => client.generate({ prompt: "hi" }), (err) => {
    assert.equal(err.code, "provider_transport_error");
    assert.equal(err.reason, "client-fatal");
    return true;
  });
  assert.equal(calls, 1);
});

test("NOT retry on 401 — auth error, fail immediately", async () => {
  let calls = 0;
  const adapter = {
    async generate() {
      calls++;
      throw new ProviderTransportError("Unauthorized", { status: 401 });
    }
  };
  const client = makeClient(adapter, { retryMax: 3 });
  await assert.rejects(() => client.generate({ prompt: "hi" }), (err) => {
    assert.equal(err.code, "provider_transport_error");
    assert.equal(err.reason, "client-fatal");
    return true;
  });
  assert.equal(calls, 1);
});

test("retry on 502/503/504 — server errors are retryable", async () => {
  for (const status of [502, 503, 504]) {
    let calls = 0;
    const adapter = {
      async generate() {
        calls++;
        if (calls === 1) {
          throw new ProviderTransportError(`HTTP ${status}`, { status });
        }
        return { text: "recovered", usage: {} };
      }
    };
    const client = makeClient(adapter, { retryMax: 2 });
    const result = await client.generate({ prompt: "hi" });
    assert.equal(result.text, "recovered", `status ${status} should retry`);
    assert.equal(calls, 2, `status ${status}: should have retried once`);
  }
});

test("not retry on user abort — pre-aborted signal, AbortError thrown", async () => {
  let calls = 0;
  const adapter = {
    async generate() {
      calls++;
      return { text: "nope", usage: {} };
    }
  };
  const controller = new AbortController();
  controller.abort();
  const client = makeClient(adapter);
  await assert.rejects(
    () => client.generate({ prompt: "hi", signal: controller.signal }),
    (err) => {
      assert.ok(err instanceof DOMException);
      assert.equal(err.name, "AbortError");
      return true;
    }
  );
  assert.equal(calls, 0, "adapter should never be called");
});

test("user abort interrupts retry backoff", async () => {
  let calls = 0;
  const controller = new AbortController();
  const adapter = {
    async generate() {
      calls++;
      throw new ProviderTransportError("Rate limited", { status: 429 });
    }
  };
  const client = makeClient(adapter, {
    retryBaseDelayMs: 1000,
    retryMaxDelayMs: 1000,
    retryMax: 3,
    onRetry() {
      controller.abort();
    }
  });

  await assert.rejects(
    () => client.generate({ prompt: "hi", signal: controller.signal }),
    (err) => err instanceof DOMException && err.name === "AbortError"
  );
  assert.equal(calls, 1, "abort during backoff should not start another attempt");
});

test("retry on timeout — HangingAdapter with short timeout", async () => {
  const hanging = new HangingAdapter();
  const client = makeClient(hanging, { retryMax: 1, timeoutMs: 50 });
  await assert.rejects(
    () => client.generate({ prompt: "hi" }),
    (err) => {
      assert.equal(err.code, "provider_transport_error");
      assert.equal(err.reason, "timeout");
      return true;
    }
  );
  // First attempt hangs and times out, second attempt also hangs and times out, then exhausted
  assert.equal(hanging.callIndex, 2);
});

test("call onRetry callback with correct fields", async () => {
  const retryLog = [];
  let calls = 0;
  const adapter = {
    async generate() {
      calls++;
      if (calls === 1) {
        throw new ProviderTransportError("Rate limited", { status: 429 });
      }
      return { text: "ok", usage: {} };
    }
  };
  const client = makeClient(adapter, {
    retryMax: 3,
    onRetry(info) {
      retryLog.push({ ...info });
    }
  });
  const result = await client.generate({ prompt: "hi" });
  assert.equal(result.text, "ok");
  assert.equal(retryLog.length, 1);
  assert.equal(retryLog[0].attempt, 1);
  assert.equal(retryLog[0].maxAttempts, 3);
  assert.equal(retryLog[0].reason, "server-retryable");
  assert.equal(retryLog[0].model, "test-model");
  assert.ok(retryLog[0].delay >= 10, "delay should be at least base delay");
  assert.ok(retryLog[0].error instanceof ProviderTransportError);
});

test("throw after exhausting retries — all attempts fail", async () => {
  let calls = 0;
  const adapter = {
    async generate() {
      calls++;
      throw new ProviderTransportError("Network down", { reason: "network" });
    }
  };
  const client = makeClient(adapter, { retryMax: 2 });
  await assert.rejects(
    () => client.generate({ prompt: "hi" }),
    (err) => {
      assert.equal(err.code, "provider_transport_error");
      assert.equal(err.reason, "network");
      return true;
    }
  );
  // 1 initial + 2 retries = 3 total calls
  assert.equal(calls, 3);
});

test("adapter AbortError after external abort is never retried", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers();
  let calls = 0;
  const adapter = {
    async generate({ signal }) {
      calls += 1;
      started.resolve();
      await new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      });
    }
  };
  const client = makeClient(adapter, { retryMax: 3 });
  const pending = client.generate({
    prompt: "hi",
    signal: controller.signal
  });

  await started.promise;
  controller.abort("用户停止");

  await assert.rejects(
    pending,
    (error) => error.name === "AbortError"
  );
  assert.equal(calls, 1);
});

// -- §3.1 onActivity tests --

test("onActivity called on each retry for non-streaming", async () => {
  const activityLog = [];
  let calls = 0;
  const adapter = {
    async generate() {
      calls++;
      if (calls <= 2) {
        throw new ProviderTransportError("Retryable", { reason: "server-retryable" });
      }
      return { text: "ok", usage: {} };
    }
  };
  const client = new ModelClient({
    adapters: { mock: adapter },
    activeModel: { provider: "mock", model_name: "test" },
    retryMax: 2,
    retryBaseDelayMs: 10,
    retryMaxDelayMs: 10,
    onActivity: () => { activityLog.push(Date.now()); }
  });

  const result = await client.generate({ prompt: "hi" });
  assert.equal(result.text, "ok");
  // 2 retries from 2 failures -> 2 onActivity calls
  assert.equal(activityLog.length, 2);
});

test("onActivity called via metadata during streaming", async () => {
  const activityLog = [];
  const adapter = {
    async generate({ metadata }) {
      // Simulate SSE streaming: call onActivity on each chunk
      for (let i = 0; i < 5; i++) {
        metadata?.onActivity?.();
      }
      return { text: "stream complete", usage: {} };
    }
  };
  const client = new ModelClient({
    adapters: { mock: adapter },
    activeModel: { provider: "mock", model_name: "test" },
    onActivity: () => { activityLog.push(Date.now()); }
  });

  const result = await client.generate({ prompt: "hi" });
  assert.equal(result.text, "stream complete");
  assert.equal(activityLog.length, 5, "onActivity should be called 5 times (one per simulated chunk)");
});

test("onActivity not set in metadata when not configured", async () => {
  const adapter = {
    async generate({ metadata }) {
      assert.equal(metadata?.onActivity, undefined);
      return { text: "ok", usage: {} };
    }
  };
  const client = new ModelClient({
    adapters: { mock: adapter },
    activeModel: { provider: "mock", model_name: "test" }
  });

  const result = await client.generate({ prompt: "hi" });
  assert.equal(result.text, "ok");
});

test("onActivity not called on first successful non-streaming attempt", async () => {
  const activityLog = [];
  const adapter = {
    async generate() {
      return { text: "ok", usage: {} };
    }
  };
  const client = new ModelClient({
    adapters: { mock: adapter },
    activeModel: { provider: "mock", model_name: "test" },
    onActivity: () => { activityLog.push(Date.now()); }
  });

  await client.generate({ prompt: "hi" });
  assert.equal(activityLog.length, 0, "no retry -> no onActivity for non-streaming");
});

test("total deadline exceeded throws timeout error without further retries", async () => {
  const adapter = {
    async generate() {
      // Simulate a slow response that always takes too long
      throw new ProviderTransportError("Timeout", { reason: "timeout" });
    }
  };
  const client = makeClient(adapter, {
    retryMax: 3,
    retryBaseDelayMs: 10,
    retryMaxDelayMs: 10,
    timeoutMs: 50,
    totalDeadlineMs: 80, // Very tight deadline — will be exceeded after 1 attempt + backoff
  });
  await assert.rejects(
    () => client.generate({ prompt: "hi" }),
    (err) => {
      assert.equal(err.code, "provider_transport_error");
      assert.equal(err.reason, "timeout");
      return true;
    }
  );
});

test("stage-aware timeout from modelConfig overrides constructor timeout", async () => {
  const calls = [];
  const adapter = {
    async generate({ modelConfig }) {
      calls.push(modelConfig.timeout_ms);
      throw new ProviderTransportError("Timeout", { reason: "timeout" });
    }
  };
  // Constructor timeoutMs=1000, but modelConfig.timeout_ms=200 via project config
  const client = makeClient(adapter, {
    retryMax: 1,
    timeoutMs: 1000,
    retryBaseDelayMs: 10,
    retryMaxDelayMs: 10,
  });
  await assert.rejects(
    () => client.generate({
      prompt: "hi",
      project: {
        active_model: {
          provider: "mock",
          model_name: "test-model",
          timeout_ms: 200
        }
      }
    }),
    (err) => {
      assert.equal(err.code, "provider_transport_error");
      return true;
    }
  );
  // The timeout_ms should be passed through modelConfig to the adapter
  assert.equal(calls[0], 200);
});

test("retryAfterMs is preferred over calculated backoff in retry wait", async () => {
  const retryLog = [];
  let calls = 0;
  const adapter = {
    async generate() {
      calls++;
      if (calls === 1) {
        // First attempt fails with 429 and Retry-After
        const err = new ProviderTransportError("Rate limited", { status: 429, retryAfterMs: 5000 });
        throw err;
      }
      return { text: "ok", usage: {} };
    }
  };
  const client = makeClient(adapter, {
    retryMax: 2,
    retryBaseDelayMs: 10,
    retryMaxDelayMs: 100,
    onRetry(info) {
      retryLog.push({ ...info });
    }
  });
  const result = await client.generate({ prompt: "hi" });
  assert.equal(result.text, "ok");
  assert.equal(calls, 2);
  assert.equal(retryLog.length, 1);
  // delay should be at least 5000 (the retryAfterMs value), not the small backoff
  assert.ok(retryLog[0].delay >= 5000, `expected delay >= 5000, got ${retryLog[0].delay}`);
});

test("onActivity preserves existing metadata fields", async () => {
  const adapter = {
    async generate({ metadata }) {
      assert.equal(metadata.userField, "hello");
      assert.equal(typeof metadata.onActivity, "function");
      return { text: "ok", usage: {} };
    }
  };
  const client = new ModelClient({
    adapters: { mock: adapter },
    activeModel: { provider: "mock", model_name: "test" },
    onActivity: () => {}
  });

  await client.generate({ prompt: "hi", metadata: { userField: "hello" } });
});

// §3.5: Failed call recording in costTracker
test("failed final attempt records failed call in costTracker", async () => {
  const { CostTracker } = await import("../src/core/cost-tracker.mjs");
  let calls = 0;
  const adapter = {
    async generate() {
      calls++;
      throw new ProviderTransportError("Fatal error", { status: 400 });
    }
  };
  const costTracker = new CostTracker();
  const client = makeClient(adapter, { costTracker, retryMax: 0 });
  await assert.rejects(() => client.generate({ prompt: "hi" }));
  const s = costTracker.getSummary();
  assert.equal(s.failedCalls, 1, "failed call should be recorded");
  assert.equal(s.calls, 1, "failed call still counts as a call");
});

test("failed final attempt with provider partial usage records failed call with tokens", async () => {
  const { CostTracker } = await import("../src/core/cost-tracker.mjs");
  let calls = 0;
  const adapter = {
    async generate() {
      calls++;
      const err = new ProviderTransportError("Rate limited with usage", { status: 429 });
      // Provider returned usage info even on error (some providers do this)
      err.usage = { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 };
      throw err;
    }
  };
  const costTracker = new CostTracker();
  const client = makeClient(adapter, { costTracker, retryMax: 0 });
  await assert.rejects(() => client.generate({ prompt: "hi" }));
  const s = costTracker.getSummary();
  assert.equal(s.failedCalls, 1);
  assert.equal(s.calls, 1);
  assert.ok(s.inputTokens >= 50, `expected inputTokens >= 50, got ${s.inputTokens}`);
  assert.ok(s.outputTokens >= 10, `expected outputTokens >= 10, got ${s.outputTokens}`);
});

test("timeout also records a failed call in costTracker", async () => {
  const { CostTracker } = await import("../src/core/cost-tracker.mjs");
  const costTracker = new CostTracker();
  const hanging = new HangingAdapter();
  const client = makeClient(hanging, { costTracker, retryMax: 0, timeoutMs: 50 });
  await assert.rejects(() => client.generate({ prompt: "hi" }));
  const s = costTracker.getSummary();
  assert.equal(s.failedCalls, 1, "timeout should record a failed call");
  assert.equal(s.calls, 1);
});

test("non-streaming request emits periodic onActivity heartbeat while pending", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const activityLog = [];
  const adapter = {
    async generate() {
      await gate;
      return { text: "done", raw: {}, usage: null, cost: null };
    },
  };
  const client = makeClient(adapter, {
    heartbeatMs: 10,
    onActivity: () => { activityLog.push(Date.now()); },
  });
  const pending = client.generate({ prompt: "hi" });
  await new Promise((resolve) => setTimeout(resolve, 35));
  release();
  await pending;
  assert.ok(activityLog.length >= 2, `expected >=2 heartbeats, got ${activityLog.length}`);
});

test("heartbeat timer is cleaned up after request completes", async () => {
  const adapter = {
    async generate() { return { text: "done", raw: {}, usage: null, cost: null }; },
  };
  const client = makeClient(adapter, { heartbeatMs: 5, onActivity: () => {} });
  await client.generate({ prompt: "hi" });
  // 心跳若未清理，进程会有存活 timer；用间接方式验证：快速请求期间不应触发心跳。
  const activityLog = [];
  const client2 = makeClient(adapter, { heartbeatMs: 5, onActivity: () => { activityLog.push(1); } });
  await client2.generate({ prompt: "hi" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(activityLog.length, 0);
});

test("external abort racing with timeout yields AbortError exactly once, no retry", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers();
  let calls = 0;
  const adapter = {
    async generate({ signal }) {
      calls += 1;
      started.resolve();
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    },
  };
  // timeoutMs 设得极短，使用户 abort 与 timeout 落在同一窗口。
  const client = makeClient(adapter, { retryMax: 3, timeoutMs: 5 });
  const pending = client.generate({ prompt: "hi", signal: controller.signal });
  await started.promise;
  controller.abort("用户停止");
  await assert.rejects(pending, (error) => error.name === "AbortError");
  // 给潜在的重试留出时间窗，确认没有第二次调用。
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls, 1);
});

// -- Task 2（规格书 6.2）：网络恢复 onRecovered 回调 --

test("onRecovered fires after retry succeeds, attempt = 1", async () => {
  const retryLog = [];
  const recoveredLog = [];
  let calls = 0;
  const adapter = {
    async generate() {
      calls++;
      if (calls === 1) {
        // 网络超时（reason: "timeout"）→ 重试
        throw new ProviderTransportError("Network timeout", { reason: "timeout" });
      }
      return { text: "recovered", usage: {} };
    }
  };
  const client = makeClient(adapter, {
    retryMax: 3,
    onRetry(info) {
      retryLog.push({ ...info });
    },
    onRecovered(info) {
      recoveredLog.push({ ...info });
    }
  });
  const result = await client.generate({ prompt: "hi" });
  assert.equal(result.text, "recovered");
  assert.equal(calls, 2);
  assert.equal(retryLog.length, 1, "onRetry 应触发 1 次");
  assert.equal(retryLog[0].reason, "timeout");
  assert.equal(recoveredLog.length, 1, "onRecovered 应触发 1 次");
  assert.equal(recoveredLog[0].attempt, 1, "成功时 attempt 即已完成的重试次数");
  assert.equal(recoveredLog[0].maxAttempts, 3);
});

test("onRecovered not fired when first attempt succeeds", async () => {
  const recoveredLog = [];
  const adapter = {
    async generate() {
      return { text: "hello", usage: {} };
    }
  };
  const client = makeClient(adapter, {
    onRecovered(info) {
      recoveredLog.push({ ...info });
    }
  });
  const result = await client.generate({ prompt: "hi" });
  assert.equal(result.text, "hello");
  assert.equal(recoveredLog.length, 0, "无重试不应触发 onRecovered");
});

test("onRecovered not fired when retries are exhausted or disabled", async () => {
  // 场景 A：重试全败（1 次初始 + 2 次重试全部失败，最终 throw）→ 不是「恢复」，不触发
  const recoveredLog = [];
  let calls = 0;
  const failAdapter = {
    async generate() {
      calls++;
      throw new ProviderTransportError("Network timeout", { reason: "timeout" });
    }
  };
  const client = makeClient(failAdapter, {
    retryMax: 2,
    onRecovered(info) {
      recoveredLog.push({ ...info });
    }
  });
  await assert.rejects(
    () => client.generate({ prompt: "hi" }),
    (err) => {
      assert.equal(err.code, "provider_transport_error");
      assert.equal(err.reason, "timeout");
      return true;
    }
  );
  assert.equal(calls, 3, "1 次初始 + 2 次重试全部失败");
  assert.equal(recoveredLog.length, 0, "重试全败不是「恢复」，不应触发 onRecovered");

  // 场景 B：retryMax=0（不重试，直接失败）→ 同样不触发
  const recoveredLogNoRetry = [];
  const noRetryAdapter = {
    async generate() {
      throw new ProviderTransportError("Network timeout", { reason: "timeout" });
    }
  };
  const clientNoRetry = makeClient(noRetryAdapter, {
    retryMax: 0,
    onRecovered(info) {
      recoveredLogNoRetry.push({ ...info });
    }
  });
  await assert.rejects(() => clientNoRetry.generate({ prompt: "hi" }));
  assert.equal(recoveredLogNoRetry.length, 0, "retryMax=0 无重试，不应触发 onRecovered");
});
