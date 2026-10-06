// 会话标题与归档（规格 2026-10-07 T1）：自动标题、session_renamed 折算、/rename 落点
// （会话句柄 rename）、归档事件与封面 list() 带标题。
// 与 session-manager.test.mjs 同款纪律：os.tmpdir() 临时目录 + 真实文件系统，零 mock。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { createWorkspaceStore } from '../../src/storage/workspace-store.mjs';
import { createSessionManager, deriveAutoTitle } from '../../src/session/session-manager.mjs';
import { foldEvents } from '../../src/session/event-store.mjs';

const tempRoots = [];
after(async () => {
  await Promise.all(tempRoots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempRoot(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

const FIXED_MS = 1758900000000;
function makeClock() {
  let now = FIXED_MS;
  return () => (now += 1000);
}
function makeIdFactory(prefix = 'id') {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

function makeManager(appDataRoot) {
  const workspaceStore = createWorkspaceStore({ appDataRoot, clock: makeClock() });
  return createSessionManager({ workspaceStore, clock: makeClock(), idFactory: makeIdFactory() });
}

function event(seq, type, data, overrides = {}) {
  return {
    schema_version: 1,
    seq,
    event_id: `e${seq}`,
    at: '2026-10-07T00:00:00.000Z',
    type,
    session_id: 's1',
    run_id: null,
    data,
    ...overrides,
  };
}

test('deriveAutoTitle：首行、空白压一、斜杠命令不起名、按码点截断', () => {
  assert.equal(deriveAutoTitle('写第一章\n第二行不算'), '写第一章');
  assert.equal(deriveAutoTitle('  写  第一章  '), '写 第一章');
  assert.equal(deriveAutoTitle('/init'), null);
  assert.equal(deriveAutoTitle('   '), null);
  assert.equal(deriveAutoTitle(''), null);
  const long = Array.from({ length: 30 }, (_, i) => `字${i}`).join('');
  assert.equal(Array.from(deriveAutoTitle(long)).length, 24);
  // 代理对不劈半：emoji 按码点截，不产生半个 surrogate。
  assert.equal(deriveAutoTitle('👍'.repeat(30)), '👍'.repeat(24));
});

test('session_renamed 折算：非空生效，空串与畸形不更新只推进 seq', () => {
  const projection = foldEvents([
    event(1, 'session_created', {}),
    event(2, 'session_renamed', { title: '长夜灯' }),
    event(3, 'session_renamed', { title: '' }),
    event(4, 'session_renamed', { title: 42 }),
    event(5, 'session_renamed', {}),
    event(6, 'session_renamed', { title: '第二卷' }),
  ]);
  assert.equal(projection.title, '第二卷');
  assert.equal(projection.last_seq, 6);
});

test('首条输入自动起标题：与输入事件同批次，第二条不覆盖', async () => {
  const root = await makeTempRoot('wwriting-title-auto-');
  const projectRoot = path.join(root, 'novel');
  const manager = makeManager(root);
  const session = await manager.create(projectRoot);
  try {
    await session.submit({ text: '写第一章，主角进京赶考' });
    assert.equal(session.projection.title, '写第一章，主角进京赶考');

    const { events } = await session.eventStore.readAll();
    const renamed = events.find((item) => item.type === 'session_renamed');
    const submitted = events.find((item) => item.type === 'input_submitted');
    assert.ok(renamed, '自动标题事件已落盘');
    // 同一批次：renamed 的 seq 紧挨着输入事件（appendBatch 单批原子，state.json 只重写一次）。
    assert.equal(renamed.seq, submitted.seq - 1);
    assert.equal(renamed.data.title, '写第一章，主角进京赶考');

    await session.submit({ text: '继续写第二章' });
    assert.equal(session.projection.title, '写第一章，主角进京赶考', '已有标题不被后续输入覆盖');
  } finally {
    await session.close();
  }
});

test('首条输入是斜杠命令：不起标题；队列路径同样兜底', async () => {
  const root = await makeTempRoot('wwriting-title-slash-');
  const manager = makeManager(root);
  const session = await manager.create(root);
  try {
    await session.submit({ text: '/init' });
    assert.equal(session.projection.title, '', '斜杠命令不是对话内容');
    await session.enqueue({ text: '排队的正文不算首条对话' });
    assert.equal(session.projection.title, '排队的正文不算首条对话');
  } finally {
    await session.close();
  }
});

test('create 时已有标题：自动标题永不覆盖', async () => {
  const root = await makeTempRoot('wwriting-title-keep-');
  const manager = makeManager(root);
  const session = await manager.create(root, { title: '书名' });
  try {
    await session.submit({ text: '写第一章' });
    assert.equal(session.projection.title, '书名');
  } finally {
    await session.close();
  }
});

test('rename：改名生效、截 64 字、空标题拒绝', async () => {
  const root = await makeTempRoot('wwriting-title-rename-');
  const manager = makeManager(root);
  const session = await manager.create(root);
  try {
    await session.submit({ text: '写第一章' });
    const renamed = await manager.rename(session, ' 新标题  ');
    assert.equal(renamed.title, '新标题');
    assert.equal(session.projection.title, '新标题');

    const long = '字'.repeat(80);
    const capped = await manager.rename(session, long);
    assert.equal(capped.title.length, 64);

    await assert.rejects(() => manager.rename(session, '   '), /会话标题不能为空/);
    // 多行标题取首行（行标签是一行事实，标题里不该有换行）。
    const multiline = await manager.rename(session, '第一行\n第二行不算');
    assert.equal(multiline.title, '第一行');
  } finally {
    await session.close();
  }
});

test('归档与封面：append session_archived 后 list() 读到 archived 与标题', async () => {
  const root = await makeTempRoot('wwriting-title-archive-');
  const projectRoot = path.join(root, 'novel');
  const manager = makeManager(root);
  const session = await manager.create(projectRoot);
  try {
    await session.submit({ text: '写第一章' });
    await session.append({ type: 'session_archived' });
    assert.equal(session.projection.status, 'archived');
  } finally {
    await session.close();
  }
  const summaries = await manager.list(projectRoot);
  const summary = summaries.find((item) => item.session_id === session.sessionId);
  assert.equal(summary.status, 'archived');
  assert.equal(summary.title, '写第一章');
});
