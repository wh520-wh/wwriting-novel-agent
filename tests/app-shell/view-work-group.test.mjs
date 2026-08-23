// Task 16（第十五轮）：view/work-group.mjs 分区纯函数契约测试。
//
// 覆盖：
//   - groupLiveElapsedMs：工作组投影时钟——activeSince 活动窗口按 now 实时累计、
//     waiting_user/终态冻结（activeSince 为 null 只取 activeMs）、非法输入归零；
//   - workGroupKey：runId + firstSeq 稳定时间线键；
//   - reasoningDetailText：availability 分支文案与正文回传。
// 三个纯函数均无闭包依赖，模块级直接导出，无需构造 ctx。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  groupLiveElapsedMs,
  workGroupKey,
  reasoningDetailText
} from "../../src/app-shell/agent/view/work-group.mjs";

test("groupLiveElapsedMs：运行中按 activeSince 实时累计、终态冻结、非法输入归零", () => {
  const now = Date.parse("2026-08-23T10:00:00Z");
  // 活动窗口：activeMs 0 + (now - activeSince) = 0 + 20000
  assert.equal(groupLiveElapsedMs({ activeMs: 0, activeSince: "2026-08-23T09:59:40Z" }, now), 20000);
  // 冻结（waiting_user/终态 activeSince 为 null）：只返回已累计 activeMs
  assert.equal(groupLiveElapsedMs({ activeMs: 12345, activeSince: null }, now), 12345);
  // 非法输入：null group / 非数字 activeMs 一律归零
  assert.equal(groupLiveElapsedMs(null, now), 0);
  assert.equal(groupLiveElapsedMs({ activeMs: "abc" }, now), 0);
});

test("workGroupKey：runId + firstSeq 稳定组合键", () => {
  assert.equal(workGroupKey({ id: "run-1", firstSeq: 7 }), "work:run-1:7");
  assert.equal(workGroupKey({ id: "run-1", firstSeq: 42 }), "work:run-1:42");
});

test("reasoningDetailText：availability 分支文案与正文回传", () => {
  const emptyText = "没有可查看的思考内容（本次无输出或该模型不支持）";
  assert.equal(reasoningDetailText({ availability: "unsupported" }), "当前模型不支持查看");
  assert.equal(reasoningDetailText({ availability: "empty" }), emptyText);
  assert.equal(reasoningDetailText({ availability: "available", text: "" }), emptyText);
  assert.equal(reasoningDetailText({ availability: "available", text: " 思考过程 " }), " 思考过程 ");
});