import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendEvent } from "../src/core/event-log.mjs";
import { appendFailure } from "../src/core/failures-store.mjs";
import { loadProjectDiagnostics } from "../src/core/project-diagnostics.mjs";
import { saveState } from "../src/core/project-store.mjs";
import { TaskQueue } from "../src/core/task-queue.mjs";

test("loadProjectDiagnostics summarizes state, queue, recent events, failures, and recovery hint", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-diagnostics-"));
  await saveState(root, {
    project_status: "interrupted",
    current_stage: "drafting",
    current_chapter_no: 2,
    interrupted_reason: "provider timeout"
  });

  const queue = new TaskQueue(root);
  await queue.load();
  const task = await queue.enqueue("continue chapter", { mode: "write" });
  await queue.promoteNext();
  await queue.interrupt(task.id, new Error("provider timeout"));

  await appendEvent(root, { type: "model_call_failed", message: "provider timeout", stage: "drafting" });
  appendFailure(root, {
    id: "failure-1",
    type: "provider-error",
    message: "provider timeout",
    createdAt: new Date().toISOString()
  });

  const diagnostics = await loadProjectDiagnostics(root);

  assert.equal(diagnostics.ok, true);
  assert.equal(diagnostics.project.status, "interrupted");
  assert.equal(diagnostics.queue.interruptedCount, 1);
  assert.equal(diagnostics.recentEvents[0].type, "model_call_failed");
  assert.equal(diagnostics.failures.length, 1);
  assert.match(diagnostics.recoveryHint.message, /重试|恢复|retry|resume/u);
});

test("diagnostics 暴露 costHealth 且不读全量日志", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-diagnostics-"));
  await saveState(root, { project_status: "running", current_stage: "drafting", current_chapter_no: 1 });
  await fs.writeFile(path.join(root, "cost.json"), JSON.stringify({
    calls: 10, retries: 3, unpricedCalls: 10, costAvailable: false,
    inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedTokens: 0, estimatedCost: 0,
    byProvider: {}, byModel: {}, byStage: {}, byChapter: {}
  }));
  await fs.writeFile(path.join(root, "cache_report.json"), JSON.stringify({
    entries: { "p:drafting.v1": { cacheVersion: 8 } },
    last_call: { cacheHitRate: 0.14, stableChanged: true }
  }));

  const diagnostics = await loadProjectDiagnostics(root);

  assert.equal(diagnostics.costHealth.retries, 3);
  assert.equal(diagnostics.costHealth.costAvailable, false);
  assert.equal(diagnostics.costHealth.maxCacheVersion, 8);
  assert.equal(diagnostics.costHealth.lastCacheHitRate, 0.14);
});
