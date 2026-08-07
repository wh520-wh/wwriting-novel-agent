// SKILL.md parser 单测（计划 Task 9，冻结契约 §2.5）。
// 合法技能返回 {name, description, body, dir, source, metadata, resources}；
// 拒绝：缺 frontmatter、目录名与 name 不同、缺失/重复 name、无效 YAML、
// 绝对资源路径、../ 穿越、资源 realpath 逃逸、超 512KiB 的 SKILL.md。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_RESOURCE_BYTES,
  assertSafeSkillDirName,
  readSkillFile,
  readSkillResource
} from "../../src/core/skills/skill-file.mjs";

const VALID_SKILL = `---
name: suspense-chapter-end
description: 每章结尾留下有效悬念钩子；章节规划、写作或审稿时使用。
version: 1.0.0
metadata:
  wwriting:
    scope: chapter
    priority: 50
    always_apply: [chapter]
    hooks:
      - stage: reviewing
        action: check
        check: suspense-ending
x-custom: keep-me
---

# Suspense Chapter End

正文：本章计划必须包含一个结尾悬念钩子。
`;

function makeTemp() {
  return mkdtempSync(path.join(tmpdir(), "wwr-skill-file-"));
}

// 在临时根下创建 <dirName>/SKILL.md，返回 { root, skillDir }。
async function makeSkill(dirName, content) {
  const root = makeTemp();
  const skillDir = path.join(root, dirName);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), content, "utf8");
  return { root, skillDir };
}

async function expectRejected(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, "SkillError", `期望 SkillError，得到 ${error.name}`);
    assert.equal(error.code, code, `期望 code ${code}，得到 ${error.code}（${error.message}）`);
    return true;
  });
}

// 在技能目录内创建指向技能目录外部的逃逸链接，返回可读用的相对路径；两者都不可用
// 返回 null（调用方跳过测试）。优先文件 symlink（POSIX / 开发者模式 Windows）；普通
// Windows 无管理员/开发者模式时文件 symlink 抛 EPERM，回退为目录 junction——junction
// 不需要特权，Dirent.isSymbolicLink() 为 true 且 fs.realpath 解析到目标目录，同样触发
// realpath 逃逸路径。relPath 决定链接位置：逃逸枚举测试放在 references/ 之下，逃逸
// 读取测试放在技能目录顶层（避免枚举阶段拦截，单独测 readSkillResource 的 containment）。
function tryCreateEscapeLink(skillDir, outsideRoot, relPath) {
  const fileTarget = path.join(outsideRoot, "outside-secret.txt");
  writeFileSync(fileTarget, "secret", "utf8");
  try {
    symlinkSync(fileTarget, path.join(skillDir, relPath));
    return relPath;
  } catch (error) {
    if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
  }
  const dirTarget = path.join(outsideRoot, "outside-dir");
  mkdirSync(dirTarget, { recursive: true });
  try {
    symlinkSync(dirTarget, path.join(skillDir, relPath), "junction");
    return relPath;
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") return null;
    throw error;
  }
}

test("合法技能返回冻结的 {name, description, body, dir, source, metadata, resources}", async (t) => {
  const { root, skillDir } = await makeSkill("suspense-chapter-end", VALID_SKILL);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  await fs.mkdir(path.join(skillDir, "references", "nested"), { recursive: true });
  await fs.writeFile(path.join(skillDir, "references", "style-guide.md"), "参考文档", "utf8");
  await fs.writeFile(path.join(skillDir, "references", "nested", "extra.md"), "嵌套", "utf8");
  await fs.mkdir(path.join(skillDir, "scripts"));
  await fs.writeFile(path.join(skillDir, "scripts", "run.sh"), "#!/bin/sh\n", "utf8");
  await fs.mkdir(path.join(skillDir, "assets"));
  await fs.writeFile(path.join(skillDir, "assets", "cover.png"), "PNG", "utf8");
  // SKILL.md 顶层平铺文件不属于资源（只有 scripts/references/assets 才枚举）。
  await fs.writeFile(path.join(skillDir, "notes.md"), "不是资源", "utf8");

  const skill = await readSkillFile(skillDir, { source: "project" });

  assert.equal(skill.name, "suspense-chapter-end");
  assert.equal(skill.description, "每章结尾留下有效悬念钩子；章节规划、写作或审稿时使用。");
  assert.equal(skill.dir, skillDir);
  assert.equal(skill.source, "project");
  assert.ok(skill.body.includes("# Suspense Chapter End"), "body 应包含正文标题");
  assert.ok(skill.body.includes("本章计划必须包含一个结尾悬念钩子。"), "body 应包含正文");
  assert.ok(!skill.body.includes("name:"), "body 不应包含 frontmatter 字段");

  // metadata.wwriting 可选扩展按原样解析。
  assert.equal(skill.metadata.wwriting.scope, "chapter");
  assert.equal(skill.metadata.wwriting.priority, 50);
  assert.deepEqual(skill.metadata.wwriting.always_apply, ["chapter"]);
  assert.deepEqual(skill.metadata.wwriting.hooks, [
    { stage: "reviewing", action: "check", check: "suspense-ending" }
  ]);

  // 未知 metadata 保留但不执行。
  assert.equal(skill["x-custom"], "keep-me");

  // 顶层冻结，metadata 与 resources 深冻结。
  assert.ok(Object.isFrozen(skill));
  assert.ok(Object.isFrozen(skill.metadata));
  assert.ok(Object.isFrozen(skill.resources));
  assert.ok(Object.isFrozen(skill.resources[0]));

  // 资源枚举：只含 scripts/references/assets，递归，相对路径为 posix 形式。
  const rels = skill.resources.map((r) => r.rel).sort();
  assert.deepEqual(rels, [
    "assets/cover.png",
    "references/nested/extra.md",
    "references/style-guide.md",
    "scripts/run.sh"
  ]);
  for (const resource of skill.resources) {
    assert.equal(
      resource.abs,
      await fs.realpath(path.join(skillDir, resource.rel)),
      `资源真实路径应解析到 ${resource.rel}`
    );
  }
});

test("拒绝缺少 frontmatter 的 SKILL.md", async (t) => {
  const { root, skillDir } = await makeSkill("alpha", "# 没有 frontmatter 的正文\n");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await expectRejected(readSkillFile(skillDir, { source: "project" }), "skill_missing_frontmatter");
});

test("拒绝只有开 fence 没有闭合 fence 的 SKILL.md", async (t) => {
  const { root, skillDir } = await makeSkill("alpha", "---\nname: alpha\n");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await expectRejected(readSkillFile(skillDir, { source: "project" }), "skill_missing_frontmatter");
});

test("拒绝目录名与 name 不同的 SKILL.md", async (t) => {
  const { root, skillDir } = await makeSkill("other-name", VALID_SKILL);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await expectRejected(readSkillFile(skillDir, { source: "project" }), "skill_name_mismatch");
});

test("拒绝缺失 name 的 SKILL.md", async (t) => {
  const content = "---\ndescription: 只有描述没有名字\n---\n\n正文\n";
  const { root, skillDir } = await makeSkill("alpha", content);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await expectRejected(readSkillFile(skillDir, { source: "project" }), "skill_missing_name");
});

test("拒绝无效 YAML frontmatter", async (t) => {
  const { root, skillDir } = await makeSkill("alpha", "---\nname: [未闭合\n---\n\n正文\n");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await expectRejected(readSkillFile(skillDir, { source: "project" }), "skill_invalid_yaml");
});

test("拒绝 frontmatter 中重复的 name 键", async (t) => {
  const content = "---\nname: alpha\nname: beta\n---\n\n正文\n";
  const { root, skillDir } = await makeSkill("alpha", content);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // yaml 包默认 uniqueKeys: true，重复键直接拒绝。
  await expectRejected(readSkillFile(skillDir, { source: "project" }), "skill_invalid_yaml");
});

test("拒绝超过 512KiB 的 SKILL.md", async (t) => {
  const body = `# Big\n\n${"x".repeat(MAX_SKILL_FILE_BYTES + 1)}\n`;
  const { root, skillDir } = await makeSkill("alpha", body);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await expectRejected(readSkillFile(skillDir, { source: "project" }), "skill_file_too_large");
});

test("拒绝缺失 SKILL.md 的目录", async (t) => {
  const root = makeTemp();
  const skillDir = path.join(root, "alpha");
  await fs.mkdir(skillDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await expectRejected(readSkillFile(skillDir, { source: "project" }), "skill_file_not_found");
});

test("资源枚举拒绝 realpath 逃逸技能目录的 symlink", async (t) => {
  const root = makeTemp();
  const skillDir = path.join(root, "suspense-chapter-end");
  await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), VALID_SKILL, "utf8");
  // 逃逸链接放在 references/ 之下：枚举 scripts/references/assets 时必然遇到。
  const rel = tryCreateEscapeLink(skillDir, root, "references/evil.txt");
  if (!rel) {
    t.skip("当前环境既不能创建 symlink 也不能创建 junction，跳过逃逸枚举测试");
    rmSync(root, { recursive: true, force: true });
    return;
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await expectRejected(
    readSkillFile(skillDir, { source: "project" }),
    "skill_resource_unsafe"
  );
});

test("readSkillResource 按需读取 SKILL.md", async (t) => {
  const { root, skillDir } = await makeSkill("suspense-chapter-end", VALID_SKILL);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skill = await readSkillFile(skillDir, { source: "project" });

  const result = await readSkillResource(skill, "SKILL.md");
  assert.equal(result.name, skill.name);
  assert.equal(result.resource, "SKILL.md");
  assert.equal(result.content, VALID_SKILL);
  assert.equal(result.bytes, Buffer.byteLength(VALID_SKILL, "utf8"));
  assert.equal(result.path, await fs.realpath(path.join(skillDir, "SKILL.md")));
  assert.ok(Object.isFrozen(result));
});

test("readSkillResource 读取 references 资源", async (t) => {
  const { root, skillDir } = await makeSkill("suspense-chapter-end", VALID_SKILL);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(skillDir, "references"));
  await fs.writeFile(path.join(skillDir, "references", "guide.md"), "# 参考指南\n", "utf8");
  const skill = await readSkillFile(skillDir, { source: "project" });

  const result = await readSkillResource(skill, "references/guide.md");
  assert.equal(result.content, "# 参考指南\n");
  assert.equal(result.resource, "references/guide.md");
});

test("readSkillResource 拒绝绝对资源路径", async (t) => {
  const { root, skillDir } = await makeSkill("suspense-chapter-end", VALID_SKILL);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skill = await readSkillFile(skillDir, { source: "project" });
  const absolute = path.join(root, "outside.txt");
  await fs.writeFile(absolute, "x", "utf8");
  await expectRejected(
    readSkillResource(skill, absolute),
    "skill_resource_unsafe"
  );
});

test("readSkillResource 拒绝 ../ 穿越", async (t) => {
  const { root, skillDir } = await makeSkill("suspense-chapter-end", VALID_SKILL);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skill = await readSkillFile(skillDir, { source: "project" });
  await fs.writeFile(path.join(root, "secret.txt"), "x", "utf8");
  await expectRejected(readSkillResource(skill, "../secret.txt"), "skill_resource_unsafe");
  await expectRejected(
    readSkillResource(skill, "references/../../secret.txt"),
    "skill_resource_unsafe"
  );
});

test("readSkillResource 拒绝不存在的资源", async (t) => {
  const { root, skillDir } = await makeSkill("suspense-chapter-end", VALID_SKILL);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skill = await readSkillFile(skillDir, { source: "project" });
  await expectRejected(
    readSkillResource(skill, "references/missing.md"),
    "skill_resource_not_found"
  );
});

test("readSkillResource 对目录资源返回 skill_resource_not_found（不裸抛 EISDIR）", async (t) => {
  const { root, skillDir } = await makeSkill("suspense-chapter-end", VALID_SKILL);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(skillDir, "references", "dirres"), { recursive: true });
  const skill = await readSkillFile(skillDir, { source: "project" });
  await expectRejected(
    readSkillResource(skill, "references/dirres"),
    "skill_resource_not_found"
  );
});

test("assertSafeSkillDirName 拒绝 Windows 非法字符与保留设备名", () => {
  const invalid = [
    "a<b", "a>b", "a:b", 'a"b', "a|b", "a?b", "a*b",
    "CON", "con", "PRN", "AUX", "NUL", "NUL.txt", "COM1", "com9", "LPT1", "lpt9.txt"
  ];
  for (const bad of invalid) {
    assert.throws(
      () => assertSafeSkillDirName(bad),
      (error) => error.code === "skill_invalid_name",
      `Windows 非法技能名必须拒绝: ${JSON.stringify(bad)}`
    );
  }
  for (const ok of ["正常技能", "skill-name", "CON-note", "COMIX", "a b"]) {
    assert.equal(assertSafeSkillDirName(ok), ok, `合法技能名必须通过: ${JSON.stringify(ok)}`);
  }
});

test("readSkillResource 拒绝超过 1MiB 的文本资源", async (t) => {
  const { root, skillDir } = await makeSkill("suspense-chapter-end", VALID_SKILL);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(skillDir, "references"));
  await fs.writeFile(path.join(skillDir, "references", "big.txt"), "a".repeat(MAX_SKILL_RESOURCE_BYTES + 1), "utf8");
  const skill = await readSkillFile(skillDir, { source: "project" });
  await expectRejected(
    readSkillResource(skill, "references/big.txt"),
    "skill_resource_too_large"
  );
});

test("readSkillResource 二进制 asset 返回元数据+绝对路径，不返回 content（Task 12）", async (t) => {
  const { root, skillDir } = await makeSkill("suspense-chapter-end", VALID_SKILL);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(skillDir, "assets"));
  const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);
  await fs.writeFile(path.join(skillDir, "assets", "cover.png"), payload);
  const skill = await readSkillFile(skillDir, { source: "project" });

  const result = await readSkillResource(skill, "assets/cover.png");
  assert.equal(result.binary, true);
  assert.equal(result.content, undefined, "二进制内容不得进入模型上下文");
  assert.equal(result.bytes, payload.length);
  assert.equal(result.path, await fs.realpath(path.join(skillDir, "assets", "cover.png")));
  assert.ok(Object.isFrozen(result));
});

test("readSkillResource 拒绝通过 symlink 逃逸技能目录的资源", async (t) => {
  const root = makeTemp();
  const skillDir = path.join(root, "suspense-chapter-end");
  await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), VALID_SKILL, "utf8");
  // 逃逸链接放在技能目录顶层（不在 scripts/references/assets 下），枚举不拦截，
  // 单独验证 readSkillResource 自身的 realpath containment。
  const rel = tryCreateEscapeLink(skillDir, root, "evil.txt");
  if (!rel) {
    t.skip("当前环境既不能创建 symlink 也不能创建 junction，跳过逃逸读取测试");
    rmSync(root, { recursive: true, force: true });
    return;
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skill = await readSkillFile(skillDir, { source: "project" });
  await expectRejected(
    readSkillResource(skill, rel),
    "skill_resource_unsafe"
  );
});
