// 统一活动事件工厂：思考、工具执行、Shell 增量输出、停止都经同一 chat_activity 事件流出
// （onEvent -> SSE），前端据此驱动活动流 UI。activity_id 是同一活动的稳定锚点：
// 增量输出复用同一 id 追加 output_delta，终态事件带 exit_code / duration_ms / error。
// 每次调用返回 activity_id，调用方（chat-agent）用它串联同一活动的后续事件。
import crypto from "node:crypto";

export function createChatActivityEmitter({ turnId, onEvent = () => {} }) {
  return function activity(event = {}) {
    const payload = {
      type: "chat_activity",
      turn_id: turnId,
      activity_id: event.activity_id ?? crypto.randomUUID(),
      state: event.state,
      phase: event.phase,
      tool: event.tool ?? null,
      label: event.label ?? "",
      args: event.args ?? null,
      command: event.command ?? null,
      cwd: event.cwd ?? null,
      output_delta: event.output_delta ?? "",
      exit_code: event.exit_code ?? null,
      duration_ms: event.duration_ms ?? null,
      error: event.error ?? null,
      ts: new Date().toISOString()
    };
    onEvent(payload);
    return payload.activity_id;
  };
}
