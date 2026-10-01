// 技能清单发现契约（对齐上游 core/skills/catalog，冻结契约 §2.5）：
// 三根扫描（内置/全局/项目，bundled 留口子不做）、项目 > 全局 > 内置 的同名覆盖、
// 坏包隔离进 errors、真实内置 12 包全部可解析、service.catalog 与发现同结果。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverSkills, SKILL_SOURCE_PRIORITY } from '../../src/skills/catalog.mjs';
import { createSkillService } from '../../src/skills/index.mjs';

const REPO_BUILTIN_ROOT = path.resolve(import.meta.dirname, '..', '..', 'src', 'skills');

const tempRoots = [];
after(async () => {
  await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function makeTempRoot(prefix = 'wwriting-catalog-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function writeSkill(root, dirName, frontmatter, body = '正文') {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`, 'utf8');
  return dir;
}

test('内置根：仓库里的 12 个技能包全部解析生效，分类与展示名照上游', async () => {
  const found = await discoverSkills({ projectRoot: null, userHome: null, builtinRoot: REPO_BUILTIN_ROOT });

  assert.deepEqual(
    found.active.map((skill) => skill.name).sort(),
    [
      'avoid-ai-voice', 'balanced', 'chapter-opening-hook', 'dialogue-driven', 'dialogue-not-summary',
      'fast-readable', 'genre-detective', 'genre-suspense', 'payoff-pacing', 'psychological-literary',
      'show-dont-tell', 'suspense-chapter-end',
    ],
  );
  assert.deepEqual(found.errors, []);
  for (const skill of found.active) {
    assert.equal(skill.source, 'builtin');
    assert.equal(typeof skill.description, 'string');
    assert.ok(skill.description.length > 0);
  }
  // 分类映射（上游 CATEGORY_TAGS 的数据面）：writing-style→基座、style-modifier→修饰、genre→流派；
  // 三个旧式包无分类，照上游行为不带标签。
  const categoryOf = Object.fromEntries(found.active.map((skill) => [skill.name, skill.category]));
  assert.deepEqual(categoryOf['genre-suspense'], 'genre');
  assert.deepEqual(categoryOf['genre-detective'], 'genre');
  assert.deepEqual(categoryOf['balanced'], 'writing-style');
  assert.deepEqual(categoryOf['fast-readable'], 'writing-style');
  assert.deepEqual(categoryOf['psychological-literary'], 'writing-style');
  assert.deepEqual(categoryOf['chapter-opening-hook'], 'style-modifier');
  assert.deepEqual(categoryOf['dialogue-driven'], 'style-modifier');
  assert.deepEqual(categoryOf['payoff-pacing'], 'style-modifier');
  assert.deepEqual(categoryOf['suspense-chapter-end'], 'style-modifier');
  for (const legacy of ['avoid-ai-voice', 'dialogue-not-summary', 'show-dont-tell']) {
    assert.deepEqual(categoryOf[legacy], null, `${legacy} 无分类`);
  }
  const byName = Object.fromEntries(found.active.map((skill) => [skill.name, skill]));
  assert.equal(byName['genre-suspense'].display_name, '悬疑');
  assert.equal(byName['show-dont-tell'].display_name, 'show-dont-tell'); // display_name 缺省回落 name
});

test('同名跨根覆盖：项目 > 全局 > 内置，低优先级副本按处理顺序进被覆盖', async () => {
  const home = await makeTempRoot();
  const project = await makeTempRoot();
  const builtin = await makeTempRoot();
  await writeSkill(builtin, 'shared', 'name: shared\ndescription: 内置版', '内置正文');
  await writeSkill(path.join(home, '.wwriting', 'skills'), 'shared', 'name: shared\ndescription: 全局版', '全局正文');
  await writeSkill(path.join(project, 'skills'), 'shared', 'name: shared\ndescription: 项目版', '项目正文');

  const found = await discoverSkills({ projectRoot: project, userHome: home, builtinRoot: builtin });

  assert.equal(found.active.length, 1);
  assert.equal(found.active[0].source, 'project');
  assert.match(found.active[0].body, /项目正文/);
  assert.deepEqual(found.shadowed.map((skill) => skill.source), ['builtin', 'global']);
  assert.deepEqual(found.errors, []);
});

test('项目根缺 skills 目录、全局根缺 .wwriting 都不报错，各层为空', async () => {
  const home = await makeTempRoot();
  const project = await makeTempRoot();
  const builtin = await makeTempRoot();
  await writeSkill(builtin, 'only', 'name: only\ndescription: 唯一');

  const found = await discoverSkills({ projectRoot: project, userHome: home, builtinRoot: builtin });

  assert.equal(found.active.length, 1);
  assert.equal(found.active[0].source, 'builtin');
});

test('坏包隔离：frontmatter 违约只进 errors，好包照常生效', async () => {
  const home = await makeTempRoot();
  const project = await makeTempRoot();
  const skills = path.join(project, 'skills');
  await writeSkill(skills, 'good', 'name: good\ndescription: 好包');
  await writeSkill(skills, 'noname', 'description: 没名字');
  await writeSkill(skills, 'badyaml', 'name: [x');

  const found = await discoverSkills({ projectRoot: project, userHome: home, builtinRoot: null });

  assert.deepEqual(found.active.map((skill) => skill.name), ['good']);
  assert.equal(found.errors.length, 2);
  const badDirs = found.errors.map((item) => path.basename(item.dir)).sort();
  assert.deepEqual(badDirs, ['badyaml', 'noname']);
  for (const item of found.errors) {
    assert.equal(typeof item.error, 'string');
  }
});

test('无 SKILL.md 的子目录与普通文件都静默跳过；同根两包共存', async () => {
  const home = await makeTempRoot();
  const project = await makeTempRoot();
  const skills = path.join(project, 'skills');
  await writeSkill(skills, 'alpha', 'name: alpha\ndescription: 甲');
  await writeSkill(skills, 'beta', 'name: beta\ndescription: 乙');
  await fs.mkdir(path.join(skills, 'not-a-skill'), { recursive: true });
  await fs.writeFile(path.join(skills, 'loose-file.txt'), '不是目录', 'utf8');

  const found = await discoverSkills({ projectRoot: project, userHome: home, builtinRoot: null });

  assert.deepEqual(found.active.map((skill) => skill.name).sort(), ['alpha', 'beta']);
  assert.deepEqual(found.errors, []);
});

test('自建包无 metadata 时 display_name 回落 name、category 为 null；结果与条目全部冻结', async () => {
  const home = await makeTempRoot();
  await writeSkill(path.join(home, '.wwriting', 'skills'), 'plain', 'name: plain\ndescription: 朴素包');

  const found = await discoverSkills({ projectRoot: null, userHome: home, builtinRoot: null });

  assert.equal(found.active.length, 1);
  assert.equal(found.active[0].display_name, 'plain');
  assert.equal(found.active[0].category, null);
  assert.equal(Object.isFrozen(found), true);
  assert.equal(Object.isFrozen(found.active), true);
  assert.equal(Object.isFrozen(found.shadowed), true);
  assert.equal(Object.isFrozen(found.errors), true);
  assert.equal(Object.isFrozen(found.active[0]), true);
});

test('SKILL_SOURCE_PRIORITY 冻结契约照上游：builtin < bundled < global < project', () => {
  assert.deepEqual(SKILL_SOURCE_PRIORITY, { builtin: 0, bundled: 1, global: 2, project: 3 });
  assert.equal(Object.isFrozen(SKILL_SOURCE_PRIORITY), true);
});

test('service.catalog 与 discoverSkills 同结果（同一注入根）', async () => {
  const home = await makeTempRoot();
  const project = await makeTempRoot();
  const builtin = await makeTempRoot();
  await writeSkill(builtin, 'b-one', 'name: b-one\ndescription: 一');
  await writeSkill(path.join(home, '.wwriting', 'skills'), 'g-one', 'name: g-one\ndescription: 二');
  await writeSkill(path.join(project, 'skills'), 'p-one', 'name: p-one\ndescription: 三');

  const service = createSkillService({ userHome: home, builtinRoot: builtin });
  const catalog = await service.catalog({ projectRoot: project });
  const direct = await discoverSkills({ projectRoot: project, userHome: home, builtinRoot: builtin });

  assert.deepEqual(JSON.parse(JSON.stringify(catalog)), JSON.parse(JSON.stringify(direct)));
  assert.equal(catalog.active.length, 3);
});
