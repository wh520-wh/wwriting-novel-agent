// 旧 manifest（skill.json/yaml/yml）一次性迁移到 SKILL.md 的单测（计划 Task 11）。
//
// 覆盖：ensureMigrated 缓存（全局每 userHome 一次、项目按 canonical projectRoot
// 缓存）、catalog/read 在迁移完成后运行、importSkill/removeSkill 迁移后工作。
//
// 迁移后 live skill 目录只剩 SKILL.md 和资源；旧 manifest 移入
// <userHome>/.wwriting/migrations/skills-v2-backup/<scope>/<name>/。
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ensureMigrated
} from "../../src/core/skills/legacy-migration.mjs";
import { createSkillService } from "../../src/core/skills/index.mjs";
import { readSkillFile } from "../../src/core/skills/skill-file.mjs";

const FIXED_CLOCK = () => new Date("2026-08-07T00:00:00Z");

// 与旧 runtime BUILTIN_SKILLS / ensureBuiltinSkill 写入的 skill.json 结构一致。
const LEGACY_MANIFEST = {
  name: "suspense-chapter-end",
  version: "1.0.0",
  type: "flow-control",
  enabled: true,
  priority: 50,
  scope: "chapter",
  description: "每章结尾都要留下悬念钩子：震惊性话语、推翻认知的新事实或突然逼近的危险。",
  hooks: [
    {
      stage: "planning",
      action: "append_prompt",
      content: [
        "本章计划必须包含一个结尾悬念钩子。",
        "优先使用以下类型：一句令人震惊的话、一个推翻此前认知的新事实、或一个突然逼近的危险。"
      ].join("\n")
    },
    {
      stage: "reviewing",
      action: "check",
      check: "suspense-ending",
      prompt: "Check whether the final 500 visible characters contain a meaningful suspense hook."
    }
  ]
};

// 旧 runtime parseSkillManifest 支持的 YAML 格式（hooks 块 + `|` 块标量）。
const LEGACY_MANIFEST_YAML = `name: chapter-opening-hook
version: "1.0.0"
type: flow-control
enabled: true
priority: 40
scope: chapter
description: 每章开头必须用正在发生的事抓人。
hooks:
  - stage: planning
    action: append_prompt
    content: |
      本章开头前两句话必须进入一个正在发生的事件（人物行动、冲突、悬念或意外）。
      禁止以天气、环境描写或背景说明开场。
  - stage: reviewing
    action: check
    check: chapter-opening
    prompt: |
      检查正文开头约 150 个可见字符内是否有一个正在发生的动作、冲突或悬念。
`;

function makeTemp(prefix = "wwr-legacy-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

// 在 <root>/skills/<name>/ 下写入旧 manifest 文件，返回技能目录绝对路径。
function writeLegacyManifest(skillRoot, name, manifest, ext = "json") {
  const dir = path.join(skillRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  const content = ext === "json"
    ? `${JSON.stringify(manifest, null, 2)}\n`
    : LEGACY_MANIFEST_YAML;
  fs.writeFileSync(path.join(dir, `skill.${ext}`), content, "utf8");
  return dir;
}

test("ensureMigrated：全局迁移每 userHome 一次、项目迁移按 canonical projectRoot 缓存", async (t) => {
  const userHome = makeTemp();
  const projectRoot = makeTemp();
  const projectRoot2 = makeTemp();
  const skillRoot = path.join(userHome, ".wwriting", "skills");
  writeLegacyManifest(skillRoot, "global-a", { ...LEGACY_MANIFEST, name: "global-a" }, "json");
  writeLegacyManifest(path.join(projectRoot, "skills"), "proj-a", { ...LEGACY_MANIFEST, name: "proj-a" }, "json");
  writeLegacyManifest(path.join(projectRoot2, "skills"), "proj-b", { ...LEGACY_MANIFEST, name: "proj-b" }, "json");
  t.after(() => {
    rmSync(userHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(projectRoot2, { recursive: true, force: true });
  });

  let clockCalls = 0;
  const clock = () => {
    clockCalls += 1;
    return new Date();
  };

  const first = await ensureMigrated({ projectRoot, userHome, clock });
  assert.equal(clockCalls, 2, "首次调用：全局 + 项目各写一次 marker");
  assert.equal(first.migrated.length, 2);

  const second = await ensureMigrated({ projectRoot, userHome, clock });
  assert.equal(clockCalls, 2, "重复调用命中缓存，不再执行迁移");

  await ensureMigrated({ projectRoot: projectRoot2, userHome, clock });
  assert.equal(clockCalls, 3, "新 projectRoot 触发一次项目迁移，全局仍复用缓存");
  // 第二次项目迁移结果：只迁移 proj-b；global 结果来自缓存的首次运行（global-a）。
  const third = await ensureMigrated({ projectRoot: projectRoot2, userHome, clock });
  assert.deepEqual(
    third.migrated.filter((m) => m.scope === "project").map((m) => m.name),
    ["proj-b"]
  );
});

test("catalog 在迁移完成后运行，发现迁移后的技能并暴露 migration_errors", async (t) => {
  // 成功路径：迁移后 active 来自 project 层，live 目录只剩 SKILL.md。
  const projectRoot = makeTemp();
  const userHome = makeTemp();
  writeLegacyManifest(path.join(projectRoot, "skills"), "alpha", { ...LEGACY_MANIFEST, name: "alpha", description: "迁移技能" }, "json");
  t.after(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
  });

  const service = createSkillService({ userHome, resourcesPath: makeTemp(), builtinRoot: makeTemp() });
  const result = await service.catalog({ projectRoot });

  assert.deepEqual(fs.readdirSync(path.join(projectRoot, "skills", "alpha")), ["SKILL.md"], "catalog 调用后旧 manifest 已迁移");
  const skill = result.active.find((s) => s.name === "alpha");
  assert.ok(skill, "catalog 应发现迁移后的技能");
  assert.equal(skill.source, "project");
  assert.equal(skill.description, "迁移技能");
  assert.ok(result.body === undefined || Array.isArray(result.shadowed), "结果仍携带 active/shadowed");
  assert.deepEqual(result.migration_errors, []);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.migration_errors));
});

test("catalog 存在迁移失败项时照常运行，migration_errors 携带失败信息", async (t) => {
  const projectRoot = makeTemp();
  const userHome = makeTemp();
  const skillRoot = path.join(projectRoot, "skills");
  writeLegacyManifest(skillRoot, "ok-skill", { ...LEGACY_MANIFEST, name: "ok-skill" }, "json");
  const badDir = path.join(skillRoot, "broken-skill");
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, "skill.json"), "{ broken", "utf8");
  t.after(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
  });

  const service = createSkillService({ userHome, resourcesPath: makeTemp(), builtinRoot: makeTemp() });
  const result = await service.catalog({ projectRoot });

  assert.equal(result.migration_errors.length, 1, "失败项必须暴露给 UI");
  assert.equal(result.migration_errors[0].name, "broken-skill");
  assert.equal(result.migration_errors[0].scope, "project");
  assert.ok(typeof result.migration_errors[0].error === "string" && result.migration_errors[0].error.length > 0);
  assert.ok(result.active.some((s) => s.name === "ok-skill"), "好技能仍可被发现");
  assert.equal(fs.existsSync(path.join(badDir, "skill.json")), true, "失败技能的源文件保留");
});

test("read 在迁移完成后返回 SKILL.md 完整正文", async (t) => {
  const projectRoot = makeTemp();
  const userHome = makeTemp();
  writeLegacyManifest(path.join(projectRoot, "skills"), "readme-skill", { ...LEGACY_MANIFEST, name: "readme-skill", description: "待读技能" }, "json");
  t.after(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
  });

  const service = createSkillService({ userHome, resourcesPath: makeTemp(), builtinRoot: makeTemp() });
  const result = await service.read({ projectRoot, name: "readme-skill" });

  assert.equal(result.resource, "SKILL.md");
  assert.ok(result.content.startsWith("---\nname: readme-skill"), "read 返回迁移生成的 SKILL.md");
  assert.ok(result.content.includes("## Instructions"));
  assert.ok(result.content.includes("待读技能"));
});

test("importSkill/removeSkill 先完成迁移再工作，重名默认 409 语义，replace 可覆盖", async (t) => {
  const projectRoot = makeTemp();
  const userHome = makeTemp();
  // 项目里已有旧 manifest：import/remove 的 ensureMigrated 必须先把它迁移掉。
  writeLegacyManifest(path.join(projectRoot, "skills"), "pre-existing", { ...LEGACY_MANIFEST, name: "pre-existing" }, "json");
  // 导入源目录：合法 SKILL.md + references 资源（目录名必须与 name 一致）。
  const sourceRoot = makeTemp("wwr-import-src-");
  const sourceDir = path.join(sourceRoot, "imported-skill");
  fs.mkdirSync(path.join(sourceDir, "references"), { recursive: true });
  fs.writeFileSync(
    path.join(sourceDir, "SKILL.md"),
    "---\nname: imported-skill\ndescription: 从目录导入\n---\n\n# Imported Skill\n\n指令正文。\n",
    "utf8"
  );
  fs.writeFileSync(path.join(sourceDir, "references", "guide.md"), "# 指南\n", "utf8");
  t.after(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
    rmSync(sourceRoot, { recursive: true, force: true });
  });

  const service = createSkillService({ userHome, resourcesPath: makeTemp(), builtinRoot: makeTemp() });
  const imported = await service.importSkill({ projectRoot, source: sourceDir, scope: "project" });

  assert.equal(imported.name, "imported-skill");
  assert.equal(fs.readdirSync(path.join(projectRoot, "skills", "imported-skill")).sort().join(","), "SKILL.md,references", "SKILL.md 与资源一并导入");
  assert.equal(fs.existsSync(path.join(projectRoot, "skills", "imported-skill", "references", "guide.md")), true);
  // import 前 ensureMigrated 已把 pre-existing 的旧 manifest 迁移走。
  assert.equal(fs.existsSync(path.join(projectRoot, "skills", "pre-existing", "skill.json")), false, "import 前旧 manifest 已迁移");

  // 重名默认拒绝（Task 13 的 409 语义）。
  await assert.rejects(
    service.importSkill({ projectRoot, source: sourceDir, scope: "project" }),
    (error) => error.code === "skill_exists"
  );
  // replace: true 覆盖。
  await service.importSkill({ projectRoot, source: sourceDir, scope: "project", replace: true });
  assert.equal(fs.existsSync(path.join(projectRoot, "skills", "imported-skill", "SKILL.md")), true);

  // remove 删除技能目录。
  const removed = await service.removeSkill({ projectRoot, name: "imported-skill", scope: "project" });
  assert.equal(removed.name, "imported-skill");
  assert.equal(removed.removed, true);
  assert.equal(fs.existsSync(path.join(projectRoot, "skills", "imported-skill")), false);
  await assert.rejects(
    service.removeSkill({ projectRoot, name: "imported-skill", scope: "project" }),
    (error) => error.code === "skill_not_found"
  );
  // 非法 scope / 危险技能名拒绝。
  await assert.rejects(
    service.removeSkill({ projectRoot, name: "..", scope: "project" }),
    (error) => error.code === "skill_invalid_name"
  );
  await assert.rejects(
    service.importSkill({ projectRoot, source: sourceDir, scope: "elsewhere" }),
    (error) => error.code === "skill_invalid_scope"
  );
});

test("global scope 的导入与删除走 userHome 技能根", async (t) => {
  const projectRoot = makeTemp();
  const userHome = makeTemp();
  const sourceRoot = makeTemp("wwr-import-src-");
  const sourceDir = path.join(sourceRoot, "global-imported");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(
    path.join(sourceDir, "SKILL.md"),
    "---\nname: global-imported\ndescription: 全局导入\n---\n\n# Global Imported\n",
    "utf8"
  );
  t.after(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
    rmSync(sourceRoot, { recursive: true, force: true });
  });

  const service = createSkillService({ userHome, resourcesPath: makeTemp(), builtinRoot: makeTemp() });
  await service.importSkill({ projectRoot, source: sourceDir, scope: "global" });
  const globalDir = path.join(userHome, ".wwriting", "skills", "global-imported");
  assert.equal(fs.existsSync(path.join(globalDir, "SKILL.md")), true, "全局导入写入 userHome 技能根");
  assert.equal(fs.existsSync(path.join(projectRoot, "skills", "global-imported")), false);

  await service.removeSkill({ projectRoot, name: "global-imported", scope: "global" });
  assert.equal(fs.existsSync(globalDir), false);
});
