// 生产代码唯一 Skills service seam（计划 Task 9，brief Step 5 verbatim；Task 11 接入迁移）。
//
// catalog/read/importSkill/removeSkill 在工作前统一调用 ensureMigrated({projectRoot})：
// 全局迁移 Promise 每进程每个 userHome 只创建一次，项目迁移 Promise 按 canonical
// projectRoot 缓存；新 catalog 只在迁移完成后运行，并且永远不读取 skill.json/yaml/yml。
// catalog 结果携带 migration_errors（迁移失败项），供 UI 展示。
//
// 生产模块只允许从这里导入；底层文件（skill-file.mjs / catalog.mjs / legacy-migration.mjs）
// 仅由本 service 与 tests/skills/ 使用。默认 root 在 service 内统一解析，测试通过
// factory 注入临时目录。Task 13 升级 importSkill（ZIP/大小校验/原子 rename），不建立
// 第二个入口。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathExists } from "../fs-utils.mjs";
import { discoverSkills } from "./catalog.mjs";
import { ensureMigrated } from "./legacy-migration.mjs";
import { readSkillFile, readSkillResource, skillError } from "./skill-file.mjs";

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
    // 最小目录导入（Task 13 升级为 importer.mjs：ZIP/大小校验/原子 rename）。
    async importSkill({ projectRoot, sourceDir, scope = "project", replace = false }) {
      await ensureMigrated({ projectRoot, userHome });
      assertValidScope(scope);
      const sourceSkill = await readSkillFile(sourceDir, { source: "import" });
      const targetDir = path.join(skillRootFor({ projectRoot, scope, userHome }), sourceSkill.name);
      if (await pathExists(targetDir)) {
        if (!replace) throw skillError("skill_exists", `技能已存在: ${sourceSkill.name}`);
        await fs.rm(targetDir, { recursive: true, force: true });
      }
      await fs.mkdir(targetDir, { recursive: true });
      const files = [["SKILL.md", "SKILL.md"], ...sourceSkill.resources.map((resource) => [resource.rel, resource.rel])];
      for (const [rel, destRel] of files) {
        const dest = path.join(targetDir, destRel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(path.join(sourceDir, rel), dest);
      }
      return readSkillFile(targetDir, { source: scope });
    },
    // 删除指定 scope 下的技能目录（name 校验防路径穿越）。
    async removeSkill({ projectRoot, name, scope = "project" }) {
      await ensureMigrated({ projectRoot, userHome });
      assertValidScope(scope);
      assertSafeSkillName(name);
      const targetDir = path.join(skillRootFor({ projectRoot, scope, userHome }), name);
      if (!(await pathExists(targetDir))) throw skillError("skill_not_found", `未发现技能: ${name}`);
      await fs.rm(targetDir, { recursive: true, force: true });
      return { name, scope, removed: true };
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

// 与旧 runtime isSafeSkillName 一致；拒绝 "." / ".." 防穿越。
function assertSafeSkillName(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/u.test(name) || name === "." || name === "..") {
    throw skillError("skill_invalid_name", `非法技能名: ${name}`);
  }
}

export const skillService = createSkillService();
