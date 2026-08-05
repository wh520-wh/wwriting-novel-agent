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
// 推理内容兜底
// ---------------------------------------------------------------------------

test("content 为空时回退 reasoning_content（非流式）", async () => {
  const adapter = makeAdapter({
    fetchImpl: async () =>
      jsonResponse({
        choices: [{ message: { content: "", reasoning_content: "reasoning output" } }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
      })
  });
  const result = await adapter.complete({ messages: [{ role: "user", content: "hi" }], modelConfig: { model_name: "deepseek-reasoner" } });
  assert.equal(result.text, "reasoning output");
});

test("content 优先于 reasoning_content", async () => {
  const adapter = makeAdapter({
    fetchImpl: async () =>
      jsonResponse({
        choices: [{ message: { content: "final", reasoning_content: "reasoning" } }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
      })
  });
  const result = await adapter.complete({ messages: [{ role: "user", content: "hi" }], modelConfig: { model_name: "deepseek-reasoner" } });
  assert.equal(result.text, "final");
});

test("content 缺失时回退 reasoning_content", async () => {
  const adapter = makeAdapter({
    fetchImpl: async () =>
      jsonResponse({
        choices: [{ message: { reasoning_content: "only reasoning" } }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
      })
  });
  const result = await adapter.complete({ messages: [{ role: "user", content: "hi" }], modelConfig: { model_name: "deepseek-reasoner" } });
  assert.equal(result.text, "only reasoning");
});

test("output_text 字段优先（部分兼容代理格式）", async () => {
  const adapter = makeAdapter({
    fetchImpl: async () =>
      jsonResponse({ output_text: "direct output", choices: [{ message: { content: "other" } }] })
  });
  const result = await adapter.complete({ messages: [{ role: "user", content: "hi" }], modelConfig: { model_name: "m" } });
  assert.equal(result.text, "direct output");
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

test("流式：content 为空时回退 reasoning_content", async () => {
  const tokens = [];
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
      }
    }
  });
  assert.deepEqual(tokens, ["think", "ing"]);
  assert.equal(result.text, "thinking");
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
