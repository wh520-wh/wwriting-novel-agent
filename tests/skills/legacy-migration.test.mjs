// 旧 manifest（skill.json/yaml/yml）一次性迁移到 SKILL.md 的单测（计划 Task 11）。
//
// 覆盖：global/project 的 JSON、YAML、已存在 SKILL.md、同名多 manifest、
// 迁移中断后重跑、迁移重复运行不改写已验证的 SKILL.md、ensureMigrated 缓存
// （全局每 userHome 一次、项目按 canonical projectRoot 缓存）、catalog/read
// 在迁移完成后运行、importSkill/removeSkill 迁移后工作。
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
  ensureMigrated,
  migrateLegacySkills
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

// 在 <root>/skills/<name>/ 下写入既有 SKILL.md（内容逐字保留）。
function writeExistingSkillMd(skillRoot, name, body = "原有正文") {
  const dir = path.join(skillRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: 手写描述\n---\n\n# ${name}\n\n${body}\n`,
    "utf8"
  );
  return dir;
}

function backupRootFor(userHome) {
  return path.join(userHome, ".wwriting", "migrations", "skills-v2-backup");
}

function readMarker(userHome, scope) {
  return JSON.parse(fs.readFileSync(path.join(backupRootFor(userHome), scope, "migration-marker.json"), "utf8"));
}

test("全局 scope 的 JSON manifest 迁移为 SKILL.md，旧文件入 backup，marker 完整", async (t) => {
  const userHome = makeTemp();
  const skillRoot = path.join(userHome, ".wwriting", "skills");
  writeLegacyManifest(skillRoot, LEGACY_MANIFEST.name, LEGACY_MANIFEST, "json");
  t.after(() => rmSync(userHome, { recursive: true, force: true }));

  const result = await migrateLegacySkills({ userHome, clock: FIXED_CLOCK });

  const skillDir = path.join(skillRoot, LEGACY_MANIFEST.name);
  assert.deepEqual(result.migrated, [
    { scope: "global", name: "suspense-chapter-end", manifest: "skill.json", status: "migrated" }
  ]);
  assert.deepEqual(result.failed, []);
  // live 目录只剩 SKILL.md；旧 manifest 移入 backup/<scope>/<name>/。
  assert.deepEqual(fs.readdirSync(skillDir), ["SKILL.md"], "live 技能目录只剩 SKILL.md");
  assert.equal(
    fs.existsSync(path.join(backupRootFor(userHome), "global", LEGACY_MANIFEST.name, "skill.json")),
    true,
    "旧 manifest 应移入 skills-v2-backup/global/<name>/"
  );

  // 迁移产物通过 readSkillFile 验证。
  const skill = await readSkillFile(skillDir, { source: "global" });
  assert.equal(skill.name, "suspense-chapter-end");
  assert.equal(skill.description, LEGACY_MANIFEST.description);
  assert.equal(skill.version, "1.0.0");
  assert.ok(skill.body.startsWith("# Suspense Chapter End"), "正文应以标题开头");

  // 旧字段映射：scope/priority/type/hooks → metadata.wwriting；hooks 只保留结构字段。
  const wwriting = skill.metadata.wwriting;
  assert.equal(wwriting.scope, "chapter");
  assert.equal(wwriting.priority, 50);
  assert.equal(wwriting.type, "flow-control");
  assert.deepEqual(
    wwriting.hooks.map((h) => ({ stage: h.stage, action: h.action, check: h.check })),
    [
      { stage: "planning", action: "append_prompt", check: undefined },
      { stage: "reviewing", action: "check", check: "suspense-ending" }
    ],
    "hooks 结构等价且不携带 content/prompt"
  );
  assert.ok(wwriting.hooks.every((h) => !("content" in h) && !("prompt" in h)), "metadata hooks 不得保留正文内容");

  // append_prompt.content → 正文 Instructions；check.prompt → Review checklist 且保留 checker id。
  const body = skill.body;
  assert.ok(body.includes("## Instructions"), "正文应含 Instructions 小节");
  assert.ok(body.includes("本章计划必须包含一个结尾悬念钩子。"), "Instructions 应包含 append_prompt.content");
  assert.ok(body.includes("## Review checklist"), "正文应含 Review checklist 小节");
  assert.ok(body.includes("**suspense-ending**"), "Review checklist 应保留 hook checker id");
  assert.ok(body.includes("Check whether the final 500 visible characters"), "Review checklist 应包含 check.prompt");

  // marker 字段。
  const marker = readMarker(userHome, "global");
  assert.equal(marker.schema_version, 2);
  assert.equal(marker.completed_at, "2026-08-07T00:00:00.000Z");
  assert.equal(marker.scope, "global");
  assert.deepEqual(marker.migrated, result.migrated);
  assert.deepEqual(marker.failed, []);
});

test("项目 scope 的 YAML manifest（块标量）迁移并保留多行内容", async (t) => {
  const projectRoot = makeTemp();
  const userHome = makeTemp();
  const skillRoot = path.join(projectRoot, "skills");
  const dir = path.join(skillRoot, "chapter-opening-hook");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "skill.yaml"), LEGACY_MANIFEST_YAML, "utf8");
  t.after(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
  });

  const result = await migrateLegacySkills({ projectRoot, userHome, clock: FIXED_CLOCK });

  assert.deepEqual(result.migrated, [
    { scope: "project", name: "chapter-opening-hook", manifest: "skill.yaml", status: "migrated" }
  ]);
  assert.deepEqual(result.failed, []);
  assert.equal(fs.existsSync(path.join(backupRootFor(userHome), "project", "chapter-opening-hook", "skill.yaml")), true);

  const skill = await readSkillFile(dir, { source: "project" });
  assert.equal(skill.metadata.wwriting.priority, 40);
  // `|` 块标量的多行 content 完整进入 Instructions。
  assert.ok(skill.body.includes("本章开头前两句话必须进入一个正在发生的事件"), "YAML 块标量 content 应完整保留");
  assert.ok(skill.body.includes("禁止以天气、环境描写或背景说明开场。"), "YAML content 第二行应保留");
  assert.ok(skill.body.includes("检查正文开头约 150 个可见字符"), "YAML check.prompt 应进入 Review checklist");
});

test("已存在合法 SKILL.md 时迁移绝不改写，只把旧 manifest 移入 backup", async (t) => {
  const userHome = makeTemp();
  const skillRoot = path.join(userHome, ".wwriting", "skills");
  const dir = writeExistingSkillMd(skillRoot, "handmade", "手写正文，逐字保留");
  fs.writeFileSync(path.join(dir, "skill.json"), `${JSON.stringify({ ...LEGACY_MANIFEST, name: "handmade", description: "旧 manifest 描述" }, null, 2)}\n`, "utf8");
  const before = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
  t.after(() => rmSync(userHome, { recursive: true, force: true }));

  const result = await migrateLegacySkills({ userHome, clock: FIXED_CLOCK });

  assert.deepEqual(result.migrated, [
    { scope: "global", name: "handmade", manifest: "skill.json", status: "existing" }
  ]);
  assert.deepEqual(result.failed, []);
  assert.equal(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"), before, "已存在的 SKILL.md 必须逐字不变");
  assert.deepEqual(fs.readdirSync(dir), ["SKILL.md"], "live 目录只剩 SKILL.md");
  assert.equal(fs.existsSync(path.join(backupRootFor(userHome), "global", "handmade", "skill.json")), true);
});

test("同名多 manifest（skill.json + skill.yaml）按 json 优先迁移，全部文件入 backup", async (t) => {
  const userHome = makeTemp();
  const skillRoot = path.join(userHome, ".wwriting", "skills");
  const dir = writeLegacyManifest(skillRoot, "multi", { ...LEGACY_MANIFEST, name: "multi", description: "json 版本" }, "json");
  fs.writeFileSync(path.join(dir, "skill.yaml"), LEGACY_MANIFEST_YAML, "utf8");
  t.after(() => rmSync(userHome, { recursive: true, force: true }));

  const result = await migrateLegacySkills({ userHome, clock: FIXED_CLOCK });

  assert.deepEqual(result.migrated, [
    { scope: "global", name: "multi", manifest: "skill.json", status: "migrated" }
  ]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(fs.readdirSync(dir), ["SKILL.md"], "live 目录只剩 SKILL.md");
  const backupDir = path.join(backupRootFor(userHome), "global", "multi");
  assert.equal(fs.existsSync(path.join(backupDir, "skill.json")), true, "skill.json 应入 backup");
  assert.equal(fs.existsSync(path.join(backupDir, "skill.yaml")), true, "skill.yaml 应入 backup");

  // 以 json 为主（描述来自 json 版本）。
  const skill = await readSkillFile(dir, { source: "global" });
  assert.equal(skill.description, "json 版本");
  assert.deepEqual(result.migrated.length, 1, "同名多 manifest 只迁移一次");
});

test("迁移中断后重跑：单个技能失败不阻止其他技能，源文件不删除", async (t) => {
  const userHome = makeTemp();
  const skillRoot = path.join(userHome, ".wwriting", "skills");
  // 好技能：正常迁移。
  writeLegacyManifest(skillRoot, "good", { ...LEGACY_MANIFEST, name: "good", description: "好技能" }, "json");
  // 坏技能：非法 JSON → 解析失败，live 文件保留。
  const badDir = path.join(skillRoot, "bad-json");
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, "skill.json"), "{ 这不是 JSON", "utf8");
  // 名字不匹配技能：manifest.name 与目录名不同 → 拒绝迁移。
  const mismatchDir = path.join(skillRoot, "zz-name-mismatch");
  fs.mkdirSync(mismatchDir, { recursive: true });
  fs.writeFileSync(
    path.join(mismatchDir, "skill.json"),
    `${JSON.stringify({ ...LEGACY_MANIFEST, name: "other-name" }, null, 2)}\n`,
    "utf8"
  );
  t.after(() => rmSync(userHome, { recursive: true, force: true }));

  const first = await migrateLegacySkills({ userHome, clock: FIXED_CLOCK });

  assert.deepEqual(first.migrated, [{ scope: "global", name: "good", manifest: "skill.json", status: "migrated" }]);
  assert.equal(first.failed.length, 2, "两个坏技能进入 failed 且不阻塞 good");
  assert.deepEqual(first.failed.map((f) => f.name).sort(), ["bad-json", "zz-name-mismatch"]);
  for (const failure of first.failed) {
    assert.equal(typeof failure.error, "string");
    assert.ok(failure.error.length > 0, "失败项必须带可展示的错误信息");
  }
  // 失败技能：live 源文件完整保留，不生成 SKILL.md。
  assert.equal(fs.existsSync(path.join(badDir, "skill.json")), true);
  assert.equal(fs.existsSync(path.join(badDir, "SKILL.md")), false);
  assert.equal(fs.existsSync(path.join(mismatchDir, "skill.json")), true);
  assert.equal(fs.existsSync(path.join(mismatchDir, "SKILL.md")), false);
  // marker 记录失败项。
  const marker = readMarker(userHome, "global");
  assert.equal(marker.failed.length, 2);

  // 中断后重跑：修复 bad-json 后重跑，bad-json 被迁移，good 不被改写，name-mismatch 仍失败。
  fs.writeFileSync(
    path.join(badDir, "skill.json"),
    `${JSON.stringify({ ...LEGACY_MANIFEST, name: "bad-json", description: "已修复" }, null, 2)}\n`,
    "utf8"
  );
  const goodSkillMdBefore = fs.readFileSync(path.join(skillRoot, "good", "SKILL.md"), "utf8");
  const second = await migrateLegacySkills({ userHome, clock: FIXED_CLOCK });

  assert.deepEqual(
    second.migrated.map((m) => m.name).sort(),
    ["bad-json"],
    "重跑只迁移新出现/遗留的 manifest"
  );
  assert.deepEqual(second.failed.map((f) => f.name), ["zz-name-mismatch"]);
  assert.equal(fs.readFileSync(path.join(skillRoot, "good", "SKILL.md"), "utf8"), goodSkillMdBefore, "重跑不得改写已验证 SKILL.md");
  assert.equal(fs.existsSync(path.join(badDir, "SKILL.md")), true, "重跑后 bad-json 迁移成功");
  assert.equal(fs.existsSync(path.join(badDir, "skill.json")), false, "bad-json 旧 manifest 已移走");
  // marker 更新为最新一次迁移结果。
  const marker2 = readMarker(userHome, "global");
  assert.equal(marker2.migrated.length, 1);
  assert.equal(marker2.failed.length, 1);
});

test("迁移重复运行不改写已验证的 SKILL.md，且无 manifest 时完全无操作", async (t) => {
  const projectRoot = makeTemp();
  const userHome = makeTemp();
  const skillRoot = path.join(projectRoot, "skills");
  writeLegacyManifest(skillRoot, "stable", { ...LEGACY_MANIFEST, name: "stable", description: "稳定技能" }, "json");
  t.after(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
  });

  const first = await migrateLegacySkills({ projectRoot, userHome, clock: FIXED_CLOCK });
  const skillMd = fs.readFileSync(path.join(skillRoot, "stable", "SKILL.md"), "utf8");
  const marker = readMarker(userHome, "project");
  const markerRaw = fs.readFileSync(path.join(backupRootFor(userHome), "project", "migration-marker.json"), "utf8");
  const backupListing = listAllFiles(path.join(backupRootFor(userHome), "project"));

  const second = await migrateLegacySkills({ projectRoot, userHome, clock: FIXED_CLOCK });

  assert.deepEqual(second.migrated, [], "重复运行不再迁移任何技能");
  assert.deepEqual(second.failed, []);
  assert.equal(fs.readFileSync(path.join(skillRoot, "stable", "SKILL.md"), "utf8"), skillMd, "SKILL.md 逐字不变");
  assert.equal(fs.readFileSync(path.join(backupRootFor(userHome), "project", "migration-marker.json"), "utf8"), markerRaw, "marker 不重写");
  assert.deepEqual(listAllFiles(path.join(backupRootFor(userHome), "project")), backupListing, "backup 目录不变");
  assert.equal(marker.schema_version, 2);
});

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
  const imported = await service.importSkill({ projectRoot, sourceDir, scope: "project" });

  assert.equal(imported.name, "imported-skill");
  assert.equal(fs.readdirSync(path.join(projectRoot, "skills", "imported-skill")).sort().join(","), "SKILL.md,references", "SKILL.md 与资源一并导入");
  assert.equal(fs.existsSync(path.join(projectRoot, "skills", "imported-skill", "references", "guide.md")), true);
  // import 前 ensureMigrated 已把 pre-existing 的旧 manifest 迁移走。
  assert.equal(fs.existsSync(path.join(projectRoot, "skills", "pre-existing", "skill.json")), false, "import 前旧 manifest 已迁移");

  // 重名默认拒绝（Task 13 的 409 语义）。
  await assert.rejects(
    service.importSkill({ projectRoot, sourceDir, scope: "project" }),
    (error) => error.code === "skill_exists"
  );
  // replace: true 覆盖。
  await service.importSkill({ projectRoot, sourceDir, scope: "project", replace: true });
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
    service.importSkill({ projectRoot, sourceDir, scope: "elsewhere" }),
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
  await service.importSkill({ projectRoot, sourceDir, scope: "global" });
  const globalDir = path.join(userHome, ".wwriting", "skills", "global-imported");
  assert.equal(fs.existsSync(path.join(globalDir, "SKILL.md")), true, "全局导入写入 userHome 技能根");
  assert.equal(fs.existsSync(path.join(projectRoot, "skills", "global-imported")), false);

  await service.removeSkill({ projectRoot, name: "global-imported", scope: "global" });
  assert.equal(fs.existsSync(globalDir), false);
});

function listAllFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(dir, full).replace(/\\/gu, "/"));
    }
  };
  walk(dir);
  return out.sort();
}
