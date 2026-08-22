// 第十五轮 Task 4 对账红线：FIXED_EVENT_TYPES 里每个事件类型都必须在
// EVENT_HANDLERS 表里有 handler，且表键数 = FIXED_EVENT_TYPES 长度——
// reduceEvent 巨型 switch 拆表迁移的保命网（缺一个 handler 即迁移漏搬）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { FIXED_EVENT_TYPES, EVENT_HANDLERS } from "../../src/core/agent/journal-handlers.mjs";

test("每个固定事件类型都有 handler（迁移对账红线）", () => {
  for (const type of FIXED_EVENT_TYPES) {
    assert.equal(typeof EVENT_HANDLERS[type], "function", `缺 handler: ${type}`);
  }
  assert.equal(FIXED_EVENT_TYPES.length, Object.keys(EVENT_HANDLERS).length,
    "handler 表键数必须等于 FIXED_EVENT_TYPES 数量");
});