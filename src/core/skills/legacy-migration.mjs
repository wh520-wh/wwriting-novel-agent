// 旧 manifest（skill.json/yaml/yml）一次性迁移到 SKILL.md（计划 Task 11）。
//
// 迁移是幂等的，管线固定（brief Step 2 verbatim）：
//   1. 扫描旧 manifest；2. 解析为统一中间对象；3. 原子写 SKILL.md；
//   4. 重新调用 readSkillFile 验证；5. 移动旧文件到 backup；
//   6. 原子写 migration marker。任一步失败都不删除源文件。
//
// 旧 manifest 移入 <userHome>/.wwriting/migrations/skills-v2-backup/<scope>/<name>/，
// marker 位于 <backupRoot>/<scope>/migration-marker.json，至少包含
// schema_version: 2、completed_at、migrated[]、failed[]。
//
// 单个技能迁移失败不阻止其他技能：失败写入 failed[]（含 scope/name/manifest/error），
// UI 据此显示失败项。live 目录中已存在合法 SKILL.md 的技能只备份旧 manifest，
// 绝不改写已验证的 SKILL.md（幂等）。
//
// 本模块是 src/core/skills 的底层文件：只允许被 src/core/skills/index.mjs
// （唯一 service seam）与 tests/skills/ 使用。
import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ensureDir, pathExists, writeFileAtomic } from "../fs-utils.mjs";
import { readSkillFile, skillError } from "./skill-file.mjs";

// migration marker 的 schema 版本（与 SKILL.md 的 schema_version 无关，见 memory 文档）。
export const MIGRATION_SCHEMA_VERSION = 2;
// 旧 manifest 文件名与旧 runtime findManifestFile 优先级一致（json > yaml > yml）。
export const LEGACY_MANIFEST_NAMES = Object.freeze(["skill.json", "skill.yaml", "skill.yml"]);
const BACKUP_ROOT_NAME = "skills-v2-backup";

// 迁移 Promise 缓存：全局迁移每进程每个 userHome 只创建一次；
// 项目迁移按 canonical projectRoot 缓存。失败仍 resolve（失败项在 failed[]），
// 只有不可恢复的基础设施错误才 reject。
const globalMigrationPromises = new Map();
const projectMigrationPromises = new Map();

// 完整迁移入口：迁移传入的所有 scope（有 userHome 则迁移 global，有 projectRoot
// 则迁移 project）。service seam 通过 ensureMigrated 按 scope 分别缓存调用。
export async function migrateLegacySkills({ projectRoot, userHome, clock } = {}) {
  const scopes = [];
  if (userHome) scopes.push({ scope: "global", skillRoot: path.join(userHome, ".wwriting", "skills") });
  if (projectRoot) scopes.push({ scope: "project", skillRoot: path.join(projectRoot, "skills") });
  const backupRoot = userHome ? path.join(userHome, ".wwriting", "migrations", BACKUP_ROOT_NAME) : null;

  const migrated = [];
  const failed = [];
  for (const { scope, skillRoot } of scopes) {
    if (!backupRoot) {
      failed.push({ scope, name: null, manifest: "backup-root", error: "缺少 userHome，无法定位 migration backup 目录" });
      continue;
    }
    const result = await migrateScope(scope, skillRoot, backupRoot, clock);
    migrated.push(...result.migrated);
    failed.push(...result.failed);
  }
  return { migrated, failed };
}

// service seam 入口：全局迁移 Promise 每进程每 userHome 只创建一次，项目迁移
// Promise 按 canonical projectRoot 缓存。catalog/read/importSkill/removeSkill
// 在工作前统一调用本函数。
export async function ensureMigrated({ projectRoot, userHome, clock } = {}) {
  const backupRoot = userHome ? path.join(userHome, ".wwriting", "migrations", BACKUP_ROOT_NAME) : null;
  const jobs = [];
  if (userHome) {
    const key = await canonicalPath(userHome);
    let promise = globalMigrationPromises.get(key);
    if (!promise) {
      promise = migrateScope("global", path.join(userHome, ".wwriting", "skills"), backupRoot, clock);
      globalMigrationPromises.set(key, promise);
    }
    jobs.push(promise);
  }
  if (projectRoot) {
    const key = await canonicalPath(projectRoot);
    let promise = projectMigrationPromises.get(key);
    if (!promise) {
      promise = migrateScope("project", path.join(projectRoot, "skills"), backupRoot, clock);
      projectMigrationPromises.set(key, promise);
    }
    jobs.push(promise);
  }
  const results = await Promise.all(jobs);
  return {
    migrated: results.flatMap((result) => result.migrated),
    failed: results.flatMap((result) => result.failed)
  };
}

// ---------------------------------------------------------------------------
// 单 scope 迁移管线（1-6 步）
// ---------------------------------------------------------------------------

async function migrateScope(scope, skillRoot, backupRoot, clock) {
  const scopeBackup = path.join(backupRoot, scope);
  const markerPath = path.join(scopeBackup, "migration-marker.json");
  const candidates = await scanLegacyManifests(skillRoot);
  const migrated = [];
  const failed = [];

  // 幂等：无旧 manifest 且已有 marker → 完全无操作（不重写 marker，不改写任何文件）。
  if (candidates.length === 0 && (await pathExists(markerPath))) {
    return { scope, migrated, failed };
  }

  for (const candidate of candidates) {
    try {
      migrated.push(await migrateOneSkill(candidate, scope, scopeBackup));
    } catch (error) {
      failed.push({
        scope,
        name: candidate.name,
        manifest: path.basename(candidate.primary),
        error: error?.message ?? String(error)
      });
    }
  }

  // 6. 原子写 migration marker（失败不抛：记录进 failed，下次运行自愈）。
  const marker = {
    schema_version: MIGRATION_SCHEMA_VERSION,
    completed_at: timestamp(clock),
    scope,
    migrated,
    failed
  };
  try {
    await writeFileAtomic(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  } catch (error) {
    failed.push({ scope, name: null, manifest: "migration-marker.json", error: error?.message ?? String(error) });
  }
  return { scope, migrated, failed };
}

// 1. 扫描技能根的直接子目录，找出含旧 manifest 的目录（json > yaml > yml 优先级）。
async function scanLegacyManifests(skillRoot) {
  let entries;
  try {
    entries = await fs.readdir(skillRoot, { withFileTypes: true });
  } catch {
    return []; // root 不存在或不可读：该层没有旧 manifest
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const dir = path.join(skillRoot, entry.name);
    let stat;
    try {
      stat = await fs.stat(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const present = [];
    for (const name of LEGACY_MANIFEST_NAMES) {
      if (await pathExists(path.join(dir, name))) present.push(name);
    }
    if (present.length === 0) continue;
    candidates.push({
      name: entry.name,
      dir,
      primary: path.join(dir, present[0]),
      allManifestPaths: present.map((name) => path.join(dir, name))
    });
  }
  return candidates;
}

// 单个技能迁移（3-5 步）：SKILL.md 已存在则只验证不改写；否则生成并原子写入。
// 任一步失败都抛错（由调用方记入 failed），源文件保持原位。
async function migrateOneSkill(candidate, scope, scopeBackup) {
  const { name, dir, primary, allManifestPaths } = candidate;
  const skillMdPath = path.join(dir, "SKILL.md");
  let status;
  if (await pathExists(skillMdPath)) {
    // 已存在 SKILL.md：readSkillFile 验证合法即视为已完成，绝不改写。
    await readSkillFile(dir, { source: scope });
    status = "existing";
  } else {
    // 2. 解析为统一中间对象。
    const manifest = await parseLegacyManifest(primary);
    if (typeof manifest?.name !== "string" || manifest.name !== name) {
      throw skillError("skill_name_mismatch", `旧 manifest name（${manifest?.name ?? "缺失"}）与目录名 ${name} 不一致`);
    }
    // 3. 原子写 SKILL.md。
    await writeFileAtomic(skillMdPath, buildSkillMd(manifest));
    // 4. 重新调用 readSkillFile 验证。
    await readSkillFile(dir, { source: scope });
    status = "migrated";
  }
  // 5. 移动旧文件到 backup（跨盘 fallback：复制成功后删除源文件）。
  const destDir = path.join(scopeBackup, name);
  await ensureDir(destDir);
  for (const manifestPath of allManifestPaths) {
    await moveIntoBackup(manifestPath, path.join(destDir, path.basename(manifestPath)));
  }
  return { scope, name, manifest: path.basename(primary), status };
}

// 旧 manifest 解析：JSON 优先（与旧 runtime parseSkillManifest 一致），失败回退
// 到 YAML；两者都失败视为无效 manifest。去掉 BOM 再解析。
async function parseLegacyManifest(manifestPath) {
  const source = String(await fs.readFile(manifestPath, "utf8")).replace(/^\uFEFF/u, "");
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    try {
      parsed = parseYaml(source);
    } catch (error) {
      throw skillError("skill_invalid_manifest", `旧 manifest 解析失败（${path.basename(manifestPath)}）: ${error.message}`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw skillError("skill_invalid_manifest", `旧 manifest 不是对象（${path.basename(manifestPath)}）`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// 旧 manifest → SKILL.md 内容生成（Task 10 转换规则固定表）
// ---------------------------------------------------------------------------
// | 旧字段               | 新位置                                  |
// | name/description/version | 顶层 frontmatter                    |
// | scope/priority/hooks | metadata.wwriting                      |
// | append_prompt.content | 正文“Instructions”                     |
// | check.prompt         | 正文“Review checklist”并保留 checker id |
// post_process.content 移入正文“Post-process”（Task 12 从正文取 prompt/content）。
// 本函数同时在 seam 上暴露（/api/skills/import 的 manifest 对象契约复用同一转换）。
export function buildSkillMd(manifest) {
  const name = String(manifest.name);
  const hooks = Array.isArray(manifest.hooks)
    ? manifest.hooks.filter((hook) => hook && typeof hook === "object")
    : [];

  // metadata.wwriting：结构字段 + 结构化的 hooks（不携带 content/prompt）。
  const wwriting = {
    scope: typeof manifest.scope === "string" ? manifest.scope : "chapter",
    priority: Number.isFinite(manifest.priority) ? manifest.priority : 100
  };
  if (typeof manifest.type === "string") wwriting.type = manifest.type;
  const structureHooks = hooks.map((hook) => {
    const out = {};
    for (const key of ["stage", "action", "check", "conditions", "priority"]) {
      if (hook[key] !== undefined) out[key] = hook[key];
    }
    return out;
  });
  if (structureHooks.length > 0) wwriting.hooks = structureHooks;

  const frontmatter = {
    name,
    ...(typeof manifest.description === "string" ? { description: manifest.description } : {}),
    ...(typeof manifest.version === "string" ? { version: manifest.version } : {}),
    metadata: { wwriting }
  };

  const sections = [`# ${toTitleCase(name)}`];
  const instructions = hooks
    .filter((hook) => hook.action === "append_prompt" && hook.content != null)
    .map((hook) => String(hook.content).trim())
    .filter(Boolean);
  if (instructions.length > 0) {
    sections.push(`## Instructions\n\n${instructions.join("\n\n")}`);
  }
  const checks = hooks.filter((hook) => hook.action === "check" && hook.prompt != null);
  if (checks.length > 0) {
    sections.push(`## Review checklist\n\n${checks.map((hook) => `- **${hook.check ?? "check"}**：${String(hook.prompt).trim()}`).join("\n")}`);
  }
  const postProcess = hooks
    .filter((hook) => hook.action === "post_process" && hook.content != null)
    .map((hook) => String(hook.content).trim())
    .filter(Boolean);
  if (postProcess.length > 0) {
    sections.push(`## Post-process\n\n${postProcess.join("\n\n")}`);
  }

  const frontmatterYaml = stringifyYaml(frontmatter).trimEnd();
  return `---\n${frontmatterYaml}\n---\n\n${sections.join("\n\n")}\n`;
}

// "suspense-chapter-end" → "Suspense Chapter End"（与手写内置 SKILL.md 标题风格一致）。
function toTitleCase(name) {
  return String(name)
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function timestamp(clock) {
  const value = typeof clock === "function" ? clock() : (clock ?? new Date());
  return value instanceof Date ? value.toISOString() : String(value);
}

// 移动文件到 backup；跨盘（projectRoot 与 userHome 在不同盘）rename 抛 EXDEV 时
// 先复制成功再删除源文件——任何一步失败都不丢源内容。
async function moveIntoBackup(sourcePath, destPath) {
  try {
    await fs.rename(sourcePath, destPath);
    return;
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
  }
  await ensureDir(path.dirname(destPath));
  await fs.copyFile(sourcePath, destPath);
  await fs.unlink(sourcePath);
}

// canonical 路径：realpath 解析符号链接/大小写差异；路径不存在时回退 path.resolve。
async function canonicalPath(targetPath) {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}
