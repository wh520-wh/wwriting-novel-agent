// tests/app-shell/state-handlers.test.mjs —— Task 14 对账测试：
// state.js 的 EVENT_HANDLERS 覆盖全部已知前端事件类型；连接类 code 单源集合齐全。
// 事件类型全集来自 applyEventToState 表化前的 switch case 全集（34 个具名 case）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENT_HANDLERS, CONNECTION_ERROR_CODES } from "../../src/app-shell/agent/state.js";

// 以 state.js applyEventToState 表化前 switch case 全集登记（34 个具名 case）：
// 24 独立 case + 5 组 fall-through 复合 case × 2。复合组（input_completed/
// input_interrupted、input_withdrawn/input_cancelled、context_compaction_running/
// context_compaction_cancel_requested、context_compaction_failed/
// context_compaction_cancelled、chapter_rolled_back/memory_file_restored）
// 共享同一 handler 函数，但表键按事件类型逐个登记。
const KNOWN_EVENT_TYPES = [
  "session_created",
  "input_queued",
  "input_started",
  "input_completed",
  "input_interrupted",
  "input_withdrawn",
  "input_cancelled",
  "priority_input_requested",
  "assistant_message_delta",
  "assistant_message_completed",
  "run_started",
  "run_status_changed",
  "interrupt_requested",
  "interrupt_safe_point_reached",
  "plan_updated",
  "model_turn_started",
  "model_turn_completed",
  "decision_requested",
  "decision_resolved",
  "run_failed",
  "connection_error",
  "run_completed",
  "run_cancelled",
  "run_interrupted",
  "context_usage_updated",
  "context_compaction_started",
  "context_compaction_running",
  "context_compaction_cancel_requested",
  "context_compaction_completed",
  "context_compaction_failed",
  "context_compaction_cancelled",
  "context_compaction_noop",
  "chapter_rolled_back",
  "memory_file_restored"
];

test("已知前端事件类型全部有 handler", () => {
  for (const type of KNOWN_EVENT_TYPES) {
    assert.equal(typeof EVENT_HANDLERS[type], "function", type);
  }
});

test("EVENT_HANDLERS 键数与已知事件类型全集相等（无遗漏无多余）", () => {
  assert.equal(Object.keys(EVENT_HANDLERS).length, KNOWN_EVENT_TYPES.length);
  const expected = new Set(KNOWN_EVENT_TYPES);
  for (const key of Object.keys(EVENT_HANDLERS)) {
    assert.ok(expected.has(key), `多余表键: ${key}`);
  }
});

test("CONNECTION_ERROR_CODES 覆盖两个流错误 code", () => {
  assert.ok(CONNECTION_ERROR_CODES.has("event_stream_error"));
  assert.ok(CONNECTION_ERROR_CODES.has("event_stream_fatal"));
});
