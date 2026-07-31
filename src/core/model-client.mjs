import { CostTracker } from "./cost-tracker.mjs";
import { resolveRuntimeConfig } from "./config-runtime.mjs";
import { normalizeUsageReport } from "./usage-report.mjs";
import { sha256 } from "./fs-utils.mjs";
import { isReasonerModel, ProviderTransportError } from "./provider-adapters.mjs";
import { isCancellationError } from "./cancellation.mjs";

// L3 收窄版确定性响应缓存（仅辅助调用重试去重）：
// - 缓存条件：metadata 带 memoryExtract/factCheck 标记（辅助调用）+ 无工具请求 + 非流式
//   + 显式 temperature=0（reasoner 系模型不支持 temperature，按 isReasonerModel 区分，
//   不注入也就不缓存——确定性前提不成立）。
// - 重试豁免：metadata.attempt > 0 时既不查也不写缓存（计划语义：重试预期新调用）。
// - 命中语义：不调 adapter、不 record 费用，usage 归零返回（同 CodeWhale llm_response_cache）。
// - 容量：进程内 Map LRU，默认 256 条。
const DEFAULT_RESPONSE_CACHE_SIZE = 256;
// 缓存 key 里 metadata 的稳定子集（attempt 每次流程级重试都不同，必须排除；
// onActivity 是函数不可序列化，同样排除）。
const AUXILIARY_METADATA_KEY_FIELDS = ["memoryExtract", "factCheck", "chapterNo"];

export class ModelClient {
  constructor({
    adapters = {},
    activeModel = null,
    stageOverrides = {},
    costTracker = new CostTracker(),
    retryMax = 3,
    retryBaseDelayMs = 1000,
    retryMaxDelayMs = 16000,
    timeoutMs = 120000,
    totalDeadlineMs = 300000,
    heartbeatMs = 5000,
    onRetry = null,
    onActivity = null,
    responseCacheSize = DEFAULT_RESPONSE_CACHE_SIZE
  } = {}) {
    this.adapters = adapters;
    this.activeModel = activeModel;
    this.stageOverrides = stageOverrides;
    this.costTracker = costTracker;
    this.retryMax = retryMax;
    this.retryBaseDelayMs = retryBaseDelayMs;
    this.retryMaxDelayMs = retryMaxDelayMs;
    this.timeoutMs = timeoutMs;
    this.totalDeadlineMs = totalDeadlineMs;
    this.heartbeatMs = heartbeatMs;
    this.onRetry = onRetry;
    this.onActivity = onActivity;
    this.responseCache = new Map();
    this.responseCacheSize = responseCacheSize;
  }

  resolveModelConfig(project = {}, stage = "drafting") {
    const effectiveConfig = resolveRuntimeConfig(project, {
      globalConfig: {
        active_model: this.activeModel ?? {
          provider: "mock",
          model_name: "mock-writer"
        },
        stage_overrides: this.stageOverrides ?? {}
      }
    });
    const activeModel = effectiveConfig.active_model;
    const stageOverrides = effectiveConfig.stage_overrides ?? {};
    const stageOverride = stageOverrides[stage];
    if (stageOverride && stageOverride.enabled === true) {
      return {
        ...activeModel,
        ...stageOverride,
        stage_override_enabled: true
      };
    }
    return {
      ...activeModel,
      stage_override_enabled: false
    };
  }

  async generate({ project = {}, stage = "drafting", prompt = "", messages = [], metadata = {}, signal = undefined } = {}) {
    // If external signal is already aborted, throw immediately
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }

    const resolvedModelConfig = this.resolveModelConfig(project, stage);
    const adapter = this.adapters[resolvedModelConfig.provider];
    if (!adapter) {
      throw new Error(`No provider adapter configured for ${resolvedModelConfig.provider}`);
    }

    // L3 辅助调用确定性响应缓存：
    // 1) 资格满足时对非 reasoner 模型显式注入 temperature=0（缓存确定性前提）；
    // 2) 命中直接返回缓存响应（usage 归零、不调 adapter、不 record 费用）；
    // 3) metadata.attempt > 0 的流程级重试不查缓存。
    const { modelConfig, cacheKey } = this.#prepareAuxiliaryCache({
      modelConfig: resolvedModelConfig, stage, prompt, messages, metadata
    });
    if (cacheKey) {
      const cached = this.#responseCacheGet(cacheKey);
      if (cached) {
        const usageReport = normalizeUsageReport({
          provider: modelConfig.provider,
          model: modelConfig.model_name,
          usage: {},
          rawUsage: {},
          cost: null
        });
        return {
          text: cached.text,
          raw: cached.raw,
          usageReport,
          costSummary: this.costTracker.getSummary(),
          modelConfig
        };
      }
    }

    // Stage-aware per-attempt timeout: stage override > constructor default
    const attemptTimeoutMs = modelConfig.timeout_ms ?? this.timeoutMs;

    const startTime = Date.now();
    // §4.2.2: Stage-configurable total deadline — modelConfig.total_deadline_ms overrides constructor default
    const totalDeadlineMs = modelConfig.total_deadline_ms ?? this.totalDeadlineMs;

    for (let attempt = 0; attempt <= this.retryMax; attempt++) {
      // Check total deadline before starting the attempt
      const elapsed = Date.now() - startTime;
      if (elapsed >= totalDeadlineMs) {
        // Total deadline exceeded — throw immediately, do not retry.
        // Retrying on deadline would waste one backoff delay for a guaranteed timeout.
        throw new ProviderTransportError("Request exceeded total deadline.", { reason: "timeout" });
      }

      // Create a timeout controller for this attempt
      const timeoutController = new AbortController();
      let timedOut = false;
      const onTimeout = () => { timedOut = true; };
      timeoutController.signal.addEventListener("abort", onTimeout, { once: true });

      // Combine external signal with timeout signal
      const signals = [timeoutController.signal];
      if (signal) {
        signals.push(signal);
      }
      const combinedSignal = AbortSignal.any(signals);

      // Start the timeout timer
      const timer = setTimeout(() => timeoutController.abort(), attemptTimeoutMs);

      // Non-streaming heartbeat: while the attempt is pending, periodically ping
      // onActivity so UI can show the request is alive (0 disables; null is a valid no-op).
      const heartbeat = this.onActivity && this.heartbeatMs > 0
        ? setInterval(() => { this.onActivity?.(); }, this.heartbeatMs)
        : null;

      // Both success and failure paths must release timer + heartbeat + abort listener.
      const cleanupAttempt = () => {
        clearTimeout(timer);
        clearInterval(heartbeat);
        timeoutController.signal.removeEventListener("abort", onTimeout);
      };

      // Pass onActivity through metadata so streaming adapters can call it on each SSE chunk
      const metadataWithActivity = this.onActivity
        ? { ...metadata, onActivity: this.onActivity }
        : metadata;

      try {
        const response = await adapter.generate({
          model: modelConfig.model_name,
          modelConfig,
          prompt,
          messages,
          stage,
          metadata: metadataWithActivity,
          signal: combinedSignal
        });

        cleanupAttempt();

        // L3：成功的确定性辅助请求写入缓存（仅成功响应可缓存——失败的响应会污染缓存）
        if (cacheKey) {
          this.#responseCachePut(cacheKey, {
            text: response.text ?? "",
            raw: response.raw ?? response
          });
        }

        const usageReport = normalizeUsageReport({
          provider: modelConfig.provider,
          model: modelConfig.model_name,
          usage: response.usage ?? {},
          rawUsage: response.usage ?? {},
          cost: response.cost ?? null
        });
        const costSummary = this.costTracker.record({ stage, chapter: metadata.chapterNo ?? null, usageReport });
        return {
          text: response.text ?? "",
          raw: response.raw ?? response,
          usageReport,
          costSummary,
          modelConfig
        };
      } catch (error) {
        cleanupAttempt();

        // External cancellation always wins over timeout — never retry.
        if (signal?.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }

        // External cancellation — never retry; rethrow the original AbortError.
        if (!timedOut && isCancellationError(error, signal)) {
          // Record failed attempt before rethrowing (cancellation still consumed a call)
          const usageFromError = error.usage ?? {};
          if (usageFromError && Object.keys(usageFromError).length > 0) {
            this.costTracker.record({
              stage, chapter: metadata.chapterNo ?? null,
              usageReport: { ...normalizeUsageReport({
                provider: modelConfig.provider, model: modelConfig.model_name,
                usage: usageFromError, rawUsage: usageFromError, cost: null
              }), failed: true }
            });
          } else {
            this.costTracker.record({
              stage, chapter: metadata.chapterNo ?? null,
              usageReport: { provider: modelConfig.provider, model: modelConfig.model_name,
                inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0,
                estimatedCost: 0, failed: true
              }
            });
          }
          throw error;
        }

        // Timeout — wrap as ProviderTransportError
        if (timedOut) {
          const timeoutError = new ProviderTransportError("Request timed out.", { reason: "timeout" });
          if (this.#isRetryable(timeoutError) && attempt < this.retryMax) {
            this.onActivity?.();
            await this.#retryWait(attempt, timeoutError, modelConfig.model_name, signal);
            continue;
          }
          // §3.5: Record failed attempt (timeout still consumed budget)
          this.costTracker.record({
            stage, chapter: metadata.chapterNo ?? null,
            usageReport: { provider: modelConfig.provider, model: modelConfig.model_name,
              inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0,
              estimatedCost: 0, failed: true
            }
          });
          throw timeoutError;
        }

        // Check if the error is retryable
        if (this.#isRetryable(error) && attempt < this.retryMax) {
          this.onActivity?.();
          await this.#retryWait(attempt, error, modelConfig.model_name, signal);
          continue;
        }

        // §3.5: On final non-retryable failure, record usage if provider returned any
        const usageFromError = error.usage ?? {};
        if (usageFromError && Object.keys(usageFromError).length > 0) {
          this.costTracker.record({
            stage, chapter: metadata.chapterNo ?? null,
            usageReport: { ...normalizeUsageReport({
              provider: modelConfig.provider, model: modelConfig.model_name,
              usage: usageFromError, rawUsage: usageFromError, cost: null
            }), failed: true }
          });
        } else {
          this.costTracker.record({
            stage, chapter: metadata.chapterNo ?? null,
            usageReport: { provider: modelConfig.provider, model: modelConfig.model_name,
              inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0,
              estimatedCost: 0, failed: true
            }
          });
        }

        throw error;
      }
    }
  }

  /**
   * L3 辅助调用缓存准备：返回 { modelConfig, cacheKey }。
   * - modelConfig：资格满足且非 reasoner 模型时注入 temperature=0（用户已显式配置则尊重用户值）；
   * - cacheKey：仅当「辅助标记 + 无工具 + 非流式 + 有效 temperature=0 + attempt=0」时非空。
   *   reasoner 系模型（isReasonerModel）不注入 temperature（不支持该参数），
   *   因缓存确定性建立在显式 temperature=0 上，reasoner 模型本轮不走缓存。
   */
  #prepareAuxiliaryCache({ modelConfig, stage, prompt, messages, metadata }) {
    const isAuxiliary = metadata?.memoryExtract === true || metadata?.factCheck === true;
    const isFlowRetry = Number(metadata?.attempt) > 0;
    const hasTools = Boolean(metadata?.toolRequest);
    const streaming = modelConfig?.stream === true;
    const eligible = isAuxiliary && !isFlowRetry && !hasTools && !streaming;
    if (!eligible) {
      return { modelConfig, cacheKey: null };
    }
    const effectiveConfig = modelConfig.temperature === undefined && !isReasonerModel(modelConfig)
      ? { ...modelConfig, temperature: 0 }
      : modelConfig;
    const cacheKey = effectiveConfig.temperature === 0
      ? this.#responseCacheKey({ modelConfig: effectiveConfig, stage, prompt, messages, metadata })
      : null;
    return { modelConfig: effectiveConfig, cacheKey };
  }

  #responseCacheKey({ modelConfig, stage, prompt, messages, metadata }) {
    const stableMetadata = {};
    for (const field of AUXILIARY_METADATA_KEY_FIELDS) {
      if (metadata?.[field] !== undefined) {
        stableMetadata[field] = metadata[field];
      }
    }
    const payload = {
      provider: modelConfig.provider,
      model: modelConfig.model_name,
      base_url: modelConfig.base_url,
      stage,
      temperature: modelConfig.temperature,
      top_p: modelConfig.top_p,
      max_tokens: modelConfig.max_output_tokens ?? modelConfig.max_tokens,
      extra_body: modelConfig.extra_body ?? null,
      prompt,
      messages,
      metadata: stableMetadata
    };
    return sha256(stableStringify(payload));
  }

  #responseCacheGet(key) {
    const entry = this.responseCache.get(key);
    if (entry === undefined) {
      return null;
    }
    // LRU 刷新：删除后重放，让最近命中的条目保持较新位置
    this.responseCache.delete(key);
    this.responseCache.set(key, entry);
    return entry;
  }

  #responseCachePut(key, entry) {
    if (this.responseCache.has(key)) {
      this.responseCache.delete(key);
    }
    if (this.responseCache.size >= this.responseCacheSize) {
      // Map 迭代序 = 插入序，第一个条目即最久未使用
      const oldestKey = this.responseCache.keys().next().value;
      this.responseCache.delete(oldestKey);
    }
    this.responseCache.set(key, entry);
  }

  #isRetryable(error) {
    return (
      error.code === "provider_transport_error" &&
      (error.reason === "server-retryable" || error.reason === "timeout" || error.reason === "network")
    );
  }

  async #retryWait(attempt, error, model, signal) {
    const backoff = this.retryBaseDelayMs * Math.pow(2, attempt);
    const jitter = Math.random() * 1000;
    const baseDelay = Math.min(backoff + jitter, this.retryMaxDelayMs);
    // Prefer Retry-After from server if present and larger than backoff
    const retryAfterMs = error?.retryAfterMs ?? null;
    const delay = retryAfterMs != null ? Math.max(retryAfterMs, baseDelay) : baseDelay;
    const reason = error.reason ?? "unknown";
    if (this.onRetry) {
      this.onRetry({
        attempt: attempt + 1,
        maxAttempts: this.retryMax,
        delay,
        error,
        reason,
        model
      });
    }
    await abortableDelay(delay, signal);
  }
}

// 确定性序列化：对象键按字典序排序，保证同一请求在不同构造顺序下 key 一致。
// 函数/undefined 显式抛错——静默跳过会产出错误缓存键（命中错响应），宁可炸在明处。
function stableStringify(value, seen = new Set()) {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "string") return JSON.stringify(value);
  if (type === "number") return Number.isFinite(value) ? String(value) : "null";
  if (type === "boolean") return String(value);
  if (type === "undefined" || type === "function") {
    throw new TypeError(`stableStringify 不支持的值: ${type}`);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("stableStringify 不支持循环引用");
    seen.add(value);
    const parts = value.map((item) => stableStringify(item, seen));
    seen.delete(value);
    return `[${parts.join(",")}]`;
  }
  if (type === "object") {
    if (seen.has(value)) throw new TypeError("stableStringify 不支持循环引用");
    seen.add(value);
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key], seen)}`);
    seen.delete(value);
    return `{${parts.join(",")}}`;
  }
  throw new TypeError(`stableStringify 不支持的类型: ${type}`);
}

function abortableDelay(delay, signal) {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onResolve = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    timer = setTimeout(onResolve, delay);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
