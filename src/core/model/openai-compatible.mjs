// src/core/model/openai-compatible.mjs
//
// OpenAI-compatible 生产 adapter（统一 Agent 内核计划 Task 3）。
//
// 只处理 HTTP transport 与响应归一化：请求构造（能力净化）、SSE 流式解析、
// 原生 function calling 解析、usage 归一化、错误分类。不包含任何业务身份文本、
// 工具定义表、工作流提示或项目路径——adapter 不知道它服务的应用是谁（计划
// Rule 7）。装配完成的 request（含 messages/tools/toolChoice/modelConfig）由
// 调用方（ModelGateway）传入；adapter 不得添加任何 system message，也不得修改
// 传入的 messages。
//
// 行为从旧 provider-adapters.mjs 的 OpenAICompatibleAdapter 迁移，删除了
// 章节 writer system 注入、写作工具定义表与文本工具兜底。

import { resolveModelCapabilities } from "./capabilities.mjs";

// 项目思考档位 → 官方 reasoning_effort（low/high/max；medium 官方向上映射为 high）。
const DEEPSEEK_EFFORT_BY_SETTING = { low: "low", medium: "high", high: "high" };

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
    // 包装网络级错误时保留原错误（fetch 拒绝等），便于诊断与 cause 链
    this.cause = details.cause ?? null;
    // reason: 'user-abort' | 'timeout' | 'network' | 'server-retryable' | 'client-fatal'
    this.reason = details.reason ?? inferReason(details);
  }
}

// 工具任务硬要求（计划 Rule 7）：模型不支持 native function calling 时，
// 带工具的请求直接拒绝，不回落文本工具。
// 注意：code 用 SCREAMING_SNAKE 的 MODEL_TOOLS_UNSUPPORTED 是统一 Agent 内核
// 计划（Task 1 冻结契约）固定的字面值，与同文件两个 transport 错误码
// （provider_configuration_error / provider_transport_error）的 snake_case
// 风格不同，但契约值不得改动；该错误只由能力门槛触发，不参与重试分类。
export class ModelToolsUnsupportedError extends Error {
  constructor(message = "该模型不支持工具调用，无法执行工具任务。") {
    super(message);
    this.name = "ModelToolsUnsupportedError";
    this.code = "MODEL_TOOLS_UNSUPPORTED";
  }
}

export function createOpenAICompatibleAdapter(options = {}) {
  return new OpenAICompatibleAdapter(options);
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

  // request: {
  //   messages: [{ role, content, tool_calls?, tool_call_id? }],
  //   tools?: [{ type: "function", function: { name, description, parameters } }],
  //   toolChoice?: "auto" | { type: "function", function: { name } },
  //   modelConfig: { model_name, base_url, api_key?, api_key_env?, temperature?,
  //                  top_p?, max_output_tokens?, max_tokens?, stream?, extra_body?,
  //                  headers?, endpoint? },
  //   stream?: boolean,
  //   metadata?: { onToken?, onActivity?, onMalformedSseFrame?, responseFormat? }
  // }
  // signal: 外部取消信号（timeout 由 ModelGateway 组合后传入）。
  async complete(request, { signal } = {}) {
    if (request == null || typeof request !== "object") {
      throw new TypeError("adapter.complete 需要 request 对象");
    }
    const modelConfig = request.modelConfig ?? {};
    const baseUrl = modelConfig.base_url ?? this.baseUrl;
    if (!baseUrl) {
      throw new ProviderConfigurationError("OpenAI-compatible provider requires base_url.");
    }
    const fetchImpl = this.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new ProviderConfigurationError("OpenAI-compatible provider requires fetch implementation.");
    }

    const selectedModel = modelConfig.model_name ?? request.model ?? null;
    if (!selectedModel) {
      throw new ProviderConfigurationError("OpenAI-compatible provider requires model_name.");
    }

    const apiKey = resolveApiKey({
      explicit: modelConfig.api_key ?? this.apiKey,
      envName: modelConfig.api_key_env ?? this.apiKeyEnv
    });

    const caps = resolveModelCapabilities({ ...modelConfig, base_url: baseUrl, model_name: selectedModel });
    const tools = Array.isArray(request.tools) && request.tools.length > 0 ? request.tools : null;
    // 工具任务硬要求：请求带工具但模型不支持 native function calling → 直接拒绝。
    if (tools && caps.supportsTools === false) {
      throw new ModelToolsUnsupportedError();
    }

    const stream = request.stream === true || modelConfig.stream === true;
    const metadata = request.metadata ?? {};
    const body = {
      model: selectedModel,
      messages: Array.isArray(request.messages) ? request.messages : [],
      // capability 净化：thinking 模型不支持 temperature/top_p，注入会被 400
      ...(caps.supportsTemperature ? optionalNumber("temperature", modelConfig.temperature) : {}),
      ...(caps.supportsTopP ? optionalNumber("top_p", modelConfig.top_p) : {}),
      ...optionalNumber("max_tokens", modelConfig.max_output_tokens ?? modelConfig.max_tokens),
      // DeepSeek 思考模式显式钉死（仿 dsh-llm-deepseek，官方 thinking_mode 契约）：
      // 声明 reasoningEffortLevels 的模型一律携带 thinking:{type:"enabled"} 与
      // reasoning_effort——绝不赌服务端默认（2026-08 实测默认值按时间窗漂移，
      // 思考内容时有时无）。项目档位映射：low→low、medium/high→high（官方对
      // medium 向上映射）、auto/缺省→high（官方缺省档）。
      ...(Array.isArray(caps.reasoningEffortLevels)
        ? {
            thinking: { type: "enabled" },
            reasoning_effort: DEEPSEEK_EFFORT_BY_SETTING[modelConfig.reasoning_effort] ?? "high"
          }
        : {}),
      ...(tools ? { tools, tool_choice: request.toolChoice ?? "auto" } : {}),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
      ...(modelConfig.extra_body ?? {})
    };
    // 请求 json_object 输出时按模型 capability 注入 response_format
    if (metadata.responseFormat === "json_object" && caps.supportsJsonOutput) {
      body.response_format = { type: "json_object" };
    }

    let response;
    try {
      response = await fetchImpl(resolveEndpoint(baseUrl, modelConfig.endpoint ?? this.endpoint), {
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
    } catch (error) {
      // fetch 网络级拒绝（DNS/连接/代理/TypeError: fetch failed）：包装为可重试
      // 的 transport 错误，gateway 的 isRetryable 只认 provider_transport_error。
      // 中止（AbortError）原样上抛，保留取消语义。
      if (error?.name === "AbortError") {
        throw error;
      }
      throw new ProviderTransportError(
        `OpenAI-compatible provider fetch failed: ${error?.message ?? String(error)}`,
        { reason: "network", cause: error }
      );
    }
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
      return readStream(response.body, metadata, {
        // OpenCode 的兼容网关会在最后一个完整 JSON data 帧后直接关闭
        // 连接，省略 OpenAI 的 [DONE]/finish_reason 收尾。仅对该端点（或
        // 用户显式声明的兼容端点）放宽 EOF，默认仍保持截断保护。
        allowCleanEof: modelConfig.allow_stream_eof === true || isOpenCodeEndpoint(baseUrl)
      });
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
    return normalizeCompletion(raw);
  }
}

// ---------------------------------------------------------------------------
// 非流式响应归一化
// ---------------------------------------------------------------------------

function normalizeCompletion(raw) {
  const { text, reasoning } = extractMessage(raw);
  return {
    text,
    reasoning,
    toolCalls: extractToolCalls(raw),
    raw,
    usage: normalizeOpenAIUsage(raw.usage ?? {}),
    cost: null
  };
}

// 原生 tool_calls 的 arguments 可能已是对象（部分代理返回）或 JSON 字符串；
// 解析失败给 null。
export function parseToolCallArguments(argumentsValue) {
  if (argumentsValue && typeof argumentsValue === "object") {
    return argumentsValue;
  }
  if (typeof argumentsValue !== "string") {
    return null;
  }
  try {
    return JSON.parse(argumentsValue);
  } catch {
    return null;
  }
}

function extractToolCalls(raw) {
  const message = raw?.choices?.[0]?.message;
  if (!Array.isArray(message?.tool_calls)) {
    return [];
  }
  return message.tool_calls
    .map((tc) => {
      if (!tc) return null;
      return {
        type: "tool_call",
        id: tc.id ?? null,
        tool: tc.function?.name ?? tc.name ?? null,
        input: parseToolCallArguments(tc.function?.arguments ?? tc.arguments)
      };
    })
    .filter(Boolean);
}

// 非流式正文/reasoning 提取（契约 §2.1：两字段分离，互不兜底）。
// 提取顺序与旧 extractText 不同：content（公开正文）→ firstChoice.text →
// output_text；正文为空时绝不把 reasoning_content 回退进 text。
function extractMessage(raw) {
  const firstChoice = raw.choices?.[0];
  const message = firstChoice?.message;
  const text = extractContent(message?.content) || firstChoice?.text || raw.output_text || "";
  const reasoning = typeof message?.reasoning_content === "string"
    ? message.reasoning_content
    : "";
  return { text, reasoning };
}

// content 可能是字符串或多段数组（部分代理返回 [{ type: "text", text }]）。
function extractContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
      .filter(Boolean)
      .join("");
  }
  return "";
}

// ---------------------------------------------------------------------------
// 流式（SSE）解析：delta 文本、usage 帧、[DONE]/finish_reason 截断检测、
// 原生 function calling 增量累积、malformed 帧容忍。
// ---------------------------------------------------------------------------

async function readStream(responseBody, metadata, { allowCleanEof = false } = {}) {
  if (!responseBody || typeof responseBody.getReader !== "function") {
    throw new ProviderTransportError("OpenAI-compatible stream 缺少 ReadableStream body.", {
      reason: "network"
    });
  }
  const reader = responseBody.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let reasoningText = "";
  let usage = null;
  let eventCount = 0;
  // 累计跟踪最近一次非 null 的 finish_reason（Task 4 Issue 1）：include_usage 时
  // usage 帧（choices:[]）按 OpenAI 规范跟在 finish_reason 帧之后、[DONE] 之前，
  // 若只取末帧会把 finish_reason 覆盖成 null，导致截断检测静默失效。
  let lastFinishReason = null;
  const streamToolCalls = [];
  let malformedSseFrameCount = 0;
  let sawDone = false;

  const handleData = (data) => {
    if (data === "[DONE]") {
      sawDone = true;
      return;
    }
    let event;
    try {
      event = JSON.parse(data);
    } catch (error) {
      malformedSseFrameCount += 1;
      metadata.onMalformedSseFrame?.({ data, error });
      return;
    }
    eventCount += 1;
    if (event.usage) usage = event.usage;
    const finishReason = event?.choices?.[0]?.finish_reason ?? null;
    if (finishReason) lastFinishReason = finishReason;
    // 活动上报（Task 4 契约）：每个成功解析的 data: 帧都回调一次，不以 token
    // 非空为条件——tool-call-only 增量帧、空 delta、usage-only 帧（token=""）
    // 一律算活动；gateway 据此刷新内部空闲时钟，避免「连接活着但没有 token」
    // 的流被空闲超时误杀。回调携带 token（可能为空串）便于调用方判断「有 token
    // 但无正文」。[DONE] 与 malformed 帧不计入（不是成功解析的事件）。
    const token = extractStreamToken(event);
    const reasoningToken = extractReasoningStreamToken(event);
    metadata.onActivity?.(token || reasoningToken);
    applyStreamToolCallDeltas(streamToolCalls, event);
    if (reasoningToken) {
      reasoningText += reasoningToken;
      metadata.onReasoningToken?.(reasoningToken, event);
    }
    if (token) {
      text += token;
      metadata.onToken?.(token, event);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/(?:\r?\n){2,}/);
    buffer = parts.pop(); // keep incomplete part
    for (const part of parts) {
      for (const line of part.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        handleData(trimmed.slice(5).trim());
      }
    }
  }

  // R5-3：流结束冲刷——无参 decode() 把流式解码器内部不完整的尾字节序列解码
  //（不静默丢字节；不完整序列按 UTF-8 规范产出 U+FFFD）。冲刷结果并入 buffer，
  // 由下方「剩余缓冲」处理兜底。
  buffer += decoder.decode();

  // Handle remaining buffer（流结束前的最后一个不完整帧）
  if (buffer.trim()) {
    for (const line of buffer.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      handleData(trimmed.slice(5).trim());
    }
  }

  // Truncation detection：malformed 帧或缺失流结束信号都视为可能截断
  if (malformedSseFrameCount > 0) {
    if (!sawDone && !lastFinishReason) {
      throw new ProviderTransportError(
        `Stream ended with ${malformedSseFrameCount} malformed SSE frame(s) and no termination signal.`,
        { reason: "network", body: JSON.stringify({ truncatedContentLength: text.length + reasoningText.length, malformedSseFrameCount }) }
      );
    }
  }
  const streamTerminatedByEof = eventCount > 0 && !sawDone && !lastFinishReason;
  if (streamTerminatedByEof && !allowCleanEof) {
    throw new ProviderTransportError(
      "Stream ended without DONE or finish_reason — possible truncation.",
      { reason: "network", body: JSON.stringify({ truncatedContentLength: text.length + reasoningText.length, events: eventCount }) }
    );
  }

  return {
    text,
    reasoning: reasoningText,
    toolCalls: finalizeStreamToolCalls(streamToolCalls, {
      sawDone: sawDone || (streamTerminatedByEof && allowCleanEof),
      finishReason: lastFinishReason
    }),
    raw: {
      stream: true,
      event_count: eventCount,
      malformed_sse_frame_count: malformedSseFrameCount,
      // 末帧 finish_reason（如 "stop" / "length" / "tool_calls"）；无终止帧时为 null。
      // "length" 表示 max_tokens 截断——调用方据此标记 truncated，不能当作完整输出。
      finish_reason: lastFinishReason ?? null,
      ...(streamTerminatedByEof ? { stream_terminated_by_eof: true } : {})
    },
    usage: normalizeOpenAIUsage(usage ?? {}),
    cost: null
  };
}

// OpenAI 流式 function calling 增量：按 index 累积 id/name/arguments 片段。
function applyStreamToolCallDeltas(streamToolCalls, event) {
  const deltas = event?.choices?.[0]?.delta?.tool_calls;
  if (!Array.isArray(deltas) || deltas.length === 0) return;
  for (const delta of deltas) {
    const index = Number.isInteger(delta.index) ? delta.index : 0;
    let slot = streamToolCalls[index];
    if (!slot) {
      slot = { id: null, name: "", arguments: "" };
      streamToolCalls[index] = slot;
    }
    if (typeof delta.id === "string") slot.id = delta.id;
    if (typeof delta.function?.name === "string") slot.name = delta.function.name;
    if (typeof delta.function?.arguments === "string") slot.arguments += delta.function.arguments;
  }
}

// R5-5：finalizeStreamToolCalls 依据流终止信号与参数 JSON 完整性给每个 tool call
// 标记 arguments_complete。判定来源：流是否收到 [DONE]（sawDone）、末帧
// finish_reason（"length" 表示 max_tokens 截断——输出可能不完整）、以及累积的
// arguments 是否可解析。三者任一不满足都视为不完整，调用方（Runtime）据此
// 拒绝执行（truncated_args_rejected），而不是把半截参数喂给工具。
function finalizeStreamToolCalls(streamToolCalls, { sawDone, finishReason } = {}) {
  return streamToolCalls
    .filter((slot) => slot && slot.name)
    .map((slot) => {
      const input = parseToolCallArguments(slot.arguments);
      const argumentsComplete = sawDone === true && finishReason !== "length" && input != null;
      return {
        type: "tool_call",
        id: slot.id ?? null,
        tool: slot.name,
        input,
        arguments_complete: argumentsComplete
      };
    });
}

function extractStreamToken(event) {
  const delta = event.choices?.[0]?.delta ?? {};
  // 只有公开正文进入 onToken；reasoning_content 属于私有推理通道。
  return delta.content || event.choices?.[0]?.text || "";
}

function extractReasoningStreamToken(event) {
  const delta = event.choices?.[0]?.delta ?? {};
  return delta.reasoning_content || "";
}

function isOpenCodeEndpoint(baseUrl) {
  try {
    return new URL(String(baseUrl)).hostname.toLowerCase() === "opencode.ai";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

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

function inferReason(details) {
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
  const seconds = parseInt(raw, 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
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
