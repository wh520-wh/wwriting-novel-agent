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
