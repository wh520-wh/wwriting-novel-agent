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
    this.retryAfterMs = details.retryAfterMs ?? null;
    // reason: 'user-abort' | 'timeout' | 'network' | 'server-retryable' | 'client-fatal'
    this.reason = details.reason ?? this.#inferReason(details);
  }

  #inferReason(details) {
    // 只有 429/502/503/504 是可重试的服务器错误
    if (details.status === 429 || details.status === 502 || details.status === 503 || details.status === 504) {
      return "server-retryable";
    }
    // 其他 4xx 是客户端错误，不重试
    if (details.status >= 400 && details.status < 500) return "client-fatal";
    // 5xx 是服务器错误，可重试
    if (details.status >= 500) return "server-retryable";
    // 无 status = 网络错误
    return "network";
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
    const allowedTools = metadata?.toolRequest?.allowed_tools ?? [];
    const selectedModel = modelConfig.model_name ?? model;
    const stream = modelConfig.stream === true && !usesChapterTool;
    const body = {
      model: selectedModel,
      messages: buildMessages({ messages, prompt, usesChapterTool, allowedTools }),
      ...optionalNumber("temperature", modelConfig.temperature),
      ...optionalNumber("top_p", modelConfig.top_p),
      ...optionalNumber("max_tokens", modelConfig.max_output_tokens ?? modelConfig.max_tokens),
      ...buildChapterToolRequest(usesChapterTool, { ...modelConfig, base_url: baseUrl, model_name: selectedModel }, allowedTools),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
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
    if (!response.ok) {
      const errorText = await response.text();
      const retryAfterMs = parseRetryAfter(response.headers);
      throw new ProviderTransportError(`OpenAI-compatible provider returned HTTP ${response.status}.`, {
        status: response.status,
        body: errorText.slice(0, 2000),
        retryAfterMs
      });
    }
    if (stream) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let text = "";
      let usage = null;
      const events = [];
      let malformedSseFrameCount = 0;
      let sawDone = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Signal activity on each raw SSE chunk so the heartbeat stays fresh during long streams
        metadata?.onActivity?.();

        const parts = buffer.split(/(?:\r?\n){2,}/);
        buffer = parts.pop(); // keep incomplete part

        for (const part of parts) {
          const dataLines = part
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim());

          for (const data of dataLines) {
            if (!data) continue;
            if (data === "[DONE]") { sawDone = true; continue; }
            try {
              const event = JSON.parse(data);
              events.push(event);
              if (event.usage) usage = event.usage;
              const token = extractStreamToken(event);
              if (token) {
                text += token;
                metadata.onToken?.(token, event);
              }
            } catch (error) {
              malformedSseFrameCount += 1;
              metadata.onMalformedSseFrame?.({ data, error });
            }
          }
        }
      }

      // Handle remaining buffer
      if (buffer.trim()) {
        for (const line of buffer.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          if (trimmed === "data: [DONE]") { sawDone = true; continue; }
          try {
            const data = trimmed.slice(5).trim();
            const event = JSON.parse(data);
            events.push(event);
            if (event.usage) usage = event.usage;
            const token = extractStreamToken(event);
            if (token) {
              text += token;
              metadata.onToken?.(token, event);
            }
          } catch (error) {
            malformedSseFrameCount += 1;
            metadata.onMalformedSseFrame?.({ data: trimmed.slice(5).trim(), error });
          }
        }
      }

      // Truncation detection: malformed frames or missing stream-end signal
      const lastEvent = events.length > 0 ? events[events.length - 1] : null;
      const lastFinishReason = lastEvent?.choices?.[0]?.finish_reason ?? null;
      if (malformedSseFrameCount > 0) {
        // Only treat malformed frames as truncation when stream didn't terminate properly
        if (!sawDone && !lastFinishReason) {
          throw new ProviderTransportError(
            `Stream ended with ${malformedSseFrameCount} malformed SSE frame(s) and no termination signal.`,
            { reason: "network", body: JSON.stringify({ truncatedContentLength: text.length, malformedSseFrameCount }) }
          );
        }
        // Stream terminated normally — tolerate malformed frames with a warning
        console.warn(`Stream had ${malformedSseFrameCount} malformed SSE frame(s) but terminated normally.`);
      }
      if (events.length > 0 && !sawDone && !lastFinishReason) {
        throw new ProviderTransportError(
          "Stream ended without DONE or finish_reason — possible truncation.",
          { reason: "network", body: JSON.stringify({ truncatedContentLength: text.length, events: events.length }) }
        );
      }

      return {
        text,
        raw: { stream: true, events, malformed_sse_frame_count: malformedSseFrameCount },
        usage: normalizeOpenAIUsage(usage ?? {}),
        cost: null
      };
    }
    const responseText = await response.text();
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

// OpenAI function-call 格式的写作工具定义表。
// 写作 agent 循环（runWritingAgentLoop）中的 DRAFTING_ALLOWED_TOOLS / REVISING_ALLOWED_TOOLS
// 会通过 metadata.toolRequest.allowed_tools 传入，本表将其映射为 API 原生 tools 数组。
// 与聊天代理的 renderToolDocs 对应：聊天模式用文本描述工具，写作模式用结构化 function 定义。
const WRITING_TOOL_DEFINITIONS = {
  get_status: {
    type: "function",
    function: {
      name: "get_status",
      description: "获取项目当前状态：进度、阶段、运行状况、字数。",
      parameters: { type: "object", additionalProperties: false, properties: {} }
    }
  },
  list_chapters: {
    type: "function",
    function: {
      name: "list_chapters",
      description: "列出所有章节的进度概览（章号、状态、字数、标题），一次看全局。",
      parameters: { type: "object", additionalProperties: false, properties: {} }
    }
  },
  read_chapter: {
    type: "function",
    function: {
      name: "read_chapter",
      description: "读取指定章节正文。返回章节号、状态、字数、正文内容（可能因长度截断）。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["chapter_no"],
        properties: {
          chapter_no: { type: "integer", minimum: 1, description: "要读取的章节号" },
          max_chars: { type: "integer", description: "返回字符数上限，默认 8000。超出会截断并标记 truncated=true" }
        }
      }
    }
  },
  read_continuity: {
    type: "function",
    function: {
      name: "read_continuity",
      description: "读取设定档案（事实/时间线/角色）。可指定 entity 只看某个实体。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          entity: { type: "string", description: "可选，指定要查询的实体名称（角色名/组织名/地点等）" }
        }
      }
    }
  },
  read_outline: {
    type: "function",
    function: {
      name: "read_outline",
      description: "读取写作目标与任务计划，包括 story_seed、目标章数、字数要求等。",
      parameters: { type: "object", additionalProperties: false, properties: {} }
    }
  },
  edit_chapter: {
    type: "function",
    function: {
      name: "edit_chapter",
      description: "对指定章节正文做一次精确文本替换。find 唯一命中时直接替换；出现多次时需指定 occurrence 消歧。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["chapter_no", "find", "replace"],
        properties: {
          chapter_no: { type: "integer", minimum: 1, description: "要编辑的章节号" },
          find: { type: "string", minLength: 1, description: "要替换的原文片段（需精确匹配，建议至少 20 个字符确保唯一性）" },
          replace: { type: "string", description: "替换后的文字" },
          occurrence: { type: "integer", minimum: 1, description: "当 find 出现多次时，指定替换第几个（从 1 开始）。不填则要求 find 唯一" },
          reason: { type: "string", description: "修改原因的简短说明" }
        }
      }
    }
  },
  append_chapter_segment: {
    type: "function",
    function: {
      name: "append_chapter_segment",
      description: "将一段生成的章节正文追加到本地草稿文件。应用会在写入前校验参数。正文只放在 content 字段中，不要放在普通聊天文本里。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["project_id", "chapter_no", "segment_no", "content"],
        properties: {
          project_id: { type: "string", description: "当前任务的精确 project_id" },
          chapter_no: { type: "integer", minimum: 1, description: "当前任务的章节号" },
          segment_no: { type: "integer", minimum: 1, description: "当前任务的下一段落号" },
          content: { type: "string", minLength: 1, description: "本段落的完整正文。必须是连贯的叙事散文，不是大纲或要点。" }
        }
      }
    }
  },
  update_continuity: {
    type: "function",
    function: {
      name: "update_continuity",
      description: "更新设定档案中的实体信息（角色/组织/地点/事件等），记录新发现的事实。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["entity", "attribute", "value"],
        properties: {
          entity: { type: "string", description: "要更新的实体名（角色名/组织名/地点名等）" },
          attribute: { type: "string", description: "要更新的属性名（如 age、status、location、relationship 等）" },
          value: { type: "string", description: "属性的新值" },
          note: { type: "string", description: "补充说明（如更新原因、来源章节等）" }
        }
      }
    }
  },
  update_outline: {
    type: "function",
    function: {
      name: "update_outline",
      description: "更新写作大纲。可修改特定章节计划或整体大纲。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["plan"],
        properties: {
          chapter_no: { type: "integer", minimum: 1, description: "可选，指定要更新的章节号。不填则更新整体大纲" },
          plan: { type: "string", description: "更新后的大纲/计划内容" }
        }
      }
    }
  }
};

function shouldRequestChapterTool(metadata = {}) {
  return metadata?.toolRequest && metadata.toolRequest.project_id && metadata.toolRequest.chapter_no;
}

function buildMessages({ messages = [], prompt = "", usesChapterTool = false, allowedTools = [] } = {}) {
  const baseMessages = messages.length > 0 ? messages : [{ role: "user", content: prompt }];
  if (!usesChapterTool) {
    return baseMessages;
  }
  const hasMultiple = allowedTools.length > 1;
  const systemContent = hasMultiple
    ? "You are WWriting's chapter writer. Use tools (get_status, list_chapters, read_chapter, read_continuity, read_outline) to check context; edit_chapter to fix text; update_continuity/update_outline to record facts. When ready, output chapter prose directly as text — it will be captured automatically. Or call append_chapter_segment as an alternative."
    : "You are WWriting's chapter writer. For chapter body output, call append_chapter_segment exactly once. Put the chapter prose only in the tool input.content field, never in normal chat content.";
  return [
    { role: "system", content: systemContent },
    ...baseMessages
  ];
}

function buildChapterToolRequest(usesChapterTool, modelConfig = {}, allowedTools = []) {
  if (!usesChapterTool) {
    return {};
  }

  // 根据写作 agent 循环传入的 allowed_tools 动态构建 tools 数组。
  // 单工具模式（仅 append_chapter_segment）保持向后兼容；
  // 多工具模式（drafting/revising 阶段白名单）把全部允许工具发给 API，
  // 让模型按需先查设定/读前文/改正文，最后再提交 append_chapter_segment。
  const toolNames = allowedTools.length > 0 ? allowedTools : ["append_chapter_segment"];
  const tools = [];
  for (const name of toolNames) {
    const def = WRITING_TOOL_DEFINITIONS[name];
    if (def) {
      tools.push(def);
    }
  }

  if (tools.length === 0) {
    return {};
  }

  const hasMultiple = tools.length > 1;

  return {
    tools,
    tool_choice: chapterToolChoice(modelConfig, hasMultiple)
  };
}

function chapterToolChoice(modelConfig = {}, hasMultipleTools = false) {
  // 多工具模式：模型需要自主选择 read/edit/update/append，必须用 "auto"
  if (hasMultipleTools) {
    return "auto";
  }
  // 单工具模式：保持原有逻辑，非 DeepSeek 推理模型强制调用 append_chapter_segment
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

// DeepSeek thinking（reasoner 系）模型名单判据：base_url 指向官方 API 且模型名命中
// deepseek-v4*/deepseek-reasoner/reasoner。两处复用同一判据：
// 1. requiresAutoToolChoice —— thinking 模型拒绝强制 tool_choice，但 auto 模式仍会返回 tool_calls；
// 2. L3 确定性响应缓存 —— reasoner 系模型不支持 temperature 参数（L3 决策：不注入 temperature=0，
//    因缓存确定性建立在显式 temperature=0 上，reasoner 系模型本轮不走缓存）。
export function isReasonerModel(modelConfig = {}) {
  const baseUrl = String(modelConfig.base_url ?? "").toLowerCase();
  const modelName = String(modelConfig.model_name ?? "").toLowerCase();
  return (
    baseUrl.includes("api.deepseek.com") &&
    (modelName.includes("deepseek-v4") || modelName.includes("deepseek-reasoner") || modelName.includes("reasoner"))
  );
}

function requiresAutoToolChoice(modelConfig = {}) {
  return isReasonerModel(modelConfig);
}

function extractText(raw) {
  if (typeof raw.output_text === "string" && raw.output_text) {
    return raw.output_text;
  }
  const firstChoice = raw.choices?.[0];
  const message = firstChoice?.message;
  let text = "";
  if (typeof message?.content === "string") {
    text = message.content;
  } else if (Array.isArray(message?.content)) {
    text = message.content
      .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
      .filter(Boolean)
      .join("");
  }
  // DeepSeek 等推理模型可能在 content 为空时把内容放在 reasoning_content。
  if (!text && typeof message?.reasoning_content === "string") {
    text = message.reasoning_content;
  }
  if (!text && typeof firstChoice?.text === "string") {
    text = firstChoice.text;
  }
  return text;
}

function extractStreamToken(event) {
  const delta = event.choices?.[0]?.delta ?? {};
  // 空字符串时用 reasoning_content 兜底，避免推理模型 content 为空时丢 token。
  return delta.content || delta.reasoning_content || event.choices?.[0]?.text || "";
}

/**
 * Parse HTTP Retry-After header value into milliseconds.
 * Supports both decimal seconds and HTTP-date format.
 * Returns null if the header is missing or unparseable.
 */
function parseRetryAfter(headers) {
  if (!headers || typeof headers.get !== "function") {
    return null;
  }
  const raw = headers.get("retry-after");
  if (!raw) {
    return null;
  }
  // Try decimal seconds first
  const seconds = parseInt(raw, 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  // Try HTTP-date format — if we can't parse it, fall back to a reasonable default
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) {
    const diff = parsed - Date.now();
    return Math.max(0, diff);
  }
  return null;
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

