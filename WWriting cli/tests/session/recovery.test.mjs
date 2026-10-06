// 重启恢复测试：未闭合的模型轮、未闭合工具调用、排队输入与已完成历史。
// 恢复规则：未闭合 Run 收敛为 interrupted；排队输入作为用户数据保留；
// 绝不自动开始新的 Run、绝不自动重复执行未知写入。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { createWorkspaceStore } from '../../src/storage/workspace-store.mjs';
import { createEventStore } from '../../src/session/event-store.mjs';
import { createSessionManager } from '../../src/session/session-manager.mjs';
import { recoverSession } from '../../src/session/recovery.mjs';

// 临时目录登记：测试结束时统一删除。
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

test('recoverSession：未闭合 Run 收敛为 interrupted；干净会话不追加事件（幂等）', async () => {
  const root = await makeTempRoot('wwriting-rec-unit-');
  const dir = path.join(root, 'sess-1');
  const store = createEventStore({ sessionDir: dir, clock: makeClock(), idFactory: makeIdFactory() });

  await store.append({ type: 'session_created', session_id: 'sess-1', data: {} });
  await store.append({ type: 'input_submitted', data: { input_id: 'in-1', text: '第一章' } });
  await store.append({ type: 'run_started', run_id: 'run-1', data: { input_id: 'in-1' } });

  const result = await recoverSession({ eventStore: store });
  assert.equal(result.recovered, true);
  assert.deepEqual(result.interruptedRunIds, ['run-1']);
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0].type, 'run_interrupted');
  assert.equal(result.events[0].run_id, 'run-1');
  assert.deepEqual(result.events[0].data, { reason: 'process_exited' });
  assert.equal(result.events[1].type, 'session_recovered');
  assert.deepEqual(result.events[1].data, { runs: ['run-1'], queued_count: 0, truncated_tail: false });

  const { projection } = await store.rebuildProjection();
  assert.equal(projection.status, 'interrupted');

  // 再次恢复：无未闭合 Run，不追加事件。
  const second = await recoverSession({ eventStore: store });
  assert.equal(second.recovered, false);
  assert.deepEqual(second.events, []);
  assert.equal((await store.readAll()).events.length, 5);

  // 干净会话：没有任何未闭合 Run。
  const cleanDir = path.join(root, 'sess-2');
  const cleanStore = createEventStore({ sessionDir: cleanDir, clock: makeClock(), idFactory: makeIdFactory() });
  await cleanStore.append({ type: 'session_created', session_id: 'sess-2', data: {} });
  const clean = await recoverSession({ eventStore: cleanStore });
  assert.equal(clean.recovered, false);
  assert.deepEqual(clean.events, []);
});

test('重启恢复：未闭合模型轮与工具调用收敛为 interrupted，排队输入保留，绝不自动执行', async () => {
  const root = await makeTempRoot('wwriting-rec-crash-');
  const projectRoot = path.join(root, 'novel');
  const manager = makeManager(root);

  const session = await manager.create(projectRoot);
  const first = await session.submit({ text: '写第一章' });
  await session.append({ type: 'run_started', run_id: 'run-1', data: { input_id: first.input_id } });
  // 未闭合的工具调用（activity_started 没有 activity_finished）。
  await session.append({ type: 'activity_started', run_id: 'run-1', data: { activity: 'write_file', target: '第一章.md' } });
  const second = await session.submit({ text: '继续写' });
  const third = await session.submit({ text: '检查大纲' });
  assert.deepEqual(session.projection.queue.map((item) => item.text), ['继续写', '检查大纲']);
  const sessionId = session.sessionId;
  await session.close(); // 崩溃后锁的回收属 Task 2 职责，这里只留事件现场。

  const reopened = await manager.openById(projectRoot, sessionId);
  try {
    const projection = reopened.projection;
    assert.equal(projection.status, 'interrupted');
    assert.equal(projection.active_run_id, null);
    assert.equal(projection.active_input_id, null);
    assert.equal(projection.active_input, null);

    // 排队输入是用户数据，原样保留。
    assert.deepEqual(projection.queue.map((item) => item.input_id), [second.input_id, third.input_id]);
    assert.deepEqual(projection.queue.map((item) => item.text), ['继续写', '检查大纲']);

    // 恢复事件落盘；绝不出现新的 run_started，被打断的输入也不重新排队。
    const { events } = await reopened.eventStore.readAll();
    const types = events.map((event) => event.type);
    assert.equal(types.filter((type) => type === 'run_started').length, 1);
    assert.equal(types.filter((type) => type === 'run_interrupted').length, 1);

    const interrupted = events.find((event) => event.type === 'run_interrupted');
    assert.equal(interrupted.run_id, 'run-1');
    assert.equal(interrupted.data.reason, 'process_exited');

    const recoveredEvent = events.find((event) => event.type === 'session_recovered');
    assert.deepEqual(recoveredEvent.data.runs, ['run-1']);
    assert.equal(recoveredEvent.data.queued_count, 2);
    assert.equal(recoveredEvent.data.truncated_tail, false);

    // 被打断输入的文本仍在日志中（可手动重发），但既不在活跃位也不回队列。
    const submitted = events.find((event) => event.type === 'input_submitted');
    assert.equal(submitted.data.text, '写第一章');
    assert.equal(submitted.data.input_id, first.input_id);
    assert.ok(!projection.queue.some((item) => item.input_id === first.input_id));
    assert.equal(types.at(-1), 'session_recovered');
  } finally {
    await reopened.close();
  }
});

test('重启恢复：已完成历史不追加恢复事件，状态保持 idle，重开幂等', async () => {
  const root = await makeTempRoot('wwriting-rec-clean-');
  const projectRoot = path.join(root, 'novel');
  const manager = makeManager(root);

  const session = await manager.create(projectRoot);
  const first = await session.submit({ text: '序章' });
  await session.append({ type: 'run_started', run_id: 'run-1', data: { input_id: first.input_id } });
  await session.append({ type: 'run_completed', run_id: 'run-1', data: {} });
  const sessionId = session.sessionId;
  await session.close();

  const reopened = await manager.openById(projectRoot, sessionId);
  try {
    const { events } = await reopened.eventStore.readAll();
    assert.equal(events.some((event) => event.type === 'session_recovered'), false);
    assert.equal(events.some((event) => event.type === 'run_interrupted'), false);
    assert.equal(reopened.projection.status, 'idle');
    const count = events.length;
    await reopened.close();

    // 第二次打开同样不追加任何事件。
    const again = await manager.openById(projectRoot, sessionId);
    try {
      const { events: eventsAgain } = await again.eventStore.readAll();
      assert.equal(eventsAgain.length, count);
    } finally {
      await again.close();
    }
  } finally {
    await reopened.close().catch(() => {});
  }
});

test('重启恢复：state.json 损坏与未闭合 Run 一次修复到位', async () => {
  const root = await makeTempRoot('wwriting-rec-state-');
  const projectRoot = path.join(root, 'novel');
  const manager = makeManager(root);

  const session = await manager.create(projectRoot);
  const first = await session.submit({ text: '第一章' });
  await session.append({ type: 'run_started', run_id: 'run-1', data: { input_id: first.input_id } });
  const sessionDir = session.directory;
  const sessionId = session.sessionId;
  await session.close();

  // 缓存损坏 + 未闭合 Run 同时存在。
  await fs.writeFile(path.join(sessionDir, 'state.json'), '{broken', 'utf8');

  const reopened = await manager.openById(projectRoot, sessionId);
  try {
    assert.equal(reopened.projection.status, 'interrupted');
    // 4 个原始事件（首条输入与自动标题同批次，规格 2026-10-07 D2）+ run_interrupted + session_recovered
    assert.equal(reopened.projection.last_seq, 6);
    const state = JSON.parse(await fs.readFile(path.join(reopened.directory, 'state.json'), 'utf8'));
    assert.equal(state.status, 'interrupted');
    assert.equal(state.last_seq, reopened.projection.last_seq);
  } finally {
    await reopened.close();
  }
});

test('重启恢复：截断尾行与未闭合 Run 同时出现时恢复事实完整', async () => {
  const root = await makeTempRoot('wwriting-rec-tail-');
  const projectRoot = path.join(root, 'novel');
  const manager = makeManager(root);

  const session = await manager.create(projectRoot);
  const first = await session.submit({ text: '第一章' });
  await session.append({ type: 'run_started', run_id: 'run-1', data: { input_id: first.input_id } });
  const sessionId = session.sessionId;
  await session.close();

  // 崩溃时正在写入的下一行只留下一半。
  // 崩溃时正在写入的下一行只留下一半（首条输入与自动标题同批次后，真实下一个 seq 是 5）。
  await fs.appendFile(path.join(session.directory, 'events.jsonl'), '{"schema_version":1,"seq":5,"type":"run_sta', 'utf8');

  const reopened = await manager.openById(projectRoot, sessionId);
  try {
    const { events } = await reopened.eventStore.readAll();
    assert.equal(events[4].type, 'log_tail_truncated');
    assert.equal(events[4].seq, 5);

    const recoveredEvent = events.find((event) => event.type === 'session_recovered');
    assert.equal(recoveredEvent.data.truncated_tail, true);
    assert.equal(reopened.projection.status, 'interrupted');
    assert.equal(reopened.projection.last_seq, 7); // 截断恢复 + run_interrupted + session_recovered
  } finally {
    await reopened.close();
  }
});
