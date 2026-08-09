import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendEvent } from "../src/core/event-log.mjs";
import { loadProjectDiagnostics } from "../src/core/project-diagnostics.mjs";
import { createProject } from "../src/core/project-store.mjs";

test("loadProjectDiagnostics 组合领域审计与注入的 agentSnapshot", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-diagnostics-"));
  const { projectRoot } = await createProject(root, { slug: "project" });

  await appendEvent(projectRoot, { type: "model_call_failed", message: "provider timeout", stage: "drafting" });
  await appendEvent(projectRoot, { type: "chapter_committed", message: "第一章已提交", stage: "finalizing" });

  // 注入的 ProjectAgent.snapshot() 结果（形状：{ session, events }）
  const agentSnapshot = {
    session: {
      schema_version: 1,
      session_id: "session-1",
      project_root: projectRoot,
      status: "idle",
      active_run: {
        id: "run-1",
        status: "failed",
        workflow: "general",
        active_input_id: "input-1",
        active_grants: [],
        started_at: "2026-08-06T00:00:00.000Z"
      },
      queued_inputs: [{ id: "q1", text: "排队任务", status: "queued", queued_at: "2026-08-06T00:00:00.000Z" }],
      last_seq: 10,
      updated_at: "2026-08-06T00:00:00.000Z"
    },
    events: []
  };

  const diagnostics = await loadProjectDiagnostics(projectRoot, { agentSnapshot });

  assert.equal(diagnostics.ok, true);
  assert.equal(diagnostics.project.status, "idle");
  assert.equal(diagnostics.project.stage, "failed");
  assert.equal(diagnostics.queue.queuedCount, 1);
  assert.equal(diagnostics.queue.runningCount, 1);
  assert.match(diagnostics.recoveryHint.message, /重试|恢复|retry|resume/u);
  assert.ok(diagnostics.recentEvents.some((event) => event.type === "chapter_committed"));
  assert.ok(diagnostics.modelErrors.some((event) => event.type === "model_call_failed"));
});

test("diagnostics 暴露 costHealth 且不读全量日志", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-diagnostics-"));
  const { projectRoot } = await createProject(root, { slug: "project" });
  await fs.writeFile(path.join(projectRoot, "cost.json"), JSON.stringify({
    calls: 10, retries: 3, unpricedCalls: 10, costAvailable: false,
    inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedTokens: 0, estimatedCost: 0,
    byProvider: {}, byModel: {}, byStage: {}, byChapter: {}
  }));
  await fs.writeFile(path.join(projectRoot, "cache_report.json"), JSON.stringify({
    entries: { "p:drafting.v1": { cacheVersion: 8 } },
    last_call: { cacheHitRate: 0.14, stableChanged: true }
  }));

  const diagnostics = await loadProjectDiagnostics(projectRoot, { agentSnapshot: null });

  assert.equal(diagnostics.costHealth.retries, 3);
  assert.equal(diagnostics.costHealth.costAvailable, false);
  assert.equal(diagnostics.costHealth.maxCacheVersion, 8);
  assert.equal(diagnostics.costHealth.lastCacheHitRate, 0.14);
  // Task 4 惰性创建：无会话（agentSnapshot 为 null / 空项目）时 status 回落 'idle'
  //（旧契约快照恒有 idle 会话；空项目 dashboard 显示不变）
  assert.equal(diagnostics.project.status, "idle", "无 snapshot 时 status 为 idle");
  assert.equal(diagnostics.queue.runningCount, 0);
});

test("diagnostics 从章节索引推导当前章节（无运行时状态）", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-diagnostics-chapter-"));
  const { projectRoot } = await createProject(root, { slug: "project" });
  const index = {
    schema_version: 1,
    chapters: [
      { chapter_no: 1, status: "completed" },
      { chapter_no: 2, status: "completed" }
    ]
  };
  await fs.writeFile(path.join(projectRoot, "memory", "chapter_index.json"), JSON.stringify(index));

  const diagnostics = await loadProjectDiagnostics(projectRoot, { agentSnapshot: null });

  assert.equal(diagnostics.project.chapter, 3, "当前章节 = 已提交最大章 + 1");
});
