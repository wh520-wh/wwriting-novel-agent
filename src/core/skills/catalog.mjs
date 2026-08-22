// 四级技能 catalog（计划 Task 9）。
//
// 每个 root 只扫描直接子目录中的 SKILL.md；按 name 选最高优先级，返回 active
// 与 shadowed。同级目录名与 frontmatter name 一致（readSkillFile 校验），
// 因此同一 root 内不可能出现重复 name；跨 root 同名由优先级解决：
// project > global > bundled > builtin。
//
// 本模块是 src/core/skills 的底层文件：只允许被 src/core/skills/index.mjs
// （唯一 service seam）与 tests/skills/ 使用。
import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../fs-utils.mjs";
import { readSkillFile } from "./skill-file.mjs";

// 四层来源优先级（冻结契约 §2.5，verbatim）。
export const SKILL_SOURCE_PRIORITY = Object.freeze({ builtin: 0, bundled: 1, global: 2, project: 3 });

// 发现层（按优先级升序处理；后处理的层同名时覆盖前层，active 最终来自最高优先级）。
// 全局路径固定 %USERPROFILE%\.wwriting\skills\<name>\SKILL.md，
// 项目路径固定 <projectRoot>\skills\<name>\SKILL.md，随应用分发 <resourcesPath>\skills。
const ROOTS = [
  { source: "builtin", rootOf: ({ builtinRoot }) => builtinRoot },
  { source: "bundled", rootOf: ({ resourcesPath }) => (resourcesPath ? path.join(resourcesPath, "skills") : null) },
  { source: "global", rootOf: ({ userHome }) => (userHome ? path.join(userHome, ".wwriting", "skills") : null) },
  { source: "project", rootOf: ({ projectRoot }) => (projectRoot ? path.join(projectRoot, "skills") : null) }
];

export async function discoverSkills({ projectRoot, userHome, resourcesPath, builtinRoot }) {
  const active = new Map(); // name → 最高优先级副本
  const shadowed = [];      // 同名但被更高优先级覆盖的副本（优先级升序）
  const errors = [];        // 解析失败的技能目录 { dir, error }：跳过但不拖垮整层

  for (const { source, rootOf } of ROOTS) {
    const root = rootOf({ projectRoot, userHome, resourcesPath, builtinRoot });
    if (!root) continue;
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue; // root 不存在或不可读：该层没有技能
    }
    for (const entry of entries) {
      // 只扫描直接子目录（symlink 指向目录的也接受，与旧 resolveSkillSources 一致）。
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillDir = path.join(root, entry.name);
      let stat;
      try {
        stat = await fs.stat(skillDir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      // 目录中存在合法 SKILL.md 即可发现；无 SKILL.md 的目录不是技能，静默跳过。
      if (!(await pathExists(path.join(skillDir, "SKILL.md")))) continue;
      // 单个技能目录损坏/非法只跳过该目录并记入 errors，绝不让一层坏技能
      // 拖垮整个 catalog（否则 agent 静默拿到空列表、settings 500）。
      let skill;
      try {
        skill = await readSkillFile(skillDir, { source });
      } catch (error) {
        errors.push({ dir: skillDir, error: error?.message ?? String(error) });
        continue;
      }
      // 读出的条目补充 display_name（metadata.wwriting.display_name，缺省回落
      // name）与 category（metadata.wwriting.category，缺省 null）。
      const enriched = enrichSkill(skill);
      const previous = active.get(enriched.name);
      if (previous) shadowed.push(previous);
      active.set(enriched.name, enriched);
    }
  }

  return Object.freeze({
    active: Object.freeze([...active.values()]),
    shadowed: Object.freeze(shadowed),
    errors: Object.freeze(errors)
  });
}

// catalog 层给每个技能对象补充 display_name 与 category：display_name 来自
// metadata.wwriting.display_name（缺省回落 name）；category 来自
// metadata.wwriting.category（缺省 null）。
function enrichSkill(skill) {
  const wwriting = skill.metadata?.wwriting ?? null;
  return Object.freeze({
    ...skill,
    display_name: typeof wwriting?.display_name === "string" && wwriting.display_name ? wwriting.display_name : skill.name,
    category: typeof wwriting?.category === "string" ? wwriting.category : null
  });
}
