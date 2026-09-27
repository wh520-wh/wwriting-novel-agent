// src/core/model/anthropic-messages.mjs
//
// Anthropic Messages 协议生产 adapter（round22 D5）。
//
// 与 openai-compatible.mjs 同一契约：new Adapter({baseUrl, apiKey, apiKeyEnv,
// fetchImpl}).complete(request, { signal }) -> { text, reasoning, toolCalls,
// raw, usage, cost }。只处理 HTTP transport 与响应归一化；请求构造由 ModelGateway
// 传入，adapter 不添加任何 system message、不修改业务提示。
//
// 映射口径（D5/D6）：
//   - POST {baseUrl}/v1/messages，x-api-key + anthropic-version 鉴权；baseUrl 自带
//     /api/anthropic 等前缀原样保留、已有 /v1 结尾不重复追加。
//   - system 消息映射顶层 system；assistant/tool_calls 映射 content blocks
//     （text / tool_use）；工具结果（role:"tool"）合并进单个 user 轮的
//     tool_result block（Anthropic 要求 tool_result 全部位于 user 轮）。
//   - tools 映射 {name, description, input_schema}；max_tokens 必填（缺省 4096，
//     配置了 max_output_tokens 时用配置值）。
//   - 非流式读 content 的 text/thinking/tool_use；流式处理 message_start/
//     content_block_start/content_block_delta/message_delta/message_stop，
//     只有 message_stop 算完整工具参数，缺终止事件报传输截断。
//   - usage 沿用 Anthropic 原生 input_tokens/output_tokens（归一经
//     normalizeOpenAIUsage 的别名映射）。取消透传 AbortError；HTTP 错误复用
//     ProviderTransportError 分类与脱敏。

import { resolveModelCapabilities } from "./capabilities.mjs";
import {
  ModelToolsUnsupportedError,
  ProviderConfigurationError,
  ProviderTransportError,
  normalizeOpenAIUsage,
  parseRetryAfter,
  parseToolCallArguments,
  resolveApiKey,
  ensureTrailingSlash
} from "./openai-compatible.mjs";

const ANTHROPIC_VERSION = "2023-06-01";

export function createAnthropicMessagesAdapter(options = {}) {
  return new AnthropicMessagesAdapter(options);
}

export class AnthropicMessagesAdapter {
  constructor({ baseUrl, apiKey, apiKeyEnv, fetchImpl, defaultHeaders = {} } = {}) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.apiKeyEnv = apiKeyEnv;
    this.fetchImpl = fetchImpl;
    this.defaultHeaders = defaultHeaders;
  }

  async complete(request, { signal } = {}) {
    if (request == null || typeof request !== "object") {
      throw new TypeError("adapter.complete 需要 request 对象");
    }
    const modelConfig = request.modelConfig ?? {};
    const baseUrl = modelConfig.base_url ?? this.baseUrl;
    if (!baseUrl) {
      throw new ProviderConfigurationError("Anthropic provider requires base_url.");
    }
    const fetchImpl = this.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new ProviderConfigurationError("Anthropic provider requires fetch implementation.");
    }
    const selectedModel = modelConfig.model_name ?? request.model ?? null;
    if (!selectedModel) {
      throw new ProviderConfigurationError("Anthropic provider requires model_name.");
    }
    const apiKey = resolveApiKey({
      explicit: modelConfig.api_key ?? this.apiKey,
      envName: modelConfig.api_key_env ?? this.apiKeyEnv
    });

    const caps = resolveModelCapabilities({ ...modelConfig, base_url: baseUrl, model_name: selectedModel });
    const tools = Array.isArray(request.tools) && request.tools.length > 0 ? request.tools : null;
    if (tools && caps.supportsTools === false) {
      throw new ModelToolsUnsupportedError();
    }

    const stream = request.stream === true || modelConfig.stream === true;
    const metadata = request.metadata ?? {};
    const body = buildRequestBody(request, modelConfig, { caps, tools, stream });
    if (stream) body.stream = true;

    let response;
    try {
      response = await fetchImpl(anthropicMessagesUrl(baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { "x-api-key": apiKey } : {}),
          "anthropic-version": ANTHROPIC_VERSION,
          ...this.defaultHeaders,
          ...(modelConfig.headers ?? {})
        },
        body: JSON.stringify(body),
        signal
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw error;
      }
      throw new ProviderTransportError(
        `Anthropic provider fetch failed: ${error?.message ?? String(error)}`,
        { reason: "network", cause: error }
      );
    }
    if (!response.ok) {
      const errorText = await response.text();
      throw new ProviderTransportError(`Anthropic provider returned HTTP ${response.status}.`, {
        status: response.status,
        body: errorText.slice(0, 2000),
        retryAfterMs: parseRetryAfter(response.headers)
      });
    }

    if (stream) {
      return readStream(response.body, metadata);
    }
    const responseText = await response.text();
    let raw = {};
    try {
      raw = responseText ? JSON.parse(responseText) : {};
    } catch (error) {
      throw new ProviderTransportError(`Anthropic provider returned Invalid JSON: ${error.message}`, {
        status: response.status,
        body: responseText.slice(0, 2000)
      });
    }
    return normalizeCompletion(raw);
  }
}

// 拼端点：保留 baseUrl 自带路径前缀（如中转站的 /api/anthropic）；路径已以 /v1
// 结尾时不重复追加。
export function anthropicMessagesUrl(baseUrl) {
  const trimmed = String(baseUrl).replace(/\/+$/u, "");
  let pathname = "";
  try {
    pathname = new URL(trimmed).pathname.replace(/\/+$/u, "");
  } catch {
    return `${trimmed}/v1/messages`;
  }
  return pathname.endsWith("/v1") ? `${trimmed}/messages` : `${trimmed}/v1/messages`;
}

function buildRequestBody(request, modelConfig, { caps, tools, stream }) {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const body = {
    model: modelConfig.model_name ?? request.model,
    messages: mapMessages(messages),
    // Anthropic 要求 max_tokens 必填：优先显式配置，缺省给保守值 4096。
    max_tokens: Number.isFinite(modelConfig.max_output_tokens)
      ? modelConfig.max_output_tokens
      : Number.isFinite(modelConfig.max_tokens)
        ? modelConfig.max_tokens
        : 4096,
    ...(caps.supportsTemperature && Number.isFinite(modelConfig.temperature) ? { temperature: modelConfig.temperature } : {}),
    ...(caps.supportsTopP && Number.isFinite(modelConfig.top_p) ? { top_p: modelConfig.top_p } : {})
  };
  const system = messages
    .filter((m) => m?.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : contentText(m.content)))
    .filter(Boolean)
    .join("\n\n");
  if (system) body.system = system;
  if (tools) {
    body.tools = tools.map((tool) => {
      const fn = tool?.function ?? tool;
      return {
        name: fn?.name,
        description: fn?.description ?? "",
        input_schema: fn?.parameters ?? { type: "object", properties: {} }
      };
    });
    const choice = request.toolChoice;
    if (choice === "auto") body.tool_choice = { type: "auto" };
    else if (choice?.type === "function" && choice.function?.name) body.tool_choice = { type: "tool", name: choice.function.name };
  }
  if (stream) body.stream = true;
  return body;
}

// OpenAI 形状 → Anthropic messages：system 抽走（顶层 system）；连续 tool 结果
// 合并进单个 user 轮；assistant 的 tool_calls 映射 tool_use blocks。
export function mapMessages(messages) {
  const out = [];
  for (const message of messages) {
    if (!message || message.role === "system") continue;
    const text = typeof message.content === "string" ? message.content : contentText(message.content);
    if (message.role === "tool") {
      const toolResult = {
        type: "tool_result",
        tool_use_id: message.tool_call_id ?? null,
        content: text
      };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content) && last.content[0]?.type === "tool_result") {
        last.content.push(toolResult); // 连续工具结果并入同一 user 轮
      } else {
        out.push({ role: "user", content: [toolResult] });
      }
      continue;
    }
    if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const blocks = [];
      if (text) blocks.push({ type: "text", text });
      for (const toolCall of message.tool_calls) {
        blocks.push({
          type: "tool_use",
          id: toolCall.id ?? null,
          name: toolCall.tool ?? toolCall.function?.name ?? null,
          input: toolCall.input ?? parseToolCallArguments(toolCall.function?.arguments) ?? {}
        });
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }
    out.push({ role: message.role === "assistant" ? "assistant" : "user", content: text });
  }
  return out;
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
      .filter(Boolean)
      .join("");
  }
  return "";
}

function normalizeCompletion(raw) {
  const blocks = Array.isArray(raw?.content) ? raw.content : [];
  const textParts = [];
  const reasoningParts = [];
  const toolCalls = [];
  for (const block of blocks) {
    if (block?.type === "text" && block.text) textParts.push(block.text);
    else if (block?.type === "thinking" && block.thinking) reasoningParts.push(block.thinking);
    else if (block?.type === "tool_use") {
      toolCalls.push({
        type: "tool_call",
        id: block.id ?? null,
        tool: block.name ?? null,
        input: block.input ?? {},
        arguments_complete: true
      });
    }
  }
  return {
    text: textParts.join(""),
    reasoning: reasoningParts.join(""),
    toolCalls,
    raw,
    usage: normalizeOpenAIUsage(raw.usage ?? {}),
    cost: null
  };
}

// ---------------------------------------------------------------------------
// 流式（SSE）：event 名 + data JSON。文本/思考增量即时回调；tool_use 参数经
// input_json_delta 累积，message_stop 才算完整；缺 message_stop 报传输截断。
// ---------------------------------------------------------------------------

async function readStream(responseBody, metadata) {
  if (!responseBody || typeof responseBody.getReader !== "function") {
    throw new ProviderTransportError("Anthropic stream 缺少 ReadableStream body.", { reason: "network" });
  }
  const reader = responseBody.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let reasoningText = "";
  let usage = {};
  let sawMessageStop = false;
  let sawMessageStart = false;
  let eventCount = 0;
  let stopReason = null;
  // 按 block index 累积：tool_use 的 id/name 来自 content_block_start，参数来自
  // input_json_delta 增量。
  const blocks = new Map();

  const handleEvent = (eventName, data) => {
    eventCount += 1;
    const event = data.type ?? eventName;
    if (event === "message_start") {
      sawMessageStart = true;
      if (data.message?.usage) usage = { ...usage, ...data.message.usage };
      metadata.onActivity?.("");
      return;
    }
    if (event === "content_block_start") {
      const block = data.content_block ?? {};
      blocks.set(data.index, {
        type: block.type,
        id: block.id ?? null,
        name: block.name ?? null,
        json: ""
      });
      metadata.onActivity?.("");
      return;
    }
    if (event === "content_block_delta") {
      const slot = blocks.get(data.index) ?? { type: data.delta?.type, json: "" };
      const delta = data.delta ?? {};
      if (delta.type === "text_delta" && delta.text) {
        text += delta.text;
        metadata.onToken?.(delta.text, data);
        metadata.onActivity?.(delta.text);
      } else if (delta.type === "thinking_delta" && delta.thinking) {
        reasoningText += delta.thinking;
        metadata.onReasoningToken?.(delta.thinking, data);
        metadata.onActivity?.(delta.thinking);
      } else if (delta.type === "input_json_delta" && delta.partial_json) {
        slot.json += delta.partial_json;
        metadata.onActivity?.("");
      } else {
        metadata.onActivity?.("");
      }
      blocks.set(data.index, slot);
      return;
    }
    if (event === "message_delta") {
      if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
      if (data.usage) usage = { ...usage, ...data.usage };
      metadata.onActivity?.("");
      return;
    }
    if (event === "message_stop") {
      sawMessageStop = true;
      metadata.onActivity?.("");
      return;
    }
    if (event === "error") {
      throw new ProviderTransportError(
        `Anthropic stream error event: ${data.error?.message ?? "unknown"}`,
        { reason: "network", body: JSON.stringify(data).slice(0, 2000) }
      );
    }
    // ping 等其余事件：算活动，不携带内容
    metadata.onActivity?.("");
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/(?:\r?\n){2,}/);
    buffer = parts.pop();
    for (const part of parts) {
      const parsed = parseSseEvent(part);
      if (parsed) handleEvent(parsed.event, parsed.data);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    const parsed = parseSseEvent(buffer);
    if (parsed) handleEvent(parsed.event, parsed.data);
  }

  // 截断检测：收到过 message_start 却没有 message_stop = 传输中断，可能截断。
  if (sawMessageStart && !sawMessageStop) {
    throw new ProviderTransportError(
      "Anthropic stream ended without message_stop — possible truncation.",
      { reason: "network", body: JSON.stringify({ truncatedContentLength: text.length + reasoningText.length, events: eventCount }) }
    );
  }
  if (stopReason === "max_tokens") {
    // 与 OpenAI "length" 同语义：max_tokens 截断——工具参数可能不完整，交给
    // finalize 的 arguments_complete 判定（此处不抛错，正文照常交付）。
  }

  const toolCalls = [];
  for (const slot of blocks.values()) {
    if (slot.type !== "tool_use" || !slot.name) continue;
    const input = parseToolCallArguments(slot.json || "{}") ?? {};
    toolCalls.push({
      type: "tool_call",
      id: slot.id,
      tool: slot.name,
      input,
      arguments_complete: sawMessageStop && stopReason !== "max_tokens"
    });
  }

  return {
    text,
    reasoning: reasoningText,
    toolCalls,
    raw: {
      stream: true,
      event_count: eventCount,
      stop_reason: stopReason,
      ...(sawMessageStop ? {} : { stream_terminated_by_eof: true })
    },
    usage: normalizeOpenAIUsage(usage),
    cost: null
  };
}

// 解析单个 SSE 事件块（event: 名 + data: JSON；Anthropic 每块一个事件）。
function parseSseEvent(chunk) {
  let eventName = null;
  const dataLines = [];
  for (const line of chunk.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("event:")) eventName = trimmed.slice(6).trim();
    else if (trimmed.startsWith("data:")) dataLines.push(trimmed.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try {
    return { event: eventName, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return { event: eventName, data: { type: "malformed" } };
  }
}
