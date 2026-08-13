// SKILL.md parser（计划 Task 9，冻结契约 §2.5）。
//
// 解析并验证 SKILL.md frontmatter、正文与资源路径；readSkillResource() 在按需
// 读取时执行 realpath containment 与大小校验。标准字段只有 name、description；
// version 与 metadata.wwriting 是可选扩展，未知 metadata 保留但不执行。
//
// 本模块是 src/core/skills 的底层文件：只允许被 src/core/skills/index.mjs
// （唯一 service seam）与 tests/skills/ 使用。
import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { isPathInside, pathExists } from "../fs-utils.mjs";

// SKILL.md 文件大小上限（冻结契约 §2.5：超 512KiB 拒绝）。
export const MAX_SKILL_FILE_BYTES = 512 * 1024;
// 单次读取非 SKILL.md 文本资源的大小上限（与 Task 12 read_skill 的 1MiB 对齐）。
export const MAX_SKILL_RESOURCE_BYTES = 1024 * 1024;
// 资源枚举只包括这三个子目录。
export const SKILL_RESOURCE_DIRS = Object.freeze(["scripts", "references", "assets"]);

// Skills 领域错误：name=SkillError + 小写下划线 code（与全库错误码惯例一致）。
export function skillError(code, message) {
  const error = new Error(message);
  error.name = "SkillError";
  error.code = code;
  return error;
}

// 解析并验证单个技能目录下的 SKILL.md（brief Step 3 verbatim + resources 枚举）。
export async function readSkillFile(skillDir, { source }) {
  const target = path.join(skillDir, "SKILL.md");
  const raw = await readFileOrThrow(target);
  if (Buffer.byteLength(raw, "utf8") > MAX_SKILL_FILE_BYTES) {
    throw skillError("skill_file_too_large", `SKILL.md 超过 ${MAX_SKILL_FILE_BYTES} 字节限制`);
  }
  const { frontmatter, body } = splitFrontmatter(raw);
  let data;
  try {
    data = parseYaml(frontmatter);
  } catch (error) {
    throw skillError("skill_invalid_yaml", `SKILL.md frontmatter 解析失败: ${error.message}`);
  }
  validateSkillName(data?.name, path.basename(skillDir));
  const skillReal = await fs.realpath(skillDir);
  const resources = await enumerateResources(skillDir, skillReal);
  return deepFreeze({ ...data, body, dir: skillDir, source, resources });
}

// 按需读取技能目录内的资源（SKILL.md 或 scripts/references/assets 下文件）。
// 执行 realpath containment（真实路径必须仍在技能 realpath 内）与大小校验。
// 二进制 asset（前 8KiB 含 NUL 字节）返回元数据 + 绝对路径，不把二进制内容
// 塞进模型上下文（Task 12 read_skill 冻结契约）。
export async function readSkillResource(skill, resource = "SKILL.md") {
  assertSafeResource(resource);
  const skillDir = path.resolve(skill.dir);
  const skillReal = await fs.realpath(skillDir);
  const absPath = path.resolve(skillDir, resource);
  let realAbs;
  try {
    realAbs = await fs.realpath(absPath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      throw skillError("skill_resource_not_found", `资源不存在: ${resource}`);
    }
    throw error;
  }
  if (!isPathInside(skillReal, realAbs)) {
    throw skillError("skill_resource_unsafe", `资源真实路径逃逸技能目录: ${resource}`);
  }
  const stat = await fs.stat(realAbs);
  // 目录/非普通文件（EISDIR 场景）：不裸抛 fs 错误，映射为技能错误。
  if (!stat.isFile()) {
    throw skillError("skill_resource_not_found", `资源不是文件: ${resource}`);
  }
  const limit = resource === "SKILL.md" ? MAX_SKILL_FILE_BYTES : MAX_SKILL_RESOURCE_BYTES;
  if (stat.size > limit) {
    throw skillError("skill_resource_too_large", `资源超过 ${limit} 字节: ${resource}`);
  }
  if (stat.size === 0) {
    return Object.freeze({ name: skill.name, resource, content: "", path: realAbs, bytes: 0 });
  }
  const buffer = await fs.readFile(realAbs);
  if (looksBinary(buffer)) {
    return Object.freeze({ name: skill.name, resource, binary: true, path: realAbs, bytes: stat.size });
  }
  return Object.freeze({ name: skill.name, resource, content: buffer.toString("utf8"), path: realAbs, bytes: stat.size });
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

async function readFileOrThrow(target) {
  try {
    return await fs.readFile(target, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw skillError("skill_file_not_found", `缺少 SKILL.md: ${target}`);
    }
    throw error;
  }
}

// 拆分 `---\n<yaml>\n---\n<body>`；缺开/闭 fence 一律拒绝。
function splitFrontmatter(raw) {
  const lines = raw.split(/\r?\n/u);
  const first = String(lines[0] ?? "").replace(/^\uFEFF/u, "").trim();
  if (first !== "---") {
    throw skillError("skill_missing_frontmatter", "SKILL.md 缺少 frontmatter（必须以 --- 开头）");
  }
  let closeIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex === -1) {
    throw skillError("skill_missing_frontmatter", "SKILL.md frontmatter 缺少闭合 ---");
  }
  const bodyLines = lines.slice(closeIndex + 1);
  if (bodyLines[0]?.trim() === "") bodyLines.shift(); // 去掉闭合 fence 后的空行
  return {
    frontmatter: lines.slice(1, closeIndex).join("\n"),
    body: bodyLines.join("\n")
  };
}

// 技能名比较（R5-11）：Windows 文件系统大小写不敏感，名称比较统一大小写归一
// （大小写变体视为同一技能——冲突检测与一致性校验同口径）；POSIX 保持大小写敏感。
export function skillNamesEqual(a, b) {
  if (process.platform === "win32") {
    return String(a).toLowerCase() === String(b).toLowerCase();
  }
  return a === b;
}

// name 必须存在且与目录名一致（冻结契约 §2.5；Windows 下大小写归一后比较）。
function validateSkillName(name, dirName) {
  if (typeof name !== "string" || name.length === 0) {
    throw skillError("skill_missing_name", `SKILL.md 缺少 name 字段（目录: ${dirName}）`);
  }
  if (!skillNamesEqual(name, dirName)) {
    throw skillError("skill_name_mismatch", `目录名 ${dirName} 与 frontmatter name ${name} 不同`);
  }
}

// 技能目录名合法性（Task 13 carry-forward）：validateSkillName 只要求 name 非空且等于
// 目录名，目录名来自技能根的 readdir 单段——这里把「安全单段」约束显式化，供
// removeSkill / ZIP 导入重命名复用。允许中文等任意非空字符（本产品中文技能名）；
// Windows 平台会因非法字符/保留设备名无法落盘，跨平台一律拒绝这些名字。
export function assertSafeSkillDirName(name) {
  if (typeof name !== "string" || name.length === 0) {
    throw skillError("skill_invalid_name", `非法技能名: ${name}`);
  }
  if (name === "." || name === ".." || /[\\/]/u.test(name) || name.includes("\0")) {
    throw skillError("skill_invalid_name", `非法技能名: ${name}`);
  }
  if (/[<>:"|?*]/u.test(name)) {
    throw skillError("skill_invalid_name", `非法技能名: ${name}`);
  }
  // Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9，含带扩展名形式，大小写不敏感）。
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(name)) {
    throw skillError("skill_invalid_name", `非法技能名: ${name}`);
  }
  return name;
}

// 只读 SKILL.md frontmatter 的 name（ZIP 导入 staging 重命名用；不校验目录名，
// 校验由 stageZipImport 之后的 readSkillFile 完成）。缺 name 返回 null。
export async function readSkillNameOnly(skillDir) {
  const raw = await readFileOrThrow(path.join(skillDir, "SKILL.md"));
  const { frontmatter } = splitFrontmatter(raw);
  const data = parseYaml(frontmatter);
  return typeof data?.name === "string" && data.name.length > 0 ? data.name : null;
}

// 枚举 scripts/references/assets 下的全部文件；每个文件的真实路径（realpath）
// 必须仍在技能目录 realpath 内，逃逸即拒绝整个技能。
async function enumerateResources(skillDir, skillReal) {
  const resources = [];
  for (const sub of SKILL_RESOURCE_DIRS) {
    const subDir = path.join(skillDir, sub);
    if (!(await pathExists(subDir))) continue;
    await walkResourceDir(subDir, sub, resources, skillReal);
  }
  resources.sort((a, b) => a.rel.localeCompare(b.rel));
  return resources;
}

async function walkResourceDir(absDir, relPrefix, resources, skillReal) {
  let entries;
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return; // 子目录不可读则跳过该分支，不拒绝整个技能
  }
  for (const entry of entries) {
    const abs = path.join(absDir, entry.name);
    const rel = `${relPrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await walkResourceDir(abs, rel, resources, skillReal);
      continue;
    }
    // 文件或 symlink：真实路径必须仍在 skill realpath 内。
    let realAbs;
    let stat;
    try {
      realAbs = await fs.realpath(abs);
      stat = await fs.stat(realAbs);
    } catch {
      continue; // 悬空 symlink 或不可读：不枚举
    }
    if (!isPathInside(skillReal, realAbs)) {
      throw skillError("skill_resource_unsafe", `资源真实路径逃逸技能目录: ${rel}`);
    }
    if (stat.isFile()) {
      resources.push(Object.freeze({ rel, abs: realAbs, bytes: stat.size }));
    }
  }
}

// 二进制探测：前 8KiB 中出现 NUL 字节即视为二进制（与 git 的启发式一致）。
// 纯文本 UTF-8 文件不含 NUL，误判率极低。
function looksBinary(buffer) {
  const probe = buffer.subarray(0, Math.min(buffer.length, 8192));
  return probe.includes(0);
}

// 拒绝绝对路径、盘符路径与任何 `..` 段（Windows 也拒绝反斜杠书写）。
function assertSafeResource(resource) {  if (typeof resource !== "string" || resource.length === 0) {
    throw skillError("skill_resource_unsafe", "资源路径不能为空");
  }
  if (path.isAbsolute(resource) || /^[A-Za-z]:/u.test(resource)) {
    throw skillError("skill_resource_unsafe", `资源路径不能是绝对路径: ${resource}`);
  }
  const segments = resource.split(/[\\/]/u);
  if (segments.includes("..")) {
    throw skillError("skill_resource_unsafe", `资源路径不能包含 ../ 穿越: ${resource}`);
  }
  if (segments.includes("")) {
    throw skillError("skill_resource_unsafe", `资源路径格式非法: ${resource}`);
  }
}

// 顶层 + 嵌套 metadata/resources 全部冻结，未知 metadata 原样保留。
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}
