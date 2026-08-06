// 四级技能 catalog 单测（计划 Task 9 + Task 10）。
// 四层同名时 active 一定来自 project（项目 > 全局 > 随应用分发 > 内置）；
// 只扫描每个 root 的直接子目录；同 root 重复 name 拒绝；默认 root 在 service 内解析。
// Task 10：src/skills/<name>/SKILL.md 五个内置技能文件与 BUILTIN_SKILLS 内容等价，
// catalog 以 src/skills 为 builtin root 时全部来自 source: "builtin"，且不向项目写入 skill.json。
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
import { readSkillFile } from "../../src/core/skills/skill-file.mjs";
import { BUILTIN_SKILLS } from "../../src/core/skill-runtime.mjs";

// Task 10：内置技能文件化后的真实根目录（src/skills），与 service 默认 builtinRoot 一致。
const BUILTIN_ROOT = path.resolve(import.meta.dirname, "..", "..", "src", "skills");
const BUILTIN_SKILL_NAMES = Object.keys(BUILTIN_SKILLS);

// 内容快照比较：折叠空白后按子串包含比对，容忍正文的分行/段落重组。
function normalizeWhitespace(value) {
  return String(value).replace(/\s+/gu, " ").trim();
}

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

// ---------------------------------------------------------------------------
// Task 10：内置技能文件化（src/skills/<name>/SKILL.md）
// ---------------------------------------------------------------------------

test("五个内置技能文件存在，frontmatter 与 BUILTIN_SKILLS 等价且正文非空壳", async (t) => {
  assert.equal(BUILTIN_SKILL_NAMES.length, 5, "BUILTIN_SKILLS 应为五个内置技能");

  for (const name of BUILTIN_SKILL_NAMES) {
    const old = BUILTIN_SKILLS[name];
    const skill = await readSkillFile(path.join(BUILTIN_ROOT, name), { source: "builtin" });

    // name/description/version → 顶层 frontmatter，逐字等价。
    assert.equal(skill.name, old.name, `${name} frontmatter name`);
    assert.equal(skill.description, old.description, `${name} frontmatter description`);
    assert.equal(skill.version, old.version, `${name} frontmatter version`);

    // scope/priority → metadata.wwriting，逐字等价。
    const wwriting = skill.metadata.wwriting;
    assert.ok(wwriting, `${name} 必须声明 metadata.wwriting`);
    assert.equal(wwriting.scope, old.scope, `${name} metadata.wwriting.scope`);
    assert.equal(wwriting.priority, old.priority, `${name} metadata.wwriting.priority`);

    // hooks → metadata.wwriting.hooks：stage/action/check 结构等价；
    // append_prompt.content 与 check.prompt 移入正文（此处不要求重复保留）。
    const projectHook = (hook) => ({ stage: hook.stage, action: hook.action, check: hook.check });
    assert.deepEqual(
      wwriting.hooks.map(projectHook),
      old.hooks.map(projectHook),
      `${name} metadata.wwriting.hooks 应与旧 hooks 结构等价`
    );

    // 正文必须携带全部 append_prompt 指令与 check prompt（不能只是空壳 frontmatter）。
    const body = normalizeWhitespace(skill.body);
    assert.ok(skill.body.startsWith("# "), `${name} 正文应以标题开头`);
    for (const hook of old.hooks) {
      if (hook.action === "append_prompt" && hook.content) {
        assert.ok(
          body.includes(normalizeWhitespace(hook.content)),
          `${name} 正文 Instructions 应包含 append_prompt.content（stage=${hook.stage}）`
        );
      }
      if (hook.action === "check" && hook.prompt) {
        assert.ok(
          body.includes(normalizeWhitespace(hook.prompt)),
          `${name} 正文 Review checklist 应包含 check.prompt（check=${hook.check}）`
        );
        assert.ok(
          skill.body.includes(hook.check),
          `${name} 正文应保留 hook checker id ${hook.check}`
        );
      }
    }
  }
});

test("catalog 以 src/skills 为 builtin root 时五个内置技能全部来自 source: builtin", async (t) => {
  const projectRoot = makeTemp();
  const userHome = makeTemp();
  const resourcesPath = makeTemp();
  t.after(() => {
    for (const dir of [projectRoot, userHome, resourcesPath]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const service = createSkillService({ userHome, resourcesPath, builtinRoot: BUILTIN_ROOT });
  const { active, shadowed } = await service.catalog({ projectRoot });

  assert.equal(shadowed.length, 0, "无同名覆盖时不应有 shadowed");
  assert.equal(active.length, BUILTIN_SKILL_NAMES.length, `active 应恰好是五个内置技能，得到 ${active.map((s) => s.name).join(",")}`);
  const byName = new Map(active.map((skill) => [skill.name, skill]));
  for (const name of BUILTIN_SKILL_NAMES) {
    const skill = byName.get(name);
    assert.ok(skill, `catalog 应发现内置技能 ${name}`);
    assert.equal(skill.source, "builtin", `${name} 应来自 builtin 层`);
    assert.equal(skill.metadata.wwriting.priority, BUILTIN_SKILLS[name].priority, `${name} priority 应保留`);
  }
});

test("新建项目不会生成 skills/*/skill.json：内置技能来自 src/skills 而非项目目录", async (t) => {
  // 模拟新项目：projectRoot/skills 目录存在但为空（与 createProjectRoot 夹具一致）。
  const projectRoot = makeTemp();
  fs.mkdirSync(path.join(projectRoot, "skills"), { recursive: true });
  const userHome = makeTemp();
  const resourcesPath = makeTemp();
  t.after(() => {
    for (const dir of [projectRoot, userHome, resourcesPath]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const service = createSkillService({ userHome, resourcesPath, builtinRoot: BUILTIN_ROOT });
  const { active } = await service.catalog({ projectRoot });
  assert.equal(active.length, BUILTIN_SKILL_NAMES.length);
  assert.ok(active.every((skill) => skill.source === "builtin"), "全部内置技能均来自 builtin 层");

  // catalog 只从 src/skills 发现内置：项目 skills/ 目录保持为空，不产生任何 skill.json。
  assert.deepEqual(fs.readdirSync(path.join(projectRoot, "skills")), [], "项目 skills/ 目录应为空");
  for (const name of BUILTIN_SKILL_NAMES) {
    assert.equal(
      fs.existsSync(path.join(projectRoot, "skills", name, "skill.json")),
      false,
      `项目 skills/${name}/skill.json 不应被生成`
    );
  }
});
