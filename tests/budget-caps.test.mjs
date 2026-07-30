import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runProject } from "../src/core/agent-engine.mjs";
import { MockModel } from "../src/core/mock-model.mjs";
import { createProject, loadState } from "../src/core/project-store.mjs";
import { updateProjectSettings } from "../src/core/settings-runtime.mjs";
import { readEvents } from "../src/core/event-log.mjs";

async function setupProject(budgetConfig) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-budget-"));
  const { projectRoot } = await createProject(workspace, {
    title: "预算熔断",
    story_seed: "test",
    target_chapters: 2,
    min_words_per_chapter: 300
  });
  await updateProjectSettings(projectRoot, { budget_config: budgetConfig });
  return { workspace, projectRoot };
}

test("超过 max_total_tokens 时项目进入 blocked(token_budget_exhausted)", async () => {
  const { workspace, projectRoot } = await setupProject({ max_total_tokens: 1 });
  // 预置已超限的 cost.json
  await fs.writeFile(path.join(projectRoot, "cost.json"), JSON.stringify({
    calls: 1, totalTokens: 99999, inputTokens: 1, outputTokens: 1, cachedTokens: 0,
    estimatedCost: 0, costAvailable: false, unpricedCalls: 1, pricedCalls: 0, retries: 0,
    byProvider: {}, byModel: {}, byStage: {}, byChapter: {}
  }));
  await runProject(projectRoot, { model: new MockModel() }).catch(() => {});
  const state = await loadState(projectRoot);
  assert.equal(state.project_status, "blocked");
  assert.equal(state.blocked_reason, "token_budget_exhausted");
  const events = await readEvents(projectRoot, { limit: 50 });
  assert.ok(events.some((e) => e.type === "project_blocked" && e.message === "token_budget_exhausted"));
  await fs.rm(workspace, { recursive: true, force: true });
});

test("配置了价格且超过 max_cost 时进入 blocked(cost_budget_exhausted)", async () => {
  const { workspace, projectRoot } = await setupProject({ max_cost: 0.5 });
  await fs.writeFile(path.join(projectRoot, "cost.json"), JSON.stringify({
    calls: 1, totalTokens: 100, inputTokens: 50, outputTokens: 50, cachedTokens: 0,
    estimatedCost: 1.2, costAvailable: true, unpricedCalls: 0, pricedCalls: 1, retries: 0,
    byProvider: {}, byModel: {}, byStage: {}, byChapter: {}
  }));
  await runProject(projectRoot, { model: new MockModel() }).catch(() => {});
  const state = await loadState(projectRoot);
  assert.equal(state.blocked_reason, "cost_budget_exhausted");
  await fs.rm(workspace, { recursive: true, force: true });
});

test("costAvailable=false 时 max_cost 不熔断（无法按钱计量）", async () => {
  const { workspace, projectRoot } = await setupProject({ max_cost: 0.5 });
  await fs.writeFile(path.join(projectRoot, "cost.json"), JSON.stringify({
    calls: 1, totalTokens: 100, inputTokens: 50, outputTokens: 50, cachedTokens: 0,
    estimatedCost: 0, costAvailable: false, unpricedCalls: 1, pricedCalls: 0, retries: 0,
    byProvider: {}, byModel: {}, byStage: {}, byChapter: {}
  }));
  const result = await runProject(projectRoot, { model: new MockModel() });
  assert.ok(result);
  const state = await loadState(projectRoot);
  assert.notEqual(state.project_status, "blocked");
  await fs.rm(workspace, { recursive: true, force: true });
});

test("显式设置 max_model_calls=1 时调用一次后进入 blocked(model_call_budget_exhausted)", async () => {
  const { workspace, projectRoot } = await setupProject({ max_model_calls: 1 });
  const result = await runProject(projectRoot, { model: new MockModel() }).catch(() => {});
  assert.equal(result.blocked, true);
  const state = await loadState(projectRoot);
  assert.equal(state.blocked_reason, "model_call_budget_exhausted");
  assert.equal(state.active_budget.model_calls, 1);
  assert.equal(state.active_budget.max_model_calls, 1);
  await fs.rm(workspace, { recursive: true, force: true });
});

test("不设置 max_model_calls（默认 null）时项目不因调用上限阻塞", async () => {
  const { workspace, projectRoot } = await setupProject({});
  const result = await runProject(projectRoot, { model: new MockModel() }).catch(() => {});
  const state = await loadState(projectRoot);
  assert.equal(state.active_budget.max_model_calls, null);
  assert.notEqual(state.blocked_reason, "model_call_budget_exhausted");
  await fs.rm(workspace, { recursive: true, force: true });
});
