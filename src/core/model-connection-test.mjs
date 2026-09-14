// 模型连接测试（统一 Agent 内核计划 Task 9 cutover）。
//
// 只做最小只读连接探测，不写项目文件、不创建 Run、不追加模型 transcript：
// 通过新 ModelGateway + OpenAI-compatible adapter（model/openai-compatible.mjs）
// 发送一次最小请求。错误分类与脱敏语义保持旧行为。
import {
  ModelConfigValidationError,
  validateModelConfig,
} from "./model-config-validation.mjs";
import { createModelGateway } from "./model/gateway.mjs";
import { OpenAICompatibleAdapter } from "./model/openai-compatible.mjs";

// 探测常量（Task 7）：思考型模型（如 deepseek-reasoner）把 token 额度全花在
// reasoning_content 上、正文 content 为空，且思考期可能 >10s 无首 token——
// 4 token / 10s 对这类模型必然误判失败。64 token 足够「仅回复 OK」的非思考模型
// 与思考模型的最小思考段；30s 覆盖常见 thinking 模型的思考期。
const PROBE_TIMEOUT_MS = 30_000;
const PROBE_PROMPT = "仅回复 OK";
const PROBE_MAX_TOKENS = 64;
const PROBE_MAX_ATTEMPTS = 2;
const PROBE_RETRY_DELAY_MS = 2000;
const NETWORK_ERROR_CODES = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNRESET",
  "ETIMEDOUT",
]);

export async function testModelConnection({
  config: rawConfig,
  secrets = {},
  signal,
  now = Date.now,
  complete = completeOpenAICompatibleProbe,
  // Task 11：探测超时可注入（默认 30s 语义不变），测试用传小值触发内部超时路径。
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  let config;
  try {
    config = validateModelConfig(rawConfig);
  } catch (error) {
    if (error instanceof ModelConfigValidationError) {
      return {
        ok: false,
        code: "configuration_missing",
        message: error.message,
        provider: String(rawConfig?.provider ?? "").trim(),
        model_name: String(rawConfig?.model_name ?? "").trim(),
        fields: error.fields,
      };
    }
    throw error;
  }

  const apiKey = readSecret(secrets, config.api_key_env);
  if (!apiKey) {
    return {
      ok: false,
      code: "configuration_missing",
      message: "请先在 Windows 环境变量中配置 API Key",
      provider: config.provider,
      model_name: config.model_name,
    };
  }

  const timeoutController = new AbortController();
  // Task 11/B6：内部探测超时与调用方取消必须可区分。先置位 timedOut 再 abort——
  // 合并信号的中止会以 AbortError 形态击穿传输层（网关把「外部信号已中止」转成
  // AbortError），若 isCallerAbort 按 error.name 判断，超时会被误分类为调用方
  // 取消（HTTP 层落成 499）。分类只看 timedOut 标志与 timeoutSignal.aborted。
  let timedOut = false;
  const timeoutHandle = setTimeout(
    () => {
      timedOut = true;
      timeoutController.abort(new DOMException("probe timeout", "TimeoutError"));
    },
    timeoutMs,
  );

  const combinedSignal = mergeSignals(signal, timeoutController.signal);

  const start = now();
  try {
    await runWithRetry(
      () => complete({
        config,
        apiKey,
        messages: [{ role: "user", content: PROBE_PROMPT }],
        maxTokens: PROBE_MAX_TOKENS,
        timeoutMs,
        signal: combinedSignal,
      }),
      {
        maxAttempts: PROBE_MAX_ATTEMPTS,
        retryDelayMs: PROBE_RETRY_DELAY_MS,
        signal: combinedSignal,
      },
    );
    const latency_ms = Math.max(0, now() - start);
    return {
      ok: true,
      provider: config.provider,
      model_name: config.model_name,
      latency_ms,
    };
  } catch (error) {
    if (isCallerAbort(error, signal)) {
      throw error;
    }
    const latency_ms = Math.max(0, now() - start);
    const code = classifyError(error, { timeoutSignal: timeoutController.signal, timedOut });
    return {
      ok: false,
      code,
      message: redactSecrets(
        buildErrorMessage(error, code),
        collectSecrets(secrets, apiKey),
      ),
      provider: config.provider,
      model_name: config.model_name,
      latency_ms,
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// 最小连接请求：经 ModelGateway 走新 OpenAI-compatible adapter（Task 9）。
// gateway 只做单次调用（retryMax 0）——探测自身的 runWithRetry 负责重试，
// 避免双重退避；per-attempt 超时按探测 timeoutMs（默认 30s）配置。
export async function completeOpenAICompatibleProbe({
  config,
  apiKey,
  messages,
  maxTokens,
  signal,
  timeoutMs = PROBE_TIMEOUT_MS,
}) {
  // 名字原样发送（ADR 0004：尾标机制已淘汰，无需剥离）。
  const gateway = createModelGateway({
    adapter: new OpenAICompatibleAdapter({
      baseUrl: config.base_url,
      apiKey,
      apiKeyEnv: config.api_key_env,
    }),
    retryMax: 0,
    timeoutMs,
    totalDeadlineMs: timeoutMs,
    heartbeatMs: 0,
  });

  const response = await gateway.complete(
    {
      messages,
      stream: false,
      modelConfig: {
        model_name: config.model_name,
        base_url: config.base_url,
        api_key: apiKey,
        api_key_env: config.api_key_env,
        max_tokens: maxTokens,
        max_output_tokens: maxTokens,
        timeout_ms: timeoutMs,
      },
    },
    { signal },
  );
  // Task 7：响应成功判定放宽——正文非空**或** reasoning 非空都算成功。
  // 思考型模型（deepseek-reasoner 等）在 max_tokens 很小时会把额度全花在
  // reasoning_content 上、正文 content 为空，旧判定（只看 text）会把这种
  // 正常响应误判成 response_incompatible（「模型返回的响应无法解析」）。
  if (!response) {
    const error = new Error("模型返回了空响应，无法解析。");
    error.code = "response_incompatible";
    error.raw = null;
    throw error;
  }
  const hasText = typeof response.text === "string" && response.text.trim().length > 0;
  const hasReasoning = typeof response.reasoning === "string" && response.reasoning.trim().length > 0;
  if (!hasText && !hasReasoning) {
    // 失败诊断（借鉴 Claude Code「明确告知」模式）：给出可操作方向 + raw 摘要，
    // 让用户知道问题在模型行为还是配置，而不是一句笼统的「无法解析」。
    const rawSummary = summarizeResponseForDiagnostics(response.raw);
    const message = rawSummary
      ? `模型返回了响应，但正文与思考内容均为空，无法解析。可能原因：模型为思考型且思考未落正文、输出额度过小、或代理返回空 body。返回摘要：${rawSummary}`
      : "模型返回了空响应，无法解析。";
    const error = new Error(message);
    error.code = "response_incompatible";
    error.raw = response?.raw ?? null;
    throw error;
  }
  return response;
}

/**
 * Run an async probe function with retry on transport-level errors.
 * Uses the same error classification as the main retry chain.
 */
async function runWithRetry(fn, { maxAttempts = 1, retryDelayMs = 2000, signal } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      // Abortable wait before retry
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, retryDelayMs);
        if (signal) {
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("The operation was aborted.", "AbortError"));
          }, { once: true });
        }
      });
    }

    try {
      return await fn();
    } catch (error) {
      lastError = error;
      // 此处的 signal 是合并信号：外部调用方或内部超时任一中止都停止重试（区别于
      // 外层仅按外部 signal 判断「调用方取消」的语义）。
      if (isCallerAbort(error, signal)) {
        throw error;
      }
      // Retry only on transport-level errors (same classification as ModelGateway)
      const isTransportError =
        error.code === "provider_transport_error" &&
        (error.reason === "server-retryable" || error.reason === "timeout" || error.reason === "network");
      if (!isTransportError) {
        throw error;
      }
      // Last attempt exhausted — throw
      if (attempt >= maxAttempts - 1) {
        throw error;
      }
    }
  }
  // Should not reach here, but satisfy type-safety
  throw lastError ?? new Error("Probe failed for unknown reason");
}

function summarizeResponseForDiagnostics(raw) {
  if (!raw || typeof raw !== "object") return "";
  try {
    const firstChoice = raw.choices?.[0];
    if (firstChoice) {
      const keys = Object.keys(firstChoice?.message ?? {});
      return `choices[0].message 字段: ${keys.join(", ") || "(empty)"}`;
    }
    const keys = Object.keys(raw).slice(0, 8);
    return `响应顶层字段: ${keys.join(", ") || "(empty)"}`;
  } catch {
    return "";
  }
}

function readSecret(secrets, envName) {
  if (!secrets || typeof secrets !== "object") return null;
  const value = secrets[envName];
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

function mergeSignals(...signals) {
  const present = signals.filter((value) => value instanceof AbortSignal);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(present);
  }
  const controller = new AbortController();
  for (const signal of present) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener(
      "abort",
      () => controller.abort(signal.reason),
      { once: true },
    );
  }
  return controller.signal;
}

function isCallerAbort(error, callerSignal) {
  // Task 11/B6：只有「外部调用方传入的 signal 已中止」才算调用方取消。内部探测
  // 超时同样会中止合并信号、让传输层抛 AbortError 形态的错误——若这里按
  // error.name === "AbortError" 判断，超时会被误判成调用方取消，HTTP 层落成 499
  // client_closed_request。error 参数保留签名，供未来需要区分具体错误形态时扩展。
  return callerSignal?.aborted === true;
}

function classifyError(error, { timeoutSignal, timedOut }) {
  if (!error) return "provider_error";

  // B6：探测级超时（定时器已中止合并信号）→ request_timeout。
  if (timedOut || timeoutSignal?.aborted) {
    return "request_timeout";
  }

  const status = pickStatus(error);
  if (status === 401 || status === 403) {
    return "authentication_failed";
  }
  if (status === 404) {
    return "model_not_found";
  }

  const code = error.code;
  if (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) {
    return "network_unreachable";
  }

  // B6：网关 attempt 看门狗空闲超时抛 ProviderTransportError(reason="timeout")
  //（探测级定时器未必先到）——reason 命中同样分类为 request_timeout。
  if (
    error.name === "TimeoutError" ||
    error.reason === "timeout" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT"
  ) {
    return "request_timeout";
  }

  if (
    code === "response_incompatible" ||
    code === "invalid_json" ||
    error.name === "SyntaxError"
  ) {
    return "response_incompatible";
  }

  if (status === 429 || (typeof status === "number" && status >= 500)) {
    return "provider_error";
  }

  return "provider_error";
}

function pickStatus(error) {
  if (typeof error?.status === "number") return error.status;
  if (typeof error?.statusCode === "number") return error.statusCode;
  const raw = error?.details?.status ?? error?.body?.status;
  if (typeof raw === "number") return raw;
  return null;
}

function buildErrorMessage(error, code) {
  const baseRaw = typeof error?.message === "string" ? error.message : String(error ?? "");
  switch (code) {
    case "authentication_failed":
      return "API Key 无效或无权限";
    case "model_not_found":
      return "模型名称不存在或与该账号不匹配";
    case "network_unreachable":
      return "无法连接到模型服务器，请检查网络或接口地址";
    case "request_timeout":
      return "模型服务器响应超时（30 秒）";
    case "response_incompatible":
      // 直接保留底层诊断（探测抛出的错误已带可操作方向 + raw 摘要），不再加
      // 前缀——底层消息已含「无法解析」，叠加会造成措辞重复。
      return baseRaw || "模型返回的响应无法解析";
    case "provider_error":
    default:
      return `模型服务器返回错误：${baseRaw || "未知错误"}`;
  }
}

function collectSecrets(secrets, apiKey) {
  const values = [];
  if (secrets && typeof secrets === "object") {
    for (const value of Object.values(secrets)) {
      if (typeof value === "string" && value.length > 0) values.push(value);
    }
  }
  if (typeof apiKey === "string" && apiKey.length > 0) values.push(apiKey);
  return values;
}

function redactSecrets(value, secrets) {
  let text = String(value ?? "");
  for (const secret of secrets.filter(Boolean)) {
    text = text.replaceAll(secret, "[REDACTED]");
  }
  text = text.replace(/(authorization\s*[:=]\s*"?bearer\s+)[^\s"']+/gi, "$1[REDACTED]");
  text = text.replace(/([\"'](?:api[_-]?key|token|authorization)[\"']\s*:\s*\")[^\"']+(\")/gi, "$1[REDACTED]$2");
  text = text.replace(/([?&](?:key|api[_-]?key|token)=)[^&\s]+/gi, "$1[REDACTED]");
  return text;
}
