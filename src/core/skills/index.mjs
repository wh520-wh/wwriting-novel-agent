// 生产代码唯一 Skills service seam（计划 Task 9，brief Step 5 verbatim）。
//
// 生产模块只允许从这里导入；底层文件（skill-file.mjs / catalog.mjs）仅由本
// service 与 tests/skills/ 使用。默认 root 在 service 内统一解析，测试通过
// factory 注入临时目录。Task 13 再向同一 service 增加 import/remove，不建立
// 第二个入口。
import os from "node:os";
import path from "node:path";
import { discoverSkills } from "./catalog.mjs";
import { readSkillResource, skillError } from "./skill-file.mjs";

// 内置技能根目录 src/skills（Task 10 落地五个内置 SKILL.md；当前允许缺失）。
const DEFAULT_BUILTIN_ROOT = path.resolve(import.meta.dirname, "..", "..", "skills");

export function createSkillService({ userHome = os.homedir(), resourcesPath = process.resourcesPath, builtinRoot = DEFAULT_BUILTIN_ROOT } = {}) {
  const catalog = ({ projectRoot }) =>
    discoverSkills({ projectRoot, userHome, resourcesPath, builtinRoot });
  return {
    catalog,
    async read({ projectRoot, name, resource = "SKILL.md" }) {
      const discovered = await catalog({ projectRoot });
      const skill = discovered.active.find((item) => item.name === name);
      if (!skill) throw skillError("skill_not_found", `未发现技能: ${name}`);
      return readSkillResource(skill, resource);
    }
  };
}

export const skillService = createSkillService();
