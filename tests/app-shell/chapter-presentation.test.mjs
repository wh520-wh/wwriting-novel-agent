import assert from "node:assert/strict";
import test from "node:test";

import { presentChapterArtifact } from "../../src/app-shell/chapter-presentation.mjs";

test("committed artifact is presented as a readable local file", () => {
  const view = presentChapterArtifact({
    chapter: 3,
    artifact: {
      state: "committed",
      relativePath: "chapters/003.md",
      bytes: 1024,
    },
  });

  assert.equal(view.tone, "success");
  assert.equal(view.canOpen, true);
  assert.equal(view.title, "第 3 章已写入本地文件");
});

test("draft-only cancelled artifact tells the user that the draft remains", () => {
  const view = presentChapterArtifact({
    chapter: 3,
    projectStatus: "cancelled",
    artifact: { state: "draft_only" },
  });

  assert.equal(view.tone, "warning");
  assert.equal(view.canOpen, false);
  assert.equal(view.title, "已停止，第 3 章草稿已保留");
});

test("invalid artifact never claims that a local final file exists", () => {
  const view = presentChapterArtifact({
    chapter: 3,
    artifact: { state: "invalid", reason: "checksum_mismatch" },
  });

  assert.equal(view.tone, "warning");
  assert.equal(view.canOpen, false);
  assert.equal(view.title, "第 3 章产物状态异常，可尝试恢复");
});