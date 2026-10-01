// 章节服务测试：提交/回滚/前情的私有存储语义。
// 全部用 os.tmpdir() 临时目录 + 真实文件系统，零 mock（clock 注入定值）。
// 断言的都是「下一轮要用的事实」：版本可恢复、账本只记提交、安全快照不进前情。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { ChapterToolError, createChapterService } from '../../src/tools/chapters.mjs';

const tempRoots = [];
after(async () => {
  await Promise.all(tempRoots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeService(prefix) {
  const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(appDataRoot);
  let now = 1758900000000;
  const clock = () => (now += 1000);
  const service = createChapterService({ appDataRoot, clock });
  const projectRoot = path.join(appDataRoot, 'novel');
  await fs.mkdir(projectRoot, { recursive: true });
  return { service, projectRoot, appDataRoot };
}

test('commit 存版本 + 记账；同一路径 seq 递增，不同路径互不干扰', async () => {
  const { service, projectRoot, appDataRoot } = await makeService('wwriting-ch-commit-');
  const first = await service.commit({ projectRoot, path: 'chapters/01.md', text: '第一章内容', summary: '主角出发' });
  const second = await service.commit({ projectRoot, path: 'chapters/01.md', text: '第一章改完了', summary: '转折' });
  await service.commit({ projectRoot, path: 'chapters/02.md', text: '第二章' });

  assert.deepEqual(first, { path: 'chapters/01.md', seq: 1, charsNoSpace: 5 });
  assert.equal(second.seq, 2);
  // 版本文件真实存在且内容逐字一致（恢复就靠它）。
  const v1 = await fs.readFile(path.join(appDataRoot, 'WWriting', 'workspaces', (await fs.readdir(path.join(appDataRoot, 'WWriting', 'workspaces')))[0], 'chapters', 'versions', 'chapters', '01.md', '0001.txt'), 'utf8');
  assert.equal(v1, '第一章内容');
  // 前情账本只有提交（此刻还没有回滚快照）。
  const continuity = await service.readContinuity({ projectRoot });
  assert.equal(continuity.commits, 3);
  assert.match(continuity.text, /chapters\/01\.md · 5 字 · 主角出发/);
  assert.match(continuity.text, /chapters\/02\.md · 3 字/);
});

test('prepareRollback 返回最近一次提交内容，并把当前内容先存档为安全快照', async () => {
  const { service, projectRoot } = await makeService('wwriting-ch-rollback-');
  await service.commit({ projectRoot, path: '01.md', text: '已提交的版本', summary: null });
  const target = await service.prepareRollback({ projectRoot, path: '01.md', currentText: '写坏了的当前稿' });

  assert.deepEqual(target, { seq: 1, text: '已提交的版本' });
  // 安全快照真实存在（下一次回滚的保险），但不进前情账本的提交计数。
  const continuity = await service.readContinuity({ projectRoot });
  assert.equal(continuity.commits, 1);
  const ledger = await fs.readFile(path.join(service.rootFor(projectRoot), 'ledger.jsonl'), 'utf8');
  assert.match(ledger, /"kind":"rollback_save"/);
});

test('没有提交过的路径不可回滚：prepareRollback 返回 null', async () => {
  const { service, projectRoot } = await makeService('wwriting-ch-noversion-');
  const target = await service.prepareRollback({ projectRoot, path: '09.md', currentText: '随便什么' });
  assert.equal(target, null);
});

test('回滚两次都恢复同一次提交（回滚快照不是回滚目标）', async () => {
  const { service, projectRoot } = await makeService('wwriting-ch-twice-');
  await service.commit({ projectRoot, path: '01.md', text: '唯一提交' });
  const first = await service.prepareRollback({ projectRoot, path: '01.md', currentText: '坏稿 A' });
  const second = await service.prepareRollback({ projectRoot, path: '01.md', currentText: first.text });
  assert.equal(first.text, '唯一提交');
  assert.equal(second.text, '唯一提交');
});

test('readContinuity 预算从最新往前装，截断如实说', async () => {
  const { service, projectRoot } = await makeService('wwriting-ch-budget-');
  for (let i = 1; i <= 5; i += 1) {
    await service.commit({ projectRoot, path: `${String(i).padStart(2, '0')}.md`, text: `第${i}章`, summary: `摘要${i}` });
  }
  const full = await service.readContinuity({ projectRoot, budgetChars: 100000 });
  assert.equal(full.commits, 5);
  assert.equal(full.truncated, false);
  // 最新一章在最后一行（时间正序）。
  assert.match(full.text.trimEnd().split('\n').pop(), /^05\.md · 3 字 · 摘要5$/);

  const tight = await service.readContinuity({ projectRoot, budgetChars: 60 });
  assert.equal(tight.truncated, true);
  assert.ok(tight.entries < 5, `预算装不下全部，实际 entries=${tight.entries}`);
  // 留下来的是**最新的**几章：最后一行永远是 05.md。
  assert.match(tight.text.trimEnd(), /05\.md · 3 字 · 摘要5$/);
});

test('摘要缺省与前导空白：不编事实，只记有的事实', async () => {
  const { service, projectRoot } = await makeService('wwriting-ch-nosummary-');
  await service.commit({ projectRoot, path: '01.md', text: '内容', summary: '   ' });
  const continuity = await service.readContinuity({ projectRoot });
  assert.equal(continuity.text, '01.md · 2 字');
});

test('畸形输入各自有一条中文事实，不抛裸错误', async () => {
  const { service, projectRoot } = await makeService('wwriting-ch-invalid-');
  await assert.rejects(() => service.commit({ projectRoot, path: '', text: 'x' }), (error) => {
    assert.equal(error instanceof ChapterToolError, true);
    assert.equal(error.code, 'CHAPTER_PATH_INVALID');
    return true;
  });
  await assert.rejects(() => service.commit({ projectRoot, path: '01.md', text: '' }), (error) => {
    assert.equal(error.code, 'CHAPTER_TEXT_EMPTY');
    return true;
  });
  await assert.rejects(() => service.commit({ projectRoot, path: '../逃逸.md', text: 'x' }), (error) => {
    assert.equal(error.code, 'CHAPTER_PATH_INVALID');
    return true;
  });
});
