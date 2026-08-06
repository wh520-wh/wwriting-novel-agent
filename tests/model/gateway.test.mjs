// ModelGateway 测试（统一 Agent 内核计划 Task 3）。
//
// 从旧 tests/model-client-retry.test.mjs、tests/model-gateway.test.mjs 与
// tests/auxiliary-response-cache.test.mjs 迁移 retry/timeout/heartbeat/usage/
// cost/cache 可观察行为。mock adapter（src/core/model/mock.mjs）是 gateway
// 层的测试 adapter，与 harness 的 runtime 层整网关 mock 不同层。
import assert from "node:assert/strict";
import test from "node:test";
import { CostTracker } from "../../src/core/cost-tracker.mjs";
import { createMockAdapter, toolCall } from "../../src/core/model/mock.mjs";
import { createModelGateway } from "../../src/core/model/gateway.mjs";
import {
  ProviderTransportError,
  createOpenAICompatibleAdapter
} from "../../src/core/model/openai-compatible.mjs";

const BASE_REQUEST = {
  messages: [{ role: "user", content: "hi" }],
  modelConfig: { provider: "mock", model_name: "test-model" }
};

function makeGateway(adapter, overrides = {}) {
  return createModelGateway({
    adapter,
    retryBaseDelayMs: 10,
    retryMaxDelayMs: 10,
    ...overrides
  });
}

class HangingAdapter {
  constructor() {
    this.callIndex = 0;
    this.pending = 0;
  }
  async complete(request, { signal } = {}) {
    this.callIndex += 1;
    this.pending += 1;
    try {
      await new Promise((resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          },
          { once: true }
        );
      });
    } finally {
      this.pending -= 1;
    }
  }
}

// ---------------------------------------------------------------------------
// retry
// ---------------------------------------------------------------------------

test("首次成功不重试", async () => {
  let calls = 0;
  const adapter = {
    async complete() {
      calls += 1;
      return { text: "hello", usage: {} };
    }
  };
  const gateway = makeGateway(adapter);
  const result = await gateway.complete(BASE_REQUEST);
  assert.equal(result.text, "hello");
  assert.equal(calls, 1);
  assert.equal(result.attempts, 1);
  assert.equal(result.retried, false);
});

test("429 重试：失败两次后第三次成功", async () => {
  let calls = 0;
  const adapter = {
    async complete() {
      calls += 1;
      if (calls <= 2) {
        throw new ProviderTransportError("Rate limited", { status: 429 });
      }
      return { text: "ok", usage: {} };
    }
  };
  const gateway = makeGateway(adapter, { retryMax: 3 });
  const result = await gateway.complete(BASE_REQUEST);
  assert.equal(result.text, "ok");
  assert.equal(calls, 3);
  assert.equal(result.retried, true);
});

test("400 客户端错误不重试，立即失败", async () => {
  let calls = 0;
  const adapter = {
    async complete() {
      calls += 1;
      throw new ProviderTransportError("Bad request", { status: 400 });
    }
  };
  const gateway = makeGateway(adapter, { retryMax: 3 });
  await assert.rejects(() => gateway.complete(BASE_REQUEST), (err) => {
    assert.equal(err.code, "provider_transport_error");
    assert.equal(err.reason, "client-fatal");
    return true;
  });
  assert.equal(calls, 1);
});

test("401 认证错误不重试", async () => {
  let calls = 0;
  const adapter = {
    async complete() {
      calls += 1;
      throw new ProviderTransportError("Unauthorized", { status: 401 });
    }
  };
  const gateway = makeGateway(adapter, { retryMax: 3 });
  await assert.rejects(() => gateway.complete(BASE_REQUEST), (err) => {
    assert.equal(err.code, "provider_transport_error");
    assert.equal(err.reason, "client-fatal");
    return true;
  });
  assert.equal(calls, 1);
});

test("502/503/504 服务器错误可重试", async () => {
  for (const status of [502, 503, 504]) {
    let calls = 0;
    const adapter = {
      async complete() {
        calls += 1;
        if (calls === 1) {
          throw new ProviderTransportError(`HTTP ${status}`, { status });
        }
        return { text: "recovered", usage: {} };
      }
    };
    const gateway = makeGateway(adapter, { retryMax: 2 });
    const result = await gateway.complete(BASE_REQUEST);
    assert.equal(result.text, "recovered", `status ${status} should retry`);
    assert.equal(calls, 2, `status ${status}: should have retried once`);
  }
});

test("网络错误（无 status）可重试", async () => {
  let calls = 0;
  const adapter = {
    async complete() {
      calls += 1;
      if (calls === 1) {
        throw new ProviderTransportError("Network down", { reason: "network" });
      }
      return { text: "ok", usage: {} };
    }
  };
  const gateway = makeGateway(adapter, { retryMax: 2 });
  const result = await gateway.complete(BASE_REQUEST);
  assert.equal(result.text, "ok");
  assert.equal(calls, 2);
});

test("openai-compatible 网络级 fetch 失败被包装后可重试（gateway 集成）", async () => {
  let attempts = 0;
  const adapter = createOpenAICompatibleAdapter({
    baseUrl: "https://api.example.test/v1",
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new TypeError("fetch failed"); // fetch 原生网络拒绝
      }
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ choices: [{ message: { content: "ok" } }] });
        }
      };
    }
  });
  const gateway = createModelGateway({
    adapter,
    retryMax: 2,
    retryBaseDelayMs: 10,
    retryMaxDelayMs: 10
  });
  const result = await gateway.complete(BASE_REQUEST);
  assert.equal(result.text, "ok");
  assert.equal(attempts, 2, "网络错误应触发重试");
  assert.equal(result.retried, true);
  assert.equal(result.usageReport.inputTokens, 0);
});

test("默认重试上限 5 次：网络错误耗尽后共 6 次调用", async () => {
  let calls = 0;
  const adapter = {
    async complete() {
      calls += 1;
      throw new ProviderTransportError("网络波动", { reason: "network" });
    }
  };
  const gateway = makeGateway(adapter, { retryBaseDelayMs: 1, retryMaxDelayMs: 1 });
  await assert.rejects(
    () => gateway.complete(BASE_REQUEST),
    (err) => err.code === "provider_transport_error" && err.reason === "network"
  );
  assert.equal(calls, 6, "默认 retryMax=5：1 次初始 + 5 次重试");
});

test("重试耗尽后抛出原错误", async () => {
  let calls = 0;
  const adapter = {
    async complete() {
      calls += 1;
      throw new ProviderTransportError("Rate limited", { status: 429 });
    }
  };
  const gateway = makeGateway(adapter, { retryMax: 1 });
  await assert.rejects(() => gateway.complete(BASE_REQUEST), (err) => {
    assert.equal(err.code, "provider_transport_error");
    assert.equal(err.reason, "server-retryable");
    return true;
  });
  assert.equal(calls, 2);
});

test("流式 attempt 已输出正文后失败时不自动重试，避免重复增量", async () => {
  let calls = 0;
  const tokens = [];
  const adapter = {
    async complete(request) {
      calls += 1;
      request.metadata.onToken("partial");
      throw new ProviderTransportError("stream interrupted", { reason: "network" });
    }
  };
  const gateway = makeGateway(adapter, { retryMax: 3, retryBaseDelayMs: 1, retryMaxDelayMs: 1 });

  await assert.rejects(
    () => gateway.complete({
      ...BASE_REQUEST,
      stream: true,
      metadata: { onToken: (token) => tokens.push(token) }
    }),
    (error) => error.code === "provider_transport_error" && error.reason === "network"
  );

  assert.equal(calls, 1, "已公开正文的 attempt 不能再透明重试");
  assert.deepEqual(tokens, ["partial"]);
});

test("onRetry 回调携带正确字段", async () => {
  const retryLog = [];
  let calls = 0;
  const adapter = {
    async complete() {
      calls += 1;
      if (calls === 1) {
        throw new ProviderTransportError("Rate limited", { status: 429 });
      }
      return { text: "ok", usage: {} };
    }
  };
  const gateway = makeGateway(adapter, {
    retryMax: 3,
    onRetry(info) {
      retryLog.push({ ...info });
    }
  });
  const result = await gateway.complete(BASE_REQUEST);
  assert.equal(result.text, "ok");
  assert.equal(retryLog.length, 1);
  assert.equal(retryLog[0].attempt, 1);
  assert.equal(retryLog[0].maxAttempts, 3);
  assert.equal(retryLog[0].reason, "server-retryable");
  assert.equal(retryLog[0].model, "test-model");
  assert.ok(retryLog[0].delay >= 10, "delay should be at least base delay");
  assert.ok(retryLog[0].error instanceof ProviderTransportError);
});

test("onRecovered 在重试成功后通知（含 attempt 信息）", async () => {
  let recovered = null;
  let calls = 0;
  const adapter = {
    async complete() {
      calls += 1;
      if (calls === 1) {
        throw new ProviderTransportError("Rate limited", { status: 429 });
      }
      return { text: "ok", usage: {} };
    }
  };
  const gateway = makeGateway(adapter, {
    retryMax: 3,
    onRecovered(info) {
      recovered = info;
    }
  });
  await gateway.complete(BASE_REQUEST);
  assert.deepEqual(recovered, { attempt: 1, maxAttempts: 3 });
});

test("retryMax=0 时不进入重试分支，onRecovered 不触发", async () => {
  let recovered = false;
  let calls = 0;
  const adapter = {
    async complete() {
      calls += 1;
      throw new ProviderTransportError("Rate limited", { status: 429 });
    }
  };
  const gateway = makeGateway(adapter, { retryMax: 0, onRecovered: () => { recovered = true; } });
  await assert.rejects(() => gateway.complete(BASE_REQUEST));
  assert.equal(calls, 1);
  assert.equal(recovered, false);
});

// ---------------------------------------------------------------------------
// 取消与 timeout
// ---------------------------------------------------------------------------

test("预中止信号立即抛 AbortError，adapter 不被调用", async () => {
  let calls = 0;
  const adapter = {
    async complete() {
      calls += 1;
      return { text: "nope", usage: {} };
    }
  };
  const controller = new AbortController();
  controller.abort();
  const gateway = makeGateway(adapter);
  await assert.rejects(
    () => gateway.complete(BASE_REQUEST, { signal: controller.signal }),
    (err) => {
      assert.ok(err instanceof DOMException);
      assert.equal(err.name, "AbortError");
      return true;
    }
  );
  assert.equal(calls, 0, "adapter should never be called");
});

test("用户中止打断重试退避（onRetry 时 abort）", async () => {
  let calls = 0;
  const controller = new AbortController();
  const adapter = {
    async complete() {
      calls += 1;
      throw new ProviderTransportError("Rate limited", { status: 429 });
    }
  };
  const gateway = makeGateway(adapter, {
    retryBaseDelayMs: 1000,
    retryMaxDelayMs: 1000,
    retryMax: 3,
    onRetry() {
      controller.abort();
    }
  });
  await assert.rejects(
    () => gateway.complete(BASE_REQUEST, { signal: controller.signal }),
    (err) => err instanceof DOMException && err.name === "AbortError"
  );
  assert.equal(calls, 1, "abort during backoff should not start another attempt");
});

test("挂起 adapter 超时重试：包装为 ProviderTransportError(reason=timeout)", async () => {
  const hanging = new HangingAdapter();
  const gateway = makeGateway(hanging, { retryMax: 1, timeoutMs: 50 });
  await assert.rejects(
    () => gateway.complete(BASE_REQUEST),
    (err) => {
      assert.equal(err.code, "provider_transport_error");
      assert.equal(err.reason, "timeout");
      return true;
    }
  );
  assert.equal(hanging.callIndex, 2, "两次 attempt 都超时后耗尽");
});

test("超时重试到成功：timeout 后恢复", async () => {
  const hanging = new HangingAdapter();
  let fallback = false;
  const adapter = {
    async complete(request, options) {
      if (!fallback) {
        fallback = true;
        return hanging.complete(request, options);
      }
      return { text: "recovered", usage: {} };
    }
  };
  const gateway = makeGateway(adapter, { retryMax: 2, timeoutMs: 40 });
  const result = await gateway.complete(BASE_REQUEST);
  assert.equal(result.text, "recovered");
  assert.equal(result.retried, true);
});

test("modelConfig.timeout_ms 覆盖构造默认 timeout", async () => {
  const hanging = new HangingAdapter();
  const gateway = makeGateway(hanging, { retryMax: 0, timeoutMs: 5000 });
  await assert.rejects(
    () => gateway.complete({ ...BASE_REQUEST, modelConfig: { ...BASE_REQUEST.modelConfig, timeout_ms: 40 } }),
    (err) => err.code === "provider_transport_error" && err.reason === "timeout"
  );
  assert.equal(hanging.callIndex, 1);
});

test("total deadline 到时立即抛错，不重试", async () => {
  let calls = 0;
  const adapter = {
    async complete() {
      calls += 1;
      throw new ProviderTransportError("Server error", { status: 503 });
    }
  };
  // 第一次 attempt 失败后可重试，但退避后第二次 attempt 开始前总期限已过 → 立即抛错
  const gateway = makeGateway(adapter, { retryMax: 3, timeoutMs: 20000, totalDeadlineMs: 5 });
  await assert.rejects(
    () => gateway.complete(BASE_REQUEST),
    (err) => err.code === "provider_transport_error" && err.reason === "timeout" && /deadline/u.test(err.message)
  );
  assert.equal(calls, 1, "deadline 到期不应再发起新 attempt");
});

// ---------------------------------------------------------------------------
// heartbeat
// ---------------------------------------------------------------------------

test("非流式 heartbeat：attempt 挂起期间周期性回调 onActivity", async () => {
  const heartbeats = [];
  const controller = new AbortController();
  const adapter = {
    async complete(request, { signal } = {}) {
      // 让 attempt 挂起 60ms，期间应收到若干 heartbeat
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 60);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("The operation was aborted.", "AbortError"));
        }, { once: true });
      });
      return { text: "ok", usage: {} };
    }
  };
  const gateway = makeGateway(adapter, {
    heartbeatMs: 5,
    onActivity: () => heartbeats.push(Date.now())
  });
  const result = await gateway.complete(BASE_REQUEST);
  assert.equal(result.text, "ok");
  assert.ok(heartbeats.length >= 1, "挂起期间应收到 heartbeat 回调");
  void controller;
});

test("流式 adapter 经 metadata.onActivity 收到心跳（gateway 透传）", async () => {
  const seenActivity = [];
  const adapter = {
    async complete(request) {
      assert.equal(typeof request.metadata.onActivity, "function", "gateway 应注入 onActivity");
      request.metadata.onActivity("token-1");
      request.metadata.onActivity("");
      return { text: "ok", usage: {} };
    }
  };
  const gateway = makeGateway(adapter, { heartbeatMs: 0, onActivity: (token) => seenActivity.push(token) });
  await gateway.complete(BASE_REQUEST);
  assert.deepEqual(seenActivity, ["token-1", ""]);
});

// ---------------------------------------------------------------------------
// usage 与 cost 记账
// ---------------------------------------------------------------------------

test("成功调用归一化 usage 并 record 一次费用", async () => {
  const adapter = {
    async complete() {
      return {
        text: "ok",
        usage: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 }
      };
    }
  };
  const gateway = makeGateway(adapter);
  const result = await gateway.complete(BASE_REQUEST);
  assert.equal(result.usageReport.inputTokens, 100);
  assert.equal(result.usageReport.outputTokens, 25);
  assert.equal(result.usageReport.totalTokens, 125);
  assert.equal(result.costSummary.calls, 1);
  assert.equal(result.costSummary.failedCalls, 0);
});

test("配置价格时成功调用计算 estimatedCost", async () => {
  const adapter = {
    async complete() {
      return { text: "ok", usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 } };
    }
  };
  const pricing = { "test-model": { input_per_million: 10, output_per_million: 20 } };
  const costTracker = new CostTracker({ pricing });
  const gateway = makeGateway(adapter, { costTracker });
  const result = await gateway.complete(BASE_REQUEST);
  assert.equal(result.costSummary.calls, 1);
  assert.equal(result.costSummary.pricedCalls, 1);
  assert.equal(result.costSummary.estimatedCost, 20); // 10 * 1 + 20 * 0.5
  assert.equal(result.costSummary.costAvailable, true);
});

test("最终失败记账：failed=true 且失败次数计入", async () => {
  const adapter = {
    async complete() {
      throw new ProviderTransportError("Bad request", { status: 400 });
    }
  };
  const gateway = makeGateway(adapter, { retryMax: 0 });
  await assert.rejects(() => gateway.complete(BASE_REQUEST));
  const summary = gateway.getSummary();
  assert.equal(summary.calls, 1);
  assert.equal(summary.failedCalls, 1);
  assert.equal(summary.totalTokens, 0);
});

test("重试期间失败的 attempt 不单独记账（与旧 ModelClient 一致：最终失败才记 failed）", async () => {
  let calls = 0;
  const adapter = {
    async complete() {
      calls += 1;
      if (calls === 1) {
        const error = new ProviderTransportError("Server error", { status: 503 });
        error.usage = { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 };
        throw error;
      }
      return { text: "ok", usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
    }
  };
  const gateway = makeGateway(adapter, { retryMax: 2 });
  await gateway.complete(BASE_REQUEST);
  const summary = gateway.getSummary();
  assert.equal(summary.calls, 1, "只记成功调用一次");
  assert.equal(summary.failedCalls, 0, "被重试吸收的失败不记 failed");
  assert.equal(summary.totalTokens, 12, "仅成功 usage 累计");
  assert.equal(summary.retries, 1);
});

test("provider 错误携带 usage 时最终失败记账仍累计 token", async () => {
  let calls = 0;
  const adapter = {
    async complete() {
      calls += 1;
      const error = new ProviderTransportError("Server error", { status: 503 });
      error.usage = { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 };
      throw error;
    }
  };
  const gateway = makeGateway(adapter, { retryMax: 1 });
  await assert.rejects(() => gateway.complete(BASE_REQUEST));
  const summary = gateway.getSummary();
  assert.equal(summary.calls, 1, "最终失败记账一次");
  assert.equal(summary.failedCalls, 1);
  assert.equal(summary.totalTokens, 35, "最终失败携带的 usage 也累计");
});

test("每次重试 recordRetry 一次", async () => {
  let calls = 0;
  const adapter = {
    async complete() {
      calls += 1;
      if (calls <= 2) {
        throw new ProviderTransportError("Rate limited", { status: 429 });
      }
      return { text: "ok", usage: {} };
    }
  };
  const gateway = makeGateway(adapter, { retryMax: 3 });
  await gateway.complete(BASE_REQUEST);
  assert.equal(gateway.getSummary().retries, 2);
});

test("stage/chapter 经 metadata 传入记账", async () => {
  const adapter = {
    async complete() {
      return { text: "ok", usage: { prompt_tokens: 5, completion_tokens: 1 } };
    }
  };
  const gateway = makeGateway(adapter);
  await gateway.complete({
    ...BASE_REQUEST,
    metadata: { stage: "memory_extract", chapterNo: 3 }
  });
  const summary = gateway.getSummary();
  assert.equal(summary.byStage["memory_extract"].calls, 1);
  assert.equal(summary.byChapter["3"].calls, 1);
});

test("工具调用响应透传 toolCalls（归一化为 { id, name, arguments } 规范形状）", async () => {
  const adapter = createMockAdapter({
    script: [
      {
        reply: {
          toolCalls: [toolCall("list_files", { path: "chapters" })]
        }
      }
    ]
  });
  const gateway = makeGateway(adapter);
  const result = await gateway.complete({ ...BASE_REQUEST, tools: [{ type: "function", function: { name: "list_files" } }] });
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, "list_files");
  assert.deepEqual(result.toolCalls[0].arguments, { path: "chapters" });
  assert.ok(result.toolCalls[0].id);
});

// ---------------------------------------------------------------------------
// 确定性响应缓存（辅助调用去重，L3 行为迁移）
// ---------------------------------------------------------------------------

function cacheRequest(overrides = {}) {
  return {
    ...BASE_REQUEST,
    modelConfig: { provider: "mock", model_name: "test-model", temperature: 0, ...(overrides.modelConfig ?? {}) },
    metadata: { cacheable: true, chapterNo: 1, attempt: 0, ...(overrides.metadata ?? {}) },
    ...overrides
  };
}

test("缓存命中：相同辅助请求第二次不调 adapter、usage 归零、费用不新增", async () => {
  const adapter = createMockAdapter({
    script: [{ reply: { text: "辅助响应文本", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } }]
  });
  const gateway = makeGateway(adapter);
  const first = await gateway.complete(cacheRequest());
  const second = await gateway.complete(cacheRequest());

  assert.equal(adapter.calls.length, 1, "第二次应命中缓存，不再调 adapter");
  assert.equal(first.text, second.text);
  assert.equal(second.cached, true);
  assert.equal(second.usageReport.inputTokens, 0, "命中 usage 应归零");
  assert.equal(second.usageReport.totalTokens, 0);
  assert.equal(second.costSummary.calls, 1, "命中不 record 费用：累计调用数应保持 1");
  assert.equal(gateway.getSummary().calls, 1);
});

test("重试豁免：attempt>0 的请求既不查缓存也不写缓存", async () => {
  const adapter = createMockAdapter({
    script: [{ reply: { text: "ok", usage: { prompt_tokens: 1, completion_tokens: 1 } } }]
  });
  const gateway = makeGateway(adapter);

  // attempt=1 两次相同请求：每次都调 adapter（不查缓存）
  await gateway.complete(cacheRequest({ metadata: { cacheable: true, chapterNo: 1, attempt: 1 } }));
  await gateway.complete(cacheRequest({ metadata: { cacheable: true, chapterNo: 1, attempt: 1 } }));
  assert.equal(adapter.calls.length, 2, "attempt=1 应豁免缓存查询");

  // attempt=1 的响应不写缓存：之后 attempt=0 相同请求仍调 adapter
  await gateway.complete(cacheRequest());
  assert.equal(adapter.calls.length, 3, "attempt=1 的响应不应写入缓存");

  // 反向：attempt=0 已缓存后，attempt=1 相同请求仍不命中（重试预期新调用）
  await gateway.complete(cacheRequest());
  await gateway.complete(cacheRequest({ metadata: { cacheable: true, chapterNo: 1, attempt: 1 } }));
  assert.equal(adapter.calls.length, 4, "attempt=1 不应读取 attempt=0 的缓存");
});

test("条件排除：带工具或流式的请求不缓存", async () => {
  const adapter = createMockAdapter({
    script: [{ reply: { text: "ok", usage: { prompt_tokens: 1, completion_tokens: 1 } } }]
  });
  const gateway = makeGateway(adapter);

  const withTools = cacheRequest({ tools: [{ type: "function", function: { name: "read_file" } }] });
  await gateway.complete(withTools);
  await gateway.complete(withTools);
  assert.equal(adapter.calls.length, 2, "带工具请求不缓存");

  const streaming = cacheRequest({ stream: true });
  await gateway.complete(streaming);
  await gateway.complete(streaming);
  assert.equal(adapter.calls.length, 4, "流式请求不缓存");
});

test("条件排除：temperature!=0 或模型不支持 temperature 时不可缓存", async () => {
  const adapter = createMockAdapter({
    script: [{ reply: { text: "ok", usage: { prompt_tokens: 1, completion_tokens: 1 } } }]
  });
  const gateway = makeGateway(adapter);

  const warm = cacheRequest({ modelConfig: { temperature: 0.7 } });
  await gateway.complete(warm);
  await gateway.complete(warm);
  assert.equal(adapter.calls.length, 2, "temperature!=0 不缓存");

  // thinking 模型（supportsTemperature=false）不缓存：确定性前提不成立
  const thinking = cacheRequest({
    modelConfig: {
      temperature: 0,
      base_url: "https://api.deepseek.com/v1",
      model_name: "deepseek-v4-pro"
    }
  });
  await gateway.complete(thinking);
  await gateway.complete(thinking);
  assert.equal(adapter.calls.length, 4, "不支持 temperature 的模型不缓存");
});

test("请求体不同不命中缓存", async () => {
  const adapter = createMockAdapter({
    script: [{ reply: { text: "ok", usage: { prompt_tokens: 1, completion_tokens: 1 } } }]
  });
  const gateway = makeGateway(adapter);
  await gateway.complete(cacheRequest({ messages: [{ role: "user", content: "内容 A" }] }));
  await gateway.complete(cacheRequest({ messages: [{ role: "user", content: "内容 B" }] }));
  assert.equal(adapter.calls.length, 2, "messages 不同不应命中");
});

test("缓存 LRU：超过容量后最久未用条目被淘汰", async () => {
  const adapter = createMockAdapter({
    script: [{ reply: { text: "ok", usage: { prompt_tokens: 1, completion_tokens: 1 } } }]
  });
  const gateway = makeGateway(adapter, { responseCacheSize: 2 });
  const requestA = cacheRequest({ messages: [{ role: "user", content: "A" }] });
  const requestB = cacheRequest({ messages: [{ role: "user", content: "B" }] });
  const requestC = cacheRequest({ messages: [{ role: "user", content: "C" }] });

  const r1 = await gateway.complete(requestA); // 调用 1：缓存 {A}
  const r2 = await gateway.complete(requestB); // 调用 2：缓存 {A,B}
  const r3 = await gateway.complete(requestA); // 命中：A 刷新为最新，LRU 序 {B,A}
  const r4 = await gateway.complete(requestC); // 调用 3：挤掉 B，缓存 {A,C}
  const r5 = await gateway.complete(requestA); // 命中：A 存活
  const r6 = await gateway.complete(requestB); // 调用 4：B 已被淘汰
  const r7 = await gateway.complete(requestB); // 命中：B 回到缓存

  assert.equal(adapter.calls.length, 4);
  assert.equal(r1.cached, false);
  assert.equal(r3.cached, true, "A 被 B 之后访问后仍应在缓存中");
  assert.equal(r5.cached, true, "插入 C 只淘汰最久未用的 B，不淘汰 A");
  assert.equal(r6.cached, false, "B 已被淘汰");
  assert.equal(r7.cached, true);
});

// ---------------------------------------------------------------------------
// mock adapter 自身契约（gateway 集成形状）
// ---------------------------------------------------------------------------

test("mock adapter：脚本耗尽后返回默认答复，函数条目可断言", async () => {
  const seen = [];
  const adapter = createMockAdapter({
    script: [
      (request) => {
        seen.push(request);
        return { text: "custom", usage: { prompt_tokens: 3, completion_tokens: 1 } };
      },
      { reply: { text: "second" }, repeat: true }
    ]
  });
  const gateway = makeGateway(adapter);
  const first = await gateway.complete(BASE_REQUEST);
  assert.equal(first.text, "custom");
  assert.deepEqual(seen[0].messages, BASE_REQUEST.messages);
  const second = await gateway.complete(BASE_REQUEST);
  assert.equal(second.text, "second");
  const third = await gateway.complete(BASE_REQUEST);
  assert.equal(third.text, "second", "repeat 条目不消费游标");
});

test("mock adapter：error 条目与 usage 注入", async () => {
  const adapter = createMockAdapter({
    script: [
      { error: new ProviderTransportError("down", { status: 503 }) },
      { reply: { text: "ok" }, usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }
    ]
  });
  const gateway = makeGateway(adapter, { retryMax: 2 });
  const result = await gateway.complete(BASE_REQUEST);
  assert.equal(result.text, "ok");
  assert.equal(result.usageReport.inputTokens, 7);
  assert.equal(adapter.calls.length, 2);
});

test("mock adapter：外部信号中止抛 AbortError，gateway 不重试", async () => {
  const controller = new AbortController();
  const adapter = createMockAdapter({ script: [{ reply: { text: "slow" } }], delayMs: 60 });
  const gateway = makeGateway(adapter, { retryMax: 3 });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(
    () => gateway.complete(BASE_REQUEST, { signal: controller.signal }),
    (err) => err instanceof DOMException && err.name === "AbortError"
  );
  assert.equal(adapter.calls.length, 1);
});

test("createModelGateway 拒绝无 complete 的 adapter", () => {
  assert.throws(
    () => createModelGateway({ adapter: {} }),
    TypeError
  );
  assert.throws(
    () => createModelGateway({ adapter: null }),
    TypeError
  );
});

// ---------------------------------------------------------------------------
// 契约：reply.reasoning 透传（Task 1 冻结 §2.1）
// ---------------------------------------------------------------------------

test("契约：gateway 透传 reply.reasoning，reasoning 与正文互不兜底", async () => {
  const reasoningTokens = [];
  const adapter = {
    async complete(request) {
      request.metadata.onReasoningToken?.("先检查事实，");
      request.metadata.onReasoningToken?.("再回答。");
      return { text: "最终回答", reasoning: "先检查事实，再回答。", usage: {} };
    }
  };
  const gateway = makeGateway(adapter);
  const reply = await gateway.complete({
    ...BASE_REQUEST,
    metadata: { onReasoningToken: (token) => reasoningTokens.push(token) }
  });
  assert.equal(reply.text, "最终回答");
  assert.equal(reply.reasoning, "先检查事实，再回答。");
  assert.deepEqual(reasoningTokens, ["先检查事实，", "再回答。"]);
});

test("流式 attempt 已输出 reasoning token 后失败时不自动重试，避免重复推理", async () => {
  let calls = 0;
  const reasoningTokens = [];
  const adapter = {
    async complete(request) {
      calls += 1;
      request.metadata.onReasoningToken("think");
      throw new ProviderTransportError("stream interrupted", { reason: "network" });
    }
  };
  const gateway = makeGateway(adapter, { retryMax: 3, retryBaseDelayMs: 1, retryMaxDelayMs: 1 });

  await assert.rejects(
    () => gateway.complete({
      ...BASE_REQUEST,
      stream: true,
      metadata: { onReasoningToken: (token) => reasoningTokens.push(token) }
    }),
    (error) => error.code === "provider_transport_error" && error.reason === "network"
  );

  assert.equal(calls, 1, "已公开 reasoning 的 attempt 不能再透明重试");
  assert.deepEqual(reasoningTokens, ["think"]);
});

test("缓存命中：reasoning 一并存取，第二次返回相同 reasoning", async () => {
  let calls = 0;
  const adapter = {
    async complete() {
      calls += 1;
      return { text: "辅助响应", reasoning: "辅助推理", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    }
  };
  const gateway = makeGateway(adapter);
  const first = await gateway.complete(cacheRequest());
  const second = await gateway.complete(cacheRequest());

  assert.equal(calls, 1, "第二次应命中缓存，不再调 adapter");
  assert.equal(first.reasoning, "辅助推理");
  assert.equal(second.cached, true);
  assert.equal(second.reasoning, "辅助推理", "缓存命中时 reasoning 一并返回");
});
