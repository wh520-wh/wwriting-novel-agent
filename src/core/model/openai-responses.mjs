// src/core/model/openai-responses.mjs
//
// OpenAI Responses 协议生产 adapter（round22 D5）。
//
// 与 openai-compatible.mjs 同一契约：new Adapter({baseUrl, apiKey, apiKeyEnv,
// fetchImpl}).complete(request, { signal }) -> { text, reasoning, toolCalls,
// raw, usage, cost }。只处理 HTTP transport 与响应归一化；不添加 system message、
// 不修改传入 messages。
//
// 映射口径（D5/D6）：
//   - POST {baseUrl}/responses，Bearer 鉴权。
//   - OpenAI 形状 messages → input 项：system/user/assistant 文本消息按角色映射；
//     assistant 的 tool_calls 映射 {type:"function_call", call_id, name, arguments}；
//     工具结果（role:"tool"）映射 {type:"function_call_output", call_id, output}。
//   - 工具定义映射 {type:"function", name, description, parameters}（扁平形状）。
//   - max_output_tokens / temperature / top_p / stream 送原生字段（有值才带）。
//   - 非流式从 output 数组提取 message.output_text / reasoning / function_call；
//     流式处理 response.output_text.delta、response.function_call_arguments.delta、
//     response.output_item.done、response.completed——终止前缺完整 function_call
//     参数报截断。
//   - usage 的 input_tokens/output_tokens 回网关统一格式。取消透传 AbortError；
//     HTTP 错误复用 ProviderTransportError 分类与脱敏。

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

export function createOpenAIResponsesAdapter(options = {}) {
  return new OpenAIResponsesAdapter(options);
}

export class OpenAIResponsesAdapter {
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
      throw new ProviderConfigurationError("OpenAI Responses provider requires base_url.");
    }
    const fetchImpl = this.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new ProviderConfigurationError("OpenAI Responses provider requires fetch implementation.");
    }
    const selectedModel = modelConfig.model_name ?? request.model ?? null;
    if (!selectedModel) {
      throw new ProviderConfigurationError("OpenAI Responses provider requires model_name.");
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

    let response;
    try {
      response = await fetchImpl(`${ensureTrailingSlash(baseUrl)}responses`, {
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
      if (error?.name === "AbortError") {
        throw error;
      }
      throw new ProviderTransportError(
        `OpenAI Responses provider fetch failed: ${error?.message ?? String(error)}`,
        { reason: "network", cause: error }
      );
    }
    if (!response.ok) {
      const errorText = await response.text();
      throw new ProviderTransportError(`OpenAI Responses provider returned HTTP ${response.status}.`, {
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
      throw new ProviderTransportError(`OpenAI Responses provider returned Invalid JSON: ${error.message}`, {
        status: response.status,
        body: responseText.slice(0, 2000)
      });
    }
    return normalizeCompletion(raw);
  }
}

function buildRequestBody(request, modelConfig, { caps, tools, stream }) {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const body = {
    model: modelConfig.model_name ?? request.model,
    input: mapInput(messages),
    ...(Number.isFinite(modelConfig.max_output_tokens) || Number.isFinite(modelConfig.max_tokens)
      ? { max_output_tokens: modelConfig.max_output_tokens ?? modelConfig.max_tokens }
      : {}),
    ...(caps.supportsTemperature && Number.isFinite(modelConfig.temperature) ? { temperature: modelConfig.temperature } : {}),
    ...(caps.supportsTopP && Number.isFinite(modelConfig.top_p) ? { top_p: modelConfig.top_p } : {})
  };
  if (tools) {
    body.tools = tools.map((tool) => {
      const fn = tool?.function ?? tool;
      // 兼容两种来源：OpenAI chat 形状 {type:"function", function:{...}} 与
      // Responses 原生扁平 {type:"function", name, ...}。
      return {
        type: "function",
        name: fn?.name,
        description: fn?.description ?? "",
        parameters: fn?.parameters ?? { type: "object", properties: {} }
      };
    });
    if (request.toolChoice === "auto") body.tool_choice = "auto";
  }
  if (stream) body.stream = true;
  return body;
}

// OpenAI chat 形状 → Responses input 项序列。
export function mapInput(messages) {
  const out = [];
  for (const message of messages) {
    if (!message) continue;
    const text = typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).filter(Boolean).join("")
        : "";
    if (message.role === "tool") {
      out.push({
        type: "function_call_output",
        call_id: message.tool_call_id ?? null,
        output: text
      });
      continue;
    }
    if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      if (text) out.push({ role: "assistant", content: text });
      for (const toolCall of message.tool_calls) {
        out.push({
          type: "function_call",
          call_id: toolCall.id ?? null,
          name: toolCall.tool ?? toolCall.function?.name ?? null,
          arguments: typeof toolCall.input === "object" && toolCall.input !== null
            ? JSON.stringify(toolCall.input)
            : String(toolCall.function?.arguments ?? "{}")
        });
      }
      continue;
    }
    if (message.role === "system" || message.role === "user" || message.role === "assistant") {
      out.push({ role: message.role, content: text });
    }
  }
  return out;
}

// 非流式：output 数组 → text / reasoning / toolCalls。
function normalizeCompletion(raw) {
  const output = Array.isArray(raw?.output) ? raw.output : [];
  const textParts = [];
  const reasoningParts = [];
  const toolCalls = [];
  const collect = (items) => {
    for (const item of items) {
      if (item?.type === "message" && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part?.type === "output_text" && part.text) textParts.push(part.text);
        }
      } else if (item?.type === "reasoning") {
        const summary = Array.isArray(item.summary) ? item.summary : [];
        for (const part of summary) {
          if (part?.type === "summary_text" && part.text) reasoningParts.push(part.text);
        }
        if (typeof item.content === "string") reasoningParts.push(item.content);
      } else if (item?.type === "function_call") {
        toolCalls.push({
          type: "tool_call",
          id: item.id ?? item.call_id ?? null,
          tool: item.name ?? null,
          input: parseToolCallArguments(item.arguments),
          arguments_complete: true
        });
      }
    }
  };
  collect(output);
  return {
    text: textParts.join("") || (typeof raw.output_text === "string" ? raw.output_text : ""),
    reasoning: reasoningParts.join(""),
    toolCalls,
    raw,
    usage: normalizeOpenAIUsage(raw.usage ?? {}),
    cost: null
  };
}

// ---------------------------------------------------------------------------
// 流式（SSE）：response.output_text.delta / response.function_call_arguments.delta
// / response.output_item.done / response.completed。function_call 参数在收到
// response.completed 前一律不算完整；缺 completed 报传输截断。
// ---------------------------------------------------------------------------

async function readStream(responseBody, metadata) {
  if (!responseBody || typeof responseBody.getReader !== "function") {
    throw new ProviderTransportError("OpenAI Responses stream 缺少 ReadableStream body.", { reason: "network" });
  }
  const reader = responseBody.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let reasoningText = "";
  let usage = {};
  let sawCompleted = false;
  let eventCount = 0;
  // item_id -> { id, name, arguments, done }：function_call 参数增量累积
  const callItems = new Map();
  const completedItems = [];

  const handleEvent = (data) => {
    eventCount += 1;
    const type = data.type ?? "";
    if (type === "response.output_text.delta") {
      if (data.delta) {
        text += data.delta;
        metadata.onToken?.(data.delta, data);
        metadata.onActivity?.(data.delta);
      }
      return;
    }
    if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
      if (data.delta) {
        reasoningText += data.delta;
        metadata.onReasoningToken?.(data.delta, data);
        metadata.onActivity?.(data.delta);
      }
      return;
    }
    if (type === "response.function_call_arguments.delta") {
      const slot = callItems.get(data.item_id) ?? { id: null, name: null, arguments: "", done: false };
      slot.arguments += data.delta ?? "";
      callItems.set(data.item_id, slot);
      metadata.onActivity?.("");
      return;
    }
    if (type === "response.output_item.done") {
      const item = data.item ?? {};
      if (item.type === "function_call") {
        const slot = callItems.get(item.id) ?? { id: null, name: null, arguments: "", done: false };
        callItems.set(item.id, {
          id: item.id ?? item.call_id ?? slot.id,
          name: item.name ?? slot.name,
          arguments: item.arguments ?? slot.arguments,
          done: true
        });
        completedItems.push(item);
      }
      metadata.onActivity?.("");
      return;
    }
    if (type === "response.completed") {
      sawCompleted = true;
      if (data.response?.usage) usage = data.response.usage;
      metadata.onActivity?.("");
      return;
    }
    if (type === "response.failed" || type === "error") {
      const message = data.response?.error?.message ?? data.error?.message ?? data.error?.code ?? "unknown";
      throw new ProviderTransportError(`OpenAI Responses stream error: ${message}`, {
        reason: "network",
        body: JSON.stringify(data).slice(0, 2000)
      });
    }
    metadata.onActivity?.("");
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/(?:\r?\n){2,}/);
    buffer = parts.pop();
    for (const part of parts) {
      const data = parseSseData(part);
      if (data) handleEvent(data);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    const data = parseSseData(buffer);
    if (data) handleEvent(data);
  }

  if (eventCount > 0 && !sawCompleted) {
    throw new ProviderTransportError(
      "OpenAI Responses stream ended without response.completed — possible truncation.",
      { reason: "network", body: JSON.stringify({ truncatedContentLength: text.length + reasoningText.length, events: eventCount }) }
    );
  }

  const toolCalls = [];
  const collectCall = ({ id, name, arguments: args, done }) => {
    if (!name) return;
    const input = parseToolCallArguments(args || "{}");
    toolCalls.push({
      type: "tool_call",
      id: id ?? null,
      tool: name,
      input: input ?? {},
      arguments_complete: done && sawCompleted && input != null
    });
  };
  for (const slot of callItems.values()) collectCall(slot);
  // completed 事件的 response.output 是权威清单：流里未见过的 item（如跳帧）从
  // 这里补齐；已收集的按 id 去重。
  const seenIds = new Set(toolCalls.map((c) => c.id));
  for (const item of Array.isArray(completedItems) ? completedItems : []) {
    if (seenIds.has(item.id ?? item.call_id)) continue;
    collectCall({ id: item.id ?? item.call_id, name: item.name, arguments: item.arguments ?? "", done: true });
  }

  return {
    text,
    reasoning: reasoningText,
    toolCalls,
    raw: {
      stream: true,
      event_count: eventCount,
      ...(sawCompleted ? {} : { stream_terminated_by_eof: true })
    },
    usage: normalizeOpenAIUsage(usage),
    cost: null
  };
}

// 解析单个 SSE 事件块的 data: JSON（Responses 流每块一条 data，event 名在 data.type）。
function parseSseData(chunk) {
  const dataLines = [];
  for (const line of chunk.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("data:")) dataLines.push(trimmed.slice(5).trim());
  }
  if (dataLines.length === 0 || dataLines[0] === "[DONE]") return null;
  try {
    return JSON.parse(dataLines.join("\n"));
  } catch {
    return null;
  }
}
