// 技能分区唯一 service seam（对齐上游 core/skills/index；ADR-0013/0014）。
//
// CLI 无 legacy 迁移与导入面：上游的 ensureMigrated/importSkill/removeSkill
// 不移植，装删靠用户直接操作技能目录（~/.wwriting/skills 或 <项目根>/skills）。
// 默认内置根就是本目录：代码文件与 12 个内置包同住 src/skills，发现扫描只认
// 含 SKILL.md 的子目录，代码文件不参与。
import os from 'node:os';
import path from 'node:path';
import { discoverSkills } from './catalog.mjs';
import { readSkillResource, skillError } from './skill-file.mjs';

const DEFAULT_BUILTIN_ROOT = path.resolve(import.meta.dirname);

export function createSkillService({ userHome = os.homedir(), builtinRoot = DEFAULT_BUILTIN_ROOT } = {}) {
  return {
    async catalog({ projectRoot }) {
      return discoverSkills({ projectRoot, userHome, builtinRoot });
    },
    // 只按 active catalog 的名字解析；shadowed 副本不可读。
    // realpath containment、大小上限与二进制判定都在 readSkillResource 内执行。
    async read({ projectRoot, name, resource = 'SKILL.md' }) {
      const discovered = await discoverSkills({ projectRoot, userHome, builtinRoot });
      const skill = discovered.active.find((item) => item.name === name);
      if (!skill) throw skillError('skill_not_found', `未发现技能: ${name}`);
      return readSkillResource(skill, resource);
    },
  };
}

export const skillService = createSkillService();
