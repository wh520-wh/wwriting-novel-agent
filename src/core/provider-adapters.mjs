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
    // capability 净化：thinking 模型（reasoner/v4-pro）不支持 temperature/top_p，注入会被 DeepSeek 400。
    // resolveModelCapabilities 已算 supportsTemperature/supportsTopP，这里统一在请求构造层生效
    // （此前仅在 model-client L3 辅助缓存路径使用，正文写作路径漏净化）。
    const caps = resolveModelCapabilities({ ...modelConfig, base_url: baseUrl, model_name: selectedModel });
    const body = {
      model: selectedModel,
      messages: buildMessages({ messages, prompt, usesChapterTool, allowedTools }),
      ...(caps.supportsTemperature ? optionalNumber("temperature", modelConfig.temperature) : {}),
      ...(caps.supportsTopP ? optionalNumber("top_p", modelConfig.top_p) : {}),
      ...optionalNumber("max_tokens", modelConfig.max_output_tokens ?? modelConfig.max_tokens ?? (usesChapterTool ? DEFAULT_CHAPTER_TOOL_MAX_TOKENS : undefined)),
      ...buildChapterToolRequest(usesChapterTool, { ...modelConfig, base_url: baseUrl, model_name: selectedModel }, allowedTools, metadata),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
      ...(modelConfig.extra_body ?? {})
    };
    // 标准化输出契约：metadata.responseFormat 请求 json_object 输出时，
    // 按模型 capability 注入 response_format（DeepSeek JSON Output 兼容 OpenAI 格式）。
    if (metadata?.responseFormat === "json_object") {
      const caps = resolveModelCapabilities({ ...modelConfig, base_url: baseUrl, model_name: selectedModel });
      if (caps.supportsJsonOutput) {
        body.response_format = { type: "json_object" };
      }
    }
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
              // 流式心跳升级：onActivity 从无参心跳变为「带 delta 的心跳」——每个解析出的
              // 事件回调新增正文文本（usage-only 帧返回空串也照常回调，前端据此判断
              // "有 token 但无正文"不渲染；回调本身同时保持长流心跳新鲜）。
              metadata?.onActivity?.(token);
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
            metadata?.onActivity?.(token);
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

// 章节工具请求在未显式配置 max_output_tokens/max_tokens 时的默认上限。
// 防 reasoning 模型长输出（思考 token 计入完成 token）撞请求超时；
// 显式配置（max_output_tokens > max_tokens）优先于本默认值。
export const DEFAULT_CHAPTER_TOOL_MAX_TOKENS = 4096;

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
  const tr = metadata?.toolRequest;
  // 空 tools 数组（空注册表）不触发：回落围栏解析兜底，避免注入 {tools:[], tool_choice:"auto"}
  return Boolean(tr) && ((tr.tools?.length ?? 0) > 0 || (tr.project_id && tr.chapter_no));
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
  // 注入判定统一为「首条消息是否 system」：
  // - 首条已是 system（聊天会话 / 已含 system 的 transcript）不重注入，避免重复指令干扰上下文；
  // - 首条为 user 时注入（写作循环第 2+ 轮 transcript 首条是 user，仍需章节 writer 的英文 system 指令）。
  if (baseMessages[0]?.role === "system") {
    return baseMessages;
  }
  return [
    { role: "system", content: systemContent },
    ...baseMessages
  ];
}

function buildChapterToolRequest(usesChapterTool, modelConfig = {}, allowedTools = [], metadata = {}) {
  if (!usesChapterTool) {
    return {};
  }

  // 聊天场景：外部传入完整 tools 数组（toOpenAITools 产物），直接原样注入，
  // tool_choice 用 "auto"（模型自主选择是否调用），不查 WRITING_TOOL_DEFINITIONS。
  if (metadata?.toolRequest?.tools) {
    return { tools: metadata.toolRequest.tools, tool_choice: "auto" };
  }

  // 写作场景：根据写作 agent 循环传入的 allowed_tools 动态构建 tools 数组。
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

// 2026-07-31 结论记录（D3，DeepSeek thinking-mode 防护；F1 修订）：
// 当前架构不存在 CodeWhale 报告描述的「DeepSeek 推理模型拒绝强制 tool_choice 返回 400」场景，无需新增 sanitize。
// 依据：
// 1. requiresAutoToolChoice（isReasonerModel）已对 DeepSeek 推理模型强制 tool_choice="auto"（见 chapterToolChoice），
//    auto 模式 DeepSeek 仍会返回 tool_calls，不会因强制指定 tool 名而 400；
// 2. extractText / extractStreamToken 均有 reasoning_content 兜底（content 为空时取 reasoning_content），
//    不会因推理模型 content 为空而丢正文或触发错误路径。
// 3. F1 修订：deepseek-v4-flash 默认 non-thinking（官方 2026-07 文档），与 deepseek-chat 同等走
//    单工具 force 分支（chapterToolChoice 默认返回指定工具名）；仅 v4-pro / deepseek-reasoner 需 auto。
//    若未来暴露 thinking 参数开关，v4-flash 切 thinking 时需重新评估本条（含 reasoning_content 回传）。
// 若未来接入不经由此适配器的模型直连通道，需重新评估该结论。
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

// ── 供应商能力判断注册表（Task 5 泛化）──────────────────────────────────────
// 演进史（保留自 2026-07 记录，供维护者参考）：
// - DeepSeek thinking 判据：base_url 指向官方 API 且模型名命中 deepseek-v4-pro/deepseek-reasoner/
//   reasoner（2026-07 官方文档修正 F1：deepseek-reasoner 是 v4-flash thinking 模式的旧别名，
//   2026-07-24 已退役，名单保留以兼容旧配置）。
// - v4-flash（官方三模式 non-thinking/thinking/thinking_max，默认 non-thinking）不再判为 reasoner，
//   但官方 API 实测按 thinking 处理：不走 L3 缓存（采样参数不支持，无 temperature=0 注入）、
//   tool_choice 走 auto（与 v4-pro 同路径）；WWriting 不透传 thinking 参数，
//   v4-flash 恒走默认 non-thinking——若未来暴露思考模式开关，需改为按「是否启用 thinking」判定。
// - L3 确定性响应缓存：reasoner 系模型不支持 temperature 参数，不注入 temperature=0，
//   因缓存确定性建立在显式 temperature=0 上，这类模型本轮不走缓存（见 model-client #prepareAuxiliaryCache）。
// - Task 3 收敛：模型能力判定统一收敛到 capability matrix；Task 5 泛化：判据改为可注册表，
//   非 DeepSeek 供应商有类似 thinking/参数限制时注册一条 resolver 即可，无需改本文件内 if 分支
//   （评估报告 P2：非 DeepSeek 供应商覆盖面限制）。
const PROVIDER_CAPABILITY_RESOLVERS = [];

const DEFAULT_CAPABILITIES = Object.freeze({
  supportsThinking: false,
  requiresAutoToolChoice: false,
  supportsTemperature: true,
  supportsTopP: true,
  supportsJsonOutput: true,
  supportsTools: true,
  supportsStreaming: true
});

// 供应商能力判断注册表：新供应商有推理模型/参数限制时，注册一条 resolver 即可，
// 不需要改这个文件内部的 if 分支（评估报告 P2：非 DeepSeek 供应商覆盖面限制）。
// matcher(modelConfig) 命中时用 resolver(modelConfig) 的返回值覆盖 DEFAULT_CAPABILITIES；
// 按注册顺序先匹配先生效。
export function registerProviderCapabilityResolver(matcher, resolver) {
  PROVIDER_CAPABILITY_RESOLVERS.push({ matcher, resolver });
}

function resolveDeepSeekCapabilities(modelConfig) {
  const modelName = String(modelConfig.model_name ?? "").toLowerCase();
  // 原 isReasonerModel 判据 1:1 搬移：v4-pro / deepseek-reasoner / reasoner 系为 thinking 模型；
  // v4-flash 默认 non-thinking（官方 2026-07），不判为 reasoner。
  const supportsThinking = (
    (modelName.includes("deepseek-v4") && !modelName.includes("-flash")) ||
    modelName.includes("deepseek-reasoner") ||
    modelName.includes("reasoner")
  );
  // 实测：DeepSeek 官方 API 当前把 deepseek-v4-flash 当 thinking 模型处理，
  // 强制 tool_choice 会返回 400 "Thinking mode does not support this tool_choice"，
  // 故对官方 v4-flash 也走 auto（模型仍会返回 tool_calls）。
  const isDeepSeekV4Flash = modelName.includes("deepseek-v4-flash");
  return {
    supportsThinking,
    requiresAutoToolChoice: supportsThinking || isDeepSeekV4Flash,
    // v4-flash 官方按 thinking 处理(requiresAutoToolChoice)，采样参数同样不支持，
    // 与 supportsThinking 一并排除(R1:Task 4 净化覆盖 v4-flash，防 temperature 触发 400)。
    supportsTemperature: !supportsThinking && !isDeepSeekV4Flash,
    supportsTopP: !supportsThinking && !isDeepSeekV4Flash,
    supportsJsonOutput: true, // DeepSeek + OpenAI 兼容均支持 json_object
    supportsTools: true,
    supportsStreaming: true
  };
}

// DeepSeek 的 resolver 在模块加载时自动注册一次（matcher 对 base_url 做 lowercase 归一化，
// 与泛化前 isDeepSeek 门控语义等价），调用方无需手动注册。
registerProviderCapabilityResolver(
  (modelConfig) => String(modelConfig.base_url ?? "").toLowerCase().includes("api.deepseek.com"),
  resolveDeepSeekCapabilities
);

// 模型能力判定：遍历已注册 resolver，未匹配任何供应商时回落默认全能力开放。
export function resolveModelCapabilities(modelConfig = {}) {
  for (const { matcher, resolver } of PROVIDER_CAPABILITY_RESOLVERS) {
    if (matcher(modelConfig)) {
      return { ...DEFAULT_CAPABILITIES, ...resolver(modelConfig) };
    }
  }
  return DEFAULT_CAPABILITIES;
}

// C 档：写作引擎强依赖工具调用与流式；缺失时阻止保存/选用/切换（2026-08-03 调研落地）。
export function writingRequiredCapabilitiesOk(modelConfig = {}) {
  const caps = resolveModelCapabilities(modelConfig);
  return caps.supportsTools !== false && caps.supportsStreaming !== false;
}

function requiresAutoToolChoice(modelConfig = {}) {
  return resolveModelCapabilities(modelConfig).requiresAutoToolChoice;
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

