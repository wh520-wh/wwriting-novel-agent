// 第九轮：systemNotices 投影测试（chapter_rolled_back / memory_file_restored → timeline）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createState, reduceEvent } from "../../src/app-shell/agent/state.js";

test("chapter_rolled_back 投影进 systemNotices", () => {
  const state = createState();
  reduceEvent(state, {
    seq: 10,
    type: "chapter_rolled_back",
    payload: { chapter_no: 3, from_version: 5, to_version: 2 }
  });
  assert.equal(state.systemNotices.length, 1);
  assert.equal(state.systemNotices[0].seq, 10);
  assert.equal(state.systemNotices[0].type, "chapter_rolled_back");
  assert.equal(state.systemNotices[0].payload.chapter_no, 3);
  assert.equal(state.systemNotices[0].payload.to_version, 2);
});

test("memory_file_restored 投影进 systemNotices", () => {
  const state = createState();
  reduceEvent(state, {
    seq: 11,
    type: "memory_file_restored",
    payload: { file: "worklog", to_version: 4 }
  });
  assert.equal(state.systemNotices.length, 1);
  assert.equal(state.systemNotices[0].type, "memory_file_restored");
  assert.equal(state.systemNotices[0].payload.file, "worklog");
});

test("多个通知依次追加，bump notices revision", () => {
  const state = createState();
  const baseline = state.revisions.notices;
  reduceEvent(state, {
    seq: 10,
    type: "chapter_rolled_back",
    payload: { chapter_no: 3, from_version: 5, to_version: 2 }
  });
  reduceEvent(state, {
    seq: 11,
    type: "memory_file_restored",
    payload: { file: "worklog", to_version: 4 }
  });
  assert.equal(state.systemNotices.length, 2);
  assert.ok(state.revisions.notices > baseline, "notices revision should increment");
});

test("systemNotices 是 payload 的深拷贝（互不影响）", () => {
  const state = createState();
  const payload = { chapter_no: 7, to_version: 1 };
  reduceEvent(state, { seq: 20, type: "chapter_rolled_back", payload });
  payload.chapter_no = 99;
  assert.equal(state.systemNotices[0].payload.chapter_no, 7);
});

test("未知事件类型不进入 systemNotices", () => {
  const state = createState();
  reduceEvent(state, { seq: 30, type: "run_completed", payload: {} });
  assert.equal(state.systemNotices.length, 0);
});
