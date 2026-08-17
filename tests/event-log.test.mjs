import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { appendEvent, readEvents } from "../src/core/event-log.mjs";

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

// -- §3.2 corrupted line tolerance tests --

test("readEvents skips a single malformed JSON line", async () => {
  const root = await makeProject();
  await appendEvent(root, { type: "good", message: "before" });
  // Inject a bad line directly
  const logPath = path.join(root, "run_log.jsonl");
  await fs.appendFile(logPath, `{"broken}\n`, "utf8");
  await appendEvent(root, { type: "good", message: "after" });

  const events = await readEvents(root);
  assert.equal(events.length, 2);
  assert.equal(events[0].message, "before");
  assert.equal(events[1].message, "after");
});

test("readEvents with limit skips malformed lines in middle of file", async () => {
  const root = await makeProject();
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const ev = await appendEvent(root, { type: "good", message: `msg-${i}` });
    ids.push(ev.event_id);
  }
  // Inject bad lines in the middle
  const logPath = path.join(root, "run_log.jsonl");
  await fs.appendFile(logPath, `garbage_line\n`, "utf8");
  await fs.appendFile(logPath, `{truncated\n`, "utf8");
  for (let i = 5; i < 10; i++) {
    const ev = await appendEvent(root, { type: "good", message: `msg-${i}` });
    ids.push(ev.event_id);
  }

  const tail = await readEvents(root, { limit: 5 });
  // tail returns last 5 non-empty lines: [good5, good6, good7, good8, good9]
  // all parse correctly because bad lines are before the tail window
  assert.equal(tail.length, 5);
  assert.equal(tail[0].message, "msg-5");
  assert.equal(tail[4].message, "msg-9");
});

test("readEvents handles file with all bad lines", async () => {
  const root = await makeProject();
  const logPath = path.join(root, "run_log.jsonl");
  await fs.writeFile(logPath, `garbage\nnot-json\n{"partial\n`, "utf8");

  const events = await readEvents(root);
  assert.deepEqual(events, []);
});

test("readEvents empty file returns empty array", async () => {
  const root = await makeProject();
  const logPath = path.join(root, "run_log.jsonl");
  await fs.writeFile(logPath, "", "utf8");

  const events = await readEvents(root);
  assert.deepEqual(events, []);
});

test("readEvents with limit on empty file returns empty array", async () => {
  const root = await makeProject();
  const logPath = path.join(root, "run_log.jsonl");
  await fs.writeFile(logPath, "", "utf8");

  const events = await readEvents(root, { limit: 5 });
  assert.deepEqual(events, []);
});
