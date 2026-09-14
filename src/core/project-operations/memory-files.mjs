// src/core/project-operations/memory-files.mjs —— 第九轮：AI 自由文本记忆文件
//（book_summary.md / WORKLOG.md）落在项目根；老项目 memory/book_summary.md 迁移。
// 幂等；所有分支以 pathExists 先行判断，重复调用安全。
import fs from "node:fs/promises";
import { pathExists, safeJoin, writeFileAtomic } from "../fs-utils.mjs";

export const WORKLOG_PLACEHOLDER = "# WORKLOG\n";

export async function ensureWorklog(projectRoot) {
  const target = safeJoin(projectRoot, "WORKLOG.md");
  if (await pathExists(target)) return { path: target, created: false };
  await writeFileAtomic(target, WORKLOG_PLACEHOLDER);
  return { path: target, created: true };
}

export async function migrateBookSummaryToRoot(projectRoot) {
  const rootPath = safeJoin(projectRoot, "book_summary.md");
  const legacyPath = safeJoin(projectRoot, "memory", "book_summary.md");
  const rootExists = await pathExists(rootPath);
  const legacyExists = await pathExists(legacyPath);
  if (!legacyExists) return { rootPath, migrated: false, action: "none" };
  if (!rootExists) {
    const content = await fs.readFile(legacyPath, "utf8");
    await writeFileAtomic(rootPath, content);
    await fs.unlink(legacyPath);
    return { rootPath, migrated: true, action: "moved" };
  }
  // 根目录版优先：旧版改名留底（改名目标已存在 = 上次迁移完成，幂等跳过）。
  const backupPath = `${legacyPath}.bak`;
  try {
    await fs.rename(legacyPath, backupPath);
  } catch (error) {
    if (error.code !== "ENOENT" && !(await pathExists(backupPath))) throw error;
  }
  return { rootPath, migrated: true, action: "backed_up" };
}

// 老项目打开时一次补齐（幂等；调用方 try/catch，失败不阻断项目打开）。
export async function ensureMemoryFilesForProject(projectRoot) {
  const summary = await migrateBookSummaryToRoot(projectRoot);
  const worklog = await ensureWorklog(projectRoot);
  return { summary, worklog };
}
