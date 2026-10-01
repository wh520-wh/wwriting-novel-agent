// SKILL.md 解析契约（对齐上游 core/skills/skill-file，冻结契约 §2.5）：
// frontmatter 拆分与校验、name 必须等于目录名（Windows 大小写归一）、512KiB 上限、
// resources 枚举（scripts/references/assets，realpath 逃逸拒绝）、SkillError 错误形态。
// 全部用真实临时目录，不 mock fs。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_SKILL_FILE_BYTES,
  readSkillFile,
  skillError,
  skillNamesEqual,
} from '../../src/skills/skill-file.mjs';

const tempRoots = [];
after(async () => {
  await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function makeTempRoot(prefix = 'wwriting-skill-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function writeSkill(root, dirName, content, extraFiles = null) {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), content, 'utf8');
  if (extraFiles) {
    for (const [rel, data] of Object.entries(extraFiles)) {
      const target = path.join(dir, rel);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, data);
    }
  }
  return dir;
}

const VALID = [
  '---',
  'name: demo',
  'description: 测试技能',
  'version: 1.0.0',
  'metadata:',
  '  wwriting:',
  '    category: genre',
  '    display_name: 悬疑',
  '---',
  '',
  '# 正文',
  '',
  '第一段。',
  '',
].join('\n');

test('合法包解析：frontmatter 透传 + body 去掉闭合 fence 后首个空行 + dir/source 挂上 + 深冻结', async () => {
  const root = await makeTempRoot();
  const dir = await writeSkill(root, 'demo', VALID);

  const skill = await readSkillFile(dir, { source: 'project' });

  assert.equal(skill.name, 'demo');
  assert.equal(skill.description, '测试技能');
  assert.equal(skill.version, '1.0.0');
  assert.equal(skill.metadata.wwriting.category, 'genre');
  assert.equal(skill.metadata.wwriting.display_name, '悬疑');
  assert.equal(skill.body, '# 正文\n\n第一段。\n'); // 文件末尾换行保留在 body 里
  assert.equal(skill.dir, dir);
  assert.equal(skill.source, 'project');
  assert.deepEqual(skill.resources, []);
  assert.equal(Object.isFrozen(skill), true);
  assert.equal(Object.isFrozen(skill.metadata), true);
});

test('缺 name → skill_missing_name，消息里带目录名', async () => {
  const root = await makeTempRoot();
  const dir = await writeSkill(root, 'noname', '---\ndescription: 无名\n---\n正文');

  await assert.rejects(readSkillFile(dir, { source: 'project' }), (error) => {
    assert.equal(error.name, 'SkillError');
    assert.equal(error.code, 'skill_missing_name');
    assert.match(error.message, /noname/);
    return true;
  });
});

test('name 与目录名不符 → skill_name_mismatch；大小写变体按平台口径比较', async () => {
  const root = await makeTempRoot();
  const dir = await writeSkill(root, 'elsewhere', '---\nname: demo\ndescription: d\n---\n正文');

  await assert.rejects(readSkillFile(dir, { source: 'project' }), { code: 'skill_name_mismatch' });

  // R5-11：Windows 文件系统大小写不敏感，大小写变体视为同一技能；POSIX 敏感。
  assert.equal(skillNamesEqual('Demo', 'demo'), process.platform === 'win32');
});

test('缺开 fence 与缺闭 fence 都报 skill_missing_frontmatter', async () => {
  const root = await makeTempRoot();
  const noOpen = await writeSkill(root, 'no-open', 'name: demo\n---\n正文');
  const noClose = await writeSkill(root, 'no-close', '---\nname: demo\n正文');

  await assert.rejects(readSkillFile(noOpen, { source: 'project' }), { code: 'skill_missing_frontmatter' });
  await assert.rejects(readSkillFile(noClose, { source: 'project' }), { code: 'skill_missing_frontmatter' });
});

test('frontmatter 不是合法 YAML → skill_invalid_yaml', async () => {
  const root = await makeTempRoot();
  const dir = await writeSkill(root, 'bad-yaml', '---\nname: [demo\n---\n正文');

  await assert.rejects(readSkillFile(dir, { source: 'project' }), { code: 'skill_invalid_yaml' });
});

test('SKILL.md 超 512KiB → skill_file_too_large', async () => {
  const root = await makeTempRoot();
  const big = `---\nname: big\ndescription: d\n---\n${'字'.repeat(MAX_SKILL_FILE_BYTES)}`;
  const dir = await writeSkill(root, 'big', big);

  await assert.rejects(readSkillFile(dir, { source: 'project' }), { code: 'skill_file_too_large' });
});

test('目录里没有 SKILL.md → skill_file_not_found', async () => {
  const root = await makeTempRoot();
  const dir = path.join(root, 'empty');
  await fs.mkdir(dir, { recursive: true });

  await assert.rejects(readSkillFile(dir, { source: 'project' }), { code: 'skill_file_not_found' });
});

test('resources 枚举 scripts/references/assets 下文件并按 rel 排序，其他子目录不入列', async () => {
  const root = await makeTempRoot();
  const dir = await writeSkill(root, 'demo', VALID, {
    'scripts/run.md': 'run',
    'references/deep/guide.txt': 'guide-guide',
    'assets/logo.bin': 'ok',
    'other/ignored.md': 'no',
  });

  const skill = await readSkillFile(dir, { source: 'builtin' });

  assert.deepEqual(skill.resources.map((item) => item.rel), [
    'assets/logo.bin',
    'references/deep/guide.txt',
    'scripts/run.md',
  ]);
  for (const item of skill.resources) {
    assert.equal(Object.isFrozen(item), true);
    assert.equal(item.abs, await fs.realpath(path.join(dir, item.rel)));
    assert.equal(item.bytes, Buffer.byteLength(item.rel === 'references/deep/guide.txt' ? 'guide-guide' : item.rel === 'scripts/run.md' ? 'run' : 'ok'));
  }
});

test('资源 symlink 逃逸技能目录 → 整个技能被拒（skill_resource_unsafe）；悬空 symlink 跳过不报错', async () => {
  const root = await makeTempRoot();
  const outside = path.join(root, 'outside-secret.txt');
  await fs.writeFile(outside, 'secret', 'utf8');
  const dir = await writeSkill(root, 'demo', VALID);
  let symlinkOk = true;
  try {
    await fs.symlink(outside, path.join(dir, 'assets', 'escape.link'));
  } catch {
    symlinkOk = false; // Windows 无符号链接特权：平台能力缺失，跳过本用例的逃逸断言
  }
  if (!symlinkOk) return;

  await assert.rejects(readSkillFile(dir, { source: 'project' }), { code: 'skill_resource_unsafe' });

  const dangling = await writeSkill(root, 'dangling', VALID);
  try {
    await fs.symlink(path.join(root, 'not-exists.txt'), path.join(dangling, 'assets', 'dangling.link'));
  } catch {
    return;
  }
  const skill = await readSkillFile(dangling, { source: 'project' });
  assert.deepEqual(skill.resources, []);
});

test('skillError 产出 name=SkillError 的小写下划线码错误', () => {
  const error = skillError('skill_not_found', '未发现技能: x');
  assert.equal(error.name, 'SkillError');
  assert.equal(error.code, 'skill_not_found');
  assert.equal(error.message, '未发现技能: x');
});
