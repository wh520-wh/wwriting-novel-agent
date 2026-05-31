export class MockProviderAdapter {
  constructor(options = {}) {
    this.response = options.response ?? "mock provider response";
    this.usage = options.usage ?? {
      input_tokens: 12,
      output_tokens: 8,
      total_tokens: 20
    };
  }

  async generate(request) {
    const response = typeof this.response === "function" ? await this.response(request) : this.response;
    if (response && typeof response === "object" && Object.hasOwn(response, "text")) {
      return {
        text: response.text,
        raw: response.raw ?? response,
        usage: response.usage ?? this.usage
      };
    }
    return {
      text: String(response),
      raw: {
        provider: "mock",
        request
      },
      usage: this.usage
    };
  }
}

export class ProviderConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProviderConfigurationError";
    this.code = "provider_configuration_error";
  }
}

export class ProviderTransportError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ProviderTransportError";
    this.code = "provider_transport_error";
    this.status = details.status ?? null;
    this.body = details.body ?? null;
  }
}

export class OpenAICompatibleAdapter {
  constructor({ baseUrl, apiKey, apiKeyEnv, endpoint = "chat/completions", fetchImpl, defaultHeaders = {} } = {}) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.apiKeyEnv = apiKeyEnv;
    this.endpoint = endpoint;
    this.fetchImpl = fetchImpl;
    this.defaultHeaders = defaultHeaders;
  }

  async generate({ model, modelConfig = {}, prompt = "", messages = [], metadata = {}, signal = undefined } = {}) {
    const baseUrl = modelConfig.base_url ?? this.baseUrl;
    if (!baseUrl) {
      throw new ProviderConfigurationError("OpenAI-compatible provider requires base_url.");
    }
    const fetchImpl = this.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new ProviderConfigurationError("OpenAI-compatible provider requires fetch implementation.");
    }

    const apiKey = resolveApiKey({
      explicit: modelConfig.api_key ?? this.apiKey,
      envName: modelConfig.api_key_env ?? this.apiKeyEnv
    });
    const usesChapterTool = shouldRequestChapterTool(metadata);
    const selectedModel = modelConfig.model_name ?? model;
    const stream = modelConfig.stream === true && !usesChapterTool;
    const body = {
      model: selectedModel,
      messages: buildMessages({ messages, prompt, usesChapterTool }),
      ...optionalNumber("temperature", modelConfig.temperature),
      ...optionalNumber("top_p", modelConfig.top_p),
      ...optionalNumber("max_tokens", modelConfig.max_output_tokens ?? modelConfig.max_tokens),
      ...buildChapterToolRequest(usesChapterTool, { ...modelConfig, base_url: baseUrl, model_name: selectedModel }),
      ...(stream ? { stream: true } : {}),
      ...(modelConfig.extra_body ?? {})
    };
    const response = await fetchImpl(resolveEndpoint(baseUrl, modelConfig.endpoint ?? this.endpoint), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.defaultHeaders,
        ...(modelConfig.headers ?? {}),
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify(body),
      signal
    });
    const responseText = await response.text();
    if (!response.ok) {
      throw new ProviderTransportError(`OpenAI-compatible provider returned HTTP ${response.status}.`, {
        status: response.status,
        body: responseText.slice(0, 2000)
      });
    }
    if (stream) {
      const parsed = parseOpenAIStream(responseText, metadata.onToken);
      return {
        text: parsed.text,
        raw: parsed.raw,
        usage: normalizeOpenAIUsage(parsed.usage ?? {}),
        cost: null
      };
    }
    let raw = {};
    try {
      raw = responseText ? JSON.parse(responseText) : {};
    } catch (error) {
      throw new ProviderTransportError(`OpenAI-compatible provider returned Invalid JSON: ${error.message}`, {
        status: response.status,
        body: responseText.slice(0, 2000)
      });
    }
    return {
      text: extractText(raw),
      raw,
      usage: normalizeOpenAIUsage(raw.usage ?? {}),
      cost: null
    };
  }
}

function resolveApiKey({ explicit, envName }) {
  if (explicit) {
    return explicit;
  }
  if (!envName) {
    return null;
  }
  const value = process.env[envName];
  if (!value) {
    throw new ProviderConfigurationError(`Missing API key environment variable: ${envName}`);
  }
  return value;
}

function resolveEndpoint(baseUrl, endpoint) {
  return new URL(endpoint.replace(/^\/+/u, ""), ensureTrailingSlash(baseUrl)).toString();
}

function ensureTrailingSlash(value) {
  return String(value).endsWith("/") ? String(value) : `${value}/`;
}

function optionalNumber(key, value) {
  return Number.isFinite(value) ? { [key]: value } : {};
}

function shouldRequestChapterTool(metadata = {}) {
  return metadata?.toolRequest && metadata.toolRequest.project_id && metadata.toolRequest.chapter_no;
}

function buildMessages({ messages = [], prompt = "", usesChapterTool = false } = {}) {
  const baseMessages = messages.length > 0 ? messages : [{ role: "user", content: prompt }];
  if (!usesChapterTool) {
    return baseMessages;
  }
  return [
    {
      role: "system",
      content:
        "You are WWriting's chapter writer. For chapter body output, call append_chapter_segment exactly once. Put the chapter prose only in the tool input.content field, never in normal chat content."
    },
    ...baseMessages
  ];
}

function buildChapterToolRequest(usesChapterTool, modelConfig = {}) {
  if (!usesChapterTool) {
    return {};
  }
  return {
    tools: [
      {
        type: "function",
        function: {
          name: "append_chapter_segment",
          description: "Append one generated chapter segment to the local draft file. The application validates arguments before writing.",
          parameters: {
            type: "object",
            additionalProperties: false,
            required: ["project_id", "chapter_no", "segment_no", "content"],
            properties: {
              project_id: {
                type: "string",
                description: "The exact active WWriting project_id supplied by the current task."
              },
              chapter_no: {
                type: "integer",
                minimum: 1,
                description: "The active chapter number supplied by the current task."
              },
              segment_no: {
                type: "integer",
                minimum: 1,
                description: "The next segment number supplied by the current task."
              },
              content: {
                type: "string",
                minLength: 1,
                description: "The complete prose for this chapter segment."
              }
            }
          }
        }
      }
    ],
    tool_choice: chapterToolChoice(modelConfig)
  };
}

function chapterToolChoice(modelConfig = {}) {
  if (requiresAutoToolChoice(modelConfig)) {
    return "auto";
  }
  return {
    type: "function",
    function: {
      name: "append_chapter_segment"
    }
  };
}

function requiresAutoToolChoice(modelConfig = {}) {
  const baseUrl = String(modelConfig.base_url ?? "").toLowerCase();
  const modelName = String(modelConfig.model_name ?? "").toLowerCase();
  // DeepSeek thinking models reject forced tool_choice, but still return tool_calls with auto.
  return (
    baseUrl.includes("api.deepseek.com") &&
    (modelName.includes("deepseek-v4") || modelName.includes("deepseek-reasoner") || modelName.includes("reasoner"))
  );
}

function extractText(raw) {
  if (typeof raw.output_text === "string") {
    return raw.output_text;
  }
  const firstChoice = raw.choices?.[0];
  if (typeof firstChoice?.message?.content === "string") {
    return firstChoice.message.content;
  }
  if (Array.isArray(firstChoice?.message?.content)) {
    return firstChoice.message.content
      .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
      .filter(Boolean)
      .join("");
  }
  if (typeof firstChoice?.text === "string") {
    return firstChoice.text;
  }
  return "";
}

function normalizeOpenAIUsage(usage) {
  return {
    ...usage,
    cached_tokens: usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens,
    cache_read_tokens: usage.cache_read_tokens ?? usage.cache_read_input_tokens,
    cache_write_tokens: usage.cache_write_tokens ?? usage.cache_creation_input_tokens,
    reasoning_tokens: usage.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens
  };
}

function parseOpenAIStream(source, onToken) {
  const events = [];
  let text = "";
  let usage = null;
  for (const eventText of String(source).split(/\n\n+/u)) {
    const dataLines = eventText
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    for (const data of dataLines) {
      if (!data || data === "[DONE]") {
        continue;
      }
      const event = JSON.parse(data);
      events.push(event);
      if (event.usage) {
        usage = event.usage;
      }
      const delta = event.choices?.[0]?.delta?.content ?? event.choices?.[0]?.text ?? "";
      if (delta) {
        text += delta;
        onToken?.(delta, event);
      }
    }
  }
  return {
    text,
    usage,
    raw: {
      stream: true,
      events
    }
  };
}
