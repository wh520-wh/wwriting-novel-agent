// 生产代码唯一 Skills service seam（计划 Task 9，brief Step 5 verbatim；Task 11 接入迁移）。
//
// catalog/read/importSkill/removeSkill/migrationErrors 在工作前统一调用
// ensureMigrated({projectRoot})：全局迁移 Promise 每进程每个 userHome 只创建一次，
// 项目迁移 Promise 按 canonical projectRoot 缓存；新 catalog 只在迁移完成后运行，
// 并且永远不读取 skill.json/yaml/yml。catalog 结果携带 migration_errors（迁移失败项），
// 供 UI 展示；migrationErrors() 额外重读 migration marker 提供「新鲜」失败项（Task 13）。
//
// 生产模块只允许从这里导入；底层文件（skill-file.mjs / catalog.mjs / legacy-migration.mjs /
// hooks.mjs / importer.mjs）仅由本 service 与 tests/skills/ 使用。默认 root 在 service
// 内统一解析，测试通过 factory 注入临时目录。Task 13 把 importSkill 升级为安全导入
//（文件夹/ZIP → 目标盘临时目录 → 逐 entry 校验展开 → 验证 SKILL.md → 原子 rename；
// 重名 409 / replace 覆盖），不建立第二个入口。
//
// Task 12：runSkillChecks/runPostProcessHooks 也经本 seam 暴露——hooks 的确定性实现
// 在 hooks.mjs（只接收技能列表），这里负责从 service 解析 active catalog 并绑定
// skillService。调用方可通过 context.skills 注入 active 技能列表或带 catalog() 的
// service（测试/运行时注入，避免触碰真实用户目录）。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathExists } from "../fs-utils.mjs";
import { discoverSkills } from "./catalog.mjs";
import { stageSkillSource } from "./importer.mjs";
import { ensureMigrated, readMigrationMarker } from "./legacy-migration.mjs";
import { assertSafeSkillDirName, readSkillFile, readSkillResource, skillError } from "./skill-file.mjs";
import {
  runPostProcessHooksWithSkills,
  runSkillChecksWithSkills
} from "./hooks.mjs";

// 内置技能根目录 src/skills（Task 10 落地五个内置 SKILL.md；当前允许缺失）。
const DEFAULT_BUILTIN_ROOT = path.resolve(import.meta.dirname, "..", "..", "skills");

export function createSkillService({ userHome = os.homedir(), resourcesPath = process.resourcesPath, builtinRoot = DEFAULT_BUILTIN_ROOT } = {}) {
  // 迁移先行：任何 catalog 数据都在 ensureMigrated 完成后才读取（旧 manifest 只作迁移输入）。
  const runCatalog = async ({ projectRoot }) => {
    const migration = await ensureMigrated({ projectRoot, userHome });
    const discovered = await discoverSkills({ projectRoot, userHome, resourcesPath, builtinRoot });
    return { discovered, failed: migration.failed };
  };
  return {
    async catalog({ projectRoot }) {
      const { discovered, failed } = await runCatalog({ projectRoot });
      return Object.freeze({ ...discovered, migration_errors: Object.freeze(failed) });
    },
    async read({ projectRoot, name, resource = "SKILL.md" }) {
      const { discovered } = await runCatalog({ projectRoot });
      const skill = discovered.active.find((item) => item.name === name);
      if (!skill) throw skillError("skill_not_found", `未发现技能: ${name}`);
      return readSkillResource(skill, resource);
    },
    // 安全导入（Task 13 升级）：source 为文件夹或 ZIP 路径。文件夹/ZIP 都先落到
    // 目标盘（目标技能根父目录）的临时目录，逐 entry 校验后展开、验证 SKILL.md，
    // 再原子 rename 到目标根；重名默认 skill_exists（HTTP 409 语义），replace:true
    // 仅在 UI 二次确认后传入。
    async importSkill({ projectRoot, source, scope = "project", replace = false }) {
      await ensureMigrated({ projectRoot, userHome });
      assertValidScope(scope);
      const targetRoot = skillRootFor({ projectRoot, scope, userHome });
      await fs.mkdir(targetRoot, { recursive: true });
      const staged = await stageSkillSource({ source, targetRoot });
      try {
        const targetDir = path.join(targetRoot, staged.name);
        const exists = await pathExists(targetDir);
        if (exists && !replace) throw skillError("skill_exists", `技能已存在: ${staged.name}`);
        if (exists && replace) {
          await fs.rm(targetDir, { recursive: true, force: true });
        }
        // 原子 rename：staging 与 targetRoot 同盘（stageSkillSource 建在 targetRoot
        // 父目录下）。replace 分支先删旧目录再 rename（短暂空窗可接受）。
        await fs.rename(staged.dir, targetDir);
        return readSkillFile(targetDir, { source: scope });
      } finally {
        await fs.rm(staged.stagingRoot, { recursive: true, force: true }).catch(() => {});
      }
    },
    // 删除指定 scope 下的技能目录（name 校验与 readSkillFile 的目录名语义对齐：
    // 允许中文等任意非空单段名，拒绝路径分隔符与 . / .. 防穿越）。
    async removeSkill({ projectRoot, name, scope = "project" }) {
      await ensureMigrated({ projectRoot, userHome });
      assertValidScope(scope);
      assertSafeSkillDirName(name);
      const targetDir = path.join(skillRootFor({ projectRoot, scope, userHome }), name);
      if (!(await pathExists(targetDir))) throw skillError("skill_not_found", `未发现技能: ${name}`);
      await fs.rm(targetDir, { recursive: true, force: true });
      return { name, scope, removed: true };
    },
    // 迁移失败项（Task 13 carry-forward）：不依赖进程内缓存的首次迁移结果，
    // 直接重读 migration marker，settings 的 catalog 路由据此展示「新鲜」失败项。
    async migrationErrors({ projectRoot }) {
      const [globalMarker, projectMarker] = await Promise.all([
        readMigrationMarker({ scope: "global", userHome }),
        projectRoot ? readMigrationMarker({ scope: "project", userHome }) : Promise.resolve(null)
      ]);
      return Object.freeze([
        ...(globalMarker?.failed ?? []),
        ...(projectMarker?.failed ?? [])
      ]);
    }
  };
}

function skillRootFor({ projectRoot, scope, userHome }) {
  return scope === "global" ? path.join(userHome, ".wwriting", "skills") : path.join(projectRoot, "skills");
}

function assertValidScope(scope) {
  if (scope !== "global" && scope !== "project") {
    throw skillError("skill_invalid_scope", `非法 scope: ${scope}`);
  }
}

export const skillService = createSkillService();

// ---------------------------------------------------------------------------
// 确定性技能钩子（Task 12 Step 4）：service seam 暴露入口
// ---------------------------------------------------------------------------

// 解析 hooks 输入：context.skills 可以是 active 技能数组、带 catalog() 的 service，
// 缺省使用全局 skillService（生产路径，迁移先行）。
async function resolveHookSkills(context, projectRoot) {
  if (Array.isArray(context.skills)) return context.skills;
  if (context.skills && typeof context.skills.catalog === "function") {
    const { active } = await context.skills.catalog({ projectRoot });
    return active;
  }
  const { active } = await skillService.catalog({ projectRoot });
  return active;
}

// 保持旧 runSkillChecks(projectRoot, project, stage, context) 调用形状（章节提交使用）。
export async function runSkillChecks(projectRoot, project, stage, context = {}) {
  const skills = await resolveHookSkills(context, projectRoot);
  return runSkillChecksWithSkills(skills, stage, context);
}

// 保持旧 runPostProcessHooks(projectRoot, project, context) 调用形状。
export async function runPostProcessHooks(projectRoot, project, context = {}) {
  const skills = await resolveHookSkills(context, projectRoot);
  return runPostProcessHooksWithSkills(skills, context);
}
