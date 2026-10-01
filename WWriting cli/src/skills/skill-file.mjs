// SKILL.md 解析器（对齐上游 core/skills/skill-file，冻结契约 §2.5，文案逐字）。
//
// 解析并验证 SKILL.md frontmatter、正文与资源路径；按需读取的资源安全校验
// （realpath containment、大小上限、二进制判定）在票据 02 随服务 read() 接入。
// 标准字段只有 name、description；version 与 metadata.wwriting 是可选扩展，
// 未知 metadata 保留但不执行。
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { isPathInside, pathExists } from './fs-utils.mjs';

// SKILL.md 文件大小上限（冻结契约 §2.5：超 512KiB 拒绝）。
export const MAX_SKILL_FILE_BYTES = 512 * 1024;
// 资源枚举只包括这三个子目录。
export const SKILL_RESOURCE_DIRS = Object.freeze(['scripts', 'references', 'assets']);

// Skills 领域错误：name=SkillError + 小写下划线 code（与全库错误码惯例一致）。
export function skillError(code, message) {
  const error = new Error(message);
  error.name = 'SkillError';
  error.code = code;
  return error;
}

// 解析并验证单个技能目录下的 SKILL.md（上游 brief Step 3 verbatim + resources 枚举）。
export async function readSkillFile(skillDir, { source }) {
  const target = path.join(skillDir, 'SKILL.md');
  const raw = await readFileOrThrow(target);
  if (Buffer.byteLength(raw, 'utf8') > MAX_SKILL_FILE_BYTES) {
    throw skillError('skill_file_too_large', `SKILL.md 超过 ${MAX_SKILL_FILE_BYTES} 字节限制`);
  }
  const { frontmatter, body } = splitFrontmatter(raw);
  let data;
  try {
    data = parseYaml(frontmatter);
  } catch (error) {
    throw skillError('skill_invalid_yaml', `SKILL.md frontmatter 解析失败: ${error.message}`);
  }
  validateSkillName(data?.name, path.basename(skillDir));
  const skillReal = await fs.realpath(skillDir);
  const resources = await enumerateResources(skillDir, skillReal);
  return deepFreeze({ ...data, body, dir: skillDir, source, resources });
}

// 技能名比较（上游 R5-11）：Windows 文件系统大小写不敏感，名称比较统一大小写归一
// （大小写变体视为同一技能——冲突检测与一致性校验同口径）；POSIX 保持大小写敏感。
export function skillNamesEqual(a, b) {
  if (process.platform === 'win32') {
    return String(a).toLowerCase() === String(b).toLowerCase();
  }
  return a === b;
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

async function readFileOrThrow(target) {
  try {
    return await fs.readFile(target, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw skillError('skill_file_not_found', `缺少 SKILL.md: ${target}`);
    }
    throw error;
  }
}

// 拆分 `---\n<yaml>\n---\n<body>`；缺开/闭 fence 一律拒绝。
function splitFrontmatter(raw) {
  const lines = raw.split(/\r?\n/u);
  const first = String(lines[0] ?? '').replace(/^\uFEFF/u, '').trim();
  if (first !== '---') {
    throw skillError('skill_missing_frontmatter', 'SKILL.md 缺少 frontmatter（必须以 --- 开头）');
  }
  let closeIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex === -1) {
    throw skillError('skill_missing_frontmatter', 'SKILL.md frontmatter 缺少闭合 ---');
  }
  const bodyLines = lines.slice(closeIndex + 1);
  if (bodyLines[0]?.trim() === '') bodyLines.shift(); // 去掉闭合 fence 后的空行
  return {
    frontmatter: lines.slice(1, closeIndex).join('\n'),
    body: bodyLines.join('\n'),
  };
}

// name 必须存在且与目录名一致（冻结契约 §2.5；Windows 下大小写归一后比较）。
function validateSkillName(name, dirName) {
  if (typeof name !== 'string' || name.length === 0) {
    throw skillError('skill_missing_name', `SKILL.md 缺少 name 字段（目录: ${dirName}）`);
  }
  if (!skillNamesEqual(name, dirName)) {
    throw skillError('skill_name_mismatch', `目录名 ${dirName} 与 frontmatter name ${name} 不同`);
  }
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
      throw skillError('skill_resource_unsafe', `资源真实路径逃逸技能目录: ${rel}`);
    }
    if (stat.isFile()) {
      resources.push(Object.freeze({ rel, abs: realAbs, bytes: stat.size }));
    }
  }
}

// 顶层 + 嵌套 metadata/resources 全部冻结，未知 metadata 原样保留。
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}
