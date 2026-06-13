import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { inspectChapterArtifact } from "../src/core/chapter-artifact.mjs";
import { sha256 } from "../src/core/fs-utils.mjs";

async function makeProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), "wwriting-artifact-"));
  await mkdir(path.join(root, "chapters"), { recursive: true });
  return root;
}

test("missing final file overrides a completed index entry", async () => {
  const root = await makeProject();
  const artifact = await inspectChapterArtifact({
    projectRoot: root,
    chapter: 1,
    indexEntry: {
      status: "completed",
      final_path: "chapters/001.md",
      checksum: "stale",
      actual_words: 1200,
    },
  });

  assert.equal(artifact.state, "invalid");
  assert.equal(artifact.reason, "missing_file");
});

test("existing file returns verified metadata and content checksum", async () => {
  const root = await makeProject();
  const relative = "chapters/001.md";
  const content = "# 第一章\n\n正文";
  await writeFile(path.join(root, relative), content, "utf8");
  const checksum = sha256(content);

  const artifact = await inspectChapterArtifact({
    projectRoot: root,
    chapter: 1,
    indexEntry: {
      status: "completed",
      final_path: relative,
      checksum,
      actual_words: 2,
    },
  });

  assert.equal(artifact.state, "committed");
  assert.equal(artifact.relative_path, relative);
  assert.equal(artifact.checksum, checksum);
  assert.equal(await readFile(artifact.absolute_path, "utf8"), "# 第一章\n\n正文");
});

test("readable draft without completed index is draft_only", async () => {
  const root = await makeProject();
  await mkdir(path.join(root, "drafts"), { recursive: true });
  await writeFile(path.join(root, "drafts", "001.draft.md"), "草稿", "utf8");

  const artifact = await inspectChapterArtifact({
    projectRoot: root,
    chapter: 1,
    indexEntry: {
      status: "reviewing",
      draft_path: "drafts/001.draft.md",
    },
  });

  assert.equal(artifact.state, "draft_only");
  assert.equal(artifact.reason, null);
});

test("finalizing index is committing even before final file exists", async () => {
  const root = await makeProject();
  const artifact = await inspectChapterArtifact({
    projectRoot: root,
    chapter: 1,
    indexEntry: { status: "finalizing" },
  });

  assert.equal(artifact.state, "committing");
});

test("completed index without checksum is invalid", async () => {
  const root = await makeProject();
  await writeFile(path.join(root, "chapters", "001.md"), "正文", "utf8");

  const artifact = await inspectChapterArtifact({
    projectRoot: root,
    chapter: 1,
    indexEntry: {
      status: "completed",
      final_path: "chapters/001.md",
      checksum: null,
    },
  });

  assert.equal(artifact.state, "invalid");
  assert.equal(artifact.reason, "missing_checksum");
});

test("file metadata change invalidates the checksum cache", async () => {
  const root = await makeProject();
  const finalPath = path.join(root, "chapters", "001.md");
  await writeFile(finalPath, "初始正文", "utf8");
  const checksum = sha256("初始正文");
  const indexEntry = {
    status: "completed",
    final_path: "chapters/001.md",
    checksum,
  };

  assert.equal(
    (await inspectChapterArtifact({
      projectRoot: root,
      chapter: 1,
      indexEntry,
    })).state,
    "committed"
  );

  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(finalPath, "已经被修改的正文", "utf8");
  const changed = await inspectChapterArtifact({
    projectRoot: root,
    chapter: 1,
    indexEntry,
  });

  assert.equal(changed.state, "invalid");
  assert.equal(changed.reason, "checksum_mismatch");
});
