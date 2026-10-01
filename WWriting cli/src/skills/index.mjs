// 技能分区唯一 service seam（对齐上游 core/skills/index；ADR-0013/0014）。
//
// CLI 无 legacy 迁移与导入面：上游的 ensureMigrated/importSkill/removeSkill
// 不移植，装删靠用户直接操作技能目录（~/.wwriting/skills 或 <项目根>/skills）。
// v1 只做 catalog()；read() 在票据 02 接入。
// 默认内置根就是本目录：代码文件与 12 个内置包同住 src/skills，发现扫描只认
// 含 SKILL.md 的子目录，代码文件不参与。
import os from 'node:os';
import path from 'node:path';
import { discoverSkills } from './catalog.mjs';

const DEFAULT_BUILTIN_ROOT = path.resolve(import.meta.dirname);

export function createSkillService({ userHome = os.homedir(), builtinRoot = DEFAULT_BUILTIN_ROOT } = {}) {
  return {
    async catalog({ projectRoot }) {
      return discoverSkills({ projectRoot, userHome, builtinRoot });
    },
  };
}

export const skillService = createSkillService();
