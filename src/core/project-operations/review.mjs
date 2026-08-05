// src/core/project-operations/review.mjs —— 只读项目/章节证据审查（统一 Agent 内核计划 Task 5）。
//
// 职责（Rule 6 深模块）：基于项目文件与可观察证据审查章节、设定或全书；返回结构化
// findings。绝不调用模型、绝不写任何项目文件（也不写 review 报告目录）。
//
// 移植来源（只读参考）：src/core/reviewer-agent.mjs 的确定性规则（completed 章节
// 文件证据、字数/校验和/索引一致性、checkpoint 存在性）+ continuity/timeline 的
// 确定性矛盾检查。不复制其旧 agent_state 读取（Rule 9：完成事实由章节文件 +
// 章节索引证明），不运行第二模型循环。
//
// scope： "chapter"（只查章节证据）| "setting"（只查设定/连续性/时间线）| "book"（全部）。

import fs from "node:fs/promises";
import path from "node:path";

import { loadChapterMemory } from "../chapter-memory.mjs";
import { loadContinuity } from "../continuity-store.mjs";
import { isPathInside, pathExists, readJson, safeJoin, sha256 } from "../fs-utils.mjs";
import { loadChapterIndex, loadProject } from "../project-store.mjs";
import { checkTimeline } from "../timeline-check.mjs";
import { countEffectiveWords } from "../word-count.mjs";
import { BLUEPRINT_PLACEHOLDER } from "./blueprint.mjs";

export const REVIEW_SCOPES = Object.freeze(["chapter", "setting", "book"]);

export class ReviewOperationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReviewOperationError";
    this.code = code;
  }
}

export async function reviewProject({ projectRoot, scope = "book" }) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw new ReviewOperationError("invalid_project_root", "projectRoot 必须是非空路径。");
  }
  if (!REVIEW_SCOPES.includes(scope)) {
    throw new ReviewOperationError("invalid_scope", `scope 必须是 ${REVIEW_SCOPES.join("|")} 之一。`);
  }

  const root = path.resolve(projectRoot);
  const [project, chapterIndex, continuity] = await Promise.all([
    loadProject(root),
    loadChapterIndex(root),
    loadContinuity(root)
  ]);
  // scope=setting 只查设定/连续性，不加载章节记忆（按需加载）
  const chapterMemory = scope === "setting" ? null : await loadChapterMemory(root);

  const findings = [];

  if (scope !== "setting") {
    await reviewChapterFiles({ root, project, chapterIndex, chapterMemory, findings });
  }
  if (scope !== "chapter") {
    await reviewSettingEvidence({ root, project, continuity, findings });
  }

  const completedChapters = (chapterIndex.chapters ?? []).filter((c) => c.status === "completed");
  return {
    schema_version: 1,
    reviewed_at: new Date().toISOString(),
    project_id: project.project_id ?? null,
    project_title: project.title ?? null,
    scope,
    status: reportStatus(findings),
    summary: {
      findings: findings.length,
      p1: findings.filter((f) => f.severity === "P1").length,
      p2: findings.filter((f) => f.severity === "P2").length,
      p3: findings.filter((f) => f.severity === "P3").length,
      completed_chapters: completedChapters.length,
      target_chapters: Number(project.target_chapters ?? 0)
    },
    findings
  };
}

// ---------------------------------------------------------------------------
// 章节证据（从 reviewer-agent.mjs reviewChapterFiles 移植；不依赖 agent_state）
// ---------------------------------------------------------------------------

async function reviewChapterFiles({ root, project, chapterIndex, chapterMemory, findings }) {
  const minWords = Number(project.min_words_per_chapter ?? 0);
  const checkpoints = await readCheckpoints(root);
  const memorizedNos = new Set(chapterMemory.chapters.map((c) => Number(c.chapter_no)));
  const chapters = (chapterIndex.chapters ?? []).sort((a, b) => Number(a.chapter_no) - Number(b.chapter_no));

  for (const chapter of chapters) {
    if (chapter.status !== "completed") {
      continue;
    }
    const chapterNo = chapter.chapter_no;
    if (!chapter.final_path) {
      addFinding(findings, "P1", "completed_chapter_missing_final_path", "已完成章节没有 final_path。", { chapter_no: chapterNo });
      continue;
    }
    if (!isPathInside(root, chapter.final_path)) {
      addFinding(findings, "P1", "chapter_path_escapes_project", "已完成章节 final_path 越出项目根目录。", {
        chapter_no: chapterNo,
        final_path: chapter.final_path
      });
      continue;
    }
    if (!(await pathExists(chapter.final_path))) {
      addFinding(findings, "P1", "completed_chapter_file_missing", "已完成章节的正式文件缺失。", {
        chapter_no: chapterNo,
        final_path: chapter.final_path
      });
      continue;
    }

    const content = await fs.readFile(chapter.final_path, "utf8");
    const actualWords = countEffectiveWords(content);
    if (actualWords < minWords) {
      addFinding(findings, "P1", "completed_chapter_below_min_words", "已完成章节低于项目最低字数。", {
        chapter_no: chapterNo,
        actual_words: actualWords,
        min_words: minWords
      });
    }
    if (Number(chapter.actual_words ?? 0) !== actualWords) {
      addFinding(findings, "P2", "chapter_index_word_count_mismatch", "章节索引字数与本地文件不一致。", {
        chapter_no: chapterNo,
        indexed_words: chapter.actual_words,
        actual_words: actualWords
      });
    }
    if (!chapter.checksum) {
      addFinding(findings, "P1", "completed_chapter_missing_checksum", "已完成章节缺少校验和记录。", {
        chapter_no: chapterNo
      });
    } else if (chapter.checksum !== sha256(content)) {
      addFinding(findings, "P1", "chapter_checksum_mismatch", "章节校验和与本地正式文件不一致。", {
        chapter_no: chapterNo,
        indexed_checksum: chapter.checksum,
        actual_checksum: sha256(content)
      });
    }
    if (!hasPassedWordGate(chapter)) {
      addFinding(findings, "P2", "completed_chapter_missing_word_gate", "已完成章节没有通过（或被用户例外）的字数门禁记录。", {
        chapter_no: chapterNo
      });
    }
    if (!memorizedNos.has(Number(chapterNo))) {
      addFinding(findings, "P2", "completed_chapter_missing_memory", "已完成章节没有章节记忆记录。", {
        chapter_no: chapterNo
      });
    }
    if (!checkpoints.some((checkpoint) => checkpoint.chapter_no === chapterNo && ["summarizing", "completed"].includes(checkpoint.stage))) {
      addFinding(findings, "P3", "completed_chapter_missing_late_checkpoint", "已完成章节没有 summarizing/completed checkpoint。", {
        chapter_no: chapterNo
      });
    }
  }
}

function hasPassedWordGate(chapter) {
  return (chapter.quality_gate_results ?? []).some(
    (result) =>
      result.gate === "word-count-gate" && (result.status === "passed" || result.status === "excepted")
  );
}

// ---------------------------------------------------------------------------
// 设定/连续性证据（确定性：continuity 事实冲突 + 故事时钟 + 蓝图占位）
// ---------------------------------------------------------------------------

async function reviewSettingEvidence({ root, project, continuity, findings }) {
  for (const fact of continuity.facts ?? []) {
    if (fact.conflict_with) {
      addFinding(findings, "P2", "continuity_fact_conflict", "设定档案中存在未裁决的事实冲突。", {
        entity: fact.entity,
        attribute: fact.attribute,
        value: fact.value,
        conflict_with: fact.conflict_with,
        chapter_no: fact.chapter_no ?? null
      });
    }
  }

  const { violations } = checkTimeline(continuity.timeline ?? []);
  for (const violation of violations) {
    addFinding(findings, "P2", "timeline_violation", "故事时间线存在矛盾。", {
      type: violation.type,
      chapter_no: violation.chapter_no ?? null,
      prior_chapter: violation.prior_chapter ?? null,
      detail: violation.detail
    });
  }

  const blueprintStatus = project.blueprint_status ?? "none";
  const outline = await readBlueprintFile(root, "OUTLINE.md");
  const setting = await readBlueprintFile(root, "SETTING.md");
  if (blueprintStatus === "complete") {
    if (!outline || outline.placeholder) {
      addFinding(findings, "P2", "outline_missing_for_complete_blueprint", "blueprint_status 为 complete 但 OUTLINE.md 缺失或仍是占位。");
    }
    if (!setting || setting.placeholder) {
      addFinding(findings, "P2", "setting_missing_for_complete_blueprint", "blueprint_status 为 complete 但 SETTING.md 缺失或仍是占位。");
    }
  }
}

async function readBlueprintFile(projectRoot, fileName) {
  const filePath = safeJoin(projectRoot, fileName);
  if (!(await pathExists(filePath))) {
    return null;
  }
  const content = await fs.readFile(filePath, "utf8");
  return { exists: true, placeholder: BLUEPRINT_PLACEHOLDER.test(content.trim()) };
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

async function readCheckpoints(projectRoot) {
  const checkpointDir = safeJoin(projectRoot, "checkpoints");
  if (!(await pathExists(checkpointDir))) {
    return [];
  }
  const files = await fs.readdir(checkpointDir);
  const checkpoints = [];
  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    checkpoints.push(await readJson(safeJoin(checkpointDir, file), {}));
  }
  return checkpoints;
}

function addFinding(findings, severity, code, message, data = {}) {
  findings.push({ severity, code, message, data });
}

function reportStatus(findings) {
  if (findings.some((finding) => finding.severity === "P1")) {
    return "failed";
  }
  if (findings.length > 0) {
    return "warning";
  }
  return "passed";
}
