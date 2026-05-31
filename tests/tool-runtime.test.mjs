import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProject } from "../src/core/project-store.mjs";
import { assertToolCallForChapter } from "../src/core/quality-gates.mjs";
import { appendChapterSegment, ToolValidationError } from "../src/core/tool-runtime.mjs";
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
