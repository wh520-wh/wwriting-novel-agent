import assert from "node:assert/strict";
import test from "node:test";
import { computeAgentTruth, deriveBadges } from "../src/app-shell/agent-truth.mjs";

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

test("deriveBadges 在最近事件含 chapter_cost_warning 时成本徽章至少为 warning", () => {
  const dashboard = {
    summary: { estimatedCost: 0.1, targetChapters: 10, completedChapters: 1 },
    project: { budget_config: { max_cost: 100 } },
    events: [{ type: "chapter_cost_warning" }]
  };
  const badges = deriveBadges(dashboard);
  assert.equal(badges.cost.level, "warning");
});

test("deriveBadges 超预算 over 优先级高于预警事件", () => {
  const dashboard = {
    summary: { estimatedCost: 120, targetChapters: 10, completedChapters: 1 },
    project: { budget_config: { max_cost: 100 } },
    events: [{ type: "chapter_cost_warning" }]
  };
  assert.equal(deriveBadges(dashboard).cost.level, "over");
});

test("deriveBadges 无预警无超预算时成本徽章为 normal", () => {
  const dashboard = {
    summary: { estimatedCost: 0.1, targetChapters: 10, completedChapters: 1 },
    project: { budget_config: { max_cost: 100 } },
    events: []
  };
  assert.equal(deriveBadges(dashboard).cost.level, "normal");
});
