// 会话与队列行为测试：新建、继续最近会话、指定 ID 恢复、FIFO 排队、
// promote 只移动一个输入、撤回排队项、运行结束后临时授权清空、跨进程独占写入。
// 全部使用 os.tmpdir() 下的临时目录与真实文件系统，零 mock。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createWorkspaceStore, workspaceIdForPath } from '../../src/storage/workspace-store.mjs';
import { createSessionManager } from '../../src/session/session-manager.mjs';

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

// 每个用例独立的管理器：时钟与 ID 全部确定性注入。
function makeManager(appDataRoot) {
  const workspaceStore = createWorkspaceStore({ appDataRoot, clock: makeClock() });
  return createSessionManager({ workspaceStore, clock: makeClock(), idFactory: makeIdFactory() });
}

test('create 新建会话：目录布局、写锁与初始投影', async () => {
  const root = await makeTempRoot('wwriting-mgr-create-');
  const projectRoot = path.join(root, 'novel');
  const manager = makeManager(root);

  const session = await manager.create(projectRoot, { title: '长夜灯' });
  try {
    assert.equal(session.sessionId, 'id-1');
    // 会话目录：sessions/<session-id>/{events.jsonl, state.json}
    assert.equal(existsSync(path.join(session.directory, 'events.jsonl')), true);
    assert.equal(existsSync(path.join(session.directory, 'state.json')), true);
    assert.equal(existsSync(path.join(session.directory, 'state.json.tmp')), false);
    // 会话锁：locks/<session-id> 在打开期间存在
    const lockDir = path.join(
      root, 'WWriting', 'workspaces', workspaceIdForPath(projectRoot), 'locks', session.sessionId,
    );
    assert.equal(existsSync(lockDir), true);

    const projection = session.projection;
    assert.equal(projection.session_id, 'id-1');
    assert.equal(projection.status, 'idle');
    assert.equal(projection.active_run_id, null);
    assert.equal(projection.active_input_id, null);
    assert.deepEqual(projection.queue, []);
    assert.equal(projection.last_seq, 1);
    assert.equal(typeof projection.updated_at, 'string');
    assert.equal(projection.title, '长夜灯');

    const { events } = await session.eventStore.readAll();
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'session_created');
    assert.deepEqual(events[0].data, { title: '长夜灯' });
  } finally {
    await session.close();
  }
  // 关闭后写锁释放。
  const lockDir = path.join(
    root, 'WWriting', 'workspaces', workspaceIdForPath(projectRoot), 'locks', session.sessionId,
  );
  assert.equal(existsSync(lockDir), false);
});

test('openById 打开已有会话；会话不存在或 ID 非法报中文错误', async () => {
  const root = await makeTempRoot('wwriting-mgr-openbyid-');
  const projectRoot = path.join(root, 'novel');
  const manager = makeManager(root);

  const created = await manager.create(projectRoot);
  const sessionId = created.sessionId;
  await created.close();

  const reopened = await manager.openById(projectRoot, sessionId);
  assert.equal(reopened.sessionId, sessionId);
  assert.equal(reopened.directory, created.directory);
  assert.equal(reopened.projection.last_seq, 1);
  await reopened.close();

  await assert.rejects(manager.openById(projectRoot, 'no-such-session'), /[\u4e00-\u9fff]/);
  await assert.rejects(manager.openById(projectRoot, ''), /[\u4e00-\u9fff]/);
});

test('openLatest：无历史才创建会话，有历史选 updated_at 最大的非归档会话', async () => {
  const root = await makeTempRoot('wwriting-mgr-latest-');
  const projectRoot = path.join(root, 'novel');
  const manager = makeManager(root);

  // 空工作区：openLatest 创建新会话（无历史才创建）。
  const first = await manager.openLatest(projectRoot);
  assert.equal(first.sessionId, 'id-1');
  await first.close();

  // 已有历史：再建一个更新的会话，openLatest 选它而不是新建。
  const second = await manager.create(projectRoot);
  const secondId = second.sessionId;
  await second.close();

  const before = (await manager.list(projectRoot)).length;
  const latest = await manager.openLatest(projectRoot, { createIfMissing: false });
  assert.equal(latest.sessionId, secondId);
  await latest.close();
  assert.equal((await manager.list(projectRoot)).length, before);

  // createIfMissing 缺省为 true，但有历史时同样不新建。
  const latestDefault = await manager.openLatest(projectRoot);
  assert.equal(latestDefault.sessionId, secondId);
  await latestDefault.close();

  // 另一个空工作区：不创建时返回 null。
  const none = await manager.openLatest(path.join(root, 'other-project'), { createIfMissing: false });
  assert.equal(none, null);
});

test('archived 会话被 openLatest 跳过，但仍出现在 list 中', async () => {
  const root = await makeTempRoot('wwriting-mgr-archived-');
  const projectRoot = path.join(root, 'novel');
  const manager = makeManager(root);

  const first = await manager.create(projectRoot);
  const firstId = first.sessionId;
  await first.close();
  const second = await manager.create(projectRoot);
  const secondId = second.sessionId;
  await second.close();

  // 归档第一会话：它的 updated_at 随之变成最新，但仍不得被 openLatest 选中。
  const archiving = await manager.openById(projectRoot, firstId);
  await archiving.append({ type: 'session_archived', data: {} });
  await archiving.close();
  assert.equal((await manager.snapshot(projectRoot, firstId)).status, 'archived');

  const latest = await manager.openLatest(projectRoot, { createIfMissing: false });
  assert.equal(latest.sessionId, secondId);
  await latest.close();

  const items = await manager.list(projectRoot);
  assert.ok(items.some((item) => item.session_id === firstId && item.status === 'archived'));
});

// —— openLatest 选「有内容的最近会话」而不是裸启动留下的 0 轮空壳（P1）——

test('openLatest 优先打开最新的有内容会话，跳过裸启动留下的 0 轮空壳', async () => {
  const root = await makeTempRoot('wwriting-mgr-latest-content-');
  const projectRoot = path.join(root, 'novel');
  const manager = makeManager(root);

  // 用户真正写过的会话：一轮对话，updated_at 较旧。
  const worked = await manager.create(projectRoot, { title: '写过的' });
  await worked.append({ type: 'run_started', run_id: 'run-1', data: { input_id: 'in-1', text: '写第一章' } });
  await worked.append({ type: 'run_completed', run_id: 'run-1', data: { text: '写好了。' } });
  const workedId = worked.sessionId;
  await worked.close();

  // 裸启动留下的空壳：更新的 updated_at，但 0 轮。
  const shell = await manager.create(projectRoot, { title: '空壳' });
  const shellId = shell.sessionId;
  await shell.close();

  const summaries = await manager.list(projectRoot);
  assert.equal(summaries[0].session_id, shellId, '空壳确实是最新的（updated_at 最大）');
  assert.equal(summaries[0].turns, 0);
  assert.equal(summaries[1].session_id, workedId);
  assert.equal(summaries[1].turns, 1);

  const latest = await manager.openLatest(projectRoot, { createIfMissing: false });
  assert.equal(latest.sessionId, workedId, '-c 要接的是最近**写过**的会话，不是最近动过的空壳');
  await latest.close();
});

test('只有 0 轮会话时 openLatest 退回最新的那个；一个会话都没有时仍按 createIfMissing 创建', async () => {
  const root = await makeTempRoot('wwriting-mgr-latest-empty-');
  const projectRoot = path.join(root, 'novel');
  const manager = makeManager(root);

  // 空工作区：无任何候选 → createIfMissing 缺省 true，照建。
  const created = await manager.openLatest(projectRoot);
  assert.equal(created.sessionId, 'id-1');
  await created.close();

  // 再建一个更新的空壳：全部候选都是 0 轮 → 退回最新的那个（行为不变）。
  const newerShell = await manager.create(projectRoot);
  const newerShellId = newerShell.sessionId;
  await newerShell.close();

  const latest = await manager.openLatest(projectRoot, { createIfMissing: false });
  assert.equal(latest.sessionId, newerShellId);
  await latest.close();
});

test('openById 仍能打开 0 轮会话（--resume <ID> 指名打开不受 openLatest 的筛选影响）', async () => {
  const root = await makeTempRoot('wwriting-mgr-openbyid-empty-');
  const projectRoot = path.join(root, 'novel');
  const manager = makeManager(root);

  const shell = await manager.create(projectRoot);
  const shellId = shell.sessionId;
  await shell.close();

  const reopened = await manager.openById(projectRoot, shellId);
  assert.equal(reopened.sessionId, shellId);
  await reopened.close();
});

test('submit：空闲输入成为活跃输入，文本进入事件日志；空输入报中文错误', async () => {
  const root = await makeTempRoot('wwriting-mgr-submit-');
  const projectRoot = path.join(root, 'novel');
  const manager = makeManager(root);

  const session = await manager.create(projectRoot);
  try {
    const result = await session.submit({ text: '写第三章' });
    assert.equal(result.queued, false);
    assert.equal(session.projection.active_input_id, result.input_id);
    assert.deepEqual(session.projection.active_input, { input_id: result.input_id, text: '写第三章' });
    assert.equal(session.projection.status, 'idle');

    const { events } = await session.eventStore.readAll();
    const submitted = events.find((event) => event.type === 'input_submitted');
    assert.equal(submitted.data.input_id, result.input_id);
    assert.equal(submitted.data.text, '写第三章');

    await assert.rejects(session.submit({ text: '   ' }), /[\u4e00-\u9fff]/);
    await assert.rejects(session.submit({}), /[\u4e00-\u9fff]/);
  } finally {
    await session.close();
  }
});

test('submit：运行中输入按 FIFO 排队；run_started 引用排队输入时它离开队列', async () => {
  const root = await makeTempRoot('wwriting-mgr-fifo-');
  const projectRoot = path.join(root, 'novel');
  const manager = makeManager(root);

  const session = await manager.create(projectRoot);
  try {
    const first = await session.submit({ text: '第一条' });
    await session.append({ type: 'run_started', run_id: 'run-1', data: { input_id: first.input_id } });
    assert.equal(session.projection.status, 'active');

    const second = await session.submit({ text: '第二条' });
    assert.equal(second.queued, true);
    const third = await session.submit({ text: '第三条' });
    assert.equal(third.queued, true);
    assert.deepEqual(session.projection.queue.map((item) => item.text), ['第二条', '第三条']);
    // 排队时间来自事件时钟且随事件递增，队列保持入队顺序。
    assert.ok(session.projection.queue[0].queued_at < session.projection.queue[1].queued_at);

    // 下一轮从队首取输入：run_started 后该输入离开队列成为活跃输入。
    await session.append({ type: 'run_started', run_id: 'run-2', data: { input_id: second.input_id } });
    assert.deepEqual(session.projection.queue.map((item) => item.text), ['第三条']);
    assert.equal(session.projection.active_input_id, second.input_id);
    assert.equal(session.projection.active_input.text, '第二条');
  } finally {
    await session.close();
  }
});

test('enqueue：显式排队始终追加到队尾，即使会话空闲', async () => {
  const root = await makeTempRoot('wwriting-mgr-enqueue-');
  const projectRoot = path.join(root, 'novel');
  const manager = makeManager(root);

  const session = await manager.create(projectRoot);
  try {
    const first = await session.enqueue({ text: '预备一' });
    const second = await session.enqueue({ text: '预备二' });
    assert.deepEqual(session.projection.queue.map((item) => item.text), ['预备一', '预备二']);
    assert.deepEqual(session.projection.queue.map((item) => item.input_id), [first.input_id, second.input_id]);
    assert.equal(session.projection.active_input_id, null);
    await assert.rejects(session.enqueue({ text: '' }), /[\u4e00-\u9fff]/);
  } finally {
    await session.close();
  }
});

test('promote：只移动一个输入到队首，其余相对顺序不变', async () => {
  const root = await makeTempRoot('wwriting-mgr-promote-');
  const projectRoot = path.join(root, 'novel');
  const manager = makeManager(root);

  const session = await manager.create(projectRoot);
  try {
    const active = await session.submit({ text: '执行中' });
    await session.append({ type: 'run_started', run_id: 'run-1', data: { input_id: active.input_id } });
    const b = await session.submit({ text: '甲' });
    const c = await session.submit({ text: '乙' });
    const d = await session.submit({ text: '丙' });
    assert.deepEqual(session.projection.queue.map((item) => item.input_id), [b.input_id, c.input_id, d.input_id]);

    // 「立即」：把指定的一个排队输入提升到队首，其余保持 FIFO。
    const promoted = await session.promote(d.input_id);
    assert.equal(promoted.input_id, d.input_id);
    assert.deepEqual(
      session.projection.queue.map((item) => item.input_id),
      [d.input_id, b.input_id, c.input_id],
    );

    // 不在队列里的输入（活跃输入 / 未知 ID）不能提升。
    await assert.rejects(session.promote(active.input_id), /[\u4e00-\u9fff]/);
    await assert.rejects(session.promote('missing-input'), /[\u4e00-\u9fff]/);
    await assert.rejects(session.promote(''), /[\u4e00-\u9fff]/);
  } finally {
    await session.close();
  }
});

test('withdraw：撤回排队项，其余顺序不变；重复撤回报中文错误', async () => {
  const root = await makeTempRoot('wwriting-mgr-withdraw-');
  const projectRoot = path.join(root, 'novel');
  const manager = makeManager(root);

  const session = await manager.create(projectRoot);
  try {
    const active = await session.submit({ text: '执行中' });
    await session.append({ type: 'run_started', run_id: 'run-1', data: { input_id: active.input_id } });
    const b = await session.submit({ text: '甲' });
    const c = await session.submit({ text: '乙' });
    const d = await session.submit({ text: '丙' });

    const withdrawn = await session.withdraw(c.input_id);
    assert.equal(withdrawn.input_id, c.input_id);
    assert.deepEqual(
      session.projection.queue.map((item) => item.input_id),
      [b.input_id, d.input_id],
    );

    await assert.rejects(session.withdraw(c.input_id), /[\u4e00-\u9fff]/);
    await assert.rejects(session.withdraw('missing-input'), /[\u4e00-\u9fff]/);

    // 撤回后队列里的输入可以正常提升。
    await session.promote(d.input_id);
    assert.deepEqual(
      session.projection.queue.map((item) => item.input_id),
      [d.input_id, b.input_id],
    );
  } finally {
    await session.close();
  }
});

test('运行结束后临时授权清空（completed / interrupted / failed）', async () => {
  const root = await makeTempRoot('wwriting-mgr-grants-');
  const projectRoot = path.join(root, 'novel');
  const manager = makeManager(root);

  const session = await manager.create(projectRoot);
  try {
    // run_completed：清空活跃输入与临时授权。
    const first = await session.submit({ text: '第一章' });
    await session.append({ type: 'run_started', run_id: 'run-1', data: { input_id: first.input_id } });
    await session.append({ type: 'permission_granted', run_id: 'run-1', data: { grant: { kind: 'write', target: '第一章.md' } } });
    await session.append({ type: 'permission_granted', run_id: 'run-1', data: { grant: { kind: 'write', target: '第二章.md' } } });
    assert.equal(session.projection.status, 'active');
    assert.equal(session.projection.transient_grants.length, 2);

    await session.append({ type: 'run_completed', run_id: 'run-1', data: {} });
    assert.equal(session.projection.status, 'idle');
    assert.equal(session.projection.active_run_id, null);
    assert.equal(session.projection.active_input_id, null);
    assert.equal(session.projection.active_input, null);
    assert.deepEqual(session.projection.transient_grants, []);

    // run_interrupted：同样清空。
    const second = await session.submit({ text: '第二章' });
    await session.append({ type: 'run_started', run_id: 'run-2', data: { input_id: second.input_id } });
    await session.append({ type: 'permission_granted', run_id: 'run-2', data: { grant: { kind: 'write' } } });
    await session.append({ type: 'run_interrupted', run_id: 'run-2', data: { reason: 'user_stop' } });
    assert.equal(session.projection.active_run_id, null);
    assert.deepEqual(session.projection.transient_grants, []);

    // run_failed：同样清空。
    const third = await session.submit({ text: '第三章' });
    await session.append({ type: 'run_started', run_id: 'run-3', data: { input_id: third.input_id } });
    await session.append({ type: 'permission_granted', run_id: 'run-3', data: { grant: { kind: 'write' } } });
    await session.append({ type: 'run_failed', run_id: 'run-3', data: { message: '模型请求失败' } });
    assert.deepEqual(session.projection.transient_grants, []);

    // 从日志重建投影后结论一致。
    const rebuilt = (await session.eventStore.rebuildProjection()).projection;
    assert.deepEqual(rebuilt.transient_grants, []);
    assert.equal(rebuilt.status, 'idle');
  } finally {
    await session.close();
  }
});

test('第二写入者拿不到写锁报 SESSION_BUSY，只读 snapshot 仍可用，释放后可重开', async () => {
  const root = await makeTempRoot('wwriting-mgr-busy-');
  const projectRoot = path.join(root, 'novel');
  const manager = makeManager(root);

  const session = await manager.create(projectRoot);
  const sessionId = session.sessionId;
  try {
    await assert.rejects(
      manager.openById(projectRoot, sessionId),
      (error) => {
        assert.equal(error.code, 'SESSION_BUSY');
        assert.match(error.message, /[\u4e00-\u9fff]/);
        assert.doesNotMatch(error.message, /\n?\s+at /);
        return true;
      },
    );

    // 只读 snapshot 不受写锁影响。
    const snap = await manager.snapshot(projectRoot, sessionId);
    assert.equal(snap.session_id, sessionId);
    assert.equal(snap.status, 'idle');
  } finally {
    await session.close();
  }

  const reopened = await manager.openById(projectRoot, sessionId);
  assert.equal(reopened.sessionId, sessionId);
  await reopened.close();
});

test('manager 层 submit/enqueue/promote/withdraw 与句柄等价，非法句柄报中文错误', async () => {
  const root = await makeTempRoot('wwriting-mgr-delegate-');
  const projectRoot = path.join(root, 'novel');
  const manager = makeManager(root);

  const session = await manager.create(projectRoot);
  try {
    await manager.submit(session, { text: '手动提交' });
    assert.equal(session.projection.active_input.text, '手动提交');

    const queued = await manager.enqueue(session, { text: '排队一' });
    assert.equal(session.projection.queue.length, 1);

    await manager.promote(session, queued.input_id);
    assert.equal(session.projection.queue[0].input_id, queued.input_id);

    await manager.withdraw(session, queued.input_id);
    assert.equal(session.projection.queue.length, 0);

    await assert.rejects(manager.submit({}, { text: 'x' }), /[\u4e00-\u9fff]/);
    await assert.rejects(manager.promote(null, 'x'), /[\u4e00-\u9fff]/);
  } finally {
    await session.close();
  }
});

test('list：按 updated_at 降序返回全部会话摘要', async () => {
  const root = await makeTempRoot('wwriting-mgr-list-');
  const projectRoot = path.join(root, 'novel');
  const manager = makeManager(root);

  const first = await manager.create(projectRoot, { title: '旧会话' });
  await first.close();
  const second = await manager.create(projectRoot, { title: '新会话' });
  await second.submit({ text: '让新会话更新一次' });
  await second.close();

  const items = await manager.list(projectRoot);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.title), ['新会话', '旧会话']);
  assert.ok(items[0].updated_at > items[1].updated_at);
  for (const item of items) {
    assert.match(item.session_id, /^id-/);
    assert.equal(item.status, 'idle');
    assert.equal(typeof item.created_at, 'string');
    assert.equal(typeof item.updated_at, 'string');
    assert.equal(typeof item.last_seq, 'number');
  }
});

test('跨进程独占：活进程持锁时打开报 SESSION_BUSY，子进程退出后可打开', async () => {
  const root = await makeTempRoot('wwriting-mgr-xproc-');
  const projectRoot = path.join(root, 'novel');
  const manager = makeManager(root);

  const creator = await manager.create(projectRoot);
  const sessionId = creator.sessionId;
  await creator.close();

  const lockPath = path.join(
    root, 'WWriting', 'workspaces', workspaceIdForPath(projectRoot), 'locks', sessionId,
  );
  const lockModuleUrl = new URL('../../src/storage/process-lock.mjs', import.meta.url).href;
  const script = [
    `import { acquireSessionLock } from ${JSON.stringify(lockModuleUrl)};`,
    'const lock = await acquireSessionLock(process.argv[2], { pid: process.pid, staleAfterMs: 60000 });',
    "process.stdout.write('LOCKED\\n');",
    'if (process.argv[3] === "hold") { await new Promise((resolve) => setTimeout(resolve, 1500)); await lock.release(); }',
    'process.exit(0);',
  ].join('\n');
  const scriptPath = path.join(root, 'holder.mjs');
  await fs.writeFile(scriptPath, script, 'utf8');

  function waitMarker(child, marker) {
    return new Promise((resolve, reject) => {
      let buffer = '';
      const onData = (chunk) => {
        buffer += chunk;
        if (buffer.includes(marker)) {
          child.stdout.off('data', onData);
          resolve();
        }
      };
      child.stdout.on('data', onData);
      child.once('error', reject);
      child.once('close', () => reject(new Error('子进程在输出标记前退出')));
    });
  }
  function waitExit(child) {
    return new Promise((resolve) => child.once('close', resolve));
  }

  // 场景一：活的子进程持锁 → 第二进程打开报 SESSION_BUSY；子进程释放后可打开。
  const holder = spawn(process.execPath, [scriptPath, lockPath, 'hold'], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await waitMarker(holder, 'LOCKED');
    await assert.rejects(
      manager.openById(projectRoot, sessionId),
      (error) => {
        assert.equal(error.code, 'SESSION_BUSY');
        assert.match(error.message, /[\u4e00-\u9fff]/);
        return true;
      },
    );
  } finally {
    await waitExit(holder);
  }
  const reopened = await manager.openById(projectRoot, sessionId);
  assert.equal(reopened.sessionId, sessionId);
  await reopened.close();

  // 场景二：子进程崩溃（持锁不释放即退出）→ 死 PID 锁自动恢复后可打开。
  const crashed = spawn(process.execPath, [scriptPath, lockPath, 'crash'], { stdio: ['ignore', 'pipe', 'inherit'] });
  await waitMarker(crashed, 'LOCKED');
  await waitExit(crashed);
  const recovered = await manager.openById(projectRoot, sessionId);
  assert.equal(recovered.sessionId, sessionId);
  await recovered.close();
});

// —— markStarted：排队输入开跑的标记 ——

test('markStarted 只对排队过的输入发事件，当场提交的不发', async () => {
  const root = await makeTempRoot('wwriting-mgr-started-');
  const projectRoot = path.join(root, 'novel');
  const manager = makeManager(root);

  const session = await manager.create(projectRoot);
  try {
    // 第一条：当场提交（空闲），不排队。
    const live = await manager.submit(session, { text: '第一条' });
    // 第二条：忙碌中提交 → 进队列。
    const queued = await manager.submit(session, { text: '第二条' });

    // 当场提交的那条：readline 已经回显过，不该再发开跑标记（否则屏幕画两行）。
    assert.equal(await session.markStarted(live.input_id), null);

    // 排队的那条：发标记，并带上原文（渲染层要靠它把「排队」换成用户行）。
    const marked = await session.markStarted(queued.input_id);
    assert.equal(marked.input_id, queued.input_id);
    assert.equal(marked.text, '第二条');

    // 事件日志里的顺序必须是 queued → started，且 started 带原文。
    const { events } = await session.eventStore.readAll();
    const types = events.map((event) => event.type);
    const queuedAt = types.indexOf('input_queued');
    const startedAt = types.indexOf('input_started');
    assert.ok(queuedAt >= 0, '有排队事件');
    assert.ok(startedAt > queuedAt, 'input_started 在 input_queued 之后');
    const started = events[startedAt];
    assert.equal(started.data.input_id, queued.input_id);
    assert.equal(started.data.text, '第二条');
  } finally {
    await session.close();
  }
});

test('markStarted 对空 ID 或未知 ID 静默返回 null，不抛错也不写日志', async () => {
  const root = await makeTempRoot('wwriting-mgr-started-bad-');
  const projectRoot = path.join(root, 'novel');
  const manager = makeManager(root);

  const session = await manager.create(projectRoot);
  try {
    assert.equal(await session.markStarted(''), null);
    assert.equal(await session.markStarted(null), null);
    assert.equal(await session.markStarted('不存在的ID'), null);
    const { events } = await session.eventStore.readAll();
    assert.equal(events.some((event) => event.type === 'input_started'), false, '不该写任何事件');
  } finally {
    await session.close();
  }
});

test('list 的轮次数是真实对话轮次，不是事件数（last_seq 会大得多）', async () => {
  const root = await makeTempRoot('wwriting-mgr-turns-');
  const projectRoot = path.join(root, 'novel');
  const manager = makeManager(root);

  const session = await manager.create(projectRoot);
  try {
    await manager.submit(session, { text: '写第一章' });
    await session.eventStore.append({ type: 'run_started', run_id: 'run-1', data: { input_id: 'id-2', text: '写第一章' } });
    await session.eventStore.append({ type: 'run_completed', run_id: 'run-1', data: { text: '写好了。' } });
    await session.close();

    const [summary] = await manager.list(projectRoot);
    assert.equal(summary.turns, 1, '一轮对话就是 1 轮');
    // 关键：绝不能把 last_seq 当轮次数显示 —— 一轮对话会产生多条事件。
    assert.ok(summary.last_seq > summary.turns, `last_seq=${summary.last_seq} 应显著大于轮次数`);
  } catch (error) {
    if (!session.projection) throw error;
    await session.close().catch(() => {});
    throw error;
  }
});
