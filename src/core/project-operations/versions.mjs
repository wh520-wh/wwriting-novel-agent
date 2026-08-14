// src/core/project-operations/versions.mjs —— 章节版本快照库（第八轮模块 C）。
// append-only：每次「生效版本变化」（commit/finalize/rollback）把当前正式文件内容
// 存档为 .versions/chapters/{NNN}/v{n}.md + manifest.json；完整保留，不裁剪。
// 本模块不抛 ProjectOperationError（避免与 chapter.mjs 循环依赖）；领域错误用
// 带 code 属性的 Error，由调用方（chapter.mjs）转译为 ProjectOperationError。
import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, pathExists, readJson, safeJoin, sha256, writeFileAtomic, writeJsonAtomic } from "../fs-utils.mjs";

const VERSIONS_REL = path.join(".versions", "chapters");

function chapterVersionsDir(projectRoot, chapterNo) {
  return safeJoin(projectRoot, VERSIONS_REL, String(chapterNo).padStart(3, "0"));
}

function domainError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export async function listChapterVersions({ projectRoot, chapterNo }) {
  const manifestPath = path.join(chapterVersionsDir(projectRoot, chapterNo), "manifest.json");
  if (!(await pathExists(manifestPath))) return [];
  const manifest = await readJson(manifestPath);
  return Array.isArray(manifest.versions) ? manifest.versions : [];
}

export async function snapshotChapter({ projectRoot, chapterNo, content, source }) {
  const dir = chapterVersionsDir(projectRoot, chapterNo);
  await ensureDir(dir);
  const versions = await listChapterVersions({ projectRoot, chapterNo });
  const nextVersion = (versions.at(-1)?.version ?? 0) + 1;
  const checksum = sha256(content);
  await writeFileAtomic(path.join(dir, `v${nextVersion}.md`), content);
  const manifest = { chapter_no: chapterNo, versions: [...versions, { version: nextVersion, timestamp: new Date().toISOString(), source, checksum }] };
  await writeJsonAtomic(path.join(dir, "manifest.json"), manifest);
  return { version: nextVersion };
}

export async function readChapterVersion({ projectRoot, chapterNo, version }) {
  const versions = await listChapterVersions({ projectRoot, chapterNo });
  const meta = versions.find((v) => v.version === version);
  if (!meta) throw domainError("version_not_found", `第 ${chapterNo} 章不存在版本 ${version}。`);
  const filePath = path.join(chapterVersionsDir(projectRoot, chapterNo), `v${version}.md`);
  return { version, content: await fs.readFile(filePath, "utf8"), checksum: meta.checksum };
}

// 设计 D3 迁移最小单元：该章无任何版本时把当前内容存为 v1（baseline），幂等。
export async function ensureBaselineVersion({ projectRoot, chapterNo, content }) {
  const versions = await listChapterVersions({ projectRoot, chapterNo });
  if (versions.length > 0) {
    return { version: null, existed: true };
  }
  const { version } = await snapshotChapter({ projectRoot, chapterNo, content, source: "baseline" });
  return { version, existed: false };
}

// 设计 D3 全量迁移：对索引 completed 且正式文件存在的章节逐个种 baseline。
// 只写 .versions/，绝不触碰正文/索引/校验和；幂等（存在 v1 即跳过）。
export async function migrateBaselineVersions({ projectRoot, chapters }) {
  const results = [];
  for (const chapter of chapters ?? []) {
    if (chapter.status !== "completed") continue;
    const finalPath = chapter.final_path ? safeJoin(projectRoot, chapter.final_path) : null;
    if (!finalPath || !(await pathExists(finalPath))) continue;
    const chapterNo = Number(chapter.chapter_no);
    if (!Number.isInteger(chapterNo) || chapterNo < 1) continue;
    const content = await fs.readFile(finalPath, "utf8");
    const { existed } = await ensureBaselineVersion({ projectRoot, chapterNo, content });
    results.push({ chapter_no: chapterNo, baseline: existed ? "existing" : "created" });
  }
  return results;
}
