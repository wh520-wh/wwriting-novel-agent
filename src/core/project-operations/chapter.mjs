// src/core/project-operations/chapter.mjs —— 章节项目事务（统一 Agent 内核计划 Task 5）。
//
// 职责（Rule 6 深模块）：章节草稿、正式提交、章节索引、章节记忆、摘要与 checkpoint
// 一致性。Agent runtime 只编排；本模块是唯一的章节领域事实读写方。
//
// Task 14 边界（与派生记忆解耦）：commitChapter 只承担确定性提交事务（项目身份、
// 校验和、正式文件、章节索引、章节记忆摘录、checkpoint、run_log，原子写/回滚）；
// continuity 由独立的 updateMemoryFromExtraction(...) 接收已解析的提取数据后
// 确定性落盘——可失败/可重试，失败绝不回滚已提交正文。触发派生提取（memory
// extractor）是 Agent runtime 的编排职责，不在本模块内联模型调用。
//
// 边界：
//   - 本模块不接收 ModelGateway、不调用模型。模型类检查（fact-check、记忆提取）
//     由 Agent runtime 完成，结果经调用参数（extraction）传入本模块做
//     确定性落盘。
//   - 本模块不读写旧 agent_state 状态文件；章节位置与完成事实只由章节文件 +
//     memory/chapter_index.json 推导（Rule 9）。
//   - 不写 Agent journal（journal 事件归 runtime 的 segments）；正式提交的领域事实写
//     run_log.jsonl（event-log.mjs，计划 Rule 9）。run_log 追加属于事务边界内：
//     失败会连同已写文件一起回滚（截断到先前大小，或删除新建的空文件）。
//   - 磁盘格式与旧实现保持兼容：章节文件 chapters/NNN.ext、草稿 drafts/NNN.draft.ext、
//     memory/chapter_index.json、memory/chapter_memory.json、checkpoints/{id}.json。
//   - 错误契约：领域错误（参数、存储安全、校验和、索引 JSON 损坏）统一抛
//     ProjectOperationError；写入期的系统 I/O 错误原样抛出（保证已回滚，可能附加
//     error.rollbackWarnings）。process 级不可恢复错误不在此列。
//   - 测试 seam：所有导出操作接受可选第二参数 options = { hooks: { beforeWrite } }。
//     beforeWrite({ path, kind, attempt }) 在每次事务正向写入前调用；抛错即模拟该
//     次写入失败并触发完整回滚。回滚写入不经过探针。生产调用（Task 6）不传 options，
//     默认无探针、行为不变。
//
// 移植来源（只读参考）：src/core/tool-runtime.mjs（segment 幂等、非正文检测、草稿
// 读取、正式文件提交）、src/core/agent-engine.mjs（finalizeChapter / completeChapter /
// extractChapterMemory 的领域事实）。不复制 run loop / state dispatch / transcript。
//
// Task 10 存储安全契约：commit_chapter 只保留草稿存在、路径边界、项目身份、校验和、
// 原子写入、回滚与索引一致性约束；字数、标题格式或技能 checker 一律不是门禁，不能
// 阻止写入、提交或 Agent 结束。actual_words 只作客观记录（索引/历史兼容），不决定
// 能否提交。post-process 技能钩子与内容质量门禁已全部删除；索引固定写
// quality_gate_results: []（仅新提交生效，旧索引已有 gate 结果不批量改写）。

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { throwIfAborted } from "../cancellation.mjs";
import { appendEvent } from "../event-log.mjs";
import {
  ensureDir,
  pathExists,
  safeJoin,
  sha256,
  writeFileAtomic,
  writeJsonAtomic
} from "../fs-utils.mjs";
import { loadChapterIndex, loadProject, upsertChapter } from "../project-store.mjs";
import { countEffectiveWords } from "../word-count.mjs";
import { ensureBaselineVersion, listChapterVersions, readChapterVersion, snapshotChapter } from "./versions.mjs";
import { recordChapterMemory } from "../chapter-memory.mjs";
import {
  loadContinuity,
  mergeExtraction,
  renderContinuityMarkdown
} from "../continuity-store.mjs";
import { checkTimeline } from "../timeline-check.mjs";

// ---------------------------------------------------------------------------
// 错误与校验
// ---------------------------------------------------------------------------

export class ProjectOperationError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "ProjectOperationError";
    this.code = code;
    this.details = details;
  }
}

const MAX_CONTENT_CHARS = 200_000;

function assertProjectRoot(projectRoot) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw new ProjectOperationError("invalid_project_root", "projectRoot 必须是非空路径。");
  }
}

function assertChapterNo(chapterNo) {
  if (!Number.isInteger(chapterNo) || chapterNo < 1) {
    throw new ProjectOperationError("invalid_chapter_no", "chapter_no 必须是正整数。");
  }
}

function assertProjectIdMatches(project, projectId) {
  if (projectId !== undefined && projectId !== null && projectId !== "" && project.project_id !== projectId) {
    throw new ProjectOperationError("invalid_project_id", "project_id 与当前项目不匹配。");
  }
}

async function loadProjectForOperation(projectRoot, projectId) {
  assertProjectRoot(projectRoot);
  let project;
  try {
    project = await loadProject(projectRoot);
  } catch (error) {
    throw new ProjectOperationError("project_not_found", `无法读取 project.yaml：${error.message}`);
  }
  assertProjectIdMatches(project, projectId);
  return project;
}

// 章节索引 JSON 损坏（坏 JSON）统一包装为领域错误；I/O 错误原样抛出。
async function loadChapterIndexSafe(projectRoot) {
  try {
    return await loadChapterIndex(projectRoot);
  } catch (error) {
    if (error instanceof ProjectOperationError) {
      throw error;
    }
    throw new ProjectOperationError("chapter_index_invalid", `章节索引不可读：${error.message}`);
  }
}

// 测试写探针：options.hooks.beforeWrite({ path, kind, attempt }) 在每次事务正向
// 写入前调用；抛错即模拟该次写入失败（触发回滚）。生产路径无探针，直接写入。
function createWriteProbe(options) {
  const hook = options?.hooks?.beforeWrite ?? null;
  if (typeof hook !== "function") {
    return async () => {};
  }
  let attempt = 0;
  return async ({ path: targetPath, kind }) => {
    attempt += 1;
    await hook({ path: targetPath, kind, attempt });
  };
}

// ---------------------------------------------------------------------------
// 文件命名约定（与旧实现/受保护路径规则一致，保持磁盘兼容）
// ---------------------------------------------------------------------------

export function chapterFileName(chapterNo, extension = "md") {
  return `${String(chapterNo).padStart(3, "0")}.${extension}`;
}

export function chapterDraftPath(projectRoot, chapterNo, outputFormat) {
  return safeJoin(projectRoot, "drafts", chapterFileName(chapterNo, `draft.${outputFormat}`));
}

export function chapterFinalPath(projectRoot, chapterNo, outputFormat) {
  return safeJoin(projectRoot, "chapters", chapterFileName(chapterNo, outputFormat));
}

export async function readChapterDraft(projectRoot, project, chapterNo) {
  const draftPath = chapterDraftPath(projectRoot, chapterNo, project.output_format);
  if (!(await pathExists(draftPath))) {
    return "";
  }
  return fs.readFile(draftPath, "utf8");
}

// ---------------------------------------------------------------------------
// 非正文内容启发式检测：防止模型把工具调用报错、内心独白、prompt 字段名写入章节。
// 检测对象是应当为小说正文的 content；误伤率应极低（snake_case 工具名与中文小说
// 正文不重叠）。
//
// 选择与权衡（相对旧 tool-runtime 的裸 includes 扫描）：
//   - 全部工具名改用词边界正则 \b…\b：防止 "read_file" 出现在 "read_files" 之类
//     更长 token 中仍被误拒；snake_case 标识符在自然正文中不可能以词边界出现。
//   - 刻意剔除纯英文单词 "shell"：英文正文（如战争小说里的 shell）会以词边界命中，
//     误伤面不可接受；观察到的新架构 shell 工具自我对话都会带 "allowed tools" /
//     "tool is not allowed" 上下文，已被 NON_PROSE_PATTERNS 覆盖。
//   - 幂等 marker 只按段号判重（旧恢复契约：重放段内容必须逐字一致）；同号段内容
//     漂移时仍按重复处理（语义不变），但返回 content_mismatch 供调用方观测。
// ---------------------------------------------------------------------------

const KNOWN_TOOL_NAME_PATTERNS = [
  { name: "append_chapter_segment", re: /\bappend_chapter_segment\b/u },
  { name: "commit_chapter", re: /\bcommit_chapter\b/u },
  { name: "finalize_revision", re: /\bfinalize_revision\b/u },
  { name: "rollback_chapter", re: /\brollback_chapter\b/u },
  { name: "update_plan", re: /\bupdate_plan\b/u },
  { name: "list_files", re: /\blist_files\b/u },
  { name: "search_files", re: /\bsearch_files\b/u },
  { name: "read_file", re: /\bread_file\b/u },
  { name: "write_file", re: /\bwrite_file\b/u },
  { name: "edit_file", re: /\bedit_file\b/u }
];

const NON_PROSE_PATTERNS = [
  { pattern: /\btool\s+is\s+not\s+allowed\b/giu, reason: "包含工具调用被拒的英文描述" },
  { pattern: /\bonly\s+allowed\s+tool\b/giu, reason: "包含白名单限制描述" },
  { pattern: /\ballowed\s+tools?\s+includes?\b/giu, reason: "包含允许工具列表描述" },
  { pattern: /\bsegment_target_words\b/giu, reason: "包含 prompt 内部字段名" }
];

export function detectNonProseContent(content) {
  if (typeof content !== "string") {
    return { isNonProse: true, reason: "content 不是字符串" };
  }
  const text = content;
  for (const { name, re } of KNOWN_TOOL_NAME_PATTERNS) {
    if (re.test(text)) {
      return { isNonProse: true, reason: `包含写作工具名 "${name}"` };
    }
  }
  for (const { pattern, reason } of NON_PROSE_PATTERNS) {
    if (pattern.test(text)) {
      return { isNonProse: true, reason };
    }
  }
  return { isNonProse: false, reason: null };
}

// ---------------------------------------------------------------------------
// inspectChapterContext —— 从请求章节号 + 章节索引推导章节位置
// （绝不读取旧 agent_state；current/next/completed 全部来自文件证据）
// ---------------------------------------------------------------------------

export async function inspectChapterContext({ projectRoot, chapterNo }) {
  assertProjectRoot(projectRoot);
  assertChapterNo(chapterNo);
  const project = await loadProjectForOperation(projectRoot, undefined);
  const index = await loadChapterIndexSafe(projectRoot);
  const chapters = Array.isArray(index.chapters) ? index.chapters : [];
  const entry = chapters.find((chapter) => Number(chapter.chapter_no) === chapterNo) ?? null;
  const completedNos = chapters
    .filter((chapter) => chapter.status === "completed")
    .map((chapter) => Number(chapter.chapter_no))
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b);
  const lastCompleted = completedNos.length > 0 ? completedNos[completedNos.length - 1] : null;

  const outputFormat = project.output_format ?? "md";
  const draftPath = chapterDraftPath(projectRoot, chapterNo, outputFormat);
  const finalPath = chapterFinalPath(projectRoot, chapterNo, outputFormat);

  return {
    chapter_no: chapterNo,
    output_format: outputFormat,
    entry,
    status: entry?.status ?? "not_started",
    is_committed: entry?.status === "completed",
    draft_path: entry?.draft_path ?? null,
    final_path: entry?.final_path ?? null,
    actual_words: Number(entry?.actual_words ?? 0),
    checksum: entry?.checksum ?? null,
    draft_exists: await pathExists(draftPath),
    final_exists: await pathExists(finalPath),
    completed_chapter_nos: completedNos,
    last_completed_chapter_no: lastCompleted,
    // 下一章 = 尚未完成的请求章，否则取已完成最大章的后一章
    next_chapter_no: entry?.status === "completed" ? (lastCompleted ?? chapterNo) + 1 : chapterNo
  };
}

// ---------------------------------------------------------------------------
// appendChapterSegment —— 原子追加草稿段（幂等：同一 segment_no 重复追加不重复写入）
// 原子性：草稿写入成功后才更新索引 draft_path；索引更新失败则还原草稿先前字节，
// 不留"索引指向不存在草稿"的半写状态。
// ---------------------------------------------------------------------------

export async function appendChapterSegment({ projectRoot, projectId, chapterNo, segmentNo, content, signal }, options = {}) {
  assertProjectRoot(projectRoot);
  assertChapterNo(chapterNo);
  if (!Number.isInteger(segmentNo) || segmentNo < 1) {
    throw new ProjectOperationError("invalid_segment_no", "segment_no 必须是正整数。");
  }
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new ProjectOperationError("empty_content", "content 必须是非空字符串。");
  }
  if (content.length > MAX_CONTENT_CHARS) {
    throw new ProjectOperationError("content_too_large", `content 超过 ${MAX_CONTENT_CHARS} 字符。`);
  }
  const project = await loadProjectForOperation(projectRoot, projectId);
  throwIfAborted(signal);

  const nonProseCheck = detectNonProseContent(content);
  if (nonProseCheck.isNonProse) {
    throw new ProjectOperationError(
      "non_prose_content",
      `检测到非正文内容：${nonProseCheck.reason}。请只输出小说正文。`,
      { reason: nonProseCheck.reason }
    );
  }

  const draftPath = chapterDraftPath(projectRoot, chapterNo, project.output_format);
  await ensureDir(path.dirname(draftPath));
  const draftExisted = await pathExists(draftPath);
  const current = draftExisted
    ? await fs.readFile(draftPath, "utf8")
    : `# Chapter ${String(chapterNo).padStart(3, "0")}\n`;
  const probe = createWriteProbe(options);

  const marker = `<!-- segment:${segmentNo} `;
  if (current.includes(marker)) {
    // 幂等：同号段返回 duplicate（重放内容必须逐字一致；漂移只观测不拒绝），
    // 并修复索引 draft_path（旧不变量：只读工具靠 final_path ?? draft_path 解析）。
    await probe({ path: draftPath, kind: "draft_index" });
    await upsertChapter(projectRoot, { chapter_no: chapterNo, draft_path: draftPath });
    const checksumMatch = current.match(new RegExp(`<!-- segment:${segmentNo} checksum:([^ ]+) -->`, "u"));
    return {
      ok: true,
      duplicate: true,
      chapter_no: chapterNo,
      segment_no: segmentNo,
      path: draftPath,
      actual_words: countEffectiveWords(current),
      bytes_written: 0,
      checksum: sha256(current),
      content_mismatch: checksumMatch ? checksumMatch[1] !== sha256(content) : null
    };
  }

  throwIfAborted(signal);
  const block = `\n\n<!-- segment:${segmentNo} checksum:${sha256(content)} -->\n${String(content).trim()}\n`;
  const next = current + block;
  await probe({ path: draftPath, kind: "draft" });
  const written = await writeFileAtomic(draftPath, next);
  try {
    await probe({ path: draftPath, kind: "draft_index" });
    await upsertChapter(projectRoot, { chapter_no: chapterNo, draft_path: draftPath });
  } catch (error) {
    // 段写入成功但索引更新失败 → 还原草稿先前字节，不留半写状态。
    // 从未创建的草稿 unlink 得 ENOENT 不算回滚失败（不产生误导性警告）。
    try {
      if (draftExisted) {
        await writeFileAtomic(draftPath, current);
      } else {
        await fs.unlink(draftPath);
      }
    } catch (rollbackError) {
      if (!(rollbackError.code === "ENOENT" && !draftExisted)) {
        error.rollbackWarnings = [`还原草稿失败：${rollbackError.message}`];
      }
    }
    throw error;
  }
  return {
    ok: true,
    duplicate: false,
    chapter_no: chapterNo,
    segment_no: segmentNo,
    path: draftPath,
    bytes_written: written.bytes_written,
    actual_words: countEffectiveWords(next),
    checksum: written.checksum
  };
}

// ---------------------------------------------------------------------------
// commitChapter —— 原子正式提交：
//   Task 10：只保留存储安全约束（草稿存在、项目身份、expected 校验和、原子写入
//   与回滚）。内容质量（字数/标题格式/技能 checker）一律不是门禁；索引固定写
//   quality_gate_results: []，仅新提交生效，旧索引已有 gate 结果不批量改写。
//   写入顺序：正式文件 → 章节记忆 → 章节索引 → checkpoint → run_log 领域事件。
// 任一写失败：恢复被覆盖文件的先前字节，run_log 截断/删除，不留下半写状态。
// ---------------------------------------------------------------------------

export async function commitChapter({ projectRoot, projectId, chapterNo, expectedDraftChecksum = null }, options = {}) {
  assertProjectRoot(projectRoot);
  assertChapterNo(chapterNo);
  const project = await loadProjectForOperation(projectRoot, projectId);

  const finalPath = chapterFinalPath(projectRoot, chapterNo, project.output_format);
  const draftPath = chapterDraftPath(projectRoot, chapterNo, project.output_format);
  const index = await loadChapterIndexSafe(projectRoot);
  const existing = (index.chapters ?? []).find((chapter) => Number(chapter.chapter_no) === chapterNo) ?? null;

  const finalExists = await pathExists(finalPath);
  const draftExists = await pathExists(draftPath);

  // 幂等：正式文件与 completed 索引都在 → 纯重复提交，零写入。
  if (existing?.status === "completed" && finalExists) {
    const content = await fs.readFile(finalPath, "utf8");
    return {
      ok: true,
      duplicate: true,
      repairing: false,
      chapter_no: chapterNo,
      path: finalPath,
      actual_words: countEffectiveWords(content),
      checksum: sha256(content),
      checkpoint_id: null,
      quality_gate_results: []
    };
  }

  // 源内容：优先正式文件（中断恢复：final 已落盘只修索引，不重写文件），否则草稿。
  let sourceContent;
  let usedFinal = false;
  if (finalExists) {
    try {
      sourceContent = await fs.readFile(finalPath, "utf8");
    } catch (error) {
      throw new ProjectOperationError("chapter_read_failed", `无法读取章节正式文件：${error.message}`, {
        path: finalPath
      });
    }
    usedFinal = true;
  } else if (draftExists) {
    try {
      sourceContent = await fs.readFile(draftPath, "utf8");
    } catch (error) {
      throw new ProjectOperationError("chapter_read_failed", `无法读取章节草稿：${error.message}`, {
        path: draftPath
      });
    }
  } else {
    throw new ProjectOperationError("draft_not_found", `第 ${chapterNo} 章没有可提交的草稿或正式文件。`);
  }

  if (expectedDraftChecksum !== null && expectedDraftChecksum !== sha256(sourceContent)) {
    throw new ProjectOperationError(
      "draft_checksum_mismatch",
      "草稿校验和与预期不符，拒绝提交漂移后的内容。",
      { expected: expectedDraftChecksum }
    );
  }

  // ---- 提交内容与客观记录：不运行 post-process 技能钩子，也不做任何内容门禁 ----
  const commitContent = sourceContent;
  const actualWords = countEffectiveWords(commitContent);
  const checksum = sha256(commitContent);

  // ---- 事务写入（带回滚）----
  const chapterMemoryPath = safeJoin(projectRoot, "memory", "chapter_memory.json");
  const chapterIndexPath = safeJoin(projectRoot, "memory", "chapter_index.json");
  const runLogPath = safeJoin(projectRoot, "run_log.jsonl");
  const checkpointId = randomUUID();
  const checkpointPath = safeJoin(projectRoot, "checkpoints", `${checkpointId}.json`);
  const probe = createWriteProbe(options);
  const backups = [];
  const track = async (filePath) => {
    const existed = await pathExists(filePath);
    backups.push({ path: filePath, bytes: existed ? await fs.readFile(filePath, "utf8") : null });
  };
  if (!usedFinal) {
    await track(finalPath); // 常规提交创建正式文件；回滚时删除
  }
  await track(chapterMemoryPath);
  await track(chapterIndexPath);
  const runLogExisted = await pathExists(runLogPath);
  const runLogSize = runLogExisted ? (await fs.stat(runLogPath)).size : 0;

  try {
    if (!usedFinal) {
      await probe({ path: finalPath, kind: "final" });
      await writeFileAtomic(finalPath, commitContent);
    }
    // 章节记忆（摘要与摘录，确定性）
    await probe({ path: chapterMemoryPath, kind: "chapter_memory" });
    await recordChapterMemory(projectRoot, {
      chapterNo,
      title: `第${String(chapterNo).padStart(3, "0")}章`,
      actualWords,
      checksum,
      content: commitContent
    });
    // 章节索引：正式文件、真实字数、校验和；Task 10 起门禁结果固定为空数组
    await probe({ path: chapterIndexPath, kind: "chapter_index" });
    await upsertChapter(projectRoot, {
      chapter_no: chapterNo,
      status: "completed",
      draft_path: draftPath,
      final_path: finalPath,
      actual_words: actualWords,
      checksum,
      quality_gate_results: []
    });
    // checkpoint：与旧 checkpoints/{id}.json 格式兼容（project-store.writeCheckpoint
    // 会写旧 agent_state 状态文件，本模块不得触碰，故本地写 checkpoint 文件本体）
    await probe({ path: checkpointPath, kind: "checkpoint" });
    await writeJsonAtomic(checkpointPath, buildCheckpoint({
      project,
      chapterNo,
      checkpointId,
      artifact: { chapter_no: chapterNo, final_path: finalPath, checksum, duplicate: usedFinal }
    }));
    // run_log 领域事实（计划 Rule 9：章节提交是 run_log 记录的领域事实）；
    // 追加在事务内：失败时连同已写文件一起回滚。
    await probe({ path: runLogPath, kind: "run_log" });
    await appendEvent(projectRoot, {
      type: "chapter_completed",
      project_id: project.project_id,
      chapter_no: chapterNo,
      stage: "completed",
      message: `第 ${chapterNo} 章已提交`,
      data: {
        path: finalPath,
        actual_words: actualWords,
        checksum,
        checkpoint_id: checkpointId,
        recovered: usedFinal
      }
    });
  } catch (error) {
    const rollbackWarnings = [];
    for (const backup of backups) {
      try {
        if (backup.bytes === null) {
          await fs.unlink(backup.path);
        } else {
          await writeFileAtomic(backup.path, backup.bytes);
        }
      } catch (rollbackError) {
        // 未创建文件的 unlink ENOENT 不算回滚失败（与 run_log 回滚一致）
        if (!(rollbackError.code === "ENOENT" && backup.bytes === null)) {
          rollbackWarnings.push(`恢复 ${backup.path} 失败：${rollbackError.message}`);
        }
      }
    }
    try {
      await fs.unlink(checkpointPath);
    } catch (rollbackError) {
      if (rollbackError.code !== "ENOENT") {
        rollbackWarnings.push(`删除 ${checkpointPath} 失败：${rollbackError.message}`);
      }
    }
    try {
      if (runLogExisted) {
        await fs.truncate(runLogPath, runLogSize);
      } else {
        await fs.unlink(runLogPath);
      }
    } catch (rollbackError) {
      if (rollbackError.code !== "ENOENT") {
        rollbackWarnings.push(`run_log 回滚失败：${rollbackError.message}`);
      }
    }
    if (rollbackWarnings.length > 0) {
      error.rollbackWarnings = rollbackWarnings;
    }
    throw error;
  }

  // 快照触发（模块 C）：成功生效的提交存档当前正式内容。失败不抛、只标记
  // 为 version 状态（版本库是派生归档，不得阻塞/回滚已提交的正文）。
  let snapshot = null;
  try {
    snapshot = await snapshotChapter({
      projectRoot,
      chapterNo,
      content: commitContent,
      source: usedFinal ? "revision" : "commit"
    });
  } catch (snapshotError) {
    snapshot = {
      status: "failed",
      error: { code: snapshotError.code ?? "snapshot_failed", message: snapshotError.message }
    };
  }

  return {
    ok: true,
    duplicate: false,
    repairing: usedFinal,
    chapter_no: chapterNo,
    path: finalPath,
    actual_words: actualWords,
    checksum,
    checkpoint_id: path.basename(checkpointPath, ".json"),
    quality_gate_results: [],
    ...(snapshot ? { version: snapshot } : {})
  };
}

// ---------------------------------------------------------------------------
// finalizeChapter —— 编辑后重新入账（确认修订，Task C3）：
// 正式章节文件（C1 起可直接编辑）被 write_file/edit_file 直接改过后，账本
// （章节索引校验和/字数、章节记忆、checkpoint、run_log 领域事实）仍停留在旧
// 版本。本操作用事务一致性把「已编辑的正式文件」重新入账到账本。
//
// 前置条件：章节已提交（索引 completed 且正式文件存在）；expected_checksum
// 提供时校验与当前文件一致（防止入账漂移后的内容）；non_prose 检测拒绝把
// 工具名/模型自我对话混入正文的修订入账。
// 写入顺序：章节记忆 → 章节索引 → checkpoint → run_log 事件（chapter_revised）。
// 任一写失败：恢复被覆盖文件的先前字节，run_log 截断/删除，不留下半写状态。
// ---------------------------------------------------------------------------

export async function finalizeChapter({ projectRoot, projectId, chapterNo, expectedChecksum = null }, options = {}) {
  assertProjectRoot(projectRoot);
  assertChapterNo(chapterNo);
  const project = await loadProjectForOperation(projectRoot, projectId);
  const finalPath = chapterFinalPath(projectRoot, chapterNo, project.output_format);
  const index = await loadChapterIndexSafe(projectRoot);
  const existing = (index.chapters ?? []).find((chapter) => Number(chapter.chapter_no) === chapterNo) ?? null;
  if (existing?.status !== "completed" || !(await pathExists(finalPath))) {
    throw new ProjectOperationError(
      "chapter_not_committed",
      `第 ${chapterNo} 章尚未提交，不能确认修订。`
    );
  }

  let content;
  try {
    content = await fs.readFile(finalPath, "utf8");
  } catch (error) {
    throw new ProjectOperationError("chapter_read_failed", `无法读取章节正式文件：${error.message}`, {
      path: finalPath
    });
  }
  if (expectedChecksum !== null && expectedChecksum !== sha256(content)) {
    throw new ProjectOperationError("stale_checksum", "章节文件已被其他修改更新，请重新读取后再确认修订。", {
      expected: expectedChecksum
    });
  }
  const nonProse = detectNonProseContent(content);
  if (nonProse.isNonProse) {
    throw new ProjectOperationError(
      "non_prose_content",
      `章节内容非正文（${nonProse.reason}），拒绝入账。`,
      { reason: nonProse.reason }
    );
  }

  const actualWords = countEffectiveWords(content);
  const checksum = sha256(content);

  // ---- 事务写入（同 commitChapter 模式）----
  const chapterMemoryPath = safeJoin(projectRoot, "memory", "chapter_memory.json");
  const chapterIndexPath = safeJoin(projectRoot, "memory", "chapter_index.json");
  const runLogPath = safeJoin(projectRoot, "run_log.jsonl");
  const checkpointId = randomUUID();
  const checkpointPath = safeJoin(projectRoot, "checkpoints", `${checkpointId}.json`);
  const probe = createWriteProbe(options);
  const backups = [];
  const track = async (filePath) => {
    const existed = await pathExists(filePath);
    backups.push({ path: filePath, bytes: existed ? await fs.readFile(filePath, "utf8") : null });
  };
  await track(chapterMemoryPath);
  await track(chapterIndexPath);
  const runLogExisted = await pathExists(runLogPath);
  const runLogSize = runLogExisted ? (await fs.stat(runLogPath)).size : 0;

  try {
    // 章节记忆（摘要与摘录，确定性；用修订后内容重建该章记忆）
    await probe({ path: chapterMemoryPath, kind: "chapter_memory" });
    await recordChapterMemory(projectRoot, {
      chapterNo,
      title: `第${String(chapterNo).padStart(3, "0")}章`,
      actualWords,
      checksum,
      content
    });
    // 章节索引：正式文件、真实字数、新校验和；门禁结果固定为空数组
    await probe({ path: chapterIndexPath, kind: "chapter_index" });
    await upsertChapter(projectRoot, {
      chapter_no: chapterNo,
      status: "completed",
      draft_path: chapterDraftPath(projectRoot, chapterNo, project.output_format),
      final_path: finalPath,
      actual_words: actualWords,
      checksum,
      quality_gate_results: []
    });
    // checkpoint：与 checkpoints/{id}.json 格式兼容（本地写 checkpoint 文件本体）
    await probe({ path: checkpointPath, kind: "checkpoint" });
    await writeJsonAtomic(checkpointPath, buildCheckpoint({
      project,
      chapterNo,
      checkpointId,
      artifact: { chapter_no: chapterNo, final_path: finalPath, checksum, duplicate: false }
    }));
    // run_log 领域事实（追加在事务内：失败时连同已写文件一起回滚）
    await probe({ path: runLogPath, kind: "run_log" });
    await appendEvent(projectRoot, {
      type: "chapter_revised",
      project_id: project.project_id,
      chapter_no: chapterNo,
      stage: "revised",
      message: `第 ${chapterNo} 章已确认修订`,
      data: {
        path: finalPath,
        actual_words: actualWords,
        checksum,
        checkpoint_id: checkpointId
      }
    });
  } catch (error) {
    const rollbackWarnings = [];
    for (const backup of backups) {
      try {
        if (backup.bytes === null) {
          await fs.unlink(backup.path);
        } else {
          await writeFileAtomic(backup.path, backup.bytes);
        }
      } catch (rollbackError) {
        // 未创建文件的 unlink ENOENT 不算回滚失败（与 run_log 回滚一致）
        if (!(rollbackError.code === "ENOENT" && backup.bytes === null)) {
          rollbackWarnings.push(`恢复 ${backup.path} 失败：${rollbackError.message}`);
        }
      }
    }
    try {
      await fs.unlink(checkpointPath);
    } catch (rollbackError) {
      if (rollbackError.code !== "ENOENT") {
        rollbackWarnings.push(`删除 ${checkpointPath} 失败：${rollbackError.message}`);
      }
    }
    try {
      if (runLogExisted) {
        await fs.truncate(runLogPath, runLogSize);
      } else {
        await fs.unlink(runLogPath);
      }
    } catch (rollbackError) {
      if (rollbackError.code !== "ENOENT") {
        rollbackWarnings.push(`run_log 回滚失败：${rollbackError.message}`);
      }
    }
    if (rollbackWarnings.length > 0) {
      error.rollbackWarnings = rollbackWarnings;
    }
    throw error;
  }

  // 版本快照（模块 C，设计 D3 迁移最小单元）：先确保基线（老项目首次修订前的
  // 状态存为 v1 baseline），再存档当前修订版。失败不抛、只标记（派生归档，
  // 不得阻塞/回滚已入账的修订）。
  // options.skipVersionSnapshot：rollbackChapter 复用本函数的重新入账事务时传
  // true，跳过这里的修订快照（回滚由自身存档单个 "rollback" 版本，避免重复）。
  let snapshot = null;
  if (options?.skipVersionSnapshot !== true) {
    try {
      await ensureBaselineVersion({ projectRoot, chapterNo, content });
      snapshot = await snapshotChapter({ projectRoot, chapterNo, content, source: "revision" });
    } catch (snapshotError) {
      snapshot = {
        status: "failed",
        error: { code: snapshotError.code ?? "snapshot_failed", message: snapshotError.message }
      };
    }
  }

  return {
    ok: true,
    chapter_no: chapterNo,
    path: finalPath,
    actual_words: actualWords,
    checksum,
    checkpoint_id: path.basename(checkpointPath, ".json"),
    quality_gate_results: [],
    ...(snapshot ? { version: snapshot } : {})
  };
}

// ---------------------------------------------------------------------------
// rollbackChapter —— 模型侧回滚（第八轮模块 C）：把 .versions/ 中指定版本的快照
// 写回正式章节文件，重新入账（复用 finalizeChapter），并把回滚本身存档为新版本
// （append-only）。
//
// 语义：
//   - version 缺省（null/undefined）= 恢复到「上一版」（当前最新版的前一版）；
//   - 显式 version 等于当前最新版，或缺省"上一版"时当前只有 v1（无更早可回滚）
//     → already_current；
//   - 目标版本不存在 → version_not_found；该章无任何版本 → no_versions；
//   - 覆盖前若当前正式文件与最新版本校验和不一致（用户/外部未入账手动改动），
//     先 snapshotChapter 存 pre_rollback 档，保证覆盖后可恢复（不丢内容）；
//   - 写回后调用 finalizeChapter 重新入账（索引校验和/字数/章节记忆/checkpoint/
//     run_log 一致更新；传 skipVersionSnapshot 避免 finalize 内部的修订快照，
//     因为回滚自身存档唯一的 "rollback" 版本）；再 snapshotChapter source
//     "rollback" 存档为新版本。
// ---------------------------------------------------------------------------

export async function rollbackChapter({ projectRoot, projectId, chapterNo, version = null }, options = {}) {
  assertProjectRoot(projectRoot);
  assertChapterNo(chapterNo);
  const project = await loadProjectForOperation(projectRoot, projectId);

  const finalPath = chapterFinalPath(projectRoot, chapterNo, project.output_format);
  const versions = await listChapterVersions({ projectRoot, chapterNo });
  if (versions.length === 0) {
    throw new ProjectOperationError("no_versions", `第 ${chapterNo} 章没有任何历史版本，无法回滚。`);
  }
  const currentVersion = versions.at(-1).version;
  const targetVersion = version === null || version === undefined ? currentVersion - 1 : Number(version);
  if (targetVersion === currentVersion || targetVersion < 1) {
    // 显式回滚到当前版，或缺省"上一版"但当前只有 v1（baseline 锚点）
    throw new ProjectOperationError(
      "already_current",
      targetVersion < 1
        ? `第 ${chapterNo} 章只有版本 1，没有更早版本可回滚。`
        : `第 ${chapterNo} 章当前就是版本 ${currentVersion}，无需回滚。`
    );
  }
  if (!versions.some((v) => v.version === targetVersion)) {
    throw new ProjectOperationError("version_not_found", `第 ${chapterNo} 章不存在版本 ${targetVersion}。`);
  }
  const { content } = await readChapterVersion({ projectRoot, chapterNo, version: targetVersion });

  // 防覆盖保护：写回前若当前正式文件内容与最新版本不一致（用户手动改过/未入账
  // 改动），先把当前内容存档为 pre_rollback，保证覆盖后可恢复（对抗审查：回滚
  // 不得丢用户内容）。pre_rollback 失败即抛（宁可不覆盖也不丢内容）。
  const latestChecksum = versions.at(-1).checksum;
  const currentContent = await fs.readFile(finalPath, "utf8");
  if (sha256(currentContent) !== latestChecksum) {
    await snapshotChapter({ projectRoot, chapterNo, content: currentContent, source: "pre_rollback" });
  }

  await writeFileAtomic(finalPath, content);
  // 重新入账（含非散文校验、索引/checkpoint/run_log 更新）；失败不吞，写回的文件
  // 保持现状（下一次 finalize_revision 仍可修正账本）。skipVersionSnapshot 让
  // 回滚存档唯一新版本（source "rollback"），避免 finalize 重复存 revision 版。
  const finalized = await finalizeChapter(
    { projectRoot, projectId, chapterNo },
    { ...options, skipVersionSnapshot: true }
  );
  await appendEvent(projectRoot, {
    type: "chapter_rolled_back",
    project_id: project.project_id,
    chapter_no: chapterNo,
    stage: "rolled_back",
    message: `第 ${chapterNo} 章已回滚到版本 ${targetVersion}`,
    data: { path: finalPath, from_version: currentVersion, to_version: targetVersion }
  });

  // 回滚存档为新版本（append-only）。失败不抛、只并入返回的 version 字段把
  // 状态标为 failed（派生归档不得阻塞已回滚并入账的正文）。
  const versionField = { from: currentVersion, to: targetVersion };
  let snapshot = null;
  try {
    snapshot = await snapshotChapter({ projectRoot, chapterNo, content, source: "rollback" });
  } catch (snapshotError) {
    snapshot = {
      status: "failed",
      error: { code: snapshotError.code ?? "snapshot_failed", message: snapshotError.message }
    };
  }
  if (snapshot?.status === "failed") {
    versionField.snapshot = snapshot;
  }
  return { ...finalized, version: versionField };
}

function buildCheckpoint({ project, chapterNo, checkpointId, artifact }) {
  return {
    schema_version: 1,
    checkpoint_id: checkpointId,
    timestamp: new Date().toISOString(),
    task_id: null,
    task_contract: null,
    committed_model_calls: [],
    artifact_commit: artifact,
    chapter_no: chapterNo,
    stage: "completed",
    segment_no: null,
    model_config: {
      // Task 8：未配置模型 = null，不再构造 mock 兜底（调用方按未配置处理）。
      active_model: project.active_model ?? null,
      writer: project.default_writer_model ?? null,
      reviewer: project.default_reviewer_model ?? null
    },
    prompt_template_versions: project.prompt_template_versions ?? {},
    prompt_block_hashes: {},
    model_calls: [],
    usage_reports: [],
    cost_summary: null,
    cache_report: null,
    cache_key: null,
    context_package_hash: null,
    transcript: null,
    tool_calls: [],
    tool_results: [],
    state_before: null,
    state_after: null,
    quality_gate_results: [],
    error: null
  };
}

// ---------------------------------------------------------------------------
// updateMemoryFromExtraction —— 第九轮：update_memory 工具的系统侧落盘函数。
// 接收已归一化的提取数据（facts/timeline/characters），轻量门禁校验章节存在后，
// 幂等合并（mergeExtraction 去重/冲突标记）并原子更新 continuity 两文件。
// 不再写全书摘要、水位、pending（旧架构移除），不做正文指纹比对。
// ---------------------------------------------------------------------------

export async function updateMemoryFromExtraction({ projectRoot, chapterNo, extraction = null }, options = {}) {
  assertProjectRoot(projectRoot);
  assertChapterNo(chapterNo);
  if (!extraction || typeof extraction !== "object") {
    throw new ProjectOperationError("extraction_missing", "缺少记忆更新数据（extraction）。");
  }

  // 轻量门禁：引用章节必须存在（chapter_index 有记录 或 正式章节文件存在于磁盘）。
  const index = await loadChapterIndexSafe(projectRoot);
  const entry = (index.chapters ?? []).find((chapter) => Number(chapter.chapter_no) === chapterNo) ?? null;
  const chapterPath = entry?.final_path ?? entry?.draft_path ?? null;
  const fallbackPath = safeJoin(projectRoot, "chapters", `${String(chapterNo).padStart(3, "0")}.md`);
  const chapterExists = entry !== null
    || (chapterPath !== null && (await pathExists(chapterPath)))
    || (await pathExists(fallbackPath));
  if (!chapterExists) {
    throw new ProjectOperationError("chapter_not_found", `第 ${chapterNo} 章文件不存在，无法更新设定档案。`);
  }

  // ---- 计算全部目标状态（写入前完成，失败不落盘）----
  const continuity = await loadContinuity(projectRoot);
  const baseFacts = continuity.facts.length;
  const baseTimeline = continuity.timeline.length;
  const baseCharacterNames = new Set(continuity.characters.map((c) => c.name));
  const merged = mergeExtraction(continuity, extraction);

  // ---- 原子写入两文件 + 回滚（沿用既有备份/恢复机制）----
  const continuityPath = safeJoin(projectRoot, "memory", "continuity.json");
  const continuityMdPath = safeJoin(projectRoot, "memory", "continuity.md");
  const probe = createWriteProbe(options);
  const backups = [];
  for (const filePath of [continuityPath, continuityMdPath]) {
    const existed = await pathExists(filePath);
    backups.push({ path: filePath, bytes: existed ? await fs.readFile(filePath, "utf8") : null });
  }
  try {
    await probe({ path: continuityPath, kind: "continuity_json" });
    await writeJsonAtomic(continuityPath, merged);
    await probe({ path: continuityMdPath, kind: "continuity_md" });
    await writeFileAtomic(continuityMdPath, renderContinuityMarkdown(merged));
  } catch (error) {
    const rollbackWarnings = [];
    for (const backup of backups) {
      try {
        if (backup.bytes === null) {
          await fs.unlink(backup.path);
        } else {
          await writeFileAtomic(backup.path, backup.bytes);
        }
      } catch (rollbackError) {
        if (!(rollbackError.code === "ENOENT" && backup.bytes === null)) {
          rollbackWarnings.push(`恢复 ${backup.path} 失败：${rollbackError.message}`);
        }
      }
    }
    if (rollbackWarnings.length > 0) {
      error.rollbackWarnings = rollbackWarnings;
    }
    throw error;
  }

  // 确定性连续性门禁：故事时钟矛盾只报"较晚一方=本章"的冲突（旧过滤语义）。
  const { violations } = checkTimeline(merged.timeline);
  const timelineViolations = violations.filter((violation) => violation.chapter_no === chapterNo);

  return {
    ok: true,
    chapter_no: chapterNo,
    facts_added: merged.facts.length - baseFacts,
    timeline_added: merged.timeline.length - baseTimeline,
    characters_added: merged.characters.filter((c) => !baseCharacterNames.has(c.name)).length,
    timeline_violations: timelineViolations
  };
}
