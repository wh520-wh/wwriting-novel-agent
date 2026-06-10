import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { appendEvent, readEvents, tailEvents } from "../src/core/event-log.mjs";

let tmpDir;

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

async function makeProject() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ww-eventlog-"));
  return tmpDir;
}

test("append and read all preserves insertion order", async () => {
  const root = await makeProject();
  const a = await appendEvent(root, { type: "alpha", message: "first" });
  const b = await appendEvent(root, { type: "beta", message: "second" });

  const events = await readEvents(root);
  assert.equal(events.length, 2);
  assert.equal(events[0].event_id, a.event_id);
  assert.equal(events[1].event_id, b.event_id);
});

test("read all when no limit returns every event", async () => {
  const root = await makeProject();
  for (let i = 0; i < 50; i++) {
    await appendEvent(root, { type: "tick", message: `n-${i}` });
  }
  const events = await readEvents(root);
  assert.equal(events.length, 50);
  assert.equal(events[0].message, "n-0");
  assert.equal(events[49].message, "n-49");
});

test("readEvents with limit returns last N events", async () => {
  const root = await makeProject();
  const inserted = [];
  for (let i = 0; i < 100; i++) {
    const ev = await appendEvent(root, { type: "item", message: `msg-${i}` });
    inserted.push(ev);
  }

  const tail = await readEvents(root, { limit: 5 });
  assert.equal(tail.length, 5);
  for (let i = 0; i < 5; i++) {
    assert.equal(tail[i].event_id, inserted[95 + i].event_id);
  }
});

test("readEvents returns empty array for non-existent path", async () => {
  const result = await readEvents("/nonexistent_root_abc_xyz_123");
  assert.deepEqual(result, []);
});

test("limit larger than total events returns all events", async () => {
  const root = await makeProject();
  await appendEvent(root, { type: "only", message: "one" });
  const events = await readEvents(root, { limit: 100 });
  assert.equal(events.length, 1);
  assert.equal(events[0].message, "one");
});

test("tailEvents is a convenience wrapper for readEvents with limit", async () => {
  const root = await makeProject();
  const inserted = [];
  for (let i = 0; i < 20; i++) {
    const ev = await appendEvent(root, { type: "e", message: `v-${i}` });
    inserted.push(ev);
  }
  const tail = await tailEvents(root, 3);
  assert.equal(tail.length, 3);
  assert.equal(tail[0].event_id, inserted[17].event_id);
  assert.equal(tail[2].event_id, inserted[19].event_id);
});

test("tail read with limit=1 returns only the last event", async () => {
  const root = await makeProject();
  for (let i = 0; i < 10; i++) {
    await appendEvent(root, { type: "step", message: `s-${i}` });
  }
  const one = await readEvents(root, { limit: 1 });
  assert.equal(one.length, 1);
  assert.equal(one[0].message, "s-9");
});

test("readEvents with a small limit handles a large log and returns only recent events", async () => {
  const root = await makeProject();
  for (let i = 0; i < 5000; i += 1) {
    await appendEvent(root, {
      type: "large_sample",
      message: `event ${i}`,
      data: { seq: i }
    });
  }

  const started = performance.now();
  const recent = await readEvents(root, { limit: 5 });
  const elapsedMs = performance.now() - started;

  assert.deepEqual(recent.map((event) => event.data.seq), [4995, 4996, 4997, 4998, 4999]);
  assert.ok(elapsedMs < 100, `expected recent log read under 100ms, got ${elapsedMs}ms`);
});
