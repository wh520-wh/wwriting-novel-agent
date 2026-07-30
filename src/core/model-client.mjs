import { CostTracker } from "./cost-tracker.mjs";
import { resolveRuntimeConfig } from "./config-runtime.mjs";
import { normalizeUsageReport } from "./usage-report.mjs";
import { ProviderTransportError } from "./provider-adapters.mjs";
import { isCancellationError } from "./cancellation.mjs";

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
    onRetry = null,
    onActivity = null
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
    this.onRetry = onRetry;
    this.onActivity = onActivity;
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

    const modelConfig = this.resolveModelConfig(project, stage);
    const adapter = this.adapters[modelConfig.provider];
    if (!adapter) {
      throw new Error(`No provider adapter configured for ${modelConfig.provider}`);
    }

    // Stage-aware per-attempt timeout: stage override > constructor default
    const attemptTimeoutMs = modelConfig.timeout_ms ?? this.timeoutMs;

    const startTime = Date.now();

    for (let attempt = 0; attempt <= this.retryMax; attempt++) {
      // Check total deadline before starting the attempt
      const elapsed = Date.now() - startTime;
      if (elapsed >= this.totalDeadlineMs) {
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

        clearTimeout(timer);
        timeoutController.signal.removeEventListener("abort", onTimeout);

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
        clearTimeout(timer);
        timeoutController.signal.removeEventListener("abort", onTimeout);

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

        // User abort — don't retry
        if (signal?.aborted && !timedOut) {
          throw new DOMException("The operation was aborted.", "AbortError");
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
