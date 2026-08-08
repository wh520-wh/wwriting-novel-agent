// src/core/agent/compaction.mjs
//
// Task 8：压缩状态机协调器（窄编排接口）。
//
// 职责：把一次压缩编排为严格的 Journal 事件序列并驱动 checkpoint store 的
// 候选→提交时序：
//
//   start()  -> context_compaction_started -> context_compaction_running
//            -> gateway.complete(request, { signal, retryMax: 0 })（每 attempt 恰好一次；
//               attempt 1 对瞬时传输错误自动再请求一次，即最多 2 次模型请求；结构/完整性/
//               持久化失败不自动重试）
//            -> context_compaction_completed（由 commitCandidate 经预写 event_id 追加）
//               \-> context_compaction_failed（error_code 固定字段，不可用值写 null）
//               \-> context_compaction_cancelled（cancel_requested 先于 cancelled；
//                   cancelled 只在底层请求确认终止后追加）
//
// 禁止：tools.execute、写创作文件、更新章节状态、启动第二个普通 Run。压缩调用
// 只做一次逻辑模型 turn（stream:false、无工具），metadata 固定
// { stage: "context_compaction", compaction_id, cacheable: false }。
//
// retry() 继续同一 compaction_id 的新 attempt（attempt+1）：内存态存在时复用
// entry；进程重启后凭 journal 事件重建 entry（started 事件的 payload 记录
// source_checkpoint_id/checkpoint_id/pending_input_id/trigger/attempt），源材料由
// 注入的 buildInput 从当前 journal 重建。
//
// cancel() 复用同一 AbortSignal 链：cancel 先追加 context_compaction_cancel_requested
// 进入 cancelling，abort 底层请求，等待 attempt 收尾后才追加 cancelled。
import { randomUUID } from "node:crypto";
import { COMPACTION_PROMPT, parseCompactionResponse, validateCompactionSummary } from "./compaction-prompt.mjs";
import { estimateTokens } from "./prompt.mjs";
import { COMPACTION_PAYLOAD_FIELDS } from "./context-checkpoints.mjs";

export const COMPACTION_EVENT_TYPES = Object.freeze([
  "context_compaction_started",
  "context_compaction_running",
  "context_compaction_cancel_requested",
  "context_compaction_completed",
  "context_compaction_failed",
  "context_compaction_cancelled",
  "context_compaction_noop"
]);

// 非终态压缩状态（load() 对账时用于判断"未完成 attempt"）。
export const COMPACTION_NON_TERMINAL_STATES = Object.freeze(["started", "running", "cancelling"]);

// 阻塞普通发送/自动恢复的压缩状态（open() 不得对这些状态自动启动 Run 循环）。
export const COMPACTION_BLOCKED_STATES = Object.freeze([
  "started",
  "running",
  "cancelling",
  "failed",
  "cancelled"
]);

function defaultClock() {
  return Date.now();
}

function defaultIdFactory() {
  return randomUUID();
}

function normalizeAt(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`非法时间值: ${String(value)}`);
  return date.toISOString();
}

function compactionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// 瞬时传输错误（计划不变式 5）：network/timeout/429/5xx 允许自动重试一次；
// 结构校验/候选丢失关键状态/持久化失败不自动重试。
export function isTransientTransportError(error) {
  if (error == null) return false;
  if (error?.code === "provider_transport_error") return true;
  const code = String(error?.code ?? "");
  if (code === "model_timeout") return true;
  if (code === "model_network" || code === "network_error" || code === "model_transport") return true;
  if (/^rate_limit/iu.test(code)) return true;
  if (/^server_error/u.test(code) || /^http_5\d{2}/u.test(code) || /^http_429/u.test(code)) return true;
  return false;
}

function isAbort(error, entry) {
  if (entry?.requestController?.signal?.aborted) return true;
  if (error?.name === "AbortError") return true;
  if (error?.code === "model_aborted" || error?.code === "model_cancelled") return true;
  return false;
}

// 固定事件 payload（计划 §2 COMPACTION_PAYLOAD_FIELDS；不可用值写 null，绝不改名）。
function buildPayload(entry, overrides = {}) {
  const source = entry.source ?? {};
  const sourceState = source.sourceState ?? {};
  return {
    compaction_id: entry.compactionId,
    trigger: entry.trigger,
    attempt: entry.attempt,
    source_checkpoint_id: entry.sourceCheckpointId,
    checkpoint_id: entry.checkpointId,
    source_seq: sourceState.source_seq ?? null,
    source_transcript_seq: sourceState.source_transcript_seq ?? null,
    provider_model_id: sourceState.provider_model_id ?? null,
    estimated_tokens_before: source.estimated_tokens_before ?? null,
    estimated_tokens_after: null,
    released_tokens: null,
    summary_schema_version: 1,
    duration_ms: null,
    validation: null,
    error_code: null,
    cancel_reason: null,
    ...overrides
  };
}

// 守卫：固定字段一个都不能少（契约完整性）。
function assertPayloadComplete(payload) {
  for (const field of COMPACTION_PAYLOAD_FIELDS) {
    if (!(field in payload)) {
      throw compactionError("compaction_payload_schema", `事件 payload 缺少固定字段 ${field}`);
    }
  }
}

export function createCompactionCoordinator({
  journal,
  gateway,
  checkpointStore,
  buildInput,
  clock = defaultClock,
  idFactory = defaultIdFactory
} = {}) {
  if (!journal || !gateway || !checkpointStore || typeof buildInput !== "function") {
    throw new TypeError("createCompactionCoordinator 需要 journal/gateway/checkpointStore/buildInput");
  }

  const compactions = new Map(); // compaction_id -> entry（进程内状态；重启后按需重建）

  function durationOf(entry) {
    if (entry?.startedAt == null) return null;
    const ms = Date.parse(normalizeAt(clock())) - Date.parse(entry.startedAt);
    return Math.max(0, ms);
  }

  // 新 active context 大小估算：摘要 + checkpoint 近期原文（CJK 感知，与 prompt 层同源）。
  function estimateTokensOf(entry, summary) {
    const summaryTokens = estimateTokens(JSON.stringify(summary ?? {}));
    const recentTokens = estimateTokens(JSON.stringify(entry.source?.recent_messages ?? []));
    return Math.max(1, summaryTokens + recentTokens);
  }

  function buildRequest(entry) {
    const modelConfig = entry.modelConfig ?? null;
    return {
      messages: [
        { role: "system", content: COMPACTION_PROMPT },
        { role: "user", content: entry.source?.sourceMaterial ?? "" }
      ],
      tools: undefined,
      toolChoice: undefined,
      stream: false,
      modelConfig,
      metadata: { stage: "context_compaction", compaction_id: entry.compactionId, cacheable: false }
    };
  }

  function inferStateFromEvents(events, compactionId) {
    let state = "started";
    for (const event of events) {
      if (event?.payload?.compaction_id !== compactionId) continue;
      switch (event?.type) {
        case "context_compaction_started":
          state = "started";
          break;
        case "context_compaction_running":
          state = "running";
          break;
        case "context_compaction_cancel_requested":
          state = "cancelling";
          break;
        case "context_compaction_completed":
          state = "completed";
          break;
        case "context_compaction_failed":
          state = "failed";
          break;
        case "context_compaction_cancelled":
          state = "cancelled";
          break;
        case "context_compaction_noop":
          state = "noop";
          break;
        default:
          break;
      }
    }
    return state;
  }

  // 进程重启后从 journal 事件重建 entry（started 事件是最新 attempt 的起点）。
  async function loadEntry(compactionId) {
    const existing = compactions.get(compactionId);
    if (existing) return existing;
    const events = await journal.read({ afterSeq: 0, limit: 100000 });
    const startedEvents = events.filter(
      (event) => event?.type === "context_compaction_started" && event?.payload?.compaction_id === compactionId
    );
    const started = startedEvents.at(-1);
    if (!started) {
      throw compactionError("compaction_not_found", `compaction ${compactionId} 不存在`);
    }
    const entry = {
      compactionId,
      trigger: started.payload.trigger === "manual" ? "manual" : "automatic",
      attempt: Number.isInteger(started.payload.attempt) ? started.payload.attempt : 1,
      checkpointId: started.payload.checkpoint_id ?? idFactory(),
      sourceCheckpointId: started.payload.source_checkpoint_id ?? null,
      pendingInputId: started.payload.pending_input_id ?? null,
      startedAt: started.payload.started_at ?? normalizeAt(clock()),
      state: inferStateFromEvents(events, compactionId),
      source: null,
      modelConfig: null,
      requestController: null,
      pending: null,
      cancelReason: null
    };
    compactions.set(compactionId, entry);
    return entry;
  }

  // 单次 attempt：running 事件 → 至多 maxRequests 次 gateway 调用（attempt 1 对
  // 瞬时错误自动再请求一次）→ 成功提交 / 失败 / 取消。
  async function runAttempt(entry, { signal } = {}) {
    if (entry.state === "cancelling") {
      return finalizeCancelled(entry, entry.cancelReason ?? "user_cancel");
    }
    entry.state = "running";
    await journal.append({
      type: "context_compaction_running",
      payload: { compaction_id: entry.compactionId, trigger: entry.trigger, attempt: entry.attempt }
    });
    const request = buildRequest(entry);
    const maxRequests = entry.attempt === 1 ? 2 : 1; // 自动重试只属于第一次 attempt
    for (let requestIndex = 0; requestIndex < maxRequests; requestIndex += 1) {
      const requestController = new AbortController();
      entry.requestController = requestController;
      // 复用传入的 AbortSignal 链（ESC/stop 共用同一 controller，无第二套终止协议）
      if (signal?.aborted) {
        requestController.abort();
      } else if (signal?.addEventListener) {
        signal.addEventListener("abort", () => requestController.abort(), { once: true });
      }
      if (entry.state === "cancelling") requestController.abort();
      try {
        const reply = await gateway.complete(request, { signal: requestController.signal, retryMax: 0 });
        if (entry.state === "cancelling") {
          return finalizeCancelled(entry, entry.cancelReason ?? "user_cancel");
        }
        return await finalizeSuccess(entry, reply);
      } catch (error) {
        if (isAbort(error, entry) || entry.state === "cancelling") {
          return finalizeCancelled(entry, entry.cancelReason ?? "user_cancel");
        }
        if (isTransientTransportError(error) && requestIndex < maxRequests - 1) {
          continue; // 同一 attempt 内只自动重试一次（瞬时传输错误）
        }
        return finalizeFailure(entry, error);
      }
    }
    return { status: "failed", compaction_id: entry.compactionId, attempt: entry.attempt, error_code: "compaction_failed" };
  }

  async function finalizeSuccess(entry, reply) {
    const source = entry.source ?? {};
    const sourceState = source.sourceState ?? {};
    let summary;
    try {
      summary = parseCompactionResponse(String(reply?.text ?? ""));
      validateCompactionSummary(summary, sourceState);
    } catch (error) {
      return finalizeFailure(entry, error);
    }
    const estimatedTokensAfter = estimateTokensOf(entry, summary);
    const candidate = {
      schema_version: 1,
      checkpoint_id: entry.checkpointId,
      source_checkpoint_id: entry.sourceCheckpointId,
      source_seq: sourceState.source_seq ?? null,
      source_transcript_seq: sourceState.source_transcript_seq ?? null,
      configured_model_id: sourceState.configured_model_id ?? null,
      provider_model_id: sourceState.provider_model_id ?? null,
      trigger: entry.trigger,
      summary,
      recent_messages: source.recent_messages ?? [],
      open_tool_calls: source.open_tool_calls ?? [],
      reload_from_workspace: source.reload_from_workspace ?? [],
      estimated_tokens: estimatedTokensAfter,
      created_at: normalizeAt(clock()),
      sha256: ""
    };
    const commitEvent = {
      event_id: idFactory(),
      payload: {
        compaction_id: entry.compactionId,
        trigger: entry.trigger,
        attempt: entry.attempt,
        estimated_tokens_before: source.estimated_tokens_before ?? null,
        estimated_tokens_after: estimatedTokensAfter,
        released_tokens: Math.max(0, (source.estimated_tokens_before ?? 0) - estimatedTokensAfter),
        duration_ms: durationOf(entry)
      }
    };
    try {
      await checkpointStore.writeCandidate(candidate);
      await checkpointStore.validateCandidate(candidate, sourceState);
      const committed = await checkpointStore.commitCandidate(candidate, { journal, commitEvent, sourceState });
      entry.state = "completed";
      if (committed?.checkpoint_id != null) entry.checkpointId = committed.checkpoint_id;
      return {
        status: "completed",
        compaction_id: entry.compactionId,
        checkpoint_id: entry.checkpointId,
        attempt: entry.attempt,
        event_id: committed?.event_id ?? null
      };
    } catch (error) {
      await checkpointStore.discardCandidate(entry.checkpointId).catch(() => {});
      return finalizeFailure(entry, error);
    }
  }

  async function finalizeFailure(entry, error) {
    entry.state = "failed";
    const errorCode = error?.code ?? "compaction_failed";
    const payload = buildPayload(entry, { error_code: errorCode, duration_ms: durationOf(entry) });
    assertPayloadComplete(payload);
    await journal.append({ type: "context_compaction_failed", payload }).catch(() => {});
    return { status: "failed", compaction_id: entry.compactionId, attempt: entry.attempt, error_code: errorCode, error };
  }

  async function finalizeCancelled(entry, reason) {
    entry.state = "cancelled";
    const payload = buildPayload(entry, {
      cancel_reason: reason,
      duration_ms: durationOf(entry)
    });
    assertPayloadComplete(payload);
    await journal.append({ type: "context_compaction_cancelled", payload }).catch(() => {});
    await checkpointStore.discardCandidate(entry.checkpointId).catch(() => {});
    return { status: "cancelled", compaction_id: entry.compactionId, attempt: entry.attempt, cancel_reason: reason };
  }

  async function start({ projectRoot, trigger, pendingInputId = null, modelConfig, signal } = {}) {
    const pointer = await checkpointStore.readActive();
    const compactionId = idFactory();
    const checkpointId = idFactory();
    const startedAt = normalizeAt(clock());
    const entry = {
      compactionId,
      trigger: trigger === "manual" ? "manual" : "automatic",
      attempt: 1,
      checkpointId,
      sourceCheckpointId: pointer.checkpoint_id ?? null,
      pendingInputId,
      startedAt,
      state: "started",
      source: null,
      modelConfig: modelConfig ?? null,
      requestController: null,
      pending: null,
      cancelReason: null,
      projectRoot: projectRoot ?? null
    };
    compactions.set(compactionId, entry);
    // 先构建源材料做 noop 预检：无可压缩历史时"直接追加 context_compaction_noop"
    //（brief Step 6），不产生 started/running 事件、不调用模型。
    const built = await buildInput({
      journal,
      checkpointStore,
      sourceCheckpointId: entry.sourceCheckpointId,
      trigger: entry.trigger,
      modelConfig: modelConfig ?? null,
      projectRoot: projectRoot ?? null
    });
    if (built?.noop === true) {
      // 无可压缩历史：noop，不调用模型
      entry.state = "noop";
      await journal.append({
        type: "context_compaction_noop",
        payload: { compaction_id: compactionId, trigger: entry.trigger, reason: built.reason ?? "nothing_to_compact" }
      });
      return { status: "noop", compaction_id: compactionId, reason: built.reason ?? "nothing_to_compact" };
    }
    await journal.append({
      type: "context_compaction_started",
      payload: {
        compaction_id: compactionId,
        trigger: entry.trigger,
        attempt: 1,
        source_checkpoint_id: entry.sourceCheckpointId,
        checkpoint_id: checkpointId,
        pending_input_id: pendingInputId,
        started_at: startedAt
      }
    });
    entry.source = built ?? {};
    if (entry.modelConfig == null && built?.modelConfig != null) entry.modelConfig = built.modelConfig;
    const attemptPromise = runAttempt(entry, { signal });
    entry.pending = attemptPromise;
    return attemptPromise;
  }

  // 继续同一 compaction 的新 attempt（用户手动重试）。进程重启后凭 journal 重建 entry。
  async function retry({ compactionId, signal } = {}) {
    const entry = await loadEntry(compactionId);
    if (entry.state === "completed" || entry.state === "noop") {
      return { status: entry.state, compaction_id: compactionId, attempt: entry.attempt };
    }
    if (entry.state === "started" || entry.state === "running" || entry.state === "cancelling") {
      return { status: "in_flight", compaction_id: compactionId };
    }
    // failed 或 cancelled（重启恢复后的 cancelled 是否可重试由 runtime 按 pending input 决定）
    entry.attempt += 1;
    entry.state = "started";
    entry.cancelReason = null;
    entry.startedAt = normalizeAt(clock());
    const built = await buildInput({
      journal,
      checkpointStore,
      sourceCheckpointId: entry.sourceCheckpointId,
      trigger: entry.trigger,
      modelConfig: entry.modelConfig ?? null,
      projectRoot: entry.projectRoot ?? null
    });
    if (built?.noop === true) {
      entry.state = "noop";
      await journal.append({
        type: "context_compaction_noop",
        payload: { compaction_id: compactionId, trigger: entry.trigger, reason: built.reason ?? "nothing_to_compact" }
      });
      return { status: "noop", compaction_id: compactionId };
    }
    entry.source = built ?? {};
    if (entry.modelConfig == null && built?.modelConfig != null) entry.modelConfig = built.modelConfig;
    await journal.append({
      type: "context_compaction_started",
      payload: {
        compaction_id: compactionId,
        trigger: entry.trigger,
        attempt: entry.attempt,
        source_checkpoint_id: entry.sourceCheckpointId,
        checkpoint_id: entry.checkpointId,
        pending_input_id: entry.pendingInputId,
        started_at: entry.startedAt
      }
    });
    const attemptPromise = runAttempt(entry, { signal });
    entry.pending = attemptPromise;
    return attemptPromise;
  }

  async function cancel({ compactionId } = {}) {
    let entry;
    try {
      entry = compactions.get(compactionId) ?? (await loadEntry(compactionId));
    } catch {
      return { status: "not_found", compaction_id: compactionId };
    }
    if (entry.state === "completed" || entry.state === "failed" || entry.state === "cancelled" || entry.state === "noop") {
      return { status: "already_terminal", compaction_id: compactionId, state: entry.state };
    }
    if (entry.state === "cancelling") {
      await entry.pending?.catch(() => {});
      return { status: "cancelled", compaction_id: compactionId };
    }
    // started/running → cancelling；底层结束后（entry.pending resolve）才返回 cancelled
    entry.state = "cancelling";
    entry.cancelReason = "user_cancel";
    await journal
      .append({
        type: "context_compaction_cancel_requested",
        payload: { compaction_id: compactionId, trigger: entry.trigger, cancel_reason: entry.cancelReason }
      })
      .catch(() => {});
    entry.requestController?.abort();
    await entry.pending?.catch(() => {});
    return { status: "cancelled", compaction_id: compactionId, cancel_reason: entry.cancelReason };
  }

  return { start, retry, cancel };
}
