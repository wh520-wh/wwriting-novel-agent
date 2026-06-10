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
    assert.equal(err.reason, "server-fatal");
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
    assert.equal(err.reason, "server-fatal");
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
