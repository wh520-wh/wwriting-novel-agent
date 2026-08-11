import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { appendEvent } from "./event-log.mjs";
import { assertSafeSlug, ensureDir, pathExists, readJson, safeJoin, sha256, writeFileAtomic, writeJsonAtomic } from "./fs-utils.mjs";
import { CHAPTER_MEMORY_SCHEMA_VERSION } from "./chapter-memory.mjs";
import { parseSimpleYaml, serializeSimpleYaml } from "./simple-yaml.mjs";

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
    // 统一 Agent 内核计划 Rule 9：project.yaml 保存项目身份、配置与 blueprint_status；
    // .wwriting/agent/ 由 ProjectAgent 惰性创建，旧运行态文件不再创建。
    // Task 12：不再默认填充 enabled_skills（技能改为发现即生效，无启停集合）。
    blueprint_status: options.blueprint_status ?? "none",
    stage_overrides: options.stage_overrides ?? null,
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
  await writeFileAtomic(safeJoin(target, "memory", "book_summary.md"), "# 全书摘要\n\n");
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

// 章节产物证据（统一 Agent 内核计划 Task 7 legacy 语义）：chapters/ 目录有章节
// 文件（.md/.txt，过滤系统杂项如 Thumbs.db/desktop.ini/子目录），或
// chapter_index.json 有索引。仅由一次性只读导入器 agent/legacy-import.mjs 使用，
// 用于在旧状态缺失 blueprint_status 时按章节证据判定 "legacy"/"none"。
export async function hasChapterArtifacts(projectRoot) {
  const chaptersDir = safeJoin(projectRoot, "chapters");
  if (await pathExists(chaptersDir)) {
    try {
      const entries = await fs.readdir(chaptersDir);
      if (entries.some((name) => /\.(md|txt)$/i.test(name))) return true;
    } catch {
      // 目录不可读时继续看索引
    }
  }
  const index = await readJson(safeJoin(projectRoot, "memory", "chapter_index.json"), { chapters: [] });
  return Array.isArray(index?.chapters) && index.chapters.length > 0;
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
      quality_gate_results: [],
      created_at: now,
      updated_at: now,
      ...patch
    });
  }
  index.chapters.sort((a, b) => a.chapter_no - b.chapter_no);
  await saveChapterIndex(projectRoot, index);
  return index.chapters.find((chapter) => chapter.chapter_no === patch.chapter_no);
}

// checkpoint 文件本体写入（统一 Agent 内核计划 Rule 9：正式章节 checkpoint 继续
// 保存在项目 checkpoints/，journal 只记录引用；本函数不再同步任何 agent_state
// 状态文件——运行态与 last_checkpoint_id 归属 journal 与章节索引）。
export async function writeCheckpoint(projectRoot, payload) {
  const checkpoint_id = payload.checkpoint_id ?? randomUUID();
  const checkpoint = {
    schema_version: SCHEMA_VERSION,
    checkpoint_id,
    timestamp: new Date().toISOString(),
    task_id: payload.task_id ?? null,
    task_contract: payload.task_contract ?? null,
    committed_model_calls: payload.committed_model_calls ?? [],
    artifact_commit: payload.artifact_commit ?? null,
    chapter_no: payload.chapter_no ?? null,
    stage: payload.stage ?? null,
    segment_no: payload.segment_no ?? null,
    model_config: payload.model_config ?? {},
    prompt_template_versions: payload.prompt_template_versions ?? {},
    context_package_hash: payload.context_package_hash ?? sha256(JSON.stringify(payload.context_package ?? {})),
    prompt_block_hashes: payload.prompt_block_hashes ?? {},
    model_calls: payload.model_calls ?? [],
    usage_reports: payload.usage_reports ?? [],
    cost_summary: payload.cost_summary ?? null,
    cache_report: payload.cache_report ?? null,
    cache_key: payload.cache_key ?? null,
    skill_hooks: payload.skill_hooks ?? [],
    skill_gate_results: payload.skill_gate_results ?? [],
    transcript: payload.transcript ?? null,
    tool_calls: payload.tool_calls ?? [],
    tool_results: payload.tool_results ?? [],
    state_before: payload.state_before ?? null,
    state_after: payload.state_after ?? null,
    error: payload.error ?? null
  };
  const targetPath = safeJoin(projectRoot, "checkpoints", `${checkpoint_id}.json`);
  await writeJsonAtomic(targetPath, checkpoint);
  await appendEvent(projectRoot, {
    type: "checkpoint_written",
    project_id: payload.project_id,
    chapter_no: checkpoint.chapter_no,
    stage: checkpoint.stage,
    message: "checkpoint 已写入",
    data: { checkpoint_id }
  });
  return checkpoint;
}
