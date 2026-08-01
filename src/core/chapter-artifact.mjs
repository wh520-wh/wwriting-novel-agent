import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { isPathInside, sha256 } from "./fs-utils.mjs";

const artifactCache = new Map();

export async function inspectChapterArtifact({ projectRoot, chapter, indexEntry = {} }) {
  if (indexEntry.status === "finalizing") {
    return artifactState("committing", chapter);
  }
  if (indexEntry.status !== "completed") {
    const draftExists = await isReadableFile(projectRoot, indexEntry.draft_path);
    return artifactState(
      draftExists ? "draft_only" : "invalid",
      chapter,
      draftExists ? null : "chapter_not_committed"
    );
  }
  if (!indexEntry.final_path) {
    return artifactState("invalid", chapter, "missing_final_path");
  }
  if (!indexEntry.checksum) {
    return artifactState("invalid", chapter, "missing_checksum");
  }

  const indexedPath = indexEntry.final_path;
  const absolutePath = path.isAbsolute(indexedPath)
    ? path.resolve(indexedPath)
    : path.resolve(projectRoot, indexedPath);
  const relativePath = path.relative(projectRoot, absolutePath).replaceAll("\\", "/");
  if (!isPathInside(projectRoot, absolutePath) || absolutePath === path.resolve(projectRoot)) {
    return artifactState("invalid", chapter, "invalid_path", { relative_path: relativePath });
  }

  let fileStat;
  try {
    fileStat = await stat(absolutePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return artifactState("invalid", chapter, "missing_file", { relative_path: relativePath });
    }
    return artifactState("invalid", chapter, "inspect_error", {
      relative_path: relativePath,
      error_code: error.code ?? null,
    });
  }
  if (!fileStat.isFile()) {
    return artifactState("invalid", chapter, "not_a_file", { relative_path: relativePath });
  }

  const cacheKey = `${absolutePath}:${fileStat.size}:${fileStat.mtimeMs}`;
  let checksum = artifactCache.get(cacheKey);
  if (!checksum) {
    let content;
    try {
      content = await readFile(absolutePath);
    } catch (error) {
      return artifactState("invalid", chapter, "inspect_error", {
        path_exists: true,
        relative_path: relativePath,
        absolute_path: absolutePath,
        error_code: error.code ?? null,
      });
    }
    checksum = sha256(content);
    artifactCache.set(cacheKey, checksum);
  }

  const modifiedAt = fileStat.mtime.toISOString();
  if (indexEntry.checksum !== checksum) {
    return artifactState("invalid", chapter, "checksum_mismatch", {
      path_exists: true,
      checksum_valid: false,
      readable: true,
      relative_path: relativePath,
      absolute_path: absolutePath,
      checksum,
      bytes: fileStat.size,
      modified_at: modifiedAt,
    });
  }
  return {
    chapter,
    state: "committed",
    reason: null,
    path_exists: true,
    checksum_valid: true,
    readable: true,
    relative_path: relativePath,
    absolute_path: absolutePath,
    checksum,
    bytes: fileStat.size,
    modified_at: modifiedAt,
  };
}

function artifactState(state, chapter, reason = null, extra = {}) {
  return {
    chapter,
    state,
    reason,
    path_exists: false,
    checksum_valid: false,
    readable: false,
    relative_path: null,
    absolute_path: null,
    checksum: null,
    bytes: null,
    modified_at: null,
    ...extra,
  };
}

async function isReadableFile(projectRoot, candidate) {
  if (!candidate) return false;
  const absolutePath = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(projectRoot, candidate);
  try {
    return (await stat(absolutePath)).isFile();
  } catch {
    return false;
  }
}
