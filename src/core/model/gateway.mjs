// src/core/model/gateway.mjs
//
// 统一 ModelGateway（统一 Agent 内核计划 Task 3）。
//
// 深模块：retry（指数退避 + jitter + Retry-After）、per-attempt timeout、
// total deadline、非流式 heartbeat、usage 归一化、cost 记账与错误分类全部
// 集中在这里；HTTP/SSE transport 与响应归一化在 openai-compatible.mjs。
//
// 公共形状（Task 1 harness 冻结）：
//   const gateway = createModelGateway({ adapter, retryMax, timeoutMs, ... });
//   const result = await gateway.complete(request, { signal, retryMax });
//   result -> { text, reasoning, toolCalls, raw, usageReport, costSummary,
//               modelConfig, attempts, retried, cached }
//
// request 为装配完成的模型请求：{ messages, tools, toolChoice, modelConfig,
// stream, metadata }。gateway 不解析业务提示、不选择模型——模型与阶段配置由
// runtime（Task 6）解析后放入 modelConfig。
//
// 记账：每次成功调用 costTracker.record 一次；最终失败（含 timeout 耗尽）以
// failed: true 记账一次（错误携带 usage 时同样累计 token）；外部取消
//（signal 已中止）直接抛 AbortError 不记账（与旧 ModelClient 一致）；每次
// 重试 recordRetry 一次。确定性辅助调用的响应缓存命中不调 adapter、不记账、
// usage 归零返回（L3 行为迁移）。

import { CostTracker } from "../cost-tracker.mjs";
import { normalizeUsageReport } from "../usage-report.mjs";
import { sha256 } from "../fs-utils.mjs";
import { isCancellationError } from "../cancellation.mjs";
import { ProviderTransportError } from "./openai-compatible.mjs";
import { resolveModelCapabilities } from "./capabilities.mjs";

const DEFAULT_RESPONSE_CACHE_SIZE = 256;
// 缓存 key 里 metadata 的稳定子集（attempt 每次流程级重试都不同，必须排除；
// onActivity/onToken 是函数不可序列化，同样排除）。
const AUXILIARY_METADATA_KEY_FIELDS = ["cacheable", "chapterNo"];

export function createModelGateway({
  adapter = null,
  retryMax = 5,
  retryBaseDelayMs = 1000,
  retryMaxDelayMs = 16000,
  timeoutMs = 300000,
  // 单次 gateway.complete 默认总期限 6 小时（空闲超时以外的硬闸）；modelConfig.
  // total_deadline_ms 可逐请求覆盖。持续活动只刷新空闲时钟，不重置总期限。
  totalDeadlineMs = 21_600_000,
  heartbeatMs = 5000,
  onRetry = null,
  onRecovered = null,
  onActivity = null,
  costTracker = new CostTracker(),
  responseCacheSize = DEFAULT_RESPONSE_CACHE_SIZE,
  // 时间 seam（Task 2 同款约定：clock/setTimer/clearTimer）：测试注入假时钟与
  // 假定时器，期限行为不依赖真实等待。watchdog 与 heartbeat 都是周期性定时器，
  // 默认实现基于 setInterval/clearInterval。
  clock = Date.now,
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = (id) => clearInterval(id)
} = {}) {
  if (!adapter || typeof adapter.complete !== "function") {
    throw new TypeError("createModelGateway 需要提供带 complete(request, { signal }) 的 adapter");
  }

  const responseCache = new Map();

  async function complete(request, { signal = undefined, retryMax: requestRetryMax = retryMax } = {}) {
    if (request == null || typeof request !== "object") {
      throw new TypeError("gateway.complete 需要 request 对象");
    }
    if (!Number.isInteger(requestRetryMax) || requestRetryMax < 0) {
      throw new TypeError("gateway.complete retryMax 必须是非负整数");
    }
    const modelConfig = request.modelConfig ?? {};
    const provider = modelConfig.provider ?? "unknown";
    const model = modelConfig.model_name ?? request.model ?? "unknown";
    const metadata = request.metadata ?? {};
    const stage = metadata.stage ?? "unknown";
    const chapter = metadata.chapterNo ?? null;
    const tools = Array.isArray(request.tools) && request.tools.length > 0 ? request.tools : null;

    // 外部信号已中止 → 立即抛出，不进入 adapter
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }

    // 确定性辅助调用响应缓存：命中直接返回（usage 归零、不调 adapter、不记账）。
      const cacheKey = prepareCacheKey(request, modelConfig, provider, model);
      if (cacheKey) {
        const cached = cacheGet(cacheKey);
        if (cached) {
          const usageReport = normalizeUsageReport({ provider, model, usage: {}, rawUsage: {}, cost: null });
          return {
            text: cached.text,
            reasoning: cached.reasoning ?? "",
            toolCalls: normalizeToolCalls(cached.toolCalls ?? []),
            raw: cached.raw,
            usageReport,
            costSummary: costTracker.getSummary(),
            modelConfig,
            attempts: 1,
            retried: false,
            cached: true
          };
        }
      }

    // Stage-aware per-attempt timeout：modelConfig.timeout_ms > 构造默认值；
    // total deadline 同理（modelConfig.total_deadline_ms > 构造默认值）。
    const attemptTimeoutMs = modelConfig.timeout_ms ?? timeoutMs;
    const totalDeadline = modelConfig.total_deadline_ms ?? totalDeadlineMs;

    const startTime = clock();
    // 网络恢复标志：本方法作用域内发生过 ≥1 次重试且最终成功时，成功 return 前
    // 通知上层发「连接已恢复」。
    let retried = false;

    for (let attempt = 0; attempt <= requestRetryMax; attempt += 1) {
      const elapsed = clock() - startTime;
      if (elapsed >= totalDeadline) {
        // 总期限已过：立即抛错，不重试（重试只会多等一次退避后必然超时）
        throw new ProviderTransportError("Request exceeded total deadline.", { reason: "timeout" });
      }

      const timeoutController = new AbortController();
      let timedOut = false;
      let timedOutReason = null; // "idle"（空闲超时）| "deadline"（总期限硬闸）
      const onTimeout = () => {
        timedOut = true;
      };
      timeoutController.signal.addEventListener("abort", onTimeout, { once: true });

      const signals = [timeoutController.signal];
      if (signal) signals.push(signal);
      const combinedSignal = AbortSignal.any(signals);

      // attempt 级看门狗（单一 interval）：timeoutMs 语义是「空闲超时」（SSE
      // 事件间最大间隔），不再是总时长硬超时。记录 lastActivityAt，每次
      // onToken/onReasoningToken 活动刷新；interval 每 tick 检查「距上次活动
      // >= attemptTimeoutMs」→ 空闲超时 abort；「总耗时 >= totalDeadline」→
      // 硬闸 abort；都不满足则继续等待。interval 周期 = heartbeatMs > 0 ?
      // min(heartbeatMs, 1000) : 1000——heartbeatMs=0 时超时检查仍照常运行。
      let lastActivityAt = clock();
      const watchdogIntervalMs = heartbeatMs > 0 ? Math.min(heartbeatMs, 1000) : 1000;
      const watchdog = setTimer(() => {
        const now = clock();
        // 总期限硬闸优先于空闲超时：同一 tick 双命中时（最后一帧活动恰好落在
        // 距期限一个 attemptTimeoutMs 内）必须按 deadline 处理——否则空闲分支会
        // 走重试路径（全量退避 + onRetry + recordRetry）后才在循环顶抛错，白等
        // 一个 backoff 且记一次未发生的重试（与 catch 的 deadline 直抛分支一致）。
        if (now - startTime >= totalDeadline) {
          timedOutReason = "deadline";
          timeoutController.abort();
          return;
        }
        if (now - lastActivityAt >= attemptTimeoutMs) {
          timedOutReason = "idle";
          timeoutController.abort();
        }
      }, watchdogIntervalMs);

      // 非流式 heartbeat：attempt 挂起期间周期性 ping onActivity，让上层看到
      // 请求还活着（0 禁用；null 是无操作）。回调异常不得击穿 attempt——
      // 未捕获的定时器异常会终止进程，捕获后停止本 attempt 的心跳。
      // 注意：heartbeat 直接调用构造级 onActivity，不经过内部 markActivity——
      // 心跳只是"连接还挂着"的通知，不能宣称 provider 真有进展（不刷新
      // lastActivityAt，与已解析 SSE 帧的活动区分开）。
      let heartbeat = null;
      if (onActivity && heartbeatMs > 0) {
        heartbeat = setTimer(() => {
          try {
            onActivity?.();
          } catch {
            if (heartbeat) clearTimer(heartbeat);
          }
        }, heartbeatMs);
      }

      const cleanupAttempt = () => {
        clearTimer(watchdog);
        clearTimer(heartbeat);
        timeoutController.signal.removeEventListener("abort", onTimeout);
      };

      // markActivity：先刷新内部 lastActivityAt，再转发外部通知（onActivity
      // 仅为通知，缺省为空）。onActivity 包装无条件注入 adapter——活动刷新不依赖
      // Runtime 额外注册空回调，Gateway 自己兜底：流式 adapter 对每个成功解析的
      // SSE 帧（含 usage-only/空 delta/tool-call 增量帧）回调 metadata.onActivity，
      // 全部经此刷新 lastActivityAt，避免「连接活着但没有 token」的流被空闲超时
      // 误杀。onToken/onReasoningToken 同样先刷新 lastActivityAt；
      // emittedProviderToken 只由 onToken（公开正文）置位——reasoning-only 流
      // 不再阻断透明重试（重试最多重复模型内部推理，不会重复公开正文，正文已
      // 公开才不可重试）。
      const injectedOnActivity = onActivity ?? metadata.onActivity;
      const markActivity = (...args) => {
        lastActivityAt = clock();
        injectedOnActivity?.(...args);
      };
      let emittedProviderToken = false;
      const metadataForAttempt = {
        ...metadata,
        onActivity: markActivity,
        onToken(token, event) {
          lastActivityAt = clock();
          if (String(token ?? "")) emittedProviderToken = true;
          metadata.onToken?.(token, event);
        },
        onReasoningToken(token, event) {
          lastActivityAt = clock();
          metadata.onReasoningToken?.(token, event);
        }
      };

      try {
        const response = await adapter.complete(
          { ...request, metadata: metadataForAttempt },
          { signal: combinedSignal }
        );

        cleanupAttempt();

        // 只有成功响应可写缓存（失败的响应会污染缓存）
        if (cacheKey) {
          cachePut(cacheKey, {
            text: response.text ?? "",
            reasoning: response.reasoning ?? "",
            toolCalls: response.toolCalls ?? [],
            raw: response.raw ?? response
          });
        }

        const usageReport = normalizeUsageReport({
          provider,
          model,
          usage: response.usage ?? {},
          rawUsage: response.usage ?? {},
          cost: response.cost ?? null
        });
        const costSummary = costTracker.record({ stage, chapter, usageReport });
        if (retried && onRecovered) {
          onRecovered({ attempt: Math.min(attempt, retryMax), maxAttempts: retryMax });
        }
        return {
          text: response.text ?? "",
          reasoning: response.reasoning ?? "",
          toolCalls: normalizeToolCalls(response.toolCalls ?? []),
          raw: response.raw ?? response,
          usageReport,
          costSummary,
          modelConfig,
          attempts: attempt + 1,
          retried,
          cached: false
        };
      } catch (error) {
        cleanupAttempt();

        // 外部取消永远优先于 timeout——绝不重试
        if (signal?.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }

        // 外部取消（非 timeout）：不重试，记录失败调用后重抛原错误
        if (!timedOut && isCancellationError(error, signal)) {
          recordFailed(error, { provider, model, stage, chapter });
          throw error;
        }

        // Timeout：包装为 ProviderTransportError（空闲超时与总期限硬闸共用此
        // 分支，reason 均为 timeout，仅消息区分 deadline 以保留既有契约）
        if (timedOut) {
          const timeoutError = new ProviderTransportError(
            timedOutReason === "deadline" ? "Request exceeded total deadline." : "Request timed out.",
            { reason: "timeout" }
          );
          // 正文已输出，或总期限硬闸已到：直接失败、不重试——硬闸后再退避只
          // 会白等一个完整 backoff，且 recordRetry 记一次未发生的重试
          if (emittedProviderToken || timedOutReason === "deadline") {
            recordFailed(timeoutError, { provider, model, stage, chapter });
            throw timeoutError;
          }
          if (isRetryable(timeoutError) && attempt < requestRetryMax) {
            onActivity?.();
            retried = true;
            costTracker.recordRetry();
            await retryWait(attempt, timeoutError, model, signal);
            continue;
          }
          recordFailed(timeoutError, { provider, model, stage, chapter });
          throw timeoutError;
        }

        if (emittedProviderToken) {
          recordFailed(error, { provider, model, stage, chapter });
          throw error;
        }

        if (isRetryable(error) && attempt < requestRetryMax) {
          onActivity?.();
          retried = true;
          costTracker.recordRetry();
          await retryWait(attempt, error, model, signal);
          continue;
        }

        // 最终失败：provider 若在错误里带了 usage 也照常记账
        recordFailed(error, { provider, model, stage, chapter });
        throw error;
      }
    }
    // 不可达：循环上限 requestRetryMax 次重试后必然 throw
    throw new ProviderTransportError("Request failed after exhausting retries.", { reason: "network" });
  }

  // -------------------------------------------------------------------------
  // 记账与重试辅助（闭包捕获实例配置）
  // -------------------------------------------------------------------------

  function recordFailed(error, { provider, model, stage, chapter }) {
    const usageFromError = error.usage ?? {};
    const hasUsage = usageFromError && typeof usageFromError === "object" && Object.keys(usageFromError).length > 0;
    const usageReport = hasUsage
      ? {
          ...normalizeUsageReport({
            provider, model,
            usage: usageFromError, rawUsage: usageFromError, cost: null
          }),
          failed: true
        }
      : {
          provider, model,
          inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0,
          estimatedCost: 0, failed: true
        };
    costTracker.record({ stage, chapter, usageReport });
  }

  function isRetryable(error) {
    return (
      error?.code === "provider_transport_error" &&
      (error.reason === "server-retryable" || error.reason === "timeout" || error.reason === "network")
    );
  }

  async function retryWait(attempt, error, model, signal) {
    const backoff = retryBaseDelayMs * Math.pow(2, attempt);
    const jitter = Math.random() * 1000;
    const baseDelay = Math.min(backoff + jitter, retryMaxDelayMs);
    // Prefer Retry-After from server if present and larger than backoff
    const retryAfterMs = error?.retryAfterMs ?? null;
    const delay = retryAfterMs != null ? Math.max(retryAfterMs, baseDelay) : baseDelay;
    const reason = error?.reason ?? "unknown";
    if (onRetry) {
      onRetry({
        attempt: attempt + 1,
        maxAttempts: retryMax,
        delay,
        error,
        reason,
        model
      });
    }
    await abortableDelay(delay, signal);
  }

  // -------------------------------------------------------------------------
  // 确定性响应缓存（仅辅助调用重试去重）
  // -------------------------------------------------------------------------

  function prepareCacheKey(request, modelConfig, provider, model) {
    const metadata = request.metadata ?? {};
    // 流程级重试（attempt > 0）预期新调用：既不查也不写缓存
    if (Number(metadata.attempt) > 0) return null;
    // 条件：辅助标记 + 无工具 + 非流式 + 显式 temperature=0 + 模型 supportsTemperature。
    // 不支持 temperature 的模型（thinking 系）不注入也就不缓存——确定性前提不成立。
    if (metadata.cacheable !== true) return null;
    if (Array.isArray(request.tools) && request.tools.length > 0) return null;
    if (request.stream === true || modelConfig.stream === true) return null;
    if (modelConfig.temperature !== 0) return null;
    const caps = resolveModelCapabilities(modelConfig);
    if (caps.supportsTemperature !== true) return null;

    // 缓存 key 只纳入当前确定性前提相关的采样字段（temperature/top_p/
    // max_tokens/extra_body）。若未来 modelConfig 引入新的采样类字段（如 seed、
    // frequency_penalty），必须同步纳入 key，否则可能命中采样语义不同的响应。
    // 该责任与 metadata.cacheable 的标记纪律一起归 Task 6 runtime：只有 runtime
    // 把真正确定性的辅助调用标记为 cacheable，本缓存才被启用；任何未被 key
    // 覆盖的采样参数都会破坏命中正确性。

    const stableMetadata = {};
    for (const field of AUXILIARY_METADATA_KEY_FIELDS) {
      if (metadata[field] !== undefined) {
        stableMetadata[field] = metadata[field];
      }
    }
    const payload = {
      provider,
      model,
      base_url: modelConfig.base_url ?? null,
      temperature: modelConfig.temperature ?? null,
      top_p: modelConfig.top_p ?? null,
      max_tokens: modelConfig.max_output_tokens ?? modelConfig.max_tokens ?? null,
      extra_body: modelConfig.extra_body ?? null,
      messages: request.messages ?? null,
      tools: Array.isArray(request.tools) ? request.tools : null,
      metadata: stableMetadata
    };
    return sha256(stableStringify(payload));
  }

  function cacheGet(key) {
    const entry = responseCache.get(key);
    if (entry === undefined) return null;
    // LRU 刷新：删除后重放，让最近命中的条目保持较新位置
    responseCache.delete(key);
    responseCache.set(key, entry);
    return entry;
  }

  function cachePut(key, entry) {
    if (responseCache.has(key)) {
      responseCache.delete(key);
    }
    if (responseCache.size >= responseCacheSize) {
      // Map 迭代序 = 插入序，第一个条目即最久未使用
      const oldestKey = responseCache.keys().next().value;
      responseCache.delete(oldestKey);
    }
    responseCache.set(key, entry);
  }

  return {
    adapter,
    retryMax,
    retryBaseDelayMs,
    retryMaxDelayMs,
    timeoutMs,
    totalDeadlineMs,
    heartbeatMs,
    onRetry,
    onRecovered,
    onActivity,
    costTracker,
    getSummary() {
      return costTracker.getSummary();
    },
    complete
  };
}

// ---------------------------------------------------------------------------
// 纯辅助（无状态）
// ---------------------------------------------------------------------------

// 归一化 toolCalls 为 runtime 消费的规范形状 { id, name, arguments }（与
// harness 冻结的 tool() 形状一致）。adapter 可能返回 { id, tool, input }
//（openai-compatible）或 { id, name, arguments }（mock/脚本），这里统一。
function normalizeToolCalls(calls) {
  if (!Array.isArray(calls)) return [];
  return calls
    .map((tc) => {
      if (tc == null) return null;
      return {
        id: tc.id ?? null,
        name: tc.name ?? tc.tool ?? null,
        arguments: tc.arguments ?? tc.input ?? null
      };
    })
    .filter((tc) => tc !== null && tc.name != null);
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
