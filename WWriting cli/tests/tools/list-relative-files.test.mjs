// listRelativeFiles（规格 2026-10-07 T5/D16）：递归列创作目录普通文件，
// 跳过点开头目录/文件与 node_modules，路径用 `/` 分隔、路径短者在前、上限截断。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { listRelativeFiles } from '../../src/tools/files.mjs';

const tempRoots = [];
after(async () => {
  await Promise.all(tempRoots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempRoot(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function makeNovelDir(prefix) {
  const root = await makeTempRoot(prefix);
  await fs.mkdir(path.join(root, '设定'), { recursive: true });
  await fs.mkdir(path.join(root, '.git'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  await fs.writeFile(path.join(root, '第一章.md'), '正文', 'utf8');
  await fs.writeFile(path.join(root, 'OUTLINE.md'), '', 'utf8');
  await fs.writeFile(path.join(root, '设定', '人物.md'), '', 'utf8');
  await fs.writeFile(path.join(root, '设定', '.隐藏.md'), '', 'utf8');
  await fs.writeFile(path.join(root, '.git', 'config'), '', 'utf8');
  await fs.writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), '', 'utf8');
  return root;
}

test('递归列出普通文件：跳过点开头与 node_modules，`/` 分隔，路径短者在前', async () => {
  const root = await makeNovelDir('wwriting-files-rel-');
  const files = await listRelativeFiles(root);
  // 长度按字符串（第一章.md 6 < 设定/人物.md 8 < OUTLINE.md 10）。
  assert.deepEqual(files, ['第一章.md', '设定/人物.md', 'OUTLINE.md']);
});

test('上限截断：按「路径短者在前」留前 limit 个；空目录与无效根如实', async () => {
  const root = await makeNovelDir('wwriting-files-limit-');
  const limited = await listRelativeFiles(root, { limit: 2 });
  assert.deepEqual(limited, ['第一章.md', '设定/人物.md']);

  const emptyDir = await makeTempRoot('wwriting-files-empty-');
  assert.deepEqual(await listRelativeFiles(emptyDir), []);

  await assert.rejects(() => listRelativeFiles(''), /需要有效的项目根/);
});
