import assert from "node:assert/strict";
import test from "node:test";
import { ModelClient } from "../src/core/model-client.mjs";
import {
  OpenAICompatibleAdapter,
  ProviderConfigurationError,
  ProviderTransportError
} from "../src/core/provider-adapters.mjs";

test("OpenAICompatibleAdapter sends chat completion requests and extracts usage", async () => {
  let captured = null;
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://api.example.test/v1",
    apiKey: "test-key",
    fetchImpl: async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            choices: [{ message: { content: "adapter response" } }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
              prompt_tokens_details: {
                cached_tokens: 4
              }
            }
          });
        }
      };
    }
  });

  const result = await adapter.generate({
    model: "writer-model",
    prompt: "Write through tools.",
    modelConfig: {
      max_output_tokens: 42,
      temperature: 0.2
    }
  });

  assert.equal(captured.url, "https://api.example.test/v1/chat/completions");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers.authorization, "Bearer test-key");
  assert.equal(captured.body.model, "writer-model");
  assert.equal(captured.body.max_tokens, 42);
  assert.equal(captured.body.messages[0].content, "Write through tools.");
  assert.equal(result.text, "adapter response");
  assert.equal(result.usage.cached_tokens, 4);
});

test("OpenAICompatibleAdapter forwards AbortSignal to fetch", async () => {
  const controller = new AbortController();
  let captured = null;
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://api.example.test/v1",
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ choices: [{ message: { content: "ok" } }] });
        }
      };
    }
  });

  await adapter.generate({
    model: "writer-model",
    prompt: "hello",
    signal: controller.signal
  });

  assert.equal(captured.init.signal, controller.signal);
});

test("OpenAICompatibleAdapter requests native tool calls for chapter writing", async () => {
  let captured = null;
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://api.example.test/v1",
    apiKey: "test-key",
    fetchImpl: async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "append_chapter_segment",
                        arguments: JSON.stringify({
                          project_id: "project-1",
                          chapter_no: 1,
                          segment_no: 1,
                          content: "chapter text"
                        })
                      }
                    }
                  ]
                }
              }
            ],
            usage: {
              prompt_tokens: 12,
              completion_tokens: 4,
              total_tokens: 16
            }
          });
        }
      };
    }
  });

  const result = await adapter.generate({
    model: "writer-model",
    prompt: "Write through tools.",
    modelConfig: {
      stream: true
    },
    metadata: {
      toolRequest: {
        project_id: "project-1",
        chapter_no: 1,
        segment_no: 1
      }
    }
  });

  assert.equal(captured.body.messages[0].role, "system");
  assert.match(captured.body.messages[0].content, /append_chapter_segment/u);
  assert.equal(captured.body.messages[1].content, "Write through tools.");
  assert.equal(captured.body.tools[0].function.name, "append_chapter_segment");
  assert.deepEqual(captured.body.tool_choice, {
    type: "function",
    function: { name: "append_chapter_segment" }
  });
  assert.equal(captured.body.stream, undefined);
  assert.equal(result.raw.choices[0].message.tool_calls[0].function.name, "append_chapter_segment");
});

test("OpenAICompatibleAdapter uses auto tool choice for DeepSeek thinking models", async () => {
  let captured = null;
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://api.deepseek.com",
    apiKey: "test-key",
    fetchImpl: async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "append_chapter_segment",
                        arguments: JSON.stringify({
                          project_id: "project-1",
                          chapter_no: 1,
                          segment_no: 1,
                          content: "chapter text"
                        })
                      }
                    }
                  ]
                }
              }
            ],
            usage: {
              prompt_tokens: 12,
              completion_tokens: 4,
              total_tokens: 16
            }
          });
        }
      };
    }
  });

  await adapter.generate({
    model: "deepseek-v4-pro",
    prompt: "Write through tools.",
    modelConfig: {
      stream: true
    },
    metadata: {
      toolRequest: {
        project_id: "project-1",
        chapter_no: 1,
        segment_no: 1
      }
    }
  });

  assert.equal(captured.body.tools[0].function.name, "append_chapter_segment");
  assert.equal(captured.body.tool_choice, "auto");
  assert.equal(captured.body.stream, undefined);
});

test("ModelClient records OpenAI-compatible cache metrics when provider returns them", async () => {
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://api.example.test/v1",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 10,
            total_tokens: 30,
            prompt_tokens_details: {
              cached_tokens: 5
            }
          }
        });
      }
    })
  });
  const client = new ModelClient({
    adapters: {
      openai: adapter
    }
  });
  const result = await client.generate({
    project: {
      active_model: {
        provider: "openai",
        model_name: "writer-model",
        base_url: "https://api.example.test/v1"
      }
    },
    prompt: "hello"
  });
  assert.equal(result.text, "ok");
  assert.equal(result.usageReport.cacheMetricsAvailable, true);
  assert.equal(result.usageReport.cacheHitRate, 0.25);
});

test("OpenAICompatibleAdapter reports missing configured API key env", async () => {
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://api.example.test/v1",
    fetchImpl: async () => {
      throw new Error("fetch should not be called");
    }
  });
  await assert.rejects(
    () =>
      adapter.generate({
        model: "writer-model",
        prompt: "hello",
        modelConfig: {
          api_key_env: "WWRITING_TEST_MISSING_KEY"
        }
      }),
    (error) => error instanceof ProviderConfigurationError && /WWRITING_TEST_MISSING_KEY/u.test(error.message)
  );
});

test("OpenAICompatibleAdapter wraps non-2xx provider responses", async () => {
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://api.example.test/v1",
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      async text() {
        return "rate limited";
      }
    })
  });
  await assert.rejects(
    () => adapter.generate({ model: "writer-model", prompt: "hello" }),
    (error) => error instanceof ProviderTransportError && error.status === 429 && error.body === "rate limited"
  );
});

test("OpenAICompatibleAdapter wraps invalid JSON success responses with provider context", async () => {
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://api.example.test/v1",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() {
        return "<html>login expired</html>";
      }
    })
  });
  await assert.rejects(
    () => adapter.generate({ model: "writer-model", prompt: "hello" }),
    (error) => error instanceof ProviderTransportError && error.status === 200 && /Invalid JSON/u.test(error.message)
  );
});

test("OpenAICompatibleAdapter parses streaming SSE responses", async () => {
  const tokens = [];
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://api.example.test/v1",
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.stream, true);
      return {
        ok: true,
        status: 200,
        async text() {
          return [
            'data: {"choices":[{"delta":{"content":"Hel"}}]}',
            "",
            'data: {"choices":[{"delta":{"content":"lo"}}]}',
            "",
            'data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10,"cache_read_input_tokens":3}}',
            "",
            "data: [DONE]",
            ""
          ].join("\n");
        }
      };
    }
  });
  const result = await adapter.generate({
    model: "writer-model",
    prompt: "hello",
    modelConfig: { stream: true },
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
});
