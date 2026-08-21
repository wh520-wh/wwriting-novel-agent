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

test("N2: Run 终态后非最终 assistant 消息标记 narration，最终一条不标记", () => {
  const state = createState();
  reduceEvent(state, ev("run_started", { input_id: "in-1" }, 1));
  reduceEvent(state, ev("assistant_message_completed", { input_id: "in-1", text: "先读一下大纲" }, 2));
  reduceEvent(state, ev("assistant_message_completed", { input_id: "in-1", text: "写完了，本章交付" }, 3));
  reduceEvent(state, ev("run_completed", {}, 4));
  const texts = state.conversation.filter((m) => m.role === "assistant");
  assert.equal(texts.length, 2);
  assert.equal(texts[0].narration, true, "先说的那句是叙述");
  assert.equal(texts[1].narration, undefined, "最终交付不是叙述（未标记字段不写）");
});

test("N2: 窗口缺 run_started（F11 尾页）时无 narration 标记", () => {
  // 规格 F11 同场景：尾页加载，Run 起点落在已加载窗口之外，没有 run_started。
  // runConversationStart 为 null——宁可不标不可误标。
  const state = createState();
  reduceEvent(state, ev("assistant_message_completed", { input_id: "in-1", text: "先读一下大纲" }, 1));
  reduceEvent(state, ev("assistant_message_completed", { input_id: "in-1", text: "写完了，本章交付" }, 2));
  reduceEvent(state, ev("run_completed", {}, 3));
  const texts = state.conversation.filter((m) => m.role === "assistant");
  assert.equal(texts.length, 2);
  assert.equal(texts[0].narration, undefined, "无 run_started（窗口起点未知）第一条不标");
  assert.equal(texts[1].narration, undefined, "无 run_started（窗口起点未知）最终一条不标");
});

test("N2: waiting_user 暂停→resume→终态仍标暂停前叙述（整 Run 窗口语义）", () => {
  // 钉住「Run 窗口 = run_started 到最终终态」：resume 不发 run_started，暂停期间
  // runConversationStart 不得被清掉或重设，否则暂停前叙述会在最终终态漏标。
  const state = createState();
  reduceEvent(state, ev("run_started", { input_id: "in-1" }, 1));
  reduceEvent(state, ev("assistant_message_completed", { input_id: "in-1", text: "先读一下大纲" }, 2));
  reduceEvent(state, ev("run_status_changed", { status: "waiting_user" }, 3));
  reduceEvent(state, ev("run_status_changed", { status: "running" }, 4));
  reduceEvent(state, ev("assistant_message_completed", { input_id: "in-1", text: "写完交付" }, 5));
  reduceEvent(state, ev("run_completed", {}, 6));
  const texts = state.conversation.filter((m) => m.role === "assistant");
  assert.equal(texts.length, 2);
  assert.equal(texts[0].narration, true, "暂停前的叙述在最终终态仍标 narration");
  assert.equal(texts[1].narration, undefined, "恢复后的交付是最终一条，不标");
});

test("N2: 重建确定性——乱序重放后 narration 标记与增量路径一致", () => {
  const events = [
    ev("run_started", { input_id: "in-1" }, 1),
    ev("assistant_message_completed", { input_id: "in-1", text: "先读一下大纲" }, 2),
    ev("assistant_message_completed", { input_id: "in-1", text: "写完了，本章交付" }, 3),
    ev("run_completed", {}, 4)
  ];
  // 增量基准：按序送达。
  const control = createState();
  for (const event of events) reduceEvent(control, event);
  // 乱序送达（SSE 重排）：run_completed 先到、两条 completed 后到——seq 2/3 <
  // lastSeq 4 触发 rebuildDerivedState 按 (seq, event_key) 全量重放，narration
  // 由重放中的 run_completed 统一施加，与增量路径一致。
  const state = createState();
  reduceEvent(state, events[0]);
  reduceEvent(state, events[3]);
  reduceEvent(state, events[1]);
  reduceEvent(state, events[2]);
  assert.deepEqual(state.conversation, control.conversation, "重建与增量路径的 conversation（含 narration）必须逐字段一致");
  const texts = state.conversation.filter((m) => m.role === "assistant");
  assert.equal(texts.length, 2);
  assert.equal(texts[0].narration, true, "重建后第一条仍标 narration");
  assert.equal(texts[1].narration, undefined, "重建后最终一条不标");
  // 再触发一次重建（seq 1.5 < lastSeq 4）：narration 标记不漂移。
  reduceEvent(state, ev("input_withdrawn", { input_id: "in-x" }, 1.5));
  const rebuilt = state.conversation.filter((m) => m.role === "assistant");
  assert.equal(rebuilt[0].narration, true, "重复重建后 narration 不漂移");
  assert.equal(rebuilt[1].narration, undefined);
});

test("F5: 连接错误同 code 去重，非连接事件到达即清卡", () => {
  const state = createState();
  reduceEvent(state, ev("connection_error", { code: "event_stream_error", message: "第一次" }, 1));
  reduceEvent(state, ev("connection_error", { code: "event_stream_error", message: "第二次" }, 2));
  assert.equal(state.errors.length, 1, "同 code 只留一张可更新的卡");
  assert.equal(state.errors[0].message, "第二次");
  reduceEvent(state, ev("run_status_changed", { status: "running" }, 3));
  assert.equal(state.errors.length, 0, "非连接事件到达（流恢复）即清卡（F5）");
});

test("第十二轮 F11：无 active_run 时 plan_updated 也投影顶层 plan", () => {
  const state = createState();
  reduceEvent(state, ev("plan_updated", { explanation: "计划", items: [{ step: "1", status: "pending" }] }, 1));
  assert.ok(state.plan && Array.isArray(state.plan.items) && state.plan.items.length === 1,
    "顶层 plan 投影不依赖 active_run 在场（F11 尾页窗口口径）");
  // 空 items：计划清空 → 顶层投影收敛为 null（chip 隐藏口径一致）。
  reduceEvent(state, ev("plan_updated", { explanation: "", items: [] }, 2));
  assert.equal(state.plan, null, "空 items 后顶层 plan 收敛为 null");
});
