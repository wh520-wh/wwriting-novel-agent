// 技能分区的文件系统小工具（语义逐字对齐上游 core/fs-utils，仅本分区使用）。
import fs from 'node:fs/promises';
import path from 'node:path';

export async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function isPathInside(rootPath, targetPath) {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  // Windows 文件系统大小写不敏感：字面比较前归一化大小写，避免大小写变体绕过
  // 受包含检查保护的路径（安全边界）。POSIX 保持大小写敏感。
  if (process.platform === 'win32') {
    const rootForCompare = root.toLowerCase();
    const targetForCompare = target.toLowerCase();
    return targetForCompare === rootForCompare || targetForCompare.startsWith(rootForCompare + path.sep);
  }
  return target === root || target.startsWith(root + path.sep);
}
