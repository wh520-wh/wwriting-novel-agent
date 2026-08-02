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

test("cancelling task tells the user that cancellation is in progress", () => {
  const truth = computeAgentTruth(data({
    summary: { projectStatus: "cancelling", currentChapterNo: 4, currentStage: "drafting" },
    state: { project_status: "cancelling", current_chapter_no: 4 }
  }), now);

  assert.equal(truth.className, "cancelling");
  assert.equal(truth.display, "正在取消第 4 章");
  assert.equal(truth.showStop, false);
});

test("cancelling status comes from the persisted project_status even when summary is missing", () => {
  const truth = computeAgentTruth(data({
    summary: { projectStatus: null, currentChapterNo: 7 },
    state: { project_status: "cancelling", current_chapter_no: 7 }
  }), now);

  assert.equal(truth.className, "cancelling");
  assert.equal(truth.display, "正在取消第 7 章");
  assert.equal(truth.showStop, false);
});

test("cancelling truth does not collide with the cancelled terminal label", () => {
  const cancelling = computeAgentTruth(data({
    summary: { projectStatus: "cancelling", currentChapterNo: 2 }
  }), now);
  const cancelled = computeAgentTruth(data({
    summary: { projectStatus: "cancelled", currentChapterNo: 2 }
  }), now);
  assert.notEqual(cancelling.display, cancelled.display);
  assert.equal(cancelled.display, "已停止");
});

test("agent truth: 任务已入队但 project_status 仍为 idle 时显示排队中而非待命", () => {
  const truth = computeAgentTruth(data({
    summary: { projectStatus: "idle", currentStage: "queued" },
    state: { project_status: "idle", agent_alive: false },
    queue: { tasks: [{ index: 1, status: "queued" }] }
  }), now);

  assert.equal(truth.display, "排队中");
  assert.notEqual(truth.display, "空闲");
  assert.equal(truth.className, "running");
  assert.equal(truth.showRetry, false);
});

test("agent truth: 仅队列存在 queued 任务（stage 未知）也显示排队中", () => {
  const truth = computeAgentTruth(data({
    summary: { projectStatus: "idle", currentStage: null },
    queue: { tasks: [{ index: 2, status: "running" }] }
  }), now);

  assert.equal(truth.display, "排队中");
  assert.equal(truth.className, "running");
});

test("agent truth: 无排队任务且状态 idle 仍为空闲", () => {
  const truth = computeAgentTruth(data({
    summary: { projectStatus: "idle", currentStage: null },
    queue: { tasks: [{ index: 3, status: "completed" }] }
  }), now);

  assert.equal(truth.display, "空闲");
  assert.equal(truth.className, "idle");
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
