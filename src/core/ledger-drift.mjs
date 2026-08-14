// src/core/ledger-drift.mjs —— 账本一致性检测（第八轮模块 C，设计 D1）：
// "正式文件与索引不一致"是可检测、可修复的中间态。每轮 prompt 装配前检测，
// 发现漂移时提示模型对相应章节调用 finalize_revision 入账。
import fs from "node:fs/promises";
import { pathExists, safeJoin, sha256 } from "./fs-utils.mjs";
import { loadChapterIndex } from "./project-store.mjs";

export async function detectLedgerDrift({ projectRoot }) {
  const index = await loadChapterIndex(projectRoot);
  const drifts = [];
  for (const chapter of index.chapters ?? []) {
    if (chapter.status !== "completed" || !chapter.final_path) continue;
    const chapterNo = Number(chapter.chapter_no);
    const finalPath = safeJoin(projectRoot, chapter.final_path);
    if (!(await pathExists(finalPath))) {
      drifts.push({ chapter_no: chapterNo, issue: "file_missing" });
      continue;
    }
    const content = await fs.readFile(finalPath, "utf8");
    const fileChecksum = sha256(content);
    if (chapter.checksum !== fileChecksum) {
      drifts.push({
        chapter_no: chapterNo,
        issue: "checksum_mismatch",
        file_checksum: fileChecksum,
        index_checksum: chapter.checksum ?? null
      });
    }
  }
  return drifts;
}

export function buildLedgerDriftNote(drifts) {
  if (!Array.isArray(drifts) || drifts.length === 0) return "";
  const chapters = drifts.map((d) => `第 ${d.chapter_no} 章`).join("、");
  return `[Ledger Drift] 检测到章节正式文件与账本不一致（文件被直接编辑但未入账）：${chapters}。请对每一章调用 finalize_revision 入账后再继续。`;
}
