import { test } from "node:test";
import assert from "node:assert/strict";
import { on, emit, CORE_EVENTS, _resetEventBus } from "../src/core/event-bus.mjs";

test.beforeEach(() => {
  _resetEventBus();
});

test("multiple subscribers receive event payload", async () => {
  const received = [];
  on(CORE_EVENTS.ModelCallComplete, (p) => received.push(p));
  on(CORE_EVENTS.ModelCallComplete, (p) => received.push({ ...p, doubled: true }));

  await emit(CORE_EVENTS.ModelCallComplete, { model: "deepseek", usage: { total: 100 } });
  assert.equal(received.length, 2);
  assert.equal(received[0].model, "deepseek");
  assert.equal(received[1].doubled, true);
});

test("throwing subscriber does not prevent other subscribers", async () => {
  let secondCalled = false;
  on(CORE_EVENTS.TaskFailed, () => {
    throw new Error("intentional");
  });
  on(CORE_EVENTS.TaskFailed, () => {
    secondCalled = true;
  });

  const result = await emit(CORE_EVENTS.TaskFailed, { error: new Error("test") });
  assert.equal(secondCalled, true);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
});
