// 服务 read() 与路径安全矩阵（对齐上游 core/skills skill-file.readSkillResource + index.read）：
// 按生效清单解析名字、资源 realpath 不可逃逸、512KiB/1MiB 上限、二进制判定、
// SkillError 错误码与文案逐字对齐上游。全部真实临时目录。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_SKILL_RESOURCE_BYTES, readSkillResource } from '../../src/skills/skill-file.mjs';
import { createSkillService } from '../../src/skills/index.mjs';

const tempRoots = [];
after(async () => {
  await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function makeTempRoot(prefix = 'wwriting-read-') {
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

async function writeResource(skillDir, rel, data) {
  const target = path.join(skillDir, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, data);
  return target;
}

function makeService({ home, project, builtin }) {
  return createSkillService({ userHome: home ?? makeNeverRoot(), builtinRoot: builtin ?? makeNeverRoot() });
}
function makeNeverRoot() {
  const root = path.join(os.tmpdir(), `wwriting-absent-${Math.random().toString(36).slice(2)}`);
  tempRoots.push(root);
  return root;
}

test('read 默认读 SKILL.md：content/path/bytes 齐，path 是真实路径', async () => {
  const project = await makeTempRoot();
  const dir = await writeSkill(path.join(project, 'skills'), 'demo', 'name: demo\ndescription: 测试', '第一行\n第二行');
  const service = makeService({ project });

  const result = await service.read({ projectRoot: project, name: 'demo' });

  assert.equal(result.name, 'demo');
  assert.equal(result.resource, 'SKILL.md');
  assert.match(result.content, /第一行\n第二行/);
  assert.equal(result.path, await fs.realpath(path.join(dir, 'SKILL.md')));
  assert.equal(result.bytes, (await fs.stat(path.join(dir, 'SKILL.md'))).size);
  assert.equal(Object.isFrozen(result), true);
});

test('read 空资源文件：content 为空串、bytes 为 0（空 SKILL.md 过不了发现层，此分支只对资源可达）', async () => {
  const project = await makeTempRoot();
  const dir = await writeSkill(path.join(project, 'skills'), 'empty', 'name: empty\ndescription: d');
  await writeResource(dir, 'references/empty.txt', '');
  const service = makeService({ project });

  const result = await service.read({ projectRoot: project, name: 'empty', resource: 'references/empty.txt' });

  assert.equal(result.content, '');
  assert.equal(result.bytes, 0);
});

test('read 未知名 → skill_not_found「未发现技能: 名字」', async () => {
  const project = await makeTempRoot();
  const service = makeService({ project });

  await assert.rejects(service.read({ projectRoot: project, name: 'nope' }), (error) => {
    assert.equal(error.code, 'skill_not_found');
    assert.equal(error.message, '未发现技能: nope');
    return true;
  });
});

test('read 只按生效清单解析：同名跨根读到项目版，被覆盖副本不可达', async () => {
  const home = await makeTempRoot();
  const project = await makeTempRoot();
  await writeSkill(path.join(home, '.wwriting', 'skills'), 'shared', 'name: shared\ndescription: 全局版', '全局正文');
  await writeSkill(path.join(project, 'skills'), 'shared', 'name: shared\ndescription: 项目版', '项目正文');
  const service = createSkillService({ userHome: home, builtinRoot: makeNeverRoot() });

  const result = await service.read({ projectRoot: project, name: 'shared' });

  assert.match(result.content, /项目正文/);
  assert.doesNotMatch(result.content, /全局正文/);
});

test('read 每次重新发现：目录删掉后再读报 skill_not_found（缓存语义在上层 runId）', async () => {
  const project = await makeTempRoot();
  const dir = await writeSkill(path.join(project, 'skills'), 'gone', 'name: gone\ndescription: d');
  const service = makeService({ project });
  await service.read({ projectRoot: project, name: 'gone' });

  await fs.rm(dir, { recursive: true, force: true });

  await assert.rejects(service.read({ projectRoot: project, name: 'gone' }), { code: 'skill_not_found' });
});

test('resource 可读 references/scripts/assets 下文件，默认才是 SKILL.md', async () => {
  const project = await makeTempRoot();
  const dir = await writeSkill(path.join(project, 'skills'), 'demo', 'name: demo\ndescription: d');
  await writeResource(dir, 'references/deep/guide.txt', '指南正文');
  const service = makeService({ project });

  const result = await service.read({ projectRoot: project, name: 'demo', resource: 'references/deep/guide.txt' });

  assert.equal(result.resource, 'references/deep/guide.txt');
  assert.equal(result.content, '指南正文');
});

test('resource 非法形态一律 skill_resource_unsafe，文案逐字对齐上游', async () => {
  const project = await makeTempRoot();
  await writeSkill(path.join(project, 'skills'), 'demo', 'name: demo\ndescription: d');
  const service = makeService({ project });
  const cases = [
    ['', '资源路径不能为空'],
    ['C:\\evil.md', '资源路径不能是绝对路径: C:\\evil.md'],
    ['/etc/passwd', '资源路径不能是绝对路径: /etc/passwd'],
    ['../escape.md', '资源路径不能包含 ../ 穿越: ../escape.md'],
    ['assets\\..\\..\\x.md', '资源路径不能包含 ../ 穿越: assets\\..\\..\\x.md'],
    ['a//b.md', '资源路径格式非法: a//b.md'],
  ];
  for (const [resource, message] of cases) {
    await assert.rejects(service.read({ projectRoot: project, name: 'demo', resource }), (error) => {
      assert.equal(error.code, 'skill_resource_unsafe');
      assert.equal(error.message, message);
      return true;
    });
  }
});

test('resource 不存在与非普通文件都报 skill_resource_not_found（区分文案）', async () => {
  const project = await makeTempRoot();
  const dir = await writeSkill(path.join(project, 'skills'), 'demo', 'name: demo\ndescription: d');
  await fs.mkdir(path.join(dir, 'references', 'folder'), { recursive: true });
  const service = makeService({ project });

  await assert.rejects(
    service.read({ projectRoot: project, name: 'demo', resource: 'references/none.txt' }),
    (error) => {
      assert.equal(error.code, 'skill_resource_not_found');
      assert.equal(error.message, '资源不存在: references/none.txt');
      return true;
    },
  );
  await assert.rejects(
    service.read({ projectRoot: project, name: 'demo', resource: 'references/folder' }),
    (error) => {
      assert.equal(error.code, 'skill_resource_not_found');
      assert.equal(error.message, '资源不是文件: references/folder');
      return true;
    },
  );
});

test('资源超 1MiB → skill_resource_too_large', async () => {
  const project = await makeTempRoot();
  const dir = await writeSkill(path.join(project, 'skills'), 'demo', 'name: demo\ndescription: d');
  await writeResource(dir, 'references/big.txt', 'x'.repeat(MAX_SKILL_RESOURCE_BYTES + 1));
  const service = makeService({ project });

  await assert.rejects(
    service.read({ projectRoot: project, name: 'demo', resource: 'references/big.txt' }),
    (error) => {
      assert.equal(error.code, 'skill_resource_too_large');
      assert.match(error.message, /超过 1048576 字节/);
      return true;
    },
  );
});

test('二进制资源（前 8KiB 含 NUL）：只报 binary/path/bytes，不产生 content', async () => {
  const project = await makeTempRoot();
  const dir = await writeSkill(path.join(project, 'skills'), 'demo', 'name: demo\ndescription: d');
  const target = await writeResource(dir, 'assets/logo.bin', Buffer.from([0x89, 0x00, 0x01, 0x50]));
  const service = makeService({ project });

  const result = await service.read({ projectRoot: project, name: 'demo', resource: 'assets/logo.bin' });

  assert.equal(result.binary, true);
  assert.equal(result.path, await fs.realpath(target));
  assert.equal(result.bytes, 4);
  assert.equal('content' in result, false);
});

test('readSkillResource 直接调用：SKILL.md 用 512KiB 上限（发现层挡不住的场景）', async () => {
  const project = await makeTempRoot();
  const dir = path.join(project, 'huge');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), 'x'.repeat(512 * 1024 + 1), 'utf8');
  const skill = { name: 'huge', dir };

  await assert.rejects(readSkillResource(skill, 'SKILL.md'), (error) => {
    assert.equal(error.code, 'skill_resource_too_large');
    assert.match(error.message, /超过 524288 字节/);
    return true;
  });
});
