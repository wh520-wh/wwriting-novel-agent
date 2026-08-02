import fs from "node:fs/promises";
import path from "node:path";
import { appendEvent } from "./event-log.mjs";
import { countEffectiveWords } from "./word-count.mjs";
import { throwIfAborted } from "./cancellation.mjs";
import { ensureDir, pathExists, safeJoin, sha256, writeFileAtomic } from "./fs-utils.mjs";
import { upsertChapter } from "./project-store.mjs";

export class ToolValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ToolValidationError";
    this.code = code;
  }
}

export function chapterFileName(chapterNo, extension = "md") {
  return `${String(chapterNo).padStart(3, "0")}.${extension}`;
}

// 非正文内容启发式检测：防止模型把工具调用报错、内心独白、prompt 字段名写入章节。
// 检测对象是应当为小说正文的 content；误伤率应极低（snake_case 工具名与中文小说正文不重叠）。
const KNOWN_TOOL_NAMES = [
  "append_chapter_segment",
  "read_chapter",
  "read_continuity",
  "read_outline",
  "get_status",
  "edit_chapter",
  "update_continuity",
  "update_outline",
  "list_chapters"
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
  for (const tool of KNOWN_TOOL_NAMES) {
    if (text.includes(tool)) {
      return { isNonProse: true, reason: `包含写作工具名 "${tool}"` };
    }
  }
  for (const { pattern, reason } of NON_PROSE_PATTERNS) {
    if (pattern.test(text)) {
      return { isNonProse: true, reason };
    }
  }
  return { isNonProse: false, reason: null };
}

export function validateAppendChapterSegmentInput(project, input, options = {}) {
  if (!input || typeof input !== "object") {
    throw new ToolValidationError("missing_tool_input", "Tool input is required.");
  }
  if (options.requireProjectId && input.project_id !== project.project_id) {
    throw new ToolValidationError("invalid_project_id", "project_id does not match the active project.");
  }
  if (input.project_id !== undefined && input.project_id !== project.project_id) {
    throw new ToolValidationError("invalid_project_id", "project_id does not match the active project.");
  }
  if (!Number.isInteger(input.chapter_no) || input.chapter_no < 1) {
    throw new ToolValidationError("invalid_chapter_no", "chapter_no must be a positive integer.");
  }
  if (options.expectedChapterNo !== undefined && input.chapter_no !== options.expectedChapterNo) {
    throw new ToolValidationError("invalid_chapter_no", "chapter_no does not match the active chapter.");
  }
  if (!Number.isInteger(input.segment_no) || input.segment_no < 1) {
    throw new ToolValidationError("invalid_segment_no", "segment_no must be a positive integer.");
  }
  if (options.expectedSegmentNo !== undefined && input.segment_no !== options.expectedSegmentNo) {
    throw new ToolValidationError("invalid_segment_no", "segment_no does not match the expected next segment.");
  }
  if (typeof input.content !== "string" || input.content.trim().length === 0) {
    throw new ToolValidationError("empty_content", "content must be a non-empty string.");
  }
  const maxContentChars = options.maxContentChars ?? 200_000;
  if (input.content.length > maxContentChars) {
    throw new ToolValidationError("content_too_large", `content exceeds ${maxContentChars} characters.`);
  }
}

export async function appendChapterSegment(projectRoot, project, input, options = {}) {
  validateAppendChapterSegmentInput(project, input, options);
  const nonProseCheck = detectNonProseContent(input.content);
  if (nonProseCheck.isNonProse) {
    throw new ToolValidationError("non_prose_content", `检测到非正文内容：${nonProseCheck.reason}。请只输出小说正文。`);
  }
  const chapterNo = input.chapter_no;
  const segmentNo = input.segment_no;
  const draftPath = safeJoin(projectRoot, "drafts", chapterFileName(chapterNo, `draft.${project.output_format}`));
  await ensureDir(path.dirname(draftPath));
  const current = (await pathExists(draftPath)) ? await fs.readFile(draftPath, "utf8") : `# Chapter ${String(chapterNo).padStart(3, "0")}\n`;
  // 把 draft_path 落进章节索引：写作 agent 循环里 edit_chapter/read_chapter/search_text
  // 都靠索引里的 final_path ?? draft_path 解析文件，否则草稿阶段会误报 chapter_not_found。
  await upsertChapter(projectRoot, { chapter_no: chapterNo, draft_path: draftPath });
  const marker = `<!-- segment:${segmentNo} `;
  if (current.includes(marker)) {
    const actualWords = countEffectiveWords(current);
    return {
      ok: true,
      duplicate: true,
      path: draftPath,
      actual_words: actualWords,
      bytes_written: 0,
      checksum: sha256(current)
    };
  }
  const block = `\n\n<!-- segment:${segmentNo} checksum:${sha256(input.content)} -->\n${String(input.content).trim()}\n`;
  const next = current + block;
  const written = await writeFileAtomic(draftPath, next);
  const actualWords = countEffectiveWords(next);
  await appendEvent(projectRoot, {
    type: "tool_call_completed",
    project_id: project.project_id,
    chapter_no: chapterNo,
    stage: "drafting",
    message: `segment ${segmentNo} written to draft`,
    data: { tool: "append_chapter_segment", path: draftPath, actual_words: actualWords }
  });
  return {
    ok: true,
    duplicate: false,
    path: draftPath,
    bytes_written: written.bytes_written,
    actual_words: actualWords,
    checksum: written.checksum
  };
}

export async function finalizeChapterFile(projectRoot, project, chapterNo, { signal } = {}) {
  throwIfAborted(signal);
  const draftPath = safeJoin(projectRoot, "drafts", chapterFileName(chapterNo, `draft.${project.output_format}`));
  const finalPath = safeJoin(projectRoot, "chapters", chapterFileName(chapterNo, project.output_format));
  if (await pathExists(finalPath)) {
    const existing = await fs.readFile(finalPath, "utf8");
    return {
      ok: true,
      duplicate: true,
      path: finalPath,
      draft_path: draftPath,
      bytes_written: 0,
      actual_words: countEffectiveWords(existing),
      checksum: sha256(existing)
    };
  }
  const content = await fs.readFile(draftPath, "utf8");
  throwIfAborted(signal);
  const actualWords = countEffectiveWords(content);
  const written = await writeFileAtomic(finalPath, content);
  await appendEvent(projectRoot, {
    type: "tool_call_completed",
    project_id: project.project_id,
    chapter_no: chapterNo,
    stage: "finalizing",
    message: "chapter finalized",
    data: { tool: "finalize_chapter_file", path: finalPath, actual_words: actualWords }
  });
  return {
    ok: true,
    duplicate: false,
    path: finalPath,
    draft_path: draftPath,
    bytes_written: written.bytes_written,
    actual_words: actualWords,
    checksum: written.checksum
  };
}

export async function readDraft(projectRoot, project, chapterNo) {
  const draftPath = safeJoin(projectRoot, "drafts", chapterFileName(chapterNo, `draft.${project.output_format}`));
  if (!(await pathExists(draftPath))) {
    return "";
  }
  return fs.readFile(draftPath, "utf8");
}
