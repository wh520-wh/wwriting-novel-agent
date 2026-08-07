// 四级技能 catalog 单测（计划 Task 9 + Task 10）。
// 四层同名时 active 一定来自 project（项目 > 全局 > 随应用分发 > 内置）；
// 只扫描每个 root 的直接子目录；同 root 重复 name 拒绝；默认 root 在 service 内解析。
// Task 10：src/skills/<name>/SKILL.md 五个内置技能文件与旧 BUILTIN_SKILLS 内容等价
// （BUILTIN_SKILLS 常量随 Task 12 删除，改用冻结快照保持等价断言），
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

// Task 10：内置技能文件化后的真实根目录（src/skills），与 service 默认 builtinRoot 一致。
const BUILTIN_ROOT = path.resolve(import.meta.dirname, "..", "..", "src", "skills");

// 旧 BUILTIN_SKILLS 常量（Task 12 已删除）的冻结快照：五个内置技能的
// name/description/version/scope/priority/hooks（含正文等价断言需要的
// append_prompt.content 与 check.prompt 原文）。
const BUILTIN_SKILL_SNAPSHOT = Object.freeze({
  "suspense-chapter-end": Object.freeze({
    name: "suspense-chapter-end",
    version: "1.0.0",
    scope: "chapter",
    priority: 50,
    description: "每章结尾都要留下悬念钩子：震惊性话语、推翻认知的新事实或突然逼近的危险。",
    hooks: Object.freeze([
      Object.freeze({
        stage: "planning",
        action: "append_prompt",
        content: "本章计划必须包含一个结尾悬念钩子。\n优先使用以下类型：一句令人震惊的话、一个推翻此前认知的新事实、或一个突然逼近的危险。"
      }),
      Object.freeze({
        stage: "reviewing",
        action: "check",
        check: "suspense-ending",
        prompt: "Check whether the final 500 visible characters contain a meaningful suspense hook."
      })
    ])
  }),
  "chapter-opening-hook": Object.freeze({
    name: "chapter-opening-hook",
    version: "1.0.0",
    scope: "chapter",
    priority: 40,
    description: "每章开头必须用正在发生的事抓人：动作、冲突或悬念开场，不写天气和环境铺垫。",
    hooks: Object.freeze([
      Object.freeze({
        stage: "planning",
        action: "append_prompt",
        content: "本章开头前两句话必须进入一个正在发生的事件（人物行动、冲突、悬念或意外）。\n禁止以天气、环境描写或背景说明开场。"
      }),
      Object.freeze({
        stage: "reviewing",
        action: "check",
        check: "chapter-opening",
        prompt: "检查正文开头约 150 个可见字符内是否有一个正在发生的动作、冲突或悬念。"
      })
    ])
  }),
  "avoid-ai-voice": Object.freeze({
    name: "avoid-ai-voice",
    version: "1.0.0",
    scope: "chapter",
    priority: 30,
    description: "去除 AI 腔：不堆排比、不用模糊修饰词和总结式收尾，读起来像人写的。",
    hooks: Object.freeze([
      Object.freeze({
        stage: "drafting",
        action: "append_prompt",
        content: [
          "去除 AI 腔，这些写法一律不用：",
          "1) 三连排比堆砌（如“他握住刀，握住恨，握住……”）；",
          "2) 段尾用总结句收束情绪（如“她终于明白了……”）；",
          "3) 模糊修饰词连发（仿佛、似乎、不禁、不由得、莫名、悄然、缓缓、微微、瞬间、顿时、一股莫名的、一种说不出的）；",
          "4) 抒情长句连续不断，情绪改用具体动作和实物承载；",
          "5) “如果说……那么……”式的议论句式。"
        ].join("\n")
      }),
      Object.freeze({
        stage: "reviewing",
        action: "check",
        check: "ai-voice",
        prompt: "统计正文中模糊修饰词（仿佛/似乎/不禁/不由得/莫名/悄然/缓缓/微微/瞬间/顿时等）的出现密度，判断是否超标。"
      })
    ])
  }),
  "dialogue-not-summary": Object.freeze({
    name: "dialogue-not-summary",
    version: "1.0.0",
    scope: "chapter",
    priority: 40,
    description: "对话推进剧情：人物各有声音、不重复已知信息；本章对话占比合理。",
    hooks: Object.freeze([
      Object.freeze({
        stage: "drafting",
        action: "append_prompt",
        content: [
          "对话规则：",
          "1) 每段对话必须有目的：推进情节、暴露人设或制造冲突；",
          "2) 禁止用对话复述读者已知的信息（“如你所知……”式）；",
          "3) 人物各有口头禅和句式，不要所有人一个腔调；",
          "4) 对话配动作与反应（表情、停顿、小动作），避免“他说道”“她答道”连发。"
        ].join("\n")
      }),
      Object.freeze({
        stage: "reviewing",
        action: "check",
        check: "dialogue-ratio",
        prompt: "计算本章引号内对话占总可见字符的比例，对话过少或过多都要标记。"
      })
    ])
  }),
  "show-dont-tell": Object.freeze({
    name: "show-dont-tell",
    version: "1.0.0",
    scope: "chapter",
    priority: 50,
    description: "展示而非陈述：用动作、反应和细节表现情绪与性格，不直接贴标签。",
    hooks: Object.freeze([
      Object.freeze({
        stage: "drafting",
        action: "append_prompt",
        content: [
          "展示而非陈述：不直接宣告情绪或性格（如“他很生气”“她是个善良的人”）。",
          "改用具体动作、身体反应、环境细节和他人反应：",
          "例：他摔上门，钥匙在锁孔里断成两截——而不是：他很生气。",
          "例：她蹲下来把碎纸一片片捡起，摆回信封——而不是：她是个细心的人。"
        ].join("\n")
      }),
      Object.freeze({
        stage: "revising",
        action: "append_prompt",
        content: "修订时检查：正文中是否还有直接宣告情绪、性格或结论的句子？把它们改写成具体动作与细节。"
      })
    ])
  })
});
const BUILTIN_SKILL_NAMES = Object.keys(BUILTIN_SKILL_SNAPSHOT);

// Task 8：三个受保护写作风格技能（保留名称，SPEC §6.4 正文）。
const WRITING_STYLE_SKILLS = Object.freeze(["balanced", "fast-readable", "psychological-literary"]);
const ALL_BUILTIN_SKILL_NAMES = Object.freeze([...BUILTIN_SKILL_NAMES, ...WRITING_STYLE_SKILLS]);

// Task 8：三个风格技能的 frontmatter 固定值（brief Step 2 verbatim）。
const STYLE_FRONTMATTER = Object.freeze({
  balanced: Object.freeze({
    description: "在情节、人物、描写与可读性之间保持均衡；生成、续写、改写、润色或审核中文小说正文时使用。",
    display_name: "均衡"
  }),
  "fast-readable": Object.freeze({
    description: "用清楚因果、直接冲突和易扫读段落写快节奏中文网文正文。",
    display_name: "快节奏易读"
  }),
  "psychological-literary": Object.freeze({
    description: "在大众网文可读性内加强人物动机、心理变化与潜台词，不写晦涩意识流。",
    display_name: "心理文学"
  })
});

// 从 SPEC §6.4 提取三个代码块作为正文权威（truth source；归一化行尾后与
// SKILL.md body 全等比对，保证「逐字采用」可被测试机械验证）。
function extractSpecSkillBodies() {
  const specPath = path.resolve(
    import.meta.dirname, "..", "..", "docs", "superpowers", "specs",
    "2026-08-07-workspace-chat-and-writing-style-spec.md"
  );
  const text = fs.readFileSync(specPath, "utf8");
  const start = text.indexOf("### 6.4");
  assert.ok(start >= 0, "SPEC 必须包含 §6.4 三个技能的完整提示词合同");
  // §6.4 结束于下一个一级章节标题 "## 7."（§6.4 内正文的 "## 目标" 等都在
  // markdown 代码块内，不能用普通 "## " 前缀截断）。
  const end = text.indexOf("\n## 7.", start);
  assert.ok(end > start, "SPEC §6.4 之后必须有下一章标题");
  const section = text.slice(start, end);
  const blocks = [...section.matchAll(/```markdown\n([\s\S]*?)```/gu)]
    .map((match) => match[1].replace(/\r\n/gu, "\n"));
  assert.equal(blocks.length, 3, "SPEC §6.4 应恰好包含三个 markdown 代码块");
  return {
    balanced: blocks[0],
    "fast-readable": blocks[1],
    "psychological-literary": blocks[2]
  };
}
const SPEC_STYLE_BODIES = extractSpecSkillBodies();

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

// Task 8 Step 1：在 projectRoot/skills/ 下写一个同名项目技能（模拟项目伪造版本）。
function writeSkill(projectRoot, name, body = "项目伪造版本") {
  return makeSkill(path.join(projectRoot, "skills"), name, { body });
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

test("五个内置技能文件存在，frontmatter 与旧 BUILTIN_SKILLS 快照等价且正文非空壳", async (t) => {
  assert.equal(BUILTIN_SKILL_NAMES.length, 5, "内置技能应为五个");

  for (const name of BUILTIN_SKILL_NAMES) {
    const old = BUILTIN_SKILL_SNAPSHOT[name];
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

test("catalog 以 src/skills 为 builtin root 时全部内置技能来自 source: builtin（五个写作辅助 + 三个写作风格）", async (t) => {
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
    assert.equal(skill.metadata.wwriting.priority, BUILTIN_SKILL_SNAPSHOT[name].priority, `${name} priority 应保留`);
  }
  for (const name of WRITING_STYLE_SKILLS) {
    const skill = byName.get(name);
    assert.ok(skill, `catalog 应发现内置写作风格 ${name}`);
    assert.equal(skill.source, "builtin", `${name} 应来自 builtin 层`);
    assert.equal(skill.readonly, true, `${name} readonly`);
    assert.equal(skill.protected, true, `${name} protected`);
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
// Task 8：三个受保护写作风格技能（保留名称、只读、SPEC §6.4 正文逐字一致）
// ---------------------------------------------------------------------------

test("三个内置写作风格：frontmatter 固定、正文与 SPEC §6.4 逐字一致", async () => {
  for (const name of WRITING_STYLE_SKILLS) {
    const skill = await readSkillFile(path.join(BUILTIN_ROOT, name), { source: "builtin" });

    // frontmatter 固定值（brief Step 2 verbatim）。
    assert.equal(skill.name, name, `${name} frontmatter name`);
    assert.equal(skill.description, STYLE_FRONTMATTER[name].description, `${name} frontmatter description`);
    assert.equal(skill.version, "1.0.0", `${name} frontmatter version`);
    const wwriting = skill.metadata.wwriting;
    assert.ok(wwriting, `${name} 必须声明 metadata.wwriting`);
    assert.equal(wwriting.category, "writing-style", `${name} metadata.wwriting.category`);
    assert.equal(wwriting.display_name, STYLE_FRONTMATTER[name].display_name, `${name} metadata.wwriting.display_name`);
    assert.equal(wwriting.readonly, true, `${name} metadata.wwriting.readonly`);

    // 正文必须与 SPEC §6.4 代码块逐字一致（归一化行尾后全等）。
    assert.equal(
      skill.body.replace(/\r\n/gu, "\n"),
      SPEC_STYLE_BODIES[name],
      `${name} 正文必须逐字采用 SPEC §6.4 完整提示词合同`
    );
    // 边界条款不得删去：「只在小说正文时使用」与「普通聊天不使用小说文风」。
    assert.ok(
      skill.body.includes("只在生成、续写、改写、润色或审核中文小说正文时使用本技能"),
      `${name} 必须保留「只在小说正文时使用」边界`
    );
    assert.ok(skill.body.includes("## 交付前静默检查"), `${name} 必须保留交付前静默检查`);
  }
  // 心理文学不得改写成纯文学/意识流：保留面向大众读者的明确边界。
  assert.ok(SPEC_STYLE_BODIES["psychological-literary"].includes("不写大段意识流、晦涩哲思或纯文学仿作"));
  assert.ok(SPEC_STYLE_BODIES["psychological-literary"].includes("普通聊天不使用小说文风"));
});

test("内置写作风格使用保留名称且不能被项目技能覆盖（brief Step 1）", async (t) => {
  const projectRoot = makeTemp();
  const userHome = makeTemp();
  const resourcesPath = makeTemp();
  for (const name of WRITING_STYLE_SKILLS) writeSkill(projectRoot, name, "项目伪造版本");

  t.after(() => {
    for (const dir of [projectRoot, userHome, resourcesPath]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const service = createSkillService({ userHome, resourcesPath, builtinRoot: BUILTIN_ROOT });
  const catalog = await service.catalog({ projectRoot });

  for (const name of WRITING_STYLE_SKILLS) {
    const builtin = catalog.active.find((skill) => skill.name === name);
    assert.ok(builtin, `active 必须保留内置 ${name}`);
    assert.equal(builtin.source, "builtin", `${name} 不能被项目技能覆盖`);
    assert.equal(builtin.readonly, true, `${name} readonly 必须为 true`);
    assert.equal(builtin.protected, true, `${name} protected 必须为 true`);
    assert.equal(builtin.display_name, STYLE_FRONTMATTER[name].display_name, `${name} display_name 来自 frontmatter`);
    const shadowed = catalog.shadowed.find((skill) => skill.name === name && skill.source === "project");
    assert.ok(shadowed, `${name} 的项目同名技能必须进入 shadowed`);
    assert.equal(shadowed.shadow_reason, "reserved_builtin", `${name} shadowed 携带 reserved_builtin 原因`);
  }
  // 项目伪造版本绝不能被激活。
  assert.ok(!catalog.active.some((skill) => skill.source === "project" && WRITING_STYLE_SKILLS.includes(skill.name)));
});

test("保留名称即使没有内置技能（空 builtin root）也绝不进入 active", async (t) => {
  const projectRoot = makeTemp();
  const userHome = makeTemp();
  const resourcesPath = makeTemp();
  const builtinRoot = makeTemp();
  for (const name of WRITING_STYLE_SKILLS) writeSkill(projectRoot, name, "项目伪造版本");

  t.after(() => {
    for (const dir of [projectRoot, userHome, resourcesPath, builtinRoot]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const service = createSkillService({ userHome, resourcesPath, builtinRoot });
  const { active, shadowed } = await service.catalog({ projectRoot });
  assert.ok(!active.some((skill) => WRITING_STYLE_SKILLS.includes(skill.name)), "保留名称在无内置时也绝不 active");
  assert.equal(
    shadowed.filter((skill) => WRITING_STYLE_SKILLS.includes(skill.name)).length,
    WRITING_STYLE_SKILLS.length,
    "保留名称项目技能一律 shadowed(reserved_builtin)"
  );
  assert.ok(shadowed.every((skill) => skill.shadow_reason === "reserved_builtin"));
});

test("保留名称同时出现在 global 与 project 层：两者都 shadowed，active 恒为 builtin", async (t) => {
  const projectRoot = makeTemp();
  const userHome = makeTemp();
  const resourcesPath = makeTemp();
  writeSkill(projectRoot, "balanced", "项目伪造版本");
  fs.mkdirSync(path.join(userHome, ".wwriting", "skills", "balanced"), { recursive: true });
  fs.writeFileSync(
    path.join(userHome, ".wwriting", "skills", "balanced", "SKILL.md"),
    "---\nname: balanced\ndescription: global 伪造版本\n---\n\n# Global Fake\n",
    "utf8"
  );

  t.after(() => {
    for (const dir of [projectRoot, userHome, resourcesPath]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const service = createSkillService({ userHome, resourcesPath, builtinRoot: BUILTIN_ROOT });
  const { active, shadowed } = await service.catalog({ projectRoot });
  const activeBalanced = active.find((skill) => skill.name === "balanced");
  assert.equal(activeBalanced.source, "builtin", "active 恒为内置版本");
  const reserved = shadowed.filter((skill) => skill.name === "balanced");
  assert.equal(reserved.length, 2, "project 与 global 两个同名项都 shadowed");
  assert.ok(reserved.every((skill) => skill.shadow_reason === "reserved_builtin"));
});

test("其他技能（非保留名）DTO 字段：readonly/protected 为 false，display_name 回落 name", async (t) => {
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
  assert.equal(alpha.readonly, false, "非保留名 readonly 为 false");
  assert.equal(alpha.protected, false, "非保留名 protected 为 false");
  assert.equal(alpha.display_name, "alpha", "非保留名 display_name 回落 name");
  assert.equal(alpha.category, null, "无 category metadata 时为 null");
});
