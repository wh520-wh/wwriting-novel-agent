// src/core/skills/importer.mjs —— 安全技能导入（计划 Task 13 Step 1）。
//
// 冻结契约（brief verbatim）：
//   - 文件夹与 ZIP 都先落到「目标盘」的临时目录（staging 建在 targetRoot 父目录，
//     保证最终 fs.rename 原子）；
//   - ZIP 用 yauzl lazyEntries 逐 entry 校验后再展开：拒绝绝对路径、盘符、`..`、
//     symlink、单文件 > 10MiB、总展开 > 50MiB；
//   - 展开后以 readSkillFile 验证 SKILL.md（frontmatter / name 与目录名一致 /
//     资源 realpath containment），最后原子 rename 到目标根；
//   - 重名由 service seam 抛 skill_exists（HTTP 409），replace:true 仅 UI 二次确认后传。
//
// 本模块是 src/core/skills 的底层文件：只允许被 src/core/skills/index.mjs
// （唯一 service seam）与 tests/skills/ 使用。
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import yauzl from "yauzl";
import { assertSafeSkillDirName, readSkillFile, readSkillNameOnly, skillError } from "./skill-file.mjs";

// ZIP entry 大小上限（冻结契约，verbatim）。
export const MAX_ZIP_ENTRY_BYTES = 10 * 1024 * 1024;
// ZIP 总展开上限（冻结契约，verbatim）。
export const MAX_ZIP_TOTAL_BYTES = 50 * 1024 * 1024;

// 统一入口：source 为文件夹或 ZIP 文件路径。返回 { name, dir, stagingRoot }——
// dir 是 staging 下以技能名命名的完整技能目录（已通过 readSkillFile 验证），
// stagingRoot 供调用方 finally 清理。任何失败都不触碰目标根。
export async function stageSkillSource({ source, targetRoot }) {
  const abs = path.resolve(String(source ?? ""));
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw skillError("skill_source_not_found", `导入源不存在: ${abs}`);
  }
  if (stat.isDirectory()) {
    return stageFolderImport({ sourceDir: abs, targetRoot });
  }
  if (stat.isFile()) {
    return stageZipImport({ sourceZip: abs, targetRoot });
  }
  throw skillError("skill_source_invalid", `导入源必须是文件夹或 ZIP 文件: ${abs}`);
}

// ---------------------------------------------------------------------------
// 文件夹导入
// ---------------------------------------------------------------------------

async function stageFolderImport({ sourceDir, targetRoot }) {
  // 源目录先整体通过 readSkillFile（目录名 = frontmatter name、资源 containment）。
  const name = path.basename(sourceDir);
  const source = await readSkillFile(sourceDir, { source: "import" });
  const stagingRoot = await makeStagingRoot(targetRoot);
  const staging = path.join(stagingRoot, name);
  try {
    await fs.mkdir(staging, { recursive: true });
    // 只复制 SKILL.md + scripts/references/assets（readSkillFile 枚举的资源集合），
    // 不把源目录里的杂项文件带进技能目录。
    await fs.copyFile(path.join(sourceDir, "SKILL.md"), path.join(staging, "SKILL.md"));
    for (const resource of source.resources) {
      const dest = path.join(staging, resource.rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(resource.abs, dest);
    }
    // 复制后的 staging 再验证一遍：内容自洽、name 与目录名一致。
    await readSkillFile(staging, { source: "import" });
    return { name, dir: staging, stagingRoot };
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

// ---------------------------------------------------------------------------
// ZIP 导入
// ---------------------------------------------------------------------------

// ZIP entry 路径安全校验：拒绝绝对路径、盘符、`..` 段与反斜杠书写。
function assertSafeZipEntryPath(entryName, reason) {
  if (typeof entryName !== "string" || entryName.length === 0) {
    throw skillError("skill_zip_unsafe", `${reason}: 空路径`);
  }
  if (path.isAbsolute(entryName) || /^[A-Za-z]:/u.test(entryName)) {
    throw skillError("skill_zip_unsafe", `${reason}: 绝对路径（${entryName}）`);
  }
  const segments = entryName.split(/[\\/]/u);
  if (segments.some((segment) => segment === "..")) {
    throw skillError("skill_zip_unsafe", `${reason}: 路径包含 ../ 穿越（${entryName}）`);
  }
  if (entryName.includes("\0")) {
    throw skillError("skill_zip_unsafe", `${reason}: 路径包含 NUL 字节`);
  }
}

// Unix 外部属性类型位：symlink = 0o120000（zip 的 symlink 在 externalFileAttributes
// 高位 16 位携带 Unix mode，与 tar/zip 惯例一致）。
function isZipSymlinkEntry(entry) {
  const mode = (Number(entry.externalFileAttributes ?? 0) >>> 16) & 0o170000;
  return mode === 0o120000;
}

// ZIP 白名单单元数据项（R5-2）：__MACOSX 顶层镜像子树、顶层 .DS_Store 单文件、
// 顶层 README（README / README.md / README.txt，大小写不敏感）——macOS
// Finder/归档工具生成的技能包常见产物，不是技能内容。布局按剔除白名单后的真实
// 顶层根判定，展开时一律忽略这些条目。取舍：根布局技能若自带顶层 README.md，
// 该文件会随白名单一并丢弃（白名单语义，接受）；其余任何顶层条目（含第二个
// 真实技能根）都按真实内容处理。
function isIgnoredZipEntry(entryName) {
  const first = entryName.split(/[\\/]/u)[0];
  const isTopLevelFile = !/[\\/]/u.test(entryName) && !entryName.endsWith("/");
  if (first === "__MACOSX") return true; // 顶层镜像子树整体忽略
  if (isTopLevelFile && first === ".DS_Store") return true; // 顶层 .DS_Store 单文件
  if (!isTopLevelFile) return false;
  return /^README(?:\.(?:md|txt))?$/iu.test(first);
}

async function stageZipImport({ sourceZip, targetRoot }) {
  let zipfile;
  try {
    zipfile = await yauzl.openPromise(sourceZip, {
      lazyEntries: true,
      // 关闭必须由本模块控制：autoClose 会在读完最后一个 entry 时立刻 close，
      // 而 pass 2 展开还需要再开 read stream。
      autoClose: false,
      validateEntrySizes: true
    });
  } catch (error) {
    throw skillError("skill_zip_invalid", `无法打开 ZIP 包: ${error?.message ?? String(error)}`);
  }

  // pass 1：lazy 逐 entry 校验（不展开任何数据），收集相对路径。
  const entries = [];
  let totalBytes = 0;
  try {
    await new Promise((resolve, reject) => {
      zipfile.on("entry", (entry) => {
        try {
          assertSafeZipEntryPath(entry.fileName, "ZIP entry 非法");
          if (isZipSymlinkEntry(entry)) {
            throw skillError("skill_zip_unsafe", `ZIP entry 是符号链接: ${entry.fileName}`);
          }
          if (entry.uncompressedSize > MAX_ZIP_ENTRY_BYTES) {
            throw skillError(
              "skill_zip_too_large",
              `ZIP entry 超过 ${MAX_ZIP_ENTRY_BYTES} 字节: ${entry.fileName}（${entry.uncompressedSize}）`
            );
          }
          totalBytes += entry.uncompressedSize;
          if (totalBytes > MAX_ZIP_TOTAL_BYTES) {
            throw skillError(
              "skill_zip_too_large",
              `ZIP 总展开超过 ${MAX_ZIP_TOTAL_BYTES} 字节`
            );
          }
          entries.push({ entry, name: entry.fileName });
          zipfile.readEntry();
        } catch (error) {
          reject(error);
        }
      });
      zipfile.on("end", resolve);
      zipfile.on("error", (error) => {
        // yauzl 自带 validateFileName 会先于 entry 事件拒绝绝对路径/盘符/../反斜杠
        // 名称（严格文件名校验在 getFileNameLowLevel 里归一化后执行），这些错误没有
        // code——按冻结契约映射为 skill_zip_unsafe；其余（损坏 zip/IO）映射为
        // skill_zip_invalid。
        const message = error?.message ?? String(error);
        const isPathIssue = /absolute path|invalid characters|invalid relative path/u.test(message);
        reject(skillError(isPathIssue ? "skill_zip_unsafe" : "skill_zip_invalid", message));
      });
      zipfile.readEntry();
    });
  } catch (error) {
    zipfile.close();
    throw error;
  }

  // 布局（R5-2）：按结构化 entry 分类而非字符串猜根——白名单单元数据项
  // （__MACOSX/.DS_Store/顶层 README）先剔除；剩余真实顶层根恰好一个 → 剥离该
  // 前缀（zip 里是一个技能文件夹）；SKILL.md 在 zip 根 → 技能内容直接在 zip 根；
  // 多个真实技能根 → 整体拒绝（误导性的「缺少 SKILL.md」不再出现）。
  const realTopLevels = new Set();
  for (const { name } of entries) {
    if (isIgnoredZipEntry(name)) continue;
    const first = name.split(/[\\/]/u)[0];
    if (first.length > 0) realTopLevels.add(first);
  }
  let stripPrefix = null;
  if (!realTopLevels.has("SKILL.md")) {
    if (realTopLevels.size === 1) {
      stripPrefix = [...realTopLevels][0];
    } else if (realTopLevels.size > 1) {
      zipfile.close();
      throw skillError(
        "skill_zip_invalid",
        `ZIP 包含多个技能根: ${[...realTopLevels].sort().join(", ")}`
      );
    }
  }

  const stagingRoot = await makeStagingRoot(targetRoot);
  const staging = path.join(stagingRoot, "skill");
  try {
    await fs.mkdir(staging, { recursive: true });
    // pass 2：展开（相对路径已全部通过 pass 1 校验；写入前再做 containment 兜底）。
    // 展开期 IO/解压失败（损坏数据、磁盘错误等）映射为带 code 的技能错误，
    // 让 HTTP 层返回结构化错误而不是裸 fs 异常。
    try {
      for (const { entry } of entries) {
        if (isIgnoredZipEntry(entry.fileName)) continue; // R5-2：白名单单元数据项不展开
        let rel = entry.fileName.replace(/\\/gu, "/");
        if (stripPrefix) {
          if (rel === stripPrefix || rel.startsWith(`${stripPrefix}/`)) {
            rel = rel.slice(stripPrefix.length).replace(/^\//u, "");
          }
        }
        if (rel.length === 0) continue; // 顶层目录条目
        const dest = path.resolve(staging, rel);
        if (path.relative(path.resolve(staging), dest).startsWith("..")) {
          throw skillError("skill_zip_unsafe", `ZIP entry 逃逸技能目录: ${entry.fileName}`);
        }
        if (entry.fileName.endsWith("/")) {
          await fs.mkdir(dest, { recursive: true });
          continue;
        }
        await fs.mkdir(path.dirname(dest), { recursive: true });
        const readStream = await zipfile.openReadStreamPromise(entry);
        await pipeToFile(readStream, dest);
      }
    } catch (error) {
      // 校验类错误（SkillError）原样透传；其余按展开失败映射。
      if (error?.name === "SkillError") throw error;
      throw skillError("skill_zip_invalid", `ZIP 展开失败: ${error?.message ?? String(error)}`);
    }

    // 验证 SKILL.md 并取 frontmatter name；目录名与 name 不一致时按 name 重命名。
    const name = await readSkillNameOnly(staging);
    if (!name) {
      throw skillError("skill_missing_name", "ZIP 内 SKILL.md 缺少 name 字段");
    }
    assertSafeSkillDirName(name);
    let finalDir = staging;
    if (name !== "skill") {
      finalDir = path.join(stagingRoot, name);
      await fs.rename(staging, finalDir);
    }
    await readSkillFile(finalDir, { source: "import" });
    return { name, dir: finalDir, stagingRoot };
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    // yauzl 的 close() 幂等（已 autoClose 时为 no-op），这里只防御性关闭。
    if (zipfile) {
      try { zipfile.close(); } catch { /* 已关闭 */ }
    }
  }
}

// 流式写文件：拒绝中途大小超限（validateEntrySizes 已在 openReadStream 层校验，
// 这里只做防御性落盘失败传播）。
async function pipeToFile(readStream, dest) {
  await new Promise((resolve, reject) => {
    const writeStream = createWriteStream(dest);
    readStream.on("error", reject);
    writeStream.on("error", reject);
    writeStream.on("close", resolve);
    readStream.pipe(writeStream);
  });
}

// ---------------------------------------------------------------------------
// staging 根：targetRoot 的父目录（同盘，保证最终 rename 原子）。
// ---------------------------------------------------------------------------

async function makeStagingRoot(targetRoot) {
  const parent = path.resolve(path.dirname(path.resolve(targetRoot)));
  await fs.mkdir(parent, { recursive: true });
  return fs.mkdtemp(path.join(parent, ".wwriting-skill-import-"));
}
