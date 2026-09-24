// tests/helpers/mock-adapter.mjs
//
// 2026-09-24 迁出 src/：测试专用 adapter 不入发布包（审计清理）。
//
// gateway 层测试 adapter（统一 Agent 内核计划 Task 3）。
//
// 本文件是 ModelGateway 的 mock adapter：与 openai-compatible.mjs 同形状的
// complete(request, { signal }) 接口，当前消费方为 tests/model/gateway.test.mjs
// 与 scripts/measure-auxiliary-share.mjs（runtime 层集成改用 harness 的
// createMockModelGateway——整网关 mock，与本 adapter 不同层，本文件可独立复用）。
//
// 能力：脚本化响应（文本 / 工具调用 / 错误 / 自定义函数）、usage 注入、
// 调用记录、可选延迟与外部取消。不含任何业务身份文本或工具定义表。

import { randomUUID } from "node:crypto";

const DEFAULT_REPLY = { text: "（mock 默认答复）" };

function createAbortableDelay(ms, signal) {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizeReply(reply, defaultUsage) {
  const base = reply && typeof reply === "object" ? reply : { text: String(reply ?? "") };
  return {
    text: typeof base.text === "string" ? base.text : "",
    toolCalls: Array.isArray(base.toolCalls) ? base.toolCalls : [],
    usage: base.usage ?? defaultUsage ?? null,
    raw: base.raw ?? null
  };
}

// script 条目（顺序消费；脚本耗尽后返回 DEFAULT_REPLY）：
//   { reply: { text } | { text, toolCalls: [{ id, name, arguments }] } }
//   { reply, usage }                       —— 为本次响应注入 usage（默认 defaultUsage）
//   { error: Error }                       —— 该轮模型调用抛错
//   (request) => reply                     —— 自定义断言/返回（可返回 { error }）
//   { reply, repeat: true }                —— 不消费脚本游标（可无限复用）
export function createMockAdapter({ script = [], delayMs = 0, defaultUsage = null, onCall = null } = {}) {
  if (!Array.isArray(script)) {
    throw new TypeError("createMockAdapter 的 script 必须是数组");
  }
  const calls = [];
  let cursor = 0;

  const adapter = {
    calls,
    async complete(request, { signal } = {}) {
      const startedAt = Date.now();
      const entry = script[cursor] ?? null;
      if (entry && !entry.repeat) cursor += 1;

      let rawReply;
      if (typeof entry === "function") {
        rawReply = await entry(request);
      } else if (entry?.error) {
        rawReply = { error: entry.error };
      } else if (entry?.reply) {
        rawReply = entry.reply;
      } else {
        rawReply = DEFAULT_REPLY;
      }

      const error = rawReply?.error ?? null;
      const reply = error ? null : normalizeReply(rawReply, entry?.usage ?? defaultUsage);

      // 先记录调用再等待延迟：外部取消/超时中断的 attempt 也可被观察
      const record = { request, reply, error, startedAt, finishedAt: null };
      calls.push(record);
      onCall?.({ request, reply, error, index: calls.length - 1 });

      try {
        if (delayMs > 0) await createAbortableDelay(delayMs, signal);
        if (error) throw error;
        record.finishedAt = Date.now();
        return {
          text: reply.text,
          toolCalls: reply.toolCalls,
          raw: reply.raw ?? { provider: "mock", request },
          usage: reply.usage ?? {},
          cost: null
        };
      } catch (caught) {
        record.finishedAt = Date.now();
        throw caught;
      }
    }
  };
  return adapter;
}

// 便捷工具调用构造：{ id, name, arguments }（arguments 为已解析对象）。
export function toolCall(name, args = {}, id = null) {
  return {
    id: id ?? `call_${name}_${randomUUID().slice(0, 8)}`,
    name,
    arguments: args
  };
}
