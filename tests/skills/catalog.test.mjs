// 四级技能 catalog 单测（计划 Task 9）。
// 四层同名时 active 一定来自 project（项目 > 全局 > 随应用分发 > 内置）；
// 只扫描每个 root 的直接子目录；同 root 重复 name 拒绝；默认 root 在 service 内解析。
import assert from "node:assert/strict";
import fs from "node:fs";
import { realpath as realpathAsync } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  discoverSkills,
  SKILL_SOURCE_PRIORITY
} from "../../src/core/skills/catalog.mjs";
import { createSkillService } from "../../src/core/skills/index.mjs";

function makeTemp(prefix = "wwr-catalog-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function makeSkill(skillRoot, name, { description = `desc-${name}`, body = `# ${name}\n\nbody` } = {}) {
  const dir = path.join(skillRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
    "utf8"
  );
  return dir;
}

test("SKILL_SOURCE_PRIORITY 冻结且四级优先级固定", () => {
  assert.ok(Object.isFrozen(SKILL_SOURCE_PRIORITY));
  assert.deepEqual(SKILL_SOURCE_PRIORITY, {
    builtin: 0,
    bundled: 1,
    global: 2,
    project: 3
  });
});

test("四层同名时 active 一定来自 project，其余三层进入 shadowed", async (t) => {
  const projectRoot = makeTemp();
  const userHome = makeTemp();
  const resourcesPath = makeTemp();
  const builtinRoot = makeTemp();

  makeSkill(builtinRoot, "alpha", { description: "builtin alpha", body: "# Builtin Alpha" });
  fs.mkdirSync(path.join(resourcesPath, "skills"), { recursive: true });
  makeSkill(path.join(resourcesPath, "skills"), "alpha", { description: "bundled alpha", body: "# Bundled Alpha" });
  fs.mkdirSync(path.join(userHome, ".wwriting", "skills"), { recursive: true });
  makeSkill(path.join(userHome, ".wwriting", "skills"), "alpha", { description: "global alpha", body: "# Global Alpha" });
  fs.mkdirSync(path.join(projectRoot, "skills"), { recursive: true });
  makeSkill(path.join(projectRoot, "skills"), "alpha", { description: "project alpha", body: "# Project Alpha" });

  t.after(() => {
    for (const dir of [projectRoot, userHome, resourcesPath, builtinRoot]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const service = createSkillService({ userHome, resourcesPath, builtinRoot });
  const { active, shadowed } = await service.catalog({ projectRoot });

  assert.equal(active.length, 1, `期望恰好 1 个 active，得到 ${JSON.stringify(active.map((s) => s.source))}`);
  assert.equal(active[0].name, "alpha");
  assert.equal(active[0].source, "project");
  assert.equal(active[0].description, "project alpha");
  assert.equal(active[0].body.trim(), "# Project Alpha", "active 携带 project 层完整技能对象");

  assert.equal(shadowed.length, 3, "其余三层全部 shadowed");
  assert.deepEqual(
    shadowed.map((s) => s.source),
    ["builtin", "bundled", "global"],
    "shadowed 按优先级升序"
  );
  assert.ok(!shadowed.some((s) => s.source === "project"), "project 层绝不 shadowed");
});

test("两层同名（builtin + project）时 project 覆盖 builtin；仅 builtin 时 active 来自 builtin", async (t) => {
  const projectRoot = makeTemp();
  const builtinRoot = makeTemp();

  makeSkill(builtinRoot, "beta", { body: "# Builtin Beta" });
  fs.mkdirSync(path.join(projectRoot, "skills"), { recursive: true });
  makeSkill(path.join(projectRoot, "skills"), "beta", { body: "# Project Beta" });

  t.after(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(builtinRoot, { recursive: true, force: true });
  });

  const service = createSkillService({ userHome: makeTemp(), resourcesPath: makeTemp(), builtinRoot });
  const merged = await service.catalog({ projectRoot });
  assert.equal(merged.active.length, 1);
  assert.equal(merged.active[0].source, "project");
  assert.equal(merged.active[0].body.trim(), "# Project Beta");
  assert.deepEqual(merged.shadowed.map((s) => s.source), ["builtin"]);

  // 只扫描 builtin 层（projectRoot 的 skills 目录不存在 → 跳过）。
  const emptyProject = makeTemp();
  t.after(() => rmSync(emptyProject, { recursive: true, force: true }));
  const onlyBuiltin = await service.catalog({ projectRoot: emptyProject });
  assert.equal(onlyBuiltin.active.length, 1);
  assert.equal(onlyBuiltin.active[0].source, "builtin");
  assert.equal(onlyBuiltin.active[0].body.trim(), "# Builtin Beta");
});

test("每个 root 只扫描直接子目录中的 SKILL.md", async (t) => {
  const projectRoot = makeTemp();
  fs.mkdirSync(path.join(projectRoot, "skills"), { recursive: true });
  makeSkill(path.join(projectRoot, "skills"), "direct", { body: "# Direct" });
  // 直接子目录 nested 没有 SKILL.md（只放 README），其下一层的 inner 有 SKILL.md 也不得被发现。
  fs.mkdirSync(path.join(projectRoot, "skills", "nested", "inner"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, "skills", "nested", "inner", "SKILL.md"),
    "---\nname: inner\ndescription: nested skill\n---\n\n# Inner\n",
    "utf8"
  );
  // 直接子层是文件而不是目录 → 跳过。
  fs.writeFileSync(path.join(projectRoot, "skills", "note.txt"), "not a dir", "utf8");

  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));

  const service = createSkillService({ userHome: makeTemp(), resourcesPath: makeTemp(), builtinRoot: makeTemp() });
  const { active } = await service.catalog({ projectRoot });
  assert.deepEqual(
    active.map((s) => s.name).sort(),
    ["direct"],
    `只应发现直接子目录中的 direct，得到 ${JSON.stringify(active.map((s) => s.name))}`
  );
});

test("目录中无 SKILL.md 的目录被静默跳过", async (t) => {
  const projectRoot = makeTemp();
  fs.mkdirSync(path.join(projectRoot, "skills", "junk"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "skills", "junk", "README.md"), "no skill here", "utf8");

  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));

  const service = createSkillService({ userHome: makeTemp(), resourcesPath: makeTemp(), builtinRoot: makeTemp() });
  const { active, shadowed } = await service.catalog({ projectRoot });
  assert.deepEqual(active, []);
  assert.deepEqual(shadowed, []);
});

test("service.read 返回 active（project 层）SKILL.md 完整正文", async (t) => {
  const projectRoot = makeTemp();
  const builtinRoot = makeTemp();
  makeSkill(builtinRoot, "gamma", { body: "# Builtin Gamma" });
  fs.mkdirSync(path.join(projectRoot, "skills"), { recursive: true });
  makeSkill(path.join(projectRoot, "skills"), "gamma", { body: "# Project Gamma" });
  t.after(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(builtinRoot, { recursive: true, force: true });
  });

  const service = createSkillService({ userHome: makeTemp(), resourcesPath: makeTemp(), builtinRoot });
  const result = await service.read({ projectRoot, name: "gamma" });
  assert.equal(result.resource, "SKILL.md");
  assert.equal(result.content, "---\nname: gamma\ndescription: desc-gamma\n---\n\n# Project Gamma\n");
  assert.ok(result.content.includes("# Project Gamma"), "read 读的是 active project 层正文");
});

test("service.read 按 active catalog 读取命名资源", async (t) => {
  const projectRoot = makeTemp();
  fs.mkdirSync(path.join(projectRoot, "skills", "delta", "references"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, "skills", "delta", "SKILL.md"),
    "---\nname: delta\ndescription: desc\n---\n\n# Delta\n",
    "utf8"
  );
  fs.writeFileSync(path.join(projectRoot, "skills", "delta", "references", "guide.md"), "# 指南\n", "utf8");
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));

  const service = createSkillService({ userHome: makeTemp(), resourcesPath: makeTemp(), builtinRoot: makeTemp() });
  const result = await service.read({ projectRoot, name: "delta", resource: "references/guide.md" });
  assert.equal(result.content, "# 指南\n");
  assert.equal(result.path, await realpathAsync(path.join(projectRoot, "skills", "delta", "references", "guide.md")));
});

test("service.read 未发现技能时抛出 skill_not_found", async (t) => {
  const projectRoot = makeTemp();
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));

  const service = createSkillService({ userHome: makeTemp(), resourcesPath: makeTemp(), builtinRoot: makeTemp() });
  await assert.rejects(
    service.read({ projectRoot, name: "nope" }),
    (error) => {
      assert.equal(error.name, "SkillError");
      assert.equal(error.code, "skill_not_found");
      assert.ok(error.message.includes("nope"));
      return true;
    }
  );
});

test("service.read 拒绝穿越技能目录的资源路径", async (t) => {
  const projectRoot = makeTemp();
  fs.mkdirSync(path.join(projectRoot, "skills", "epsilon"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, "skills", "epsilon", "SKILL.md"),
    "---\nname: epsilon\ndescription: desc\n---\n\n# Epsilon\n",
    "utf8"
  );
  fs.writeFileSync(path.join(projectRoot, "secret.txt"), "x", "utf8");
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));

  const service = createSkillService({ userHome: makeTemp(), resourcesPath: makeTemp(), builtinRoot: makeTemp() });
  await assert.rejects(
    service.read({ projectRoot, name: "epsilon", resource: "../../secret.txt" }),
    (error) => error.code === "skill_resource_unsafe"
  );
});

test("默认 root 在 service 内统一解析，测试通过 factory 注入临时目录", async (t) => {
  // createSkillService() 无参：userHome 默认 os.homedir()、resourcesPath 默认
  // process.resourcesPath（node 下 undefined）、builtinRoot 默认 src/skills。
  // 用唯一技能名避免与真实用户目录中任何同名技能冲突。
  const projectRoot = makeTemp();
  const unique = `zz-task9-default-root-${process.pid}`;
  fs.mkdirSync(path.join(projectRoot, "skills"), { recursive: true });
  makeSkill(path.join(projectRoot, "skills"), unique, { body: "# From Default Service" });
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));

  const service = createSkillService();
  const { active } = await service.catalog({ projectRoot });
  const found = active.find((s) => s.name === unique);
  assert.ok(found, `默认 service 应发现注入 projectRoot 下的技能，得到 ${JSON.stringify(active.map((s) => s.name))}`);
  assert.equal(found.source, "project");
});

test("所有 root 缺失时返回空 catalog", async (t) => {
  const projectRoot = makeTemp();
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));

  // 注入的四个 root 都是不存在的路径（或空目录）。
  const service = createSkillService({
    userHome: path.join(projectRoot, "no-user-home"),
    resourcesPath: path.join(projectRoot, "no-resources"),
    builtinRoot: path.join(projectRoot, "no-builtin")
  });
  const { active, shadowed } = await service.catalog({ projectRoot });
  assert.deepEqual(active, []);
  assert.deepEqual(shadowed, []);
});

test("discoverSkills 直接调用与 service.catalog 行为一致", async (t) => {
  const projectRoot = makeTemp();
  fs.mkdirSync(path.join(projectRoot, "skills"), { recursive: true });
  makeSkill(path.join(projectRoot, "skills"), "zeta", { body: "# Zeta" });
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));

  const discovered = await discoverSkills({
    projectRoot,
    userHome: makeTemp(),
    resourcesPath: makeTemp(),
    builtinRoot: makeTemp()
  });
  assert.equal(discovered.active.length, 1);
  assert.equal(discovered.active[0].name, "zeta");
  assert.equal(discovered.active[0].source, "project");
  assert.deepEqual(discovered.shadowed, []);
  assert.ok(Object.isFrozen(discovered));
  assert.ok(Object.isFrozen(discovered.active));
  assert.ok(Object.isFrozen(discovered.shadowed));
});
