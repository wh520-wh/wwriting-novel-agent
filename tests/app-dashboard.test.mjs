import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadDashboardData, readChapterContent, validateProjectRoot } from "../src/core/app-dashboard.mjs";
import { loadProject, upsertChapter } from "../src/core/project-store.mjs";
import { createWritingProject } from "./helpers.mjs";
import { sha256 } from "../src/core/fs-utils.mjs";
import { searchWeb } from "../src/core/research-tools.mjs";
import { updateProjectSettings } from "../src/core/settings-runtime.mjs";

// Task 12：dashboard 技能列表改读新 catalog。注入临时 root 的 skills service
//（内置技能来自仓库 src/skills；migration marker 只写进项目内临时 home，绝不
// 触碰真实用户目录）。按 projectRoot 缓存 service，避免重复迁移。
const skillServiceCache = new Map();
async function skillServiceFor(projectRoot) {
  if (!skillServiceCache.has(projectRoot)) {
    const { createSkillService } = await import("../src/core/skills/index.mjs");
    const home = path.join(projectRoot, ".test-skill-home");
    skillServiceCache.set(projectRoot, createSkillService({ userHome: home, resourcesPath: null }));
  }
  return skillServiceCache.get(projectRoot);
}

async function activeSkillsFor(projectRoot) {
  const { active } = await (await skillServiceFor(projectRoot)).catalog({ projectRoot });
  return active;
}

async function loadDashboard(root, projectRoot, extra = {}) {
  return loadDashboardData(root, { ...extra, projectRoot, skillService: await skillServiceFor(projectRoot) });
}

// 章节事实辅助：用项目领域模块提交一章（dashboard 测试不依赖 Agent 写章）。
// 正文必须通过全部四个确定性技能门禁（内置技能发现即生效）。
async function commitChapterViaOperations(projectRoot, chapterNo, content) {
  const project = await loadProject(projectRoot);
  const { appendChapterSegment, commitChapter } = await import("../src/core/project-operations/chapter.mjs");
  await appendChapterSegment({
    projectRoot,
    projectId: project.project_id,
    chapterNo,
    segmentNo: 1,
    content
  });
  await commitChapter(
    { projectRoot, projectId: project.project_id, chapterNo },
    { skills: await activeSkillsFor(projectRoot) }
  );
}

test("loadDashboardData summarizes real project files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-dashboard-"));
  const { projectRoot } = await createWritingProject(root, {
    slug: "project",
    target_chapters: 2,
    min_words_per_chapter: 10,
    target_words_per_chapter: 20,
    network_allowed: true
  });
  await commitChapterViaOperations(projectRoot, 1, "雨夜，一封没有署名的信突然落在门缝里。他猛地抬头，低声道：“谁在送信？老宅的钟会在午夜敲响。”信纸背面写着：真相就在老宅。他攥紧信，冲出门去。");
  await commitChapterViaOperations(projectRoot, 2, "档案管理员林晚猛地推开档案室的门，低声道：“信上说的老宅，真有钟声吗？”她翻开登记簿，指尖停在一行字上：三十年前，老宅钟楼失踪过一个人。窗外忽然传来敲门声。");
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

  const data = await loadDashboard(root, projectRoot);
  assert.equal(data.hasProject, true);
  assert.equal(data.summary.completedChapters, 2);
  assert.equal(data.summary.targetChapters, 2);
  assert.equal(data.summary.progressPercent, 100);
  assert.ok(data.summary.totalWords >= 20);
  assert.ok(data.chapters.every((chapter) => chapter.status === "completed"));
  assert.ok(data.events.some((event) => event.type === "project_created"));
  assert.equal(data.config.effective.tool_permissions.network_allowed, true);
  const suspenseSkill = data.skills.items.find((skill) => skill.name === "suspense-chapter-end");
  assert.ok(suspenseSkill, "built-in suspense skill should be listed");
  const aiVoiceSkill = data.skills.items.find((skill) => skill.name === "avoid-ai-voice");
  assert.ok(aiVoiceSkill, "built-in ai-voice skill should be listed");
  // Task 13：无启停集合，DTO 不再返回启停字段。
  assert.equal(aiVoiceSkill["enabled_in_" + "project"], undefined);
  assert.equal(aiVoiceSkill.enabled, undefined);
  assert.equal(data.sources.count, 1);
  assert.equal(data.sources.latest[0].untrusted, true);
  assert.equal(await validateProjectRoot(projectRoot), projectRoot);
});

test("loadDashboardData 不再返回运行状态推断与旧领域字段", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-dashboard-no-run-"));
  const { projectRoot } = await createWritingProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 10,
    target_words_per_chapter: 20
  });
  await commitChapterViaOperations(projectRoot, 1, "雨夜，一封没有署名的信突然落在门缝里。他猛地抬头，低声道：“谁在送信？老宅的钟会在午夜敲响。”信纸背面写着：真相就在老宅。他攥紧信，冲出门去。");

  const data = await loadDashboard(root, projectRoot);
  // Rule 9：dashboard 不推测 Agent 是否繁忙
  assert.equal(data.summary.projectStatus, undefined);
  assert.equal(data.summary.currentStage, undefined);
  assert.equal(data.summary.currentChapterNo, undefined);
  assert.equal(data.summary.activityProgressPercent, undefined);
  assert.equal(data.summary.latestCheckpoint, undefined);
  // 旧审查/故障卡/recent tool events 字段删除
  assert.equal(data.review, undefined);
  assert.equal(data.failures, undefined);
  assert.equal(data.recent_tool_events, undefined);
});

test("loadDashboardData reports configured model-call budget from effective settings", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-dashboard-budget-"));
  const { projectRoot } = await createWritingProject(root, {
    slug: "project",
    max_model_calls: 200
  });
  await updateProjectSettings(projectRoot, {
    budget_config: {
      max_model_calls: 77
    }
  });

  const data = await loadDashboard(root, projectRoot);
  // 预算限制只来自有效项目配置（Rule 9）
  assert.equal(data.project.budget_config.max_model_calls, 77);
});

test("readChapterContent returns clean prose without segment markup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-reader-"));
  const { projectRoot } = await createWritingProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 10,
    target_words_per_chapter: 20
  });
  await commitChapterViaOperations(projectRoot, 1, "雨夜，一封没有署名的信突然落在门缝里。他猛地抬头，低声道：“谁在送信？老宅的钟会在午夜敲响。”信纸背面写着：真相就在老宅。他攥紧信，冲出门去。");
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
  const { projectRoot } = await createWritingProject(externalRoot, {
    slug: "opened-project",
    target_chapters: 1,
    min_words_per_chapter: 10,
    target_words_per_chapter: 20
  });
  await commitChapterViaOperations(projectRoot, 1, "雨夜，一封没有署名的信突然落在门缝里。他猛地抬头，低声道：“谁在送信？老宅的钟会在午夜敲响。”信纸背面写着：真相就在老宅。他攥紧信，冲出门去。");
  const data = await loadDashboard(workspace, projectRoot, { allowExternalProjectRoot: true });
  assert.equal(data.hasProject, true);
  assert.equal(data.projectRoot, projectRoot);
  assert.equal(data.summary.completedChapters, 1);
});

test("loadDashboardData can disable latest-project fallback", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-dashboard-no-fallback-"));
  await createWritingProject(root, { slug: "project", title: "Fallback Candidate" });

  const data = await loadDashboardData(root, { disableProjectFallback: true });

  assert.equal(data.ok, true);
  assert.equal(data.hasProject, false);
});

test("loadDashboardData returns cacheSummary when cache report is missing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-dashboard-cache-empty-"));
  const { projectRoot } = await createWritingProject(root, { slug: "project" });

  const data = await loadDashboard(root, projectRoot);

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
  const { projectRoot } = await createWritingProject(root, { slug: "project" });
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

  const data = await loadDashboard(root, projectRoot);

  assert.equal(data.cacheSummary.available, true);
  assert.equal(data.cacheSummary.providerMetricsAvailable, false);
  assert.equal(data.cacheSummary.explanation, "缓存键稳定；供应商未返回命中指标");
});

test("dashboard does not count an indexed chapter whose file is missing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-artifact-dashboard-"));
  const { projectRoot } = await createWritingProject(root, {
    slug: "project",
    target_chapters: 2,
  });
  await upsertChapter(projectRoot, {
    chapter_no: 1,
    status: "completed",
    final_path: path.join(projectRoot, "chapters", "001.md"),
    checksum: sha256("# 第一章\n\n内容"),
    actual_words: 1200,
  });

  const dashboard = await loadDashboard(root, projectRoot);

  assert.equal(dashboard.summary.completedChapters, 0);
  assert.equal(dashboard.chapters[0].artifact.state, "invalid");
  assert.equal(dashboard.chapters[0].artifact.reason, "missing_file");
});

test("dashboard exposes a verified artifact for a readable chapter file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-artifact-dashboard-"));
  const { projectRoot } = await createWritingProject(root, {
    slug: "project",
    target_chapters: 2,
  });
  const finalPath = path.join(projectRoot, "chapters", "001.md");
  const content = "# 第一章\n\n内容";
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.writeFile(finalPath, content, "utf8");
  const checksum = sha256(content);
  await upsertChapter(projectRoot, {
    chapter_no: 1,
    status: "completed",
    final_path: finalPath,
    checksum,
    actual_words: 2,
  });

  const dashboard = await loadDashboard(root, projectRoot);

  assert.equal(dashboard.summary.completedChapters, 1);
  assert.equal(dashboard.chapters[0].artifact.state, "committed");
  assert.equal(dashboard.chapters[0].artifact.checksum, checksum);
});
