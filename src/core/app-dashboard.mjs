import fs from "node:fs/promises";
import path from "node:path";
import { loadConfigLayers } from "./config-runtime.mjs";
import { readEvents } from "./event-log.mjs";
import { isPathInside, pathExists, readJson, safeJoin } from "./fs-utils.mjs";
import { loadProject } from "./project-store.mjs";
import { inspectChapterArtifact } from "./chapter-artifact.mjs";
import { skillService } from "./skills/index.mjs";

// 项目仪表盘（统一 Agent 内核计划 Task 9 重写）。
// 只返回项目/章节/成本/设置/技能/资料等静态与领域事实；不再读取旧运行态文件，
// 不再返回旧审查报告、故障卡、recent tool events 或运行进度推断（运行状态由
// AgentSurface 消费 ProjectAgent snapshot；dashboard 不推测 Agent 是否繁忙）。
// Task 12：技能列表改读新 catalog；Task 13：DTO 移除启停集合字段（发现即生效）。
//（发现即生效，无启停集合）。
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

  const [project, chapterIndex, events, cost, cache] = await Promise.all([
    loadProject(projectRoot),
    readJson(safeJoin(projectRoot, "memory", "chapter_index.json"), { chapters: [] }),
    readEvents(projectRoot, { limit: 80 }),
    readJson(safeJoin(projectRoot, "cost.json"), null),
    readJson(safeJoin(projectRoot, "cache_report.json"), null)
  ]);
  const config = await loadConfigLayers(projectRoot, project);
  const effectiveProject = {
    ...project,
    effective_config: config.effective
  };
  // skills service：注入优先（测试传临时 root 的 service），缺省全局单例。
  const skills = options.skillService ?? skillService;
  const [skillsData, sources] = await Promise.all([readSkills(projectRoot, skills), readSources(projectRoot)]);

  const indexedChapters = chapterIndex.chapters ?? [];
  const chapters = await Promise.all(
    indexedChapters.map(async (chapter) => ({
      ...chapter,
      artifact: await inspectChapterArtifact({
        projectRoot,
        chapter: chapter.chapter_no,
        indexEntry: chapter
      })
    }))
  );
  const totalWords = chapters.reduce((sum, chapter) => sum + Number(chapter.actual_words ?? 0), 0);
  const completedChapters = chapters.filter((chapter) => chapter.artifact.state === "committed").length;
  const targetChapters = Number(project.target_chapters ?? chapters.length ?? 0);
  const progressPercent = targetChapters > 0 ? Math.round((completedChapters / targetChapters) * 100) : 0;

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
      tool_permissions: project.tool_permissions ?? {},
      archived_at: project.archived_at ?? null,
      budget_config: config.effective.budget_config,
      research_config: config.effective.research_config
    },
    summary: {
      completedChapters,
      targetChapters,
      progressPercent,
      totalWords,
      totalTokens: cost?.totalTokens ?? 0,
      estimatedCost: cost?.estimatedCost ?? 0,
      costAvailable: cost?.costAvailable ?? false,
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
    skills: skillsData,
    sources
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

// 工作区资格（计划 Task 4）：文件夹 = 工作区 = 项目。只要求目录存在且可访问，
// Git、project.yaml、.wwriting/、WWRITING.md 都不是聊天资格条件（SPEC §2.1）。
// 错误必须是可行动中文文案（用户看不到 ENOENT/路径/堆栈）。
export async function validateWorkspaceRoot(projectRoot) {
  if (typeof projectRoot !== "string" || projectRoot.trim() === "") {
    throw new Error("请选择一个工作文件夹。");
  }
  const target = path.resolve(projectRoot);
  let stat;
  try {
    stat = await fs.stat(target);
    await fs.access(target);
  } catch {
    throw new Error("工作文件夹不存在或无法访问，请检查后重试。");
  }
  if (!stat.isDirectory()) throw new Error("选择的路径不是文件夹。");
  return target;
}

// 旧结构化领域内部兼容：仅当目录里确实有 project.yaml 时才用于旧领域操作，
// 不再参与聊天资格判断（POST /api/projects/open 改走 validateWorkspaceRoot）。
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

async function readSkills(projectRoot, skills) {
  try {
    const { active, migration_errors } = await skills.catalog({ projectRoot });
    return {
      error: null,
      migration_errors,
      items: active.map((skill) => ({
        name: skill.name,
        version: skill.version,
        type: skill.metadata?.wwriting?.type ?? null,
        scope: skill.metadata?.wwriting?.scope ?? "chapter",
        // Task 13：无启停集合、无 per-project 启用集；目录里的技能都是 active，
        // DTO 不再返回启停字段。
        source_type: skill.source,
        priority: skill.metadata?.wwriting?.priority ?? 100,
        description: skill.description ?? "",
        hooks: (skill.metadata?.wwriting?.hooks ?? []).map((hook) => ({
          stage: hook.stage,
          action: hook.action,
          priority: hook.priority ?? skill.metadata?.wwriting?.priority ?? 100
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
