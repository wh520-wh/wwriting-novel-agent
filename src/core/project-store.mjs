import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { appendEvent } from "./event-log.mjs";
import { assertSafeSlug, ensureDir, pathExists, readJson, safeJoin, writeFileAtomic, writeJsonAtomic } from "./fs-utils.mjs";
import { CHAPTER_MEMORY_SCHEMA_VERSION } from "./chapter-memory.mjs";
import { parseSimpleYaml, serializeSimpleYaml } from "./simple-yaml.mjs";
import { ensureMemoryFilesForProject, WORKLOG_PLACEHOLDER } from "./project-operations/memory-files.mjs";

export const SCHEMA_VERSION = 1;

export async function createProject(workspaceRoot, options = {}) {
  const workspace = path.resolve(workspaceRoot);
  const slug = assertSafeSlug(options.slug ?? `novel-${Date.now()}`);
  const projectRoot = safeJoin(workspace, slug);
  return createProjectAt(projectRoot, options);
}

export async function createProjectAt(projectRoot, options = {}) {
  const target = path.resolve(projectRoot);
  await ensureDir(target);
  for (const dir of ["chapters", "drafts", "memory", "skills", "checkpoints", "prompts", "sources"]) {
    await ensureDir(safeJoin(target, dir));
  }
  if (!(await pathExists(safeJoin(target, "run_log.jsonl")))) {
    await fs.writeFile(safeJoin(target, "run_log.jsonl"), "", "utf8");
  }

  const project = {
    schema_version: SCHEMA_VERSION,
    project_id: options.project_id ?? randomUUID(),
    title: options.title ?? "Untitled Novel",
    story_seed: options.story_seed ?? "一个人在雨夜收到一封没有署名的信。",
    root_path: target,
    output_format: options.output_format ?? "md",
    target_chapters: options.target_chapters ?? 3,
    min_words_per_chapter: options.min_words_per_chapter ?? 3000,
    target_words_per_chapter: options.target_words_per_chapter ?? 3300,
    run_mode: options.run_mode ?? "auto",
    default_writer_model: options.default_writer_model ?? null,
    default_reviewer_model: options.default_reviewer_model ?? null,
    // 未配置模型 = active_model: null（用户面不再以 mock 作为兜底）
    active_model: options.active_model ?? null,
    // 统一 Agent 内核计划 Rule 9：project.yaml 保存项目身份与配置；
    // .wwriting/agent/ 由 ProjectAgent 惰性创建，旧运行态文件不再创建。
    // Task 12：不再默认填充 enabled_skills（技能改为发现即生效，无启停集合）。
    // Task 12：旧世界的持久字段从新项目默认值与运行时领域模型删除（旧项目已
    // 存在的字段由保存器自然保留，但生产代码不读取、不驱动行为）。
    output_style: options.output_style ?? "creative",
    archived_at: options.archived_at ?? null,
    tool_permissions: {
      network_allowed: options.network_allowed ?? false,
      safe_edit: true,
      read_only: false,
      auto_edit: false,
      yolo: false,
      dangerous: false,
      ...(options.tool_permissions ?? {})
    },
    prompt_template_versions: {
      planning: "v1",
      drafting: "v1",
      reviewing: "v1"
    }
  };
  await writeFileAtomic(safeJoin(target, "project.yaml"), serializeSimpleYaml(project));
  await writeJsonAtomic(safeJoin(target, "memory", "chapter_index.json"), {
    schema_version: SCHEMA_VERSION,
    chapters: []
  });
  await writeJsonAtomic(safeJoin(target, "memory", "chapter_memory.json"), {
    schema_version: CHAPTER_MEMORY_SCHEMA_VERSION,
    chapters: []
  });
  await writeFileAtomic(safeJoin(target, "book_summary.md"), "# 全书摘要\n\n");
  await writeFileAtomic(safeJoin(target, "WORKLOG.md"), WORKLOG_PLACEHOLDER);
  await writeFileAtomic(safeJoin(target, "sources.md"), "# Sources\n\n");
  await writeFileAtomic(safeJoin(target, "source_summaries.md"), "# Source Summaries\n\n");
  await writeFileAtomic(safeJoin(target, "OUTLINE.md"), "# OUTLINE.md\n\n> 蓝图未生成，请运行 /init\n");
  await writeFileAtomic(safeJoin(target, "SETTING.md"), "# SETTING.md\n\n> 蓝图未生成，请运行 /init\n");
  await writeFileAtomic(safeJoin(target, "prompts", "drafting.v1.md"), "章节正文必须通过工具调用写入本地文件。\n");
  // Task 12：新项目不再为 enabled_skills 写入 skills/*/skill.json——内置技能来自
  // src/skills 的 SKILL.md，由 catalog 发现；项目 skills/ 目录保持为空。
  await appendEvent(target, {
    type: "project_created",
    project_id: project.project_id,
    message: "项目已创建",
    data: { projectRoot: target }
  });
  return { projectRoot: target, project };
}

export async function loadProject(projectRoot) {
  // 第九轮：老项目记忆文件迁移（幂等；失败不阻断项目读取）。
  try { await ensureMemoryFilesForProject(projectRoot); } catch { /* 只读兜底 */ }
  const source = await fs.readFile(safeJoin(projectRoot, "project.yaml"), "utf8");
  return parseSimpleYaml(source);
}

// Task 12：保存配置时移除已废弃的 enabled_skills 字段（旧 project.yaml 允许
// parser 忽略一版；这里在落盘前剥离，保证新保存的配置不再携带启停集合）。
// 不能把空数组解释成"自动启用"，也不保留任何启停分支。
export async function saveProject(projectRoot, project) {
  const cleaned = stripDeprecatedProjectFields(project);
  return writeFileAtomic(safeJoin(projectRoot, "project.yaml"), serializeSimpleYaml(cleaned));
}

function stripDeprecatedProjectFields(project) {
  if (!project || typeof project !== "object" || Array.isArray(project)) return project;
  if (!Object.hasOwn(project, "enabled_skills")) return project;
  const { enabled_skills: _ignored, ...rest } = project;
  return rest;
}

export async function loadChapterIndex(projectRoot) {
  return readJson(safeJoin(projectRoot, "memory", "chapter_index.json"), {
    schema_version: SCHEMA_VERSION,
    chapters: []
  });
}

export async function saveChapterIndex(projectRoot, index) {
  return writeJsonAtomic(safeJoin(projectRoot, "memory", "chapter_index.json"), index);
}

export async function upsertChapter(projectRoot, patch) {
  const index = await loadChapterIndex(projectRoot);
  const existing = index.chapters.find((chapter) => chapter.chapter_no === patch.chapter_no);
  const now = new Date().toISOString();
  if (existing) {
    Object.assign(existing, patch, { updated_at: now });
  } else {
    index.chapters.push({
      title: `第${String(patch.chapter_no).padStart(3, "0")}章`,
      status: "queued",
      draft_path: null,
      final_path: null,
      actual_words: 0,
      checksum: null,
      created_at: now,
      updated_at: now,
      ...patch
    });
  }
  index.chapters.sort((a, b) => a.chapter_no - b.chapter_no);
  await saveChapterIndex(projectRoot, index);
  return index.chapters.find((chapter) => chapter.chapter_no === patch.chapter_no);
}
