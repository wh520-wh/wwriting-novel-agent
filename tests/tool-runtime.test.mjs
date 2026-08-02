import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProject } from "../src/core/project-store.mjs";
import { assertToolCallForChapter } from "../src/core/quality-gates.mjs";
import { appendChapterSegment, finalizeChapterFile, ToolValidationError } from "../src/core/tool-runtime.mjs";
import { safeJoin } from "../src/core/fs-utils.mjs";

test("appendChapterSegment writes once per segment number", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-tool-"));
  const { projectRoot, project } = await createProject(root, {
    slug: "project",
    min_words_per_chapter: 20
  });
  const first = await appendChapterSegment(projectRoot, project, {
    chapter_no: 1,
    segment_no: 1,
    content: "雨夜里他收到信，线索在掌心发烫。"
  });
  const second = await appendChapterSegment(projectRoot, project, {
    chapter_no: 1,
    segment_no: 1,
    content: "这段不应该重复写入。"
  });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  const file = await fs.readFile(first.path, "utf8");
  assert.equal((file.match(/segment:1/gu) ?? []).length, 1);
});

test("safeJoin rejects paths outside the project root", () => {
  assert.throws(() => safeJoin("D:\\WWriting\\Project", "..", "outside.md"), /escapes project root/u);
});

test("appendChapterSegment rejects invalid direct tool input", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-tool-guard-"));
  const { projectRoot, project } = await createProject(root, {
    slug: "project"
  });
  await assert.rejects(
    () =>
      appendChapterSegment(
        projectRoot,
        project,
        {
          project_id: "wrong-project",
          chapter_no: 1,
          segment_no: 1,
          content: "valid content"
        },
        { requireProjectId: true, expectedChapterNo: 1, expectedSegmentNo: 1 }
      ),
    (error) => error instanceof ToolValidationError && error.code === "invalid_project_id"
  );
  await assert.rejects(
    () =>
      appendChapterSegment(
        projectRoot,
        project,
        {
          project_id: project.project_id,
          chapter_no: 1,
          segment_no: 1,
          content: "   "
        },
        { requireProjectId: true, expectedChapterNo: 1, expectedSegmentNo: 1 }
      ),
    (error) => error instanceof ToolValidationError && error.code === "empty_content"
  );
  await assert.rejects(
    () =>
      appendChapterSegment(
        projectRoot,
        project,
        {
          project_id: project.project_id,
          chapter_no: 1,
          segment_no: 3,
          content: "valid content"
        },
        { requireProjectId: true, expectedChapterNo: 1, expectedSegmentNo: 2 }
      ),
    (error) => error instanceof ToolValidationError && error.code === "invalid_segment_no"
  );
});

test("chapter tool-call gate rejects mismatched scoped arguments", () => {
  const base = {
    type: "tool_call",
    tool: "append_chapter_segment",
    input: {
      project_id: "project-1",
      chapter_no: 1,
      segment_no: 2,
      content: "real chapter content"
    }
  };
  assert.equal(assertToolCallForChapter(base, { project_id: "project-1", chapter_no: 1, segment_no: 2 }).ok, true);
  assert.equal(assertToolCallForChapter({ ...base, input: { ...base.input, project_id: "project-2" } }, { project_id: "project-1" }).code, "invalid_project_id");
  assert.equal(assertToolCallForChapter({ ...base, input: { ...base.input, chapter_no: 2 } }, { chapter_no: 1 }).code, "invalid_chapter_no");
  assert.equal(assertToolCallForChapter({ ...base, input: { ...base.input, segment_no: 3 } }, { segment_no: 2 }).code, "invalid_segment_no");
  assert.equal(assertToolCallForChapter({ ...base, input: { ...base.input, content: "" } }, { segment_no: 2 }).code, "empty_content");
});

test("appendChapterSegment rejects content that looks like model reasoning or tool errors", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-tool-nonprose-"));
  const { projectRoot, project } = await createProject(root, {
    slug: "project",
    min_words_per_chapter: 10
  });
  const pollutedContent = `The read_chapter tool is not allowed right now. It seems the only allowed tool for this step is append_chapter_segment. Wait, the task says allowed_tools includes get_status, list_chapters, read_chapter, read_continuity, read_outline, edit_chapter, append_chapter_segment. But the actual response says "当前只允许调用：append_chapter_segment。请直接提交正文。" Hmm, interesting. So I should just submit the prose directly via append_chapter_segment. OK. Let me now write segment 2, continuing from the selected fragment. I need to write ~1100 words (segment_target_words: 1100).`;
  await assert.rejects(
    () =>
      appendChapterSegment(
        projectRoot,
        project,
        {
          project_id: project.project_id,
          chapter_no: 1,
          segment_no: 1,
          content: pollutedContent
        },
        { requireProjectId: true, expectedChapterNo: 1, expectedSegmentNo: 1 }
      ),
    (error) => error instanceof ToolValidationError && error.code === "non_prose_content"
  );
  // 确认文件未被创建
  await assert.rejects(
    () => fs.stat(path.join(projectRoot, "drafts", "001.draft.md")),
    (error) => error.code === "ENOENT"
  );
});

test("finalizeChapterFile respects a pre-aborted signal", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-final-abort-"));
  const { projectRoot, project } = await createProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 10,
    target_words_per_chapter: 12
  });
  await appendChapterSegment(projectRoot, project, {
    chapter_no: 1,
    segment_no: 1,
    content: "# 第一章\n\n雨声压住脚步，沈泽拆开了旧信。"
  });
  const controller = new AbortController();
  controller.abort("用户停止");
  await assert.rejects(
    () => finalizeChapterFile(projectRoot, project, 1, { signal: controller.signal }),
    (error) => error.name === "ProjectCancelledError"
  );
  await assert.rejects(
    () => fs.stat(path.join(projectRoot, "chapters", "001.md")),
    (error) => error.code === "ENOENT"
  );
});
