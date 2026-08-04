import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { appendEvent } from "./event-log.mjs";
import { assertSafeSlug, ensureDir, pathExists, readJson, safeJoin, sha256, writeFileAtomic, writeJsonAtomic } from "./fs-utils.mjs";
import { CHAPTER_MEMORY_SCHEMA_VERSION } from "./chapter-memory.mjs";
import { ensureBuiltinSkill } from "./skill-runtime.mjs";
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
    default_writer_model: options.default_writer_model ?? "mock-writer",
    default_reviewer_model: options.default_reviewer_model ?? "mock-reviewer",
    active_model: options.active_model ?? {
      provider: "mock",
      model_name: "mock-writer"
    },
    stage_overrides: options.stage_overrides ?? {
      enabled: false
    },
    enabled_skills: options.enabled_skills ?? [],
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
  await writeJsonAtomic(safeJoin(target, "agent_state.json"), {
    schema_version: SCHEMA_VERSION,
    project_status: "idle",
    blueprint_status: "none",
    current_chapter_no: 1,
    current_stage: "queued",
    current_segment_no: 0,
    retry_counts: {},
    last_checkpoint_id: null,
    pending_user_confirmation: null,
    active_budget: {
      model_calls: 0,
      max_model_calls: options.max_model_calls ?? null,
      revision_rounds_by_chapter: {},
      max_revision_rounds_per_chapter: options.max_revision_rounds_per_chapter ?? null
    }
  });
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
  for (const skillName of project.enabled_skills) {
    await ensureBuiltinSkill(target, skillName);
  }
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

export async function saveProject(projectRoot, project) {
  return writeFileAtomic(safeJoin(projectRoot, "project.yaml"), serializeSimpleYaml(project));
}

// 章节产物证据（spec §1.4 P2-5 legacy 语义）：chapters/ 目录有章节文件（.md/.txt，过滤系统杂项
// 如 Thumbs.db/desktop.ini/子目录），或 chapter_index.json 有索引。
// 用于 loadState 动态标 legacy 与 blueprint-guard 对 agent_state.json 缺失时的兜底判定。
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

export async function loadState(projectRoot) {
  const state = await readJson(safeJoin(projectRoot, "agent_state.json"));
  if (state && (state.blueprint_status === undefined || state.blueprint_status === null)) {
    // spec §1.4 P2-5：字段缺失（升级前旧项目 / 手写夹具）时按章节证据动态判定：
    // 有章节产物 → legacy（允许写作），无产物 → none（拒绝）。
    // structuredClone 后再注入：loadState 是纯读取，调用方 saveState(state) 不会把动态值
    // 意外落盘（避免 legacy 判定变粘性、与"不写回磁盘"注释矛盾）。
    // 新建项目（createProjectAt）必有字段 "none"，不会误标。
    const enriched = structuredClone(state);
    enriched.blueprint_status = (await hasChapterArtifacts(projectRoot)) ? "legacy" : "none";
    return enriched;
  }
  return state;
}

export async function saveState(projectRoot, state) {
  return writeJsonAtomic(safeJoin(projectRoot, "agent_state.json"), state);
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
    // transcript 备份：写作 agent 循环消息链序列化（对齐 checkpointPayload 的 transcript 字段），
    // 成功完成时由 draftNextSegment/reviseChapter 写入；5 轮约 30KB，可接受。
    transcript: payload.transcript ?? null,
    tool_calls: payload.tool_calls ?? [],
    tool_results: payload.tool_results ?? [],
    state_before: payload.state_before ?? null,
    state_after: payload.state_after ?? null,
    error: payload.error ?? null
  };
  const targetPath = safeJoin(projectRoot, "checkpoints", `${checkpoint_id}.json`);
  await writeJsonAtomic(targetPath, checkpoint);
  const state = await loadState(projectRoot);
  state.last_checkpoint_id = checkpoint_id;
  await saveState(projectRoot, state);
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
