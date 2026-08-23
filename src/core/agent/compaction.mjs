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
import {
  COMPACTION_PROMPT,
  DEFAULT_MIN_PROTECTED_TURNS,
  parseCompactionResponse,
  selectProtectedRecentTurns,
  validateCompactionSummary
} from "./compaction-prompt.mjs";
import { estimateTokens } from "./prompt.mjs";
import { estimateRequestUsage, OUTPUT_SAFETY_RESERVE } from "./context-window.mjs";
import { COMPACTION_PAYLOAD_FIELDS } from "./context-checkpoints.mjs";
import { defaultClock, defaultIdFactory, normalizeAt, codedError as compactionError } from "./agent-utils.mjs";
import { buildTurnsFromTranscript, collectOpenToolCalls, summarizeLargeToolMessages, transcriptToMessages } from "./history-assembly.mjs";

// 非终态压缩状态（load() 对账时用于判断"未完成 attempt"）。
export const COMPACTION_NON_TERMINAL_STATES = Object.freeze(["started", "running", "cancelling"]);

// 普通发送只在压缩仍需用户处理时阻塞；cancelled 是已收敛终态，用户再次提交可恢复 Run。
export const COMPACTION_SEND_BLOCKED_STATES = Object.freeze([
  "started",
  "running",
  "cancelling",
  "failed"
]);

// 自动恢复比用户提交更保守：cancelled 后必须等一次明确用户动作，不能在 open() 时
// 自动复活崩溃前的输入。
export const COMPACTION_RESUME_BLOCKED_STATES = Object.freeze([
  ...COMPACTION_SEND_BLOCKED_STATES,
  "cancelled"
]);

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

// Task 8/I1：压缩源材料预算——早期历史逐字内容（summarized_history）封顶为窗口的
// 该比例，保证压缩请求自身能装进上下文窗口（预算只裁剪"已早于受保护窗口"的最旧
// 轮次，受保护近期原文与旧 checkpoint 摘要不受影响；封顶后的最终估算仍由
// buildCompactionSource 的窗口预检把关）。
const COMPACTION_SOURCE_BUDGET_RATIO = 0.5;

// 压缩源材料构建（Task 10/F5d 第十五轮从 runtime.mjs 机械迁入，不改逻辑）：
// createCompactionCoordinator 的 buildInput 注入实现。读取 active checkpoint（若
// 有）→ 重建 delta 轮次 → selectProtectedRecentTurns → 生成 sourceMaterial /
// recent_messages / sourceState。无 checkpoint 且没有早于受保护窗口的历史时返回
// noop（不调用模型）。依赖参数化：resolveWorkspaceConfig/modelConfigOf 是
// runtime 内部函数（注入的 workspaceConfigLoader 与 resolveModelLimits），经
// 参数传入；storageRoot/session 为 runtime 旧调用点的签名残留（函数体不使用），
// 迁入时删除。
export async function buildCompactionSource({
  journal,
  checkpointStore,
  resolveWorkspaceConfig,
  modelConfigOf,
  sourceCheckpointId = null,
  trigger = "automatic",
  modelConfig = null,
  projectRoot = null
} = {}) {
  // 进程重启后的压缩 retry：协调器 entry 无内存 modelConfig——按 projectRoot
  // 解析当前有效配置（modelConfigOf(resolveWorkspaceConfig)），保证候选校验的
  // configured_model_id/model_name 与压缩请求的 modelConfig 始终可用。
  let effectiveModelConfig = modelConfig;
  if (effectiveModelConfig == null && typeof projectRoot === "string" && projectRoot.length > 0) {
    try {
      const project = await resolveWorkspaceConfig(projectRoot);
      effectiveModelConfig = modelConfigOf(project);
    } catch {
      effectiveModelConfig = null;
    }
  }
  const pointer = await checkpointStore.readActive();
  let oldCheckpoint = null;
  if (pointer.checkpoint_id != null) {
    oldCheckpoint = await checkpointStore.readCheckpointFile(pointer.checkpoint_id).catch(() => null);
  }
  const fromSeq = oldCheckpoint?.source_transcript_seq?.end ?? 0;
  const delta =
    fromSeq > 0 ? await journal.readTranscriptAfter({ afterSeq: fromSeq }) : await journal.readTranscript();
  const lastTailSeq = delta.at(-1)?.transcript_seq ?? fromSeq;
  const turns = buildTurnsFromTranscript(delta);
  const window =
    Number.isFinite(effectiveModelConfig?.effective_context_window) && effectiveModelConfig.effective_context_window > 0
      ? effectiveModelConfig.effective_context_window
      : 256_000;
  const targetTokens = Math.round(window * 0.25);
  let { protected_turns, summarized_turns: allSummarizedTurns } = selectProtectedRecentTurns({ turns, targetTokens });
  // 手动 /compact 是作者显式请求释放上下文。自动压缩仍保留最近 12 轮，
  // 但手动命令不能因会话尚未达到 12 轮就永远 no-op：保留最低 2 轮，其余
  // 已完成轮次交给同一摘要/checkpoint 链路。没有超过最低保留量时继续 noop。
  if (trigger === "manual" && allSummarizedTurns.length === 0 && protected_turns.length > DEFAULT_MIN_PROTECTED_TURNS) {
    ({ protected_turns, summarized_turns: allSummarizedTurns } = selectProtectedRecentTurns({
      turns,
      targetTokens,
      maxProtectedTurns: DEFAULT_MIN_PROTECTED_TURNS
    }));
  }
  // 没有任何旧轮次可纳入摘要时，默认 noop（刚完成压缩而没有新消息时，不得为
  // 同一内容重复调用模型）。例外：被保护轮内存在已截断的大工具输出时仍要压缩——
  // 上下文 90% 可能是「少数轮次 + 超大工具输出」撑起来的（轮数 ≤12 不触发驱逐，
  // 但 recent_messages 摘要化能释放大量占用），不压缩会让下一次发送再次触发
  // 同一 noop 判定，永久无法压缩。
  const hasSummarizedToolOutput = (turns) =>
    (turns ?? []).some((turn) => (turn?.tool_activities ?? []).some((activity) => activity?.summarized_output === true));
  if (allSummarizedTurns.length === 0 && !hasSummarizedToolOutput(protected_turns)) {
    return { noop: true, reason: "nothing_to_compact" };
  }
  // I1：预算封顶。summarized_history 是最早的轮次、逐字进入压缩请求——100k+ 轮次
  // transcript 的首次压缩若原样拼接会让请求超过窗口（provider 拒绝 → Run 永久卡在
  // waiting_user，retry 同源同结果）。按每轮估算（与 sourceMaterial 逐字投影同口径）
  // 从最旧轮次开始裁剪，保留紧邻受保护窗口的最新被摘要轮次；拼接前裁剪还约束了
  // JSON.stringify 的内存。
  let summarized_turns = allSummarizedTurns;
  const sourceBudgetTokens = Math.floor(window * COMPACTION_SOURCE_BUDGET_RATIO);
  if (sourceBudgetTokens > 0 && summarized_turns.length > 0) {
    const kept = [];
    let used = 0;
    for (let i = summarized_turns.length - 1; i >= 0; i -= 1) {
      const inc = estimateTokens(
        JSON.stringify({
          user: summarized_turns[i].user_text,
          assistant: summarized_turns[i].assistant_text,
          tool_activities: summarized_turns[i].tool_activities ?? []
        })
      );
      if (kept.length > 0 && used + inc > sourceBudgetTokens) break;
      kept.push(summarized_turns[i]);
      used += inc;
    }
    summarized_turns = kept.reverse();
  }
  // 压缩请求瘦身：模型只需要总结「早期历史」（summarized_history + 旧摘要），
  // 不需要被保护轮全文——它们压缩后原样保留在 checkpoint.recent_messages 中，
  // 模型下一轮自然可见。protected_recent_turns 只带轻量线索（轮次序号/用户输入
  // 开头/工具活动名），避免 12 轮大正文 + 大工具输出把压缩请求本身撑爆窗口
  // （source_exceeds_window → 无法压缩）。
  const PROTECTED_PREVIEW_CHARS = 200;
  const sourceMaterial = JSON.stringify(
    {
      old_summary: oldCheckpoint?.summary ?? null,
      old_recent_messages: summarizeLargeToolMessages(oldCheckpoint?.recent_messages ?? []),
      summarized_history: summarized_turns.map((turn) => ({
        user: turn.user_text,
        assistant: turn.assistant_text,
        tool_activities: turn.tool_activities ?? []
      })),
      protected_recent_turns: protected_turns.map((turn) => ({
        seq_start: Number.isInteger(turn.transcript_seq_start) ? turn.transcript_seq_start : null,
        seq_end: Number.isInteger(turn.transcript_seq_end) ? turn.transcript_seq_end : null,
        user: String(turn.user_text ?? "").slice(0, PROTECTED_PREVIEW_CHARS),
        assistant: String(turn.assistant_text ?? "").slice(0, PROTECTED_PREVIEW_CHARS),
        tool_activities: (turn.tool_activities ?? []).map((activity) => ({
          name: activity?.name ?? null,
          status: activity?.status ?? null,
          summarized_output: activity?.summarized_output ?? false,
          result_summary: activity?.summarized_output === true ? (activity?.result_summary ?? null) : null
        }))
      }))
    },
    null,
    2
  );
  // 受保护轮内被摘要化（大输出 → 截断摘要）的活动索引：checkpoint 的
  // recent_messages 必须用摘要化后的消息链重建，否则压缩后 active context 仍
  // 保留大工具输出全文，「压缩完还是 90%」的根因。
  const summarizedByCallId = new Map();
  for (const turn of protected_turns) {
    for (const activity of turn?.tool_activities ?? []) {
      if (activity?.summarized_output === true && activity.tool_call_id != null) {
        summarizedByCallId.set(activity.tool_call_id, activity);
      }
    }
  }
  // checkpoint 近期原文 = 受保护轮次范围内的原始消息链（复用线上消息转换，
  // 保证 assistant tool_calls 以 { id, type, function } 形状进入后续请求）。
  // 被摘要化的大输出替换为 { name, result_summary, journal_ref } 占位文本。
  const minProtectedSeq = Math.min(
    ...protected_turns.map((turn) => (Number.isInteger(turn.transcript_seq_start) ? turn.transcript_seq_start : Infinity))
  );
  const recentMessages = transcriptToMessages(
    delta
      .filter((record) => record.transcript_seq == null || record.transcript_seq >= minProtectedSeq)
      .map((record) => {
        if (record?.role !== "tool") return record;
        const activity = summarizedByCallId.get(record.tool_call_id ?? null);
        if (activity == null) return record;
        const ref = activity.journal_ref != null ? `（完整内容见 Journal ${activity.journal_ref}）` : "";
        return {
          ...record,
          content: `[工具输出已摘要] ${activity.name ?? "tool"}：${activity.result_summary ?? ""}${ref}`
        };
      })
  );
  const openToolCalls = collectOpenToolCalls(protected_turns, oldCheckpoint?.open_tool_calls ?? []);
  const sourceState = {
    source_checkpoint_id: pointer.checkpoint_id ?? null,
    source_seq: { start: 1, end: Math.max(journal.lastSeq ?? 0, 1) },
    source_transcript_seq: { start: 1, end: lastTailSeq },
    configured_model_id: effectiveModelConfig?.configured_model_id ?? null,
    provider_model_id: effectiveModelConfig?.model_name ?? null,
    trigger,
    effective_context_window: window,
    target_tokens: targetTokens,
    current_task: oldCheckpoint?.summary?.current_task ?? "",
    user_confirmed_decisions: oldCheckpoint?.summary?.user_confirmed_decisions ?? [],
    pending_steps: oldCheckpoint?.summary?.pending_steps ?? [],
    open_tool_calls: openToolCalls,
    reload_from_workspace: oldCheckpoint?.reload_from_workspace ?? []
  };
  const estimatedTokensBefore = estimateRequestUsage({
    messages: [{ role: "user", content: sourceMaterial }, ...recentMessages],
    tools: [],
    effectiveContextWindow: window
  }).used_tokens;
  // I1 预检：压缩请求自身（固定指令 + sourceMaterial）必须能装进窗口。超限直接
  // 拒绝（coordinator 按 compaction_source_exceeds_window 快速失败、不调用模型），
  // 绝不把超窗请求发给 provider——provider 拒绝只会让 Run 永久卡在 waiting_user。
  // 预算封顶已把常规超限消解掉，此检查是受保护近期原文/旧摘要超大时的兜底。
  const compactionRequestEstimate = estimateRequestUsage({
    messages: [
      { role: "system", content: COMPACTION_PROMPT },
      { role: "user", content: sourceMaterial }
    ],
    tools: [],
    effectiveContextWindow: window
  }).used_tokens;
  if (compactionRequestEstimate + OUTPUT_SAFETY_RESERVE >= window) {
    return {
      noop: false,
      too_large: true,
      reason: "source_exceeds_window",
      sourceMaterial,
      sourceState,
      recent_messages: recentMessages,
      open_tool_calls: openToolCalls,
      reload_from_workspace: sourceState.reload_from_workspace,
      estimated_tokens_before: estimatedTokensBefore,
      modelConfig: effectiveModelConfig
    };
  }
  return {
    sourceMaterial,
    sourceState,
    recent_messages: recentMessages,
    open_tool_calls: openToolCalls,
    reload_from_workspace: sourceState.reload_from_workspace,
    estimated_tokens_before: estimatedTokensBefore,
    modelConfig: effectiveModelConfig,
    noop: false
  };
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
    // I5：提交前最后确认取消。cancel 在指针切换前到达 → 取消优先（不切换指针、
    // 追加 cancelled）；指针切换后的取消竞态由 cancel() 按实际终态报告（completed
    // 绝不再追加 cancelled/failed——否则 journal 同时持有两个终态，UI 显示已取消
    // 而上下文其实已切换）。
    if (entry.state === "cancelling") {
      return finalizeCancelled(entry, entry.cancelReason ?? "user_cancel");
    }
    try {
      await checkpointStore.writeCandidate(candidate);
      await checkpointStore.validateCandidate(candidate, sourceState);
      const committed = await checkpointStore.commitCandidate(candidate, { journal, commitEvent, sourceState });
      // 提交成功（指针已切换）：即使 cancel 在提交期间到达，也按 completed 收敛——
      // 提交是原子事实，取消请求只是"没赶上"。
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
    entry.errorCode = errorCode;
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
    if (built?.too_large === true) {
      // I1：源材料超出压缩请求窗口——快速失败（不调用模型、不追加 started）。
      // Run 收敛到 waiting_user，错误码可诊断（compaction_source_exceeds_window）；
      // 输入保持 pending，用户可清空历史后重试，绝不把超窗请求发给 provider。
      entry.source = built ?? {};
      entry.state = "failed";
      const tooLargePayload = buildPayload(entry, {
        error_code: "compaction_source_exceeds_window",
        duration_ms: 0
      });
      assertPayloadComplete(tooLargePayload);
      await journal.append({ type: "context_compaction_failed", payload: tooLargePayload }).catch(() => {});
      return { status: "failed", compaction_id: compactionId, attempt: 1, error_code: "compaction_source_exceeds_window" };
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
    if (built?.too_large === true) {
      // I1：retry 重建源后仍超出窗口——与 start 同一快速失败语义（不调用模型）。
      entry.source = built ?? {};
      entry.state = "failed";
      const tooLargePayload = buildPayload(entry, {
        error_code: "compaction_source_exceeds_window",
        duration_ms: 0
      });
      assertPayloadComplete(tooLargePayload);
      await journal.append({ type: "context_compaction_failed", payload: tooLargePayload }).catch(() => {});
      return { status: "failed", compaction_id: compactionId, attempt: entry.attempt, error_code: "compaction_source_exceeds_window" };
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
      return actualOutcome(entry, compactionId);
    }
    // started/running → cancelling；底层结束后（entry.pending resolve）才返回终态。
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
    return actualOutcome(entry, compactionId);
  }

  // I5：cancel 等待期间 attempt 可能已推进到终态（提交与取消竞态）——按实际终态
  // 报告，绝不把"已成功提交（指针已切换）"的压缩误报为取消（否则调用方会把
  // 成功的压缩收敛成 input_cancelled + run_cancelled）。
  function actualOutcome(entry, compactionId) {
    if (entry.state === "completed") {
      return { status: "completed", compaction_id: compactionId, checkpoint_id: entry.checkpointId };
    }
    if (entry.state === "failed") {
      return { status: "failed", compaction_id: compactionId, error_code: entry.errorCode ?? null };
    }
    return { status: "cancelled", compaction_id: compactionId, cancel_reason: entry.cancelReason };
  }

  // 手动 /compact 预检后无可压缩历史：追加 context_compaction_noop（与 start/retry
  // 的 noop 同一事件形状）。压缩事件统一由本协调器落盘——runtime 只做输入侧预检
  // 与消费，不再直接写压缩事件。
  async function noop({ trigger, reason = "nothing_to_compact" } = {}) {
    await journal.append({
      type: "context_compaction_noop",
      payload: { compaction_id: idFactory(), trigger, reason }
    });
    return { status: "noop" };
  }

  return { start, retry, cancel, noop };
}
