import {
  ModelConfigValidationError,
  validateModelConfig,
} from "./model-config-validation.mjs";
import { OpenAICompatibleAdapter } from "./provider-adapters.mjs";

const PROBE_TIMEOUT_MS = 10_000;
const PROBE_PROMPT = "仅回复 OK";
const PROBE_MAX_TOKENS = 4;
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
  const timeoutHandle = setTimeout(
    () => timeoutController.abort(new DOMException("probe timeout", "TimeoutError")),
    PROBE_TIMEOUT_MS,
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
        timeoutMs: PROBE_TIMEOUT_MS,
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
    const code = classifyError(error, { timeoutSignal: timeoutController.signal });
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

export async function completeOpenAICompatibleProbe({
  config,
  apiKey,
  messages,
  maxTokens,
  signal,
}) {
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: config.base_url,
    apiKey,
    apiKeyEnv: config.api_key_env,
  });

  const response = await adapter.generate({
    model: config.model_name,
    modelConfig: {
      model_name: config.model_name,
      base_url: config.base_url,
      api_key: apiKey,
      api_key_env: config.api_key_env,
      max_tokens: maxTokens,
      max_output_tokens: maxTokens,
      stream: false,
    },
    messages,
    signal,
  });
  if (!response || typeof response.text !== "string" || !response.text.trim()) {
    const rawSummary = summarizeResponseForDiagnostics(response?.raw);
    const message = rawSummary
      ? `模型返回了 200，但内容为空或无法解析。返回摘要：${rawSummary}`
      : "Provider returned empty or unparseable response";
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
      if (isCallerAbort(error, signal)) {
        throw error;
      }
      // Retry only on transport-level errors (same classification as ModelClient)
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
  if (callerSignal?.aborted) return true;
  if (error && error.name === "AbortError") {
    return true;
  }
  if (
    error instanceof DOMException &&
    (error.name === "AbortError" || error.code === DOMException.ABORT_ERR)
  ) {
    return true;
  }
  return false;
}

function classifyError(error, { timeoutSignal }) {
  if (!error) return "provider_error";

  if (timeoutSignal?.aborted) {
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

  if (error.name === "TimeoutError" || code === "ETIMEDOUT" || code === "UND_ERR_HEADERS_TIMEOUT") {
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
      return "模型服务器响应超时（10 秒）";
    case "response_incompatible":
      return "模型返回的响应无法解析";
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
