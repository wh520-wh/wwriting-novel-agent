// src/core/agent/stream-writer.mjs —— Provider token 的低开销持久化出口（Task 4）。
//
// 从 runtime.mjs 原有的私有 createAssistantDeltaWriter 抽取为共享实现：公开正文
// 使用 eventType "assistant_message_delta"，reasoning 使用 "reasoning_delta"。
// 保留原有语义：
//   - 回调只同步入队，按一帧左右的时间窗口（flushMs，默认 24ms）合并，且任何时刻
//     最多一个 journal 写入在途（单 in-flight）；
//   - pending 缓冲达到 maxPendingChars（默认 2048 字）时立即落盘，不等时间窗；
//   - 流式脱敏（createStreamingRedactor）：跨 token 的 secret 在增量与终态使用
//     同一脱敏结果；finish({ flushTail: false }) 只排空已确认安全的前缀，不 flush
//     可能仍是半截密钥的 carry；
//   - 增量落盘失败不能把已成功的模型调用误报为失败（completed 仍携带权威全文）；
//   - push() 返回累积 rawText；finish() 返回 { rawText, safeText }。
//
// §2.1 纪律：onToken 只接收公开正文、onReasoningToken 只接收 reasoning，两者不得
// 互相兜底。reasoning 只存在 journal reasoning 事件，绝不写入 provider history。
import { createStreamingRedactor } from "../shell/redaction.mjs";

// reasoning 可用性三态（冻结契约 §2.3）：只看 capability 与本轮已确认安全的内容。
//   text.length > 0         -> "available"
//   capability "unsupported" -> "unsupported"
//   其余（含 "unknown"）      -> "empty"
export function reasoningAvailability(capability, text) {
  if (text.length > 0) return "available";
  if (capability === "unsupported") return "unsupported";
  return "empty";
}

export function createJournalDeltaWriter({
  journal,
  eventType,
  runId,
  basePayload,
  secrets,
  flushMs = 24,
  maxPendingChars = 2048
}) {
  const streamingRedactor = createStreamingRedactor({ secrets });
  let rawText = "";
  let safeText = "";
  let pending = "";
  let timer = null;
  let inFlight = null;
  let closed = false;

  const schedule = () => {
    if (closed || timer !== null || inFlight || pending.length === 0) return;
    timer = setTimeout(pump, flushMs);
  };

  const appendSafe = (text) => {
    if (!text) return;
    safeText += text;
    pending += text;
    if (pending.length >= maxPendingChars && !inFlight) {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pump();
    } else {
      schedule();
    }
  };

  function pump() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (inFlight || pending.length === 0) return;
    const text = pending;
    pending = "";
    inFlight = journal.append({
      type: eventType,
      run_id: runId,
      payload: { ...basePayload, text }
    }).catch(() => {
      // completed 仍携带权威全文；增量落盘失败不能把已成功的模型调用误报为失败。
    }).finally(() => {
      inFlight = null;
      if (pending.length >= maxPendingChars) {
        pump();
      } else {
        schedule();
      }
    });
  }

  return {
    get rawText() {
      return rawText;
    },
    push(token) {
      if (closed) return rawText;
      const raw = String(token ?? "");
      if (!raw) return rawText;
      rawText += raw;
      appendSafe(streamingRedactor.push(raw));
      return rawText;
    },
    async finish({ flushTail = true } = {}) {
      if (!closed) {
        if (flushTail) appendSafe(streamingRedactor.flush());
        closed = true;
      }
      if (timer !== null) clearTimeout(timer);
      timer = null;
      while (inFlight || pending.length > 0) {
        if (!inFlight) pump();
        if (inFlight) await inFlight;
      }
      return { rawText, safeText };
    }
  };
}
