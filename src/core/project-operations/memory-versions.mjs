// src/core/project-operations/memory-versions.mjs —— 第九轮：记忆文件
//（WORKLOG.md / book_summary.md）版本快照库（.versions/memory/<file>/）。
// 与章节版本库同语义：append-only、每文件最近 200 版、失败以带 code 的 Error 抛出
//（调用方在派生归档阶段 catch，不阻塞主事务）。
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { ensureDir, pathExists, readJson, safeJoin, writeFileAtomic, writeJsonAtomic } from "../fs-utils.mjs";

export const MEMORY_VERSION_CAP = 200;

const MEMORY_FILES = new Set(["worklog", "book_summary"]);

function domainError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertMemoryFile(file) {
  if (!MEMORY_FILES.has(file)) throw domainError("bad_args", `未知记忆文件类型：${file}`);
}

/** 与 fs-utils.sha256 同源，但返回裸 hex（无前缀），供 manifest checksum 字段使用。 */
function bareSha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function versionDir(projectRoot, file) {
  return safeJoin(projectRoot, ".versions", "memory", file);
}

function manifestPath(projectRoot, file) {
  return safeJoin(versionDir(projectRoot, file), "manifest.json");
}

async function loadManifest(projectRoot, file) {
  const manifest = await readJson(manifestPath(projectRoot, file), null);
  if (!manifest || !Array.isArray(manifest.versions)) {
    throw domainError("no_versions", `记忆文件 ${file} 没有任何历史版本。`);
  }
  return manifest;
}

export async function listMemoryVersions({ projectRoot, file }) {
  assertMemoryFile(file);
  const manifest = await loadManifest(projectRoot, file);
  return { file, versions: manifest.versions };
}

export async function snapshotMemoryFile({ projectRoot, file, content, source }) {
  assertMemoryFile(file);
  const dir = versionDir(projectRoot, file);
  await ensureDir(dir);
  let versions = [];
  try {
    versions = (await loadManifest(projectRoot, file)).versions;
  } catch (error) {
    if (error.code !== "no_versions") throw error;
  }
  const nextVersion = (versions.at(-1)?.version ?? 0) + 1;
  const entry = { version: nextVersion, timestamp: new Date().toISOString(), source, checksum: bareSha256(content) };
  versions = [...versions, entry];
  // 200 上限：删最老版本文件并裁剪 manifest。
  while (versions.length > MEMORY_VERSION_CAP) {
    const dropped = versions.shift();
    await fs.unlink(safeJoin(dir, `v${dropped.version}.md`)).catch(() => {});
  }
  await writeFileAtomic(safeJoin(dir, `v${nextVersion}.md`), content);
  await writeJsonAtomic(manifestPath(projectRoot, file), { file, versions });
  return { version: nextVersion };
}

export async function readMemoryVersion({ projectRoot, file, version }) {
  assertMemoryFile(file);
  const manifest = await loadManifest(projectRoot, file);
  const entry = manifest.versions.find((v) => v.version === Number(version));
  if (!entry) throw domainError("version_not_found", `记忆文件 ${file} 不存在版本 ${version}。`);
  const content = await fs.readFile(safeJoin(versionDir(projectRoot, file), `v${entry.version}.md`), "utf8");
  return { file, version: entry.version, content, checksum: entry.checksum };
}
