import fs from "node:fs/promises";
import path from "node:path";
import { loadConfigLayers } from "./config-runtime.mjs";
import { readEvents } from "./event-log.mjs";
import { readFailures } from "./failures-store.mjs";
import { isPathInside, pathExists, readJson, safeJoin } from "./fs-utils.mjs";
import { loadProject } from "./project-store.mjs";
import { listProjectSkills } from "./skill-runtime.mjs";
import { readRecentToolEvents, makeToolEventsCache } from "./recent-tool-events.mjs";

const toolEventsCache = makeToolEventsCache();

export async function loadDashboardData(workspaceRoot, options = {}) {
  const workspace = path.resolve(workspaceRoot);
  const projectRoot = options.projectRoot
    ? normalizeProjectRoot(workspace, options.projectRoot, { allowExternal: options.allowExternalProjectRoot === true })
    : options.disableProjectFallback === true
      ? null
      : await findLatestProjectRoot(workspace);

  if (!projectRoot) {
    return {
      ok: true,
      hasProject: false,
      workspaceRoot: workspace,
      project: null
    };
  }

  const [project, state, chapterIndex, events, cost, cache, review] = await Promise.all([
    loadProject(projectRoot),
    readJson(safeJoin(projectRoot, "agent_state.json"), {}),
    readJson(safeJoin(projectRoot, "memory", "chapter_index.json"), { chapters: [] }),
    readEvents(projectRoot, { limit: 80 }),
    readJson(safeJoin(projectRoot, "cost.json"), null),
    readJson(safeJoin(projectRoot, "cache_report.json"), null),
    readJson(safeJoin(projectRoot, "review", "reviewer_report.json"), null)
  ]);
  const config = await loadConfigLayers(projectRoot, project);
  const effectiveProject = {
    ...project,
    effective_config: config.effective,
    enabled_skills: config.effective.enabled_skills ?? project.enabled_skills ?? []
  };
  const [skills, sources] = await Promise.all([readSkills(projectRoot, effectiveProject), readSources(projectRoot)]);
  const failures = readFailures(projectRoot);

  const chapters = chapterIndex.chapters ?? [];
  const totalWords = chapters.reduce((sum, chapter) => sum + Number(chapter.actual_words ?? 0), 0);
  const completedChapters = chapters.filter((chapter) => chapter.status === "completed").length;
  const targetChapters = Number(project.target_chapters ?? chapters.length ?? 0);
  const progressPercent = targetChapters > 0 ? Math.round((completedChapters / targetChapters) * 100) : 0;
  const activityProgressPercent = computeActivityProgressPercent({
    completedChapters,
    targetChapters,
    currentStage: state.current_stage,
    projectStatus: state.project_status
  });
  const latestCheckpoint = state.last_checkpoint_id ?? null;

  return {
    ok: true,
    hasProject: true,
    workspaceRoot: workspace,
    projectRoot,
    project: {
      project_id: project.project_id,
      title: project.title,
      story_seed: project.story_seed,
      output_format: project.output_format,
      target_chapters: targetChapters,
      min_words_per_chapter: project.min_words_per_chapter,
      target_words_per_chapter: project.target_words_per_chapter,
      run_mode: project.run_mode,
      active_model: config.effective.active_model,
      stage_overrides: config.effective.stage_overrides,
      tool_permissions: config.effective.tool_permissions,
      budget_config: config.effective.budget_config,
      research_config: config.effective.research_config
    },
    state,
    summary: {
      completedChapters,
      targetChapters,
      progressPercent,
      activityProgressPercent,
      totalWords,
      currentChapterNo: state.current_chapter_no ?? null,
      currentStage: state.current_stage ?? null,
      projectStatus: state.project_status ?? null,
      latestCheckpoint,
      modelCalls: state.active_budget?.model_calls ?? cost?.calls ?? 0,
      maxModelCalls: config.effective.budget_config?.max_model_calls ?? state.active_budget?.max_model_calls ?? null,
      totalTokens: cost?.totalTokens ?? 0,
      estimatedCost: cost?.estimatedCost ?? 0,
      cacheMetricsAvailable: cache?.last_call?.cacheMetricsAvailable ?? false,
      cacheHitRate: cache?.last_call?.cacheHitRate ?? null
    },
    chapters,
    events,
    cost,
    cache,
    cacheSummary: buildCacheSummary(cache),
    config: {
      effective: config.effective,
      layers: config.layers
    },
    skills,
    sources,
    review,
    recent_tool_events: readRecentToolEvents(projectRoot, { cache: toolEventsCache }),
    failures: [
      ...failures.filter(f => !f.resolution).slice(-10),
      ...failures.filter(f => f.resolution).slice(-5)
    ]
  };
}

function buildCacheSummary(cache) {
  const last = cache?.last_call ?? null;
  if (!last) {
    return {
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
    };
  }
  const providerMetricsAvailable = last.cacheMetricsAvailable === true;
  const stableChanged = last.stableChanged === true;
  let explanation = "缓存键稳定；供应商未返回命中指标";
  if (providerMetricsAvailable && Number.isFinite(last.cacheHitRate)) {
    explanation = `缓存命中 ${Math.round(last.cacheHitRate * 100)}%`;
  } else if (stableChanged) {
    explanation = `缓存已刷新 v${last.cacheVersion}`;
  }
  return {
    available: true,
    providerMetricsAvailable,
    cacheKey: last.cacheKey ?? null,
    cacheVersion: last.cacheVersion ?? null,
    stableChanged,
    stableChangedReason: last.stableChangedReason ?? null,
    lastTemplateVersion: last.templateVersion ?? null,
    hitRate: Number.isFinite(last.cacheHitRate) ? last.cacheHitRate : null,
    cachedTokens: Number(last.cachedTokens ?? 0),
    explanation
  };
}

function computeActivityProgressPercent({ completedChapters, targetChapters, currentStage, projectStatus }) {
  if (targetChapters <= 0) {
    return 0;
  }
  if (projectStatus === "completed") {
    return 100;
  }
  const stageOrder = ["queued", "planning", "planned", "drafting", "reviewing", "needs_revision", "revising", "finalizing", "summarizing"];
  const stageIndex = Math.max(0, stageOrder.indexOf(currentStage));
  const stageFraction = projectStatus === "running" ? (stageIndex + 1) / (stageOrder.length + 1) : 0;
  const percent = Math.round(((completedChapters + stageFraction) / targetChapters) * 100);
  return Math.max(projectStatus === "running" ? 4 : 0, Math.min(percent, 99));
}

export async function loadProjectList(workspaceRoot, options = {}) {
  const workspace = path.resolve(workspaceRoot);
  const projects = await findProjectRoots(workspace, { maxDepth: options.maxDepth ?? 4 });
  const items = await Promise.all(
    projects.map(async (item) => {
      const project = await loadProject(item.projectRoot).catch(() => ({}));
      return {
        projectRoot: item.projectRoot,
        title: project.title ?? path.basename(item.projectRoot),
        story_seed: project.story_seed ?? "",
        mtimeMs: item.mtimeMs
      };
    })
  );
  return items.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export async function readChapterContent(projectRoot, chapterNo) {
  const root = path.resolve(projectRoot);
  const targetNo = Number(chapterNo);
  if (!Number.isInteger(targetNo) || targetNo < 1) {
    throw new Error("章节号无效。");
  }
  const chapterIndex = await readJson(safeJoin(root, "memory", "chapter_index.json"), { chapters: [] });
  const chapter = (chapterIndex.chapters ?? []).find((item) => Number(item.chapter_no) === targetNo);
  if (!chapter) {
    throw new Error(`未找到第 ${targetNo} 章。`);
  }
  const finalPath = resolveInsideRoot(root, chapter.final_path);
  const draftPath = resolveInsideRoot(root, chapter.draft_path);
  let sourcePath = null;
  let isDraft = false;
  if (finalPath && (await pathExists(finalPath))) {
    sourcePath = finalPath;
  } else if (draftPath && (await pathExists(draftPath))) {
    sourcePath = draftPath;
    isDraft = true;
  }
  if (!sourcePath) {
    throw new Error(`第 ${targetNo} 章正文文件尚未写入。`);
  }
  const raw = await fs.readFile(sourcePath, "utf8");
  return {
    ok: true,
    chapter_no: targetNo,
    title: chapter.title ?? `第${String(targetNo).padStart(3, "0")}章`,
    status: chapter.status ?? "queued",
    actual_words: Number(chapter.actual_words ?? 0),
    format: sourcePath.endsWith(".txt") ? "txt" : "md",
    is_draft: isDraft,
    content: stripChapterMarkup(raw)
  };
}

function resolveInsideRoot(root, candidate) {
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    return null;
  }
  const resolved = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(root, candidate);
  return isPathInside(root, resolved) ? resolved : null;
}

function stripChapterMarkup(raw) {
  return String(raw)
    .replace(/<!--\s*segment:[^>]*-->/gu, "")
    .replace(/^#\s+Chapter\s+\d+\s*$/imu, "")
    .replace(/^#\s+第.*章.*$/imu, "")
    .replace(/\r\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export async function validateProjectRoot(projectRoot) {
  const target = path.resolve(projectRoot);
  const projectFile = safeJoin(target, "project.yaml");
  if (!(await pathExists(projectFile))) {
    throw new Error(`不是有效的 WWriting 项目文件夹：${target}`);
  }
  await loadProject(target);
  return target;
}

export async function canInitializeProjectRoot(projectRoot) {
  if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
    throw new Error("请输入要初始化的文件夹路径。");
  }
  const target = path.resolve(projectRoot);
  await fs.mkdir(target, { recursive: true });
  const projectFile = safeJoin(target, "project.yaml");
  if (await pathExists(projectFile)) {
    throw new Error(`该文件夹已经包含 project.yaml：${target}`);
  }
  const entries = await fs.readdir(target);
  if (entries.length > 0) {
    throw new Error("为避免误写入，请选择空文件夹，或先打开已有 WWriting 项目。");
  }
  return target;
}

export async function findLatestProjectRoot(workspaceRoot) {
  const candidates = await findProjectRoots(path.resolve(workspaceRoot));
  if (candidates.length === 0) {
    return null;
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0].projectRoot;
}

export async function findProjectRoots(workspaceRoot, options = {}) {
  const maxDepth = options.maxDepth ?? 4;
  const roots = [];
  await visit(path.resolve(workspaceRoot), 0);
  return roots;

  async function visit(dirPath, depth) {
    if (depth > maxDepth) {
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      // 目录不存在或无权限，跳过
      return;
    }
    const projectFile = path.join(dirPath, "project.yaml");
    if (await pathExists(projectFile)) {
      const stat = await fs.stat(projectFile);
      roots.push({ projectRoot: dirPath, mtimeMs: stat.mtimeMs });
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || shouldSkipDir(entry.name)) {
        continue;
      }
      await visit(path.join(dirPath, entry.name), depth + 1);
    }
  }
}

async function readSkills(projectRoot, project) {
  try {
    const skills = await listProjectSkills(projectRoot, project);
    return {
      error: null,
      items: skills.map((skill) => ({
        name: skill.name,
        version: skill.version,
        type: skill.type,
        scope: skill.scope,
        enabled: skill.enabled !== false,
        enabled_in_project: skill.enabled_in_project === true,
        source_type: skill.source_type,
        priority: skill.priority,
        description: skill.description ?? "",
        hooks: skill.hooks.map((hook) => ({
          stage: hook.stage,
          action: hook.action,
          priority: hook.priority
        }))
      }))
    };
  } catch (error) {
    return {
      error: error.message,
      items: []
    };
  }
}

async function readSources(projectRoot) {
  const sourceDir = safeJoin(projectRoot, "sources");
  if (!(await pathExists(sourceDir))) {
    return {
      count: 0,
      promptInjectionWarnings: 0,
      latest: []
    };
  }
  const files = await fs.readdir(sourceDir);
  const snapshots = [];
  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const snapshot = await readJson(safeJoin(sourceDir, file), null);
    if (!snapshot) {
      continue;
    }
    snapshots.push({
      file,
      captured_at: snapshot.captured_at,
      kind: snapshot.kind,
      title: snapshot.title ?? snapshot.query ?? snapshot.url ?? file,
      url: snapshot.url ?? null,
      untrusted: snapshot.untrusted === true,
      warnings: snapshot.warnings ?? []
    });
  }
  snapshots.sort((a, b) => String(b.captured_at ?? "").localeCompare(String(a.captured_at ?? "")));
  return {
    count: snapshots.length,
    promptInjectionWarnings: snapshots.reduce((sum, snapshot) => sum + snapshot.warnings.length, 0),
    latest: snapshots.slice(0, 6)
  };
}

function normalizeProjectRoot(rootPath, targetPath, { allowExternal = false } = {}) {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  if (!allowExternal && !isPathInside(root, target)) {
    throw new Error(`仪表盘项目路径逃出工作区：${target}`);
  }
  return target;
}

function shouldSkipDir(name) {
  return ["node_modules", ".git"].includes(name);
}
