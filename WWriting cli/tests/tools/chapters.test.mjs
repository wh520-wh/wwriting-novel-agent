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
  // 前情账本每章一行（同路径重复提交/修订取最新生效版本）。
  const continuity = await service.readContinuity({ projectRoot });
  assert.equal(continuity.chapters, 2);
  assert.match(continuity.text, /chapters\/01\.md · 6 字 · 转折/);
  assert.match(continuity.text, /chapters\/02\.md · 3 字/);
});

test('prepareRollback 返回最近一次生效版本内容，并把当前内容先存档为安全快照', async () => {
  const { service, projectRoot } = await makeService('wwriting-ch-rollback-');
  await service.commit({ projectRoot, path: '01.md', text: '已提交的版本', summary: null });
  const target = await service.prepareRollback({ projectRoot, path: '01.md', currentText: '写坏了的当前稿' });

  assert.deepEqual(target, { seq: 1, text: '已提交的版本' });
  // 安全快照真实存在（下一次回滚的保险），但不进前情账本的提交计数。
  const continuity = await service.readContinuity({ projectRoot });
  assert.equal(continuity.chapters, 1);
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
  assert.equal(full.chapters, 5);
  assert.equal(full.truncated, false);
  // 最新一章在最后一行（时间正序）。
  assert.match(full.text.trimEnd().split('\n').pop(), /^05\.md · 3 字 · 摘要5$/);

  const tight = await service.readContinuity({ projectRoot, budgetChars: 60 });
  assert.equal(tight.truncated, true);
  assert.ok(tight.entries < 5, `预算装不下全部，实际 entries=${tight.entries}`);
  // 留下来的是**最新的**几章：最后一行永远是 05.md。
  assert.match(tight.text.trimEnd(), /05\.md · 3 字 · 摘要5$/);
});

test('finalizeRevision 把已提交章节的修订入账：新版本快照 + revision 账本条目', async () => {
  const { service, projectRoot, appDataRoot } = await makeService('wwriting-ch-finalize-');
  await service.commit({ projectRoot, path: '01.md', text: '初稿五个字', summary: '开篇' });
  const finalized = await service.finalizeRevision({
    projectRoot,
    path: '01.md',
    text: '修订后的版本有十个字',
    summary: '转折版',
  });
  // 返回路径、版本号、口径字数（铁律 6：本地统计，不是自报）。
  assert.deepEqual(finalized, { path: '01.md', seq: 2, charsNoSpace: 10 });
  // 修订版快照真实存在且内容逐字一致。
  const workspaceId = (await fs.readdir(path.join(appDataRoot, 'WWriting', 'workspaces')))[0];
  const v2 = await fs.readFile(
    path.join(appDataRoot, 'WWriting', 'workspaces', workspaceId, 'chapters', 'versions', '01.md', '0002.txt'),
    'utf8',
  );
  assert.equal(v2, '修订后的版本有十个字');
  // 账本记的是 revision 条目（不是伪装成第二次定稿的 commit）。
  const ledger = await fs.readFile(path.join(service.rootFor(projectRoot), 'ledger.jsonl'), 'utf8');
  assert.match(ledger, /"kind":"revision"/);
  assert.equal((ledger.match(/"kind":"commit"/g) ?? []).length, 1);
});

test('从未提交过的路径不可入账：一行中文事实拒绝，零写入', async () => {
  const { service, projectRoot } = await makeService('wwriting-ch-finalize-gate-');
  await assert.rejects(
    () => service.finalizeRevision({ projectRoot, path: '09.md', text: '没提交过的章节' }),
    (error) => {
      assert.equal(error instanceof ChapterToolError, true);
      assert.equal(error.code, 'CHAPTER_NOT_COMMITTED');
      assert.equal(typeof error.message, 'string');
      assert.notEqual(error.message, '');
      return true;
    },
  );
  // 零写入：账本与版本目录都不该存在。
  await assert.rejects(() => fs.readFile(path.join(service.rootFor(projectRoot), 'ledger.jsonl'), 'utf8'));
  await assert.rejects(() => fs.readdir(path.join(service.rootFor(projectRoot), 'versions')));
});

test('回滚目标扩为最近一次生效版本：改→入账→回滚→再回滚恢复的都是修订版', async () => {
  const { service, projectRoot } = await makeService('wwriting-ch-rollback-revision-');
  await service.commit({ projectRoot, path: '01.md', text: '唯一提交' });
  await service.finalizeRevision({ projectRoot, path: '01.md', text: '修订版内容' });
  // 第一次回滚：目标是最新的 revision（不是最初的 commit）；安全快照照常先存。
  const first = await service.prepareRollback({ projectRoot, path: '01.md', currentText: '坏稿 A' });
  assert.equal(first.seq, 2);
  assert.equal(first.text, '修订版内容');
  // 再回滚：rollback_save 不是回滚目标，恢复的仍是修订版。
  const second = await service.prepareRollback({ projectRoot, path: '01.md', currentText: first.text });
  assert.equal(second.seq, 2);
  assert.equal(second.text, '修订版内容');
});

test('前情口径随修订更新：每章取最新生效版本的字数与摘要', async () => {
  const { service, projectRoot } = await makeService('wwriting-ch-continuity-revision-');
  await service.commit({ projectRoot, path: '01.md', text: '初稿', summary: '开篇' });
  await service.commit({ projectRoot, path: '02.md', text: '第二章稿' });
  // 修订带新摘要 → 前情用新摘要；02.md 没修订 → 原样。
  await service.finalizeRevision({ projectRoot, path: '01.md', text: '修订后的稿子', summary: '转折' });
  const continuity = await service.readContinuity({ projectRoot, budgetChars: 100000 });
  assert.equal(continuity.chapters, 2, '两章各占一行，revision 不虚增章数');
  const lines = continuity.text.trimEnd().split('\n');
  assert.equal(lines[0], '01.md · 6 字 · 转折');
  assert.equal(lines[1], '02.md · 4 字');
});

test('修订不带摘要时前情保留原摘要，不编不丢', async () => {
  const { service, projectRoot } = await makeService('wwriting-ch-continuity-keep-');
  await service.commit({ projectRoot, path: '01.md', text: '初稿', summary: '开篇' });
  await service.finalizeRevision({ projectRoot, path: '01.md', text: '修订后的稿子' });
  const continuity = await service.readContinuity({ projectRoot, budgetChars: 100000 });
  assert.equal(continuity.text, '01.md · 6 字 · 开篇');
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
