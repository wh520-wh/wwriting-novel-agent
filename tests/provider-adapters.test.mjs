import assert from "node:assert/strict";
import test from "node:test";
import { ModelClient } from "../src/core/model-client.mjs";
import {
  OpenAICompatibleAdapter,
  ProviderConfigurationError,
  ProviderTransportError,
  resolveModelCapabilities
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

test("OpenAICompatibleAdapter v4-flash 走 auto tool_choice（官方 API 当前按 thinking 处理，强制 function 会 400）", async () => {
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
            usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }
          });
        }
      };
    }
  });

  await adapter.generate({
    model: "deepseek-v4-flash",
    prompt: "Write through tools.",
    modelConfig: { stream: true },
    metadata: {
      toolRequest: {
        project_id: "project-1",
        chapter_no: 1,
        segment_no: 1
      }
    }
  });

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

test("OpenAICompatibleAdapter extracts Retry-After header from 429 response", async () => {
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://api.example.test/v1",
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
    () => adapter.generate({ model: "writer-model", prompt: "hello" }),
    (error) => {
      assert.ok(error instanceof ProviderTransportError);
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterMs, 5000);
      return true;
    }
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

test("OpenAICompatibleAdapter parses streaming SSE responses via ReadableStream", async () => {
  const tokens = [];
  const sseText = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}',
    "",
    'data: {"choices":[{"delta":{"content":"lo"}}]}',
    "",
    'data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10,"cache_read_input_tokens":3}}',
    "",
    "data: [DONE]",
    ""
  ].join("\n");
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://api.example.test/v1",
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.stream, true);
      return {
        ok: true,
        status: 200,
        text: async () => { throw new Error("streaming path should not call response.text()"); },
        body: {
          getReader() {
            const chunks = [new TextEncoder().encode(sseText)];
            let index = 0;
            return {
              read() {
                if (index >= chunks.length) return Promise.resolve({ done: true, value: undefined });
                return Promise.resolve({ done: false, value: chunks[index++] });
              }
            };
          }
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

test("OpenAICompatibleAdapter real streaming fires onToken as chunks arrive", async () => {
  const tokens = [];
  const chunk1 = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n';
  const chunk2 = 'data: {"choices":[{"delta":{"content":" World"}}]}\n\n';
  const chunk3 = 'data: [DONE]\n\n';
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://api.example.test/v1",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => { throw new Error("fake streaming path should not call response.text()"); },
      body: {
        getReader() {
          const chunks = [chunk1, chunk2, chunk3].map(c => new TextEncoder().encode(c));
          let index = 0;
          return {
            read() {
              if (index >= chunks.length) return Promise.resolve({ done: true, value: undefined });
              return Promise.resolve({ done: false, value: chunks[index++] });
            }
          };
        }
      }
    })
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
  assert.deepEqual(tokens, ["Hello", " World"]);
  assert.equal(result.text, "Hello World");
  assert.equal(result.raw.stream, true);
});

test("OpenAICompatibleAdapter throws truncation error on stream without DONE or finish_reason", async () => {
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://api.example.test/v1",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => { throw new Error("streaming path should not call response.text()"); },
      body: {
        getReader() {
          const chunks = [new TextEncoder().encode('data: {"choices":[{"text":"tail"}]}')];
          let index = 0;
          return {
            read() {
              if (index >= chunks.length) return Promise.resolve({ done: true, value: undefined });
              return Promise.resolve({ done: false, value: chunks[index++] });
            }
          };
        }
      }
    })
  });

  await assert.rejects(
    () => adapter.generate({
      model: "writer-model",
      prompt: "hello",
      modelConfig: { stream: true }
    }),
    (error) => {
      assert.ok(error instanceof ProviderTransportError);
      assert.equal(error.reason, "network");
      const body = JSON.parse(error.body);
      assert.ok(body.truncatedContentLength > 0);
      return true;
    }
  );
});

test("OpenAICompatibleAdapter streams CRLF-delimited SSE frames before the response ends", async () => {
  const tokens = [];
  const chunk1 = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\r\n\r\n';
  const chunk2 = 'data: {"choices":[{"delta":{"content":" World"}}]}\r\n\r\n';
  const chunk3 = "data: [DONE]\r\n\r\n";
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://api.example.test/v1",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => { throw new Error("streaming path should not call response.text()"); },
      body: {
        getReader() {
          const chunks = [chunk1, chunk2, chunk3].map(c => new TextEncoder().encode(c));
          let index = 0;
          return {
            read() {
              if (index === 1) assert.deepEqual(tokens, ["Hello"]);
              if (index >= chunks.length) return Promise.resolve({ done: true, value: undefined });
              return Promise.resolve({ done: false, value: chunks[index++] });
            }
          };
        }
      }
    })
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

  assert.deepEqual(tokens, ["Hello", " World"]);
  assert.equal(result.text, "Hello World");
});

test("OpenAICompatibleAdapter tolerates malformed SSE frames when stream terminates normally with [DONE]", async () => {
  const chunk1 = "data: {bad json}\n\n";
  const chunk2 = 'data: {"choices":[{"delta":{"content":"ok"}}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\ndata: [DONE]\n\n';
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://api.example.test/v1",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => { throw new Error("streaming path should not call response.text()"); },
      body: {
        getReader() {
          const chunks = [chunk1, chunk2].map(c => new TextEncoder().encode(c));
          let index = 0;
          return {
            read() {
              if (index >= chunks.length) return Promise.resolve({ done: true, value: undefined });
              return Promise.resolve({ done: false, value: chunks[index++] });
            }
          };
        }
      }
    })
  });

  // Stream terminates with [DONE], so malformed frames are tolerated (no throw)
  const result = await adapter.generate({
    model: "writer-model",
    prompt: "hello",
    modelConfig: { stream: true }
  });
  assert.equal(result.text, "ok");
  assert.ok(result.raw.malformed_sse_frame_count >= 1);
});

test("OpenAICompatibleAdapter throws truncation error on malformed SSE frames without termination signal", async () => {
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://api.example.test/v1",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => { throw new Error("streaming path should not call response.text()"); },
      body: {
        getReader() {
          const chunks = ['data: {bad}\n\ndata: {also bad}\n\n'].map(c => new TextEncoder().encode(c));
          let index = 0;
          return {
            read() {
              if (index >= chunks.length) return Promise.resolve({ done: true, value: undefined });
              return Promise.resolve({ done: false, value: chunks[index++] });
            }
          };
        }
      }
    })
  });

  // No DONE and no finish_reason, so malformed frames should throw truncation error
  await assert.rejects(
    () => adapter.generate({
      model: "writer-model",
      prompt: "hello",
      modelConfig: { stream: true }
    }),
    (error) => {
      assert.ok(error instanceof ProviderTransportError);
      assert.equal(error.reason, "network");
      const body = JSON.parse(error.body);
      assert.ok(body.malformedSseFrameCount >= 2);
      return true;
    }
  );
});

test("OpenAICompatibleAdapter detects stream truncation — missing DONE and finish_reason", async () => {
  // Stream with content events but no DONE and no finish_reason → truncation error
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://api.example.test/v1",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => { throw new Error("streaming path should not call response.text()"); },
      body: {
        getReader() {
          const chunks = ['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'].map(c => new TextEncoder().encode(c));
          let index = 0;
          return {
            read() {
              if (index >= chunks.length) return Promise.resolve({ done: true, value: undefined });
              return Promise.resolve({ done: false, value: chunks[index++] });
            }
          };
        }
      }
    })
  });

  await assert.rejects(
    () => adapter.generate({
      model: "writer-model",
      prompt: "hello",
      modelConfig: { stream: true }
    }),
    (error) => {
      assert.ok(error instanceof ProviderTransportError);
      assert.equal(error.reason, "network");
      assert.match(error.message, /DONE|finish_reason/);
      const body = JSON.parse(error.body);
      assert.equal(body.truncatedContentLength, 7);
      return true;
    }
  );
});

test("OpenAICompatibleAdapter sends stream_options with streaming requests", async () => {
  let captured = null;
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://api.example.test/v1",
    apiKey: "test-key",
    fetchImpl: async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return {
        ok: true,
        status: 200,
        text: async () => { throw new Error("should not be called"); },
        body: {
          getReader() {
            const chunks = [new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')];
            let index = 0;
            return {
              read() {
                if (index >= chunks.length) return Promise.resolve({ done: true, value: undefined });
                return Promise.resolve({ done: false, value: chunks[index++] });
              }
            };
          }
        }
      };
    }
  });
  await adapter.generate({
    model: "writer-model",
    prompt: "hello",
    modelConfig: { stream: true }
  });
  assert.equal(captured.body.stream, true);
  assert.deepEqual(captured.body.stream_options, { include_usage: true });
});

test("OpenAICompatibleAdapter falls back to reasoning_content when content is empty string", async () => {
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://api.example.test/v1",
    apiKey: "test-key",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [{ message: { content: "", reasoning_content: "reasoning output" } }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
        });
      }
    })
  });
  const result = await adapter.generate({ model: "deepseek-reasoner", prompt: "hi" });
  assert.equal(result.text, "reasoning output");
});

test("OpenAICompatibleAdapter prefers content over reasoning_content", async () => {
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://api.example.test/v1",
    apiKey: "test-key",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [{ message: { content: "final", reasoning_content: "reasoning" } }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
        });
      }
    })
  });
  const result = await adapter.generate({ model: "deepseek-reasoner", prompt: "hi" });
  assert.equal(result.text, "final");
});

test("OpenAICompatibleAdapter falls back to reasoning_content when content is missing", async () => {
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://api.example.test/v1",
    apiKey: "test-key",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [{ message: { reasoning_content: "only reasoning" } }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
        });
      }
    })
  });
  const result = await adapter.generate({ model: "deepseek-reasoner", prompt: "hi" });
  assert.equal(result.text, "only reasoning");
});

test("OpenAICompatibleAdapter streaming falls back to reasoning_content when content is empty", async () => {
  const tokens = [];
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://api.example.test/v1",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => { throw new Error("streaming path should not call response.text()"); },
      body: {
        getReader() {
          const chunks = [
            new TextEncoder().encode('data: {"choices":[{"delta":{"content":"","reasoning_content":"think"}}]}\n\n'),
            new TextEncoder().encode('data: {"choices":[{"delta":{"content":"","reasoning_content":"ing"}}]}\n\ndata: [DONE]\n\n')
          ];
          let index = 0;
          return {
            read() {
              if (index >= chunks.length) return Promise.resolve({ done: true, value: undefined });
              return Promise.resolve({ done: false, value: chunks[index++] });
            }
          };
        }
      }
    })
  });
  const result = await adapter.generate({
    model: "deepseek-reasoner",
    prompt: "hi",
    modelConfig: { stream: true },
    metadata: {
      onToken(token) {
        tokens.push(token);
      }
    }
  });
  assert.deepEqual(tokens, ["think", "ing"]);
  assert.equal(result.text, "thinking");
});

test("chapter tool request defaults max_tokens to 4096 when not configured", async () => {
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
            choices: [{ message: { content: "", tool_calls: [
              { id: "call_1", type: "function", function: { name: "append_chapter_segment", arguments: "{\"content\":\"正文\"}" } },
            ] } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          });
        },
      };
    },
  });
  await adapter.generate({
    model: "writer-model",
    prompt: "写第一章",
    metadata: { toolRequest: { project_id: "p1", chapter_no: 1, segment_no: 1 } },
  });
  assert.equal(captured.body.max_tokens, 4096);
  assert.equal(captured.body.stream, undefined); // 章节工具仍强制非流式
});

test("explicit max_output_tokens still overrides the chapter tool default", async () => {
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
            choices: [{ message: { content: "", tool_calls: [
              { id: "call_1", type: "function", function: { name: "append_chapter_segment", arguments: "{\"content\":\"正文\"}" } },
            ] } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          });
        },
      };
    },
  });
  await adapter.generate({
    model: "writer-model",
    prompt: "写第一章",
    modelConfig: { max_output_tokens: 8192 },
    metadata: { toolRequest: { project_id: "p1", chapter_no: 1, segment_no: 1 } },
  });
  assert.equal(captured.body.max_tokens, 8192);
});

test("resolveModelCapabilities: deepseek-v4-pro 标记 supportsThinking 且不支持 temperature", () => {
  const caps = resolveModelCapabilities({
    base_url: "https://api.deepseek.com/v1",
    model_name: "deepseek-v4-pro"
  });
  assert.equal(caps.supportsThinking, true);
  assert.equal(caps.requiresAutoToolChoice, true);
  assert.equal(caps.supportsTemperature, false);
  assert.equal(caps.supportsJsonOutput, true);
  assert.equal(caps.supportsTools, true);
});

test("resolveModelCapabilities: deepseek-v4-flash 默认非思考，支持 temperature，但需 auto tool_choice", () => {
  const caps = resolveModelCapabilities({
    base_url: "https://api.deepseek.com/v1",
    model_name: "deepseek-v4-flash"
  });
  assert.equal(caps.supportsThinking, false);
  assert.equal(caps.requiresAutoToolChoice, true);
  assert.equal(caps.supportsTemperature, true);
});

test("resolveModelCapabilities: 非 deepseek 模型默认全支持", () => {
  const caps = resolveModelCapabilities({
    base_url: "https://api.openai.com/v1",
    model_name: "gpt-4o"
  });
  assert.equal(caps.supportsThinking, false);
  assert.equal(caps.requiresAutoToolChoice, false);
  assert.equal(caps.supportsTemperature, true);
  assert.equal(caps.supportsJsonOutput, true);
  assert.equal(caps.supportsTools, true);
});

test("OpenAICompatibleAdapter 按 capability 注入 response_format=json_object", async () => {
  let captured = null;
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "k",
    fetchImpl: async (url, init) => {
      captured = JSON.parse(init.body);
      return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: "{}" } }] }); } };
    }
  });
  await adapter.generate({
    model: "deepseek-v4-flash",
    modelConfig: { model_name: "deepseek-v4-flash", base_url: "https://api.deepseek.com/v1" },
    messages: [{ role: "user", content: "输出 json" }],
    metadata: { responseFormat: "json_object" }
  });
  assert.deepEqual(captured.response_format, { type: "json_object" });
});

test("buildMessages: messages 首条为 system 时不重注入", async () => {
  let captured = null;
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://api.deepseek.com/v1", apiKey: "k",
    fetchImpl: async (url, init) => {
      captured = JSON.parse(init.body);
      return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: "ok" } }] }); } };
    }
  });
  const multiTurnMessages = [
    { role: "system", content: "chat system" },
    { role: "user", content: "写章" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_chapter", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: '{"chapter_no":1}' }
  ];
  await adapter.generate({
    model: "deepseek-v4-flash",
    modelConfig: { model_name: "deepseek-v4-flash", base_url: "https://api.deepseek.com/v1" },
    messages: multiTurnMessages,
    metadata: { toolRequest: { project_id: "p", chapter_no: 1, allowed_tools: ["read_chapter", "append_chapter_segment"] } }
  });
  // 首条已是 system（聊天会话 / 已含 system 的 transcript）：原样透传，不重复注入写作 system
  assert.equal(captured.messages.length, 4);
  assert.equal(captured.messages[0].role, "system");
  assert.equal(captured.messages[0].content, "chat system");
});

test("buildMessages: 多轮 messages 首条为 user 时注入 system（写作循环第 2+ 轮形状）", async () => {
  let captured = null;
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://api.deepseek.com/v1", apiKey: "k",
    fetchImpl: async (url, init) => {
      captured = JSON.parse(init.body);
      return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: "ok" } }] }); } };
    }
  });
  const multiTurnMessages = [
    { role: "user", content: "写章" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_chapter", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: '{"chapter_no":1}' }
  ];
  await adapter.generate({
    model: "deepseek-v4-flash",
    modelConfig: { model_name: "deepseek-v4-flash", base_url: "https://api.deepseek.com/v1" },
    messages: multiTurnMessages,
    metadata: { toolRequest: { project_id: "p", chapter_no: 1, allowed_tools: ["read_chapter", "append_chapter_segment"] } }
  });
  // 多轮 transcript 首条为 user：仍需章节 writer 的 system 指令，必须注入在首位
  assert.equal(captured.messages.length, 4);
  assert.equal(captured.messages[0].role, "system");
  assert.ok(captured.messages[0].content.includes("chapter writer"));
  assert.equal(captured.messages[1].role, "user");
  assert.equal(captured.messages[2].role, "assistant");
  assert.equal(captured.messages[3].role, "tool");
});

// ===== Task 7: 聊天场景外部 tools 注入（toolRequest.tools） =====
test("toolRequest.tools 原样注入 + tool_choice=auto，且不注入写作 system（聊天场景）", async () => {
  let captured = null;
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://api.deepseek.com/v1", apiKey: "k",
    fetchImpl: async (url, init) => {
      captured = JSON.parse(init.body);
      return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: "ok" } }] }); } };
    }
  });
  const externalTools = [
    { type: "function", function: { name: "get_status", description: "查状态", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "read_chapter", description: "读章", parameters: { type: "object", properties: {} } } }
  ];
  const chatMessages = [
    { role: "system", content: "chat system" },
    { role: "user", content: "进度如何？" }
  ];
  await adapter.generate({
    model: "chat-model",
    modelConfig: { model_name: "chat-model", base_url: "https://api.deepseek.com/v1" },
    messages: chatMessages,
    metadata: { toolRequest: { tools: externalTools, project_id: "p1" } }
  });
  // 外部 tools 数组原样进入 body（不经 WRITING_TOOL_DEFINITIONS 查找）
  assert.deepEqual(captured.tools, externalTools);
  assert.equal(captured.tool_choice, "auto");
  // 聊天场景首条已是 system：消息原样透传，不注入英文写作 system
  assert.deepEqual(captured.messages, chatMessages);
  assert.ok(!captured.messages.some((m) => m.role === "system" && m.content.includes("chapter writer")));
});

test("toolRequest.tools 为空数组时不注入 tools（回落围栏兜底）", async () => {
  let captured = null;
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://api.deepseek.com/v1", apiKey: "k",
    fetchImpl: async (url, init) => {
      captured = JSON.parse(init.body);
      return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: "ok" } }] }); } };
    }
  });
  await adapter.generate({
    model: "chat-model",
    modelConfig: { model_name: "chat-model", base_url: "https://api.deepseek.com/v1" },
    messages: [{ role: "user", content: "hi" }],
    metadata: { toolRequest: { tools: [], project_id: "p1" } }
  });
  // 空注册表：不应出现 {tools:[], tool_choice:"auto"}，也没有 chapter writer system 注入
  assert.equal(captured.tools, undefined);
  assert.equal(captured.tool_choice, undefined);
  assert.equal(captured.messages.length, 1);
});
