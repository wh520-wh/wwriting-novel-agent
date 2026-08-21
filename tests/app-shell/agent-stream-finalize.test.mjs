// 第十二轮 F1/N2：终态定稿流式正文 + narration 标记（纯投影，无 DOM）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createState, reduceEvent } from "../../src/app-shell/agent/state.js";

function ev(type, payload, seq, extra = {}) {
  return { seq, event_id: `evt-${seq}`, session_id: "sess-1", run_id: "run-1", at: `2026-08-21T00:00:${String(seq).padStart(2, "0")}Z`, type, payload, ...extra };
}

function runToCancelled() {
  const state = createState();
  reduceEvent(state, ev("run_started", { input_id: "in-1" }, 1));
  reduceEvent(state, ev("assistant_message_delta", { text: "写到一半" }, 2));
  reduceEvent(state, ev("run_cancelled", {}, 3));
  return state;
}

test("F1: run_cancelled 把未定稿正文定稿为带 interrupted 标记的气泡", () => {
  const state = runToCancelled();
  assert.equal(state.assistantStream, null, "流式槽必须清空");
  const entry = state.conversation.find((m) => m.role === "assistant");
  assert.ok(entry, "必须产生 assistant 消息");
  assert.equal(entry.text, "写到一半");
  assert.equal(entry.interrupted, true);
});

test("F1: run_failed / run_interrupted / waiting_user 同样定稿", () => {
  for (const [type, payload] of [["run_failed", { error: "x" }], ["run_interrupted", {}], ["run_status_changed", { status: "waiting_user" }]]) {
    const state = createState();
    reduceEvent(state, ev("run_started", { input_id: "in-1" }, 1));
    reduceEvent(state, ev("assistant_message_delta", { text: "部分" }, 2));
    reduceEvent(state, ev(type, payload, 3));
    assert.equal(state.assistantStream, null, `${type} 后流式槽必须清空`);
    const entry = state.conversation.find((m) => m.role === "assistant");
    assert.ok(entry, `${type} 后必须有定稿气泡`);
    assert.equal(entry.text, "部分", `${type} 保留流式累积正文`);
    assert.equal(entry.interrupted, true, `${type} 定稿带 interrupted 标记`);
    assert.equal(entry.event_key, "finalize:3", `${type} 定稿用稳定 event_key`);
  }
});

test("F1: run_completed 终态同样定稿（5 个终态缺测的 completed）", () => {
  const state = createState();
  reduceEvent(state, ev("run_started", { input_id: "in-1" }, 1));
  reduceEvent(state, ev("assistant_message_delta", { text: "将完" }, 2));
  reduceEvent(state, ev("run_completed", {}, 3));
  assert.equal(state.assistantStream, null, "run_completed 后流式槽必须清空");
  const entry = state.conversation.find((m) => m.role === "assistant");
  assert.ok(entry, "run_completed 后必须有定稿气泡");
  assert.equal(entry.text, "将完");
  assert.equal(entry.interrupted, true);
});

test("F1: retry（run_started 重开同 run）先定稿残留再清空，不再静默删除", () => {
  const state = createState();
  reduceEvent(state, ev("run_started", { input_id: "in-1" }, 1));
  reduceEvent(state, ev("assistant_message_delta", { text: "半截" }, 2));
  reduceEvent(state, ev("run_failed", { error: "x" }, 3));
  reduceEvent(state, ev("run_started", { input_id: "in-2" }, 4));
  const texts = state.conversation.filter((m) => m.role === "assistant").map((m) => m.text);
  assert.ok(texts.includes("半截"), "retry 后半截正文必须保留");
  assert.equal(state.assistantStream, null);
});

test("F1: 空流不产生气泡（纯轮次标记）", () => {
  const state = createState();
  reduceEvent(state, ev("run_started", { input_id: "in-1" }, 1));
  reduceEvent(state, ev("run_cancelled", {}, 2));
  assert.equal(state.conversation.filter((m) => m.role === "assistant").length, 0);
});

test("F1: 重建确定性——乱序重放与增量路径派生态一致，finalize 不重复插入", () => {
  const events = [
    ev("run_started", { input_id: "in-1" }, 1),
    ev("assistant_message_delta", { text: "将完" }, 2),
    ev("run_cancelled", {}, 3)
  ];
  // 增量基准：按序送达。
  const control = createState();
  for (const event of events) reduceEvent(control, event);
  // 乱序送达（SSE 重排/前置页补齐）：run_cancelled 先到、delta 后到，
  // seq 2 < lastSeq 3 触发 rebuildDerivedState 按 (seq, event_key) 全量重放。
  const state = createState();
  reduceEvent(state, events[0]);
  reduceEvent(state, events[2]);
  reduceEvent(state, events[1]);
  assert.deepEqual(state.conversation, control.conversation, "重建与增量路径的 conversation 必须逐字段一致");
  assert.equal(state.conversation.length, 1, "finalize 消息只有一条");
  const entry = state.conversation[0];
  assert.equal(entry.event_key, "finalize:3", "重建后 event_key 与增量路径一致");
  assert.equal(entry.text, "将完");
  assert.equal(entry.interrupted, true);
  assert.equal(state.assistantStream, null);
  // 再次乱序触发一次重建：仍不重复插入，event_key 不变。
  reduceEvent(state, ev("input_withdrawn", { input_id: "in-x" }, 1.5));
  assert.equal(state.conversation.length, 1, "重复重建不得重复插入 finalize 气泡");
  assert.equal(state.conversation[0].event_key, "finalize:3");
});
