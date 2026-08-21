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
  }
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