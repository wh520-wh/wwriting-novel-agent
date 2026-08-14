// 第九轮：AI 自由文本记忆文件迁移（book_summary 搬家 + WORKLOG 占位）。
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  ensureWorklog,
  migrateBookSummaryToRoot,
  ensureMemoryFilesForProject,
  WORKLOG_PLACEHOLDER
} from "../../src/core/project-operations/memory-files.mjs";

async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-memfiles-"));
  await fs.mkdir(path.join(root, "memory"), { recursive: true });
  return root;
}

test("搬家：只有 memory/ 旧版时移动到根目录并删除旧文件", async () => {
  const root = await makeRoot();
  await fs.writeFile(path.join(root, "memory", "book_summary.md"), "# 全书摘要\n\n旧内容", "utf8");
  const result = await migrateBookSummaryToRoot(root);
  assert.deepEqual(result, { rootPath: path.join(root, "book_summary.md"), migrated: true, action: "moved" });
  assert.equal(await fs.readFile(path.join(root, "book_summary.md"), "utf8"), "# 全书摘要\n\n旧内容");
  await assert.rejects(fs.stat(path.join(root, "memory", "book_summary.md")), /ENOENT/);
});

test("撞车：根目录已有新版时旧版改名 .bak 留底，根目录内容不动", async () => {
  const root = await makeRoot();
  await fs.writeFile(path.join(root, "book_summary.md"), "根目录新版", "utf8");
  await fs.writeFile(path.join(root, "memory", "book_summary.md"), "旧版", "utf8");
  const result = await migrateBookSummaryToRoot(root);
  assert.equal(result.action, "backed_up");
  assert.equal(await fs.readFile(path.join(root, "book_summary.md"), "utf8"), "根目录新版");
  assert.equal(await fs.readFile(path.join(root, "memory", "book_summary.md.bak"), "utf8"), "旧版");
});

test("幂等：两边都没有 → no-op；重复调用不报错", async () => {
  const root = await makeRoot();
  const first = await migrateBookSummaryToRoot(root);
  assert.deepEqual(first, { rootPath: path.join(root, "book_summary.md"), migrated: false, action: "none" });
  await fs.writeFile(path.join(root, "memory", "book_summary.md"), "x", "utf8");
  await migrateBookSummaryToRoot(root);
  await assert.doesNotReject(migrateBookSummaryToRoot(root)); // 重复调用幂等
});

test("WORKLOG：缺失时建占位、存在时不动", async () => {
  const root = await makeRoot();
  const created = await ensureWorklog(root);
  assert.equal(created.created, true);
  assert.equal(await fs.readFile(path.join(root, "WORKLOG.md"), "utf8"), WORKLOG_PLACEHOLDER);
  await fs.writeFile(path.join(root, "WORKLOG.md"), "已有内容", "utf8");
  const kept = await ensureWorklog(root);
  assert.equal(kept.created, false);
  assert.equal(await fs.readFile(path.join(root, "WORKLOG.md"), "utf8"), "已有内容");
});

test("组合入口：一次补齐两文件", async () => {
  const root = await makeRoot();
  await fs.writeFile(path.join(root, "memory", "book_summary.md"), "旧", "utf8");
  const result = await ensureMemoryFilesForProject(root);
  assert.equal(result.summary.action, "moved");
  assert.equal(result.worklog.created, true);
});
