import assert from "node:assert/strict";
import test from "node:test";
import { computeAgentTruth } from "../src/app-shell/agent-truth.mjs";

const now = Date.parse("2026-05-31T00:00:00.000Z");

function data(overrides = {}) {
  return {
    hasProject: true,
    agent_alive: false,
    agent_last_heartbeat: null,
    agent_error: null,
    summary: { projectStatus: "idle", currentStage: "queued" },
    state: {},
    ...overrides
  };
}

test("computeAgentTruth covers running heartbeat states", () => {
  assert.equal(computeAgentTruth(data({ agent_alive: true, agent_last_heartbeat: "2026-05-30T23:59:50.000Z", summary: { projectStatus: "running", currentStage: "drafting" } }), now).className, "running");
  assert.equal(computeAgentTruth(data({ agent_alive: true, agent_last_heartbeat: "2026-05-30T23:59:20.000Z", summary: { projectStatus: "running", currentStage: "drafting" } }), now).className, "slow");
  const stale = computeAgentTruth(data({ agent_alive: true, agent_last_heartbeat: "2026-05-30T23:58:00.000Z", summary: { projectStatus: "running", currentStage: "drafting" } }), now);
  assert.equal(stale.className, "stale");
  assert.equal(stale.showRetry, false);
  assert.equal(stale.showStop, true);
});

test("computeAgentTruth covers stopped and terminal persisted states", () => {
  assert.equal(computeAgentTruth(data({ summary: { projectStatus: "running" } }), now).className, "interrupted");
  assert.equal(computeAgentTruth(data({ summary: { projectStatus: "interrupted" }, state: { interrupted_reason: "API timeout" } }), now).reason, "API timeout");
  assert.equal(computeAgentTruth(data({ summary: { projectStatus: "cancelled" } }), now).className, "cancelled");
  assert.equal(computeAgentTruth(data({ summary: { projectStatus: "blocked" } }), now).showRetry, false);
  assert.equal(computeAgentTruth(data({ summary: { projectStatus: "completed" } }), now).className, "completed");
  assert.equal(computeAgentTruth({ hasProject: false }, now).className, "idle");
});
