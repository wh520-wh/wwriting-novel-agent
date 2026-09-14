import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export function sha256(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

// 返回路径解析后的真实文件系统位置，处理目录 junction、文件 symlink，以及
// 尚不存在目标文件时最近真实父目录下的新 basename。用于安全边界判断，避免
// 仅按字符串比较时把项目内链接误判为项目内。
export async function resolveFilesystemPath(targetPath) {
  const absolute = path.resolve(targetPath);
  let cursor = absolute;
  const suffix = [];
  while (true) {
    try {
      const realParent = await fs.realpath(cursor);
      return path.join(realParent, ...suffix.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) return absolute;
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

export function safeJoin(rootPath, ...parts) {
  const root = path.resolve(rootPath);
  const target = path.resolve(root, ...parts);
  if (!isPathInside(root, target)) {
    throw new Error(`Path escapes project root: ${target}`);
  }
  return target;
}

export function isPathInside(rootPath, targetPath) {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  // Windows 文件系统大小写不敏感：字面比较前归一化大小写，避免 ".wwriting/AGENT/…"、
  // "Chapters/001.md" 等大小写变体绕过受保护路径检查（安全边界）。POSIX 保持
  // 大小写敏感（区分大小写的文件系统，且误判 inside 属于放行方向，宁可保守）。
  if (process.platform === "win32") {
    const rootForCompare = root.toLowerCase();
    const targetForCompare = target.toLowerCase();
    return targetForCompare === rootForCompare || targetForCompare.startsWith(rootForCompare + path.sep);
  }
  return target === root || target.startsWith(root + path.sep);
}

export function assertSafeSlug(slug) {
  if (typeof slug !== "string" || slug.length === 0 || slug.length > 80) {
    throw new Error("Project slug must be a non-empty string up to 80 characters");
  }
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/u.test(slug)) {
    throw new Error(`Invalid project slug: ${slug}`);
  }
  if (slug === "." || slug === ".." || slug.endsWith(".")) {
    throw new Error(`Invalid project slug: ${slug}`);
  }
  return slug;
}

export async function writeFileAtomic(targetPath, content) {
  await ensureDir(path.dirname(targetPath));
  const tmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(tmpPath, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await renameWithRetry(tmpPath, targetPath);
  } catch (error) {
    // 写失败清理临时文件：rename 失败（目标被并发删除/占用、磁盘错误等）时 tmp
    // 是孤儿垃圾，残留会污染目录（Windows 下 rmdir 会因孤儿 tmp 报 ENOTEMPTY）。
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
  return {
    path: targetPath,
    bytes_written: Buffer.byteLength(content, "utf8"),
    checksum: sha256(content)
  };
}

export async function readJson(targetPath, fallback = null) {
  if (!(await pathExists(targetPath))) {
    return fallback;
  }
  return JSON.parse(await fs.readFile(targetPath, "utf8"));
}

export async function writeJsonAtomic(targetPath, value) {
  return writeFileAtomic(targetPath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function renameWithRetry(sourcePath, targetPath) {
  let lastError = null;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      await fs.rename(sourcePath, targetPath);
      return;
    } catch (error) {
      lastError = error;
      if (!["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt === 6) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 35));
    }
  }
  throw lastError;
}
