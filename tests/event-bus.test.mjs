import { test } from "node:test";
import assert from "node:assert/strict";
import { on, off, emit, CORE_EVENTS, _resetEventBus } from "../src/core/event-bus.mjs";

test.beforeEach(() => {
  _resetEventBus();
});

test("emit with no listeners returns ok:true and no errors", async () => {
  const result = await emit("test:event", { foo: 1 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("emit invokes all listeners", async () => {
  let count = 0;
  on("test:event", () => count++);
  on("test:event", () => count++);
  await emit("test:event", {});
  assert.equal(count, 2);
});

test("emit awaits async listeners", async () => {
  let resolved = false;
  on("test:event", async () => {
    await new Promise((r) => setTimeout(r, 10));
    resolved = true;
  });
  await emit("test:event", {});
  assert.equal(resolved, true);
});

test("emit collects errors from throwing listeners", async () => {
  on("test:event", () => {
    throw new Error("boom");
  });
  const result = await emit("test:event", {});
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].error.message, "boom");
});

test("emit continues after one listener throws", async () => {
  let second = false;
  on("test:event", () => {
    throw new Error("boom");
  });
  on("test:event", () => {
    second = true;
  });
  const result = await emit("test:event", {});
  assert.equal(second, true);
  assert.equal(result.errors.length, 1);
});

test("off removes listener", async () => {
  let count = 0;
  const fn = () => count++;
  on("test:event", fn);
  off("test:event", fn);
  await emit("test:event", {});
  assert.equal(count, 0);
});

test("on returns an unsubscribe function", async () => {
  let count = 0;
  const unsubscribe = on("test:event", () => count++);
  await emit("test:event", {});
  unsubscribe();
  await emit("test:event", {});
  assert.equal(count, 1);
});

test("CORE_EVENTS is frozen with 3 events", () => {
  assert.equal(Object.isFrozen(CORE_EVENTS), true);
  assert.equal(Object.keys(CORE_EVENTS).length, 3);
  assert.ok("ModelCallComplete" in CORE_EVENTS);
  assert.ok("ChapterWritten" in CORE_EVENTS);
  assert.ok("TaskFailed" in CORE_EVENTS);
});
