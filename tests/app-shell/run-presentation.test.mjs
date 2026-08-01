import assert from "node:assert/strict";
import test from "node:test";
import { deriveRunPresentation, deriveStepState } from "../../src/app-shell/run-presentation.mjs";

const order = ["queued", "planning", "planned", "drafting", "reviewing", "needs_revision", "revising", "finalizing", "summarizing"];

test("interrupted drafting is a terminal display state with a reusable checkpoint", () => {
  const run = deriveRunPresentation({
    summary: { projectStatus: "interrupted", currentStage: "drafting", currentChapterNo: 2 },
    state: { interrupted_reason: "HTTP 400" }
  });

  assert.equal(run.status, "interrupted");
  assert.equal(run.resumeStage, "drafting");
  assert.equal(run.label, "已中断");
  assert.equal(run.isLive, false);
  assert.equal(deriveStepState(run, ["queued", "planning", "planned"], order), "done");
  assert.equal(deriveStepState(run, ["drafting"], order), "interrupted");
  assert.equal(deriveStepState(run, ["reviewing"], order), "todo");
});

test("cancelled drafting is not shown as writing", () => {
  const run = deriveRunPresentation({
    summary: { projectStatus: "cancelled", currentStage: "drafting", currentChapterNo: 2 }
  });
  assert.equal(run.label, "已停止");
  assert.equal(deriveStepState(run, ["drafting"], order), "cancelled");
});
