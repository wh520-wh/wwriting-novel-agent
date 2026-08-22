// transcript/checkpoint -> 模型消息装配层（Task 7 / F5a：runtime 拆分第一步）。
//
// 全部函数无磁盘写入（journal/checkpoint 只读），状态归属 journal（不变量 1）。
// 本模块含两类导出：
//   - 纯转换函数（直接 export）：transcriptToMessages / checkpointToMessages /
//     buildTurnsFromTranscript / collectOpenToolCalls / summarizeLargeToolMessages /
//     degradeVolatileToolRecords——不读任何存储，runtime 的 buildCompactionSource
//     也从这里 import。
//   - 工厂 createHistoryAssembly：buildHistory 需要读 journal transcript 与
//     checkpoint 文件，经闭包注入 { journal, checkpointStore }。storageRoot/
//     redactor 不需要注入：本层不直接触盘（存储路径由 journal/checkpointStore
//     内部持有），落盘脱敏由 journal 层完成（appendSafeTranscript，见 journal.mjs）。

import { estimateTokens } from "./prompt.mjs";
import { DEFAULT_TOOL_OUTPUT_THRESHOLD, buildToolOutputSummary } from "./compaction-prompt.mjs";

// 无 active checkpoint 时 buildHistory 只读取最近 HISTORY_PAGE_LIMIT 条 transcript
// 原文（受保护近期原文 + 门禁所需的向前页），绝不为装配 prompt 把全部 transcript
// 载入内存；达到阈值即先压缩。原 runtime.mjs 模块级常量（Task 7 随装配层迁入，
// runtime 从本模块 import，保持单一来源）。
export const HISTORY_PAGE_LIMIT = 8000;

// transcript 记录 → 干净的 OpenAI 消息形状（去掉 input_id 等内部字段）。
// assistant 的 tool_calls 必须还原为 OpenAI 线上格式（{ id, type: "function",
// function: { name, arguments: JSON 字符串 } }）——transcript 里存的是内部规范
// 形状 { id, name, arguments(对象) }（Task 11 Step 4 真实模型验证发现 DeepSeek/
// 小米等 OpenAI-compatible 提供方对扁平 tool_calls 直接 400）。
//
// Rule 7 职责边界：wire 转换放在 runtime（而不是 adapter）的取舍——runtime 是
// 唯一同时拥有 transcript 内部形状与「请求必须适配提供方言」信息的装配点，
// adapter 保持窄而薄（只做传输与响应归一化）。当前线上形状按 OpenAI 方言
// 固定；未来若接入要求其它 tool_calls 形状的提供方（如 Anthropic 的
// { id, name, input }），应由 provider-aware 转换（在 gateway 的
// dispatchAdapter 或按 provider 分支的 serializer）扩展，不要改 transcript 形状。
export function transcriptToMessages(records) {
  const messages = [];
  for (const record of records) {
    if (record?.role === "user") {
      messages.push({ role: "user", content: String(record.content ?? "") });
    } else if (record?.role === "assistant") {
      const message = { role: "assistant", content: record.content ?? null };
      if (Array.isArray(record.tool_calls) && record.tool_calls.length > 0) {
        message.tool_calls = record.tool_calls.map((tc) => {
          const rawArguments = tc?.arguments;
          // 线上格式要求 arguments 是 JSON 对象字符串。number/boolean 等标量
          // 不是合法 arguments 对象，序列化后同样不是对象——统一回落空对象，
          // 避免把 "5" 这类字符串当参数发给提供方。
          const argumentsText =
            rawArguments != null && typeof rawArguments === "object"
              ? JSON.stringify(rawArguments)
              : typeof rawArguments === "string"
                ? rawArguments
                : "{}";
          return {
            id: tc?.id ?? null,
            type: "function",
            function: {
              name: tc?.name ?? null,
              arguments: argumentsText
            }
          };
        });
      }
      messages.push(message);
    } else if (record?.role === "tool") {
      messages.push({
        role: "tool",
        tool_call_id: record.tool_call_id ?? null,
        content: String(record.content ?? "")
      });
    }
  }
  return messages;
}

// Task 8：历史装配不再无界读取全部 transcript。有 active checkpoint 时展开
// 结构化摘要 + checkpoint 近期原文，再 readTranscriptAfter({ afterSeq:
// checkpoint.source_transcript_seq.end }) 补增量；没有 checkpoint 时只读取
// 受保护近期原文（尾部一页）——达到阈值由预检门禁先压缩，绝不为装配 prompt
// 把全部 transcript 载入内存。当前正在处理的输入从历史中排除（它以
// currentInput 单独入 prompt）。
export function createHistoryAssembly({ journal, checkpointStore }) {
  // buildHistory 的存储依赖只有这两个：journal（readTranscriptAfter/
  // readTranscriptTail 读增量/尾页）与 checkpointStore（readActive/
  // readCheckpointFile 读活动 checkpoint）。不直接触盘、不脱敏，故不需要
  // storageRoot/redactor——原 runtime 调用点传入的 storageRoot 仅为签名残留，
  // 函数体并不使用（Task 7 拆除）。
  async function buildHistory({ excludeInputId = null, volatileRecords = [] }) {
    const volatileToolCallIds = new Set();
    for (const record of volatileRecords) {
      if (record?.role === "tool") volatileToolCallIds.add(record.tool_call_id ?? null);
      for (const toolCall of record?.tool_calls ?? []) {
        volatileToolCallIds.add(toolCall?.id ?? null);
      }
    }
    const filter = (records) =>
      records
        .filter((record) => !(excludeInputId != null && record.input_id != null && record.input_id === excludeInputId))
        .filter((record) => {
          if (record?.role === "tool") return !volatileToolCallIds.has(record.tool_call_id);
          if (record?.role === "assistant" && Array.isArray(record.tool_calls)) {
            return !record.tool_calls.some((toolCall) => volatileToolCallIds.has(toolCall?.id));
          }
          return true;
        });
    const pointer = await checkpointStore.readActive();
    if (pointer.checkpoint_id != null) {
      const checkpoint = await checkpointStore.readCheckpointFile(pointer.checkpoint_id).catch(() => null);
      if (checkpoint != null) {
        const delta = await journal.readTranscriptAfter({ afterSeq: checkpoint.source_transcript_seq?.end ?? 0 });
        return [...checkpointToMessages(checkpoint), ...transcriptToMessages([...filter(delta), ...volatileRecords])];
      }
    }
    const tail = await journal.readTranscriptTail({ limit: HISTORY_PAGE_LIMIT });
    return transcriptToMessages([...filter(tail), ...volatileRecords]);
  }
  return { buildHistory };
}

// 展开 active checkpoint：结构化摘要 → 独立 user 块（历史层），随后是 checkpoint
// 近期原文（已存为合法消息链，直接作为消息）。open_tool_calls 是恢复元数据，
// 未闭合调用链本身已包含在 recent_messages 内。
export function checkpointToMessages(checkpoint) {
  const messages = [];
  if (checkpoint?.summary != null && typeof checkpoint.summary === "object") {
    messages.push({ role: "user", content: `[上下文压缩摘要]\n${JSON.stringify(checkpoint.summary, null, 2)}` });
  }
  if (Array.isArray(checkpoint?.recent_messages)) {
    messages.push(...checkpoint.recent_messages);
  }
  return messages;
}

// 从 transcript 记录重建"轮次"（一轮 = 一条 user input 与其 assistant 正文）。
// 返回 selectProtectedRecentTurns 可用的 turns（含 transcript_seq 范围与
// tool_activities）。transcript 不存 result_summary，已闭合大输出保留原文，
// 由 protected 窗口语义决定是否进入摘要。
export function buildTurnsFromTranscript(records) {
  const turns = [];
  let current = null;
  const push = () => {
    if (current) turns.push(current);
    current = null;
  };
  const fresh = (seq) => ({
    id: seq != null ? `turn-${seq}` : `turn-${turns.length}`,
    user_text: "",
    assistant_text: null,
    transcript_seq_start: seq,
    transcript_seq_end: seq,
    token_estimate: null,
    tool_activities: []
  });
  for (const record of records ?? []) {
    const seq = record?.transcript_seq ?? null;
    if (record?.role === "user") {
      push();
      current = fresh(seq);
      current.user_text = String(record.content ?? "");
    } else if (record?.role === "assistant") {
      if (!current) current = fresh(seq);
      if (typeof record.content === "string" && record.content.length > 0) current.assistant_text = record.content;
      current.transcript_seq_end = seq;
      for (const toolCall of record?.tool_calls ?? []) {
        current.tool_activities.push({
          tool_call_id: toolCall?.id ?? toolCall?.tool_call_id ?? null,
          name: toolCall?.name ?? null,
          status: "open",
          arguments: toolCall?.arguments ?? null,
          output: null,
          result_summary: null,
          journal_ref: seq != null ? `transcript ${seq}` : null
        });
      }
    } else if (record?.role === "tool") {
      if (!current) current = fresh(seq);
      current.transcript_seq_end = seq;
      const id = record?.tool_call_id ?? null;
      const activity = current.tool_activities.find((a) => a.tool_call_id === id);
      if (activity) {
        activity.status = "closed";
        activity.output = String(record.content ?? "");
      } else {
        current.tool_activities.push({
          tool_call_id: id,
          name: record?.name ?? null,
          status: "closed",
          arguments: null,
          output: String(record.content ?? ""),
          result_summary: null,
          journal_ref: seq != null ? `transcript ${seq}` : null
        });
      }
    }
  }
  push();
  return turns;
}

export function collectOpenToolCalls(protectedTurns, inherited) {
  const open = [];
  for (const turn of protectedTurns) {
    for (const activity of turn?.tool_activities ?? []) {
      if (activity?.status === "open") {
        open.push({
          tool_call_id: activity.tool_call_id ?? null,
          name: activity.name ?? null,
          status: "open",
          arguments: activity.arguments ?? null,
          journal_ref: activity.journal_ref ?? null
        });
      }
    }
  }
  return open.length > 0 ? open : Array.isArray(inherited) ? inherited : [];
}

// 防御性截断：旧 checkpoint 的 recent_messages 可能由修复前的代码生成（大工具
// 输出全文进消息链）。压缩请求只带截断摘要 + Journal 引用，超大 tool 消息不进
// sourceMaterial（否则二次压缩的请求会被旧数据撑爆，重蹈 source_exceeds_window）。
export function summarizeLargeToolMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const out = messages.map((message) => {
    if (message?.role !== "tool") return message;
    const content = String(message.content ?? "");
    if (estimateTokens(content) <= DEFAULT_TOOL_OUTPUT_THRESHOLD) return message;
    changed = true;
    return {
      ...message,
      content: buildToolOutputSummary(content, { journalRef: null })
    };
  });
  return changed ? out : messages;
}

// 第十一轮（压缩审计发现 1）：volatile 大工具输出是压缩的盲区。压缩源材料
// 只重建持久 transcript（大输出已被 persistentToolResult 剥离），本轮运行的
// 新鲜大输出只存在于内存 volatileToolRecords--门禁看到超窗、压缩却 noop，
// 最终 failRun(context_window_exceeded)，下一条输入 volatile 过期自愈（用户
// 看到「报错、重发又好了」）。本 helper 在「已压缩仍超硬窗口」的最后关头把
// 超过 transcript 同一阈值的 volatile 输出降级为本地截断摘要：有窗口余量时
// 保留全文（先读后写），只在否则必失败时降级。
export function degradeVolatileToolRecords(records) {
  let degraded = 0;
  for (const record of records ?? []) {
    if (record?.role !== "tool") continue;
    const content = String(record.content ?? "");
    if (estimateTokens(content) <= DEFAULT_TOOL_OUTPUT_THRESHOLD) continue;
    record.content = buildToolOutputSummary(content, { journalRef: null });
    degraded += 1;
  }
  return degraded;
}
