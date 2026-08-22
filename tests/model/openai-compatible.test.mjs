// OpenAI-compatible adapter 测试（统一 Agent 内核计划 Task 3）。
//
// 只测 transport 与响应归一化：请求构造、原生 function calling、SSE 流式、
// usage 归一化、错误分类、能力净化。adapter 不得添加任何 system message、
// 不得包含业务身份文本或工具定义表。
import assert from "node:assert/strict";
import test from "node:test";
import { registerProviderCapabilityResolver } from "../../src/core/model/capabilities.mjs";
import {
  ModelToolsUnsupportedError,
  OpenAICompatibleAdapter,
  ProviderConfigurationError,
  ProviderTransportError,
  createOpenAICompatibleAdapter
} from "../../src/core/model/openai-compatible.mjs";

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(payload);
    }
  };
}

function streamResponse(sseText) {
  // 整段 SSE 文本作为单 chunk 交付；帧跨 chunk 的拼接由独立测试覆盖
  const chunks = [sseText];
  return {
    ok: true,
    status: 200,
    text: async () => {
      throw new Error("streaming path should not call response.text()");
    },
    body: {
      getReader() {
        let index = 0;
        return {
          read() {
            if (index >= chunks.length) return Promise.resolve({ done: true, value: undefined });
            return Promise.resolve({ done: false, value: new TextEncoder().encode(chunks[index++]) });
          }
        };
      }
    }
  };
}

function makeAdapter({ baseUrl = "https://api.example.test/v1", apiKey = "test-key", fetchImpl, ...rest } = {}) {
  return createOpenAICompatibleAdapter({ baseUrl, apiKey, fetchImpl, ...rest });
}

// ---------------------------------------------------------------------------
// 基础请求与响应归一化
// ---------------------------------------------------------------------------

test("发送 chat completion 请求并提取 usage（含 prompt_tokens_details.cached_tokens）", async () => {
  let captured = null;
  const adapter = makeAdapter({
    fetchImpl: async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return jsonResponse({
        choices: [{ message: { content: "adapter response" } }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          prompt_tokens_details: { cached_tokens: 4 }
        }
      });
    }
  });

  const result = await adapter.complete({
    messages: [{ role: "user", content: "Write through tools." }],
    modelConfig: { model_name: "writer-model", max_output_tokens: 42, temperature: 0.2 }
  });

  assert.equal(captured.url, "https://api.example.test/v1/chat/completions");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers.authorization, "Bearer test-key");
  assert.equal(captured.body.model, "writer-model");
  assert.equal(captured.body.max_tokens, 42);
  assert.equal(captured.body.messages[0].content, "Write through tools.");
  assert.equal(result.text, "adapter response");
  assert.equal(result.usage.cached_tokens, 4);
  assert.equal(result.toolCalls.length, 0);
});

test("请求体 model 使用 modelConfig.model_name（名字原样透传，adapter 不剥离）", async () => {
  let captured = null;
  const adapter = makeAdapter({
    fetchImpl: async (url, init) => {
      captured = JSON.parse(init.body);
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    }
  });
  // modelConfig 原样携带 model_name（尾标机制已淘汰）；adapter 原样发送。
  await adapter.complete({
    messages: [{ role: "user", content: "hi" }],
    modelConfig: { model_name: "model" }
  });
  assert.equal(captured.model, "model");
});

test("complete 默认走 chat/completions endpoint，且支持自定义 endpoint", async () => {
  let capturedUrl = null;
  const adapter = makeAdapter({
    fetchImpl: async (url) => {
      capturedUrl = url;
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    }
  });
  await adapter.complete({ messages: [{ role: "user", content: "hi" }], modelConfig: { model_name: "m" } });
  assert.equal(capturedUrl, "https://api.example.test/v1/chat/completions");

  const custom = makeAdapter({
    baseUrl: "https://api.example.test/v2/",
    endpoint: "/responses",
    fetchImpl: async (url) => {
      capturedUrl = url;
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    }
  });
  await custom.complete({ messages: [{ role: "user", content: "hi" }], modelConfig: { model_name: "m" } });
  assert.equal(capturedUrl, "https://api.example.test/v2/responses");
});

test("转发 AbortSignal 给 fetch", async () => {
  const controller = new AbortController();
  let captured = null;
  const adapter = makeAdapter({
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    }
  });
  await adapter.complete(
    { messages: [{ role: "user", content: "hello" }], modelConfig: { model_name: "writer-model" } },
    { signal: controller.signal }
  );
  assert.equal(captured.init.signal, controller.signal);
});

test("缺少 base_url 时抛 ProviderConfigurationError", async () => {
  const adapter = new OpenAICompatibleAdapter({});
  await assert.rejects(
    () => adapter.complete({ messages: [{ role: "user", content: "hi" }], modelConfig: { model_name: "m" } }),
    (error) => error instanceof ProviderConfigurationError && /base_url/u.test(error.message)
  );
});

test("缺少模型名时抛 ProviderConfigurationError", async () => {
  const adapter = makeAdapter({ fetchImpl: async () => jsonResponse({}) });
  await assert.rejects(
    () => adapter.complete({ messages: [{ role: "user", content: "hi" }], modelConfig: {} }),
    (error) => error instanceof ProviderConfigurationError && /model_name/u.test(error.message)
  );
});

test("缺少配置的 API key 环境变量时抛 ProviderConfigurationError", async () => {
  // 构造函数不提供 apiKey：必须走环境变量解析
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://api.example.test/v1",
    apiKeyEnv: "MISSING_ENV_TEST_KEY",
    fetchImpl: async () => {
      throw new Error("fetch should not be called");
    }
  });
  await assert.rejects(
    () =>
      adapter.complete({
        messages: [{ role: "user", content: "hello" }],
        modelConfig: { model_name: "writer-model" }
      }),
    (error) => error instanceof ProviderConfigurationError && /MISSING_ENV_TEST_KEY/u.test(error.message)
  );
});

test("非 2xx 响应包装为 ProviderTransportError（status/body/retryAfter）", async () => {
  const adapter = makeAdapter({
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      headers: {
        get(name) {
          if (name === "retry-after") return "5";
          return null;
        }
      },
      async text() {
        return "rate limited";
      }
    })
  });
  await assert.rejects(
    () => adapter.complete({ messages: [{ role: "user", content: "hello" }], modelConfig: { model_name: "m" } }),
    (error) => {
      assert.ok(error instanceof ProviderTransportError);
      assert.equal(error.status, 429);
      assert.equal(error.body, "rate limited");
      assert.equal(error.retryAfterMs, 5000);
      assert.equal(error.reason, "server-retryable");
      return true;
    }
  );
});

test("成功响应但 JSON 非法时包装为 ProviderTransportError", async () => {
  const adapter = makeAdapter({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() {
        return "<html>login expired</html>";
      }
    })
  });
  await assert.rejects(
    () => adapter.complete({ messages: [{ role: "user", content: "hello" }], modelConfig: { model_name: "m" } }),
    (error) => error instanceof ProviderTransportError && error.status === 200 && /Invalid JSON/u.test(error.message)
  );
});

test("fetch 网络级拒绝包装为 ProviderTransportError(reason=network)，保留原错误为 cause", async () => {
  const adapter = makeAdapter({
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    }
  });
  await assert.rejects(
    () => adapter.complete({ messages: [{ role: "user", content: "hello" }], modelConfig: { model_name: "m" } }),
    (error) => {
      assert.ok(error instanceof ProviderTransportError);
      assert.equal(error.code, "provider_transport_error");
      assert.equal(error.reason, "network");
      assert.ok(error.cause instanceof TypeError, "原网络错误保留在 cause 字段");
      assert.match(error.message, /fetch failed/u);
      return true;
    }
  );
});

test("fetch 因 AbortSignal 中止时原样上抛 AbortError（不包装为网络错误）", async () => {
  const controller = new AbortController();
  const adapter = makeAdapter({
    fetchImpl: async () => {
      controller.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    }
  });
  await assert.rejects(
    () => adapter.complete(
      { messages: [{ role: "user", content: "hello" }], modelConfig: { model_name: "m" } },
      { signal: controller.signal }
    ),
    (error) => error instanceof DOMException && error.name === "AbortError"
  );
});

// ---------------------------------------------------------------------------
// 原生 function calling（工具表由调用方装配传入；adapter 不注入任何 system）
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "列出目录",
      parameters: { type: "object", properties: {} }
    }
  }
];

test("tools + tool_choice=auto 原样注入，messages 不变，不添加 system message", async () => {
  let captured = null;
  const adapter = makeAdapter({
    fetchImpl: async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return jsonResponse({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "list_files",
                    arguments: JSON.stringify({ path: "chapters" })
                  }
                }
              ]
            }
          }
        ],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }
      });
    }
  });

  const messages = [
    { role: "system", content: "系统层由装配方提供" },
    { role: "user", content: "看看有哪些章节文件" }
  ];
  const result = await adapter.complete({ messages, tools: TOOLS, toolChoice: "auto", modelConfig: { model_name: "writer-model" } });

  assert.deepEqual(captured.body.messages, messages, "adapter 不得修改或添加任何 message");
  assert.deepEqual(captured.body.tools, TOOLS, "工具表原样注入");
  assert.equal(captured.body.tool_choice, "auto");
  assert.equal(captured.body.stream, undefined);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].tool, "list_files");
  assert.deepEqual(result.toolCalls[0].input, { path: "chapters" });
  assert.equal(result.toolCalls[0].id, "call_1");
});

test("空工具数组不注入 {tools: [], tool_choice: ...}", async () => {
  let captured = null;
  const adapter = makeAdapter({
    fetchImpl: async (url, init) => {
      captured = JSON.parse(init.body);
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    }
  });
  await adapter.complete({ messages: [{ role: "user", content: "hi" }], tools: [], modelConfig: { model_name: "m" } });
  assert.equal(captured.tools, undefined);
  assert.equal(captured.tool_choice, undefined);
});

test("显式 toolChoice 透传", async () => {
  let captured = null;
  const adapter = makeAdapter({
    fetchImpl: async (url, init) => {
      captured = JSON.parse(init.body);
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    }
  });
  const forced = { type: "function", function: { name: "list_files" } };
  await adapter.complete({ messages: [{ role: "user", content: "hi" }], tools: TOOLS, toolChoice: forced, modelConfig: { model_name: "m" } });
  assert.deepEqual(captured.tool_choice, forced);
});

test("模型不支持工具时带工具请求抛 MODEL_TOOLS_UNSUPPORTED", async () => {
  registerProviderCapabilityResolver(
    (modelConfig) => String(modelConfig.base_url ?? "").includes("api.no-tools-vendor.com"),
    () => ({
      supportsThinking: false,
      requiresAutoToolChoice: false,
      supportsTemperature: true,
      supportsTopP: true,
      supportsJsonOutput: true,
      supportsTools: false,
      supportsStreaming: true
    })
  );
  const adapter = makeAdapter({
    baseUrl: "https://api.no-tools-vendor.com/v1",
    fetchImpl: async () => {
      throw new Error("fetch should not be called");
    }
  });
  await assert.rejects(
    () =>
      adapter.complete({
        messages: [{ role: "user", content: "hi" }],
        tools: TOOLS,
        modelConfig: { model_name: "no-tools-model" }
      }),
    (error) => error instanceof ModelToolsUnsupportedError && error.code === "MODEL_TOOLS_UNSUPPORTED"
  );
  // 同供应商不带工具时仍可正常请求（能力缺失只拒绝工具任务）
  const okAdapter = makeAdapter({
    baseUrl: "https://api.no-tools-vendor.com/v1",
    fetchImpl: async () => jsonResponse({ choices: [{ message: { content: "ok" } }] })
  });
  const result = await okAdapter.complete({ messages: [{ role: "user", content: "hi" }], modelConfig: { model_name: "no-tools-model" } });
  assert.equal(result.text, "ok");
});

// ---------------------------------------------------------------------------
// 能力净化（temperature/top_p / response_format）
// ---------------------------------------------------------------------------

test("thinking 模型不注入 temperature/top_p（400 防护）", async () => {
  const calls = [];
  const adapter = makeAdapter({
    baseUrl: "https://api.deepseek.com/v1",
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return jsonResponse({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }
  });
  await adapter.complete({
    messages: [{ role: "user", content: "hi" }],
    modelConfig: { base_url: "https://api.deepseek.com/v1", model_name: "deepseek-reasoner", temperature: 0.7, top_p: 0.9 }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.temperature, undefined);
  assert.equal(calls[0].body.top_p, undefined);
  assert.equal(calls[0].body.model, "deepseek-reasoner");
});

test("deepseek-v4-flash 不注入 temperature/top_p（官方按 thinking 处理）", async () => {
  const calls = [];
  const adapter = makeAdapter({
    baseUrl: "https://api.deepseek.com/v1",
    fetchImpl: async (url, init) => {
      calls.push({ body: JSON.parse(init.body) });
      return jsonResponse({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }
  });
  await adapter.complete({
    messages: [{ role: "user", content: "hi" }],
    modelConfig: { base_url: "https://api.deepseek.com/v1", model_name: "deepseek-v4-flash", temperature: 0.7, top_p: 0.9 }
  });
  assert.equal(calls[0].body.temperature, undefined);
  assert.equal(calls[0].body.top_p, undefined);
});

test("非 thinking 模型正常注入 temperature/top_p", async () => {
  const calls = [];
  const adapter = makeAdapter({
    baseUrl: "https://api.example.test/v1",
    fetchImpl: async (url, init) => {
      calls.push({ body: JSON.parse(init.body) });
      return jsonResponse({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }
  });
  await adapter.complete({
    messages: [{ role: "user", content: "hi" }],
    modelConfig: { model_name: "plain-model", temperature: 0.7, top_p: 0.9 }
  });
  assert.equal(calls[0].body.temperature, 0.7);
  assert.equal(calls[0].body.top_p, 0.9);
});

test("请求 json_object 输出时按 capability 注入 response_format", async () => {
  let captured = null;
  const adapter = makeAdapter({
    baseUrl: "https://api.deepseek.com/v1",
    fetchImpl: async (url, init) => {
      captured = JSON.parse(init.body);
      return jsonResponse({ choices: [{ message: { content: "{}" } }] });
    }
  });
  await adapter.complete({
    messages: [{ role: "user", content: "输出 json" }],
    modelConfig: { base_url: "https://api.deepseek.com/v1", model_name: "deepseek-v4-flash" },
    metadata: { responseFormat: "json_object" }
  });
  assert.deepEqual(captured.response_format, { type: "json_object" });
});

// ---------------------------------------------------------------------------
// 推理内容与公开正文分离（契约 §2.1：互不兜底）
// ---------------------------------------------------------------------------

test("非流式：content 为空时正文为空串，reasoning 独立返回（不兜底）", async () => {
  const adapter = makeAdapter({
    fetchImpl: async () =>
      jsonResponse({
        choices: [{ message: { content: "", reasoning_content: "reasoning output" } }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
      })
  });
  const result = await adapter.complete({ messages: [{ role: "user", content: "hi" }], modelConfig: { model_name: "deepseek-reasoner" } });
  assert.equal(result.text, "", "正文为空时不得回退 reasoning_content");
  assert.equal(result.reasoning, "reasoning output");
});

test("非流式：content 与 reasoning_content 各归各位，互不干扰", async () => {
  const adapter = makeAdapter({
    fetchImpl: async () =>
      jsonResponse({
        choices: [{ message: { content: "final", reasoning_content: "reasoning" } }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
      })
  });
  const result = await adapter.complete({ messages: [{ role: "user", content: "hi" }], modelConfig: { model_name: "deepseek-reasoner" } });
  assert.equal(result.text, "final");
  assert.equal(result.reasoning, "reasoning");
});

test("非流式：content 缺失时正文为空串，reasoning 独立返回（不兜底）", async () => {
  const adapter = makeAdapter({
    fetchImpl: async () =>
      jsonResponse({
        choices: [{ message: { reasoning_content: "only reasoning" } }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
      })
  });
  const result = await adapter.complete({ messages: [{ role: "user", content: "hi" }], modelConfig: { model_name: "deepseek-reasoner" } });
  assert.equal(result.text, "", "content 缺失时不得回退 reasoning_content");
  assert.equal(result.reasoning, "only reasoning");
});

test("非流式：output_text 仅在无 content/text 时兜底（部分兼容代理格式）", async () => {
  const adapter = makeAdapter({
    fetchImpl: async () =>
      jsonResponse({ output_text: "direct output" })
  });
  const result = await adapter.complete({ messages: [{ role: "user", content: "hi" }], modelConfig: { model_name: "m" } });
  assert.equal(result.text, "direct output");
  assert.equal(result.reasoning, "");
});

// ---------------------------------------------------------------------------
// 流式 SSE
// ---------------------------------------------------------------------------

function sseFrames(frames) {
  return frames.join("\n\n") + (frames.length > 0 ? "\n\n" : "");
}

test("流式：onToken 逐帧回调、usage 帧归一化、raw.stream 标记", async () => {
  const tokens = [];
  const adapter = makeAdapter({
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.stream, true);
      assert.deepEqual(body.stream_options, { include_usage: true });
      return streamResponse(
        sseFrames([
          'data: {"choices":[{"delta":{"content":"Hel"}}]}',
          'data: {"choices":[{"delta":{"content":"lo"}}]}',
          'data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10,"cache_read_input_tokens":3}}',
          "data: [DONE]"
        ])
      );
    }
  });
  const result = await adapter.complete({
    messages: [{ role: "user", content: "hello" }],
    modelConfig: { model_name: "writer-model", stream: true },
    metadata: {
      onToken(token) {
        tokens.push(token);
      }
    }
  });
  assert.equal(result.text, "Hello");
  assert.deepEqual(tokens, ["Hel", "lo"]);
  assert.equal(result.raw.stream, true);
  assert.equal(result.usage.cache_read_tokens, 3);
  assert.equal(result.toolCalls.length, 0);
});

test("流式：CRLF 分隔帧", async () => {
  const tokens = [];
  const adapter = makeAdapter({
    fetchImpl: async () =>
      streamResponse(
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\r\n\r\n' +
        'data: {"choices":[{"delta":{"content":" World"}}]}\r\n\r\n' +
        "data: [DONE]\r\n\r\n"
      )
  });
  const result = await adapter.complete({
    messages: [{ role: "user", content: "hello" }],
    modelConfig: { model_name: "writer-model", stream: true },
    metadata: {
      onToken(token) {
        tokens.push(token);
      }
    }
  });
  assert.deepEqual(tokens, ["Hello", " World"]);
  assert.equal(result.text, "Hello World");
});

test("流式：长响应只保留有界诊断信息，不缓存全部 SSE 事件", async () => {
  const frameCount = 1_000;
  const frames = Array.from(
    { length: frameCount },
    () => 'data: {"choices":[{"delta":{"content":"x"}}]}'
  );
  frames.push("data: [DONE]");

  const adapter = makeAdapter({
    fetchImpl: async () => streamResponse(sseFrames(frames))
  });
  const result = await adapter.complete({
    messages: [{ role: "user", content: "write a long answer" }],
    modelConfig: { model_name: "writer-model", stream: true }
  });

  assert.equal(result.text, "x".repeat(frameCount));
  assert.equal(result.raw.event_count, frameCount);
  assert.equal("events" in result.raw, false);
});

test("流式：帧跨 chunk 边界时正确拼接", async () => {
  const adapter = makeAdapter({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => {
        throw new Error("streaming path should not call response.text()");
      },
      body: {
        getReader() {
          // 把一帧拆成两半，验证 buffer 拼接
          const halves = [
            'data: {"choices":[{"delta":{"content":"He',
            'llo"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\ndata: [DONE]\n\n'
          ];
          let index = 0;
          return {
            read() {
              if (index >= halves.length) return Promise.resolve({ done: true, value: undefined });
              return Promise.resolve({ done: false, value: new TextEncoder().encode(halves[index++]) });
            }
          };
        }
      }
    })
  });
  const result = await adapter.complete({
    messages: [{ role: "user", content: "hello" }],
    modelConfig: { model_name: "writer-model", stream: true }
  });
  assert.equal(result.text, "Hello world");
});

test("流式：末帧 finish_reason=length 正常终止 → raw.finish_reason 透传", async () => {
  const tokens = [];
  const adapter = makeAdapter({
    fetchImpl: async () =>
      streamResponse(
        sseFrames([
          'data: {"choices":[{"delta":{"content":"半截"}}]}',
          'data: {"choices":[{"delta":{"content":"正文"}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
          "data: [DONE]"
        ])
      )
  });
  const result = await adapter.complete({
    messages: [{ role: "user", content: "hello" }],
    modelConfig: { model_name: "writer-model", stream: true },
    metadata: {
      onToken(token) {
        tokens.push(token);
      }
    }
  });
  assert.equal(result.text, "半截正文", "正文照常归一化");
  assert.deepEqual(tokens, ["半截", "正文"], "finish_reason 帧不产生增量 token");
  assert.equal(result.raw.finish_reason, "length", "截断原因透传到 raw.finish_reason");
});

test("流式：finish_reason=length 之后还有 usage 帧 → raw.finish_reason 仍为 length", async () => {
  // OpenAI 规范：include_usage 时 usage 帧（choices:[]）跟在 finish_reason 帧之后、
  // [DONE] 之前。若只取末帧 finish_reason 会被 usage 帧覆盖成 null（Task 4 Issue 1）。
  const adapter = makeAdapter({
    fetchImpl: async () =>
      streamResponse(
        sseFrames([
          'data: {"choices":[{"delta":{"content":"半截"}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
          'data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}',
          "data: [DONE]"
        ])
      )
  });
  const result = await adapter.complete({
    messages: [{ role: "user", content: "hello" }],
    modelConfig: { model_name: "writer-model", stream: true }
  });
  assert.equal(result.text, "半截", "正文照常归一化");
  assert.equal(result.raw.finish_reason, "length", "usage 帧不得覆盖 finish_reason");
  assert.equal(result.raw.event_count, 3, "usage 帧计入事件数");
});

test("流式：流结束没有 DONE 且没有 finish_reason → 截断错误", async () => {
  const adapter = makeAdapter({
    fetchImpl: async () =>
      streamResponse('data: {"choices":[{"delta":{"content":"partial"}}]}')
  });
  await assert.rejects(
    () => adapter.complete({ messages: [{ role: "user", content: "hello" }], modelConfig: { model_name: "m", stream: true } }),
    (error) => {
      assert.ok(error instanceof ProviderTransportError);
      assert.equal(error.reason, "network");
      assert.match(error.message, /DONE|finish_reason/u);
      const body = JSON.parse(error.body);
      assert.equal(body.truncatedContentLength, 7);
      return true;
    }
  );
});

test("流式：opencode 兼容端点干净 EOF → 正常完成并保留正文", async () => {
  const adapter = makeAdapter({
    fetchImpl: async () =>
      streamResponse('data: {"choices":[{"delta":{"content":"来自代理的完整回复"}}]}')
  });
  const result = await adapter.complete({
    messages: [{ role: "user", content: "hello" }],
    modelConfig: {
      base_url: "https://opencode.ai/zen/go/v1",
      model_name: "deepseek-v4-flash",
      stream: true
    }
  });
  assert.equal(result.text, "来自代理的完整回复");
  assert.equal(result.raw.stream_terminated_by_eof, true);
});

test("流式：显式 allow_stream_eof 允许自定义兼容端点干净 EOF", async () => {
  const adapter = makeAdapter({
    fetchImpl: async () =>
      streamResponse('data: {"choices":[{"delta":{"content":"完整"}}]}')
  });
  const result = await adapter.complete({
    messages: [{ role: "user", content: "hello" }],
    modelConfig: { model_name: "m", stream: true, allow_stream_eof: true }
  });
  assert.equal(result.text, "完整");
  assert.equal(result.raw.stream_terminated_by_eof, true);
});

test("流式：opencode 干净 EOF 下完整工具参数仍可执行，半截 JSON 仍拒绝", async () => {
  const completeAdapter = makeAdapter({
    fetchImpl: async () =>
      streamResponse(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_file","arguments":"{\\"path\\":\\"chapter.md\\"}"}}]}}]}'
      )
  });
  const complete = await completeAdapter.complete({
    messages: [{ role: "user", content: "read" }],
    modelConfig: { base_url: "https://opencode.ai/zen/go/v1", model_name: "m", stream: true }
  });
  assert.equal(complete.toolCalls[0].arguments_complete, true);
  assert.deepEqual(complete.toolCalls[0].input, { path: "chapter.md" });

  const truncatedAdapter = makeAdapter({
    fetchImpl: async () =>
      streamResponse(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-2","function":{"name":"read_file","arguments":"{\\"path\\":\\"chapter.md\\""}}]}}]}'
      )
  });
  const truncated = await truncatedAdapter.complete({
    messages: [{ role: "user", content: "read" }],
    modelConfig: { base_url: "https://opencode.ai/zen/go/v1", model_name: "m", stream: true }
  });
  assert.equal(truncated.toolCalls[0].arguments_complete, false);
  assert.equal(truncated.toolCalls[0].input, null);
});

test("流式：malformed 帧 + 无终止信号 → 截断错误", async () => {
  const adapter = makeAdapter({
    fetchImpl: async () => streamResponse("data: {bad}\n\ndata: {also bad}\n\n")
  });
  await assert.rejects(
    () => adapter.complete({ messages: [{ role: "user", content: "hello" }], modelConfig: { model_name: "m", stream: true } }),
    (error) => {
      assert.ok(error instanceof ProviderTransportError);
      assert.equal(error.reason, "network");
      const body = JSON.parse(error.body);
      assert.ok(body.malformedSseFrameCount >= 2);
      return true;
    }
  );
});

test("流式：malformed 帧但以 [DONE] 正常终止 → 容忍不抛错", async () => {
  const adapter = makeAdapter({
    fetchImpl: async () =>
      streamResponse(
        "data: {bad json}\n\n" +
          'data: {"choices":[{"delta":{"content":"ok"}}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n' +
          "data: [DONE]\n\n"
      )
  });
  const result = await adapter.complete({ messages: [{ role: "user", content: "hello" }], modelConfig: { model_name: "m", stream: true } });
  assert.equal(result.text, "ok");
  assert.ok(result.raw.malformed_sse_frame_count >= 1);
});

test("流式：malformed 帧触发 onMalformedSseFrame 回调（携带原文与解析错误）", async () => {
  const seen = [];
  const adapter = makeAdapter({
    fetchImpl: async () =>
      streamResponse(
        'data: {bad json}\n\n' +
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
          "data: [DONE]\n\n"
      )
  });
  const result = await adapter.complete({
    messages: [{ role: "user", content: "hello" }],
    modelConfig: { model_name: "m", stream: true },
    metadata: {
      onMalformedSseFrame(info) {
        seen.push(info);
      }
    }
  });
  assert.equal(result.text, "ok", "malformed 帧被容忍，正文不受影响");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].data, "{bad json}");
  assert.ok(seen[0].error instanceof SyntaxError, "回调携带 JSON.parse 的原错误");
});

test("流式：reasoning_content 只进 onReasoningToken 与 reply.reasoning，不兜底正文", async () => {
  const tokens = [];
  const reasoningTokens = [];
  const adapter = makeAdapter({
    fetchImpl: async () =>
      streamResponse(
        sseFrames([
          'data: {"choices":[{"delta":{"content":"","reasoning_content":"think"}}]}',
          'data: {"choices":[{"delta":{"content":"","reasoning_content":"ing"}}]}',
          "data: [DONE]"
        ])
      )
  });
  const result = await adapter.complete({
    messages: [{ role: "user", content: "hi" }],
    modelConfig: { model_name: "deepseek-reasoner", stream: true },
    metadata: {
      onToken(token) {
        tokens.push(token);
      },
      onReasoningToken(token) {
        reasoningTokens.push(token);
      }
    }
  });
  assert.deepEqual(tokens, [], "私有推理 token 不得进入对话增量流");
  assert.deepEqual(reasoningTokens, ["think", "ing"]);
  assert.equal(result.text, "", "无公开正文时 text 必须为空串，不兜底");
  assert.equal(result.reasoning, "thinking");
});

test("流式：同时包含 reasoning_content 与 content 时各走各的通道", async () => {
  const tokens = [];
  const reasoningTokens = [];
  const adapter = makeAdapter({
    fetchImpl: async () =>
      streamResponse(
        sseFrames([
          'data: {"choices":[{"delta":{"content":"","reasoning_content":"private-thought"}}]}',
          'data: {"choices":[{"delta":{"content":"visible-answer"}}]}',
          "data: [DONE]"
        ])
      )
  });

  const result = await adapter.complete({
    messages: [{ role: "user", content: "hi" }],
    modelConfig: { model_name: "deepseek-reasoner", stream: true },
    metadata: {
      onToken: (token) => tokens.push(token),
      onReasoningToken: (token) => reasoningTokens.push(token)
    }
  });

  assert.deepEqual(tokens, ["visible-answer"], "onToken 只接收公开正文");
  assert.deepEqual(reasoningTokens, ["private-thought"]);
  assert.equal(result.text, "visible-answer");
  assert.equal(result.reasoning, "private-thought");
});

test("流式：tool_calls delta 增量累积并解析 arguments", async () => {
  const adapter = makeAdapter({
    fetchImpl: async () =>
      streamResponse(
        sseFrames([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"list_files","arguments":""}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"chapters\\"}"}}]}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
          "data: [DONE]"
        ])
      )
  });
  const result = await adapter.complete({ messages: [{ role: "user", content: "hi" }], modelConfig: { model_name: "m", stream: true } });
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].id, "call_1");
  assert.equal(result.toolCalls[0].tool, "list_files");
  assert.deepEqual(result.toolCalls[0].input, { path: "chapters" });
});

test("流式：每个成功解析的 data: 帧都回调 onActivity（tool-call-only/空 delta/usage-only 均计数，不以 token 非空为条件）", async () => {
  const activity = [];
  const adapter = makeAdapter({
    fetchImpl: async () =>
      streamResponse(
        sseFrames([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"list_files","arguments":"{}"}}]}}]}',
          'data: {"choices":[{"delta":{}}]}',
          'data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
          "data: [DONE]"
        ])
      )
  });
  const result = await adapter.complete({
    messages: [{ role: "user", content: "hi" }],
    modelConfig: { model_name: "m", stream: true },
    metadata: {
      onActivity(token) {
        activity.push(token);
      }
    }
  });
  assert.equal(activity.length, 4, "[DONE] 不计入，其余每个成功解析的帧都回调一次");
  assert.deepEqual(activity, ["", "", "", ""], "无正文 token 的帧（tool-call-only/空 delta/usage-only/finish_reason）也照常回调");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.usage.completion_tokens, 2);
});

test("流式：多次 tool_call delta 按 index 分别累积", async () => {
  const adapter = makeAdapter({
    fetchImpl: async () =>
      streamResponse(
        sseFrames([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c0","function":{"name":"read_file","arguments":"{\\"path\\":\\"a\\"}"}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c1","function":{"name":"read_file","arguments":"{\\"path\\":\\"b\\"}"}}]}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
          "data: [DONE]"
        ])
      )
  });
  const result = await adapter.complete({ messages: [{ role: "user", content: "hi" }], modelConfig: { model_name: "m", stream: true } });
  assert.equal(result.toolCalls.length, 2);
  assert.deepEqual(result.toolCalls.map((tc) => tc.input), [{ path: "a" }, { path: "b" }]);
});

// ---------------------------------------------------------------------------
// R5-3 TextDecoder flush 与 R5-5 截断工具参数完整性标记
// ---------------------------------------------------------------------------

test("R5-3：末 chunk 以不完整 UTF-8 序列结尾 → 流结束冲刷后 U+FFFD 出现在 malformed 帧（不静默丢字节）", async () => {
  // "你" = E4 BD A0：流的最后一个 chunk 只携带前两个字节（E4 BD），随后流被截断。
  // TextDecoder 的 stream 模式会把不完整序列挂在内部；若不冲刷，这些字节被静默
  // 丢弃（malformed 帧只有截断前的文本）；无参 decode() 冲刷后按 UTF-8 规范以
  // U+FFFD 呈现（SPEC R5-3 接受行为）。
  const prefix = 'data: {"choices":[{"delta":{"content":"';
  const seen = [];
  const prefixBytes = new TextEncoder().encode(prefix);
  const partial = Uint8Array.from([0xE4, 0xBD]);
  const chunk = new Uint8Array(prefixBytes.length + partial.length);
  chunk.set(prefixBytes, 0);
  chunk.set(partial, prefixBytes.length);
  const adapter = makeAdapter({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => {
        throw new Error("streaming path should not call response.text()");
      },
      body: {
        getReader() {
          let delivered = false;
          return {
            read() {
              if (delivered) return Promise.resolve({ done: true, value: undefined });
              delivered = true;
              return Promise.resolve({ done: false, value: chunk });
            }
          };
        }
      }
    })
  });
  await assert.rejects(
    () =>
      adapter.complete({
        messages: [{ role: "user", content: "hi" }],
        modelConfig: { model_name: "m", stream: true },
        metadata: {
          onMalformedSseFrame(info) {
            seen.push(info);
          }
        }
      }),
    (error) => {
      assert.ok(error instanceof ProviderTransportError, "无终止信号的截断流应抛 transport 错误");
      assert.equal(seen.length, 1, "尾部不完整帧应触发 onMalformedSseFrame");
      assert.ok(seen[0].data.endsWith("\uFFFD"), "不完整尾字节冲刷后以 U+FFFD 呈现，不得静默丢弃");
      return true;
    }
  );
});

test("R5-5：finish_reason=length + 半截 JSON 工具参数 → arguments_complete=false", async () => {
  const adapter = makeAdapter({
    fetchImpl: async () =>
      streamResponse(
        sseFrames([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"list_files","arguments":"{\\"path\\":"}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"chap"}}]}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
          "data: [DONE]"
        ])
      )
  });
  const result = await adapter.complete({ messages: [{ role: "user", content: "hi" }], modelConfig: { model_name: "m", stream: true } });
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.raw.finish_reason, "length");
  assert.equal(result.toolCalls[0].arguments_complete, false, "max_tokens 截断 + 不可解析参数应标记不完整");
  assert.equal(result.toolCalls[0].input, null, "半截 JSON 解析失败，input 为 null");
});

test("R5-5：完整 JSON 工具参数 + finish_reason=tool_calls + [DONE] → arguments_complete=true", async () => {
  const adapter = makeAdapter({
    fetchImpl: async () =>
      streamResponse(
        sseFrames([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"list_files","arguments":"{\\"path\\":"}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"chapters\\"}"}}]}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
          "data: [DONE]"
        ])
      )
  });
  const result = await adapter.complete({ messages: [{ role: "user", content: "hi" }], modelConfig: { model_name: "m", stream: true } });
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].arguments_complete, true, "完整参数 + 正常终止应标记完整");
  assert.deepEqual(result.toolCalls[0].input, { path: "chapters" });
});

test("R5-5：参数可解析但 finish_reason=length → 仍视为不完整（length 表示可能截断，保守拒绝）", async () => {
  // 与上一条的唯一差别是 finish_reason=length：即使累积 arguments 恰好可解析，
  // 模型输出已被 max_tokens 截断，调用完整性不可信，保守标记不完整。
  const adapter = makeAdapter({
    fetchImpl: async () =>
      streamResponse(
        sseFrames([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"list_files","arguments":"{\\"path\\":"}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"chapters\\"}"}}]}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
          "data: [DONE]"
        ])
      )
  });
  const result = await adapter.complete({ messages: [{ role: "user", content: "hi" }], modelConfig: { model_name: "m", stream: true } });
  assert.equal(result.toolCalls[0].arguments_complete, false);
  assert.deepEqual(result.toolCalls[0].input, { path: "chapters" }, "参数本身解析成功，但截断仍标记不完整");
});

// ---------------------------------------------------------------------------
// 额外契约
// ---------------------------------------------------------------------------

test("extra_body 与 headers 透传", async () => {
  let captured = null;
  const adapter = makeAdapter({
    fetchImpl: async (url, init) => {
      captured = { init, body: JSON.parse(init.body) };
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    }
  });
  await adapter.complete({
    messages: [{ role: "user", content: "hi" }],
    modelConfig: {
      model_name: "m",
      extra_body: { temperature_override: 1 },
      headers: { "x-custom": "yes" }
    }
  });
  assert.equal(captured.body.temperature_override, 1);
  assert.equal(captured.init.headers["x-custom"], "yes");
});

test("apiKey 显式传入时不做 env 解析", async () => {
  let captured = null;
  const adapter = makeAdapter({
    apiKey: null,
    apiKeyEnv: "MISSING_ENV_TEST_KEY",
    fetchImpl: async (url, init) => {
      captured = { init };
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    }
  });
  await adapter.complete({
    messages: [{ role: "user", content: "hi" }],
    modelConfig: { model_name: "m", api_key: "explicit-key" }
  });
  assert.equal(captured.init.headers.authorization, "Bearer explicit-key");
});

test("OpenAICompatibleAdapter 构造与工厂等价", () => {
  const viaClass = new OpenAICompatibleAdapter({ baseUrl: "https://api.example.test/v1" });
  const viaFactory = createOpenAICompatibleAdapter({ baseUrl: "https://api.example.test/v1" });
  assert.ok(viaClass instanceof OpenAICompatibleAdapter);
  assert.ok(viaFactory instanceof OpenAICompatibleAdapter);
  assert.equal(viaFactory.baseUrl, "https://api.example.test/v1");
});

// ---------------------------------------------------------------------------
// 思考强度（reasoning_effort）真实映射
// ---------------------------------------------------------------------------

test("DeepSeek thinking 模型配置 low 档位时请求体携带 reasoning_effort", async () => {
  let captured = null;
  const adapter = makeAdapter({
    fetchImpl: async (url, init) => {
      captured = { body: JSON.parse(init.body) };
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    }
  });
  await adapter.complete({
    messages: [{ role: "user", content: "hi" }],
    modelConfig: {
      base_url: "https://api.deepseek.com/v1",
      model_name: "deepseek-v4-pro",
      reasoning_effort: "low"
    }
  });
  assert.equal(captured.body.reasoning_effort, "low");
});

test("auto 档位不发送 reasoning_effort", async () => {
  let captured = null;
  const adapter = makeAdapter({
    fetchImpl: async (url, init) => {
      captured = { body: JSON.parse(init.body) };
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    }
  });
  await adapter.complete({
    messages: [{ role: "user", content: "hi" }],
    modelConfig: {
      base_url: "https://api.deepseek.com/v1",
      model_name: "deepseek-v4-pro",
      reasoning_effort: "auto"
    }
  });
  assert.equal("reasoning_effort" in captured.body, false);
});

test("未验证模型（MiMo/未知）即使配置档位也绝不发送 reasoning_effort", async () => {
  let captured = null;
  const adapter = makeAdapter({
    fetchImpl: async (url, init) => {
      captured = { body: JSON.parse(init.body) };
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    }
  });
  await adapter.complete({
    messages: [{ role: "user", content: "hi" }],
    modelConfig: {
      base_url: "https://api.mimo.example.test/v1",
      model_name: "mimo-v2.5",
      reasoning_effort: "high"
    }
  });
  assert.equal("reasoning_effort" in captured.body, false);
});

// ---------------------------------------------------------------------------
// 契约：reasoning 与公开正文分离（Task 1 冻结 §2.1）
// ---------------------------------------------------------------------------

test("契约：非流式返回独立的 reply.reasoning，正文与 reasoning 互不兜底", async () => {
  const adapter = makeAdapter({
    fetchImpl: async () =>
      jsonResponse({
        choices: [{ message: { content: "最终回答", reasoning_content: "先检查事实，再回答。" } }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
      })
  });
  const reply = await adapter.complete({
    messages: [{ role: "user", content: "hi" }],
    modelConfig: { model_name: "deepseek-reasoner" }
  });
  assert.equal(reply.text, "最终回答");
  assert.equal(reply.reasoning, "先检查事实，再回答。");
});

test("契约：流式 reasoning 只进 onReasoningToken，onToken 只收公开正文", async () => {
  const tokens = [];
  const reasoningTokens = [];
  const adapter = makeAdapter({
    fetchImpl: async () =>
      streamResponse(
        sseFrames([
          'data: {"choices":[{"delta":{"content":"","reasoning_content":"先检查事实，"}}]}',
          'data: {"choices":[{"delta":{"content":"","reasoning_content":"再回答。"}}]}',
          'data: {"choices":[{"delta":{"content":"最终回答"}}]}',
          "data: [DONE]"
        ])
      )
  });
  const reply = await adapter.complete({
    messages: [{ role: "user", content: "hi" }],
    modelConfig: { model_name: "deepseek-reasoner", stream: true },
    metadata: {
      onToken(token) {
        tokens.push(token);
      },
      onReasoningToken(token) {
        reasoningTokens.push(token);
      }
    }
  });
  assert.deepEqual(tokens, ["最终回答"], "onToken 只接收公开正文，reasoning 不得混入");
  assert.deepEqual(reasoningTokens, ["先检查事实，", "再回答。"]);
  assert.equal(reply.text, "最终回答");
  assert.equal(reply.reasoning, "先检查事实，再回答。");
});
