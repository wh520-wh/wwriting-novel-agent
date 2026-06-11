import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyFailureResolution } from "../src/core/failure-actions.mjs";
import { createProject, loadProject, loadState, saveState } from "../src/core/project-store.mjs";
import { readEvents } from "../src/core/event-log.mjs";

async function makeProject(prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 3,
    min_words_per_chapter: 300,
    target_words_per_chapter: 360
  });
  return projectRoot;
}

test("raise-budget 解除预算阻塞并同步 active_budget 与 project.yaml", async () => {
  const projectRoot = await makeProject("wwriting-fa-budget-");
  const state = await loadState(projectRoot);
  await saveState(projectRoot, {
    ...state,
    project_status: "blocked",
    current_stage: "blocked",
    blocked_at_stage: "drafting",
    blocked_reason: "model_call_budget_exhausted",
    active_budget: { model_calls: 200, max_model_calls: 200, revision_rounds_by_chapter: {} }
  });
  const result = await applyFailureResolution(projectRoot, { command: "raise-budget", args: { newMaxModelCalls: 400 } });
  assert.equal(result.resumeRun, true);
  const next = await loadState(projectRoot);
  assert.equal(next.project_status, "idle");
  assert.equal(next.current_stage, "drafting");
  assert.equal(next.active_budget.max_model_calls, 400);
  assert.equal(next.active_budget.model_calls, 200, "已消耗的调用数必须保留");
  const project = await loadProject(projectRoot);
  assert.equal(project.budget_config.max_model_calls, 400);
});

test("raise-cost-budget 写入 budget_config.max_cost 并要求续跑", async () => {
  const projectRoot = await makeProject("wwriting-fa-cost-budget-");
  const state = await loadState(projectRoot);
  await saveState(projectRoot, {
    ...state,
    project_status: "blocked",
    current_stage: "blocked",
    blocked_at_stage: "drafting",
    blocked_reason: "cost_budget_exhausted",
    active_budget: { model_calls: 50, max_model_calls: 200, max_cost: 1, revision_rounds_by_chapter: {} }
  });
  const result = await applyFailureResolution(projectRoot, { command: "raise-cost-budget", args: { newMaxCost: 2 } });
  assert.equal(result.resumeRun, true);
  const project = await loadProject(projectRoot);
  assert.equal(project.budget_config.max_cost, 2);
  const next = await loadState(projectRoot);
  assert.equal(next.project_status, "idle");
  assert.equal(next.active_budget.max_cost, 2);
});

test("accept-current-words 把 needs_revision 推进到 finalizing", async () => {
  const projectRoot = await makeProject("wwriting-fa-accept-");
  const state = await loadState(projectRoot);
  await saveState(projectRoot, { ...state, project_status: "idle", current_stage: "needs_revision", current_chapter_no: 2 });
  const result = await applyFailureResolution(projectRoot, { command: "accept-current-words", args: {} });
  assert.equal(result.resumeRun, true);
  const next = await loadState(projectRoot);
  assert.equal(next.current_stage, "finalizing");
  const events = await readEvents(projectRoot);
  assert.ok(events.some((e) => e.type === "quality_gate_overridden"));
});

test("switch-model 写回 active_model.model_name", async () => {
  const projectRoot = await makeProject("wwriting-fa-switch-");
  const result = await applyFailureResolution(projectRoot, { command: "switch-model", args: { modelId: "mock-writer-backup" } });
  assert.equal(result.resumeRun, true);
  const project = await loadProject(projectRoot);
  assert.equal(project.active_model.model_name, "mock-writer-backup");
});

test("retry-segment 清掉 interrupted 标记", async () => {
  const projectRoot = await makeProject("wwriting-fa-retry-");
  const state = await loadState(projectRoot);
  await saveState(projectRoot, { ...state, project_status: "interrupted", interrupted_reason: "boom", interrupted_at: "2026-06-10T00:00:00Z" });
  const result = await applyFailureResolution(projectRoot, { command: "retry-segment", args: {} });
  assert.equal(result.resumeRun, true);
  const next = await loadState(projectRoot);
  assert.equal(next.project_status, "idle");
  assert.equal(next.interrupted_reason, undefined);
});

test("pause-here 不改状态也不要求续跑", async () => {
  const projectRoot = await makeProject("wwriting-fa-pause-");
  const before = await loadState(projectRoot);
  const result = await applyFailureResolution(projectRoot, { command: "pause-here", args: {} });
  assert.equal(result.resumeRun, false);
  const after = await loadState(projectRoot);
  assert.deepEqual(after, before);
});

test("fill-words 注入补写指令事件", async () => {
  const projectRoot = await makeProject("wwriting-fa-fill-");
  const result = await applyFailureResolution(projectRoot, { command: "fill-words", args: { targetWords: 820 } });
  assert.equal(result.resumeRun, true);
  const events = await readEvents(projectRoot);
  const instruction = events.find((e) => e.type === "user_instruction_received" && e.data?.source === "failure_card");
  assert.ok(instruction, "应写入 user_instruction_received 事件");
  assert.ok(instruction.message.includes("820"));
});
