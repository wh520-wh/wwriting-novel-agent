// 三协议适配器行为用例（round22 Task 6，D5/D6 最小契约）。
//
// 用现有 fetch 注入模式覆盖每协议：请求 URL/鉴权/工具映射、非流式归一、流式
// token+工具结束、取消与 401。toolCalls 统一产出 gateway 形状 { id, tool, input }。
import assert from "node:assert/strict";
import test from "node:test";
import { createAnthropicMessagesAdapter, anthropicMessagesUrl } from "../../src/core/model/anthropic-messages.mjs";
import { createOpenAIResponsesAdapter } from "../../src/core/model/openai-responses.mjs";
import { createProtocolAdapter } from "../../src/core/model/gateway.mjs";
import { ProviderTransportError } from "../../src/core/model/openai-compatible.mjs";
import { loadProviderStore, saveProviderStore } from "../../src/core/model-provider-store.mjs";
import { ALLOWED_API_FORMATS } from "../../src/core/model-provider-store.mjs";

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(payload);
    }
  };
}

function sseResponse(chunks) {
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

const TOOL_DEFS = [
  { type: "function", function: { name: "read_file", description: "读文件", parameters: { type: "object", properties: { path: { type: "string" } } } } }
];

// ---------------------------------------------------------------------------
// Anthropic Messages
// ---------------------------------------------------------------------------

test("anthropic：URL 拼接保留前缀且不重复追加 /v1", () => {
  assert.equal(anthropicMessagesUrl("https://api.anthropic.com"), "https://api.anthropic.com/v1/messages");
  assert.equal(anthropicMessagesUrl("https://api.anthropic.com/"), "https://api.anthropic.com/v1/messages");
  assert.equal(anthropicMessagesUrl("https://relay.example.com/api/anthropic"), "https://relay.example.com/api/anthropic/v1/messages");
  assert.equal(anthropicMessagesUrl("https://relay.example.com/v1"), "https://relay.example.com/v1/messages");
});

test("anthropic 非流式：x-api-key/anthropic-version 鉴权、system 顶层映射、tools→input_schema、响应归一", async () => {
  let captured = null;
  const adapter = createAnthropicMessagesAdapter({
    baseUrl: "https://api.anthropic.com",
    apiKey: "sk-ant-test",
    fetchImpl: async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return jsonResponse({
        content: [
          { type: "text", text: "正文" },
          { type: "thinking", thinking: "思考" },
          { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "x" } }
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: "tool_use"
      });
    }
  });

  const result = await adapter.complete({
    messages: [
      { role: "system", content: "系统提示" },
      { role: "user", content: "读一下" },
      { role: "assistant", content: "", tool_calls: [{ id: "toolu_1", tool: "read_file", input: { path: "x" } }] },
      { role: "tool", tool_call_id: "toolu_1", content: "文件内容" }
    ],
    tools: TOOL_DEFS,
    modelConfig: { model_name: "claude-sonnet", max_output_tokens: 512 }
  });

  assert.equal(captured.url, "https://api.anthropic.com/v1/messages");
  assert.equal(captured.init.headers["x-api-key"], "sk-ant-test");
  assert.equal(captured.init.headers["anthropic-version"], "2023-06-01");
  assert.ok(!("authorization" in captured.init.headers), "不使用 Bearer 鉴权");
  assert.equal(captured.body.system, "系统提示");
  assert.equal(captured.body.max_tokens, 512);
  assert.equal(captured.body.model, "claude-sonnet");
  assert.deepEqual(captured.body.tools, [{ name: "read_file", description: "读文件", input_schema: { type: "object", properties: { path: { type: "string" } } } }]);
  // 工具结果合并进单个 user 轮的 tool_result block
  const toolTurn = captured.body.messages.find((m) => Array.isArray(m.content) && m.content[0]?.type === "tool_result");
  assert.ok(toolTurn, "工具结果应映射为 user 轮 tool_result");
  assert.equal(toolTurn.content[0].tool_use_id, "toolu_1");

  assert.equal(result.text, "正文");
  assert.equal(result.reasoning, "思考");
  assert.deepEqual(result.toolCalls, [{ type: "tool_call", id: "toolu_1", tool: "read_file", input: { path: "x" }, arguments_complete: true }]);
  assert.equal(result.usage.input_tokens, 10);
  assert.equal(result.usage.output_tokens, 5);
  assert.equal(result.cost, null);
});

test("anthropic 流式：text/thinking 增量回调、message_stop 才算工具参数完整、usage 汇总", async () => {
  const chunks = [[
    'event: message_start\r\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\r\n\r\n',
    'event: content_block_start\r\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\r\n\r\n',
    'event: content_block_delta\r\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\r\n\r\n',
    'event: content_block_stop\r\ndata: {"type":"content_block_stop","index":0}\r\n\r\n'
  ].join(""), [
    'event: content_block_start\r\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_9","name":"read_file"}}\r\n\r\n',
    'event: content_block_delta\r\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}\r\n\r\n',
    'event: content_block_delta\r\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"a\\"}"}}\r\n\r\n',
    'event: content_block_stop\r\ndata: {"type":"content_block_stop","index":1}\r\n\r\n',
    'event: message_delta\r\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}\r\n\r\n',
    'event: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n'
  ].join("")];
  const tokens = [];
  const adapter = createAnthropicMessagesAdapter({
    baseUrl: "https://api.anthropic.com",
    apiKey: "sk-ant-test",
    fetchImpl: async () => sseResponse(chunks)
  });

  const result = await adapter.complete({
    messages: [{ role: "user", content: "读一下" }],
    tools: TOOL_DEFS,
    stream: true,
    modelConfig: { model_name: "claude-sonnet" },
    metadata: { onToken: (t) => tokens.push(t) }
  });

  assert.deepEqual(tokens, ["你好"]);
  assert.equal(result.text, "你好");
  assert.deepEqual(result.toolCalls, [{ type: "tool_call", id: "toolu_9", tool: "read_file", input: { path: "a" }, arguments_complete: true }]);
  assert.equal(result.usage.input_tokens, 10);
  assert.equal(result.usage.output_tokens, 7);
});

test("anthropic 流式缺 message_stop → 报传输截断", async () => {
  const adapter = createAnthropicMessagesAdapter({
    baseUrl: "https://api.anthropic.com",
    apiKey: "sk-ant-test",
    fetchImpl: async () => sseResponse([
      'event: message_start\r\ndata: {"type":"message_start","message":{}}\r\n\r\n',
      'event: content_block_delta\r\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"半截"}}\r\n\r\n'
    ])
  });
  await assert.rejects(
    adapter.complete({ messages: [{ role: "user", content: "hi" }], stream: true, modelConfig: { model_name: "claude-sonnet" } }),
    (error) => error instanceof ProviderTransportError && /message_stop/u.test(error.message)
  );
});

test("anthropic：401 分类为 client-fatal；取消透传 AbortError", async () => {
  const adapter = createAnthropicMessagesAdapter({
    baseUrl: "https://api.anthropic.com",
    apiKey: "sk-ant-test",
    fetchImpl: async () => ({ ok: false, status: 401, headers: new Headers(), text: async () => '{"error":"bad key"}' })
  });
  await assert.rejects(
    adapter.complete({ messages: [{ role: "user", content: "hi" }], modelConfig: { model_name: "claude-sonnet" } }),
    (error) => error instanceof ProviderTransportError && error.status === 401 && error.reason === "client-fatal"
  );

  const abortController = new AbortController();
  abortController.abort();
  const aborting = createAnthropicMessagesAdapter({
    baseUrl: "https://api.anthropic.com",
    apiKey: "sk-ant-test",
    fetchImpl: async (url, init) => {
      // 信号已中止：模拟真实 fetch 的立即拒绝（有界等待，不悬挂）
      if (init.signal?.aborted) {
        throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
      }
      return jsonResponse({ content: [{ type: "text", text: "ok" }] });
    }
  });
  await assert.rejects(
    aborting.complete({ messages: [{ role: "user", content: "hi" }], modelConfig: { model_name: "claude" } }, { signal: abortController.signal }),
    (error) => error?.name === "AbortError"
  );
});

// ---------------------------------------------------------------------------
// OpenAI Responses
// ---------------------------------------------------------------------------

test("responses 非流式：Bearer 鉴权、input/工具扁平映射、function_call 归一", async () => {
  let captured = null;
  const adapter = createOpenAIResponsesAdapter({
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-resp",
    fetchImpl: async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return jsonResponse({
        output: [
          { type: "reasoning", summary: [{ type: "summary_text", text: "推理" }] },
          { type: "message", content: [{ type: "output_text", text: "正文" }] },
          { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: '{"path":"x"}' }
        ],
        usage: { input_tokens: 12, output_tokens: 6 }
      });
    }
  });

  const result = await adapter.complete({
    messages: [
      { role: "system", content: "系统提示" },
      { role: "user", content: "读一下" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", tool: "read_file", input: { path: "x" } }] },
      { role: "tool", tool_call_id: "call_1", content: "文件内容" }
    ],
    tools: TOOL_DEFS,
    modelConfig: { model_name: "gpt-5.2", max_output_tokens: 256 }
  });

  assert.equal(captured.url, "https://api.openai.com/v1/responses");
  assert.equal(captured.init.headers.authorization, "Bearer sk-resp");
  assert.equal(captured.body.max_output_tokens, 256);
  assert.deepEqual(captured.body.tools, [{ type: "function", name: "read_file", description: "读文件", parameters: { type: "object", properties: { path: { type: "string" } } } }]);
  // assistant tool_calls → function_call 项；工具结果 → function_call_output 项
  assert.ok(captured.body.input.some((item) => item.type === "function_call" && item.call_id === "call_1"));
  assert.ok(captured.body.input.some((item) => item.type === "function_call_output" && item.call_id === "call_1" && item.output === "文件内容"));
  assert.ok(captured.body.input.some((item) => item.role === "system" && item.content === "系统提示"));

  assert.equal(result.text, "正文");
  assert.equal(result.reasoning, "推理");
  assert.deepEqual(result.toolCalls, [{ type: "tool_call", id: "fc_1", tool: "read_file", input: { path: "x" }, arguments_complete: true }]);
  assert.equal(result.usage.input_tokens, 12);
  assert.equal(result.usage.output_tokens, 6);
});

test("responses 流式：output_text.delta 回调、参数累积、completed 前工具参数不完整", async () => {
  const chunks = [[
    'data: {"type":"response.output_text.delta","delta":"你好"}\r\n\r\n',
    'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"read_file","arguments":"{\\"path\\":"}}\r\n\r\n'
  ].join(""), [
    'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"\\"a\\"}"}\r\n\r\n',
    'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"read_file","arguments":"{\\"path\\":\\"a\\"}"}}\r\n\r\n',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":6}}}\r\n\r\n'
  ].join("")];
  const tokens = [];
  const adapter = createOpenAIResponsesAdapter({
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-resp",
    fetchImpl: async () => sseResponse(chunks)
  });

  const result = await adapter.complete({
    messages: [{ role: "user", content: "读一下" }],
    tools: TOOL_DEFS,
    stream: true,
    modelConfig: { model_name: "gpt-5.2" },
    metadata: { onToken: (t) => tokens.push(t) }
  });

  assert.deepEqual(tokens, ["你好"]);
  assert.equal(result.text, "你好");
  assert.deepEqual(result.toolCalls, [{ type: "tool_call", id: "fc_1", tool: "read_file", input: { path: "a" }, arguments_complete: true }]);
  assert.equal(result.usage.input_tokens, 12);
  assert.equal(result.usage.output_tokens, 6);
});

test("responses 流式缺 response.completed → 报传输截断；401 分类为 client-fatal", async () => {
  const adapter = createOpenAIResponsesAdapter({
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-resp",
    fetchImpl: async () => sseResponse(['data: {"type":"response.output_text.delta","delta":"半截"}\r\n\r\n'])
  });
  await assert.rejects(
    adapter.complete({ messages: [{ role: "user", content: "hi" }], stream: true, modelConfig: { model_name: "gpt-5.2" } }),
    (error) => error instanceof ProviderTransportError && /response\.completed/u.test(error.message)
  );

  const unauthorized = createOpenAIResponsesAdapter({
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-resp",
    fetchImpl: async () => ({ ok: false, status: 401, headers: new Headers(), text: async () => "nope" })
  });
  await assert.rejects(
    unauthorized.complete({ messages: [{ role: "user", content: "hi" }], modelConfig: { model_name: "gpt-5.2" } }),
    (error) => error instanceof ProviderTransportError && error.status === 401 && error.reason === "client-fatal"
  );
});

// ---------------------------------------------------------------------------
// 分发工厂与 store 持久化
// ---------------------------------------------------------------------------

test("createProtocolAdapter 按 api_format 分发三协议，未知格式抛配置错误", () => {
  const base = { baseUrl: "https://x.test", apiKey: "k" };
  assert.equal(createProtocolAdapter({ api_format: "openai-chat-completions", ...base }).constructor.name, "OpenAICompatibleAdapter");
  assert.equal(createProtocolAdapter({ api_format: "anthropic-messages", ...base }).constructor.name, "AnthropicMessagesAdapter");
  assert.equal(createProtocolAdapter({ api_format: "openai-responses", ...base }).constructor.name, "OpenAIResponsesAdapter");
  assert.throws(() => createProtocolAdapter({ api_format: "gemini-generate-content", ...base }), /不支持的模型接口协议/u);
});

test("D6：能力判定带协议维度——DeepSeek thinking 不泄到非 OpenAI 端点", async () => {
  const { resolveModelCapabilities } = await import("../../src/core/model/capabilities.mjs");
  // 同名模型走 Anthropic 端点：不得注入 DeepSeek thinking 档位
  const caps = resolveModelCapabilities({
    api_format: "anthropic-messages",
    base_url: "https://api.deepseek.com",
    model_name: "deepseek-v4-pro"
  });
  assert.equal(caps.supportsThinking, false);
  assert.equal(caps.reasoningEffortLevels, undefined);
  assert.equal(caps.supportsTools, true);
  // 同名模型走 chat-completions：DeepSeek resolver 仍生效
  const openAiCaps = resolveModelCapabilities({
    api_format: "openai-chat-completions",
    base_url: "https://api.deepseek.com",
    model_name: "deepseek-v4-pro"
  });
  assert.equal(openAiCaps.supportsThinking, true);
  assert.deepEqual(openAiCaps.reasoningEffortLevels, ["low", "high", "max"]);
});

test("store：非 OpenAI 协议条目持久化后重读不消失", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(tmpdir(), "proto-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.ok(ALLOWED_API_FORMATS.has("anthropic-messages"));
  await saveProviderStore(root, {
    schema_version: 2, default_model: null,
    providers: [
      { id: "pv_a", name: "Anthropic 直连", type: "custom", status: "enabled", base_url: "https://api.anthropic.com", api_format: "anthropic-messages", api_key_env: "A", models: [] },
      { id: "pv_b", name: "Responses 中转", type: "custom", status: "enabled", base_url: "https://relay.test/v1", api_format: "openai-responses", api_key_env: "B", models: [] }
    ]
  });
  const reloaded = await loadProviderStore(root);
  const formats = reloaded.providers.map((p) => p.api_format);
  assert.ok(formats.includes("anthropic-messages"), "anthropic-messages 条目重读后保留");
  assert.ok(formats.includes("openai-responses"), "openai-responses 条目重读后保留");
});
