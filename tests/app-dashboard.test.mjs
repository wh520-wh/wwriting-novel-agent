import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadDashboardData, loadProjectList, readChapterContent, validateProjectRoot } from "../src/core/app-dashboard.mjs";
import { runProject } from "../src/core/agent-engine.mjs";
import { createProject, loadState, saveState } from "../src/core/project-store.mjs";
import { runReviewerAgent } from "../src/core/reviewer-agent.mjs";
import { searchWeb } from "../src/core/research-tools.mjs";
import { updateProjectSettings } from "../src/core/settings-runtime.mjs";

test("loadDashboardData summarizes real project files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-dashboard-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 2,
    min_words_per_chapter: 160,
    target_words_per_chapter: 220,
    network_allowed: true,
    enabled_skills: ["suspense-chapter-end"]
  });
  await runProject(projectRoot);
  await searchWeb(
    projectRoot,
    { project_id: "dashboard-project", tool_permissions: { network_allowed: true } },
    { query: "dashboard research", limit: 1 },
    {
      adapter: {
        async search() {
          return [{ title: "Dashboard Source", url: "https://example.test/source", snippet: "source" }];
        }
      }
    }
  );
  await runReviewerAgent(projectRoot, { writeReport: true });

  const data = await loadDashboardData(root, { projectRoot });
  assert.equal(data.hasProject, true);
  assert.equal(data.summary.completedChapters, 2);
  assert.equal(data.summary.targetChapters, 2);
  assert.equal(data.summary.progressPercent, 100);
  assert.equal(data.summary.activityProgressPercent, 100);
  assert.ok(data.summary.totalWords >= 320);
  assert.ok(data.summary.totalTokens > 0);
  assert.ok(data.chapters.every((chapter) => chapter.status === "completed"));
  assert.ok(data.events.some((event) => event.type === "model_usage_recorded"));
  assert.ok(data.cost.calls >= 2);
  assert.ok(data.cache.last_call.cacheKey);
  assert.equal(data.config.effective.tool_permissions.network_allowed, true);
  assert.equal(data.skills.items[0].name, "suspense-chapter-end");
  assert.equal(data.skills.items[0].enabled_in_project, true);
  assert.ok(data.skills.items[0].hooks.some((hook) => hook.stage === "planning"));
  assert.equal(data.sources.count, 1);
  assert.equal(data.sources.latest[0].untrusted, true);
  assert.equal(data.review.status, "passed");
  const projects = await loadProjectList(root);
  assert.ok(projects.some((project) => project.projectRoot === projectRoot));
  assert.equal(await validateProjectRoot(projectRoot), projectRoot);
});

test("loadDashboardData reports visible in-chapter activity progress while running", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-dashboard-activity-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 100,
    min_words_per_chapter: 160,
    target_words_per_chapter: 220
  });
  const state = await loadState(projectRoot);
  await saveState(projectRoot, {
    ...state,
    project_status: "running",
    current_stage: "drafting",
    current_chapter_no: 1
  });

  const data = await loadDashboardData(root, { projectRoot });
  assert.equal(data.summary.progressPercent, 0);
  assert.ok(data.summary.activityProgressPercent >= 4);
  assert.ok(data.summary.activityProgressPercent < 100);
});

test("loadDashboardData reports configured model-call budget from effective settings", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-dashboard-budget-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    max_model_calls: 200
  });
  await updateProjectSettings(projectRoot, {
    budget_config: {
      max_model_calls: 77
    }
  });

  const data = await loadDashboardData(root, { projectRoot });
  assert.equal(data.summary.maxModelCalls, 77);
  assert.equal(data.project.budget_config.max_model_calls, 77);
});

test("readChapterContent returns clean prose without segment markup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-reader-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 120,
    target_words_per_chapter: 160
  });
  await runProject(projectRoot);
  const chapter = await readChapterContent(projectRoot, 1);
  assert.equal(chapter.ok, true);
  assert.equal(chapter.chapter_no, 1);
  assert.equal(chapter.is_draft, false);
  assert.ok(chapter.actual_words > 0);
  assert.ok(chapter.content.length > 0);
  assert.ok(!chapter.content.includes("segment:"));
  assert.ok(!chapter.content.includes("<!--"));
  assert.ok(!/^#\s+Chapter/imu.test(chapter.content));
  await assert.rejects(() => readChapterContent(projectRoot, 999), /未找到/u);
  await assert.rejects(() => readChapterContent(projectRoot, 0), /章节号无效/u);
});

test("loadDashboardData rejects project paths outside workspace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-dashboard-safe-"));
  await assert.rejects(() => loadDashboardData(root, { projectRoot: path.resolve(root, "..", "outside") }), /逃出工作区/u);
});

test("loadDashboardData allows an explicitly opened external project", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-dashboard-workspace-"));
  const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-dashboard-external-"));
  const { projectRoot } = await createProject(externalRoot, {
    slug: "opened-project",
    target_chapters: 1,
    min_words_per_chapter: 120,
    target_words_per_chapter: 160
  });
  await runProject(projectRoot);
  const data = await loadDashboardData(workspace, {
    projectRoot,
    allowExternalProjectRoot: true
  });
  assert.equal(data.hasProject, true);
  assert.equal(data.projectRoot, projectRoot);
  assert.equal(data.summary.completedChapters, 1);
});

test("loadDashboardData can disable latest-project fallback", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-dashboard-no-fallback-"));
  await createProject(root, { slug: "project", title: "Fallback Candidate" });

  const data = await loadDashboardData(root, { disableProjectFallback: true });

  assert.equal(data.ok, true);
  assert.equal(data.hasProject, false);
});

test("loadDashboardData returns cacheSummary when cache report is missing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-dashboard-cache-empty-"));
  const { projectRoot } = await createProject(root, { slug: "project" });

  const data = await loadDashboardData(root, { projectRoot });

  assert.deepEqual(data.cacheSummary, {
    available: false,
    providerMetricsAvailable: false,
    cacheKey: null,
    cacheVersion: null,
    stableChanged: false,
    stableChangedReason: null,
    lastTemplateVersion: null,
    hitRate: null,
    cachedTokens: 0,
    explanation: "缓存待生成"
  });
});

test("loadDashboardData explains stable cache key without provider metrics", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-dashboard-cache-summary-"));
  const { projectRoot } = await createProject(root, { slug: "project" });
  await fs.writeFile(
    path.join(projectRoot, "cache_report.json"),
    JSON.stringify(
      {
        schema_version: 1,
        updated_at: "2026-05-31T06:00:00.000Z",
        entries: {},
        last_call: {
          provider: "mock",
          model: "mock-writer",
          templateVersion: "drafting.v1",
          stableHash: "sha256:stable",
          dynamicHash: "sha256:dynamic",
          cacheVersion: 1,
          cacheKey: "p:drafting.v1:v1:stable",
          promptBlockHashes: {},
          promptBlocks: [],
          cacheMetricsAvailable: false,
          cacheHitRate: null,
          cachedTokens: 0,
          cacheHitTokens: 0,
          stableChanged: false,
          stableChangedReason: null
        }
      },
      null,
      2
    )
  );

  const data = await loadDashboardData(root, { projectRoot });

  assert.equal(data.cacheSummary.available, true);
  assert.equal(data.cacheSummary.providerMetricsAvailable, false);
  assert.equal(data.cacheSummary.explanation, "缓存键稳定；供应商未返回命中指标");
});
