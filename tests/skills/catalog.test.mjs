// 四级技能 catalog 单测（计划 Task 9 + Task 10）。
// 四层同名时 active 一定来自 project（项目 > 全局 > 随应用分发 > 内置）；
// 只扫描每个 root 的直接子目录；同 root 重复 name 拒绝；默认 root 在 service 内解析。
// Task 10：src/skills/<name>/SKILL.md 五个内置技能文件化；catalog 以 src/skills 为
// builtin root 时全部来自 source: "builtin"，且不向项目写入 skill.json。
// Task 6（F6）：三个基座内容完整重写（2.0.0），旧 BUILTIN_SKILLS 冻结快照删除——
// 内容重写后与旧常量的等价断言失去意义，改由「内置基座分类与元数据（F6）」与
// 共享 AI 红线契约测试守卫。
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

// Task 10：内置技能文件化后的真实根目录（src/skills），与 service 默认 builtinRoot 一致。
const BUILTIN_ROOT = path.resolve(import.meta.dirname, "..", "..", "src", "skills");

// 五个写作辅助内置技能名（内容以 src/skills/<name>/SKILL.md 文件为准；旧
// BUILTIN_SKILLS 常量与冻结快照已在 Task 12/Task 6 删除，这里只留名字与 priority）。
const BUILTIN_SKILL_NAMES = Object.freeze([
  "suspense-chapter-end",
  "chapter-opening-hook",
  "avoid-ai-voice",
  "dialogue-not-summary",
  "show-dont-tell"
]);
// 仍保留 frontmatter priority 的三个手艺技能（F7/F8 两个钩子改修饰后不再携带
// priority——新 frontmatter 只有 category/display_name/scope，删死 hooks）。
const BUILTIN_HOOK_PRIORITY = Object.freeze({
  "avoid-ai-voice": 30,
  "dialogue-not-summary": 40,
  "show-dont-tell": 50
});

// Task 8/F6：三个写作风格基座（F6 重写，2.0.0；D2 起无保留名/只读保护）。
const WRITING_STYLE_SKILLS = Object.freeze(["balanced", "fast-readable", "psychological-literary"]);
// F7/F8：两个修饰类新技能（payoff-pacing、dialogue-driven）。
const MODIFIER_SKILL_NAMES = Object.freeze(["payoff-pacing", "dialogue-driven"]);
const ALL_BUILTIN_SKILL_NAMES = Object.freeze([...BUILTIN_SKILL_NAMES, ...MODIFIER_SKILL_NAMES, ...WRITING_STYLE_SKILLS]);

// Task 8/F6：三个基座 frontmatter 固定值（F6 重写后 description/display_name 契约）。
const STYLE_FRONTMATTER = Object.freeze({
  balanced: Object.freeze({
    description: "事件推进与人物变化并重的标准网文节奏；每个场景必须推进局面，人物弧光是推进中的副产品。",
    display_name: "均衡"
  }),
  "fast-readable": Object.freeze({
    description: "用清楚因果、直接冲突和易扫读段落写快节奏中文网文正文；信息进入快，冲突到达早。",
    display_name: "快节奏易读"
  }),
  "psychological-literary": Object.freeze({
    description: "在网文节奏内加强人物动机、误解与选择代价；心理刻画由现场触发、落回行动，不拖节奏不堆独白。",
    display_name: "心理文学"
  })
});

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

test("单个非法 SKILL.md 不拖垮整层 catalog：合法技能保留，损坏目录进入 errors", async (t) => {
  const projectRoot = makeTemp();
  fs.mkdirSync(path.join(projectRoot, "skills"), { recursive: true });
  makeSkill(path.join(projectRoot, "skills"), "good", { body: "# Good" });
  // 非法技能：frontmatter name 与目录名不一致（readSkillFile 拒绝）。
  const badDir = path.join(projectRoot, "skills", "bad");
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(
    path.join(badDir, "SKILL.md"),
    "---\nname: other-name\ndescription: mismatch\n---\n\n# Bad\n",
    "utf8"
  );
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));

  const discovered = await discoverSkills({
    projectRoot,
    userHome: makeTemp(),
    resourcesPath: makeTemp(),
    builtinRoot: makeTemp()
  });
  assert.deepEqual(
    discovered.active.map((s) => s.name),
    ["good"],
    "同层一个坏技能不影响合法技能被发现"
  );
  assert.equal(discovered.errors.length, 1, "损坏目录必须进入 errors");
  assert.equal(discovered.errors[0].dir, badDir, "errors 携带损坏目录路径");
  assert.ok(discovered.errors[0].error.includes("other-name"), "errors 携带失败原因");
  assert.deepEqual(discovered.shadowed, [], "无同名覆盖");

  // service.catalog 同样把 errors 透出（settings DTO 据此展示）。
  const service = createSkillService({ userHome: makeTemp(), resourcesPath: makeTemp(), builtinRoot: makeTemp() });
  const merged = await service.catalog({ projectRoot });
  assert.equal(merged.errors.length, 1, "service.catalog 透出 errors");
  assert.ok(Object.isFrozen(discovered.errors), "errors 数组冻结");
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
  // Task 11 后 catalog 会先跑 ensureMigrated 迁移；注入临时 userHome，保证测试
  // 不触碰真实用户目录，也不在真实 home 写 migration marker。
  const projectRoot = makeTemp();
  const userHome = makeTemp();
  const unique = `zz-task9-default-root-${process.pid}`;
  fs.mkdirSync(path.join(projectRoot, "skills"), { recursive: true });
  makeSkill(path.join(projectRoot, "skills"), unique, { body: "# From Default Service" });
  t.after(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
  });

  const service = createSkillService({ userHome });
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

test("内置基座分类与元数据（F6）", async () => {
  const { active } = await discoverSkills({ builtinRoot: BUILTIN_ROOT });
  const byName = new Map(active.map((s) => [s.name, s]));
  for (const name of ["balanced", "fast-readable", "psychological-literary"]) {
    const skill = byName.get(name);
    assert.ok(skill, `${name} 在 catalog`);
    assert.equal(skill.category, "writing-style", `${name} category`);
    assert.equal(skill.display_name !== name, true, `${name} 有 display_name`);
    assert.equal("readonly" in skill, false, `${name} 无 readonly 字段`);
  }
});

test("catalog 以 src/skills 为 builtin root 时全部内置技能来自 source: builtin（五个写作辅助 + 两个修饰 + 三个写作风格）", async (t) => {
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
  assert.equal(active.length, ALL_BUILTIN_SKILL_NAMES.length, `active 应恰好是 ${ALL_BUILTIN_SKILL_NAMES.length} 个内置技能，得到 ${active.map((s) => s.name).join(",")}`);
  const byName = new Map(active.map((skill) => [skill.name, skill]));
  for (const name of BUILTIN_SKILL_NAMES) {
    const skill = byName.get(name);
    assert.ok(skill, `catalog 应发现内置技能 ${name}`);
    assert.equal(skill.source, "builtin", `${name} 应来自 builtin 层`);
  }
  for (const [name, priority] of Object.entries(BUILTIN_HOOK_PRIORITY)) {
    assert.equal(byName.get(name).metadata.wwriting.priority, priority, `${name} priority 应保留`);
  }
  for (const name of WRITING_STYLE_SKILLS) {
    const skill = byName.get(name);
    assert.ok(skill, `catalog 应发现内置写作风格 ${name}`);
    assert.equal(skill.source, "builtin", `${name} 应来自 builtin 层`);
    assert.equal(skill.display_name, STYLE_FRONTMATTER[name].display_name, `${name} display_name`);
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
  assert.equal(active.length, ALL_BUILTIN_SKILL_NAMES.length);
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

// ---------------------------------------------------------------------------
// F6：三个基座（writing-style）内容重写（version 2.0.0）：frontmatter 契约固定，
// 「避免」段末尾共享 AI 红线六条逐字一致；D2 起不做保留名/只读保护。
// ---------------------------------------------------------------------------

// 共享 AI 红线块（三个基座「避免」段末尾，逐字相同）。
const SHARED_RED_LINES = Object.freeze([
  "- 三连排比堆砌（如「他握住刀，握住恨，握住……」）。",
  "- 段尾用总结句收束情绪（如「她终于明白了……」）。",
  "- 模糊修饰词连发：仿佛、似乎、不禁、不由得、莫名、悄然、缓缓、微微、瞬间、顿时、一股莫名的、一种说不出的。",
  "- 抒情长句连续不断，情绪改用具体动作和实物承载。",
  "- 空转的环境与心理描写：每段必须有新的信息、动作或情绪推进，否则删掉。",
  "- 文绉绉的书面腔：能用口语说清的就用口语说，不堆华丽辞藻与文言词。"
]);

test("三个基座（F6）：frontmatter 2.0.0 契约，避免段末尾共享红线六条逐字一致", async () => {
  for (const name of WRITING_STYLE_SKILLS) {
    const skill = await readSkillFile(path.join(BUILTIN_ROOT, name), { source: "builtin" });

    // frontmatter 固定值（Task 6 brief verbatim）。
    assert.equal(skill.name, name, `${name} frontmatter name`);
    assert.equal(skill.version, "2.0.0", `${name} frontmatter version`);
    assert.equal(skill.description, STYLE_FRONTMATTER[name].description, `${name} frontmatter description`);
    const wwriting = skill.metadata.wwriting;
    assert.ok(wwriting, `${name} 必须声明 metadata.wwriting`);
    assert.equal(wwriting.category, "writing-style", `${name} metadata.wwriting.category`);
    assert.equal(wwriting.display_name, STYLE_FRONTMATTER[name].display_name, `${name} metadata.wwriting.display_name`);

    // 「只在小说正文时使用」边界必须保留。
    assert.ok(
      skill.body.includes("只在生成、续写、改写、润色或审核中文小说正文时使用本技能"),
      `${name} 必须保留「只在小说正文时使用」边界`
    );
    // 共享 AI 红线六条逐字位于「避免」段末尾（正文最后一个清单块）。
    const bullets = skill.body.split("\n").filter((line) => line.startsWith("- "));
    assert.deepEqual(
      bullets.slice(bullets.length - SHARED_RED_LINES.length),
      [...SHARED_RED_LINES],
      `${name} 「避免」段末尾必须是共享红线六条`
    );
  }
  // 心理文学不得改写成纯文学/意识流：保留面向大众读者的明确边界。
  const psych = await readSkillFile(path.join(BUILTIN_ROOT, "psychological-literary"), { source: "builtin" });
  assert.ok(psych.body.includes("不写大段意识流、晦涩哲思或纯文学仿作"));
  assert.ok(psych.body.includes("普通聊天不使用小说文风"));
});

test("其他技能 DTO 字段不含 readonly/protected，display_name 回落 name", async (t) => {
  const projectRoot = makeTemp();
  const userHome = makeTemp();
  const resourcesPath = makeTemp();
  const builtinRoot = makeTemp();
  makeSkill(builtinRoot, "alpha", { body: "# Alpha" });
  fs.mkdirSync(path.join(projectRoot, "skills"), { recursive: true });
  makeSkill(path.join(projectRoot, "skills"), "alpha", { body: "# Project Alpha" });

  t.after(() => {
    for (const dir of [projectRoot, userHome, resourcesPath, builtinRoot]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const service = createSkillService({ userHome, resourcesPath, builtinRoot });
  const { active } = await service.catalog({ projectRoot });
  const alpha = active.find((skill) => skill.name === "alpha");
  assert.equal(alpha.source, "project");
  assert.equal("readonly" in alpha, false, "catalog 不再返回 readonly 字段");
  assert.equal("protected" in alpha, false, "catalog 不再返回 protected 字段");
  assert.equal(alpha.display_name, "alpha", "非保留名 display_name 回落 name");
  assert.equal(alpha.category, null, "无 category metadata 时为 null");
});

// ---------------------------------------------------------------------------
// D2：内置技能不做任何保护——同名覆盖由纯四层优先级裁决
// （project > global > bundled > builtin），project 可覆盖 builtin 基座名。
// ---------------------------------------------------------------------------

test("D2：同名覆盖纯优先级，project 可覆盖 builtin 基座名", async (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "skills-d2-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const builtinRoot = path.join(base, "builtin");
  const projectRoot = path.join(base, "project");
  // builtin 层根即 builtinRoot；project 层根为 <projectRoot>/skills（ROOTS 契约）。
  for (const [root, name, desc] of [
    [builtinRoot, "balanced", "内置均衡"],
    [path.join(projectRoot, "skills"), "balanced", "项目自定义均衡"]
  ]) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${desc}\nversion: 1.0.0\n---\n\n# ${name}\n\n正文。\n`);
  }
  const { active, shadowed } = await discoverSkills({ builtinRoot, projectRoot });
  const activeNames = active.filter((s) => s.name === "balanced");
  assert.equal(activeNames.length, 1);
  assert.equal(activeNames[0].source, "project");
  assert.ok(shadowed.some((s) => s.name === "balanced" && s.source === "builtin"));
});

// ---------------------------------------------------------------------------
// F7/F8：修饰类四个技能（两个新建 + 两个钩子改类）frontmatter 契约：
// metadata.wwriting.category = style-modifier 且带 display_name/scope。
// ---------------------------------------------------------------------------

test("修饰类技能四个（F7/F8）", async () => {
  const { active } = await discoverSkills({ builtinRoot: BUILTIN_ROOT });
  const byName = new Map(active.map((s) => [s.name, s]));
  for (const name of ["payoff-pacing", "dialogue-driven", "suspense-chapter-end", "chapter-opening-hook"]) {
    assert.equal(byName.get(name)?.category, "style-modifier", `${name} category`);
  }
});
