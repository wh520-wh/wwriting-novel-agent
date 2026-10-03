// 提交中断幂等补齐回归（2026-10-03 补强）：
// commitChapter 写序为「正式文件 → 章节索引 → checkpoint → chapter_completed 审计」，
// 进程在写完索引、写 checkpoint 前硬退出后，重试必须补齐缺失证据（checkpoint 与
// 提交审计），而不是只凭 completed 索引返回 duplicate 成功。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createProjectRoot } from "../helpers/project-agent-harness.mjs";
import { appendChapterSegment, commitChapter } from "../../src/core/project-operations/chapter.mjs";
import { loadChapterIndex } from "../../src/core/project-store.mjs";
import { readEvents } from "../../src/core/event-log.mjs";
import { detectLedgerDrift } from "../../src/core/ledger-drift.mjs";

// 子进程模式：在 checkpoint 写边界硬退出（模拟进程被杀在索引已写、checkpoint 未写之间）。
if (process.argv[2] === "crash-child") {
  await commitChapter({ projectRoot: process.argv[3], projectId: process.argv[4], chapterNo: 1 }, {
    hooks: { beforeWrite({ kind }) { if (kind === "checkpoint") process.exit(23); } }
  });
  process.exit(0);
}

test("提交中断（checkpoint 边界退出）后重试补齐 checkpoint 与审计事件", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-commit-crash-"));
  const { projectRoot, project } = await createProjectRoot(workspace, { slug: "novel" });
  await appendChapterSegment({
    projectRoot,
    projectId: project.project_id,
    chapterNo: 1,
    segmentNo: 1,
    content: "# 第一章 雨夜来信\n\n雨夜里他推开老宅的门，桌上只有一封未署名的信。"
  });
  const child = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), "crash-child", projectRoot, project.project_id],
    { encoding: "utf8" }
  );
  assert.equal(child.status, 23, `子进程应在 checkpoint 边界退出：${child.stderr}`);

  // 中断状态：正文与 completed 索引保留；checkpoint 与审计缺失。
  const index = await loadChapterIndex(projectRoot);
  assert.equal(index.chapters[0].status, "completed");
  assert.equal((await fs.readdir(path.join(projectRoot, "checkpoints"))).length, 0);

  const retried = await commitChapter({ projectRoot, projectId: project.project_id, chapterNo: 1 });
  assert.equal(retried.duplicate, true);
  assert.equal(retried.repairing, true);
  assert.deepEqual([...retried.repaired].sort(), ["audit", "checkpoint"]);
  assert.equal((await fs.readdir(path.join(projectRoot, "checkpoints"))).length, 1, "checkpoint 幂等补齐");
  const audit = (await readEvents(projectRoot)).filter((e) => e.type === "chapter_completed");
  assert.equal(audit.length, 1, "提交审计事件补记");
  assert.equal(audit[0].data.recovered, true);
  assert.equal(audit[0].data.checkpoint_id, retried.checkpoint_id);
  assert.deepEqual(await detectLedgerDrift({ projectRoot }), []);

  // 再次重试：证据已齐，纯 duplicate、零补齐。
  const again = await commitChapter({ projectRoot, projectId: project.project_id, chapterNo: 1 });
  assert.equal(again.duplicate, true);
  assert.equal(again.repairing, false);
  assert.deepEqual(again.repaired, []);
});
