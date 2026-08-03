import test from "node:test";
import assert from "node:assert/strict";
import { subscribe, emit, unsubscribeAll } from "../src/core/run-events-bus.mjs";

test("订阅收到本项目事件，不收到其他项目事件", () => {
  const got = [];
  const off = subscribe("proj-a", (e) => got.push(e));
  emit("proj-a", { type: "model_delta", text: "他" });
  emit("proj-b", { type: "model_delta", text: "别的" });
  assert.deepEqual(got, [{ type: "model_delta", text: "他" }]);
  off();
});

test("取消订阅后不再收到；unsubscribeAll 清空", () => {
  const got = [];
  subscribe("proj-a", (e) => got.push(e));
  const off2 = subscribe("proj-a", (e) => got.push(e));
  unsubscribeAll("proj-a");
  emit("proj-a", { type: "model_delta", text: "x" });
  assert.equal(got.length, 0);
  off2();
});
