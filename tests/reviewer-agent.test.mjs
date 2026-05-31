import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runProject } from "../src/core/agent-engine.mjs";
import { createProject } from "../src/core/project-store.mjs";
import { runReviewerAgent } from "../src/core/reviewer-agent.mjs";

test("Reviewer Agent passes a locally verified completed project", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-review-pass-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 2,
    min_words_per_chapter: 220,
    target_words_per_chapter: 260
  });
  await runProject(projectRoot);

  const report = await runReviewerAgent(projectRoot, { writeReport: true });
  assert.equal(report.status, "passed");
  assert.equal(report.summary.findings, 0);
  assert.ok(report.report_path.endsWith(path.join("review", "reviewer_report.json")));
  const written = JSON.parse(await fs.readFile(report.report_path, "utf8"));
  assert.equal(written.status, "passed");
});

test("Reviewer Agent detects tampered completed chapter files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-review-tamper-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 220,
    target_words_per_chapter: 260
  });
  await runProject(projectRoot);
  await fs.writeFile(path.join(projectRoot, "chapters", "001.md"), "# Chapter 001\n\n短。", "utf8");

  const report = await runReviewerAgent(projectRoot);
  assert.equal(report.status, "failed");
  assert.ok(report.findings.some((finding) => finding.code === "completed_chapter_below_min_words"));
  assert.ok(report.findings.some((finding) => finding.code === "chapter_checksum_mismatch"));
});
