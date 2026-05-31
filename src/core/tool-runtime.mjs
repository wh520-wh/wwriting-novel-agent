import fs from "node:fs/promises";
import path from "node:path";
import { appendEvent } from "./event-log.mjs";
import { countEffectiveWords } from "./word-count.mjs";
import { ensureDir, pathExists, safeJoin, sha256, writeFileAtomic } from "./fs-utils.mjs";

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
  const chapterNo = input.chapter_no;
  const segmentNo = input.segment_no;
  const draftPath = safeJoin(projectRoot, "drafts", chapterFileName(chapterNo, `draft.${project.output_format}`));
  await ensureDir(path.dirname(draftPath));
  const current = (await pathExists(draftPath)) ? await fs.readFile(draftPath, "utf8") : `# Chapter ${String(chapterNo).padStart(3, "0")}\n`;
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

export async function finalizeChapterFile(projectRoot, project, chapterNo) {
  const draftPath = safeJoin(projectRoot, "drafts", chapterFileName(chapterNo, `draft.${project.output_format}`));
  const finalPath = safeJoin(projectRoot, "chapters", chapterFileName(chapterNo, project.output_format));
  const content = await fs.readFile(draftPath, "utf8");
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
