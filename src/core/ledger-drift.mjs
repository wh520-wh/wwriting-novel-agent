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
    if (!Number.isInteger(chapterNo) || chapterNo < 1) continue;
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
  // 检测失败的哨兵条目：不渲染章节列表，改为明确告知"本次没检测成"，
  // 防止模型把"没有漂移报告"误读成"确认一致"。
  const unavailable = drifts.some((d) => d?.issue === "drift_check_unavailable");
  const real = drifts.filter((d) => d?.issue !== "drift_check_unavailable");
  const parts = [];
  if (real.length > 0) {
    const chapters = real.map((d) => `第 ${d.chapter_no} 章`).join("、");
    parts.push(`[Ledger Drift] 检测到章节正式文件与账本不一致（文件被直接编辑但未入账）：${chapters}。请对每一章调用 finalize_revision 入账后再继续。`);
  }
  if (unavailable) {
    parts.push("[Ledger Drift] 本次账本一致性检测不可用（索引损坏或读取失败），无法确认正式文件与账本是否一致；不要默认一致，必要时读取章节文件自行核对。");
  }
  return parts.join("\n");
}
