// src/core/agent-transcript.mjs
// 写作 agent 多轮 tool transcript：保存完整消息链（assistant tool_calls + reasoning_content + role=tool 结果）。
// 解决 DeepSeek thinking 模型多轮 tool 调用要求回传 reasoning_content 的问题（E2/E13）。
// 序列化用于 pending 文件 + checkpoint 备份，恢复时识别 pendingToolCalls（进程中断后未回传结果的 tool_call）。
//
// tool result 截断：超 TOOL_RESULT_MAX_CHARS 字符截断，防多轮 transcript 膨胀超模型上下文
// （对齐 chat-agent.mjs 的 RESULT_SUMMARY_CHARS=4000）。

const TOOL_RESULT_MAX_CHARS = 4000;

export class ToolTranscript {
  constructor() {
    this.messages = [];
  }

  appendUser(content) {
    this.messages.push({ role: "user", content: String(content ?? "") });
  }

  appendAssistant({ content = null, tool_calls = null, reasoning_content = null } = {}) {
    const msg = { role: "assistant" };
    if (content) msg.content = content;
    if (tool_calls && tool_calls.length > 0) msg.tool_calls = tool_calls;
    if (reasoning_content) msg.reasoning_content = reasoning_content;
    this.messages.push(msg);
  }

  appendToolResult(toolCallId, result) {
    const raw = typeof result === "string" ? result : JSON.stringify(result ?? {});
    const content = raw.length > TOOL_RESULT_MAX_CHARS
      ? `${raw.slice(0, TOOL_RESULT_MAX_CHARS)}…`
      : raw;
    this.messages.push({ role: "tool", tool_call_id: toolCallId, content });
  }

  toMessages() {
    return this.messages;
  }

  get pendingToolCalls() {
    const pending = [];
    for (let i = 0; i < this.messages.length; i += 1) {
      const msg = this.messages[i];
      if (msg.role !== "assistant" || !msg.tool_calls) continue;
      for (const tc of msg.tool_calls) {
        if (!tc.id) continue;
        const hasResult = this.messages
          .slice(i + 1)
          .some((m) => m.role === "tool" && m.tool_call_id === tc.id);
        if (!hasResult) pending.push(tc);
      }
    }
    return pending;
  }

  // 序列化为独立快照（消息均为浅层对象，浅拷贝即可），后续 append 不影响已序列化结果
  serialize() {
    return { messages: this.messages.map((m) => ({ ...m })) };
  }

  static restore(serialized) {
    const t = new ToolTranscript();
    t.messages = Array.isArray(serialized?.messages) ? serialized.messages : [];
    return t;
  }
}
