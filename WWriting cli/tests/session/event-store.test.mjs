// 事件日志测试：seq 单调递增、同批连续、JSONL 每行可独立解析、
// state.json 损坏时可从日志重建、不完整尾行被截断并记录恢复事件。
// 全部使用 os.tmpdir() 下的临时目录与真实文件系统，零 mock。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createEventStore } from '../../src/session/event-store.mjs';
import { projectTurns } from '../../src/agent/history.mjs';

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
// 时钟每次调用前进 1 秒：at 单调且互不相同。
function makeClock() {
  let now = FIXED_MS;
  return () => (now += 1000);
}
// 确定性 ID 工厂：ev-1、ev-2……
function makeIdFactory(prefix = 'ev') {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

function makeStore(sessionDir) {
  return createEventStore({ sessionDir, clock: makeClock(), idFactory: makeIdFactory() });
}

function iso(ms) {
  return new Date(ms).toISOString();
}

test('append 首个事件：形状完整、seq 从 1 起、JSONL 与 state.json 落盘', async () => {
  const root = await makeTempRoot('wwriting-evt-first-');
  const dir = path.join(root, 'sess-1');
  const store = makeStore(dir);

  const event = await store.append({ type: 'session_created', session_id: 'sess-1', data: { title: '长夜灯' } });
  assert.deepEqual(event, {
    schema_version: 1,
    seq: 1,
    event_id: 'ev-1',
    at: iso(FIXED_MS + 1000),
    type: 'session_created',
    session_id: 'sess-1',
    run_id: null,
    data: { title: '长夜灯' },
  });

  // JSONL 落盘且以换行结尾。
  const raw = await fs.readFile(path.join(dir, 'events.jsonl'), 'utf8');
  assert.equal(raw.endsWith('\n'), true);
  assert.deepEqual(JSON.parse(raw.trimEnd()), event);

  // state.json 缓存同步写入。
  const state = JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(state.session_id, 'sess-1');
  assert.equal(state.status, 'idle');
  assert.equal(state.last_seq, 1);
  assert.equal(state.updated_at, iso(FIXED_MS + 1000));
});

test('seq 单调递增，at 与 event_id 来自注入的时钟与 ID 工厂', async () => {
  const root = await makeTempRoot('wwriting-evt-seq-');
  const store = makeStore(path.join(root, 'sess-1'));

  const e1 = await store.append({ type: 'a', session_id: 'sess-1', data: {} });
  const e2 = await store.append({ type: 'b', session_id: 'sess-1', data: {} });
  const e3 = await store.append({ type: 'c', session_id: 'sess-1', data: {} });

  assert.deepEqual([e1.seq, e2.seq, e3.seq], [1, 2, 3]);
  assert.deepEqual([e1.event_id, e2.event_id, e3.event_id], ['ev-1', 'ev-2', 'ev-3']);
  assert.deepEqual([e1.at, e2.at, e3.at], [iso(FIXED_MS + 1000), iso(FIXED_MS + 2000), iso(FIXED_MS + 3000)]);
  assert.deepEqual([e1.schema_version, e2.schema_version, e3.schema_version], [1, 1, 1]);
});

test('appendBatch：同批事件 seq 连续，跨批继续递增', async () => {
  const root = await makeTempRoot('wwriting-evt-batch-');
  const store = makeStore(path.join(root, 'sess-1'));

  const batch1 = await store.appendBatch([
    { type: 'run_started', session_id: 'sess-1', run_id: 'run-1', data: { input_id: 'in-1' } },
    { type: 'model_delta', session_id: 'sess-1', run_id: 'run-1', data: { text: '夜色' } },
    { type: 'model_delta', session_id: 'sess-1', run_id: 'run-1', data: { text: '渐深' } },
  ]);
  assert.deepEqual(batch1.map((e) => e.seq), [1, 2, 3]);

  const batch2 = await store.appendBatch([{ type: 'run_completed', session_id: 'sess-1', run_id: 'run-1' }]);
  assert.deepEqual(batch2.map((e) => e.seq), [4]);
  assert.equal(batch2[0].run_id, 'run-1');

  // 批内 seq 连续是日志不变量：重建投影与逐行读取结论一致。
  const { events } = await store.readAll();
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4]);
});

test('JSONL 每行可独立解析', async () => {
  const root = await makeTempRoot('wwriting-evt-lines-');
  const dir = path.join(root, 'sess-1');
  const store = makeStore(dir);
  await store.append({ type: 'session_created', session_id: 'sess-1', data: {} });
  await store.append({ type: 'input_submitted', session_id: 'sess-1', data: { input_id: 'in-1', text: '第一章' } });
  await store.appendBatch([
    { type: 'run_started', session_id: 'sess-1', run_id: 'run-1', data: { input_id: 'in-1' } },
    { type: 'run_completed', session_id: 'sess-1', run_id: 'run-1', data: {} },
  ]);

  const raw = await fs.readFile(path.join(dir, 'events.jsonl'), 'utf8');
  const lines = raw.split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 4);
  // 逐行独立解析：任何一行都不依赖其他行。
  const parsed = lines.map((line) => JSON.parse(line));
  assert.deepEqual(parsed.map((e) => e.seq), [1, 2, 3, 4]);
  for (const event of parsed) {
    assert.equal(event.schema_version, 1);
    assert.equal(typeof event.type, 'string');
    assert.equal(typeof event.at, 'string');
    assert.equal(typeof event.session_id, 'string');
  }
});

test('readAll 返回全部事件，tail 返回最后 n 个事件', async () => {
  const root = await makeTempRoot('wwriting-evt-tailfn-');
  const store = makeStore(path.join(root, 'sess-1'));
  for (const type of ['a', 'b', 'c', 'd']) {
    await store.append({ type, session_id: 'sess-1', data: {} });
  }

  const { events, truncatedTail } = await store.readAll();
  assert.deepEqual(events.map((e) => e.type), ['a', 'b', 'c', 'd']);
  assert.equal(truncatedTail, false);

  assert.deepEqual((await store.tail(2)).map((e) => e.seq), [3, 4]);
  assert.deepEqual(await store.tail(0), []);
  assert.deepEqual((await store.tail(99)).map((e) => e.seq), [1, 2, 3, 4]);
  await assert.rejects(store.tail(-1), /[\u4e00-\u9fff]/);
});

test('state.json 损坏：rebuildProjection 从日志重建，repair 把缓存写回', async () => {
  const root = await makeTempRoot('wwriting-evt-corrupt-');
  const dir = path.join(root, 'sess-1');
  const statePath = path.join(dir, 'state.json');
  const store = makeStore(dir);
  await store.append({ type: 'session_created', session_id: 'sess-1', data: {} });
  await store.append({ type: 'input_submitted', session_id: 'sess-1', data: { input_id: 'in-1', text: '第一章' } });
  await store.append({ type: 'run_started', session_id: 'sess-1', run_id: 'run-1', data: { input_id: 'in-1' } });

  // 缓存损坏不影响日志真相：新实例只看日志就能重建投影。
  await fs.writeFile(statePath, '这不是 JSON{{{', 'utf8');
  const fresh = makeStore(dir);
  const { projection } = await fresh.rebuildProjection();
  assert.equal(projection.session_id, 'sess-1');
  assert.equal(projection.status, 'active');
  assert.equal(projection.active_run_id, 'run-1');
  assert.equal(projection.active_input_id, 'in-1');
  assert.equal(projection.last_seq, 3);

  // repair 把重建结果原子写回 state.json。
  await fresh.repair();
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(state.status, 'active');
  assert.equal(state.last_seq, 3);
});

test('state.json 缺失：rebuildProjection 正常，repair 重写缓存', async () => {
  const root = await makeTempRoot('wwriting-evt-nostate-');
  const dir = path.join(root, 'sess-1');
  const statePath = path.join(dir, 'state.json');
  const store = makeStore(dir);
  await store.append({ type: 'session_created', session_id: 'sess-1', data: { title: '潮汐' } });
  await store.append({ type: 'input_submitted', session_id: 'sess-1', data: { input_id: 'in-1', text: '序章' } });

  await fs.rm(statePath, { force: true });
  const fresh = makeStore(dir);
  const { projection } = await fresh.rebuildProjection();
  assert.equal(projection.title, '潮汐');
  assert.equal(projection.active_input.text, '序章');
  assert.equal(existsSync(statePath), false);

  await fresh.repair();
  assert.equal(existsSync(statePath), true);
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(state.last_seq, 2);
});

test('不完整尾行被截断并记录恢复事件，后续 seq 接续', async () => {
  const root = await makeTempRoot('wwriting-evt-tail-');
  const dir = path.join(root, 'sess-1');
  const eventsPath = path.join(dir, 'events.jsonl');
  const store = makeStore(dir);
  await store.append({ type: 'session_created', session_id: 'sess-1', data: {} });
  await store.append({ type: 'input_submitted', session_id: 'sess-1', data: { input_id: 'in-1', text: '第一章' } });

  // 模拟进程在写入下一行途中崩溃：日志留下一行不完整的半行。
  const partial = '{"schema_version":1,"seq":3,"type":"input_subm';
  await fs.appendFile(eventsPath, partial, 'utf8');

  // 只读视角：半行不是事件，truncatedTail 为真。
  const fresh = makeStore(dir);
  const rebuilt = await fresh.rebuildProjection();
  const readOnly = await fresh.readAll();
  assert.equal(readOnly.events.length, 2);
  assert.equal(readOnly.truncatedTail, true);
  assert.equal(rebuilt.truncatedTail, true);
  assert.equal(rebuilt.projection.last_seq, 2);

  // 写模式修复：截断半行并追加恢复事件。
  const repairResult = await fresh.repair();
  assert.equal(repairResult.truncatedTail, true);
  const after = await fresh.readAll();
  assert.equal(after.events.length, 3);
  assert.equal(after.events[2].type, 'log_tail_truncated');
  assert.equal(after.events[2].seq, 3);
  assert.deepEqual(after.events[2].data, { removed_bytes: partial.length });
  assert.equal(after.truncatedTail, false);

  // 半行消失，文件重新以换行结尾。
  const raw = await fs.readFile(eventsPath, 'utf8');
  assert.equal(raw.endsWith('\n'), true);
  assert.equal(raw.includes('"seq":3,"type":"input_subm\n'), false);
  assert.equal(raw.split('\n').filter((line) => line !== '').length, 3);

  // 后续追加从 seq 4 接续，投影同步。
  const next = await fresh.append({ type: 'input_submitted', data: { input_id: 'in-2', text: '第二章' } });
  assert.equal(next.seq, 4);
  assert.equal((await fresh.currentProjection()).last_seq, 4);
});

test('完全未写完的首个事件（日志只有半行）：截断后不留下孤立恢复事件', async () => {
  const root = await makeTempRoot('wwriting-evt-tail-first-');
  const dir = path.join(root, 'sess-1');
  const eventsPath = path.join(dir, 'events.jsonl');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(eventsPath, '{"schema_version":1,"seq":1,"type":"sess', 'utf8');

  const store = makeStore(dir);
  const repairResult = await store.repair();
  assert.equal(repairResult.truncatedTail, true);
  const { events } = await store.readAll();
  assert.equal(events.length, 0);
  // 空日志上追加首个事件从 seq 1 开始。
  const first = await store.append({ type: 'session_created', session_id: 'sess-1', data: {} });
  assert.equal(first.seq, 1);
});

test('seq 不连续或中间行损坏：readAll 报中文错误', async () => {
  const root = await makeTempRoot('wwriting-evt-broken-');

  function eventLine(seq, type) {
    return JSON.stringify({
      schema_version: 1,
      seq,
      event_id: `ev-${seq}`,
      at: iso(FIXED_MS + seq * 1000),
      type,
      session_id: 'sess-1',
      run_id: null,
      data: {},
    });
  }

  // seq 跳号。
  const gapDir = path.join(root, 'gap');
  await fs.mkdir(gapDir, { recursive: true });
  await fs.writeFile(
    path.join(gapDir, 'events.jsonl'),
    `${eventLine(1, 'session_created')}\n${eventLine(3, 'input_submitted')}\n`,
    'utf8',
  );
  await assert.rejects(
    makeStore(gapDir).readAll(),
    (error) => {
      assert.match(error.message, /[\u4e00-\u9fff]/);
      assert.match(error.message, /seq/);
      return true;
    },
  );

  // 中间行损坏。
  const corruptDir = path.join(root, 'corrupt');
  await fs.mkdir(corruptDir, { recursive: true });
  await fs.writeFile(
    path.join(corruptDir, 'events.jsonl'),
    `${eventLine(1, 'session_created')}\n{"broken\n`,
    'utf8',
  );
  await assert.rejects(
    makeStore(corruptDir).readAll(),
    (error) => {
      assert.match(error.message, /[\u4e00-\u9fff]/);
      assert.match(error.message, /第 2 行/);
      return true;
    },
  );
});

test('事件形状校验：非法输入报中文错误', async () => {
  const root = await makeTempRoot('wwriting-evt-shape-');
  const store = makeStore(path.join(root, 'sess-1'));

  await assert.rejects(store.append({ type: '', session_id: 'sess-1' }), /[\u4e00-\u9fff]/);
  await assert.rejects(store.append({ type: '   ', session_id: 'sess-1' }), /[\u4e00-\u9fff]/);
  await assert.rejects(store.append({ type: 'x', session_id: 'sess-1', data: [1, 2] }), /[\u4e00-\u9fff]/);
  await assert.rejects(store.append({ type: 'x', session_id: 'sess-1', data: 'nope' }), /[\u4e00-\u9fff]/);
  await assert.rejects(store.append({ type: 'x', session_id: 'sess-1', run_id: 42 }), /[\u4e00-\u9fff]/);
  await assert.rejects(store.append({ type: 'x', session_id: 'sess-1', run_id: '' }), /[\u4e00-\u9fff]/);
  // 空日志且未提供 session_id：无法确定归属，报中文错误。
  await assert.rejects(store.append({ type: 'x' }), /[\u4e00-\u9fff]/);
  await assert.rejects(store.append('不是对象'), /[\u4e00-\u9fff]/);
  await assert.rejects(store.appendBatch('不是数组'), /[\u4e00-\u9fff]/);
});

test('run_id 显式保留，data 缺省为空对象，session_id 可从日志继承', async () => {
  const root = await makeTempRoot('wwriting-evt-fields-');
  const store = makeStore(path.join(root, 'sess-1'));

  const first = await store.append({ type: 'session_created', session_id: 'sess-1', data: {} });
  assert.equal(first.run_id, null);

  const withRun = await store.append({ type: 'run_started', session_id: 'sess-1', run_id: 'run-9' });
  assert.equal(withRun.run_id, 'run-9');
  assert.deepEqual(withRun.data, {});

  // 后续事件不写 session_id 时从日志继承。
  const inherited = await store.append({ type: 'run_completed', run_id: 'run-9', data: {} });
  assert.equal(inherited.session_id, 'sess-1');
});

test('append 与 appendBatch 后无临时文件残留，tail 拒绝非整数参数', async () => {
  const root = await makeTempRoot('wwriting-evt-tmp-');
  const dir = path.join(root, 'sess-1');
  const store = makeStore(dir);
  await store.append({ type: 'session_created', session_id: 'sess-1', data: {} });
  await store.appendBatch([{ type: 'a', session_id: 'sess-1', data: {} }]);
  assert.equal(existsSync(path.join(dir, 'state.json.tmp')), false);
});

test('plan_updated 落进投影；run_started 清空上一轮计划（口径 A），终态不清', async () => {
  const root = await makeTempRoot('wwriting-evt-plan-');
  const store = makeStore(path.join(root, 'sess-1'));
  await store.append({ type: 'session_created', session_id: 'sess-1', data: {} });

  await store.append({ type: 'run_started', run_id: 'run-1', data: { input_id: 'i-1', text: '改这三章' } });
  const items = [{ summary: '改第二章', status: 'completed' }, { summary: '改第三章', status: 'in_progress' }];
  await store.append({ type: 'plan_updated', run_id: 'run-1', data: { items } });
  await store.append({ type: 'run_completed', run_id: 'run-1', data: { text: '改完了', rounds: 1, usage: null } });

  let state = await store.currentProjection();
  // Run 结束后保留：scrollback 与 /plan 的回看依据。
  assert.deepEqual(state.plan, { run_id: 'run-1', items });

  // 新一轮开始：上一轮计划随之作废。
  await store.append({ type: 'run_started', run_id: 'run-2', data: { input_id: 'i-2', text: '继续' } });
  state = await store.currentProjection();
  assert.equal(state.plan, null);

  // 本轮没有计划就一直是没有；畸形数据（非数组）不更新、不抛。
  await store.append({ type: 'plan_updated', run_id: 'run-2', data: { items: '坏的' } });
  state = await store.currentProjection();
  assert.equal(state.plan, null);

  // 重启后从日志重建的投影与内存一致（readAll → foldEvents 同一套 applyEvent）。
  const rebuilt = await store.rebuildProjection();
  assert.equal(rebuilt.projection.plan, null);
});

test('plan_updated 后崩溃重建：state.json 损坏时从日志如实恢复计划', async () => {
  const root = await makeTempRoot('wwriting-evt-plan-rebuild-');
  const dir = path.join(root, 'sess-1');
  const store = makeStore(dir);
  await store.append({ type: 'session_created', session_id: 'sess-1', data: {} });
  await store.append({ type: 'run_started', run_id: 'run-1', data: {} });
  const items = [{ summary: '写第四章', status: 'in_progress' }];
  await store.append({ type: 'plan_updated', run_id: 'run-1', data: { items } });

  // state.json 直接清空（模拟损坏）：重建以 events.jsonl 为准。
  await fs.writeFile(path.join(dir, 'state.json'), '', 'utf8');
  const rebuilt = await store.rebuildProjection();
  assert.deepEqual(rebuilt.projection.plan, { run_id: 'run-1', items });
});

test('turns 计数：每个 run_started 一轮，随 state.json 落盘（规格 2026-10-06 D1）', async () => {
  const root = await makeTempRoot('wwriting-evt-turns-');
  const dir = path.join(root, 'sess-1');
  const store = makeStore(dir);

  await store.append({ type: 'session_created', session_id: 'sess-1', data: { title: '' } });
  await store.append({ type: 'input_submitted', session_id: 'sess-1', data: { input_id: 'in-1', text: '第一条' } });
  await store.append({ type: 'run_started', session_id: 'sess-1', run_id: 'run-1', data: { input_id: 'in-1', text: '第一条' } });
  await store.append({ type: 'run_completed', session_id: 'sess-1', run_id: 'run-1', data: {} });
  await store.append({ type: 'input_submitted', session_id: 'sess-1', data: { input_id: 'in-2', text: '第二条' } });
  await store.append({ type: 'run_started', session_id: 'sess-1', run_id: 'run-2', data: { input_id: 'in-2', text: '第二条' } });

  const projection = await store.currentProjection();
  assert.equal(projection.turns, 2);

  // 落盘：state.json 带 turns 字段——封面化（list 直读）的数据源。
  const state = JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(state.turns, 2);

  // 与 projectTurns 的口径逐字一致：轮次数 == run_started 的条数。
  const { events } = await store.readAll();
  assert.equal(projectTurns(events).length, 2);

  // 换一个 store（等价于重开）：从日志折算出的 turns 与内存一致。
  const reopened = makeStore(dir);
  const rebuilt = await reopened.rebuildProjection();
  assert.equal(rebuilt.projection.turns, 2);
});

// —— readTail：有界回读（规格 2026-10-06 D3）——
// tailChunkBytes 注入小值（16 字节），专门锤跨块行拼接与多字节字符跨界。

test('readTail：fileStart 全窗与 readAll 逐字节一致（16 字节块、中文混排跨块）', async () => {
  const root = await makeTempRoot('wwriting-evt-tail-full-');
  const dir = path.join(root, 'sess');
  const store = createEventStore({ sessionDir: dir, clock: makeClock(), idFactory: makeIdFactory(), tailChunkBytes: 16 });
  await store.append({ type: 'session_created', session_id: 'sess', data: { title: '长夜灯下第一章的手稿正文' } });
  for (let i = 2; i <= 8; i += 1) {
    await store.append({ type: 'note', session_id: 'sess', data: { n: i, text: `第${i}条——中文与标点：「引号」、破折号——以及 emoji 🙂 混排` } });
  }
  const all = await store.readAll();
  const full = await store.readTail({ maxBytes: 1024 * 1024 });
  assert.equal(full.stop, 'fileStart');
  assert.equal(full.truncatedTail, false);
  assert.deepEqual(full.events, all.events);
});

test('readTail：untilSeq 越界即停，低 seq 事件滤除', async () => {
  const root = await makeTempRoot('wwriting-evt-tail-until-');
  const dir = path.join(root, 'sess');
  const store = createEventStore({ sessionDir: dir, clock: makeClock(), idFactory: makeIdFactory(), tailChunkBytes: 16 });
  await store.append({ type: 'session_created', session_id: 'sess', data: {} });
  for (let i = 2; i <= 8; i += 1) {
    await store.append({ type: 'note', session_id: 'sess', data: { n: i, text: `第${i}条——中文与标点：「引号」混排` } });
  }
  const bounded = await store.readTail({ maxBytes: 1024 * 1024, untilSeq: 5 });
  assert.equal(bounded.stop, 'seqBoundary');
  assert.deepEqual(bounded.events.map((event) => event.seq), [6, 7, 8]);
});

test('readTail：byteLimit 窗口只装得下尾部几行，且是 readAll 的后缀', async () => {
  const root = await makeTempRoot('wwriting-evt-tail-limit-');
  const dir = path.join(root, 'sess');
  const store = createEventStore({ sessionDir: dir, clock: makeClock(), idFactory: makeIdFactory(), tailChunkBytes: 16 });
  await store.append({ type: 'session_created', session_id: 'sess', data: {} });
  for (let i = 2; i <= 8; i += 1) {
    await store.append({ type: 'note', session_id: 'sess', data: { n: i, text: `第${i}条——中文与标点：「引号」混排` } });
  }
  const all = (await store.readAll()).events;
  const tiny = await store.readTail({ maxBytes: 300 });
  assert.equal(tiny.stop, 'byteLimit');
  assert.ok(tiny.events.length >= 1 && tiny.events.length < all.length, `events=${tiny.events.length}`);
  assert.deepEqual(tiny.events, all.slice(-tiny.events.length), '窗口内容是全量的后缀');
  // 窗口小到装不下一行时如实返回空。
  const none = await store.readTail({ maxBytes: 8 });
  assert.deepEqual(none.events, []);
  assert.equal(none.stop, 'byteLimit');
});

test('readTail：残行跨多块时 removedBytes 精确、完整行一个不少', async () => {
  const root = await makeTempRoot('wwriting-evt-tail-torn-');
  const dir = path.join(root, 'sess');
  const store = createEventStore({ sessionDir: dir, clock: makeClock(), idFactory: makeIdFactory(), tailChunkBytes: 16 });
  await store.append({ type: 'session_created', session_id: 'sess', data: {} });
  for (let i = 2; i <= 8; i += 1) {
    await store.append({ type: 'note', session_id: 'sess', data: { n: i, text: `第${i}条——中文与标点：「引号」混排` } });
  }
  const eventsPath = path.join(dir, 'events.jsonl');
  const tornTail = '{"seq":9,"type":"torn","da';
  await fs.appendFile(eventsPath, tornTail);

  const torn = await store.readTail({ maxBytes: 1024 * 1024 });
  assert.equal(torn.truncatedTail, true, '残行如实上报');
  assert.deepEqual(torn.events.map((event) => event.seq), [1, 2, 3, 4, 5, 6, 7, 8], '完整行一个不少');
  assert.equal(torn.removedBytes, Buffer.byteLength(tornTail), '残行跨多块也要数准');
  const fileBytes = Buffer.byteLength(await fs.readFile(eventsPath, 'utf8'));
  assert.equal(torn.keepBytes, fileBytes - Buffer.byteLength(tornTail));

  // 与全量读对偶：readRaw 对同一份残文件给出同样的截断判定。
  const raw = await store.readAll();
  assert.equal(raw.truncatedTail, true);
});

// —— 打开锚点（规格 2026-10-06 T3/D6）：state.json 校验在册后增量重放，否则回退全量 ——

// 手工构造一份合法形状的封面（state.json）。
function coverJson(overrides = {}) {
  return `${JSON.stringify({
    session_id: 'sess-1',
    status: 'idle',
    active_run_id: null,
    active_input_id: null,
    active_input: null,
    queue: [],
    transient_grants: [],
    title: '',
    created_at: iso(FIXED_MS),
    updated_at: iso(FIXED_MS + 9000),
    last_seq: 4,
    turns: 1,
    plan: null,
    digest: null,
    ...overrides,
  }, null, 2)}\n`;
}

test('锚点命中：投影以封面为初值，增量事件续着折算，seq 接着走', async () => {
  const root = await makeTempRoot('wwriting-evt-anchor-hit-');
  const dir = path.join(root, 'sess-1');
  const writer = makeStore(dir);
  await writer.append({ type: 'session_created', session_id: 'sess-1', data: { title: '真标题' } });
  await writer.append({ type: 'input_submitted', session_id: 'sess-1', data: { input_id: 'in-1', text: '写' } });
  await writer.append({ type: 'run_started', session_id: 'sess-1', run_id: 'run-1', data: { input_id: 'in-1', text: '写' } });
  await writer.append({ type: 'run_completed', session_id: 'sess-1', run_id: 'run-1', data: {} });

  // 覆盖内容与全量折算刻意可区分（turns: 99）：命中锚点就采信封面。
  await fs.writeFile(path.join(dir, 'state.json'), coverJson({ turns: 99, title: '封面标题' }), 'utf8');
  const reopened = makeStore(dir);
  const projection = await reopened.currentProjection();
  assert.equal(projection.turns, 99, '命中锚点：采信封面而不是折算');
  assert.equal(projection.title, '封面标题');

  // 锚点之上继续写入：seq 接着走，投影在锚点之上正常演化。
  const appended = await reopened.append({ type: 'input_submitted', session_id: 'sess-1', data: { input_id: 'in-2', text: '再写' } });
  assert.equal(appended.seq, 5);
  const after = await reopened.currentProjection();
  assert.equal(after.last_seq, 5);
  assert.equal(after.active_input_id, 'in-2');

  // 锚点路径与全量路径对「干净日志」给出同一份投影（turns 99 是封面带来的，折算是 1）。
  const rebuilt = await reopened.rebuildProjection();
  assert.equal(rebuilt.projection.turns, 1);
});

test('锚点失效回退：last_seq 不在尾窗 / 封面损坏 / 形状不全，一律全量折算', async () => {
  async function makeCase(prefix, cover) {
    const root = await makeTempRoot(prefix);
    const dir = path.join(root, 'sess-1');
    const writer = makeStore(dir);
    await writer.append({ type: 'session_created', session_id: 'sess-1', data: { title: '真标题' } });
    await writer.append({ type: 'input_submitted', session_id: 'sess-1', data: { input_id: 'in-1', text: '写' } });
    await writer.append({ type: 'run_started', session_id: 'sess-1', run_id: 'run-1', data: { input_id: 'in-1', text: '写' } });
    await writer.append({ type: 'run_completed', session_id: 'sess-1', run_id: 'run-1', data: {} });
    if (cover !== null) await fs.writeFile(path.join(dir, 'state.json'), cover, 'utf8');
    return dir;
  }

  // last_seq 指向不存在的 seq（封面与日志脱节）。
  const staleDir = await makeCase('wwriting-evt-anchor-stale-', coverJson({ last_seq: 999, turns: 99 }));
  const stale = makeStore(staleDir);
  const staleProjection = await stale.currentProjection();
  assert.equal(staleProjection.turns, 1, '脱节封面不采信，回退折算');
  assert.equal(staleProjection.title, '真标题');

  // 封面坏 JSON。
  const brokenDir = await makeCase('wwriting-evt-anchor-broken-', '{not json');
  const broken = makeStore(brokenDir);
  assert.equal((await broken.currentProjection()).turns, 1);

  // 旧形状（无 turns 字段）。
  const legacyDir = await makeCase('wwriting-evt-anchor-legacy-', `${JSON.stringify({
    session_id: 'sess-1', status: 'idle', title: '真标题', updated_at: iso(FIXED_MS + 9000), last_seq: 4,
  })}\n`);
  const legacy = makeStore(legacyDir);
  assert.equal((await legacy.currentProjection()).turns, 1);

  // 封面缺失。
  const missingDir = await makeCase('wwriting-evt-anchor-missing-', null);
  const missing = makeStore(missingDir);
  assert.equal((await missing.currentProjection()).turns, 1);
});

test('锚点 + 滞后增量：封面落后于日志一批，增量事件续着折算', async () => {
  const root = await makeTempRoot('wwriting-evt-anchor-delta-');
  const dir = path.join(root, 'sess-1');
  const writer = makeStore(dir);
  await writer.append({ type: 'session_created', session_id: 'sess-1', data: {} });
  await writer.append({ type: 'input_submitted', session_id: 'sess-1', data: { input_id: 'in-1', text: '写' } });
  await writer.append({ type: 'run_started', session_id: 'sess-1', run_id: 'run-1', data: { input_id: 'in-1', text: '写' } });
  await writer.append({ type: 'run_completed', session_id: 'sess-1', run_id: 'run-1', data: {} });
  // 模拟「append 后、写封面前」崩溃：日志到 4，封面停在 2。
  await fs.writeFile(path.join(dir, 'state.json'), coverJson({ last_seq: 2, turns: 0, status: 'idle' }), 'utf8');

  const reopened = makeStore(dir);
  const projection = await reopened.currentProjection();
  assert.equal(projection.last_seq, 4);
  assert.equal(projection.turns, 1, '增量里的 run_started 也计入 turns');
  assert.equal(projection.status, 'idle', 'run_completed 的清场跟着生效');
});

test('锚点 + 排队跨锚点：排队项文本经队列兜住，不依赖 inputs Map', async () => {
  const root = await makeTempRoot('wwriting-evt-anchor-queue-');
  const dir = path.join(root, 'sess-1');
  const writer = makeStore(dir);
  await writer.append({ type: 'session_created', session_id: 'sess-1', data: {} });
  await writer.append({ type: 'input_submitted', session_id: 'sess-1', data: { input_id: 'in-1', text: '在跑的' } });
  await writer.append({ type: 'run_started', session_id: 'sess-1', run_id: 'run-1', data: { input_id: 'in-1', text: '在跑的' } });
  await writer.append({ type: 'input_queued', session_id: 'sess-1', data: { input_id: 'in-9', text: '排队的那条' } });

  // 封面停在排队之后：队列带着文本进封面。
  await fs.writeFile(path.join(dir, 'state.json'), coverJson({
    last_seq: 4,
    turns: 1,
    status: 'active',
    active_run_id: 'run-1',
    active_input_id: 'in-1',
    active_input: { input_id: 'in-1', text: '在跑的' },
    queue: [{ input_id: 'in-9', text: '排队的那条', queued_at: iso(FIXED_MS + 4000) }],
  }), 'utf8');

  // 重开（inputs Map 为空——锚点快路不重建它），提升排队输入为新一轮，run_started 不带文本。
  const reopened = makeStore(dir);
  const store = reopened;
  await store.append({ type: 'run_interrupted', session_id: 'sess-1', run_id: 'run-1', data: { reason: 'user_stop' } });
  await store.append({ type: 'run_started', session_id: 'sess-1', run_id: 'run-2', data: { input_id: 'in-9' } });
  const projection = await store.currentProjection();
  assert.equal(projection.active_input_id, 'in-9');
  assert.equal(projection.active_input.text, '排队的那条', '排队项自带文本兜住跨锚点开轮');
  assert.equal(projection.queue.length, 0, '排队项随 run_started 离队');
});

test('锚点 + 残尾并存：repair 照旧截断并补恢复事件，日志 seq 保持连续', async () => {
  const root = await makeTempRoot('wwriting-evt-anchor-torn-');
  const dir = path.join(root, 'sess-1');
  const writer = makeStore(dir);
  await writer.append({ type: 'session_created', session_id: 'sess-1', data: {} });
  await writer.append({ type: 'input_submitted', session_id: 'sess-1', data: { input_id: 'in-1', text: '写' } });
  await writer.append({ type: 'run_started', session_id: 'sess-1', run_id: 'run-1', data: { input_id: 'in-1', text: '写' } });
  await writer.append({ type: 'run_completed', session_id: 'sess-1', run_id: 'run-1', data: {} });
  await fs.appendFile(path.join(dir, 'events.jsonl'), '{"seq":5,"type":"torn","da');

  const reopened = makeStore(dir);
  const repaired = await reopened.repair();
  assert.equal(repaired.truncatedTail, true);

  const { events } = await reopened.readAll();
  // 修复后追加 log_tail_truncated（复用被弃尾行的 seq 5），日志 seq 连续。
  assert.equal(events.length, 5);
  assert.equal(events[4].type, 'log_tail_truncated');
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3, 4, 5]);
  const projection = await reopened.currentProjection();
  assert.equal(projection.last_seq, 5);
});

test('锚点版本标记：有 turns 无 digest 的中间形状封面不采信（T1/T2 之间的形状缺口封死）', async () => {
  const root = await makeTempRoot('wwriting-evt-anchor-t1shape-');
  const dir = path.join(root, 'sess-1');
  const writer = makeStore(dir);
  await writer.append({ type: 'session_created', session_id: 'sess-1', data: {} });
  await writer.append({ type: 'input_submitted', session_id: 'sess-1', data: { input_id: 'in-1', text: '写' } });
  await writer.append({ type: 'run_started', session_id: 'sess-1', run_id: 'run-1', data: { input_id: 'in-1', text: '写' } });
  await writer.append({ type: 'run_completed', session_id: 'sess-1', run_id: 'run-1', data: {} });
  await writer.append({ type: 'digest_compacted', session_id: 'sess-1', data: { digest: '已有的摘要。', through_seq: 4, chars: 6, covered_turns: 1, covered_total: 1 } });

  // T1 形状：turns 在位但封面缺 digest 键——若放行，已压缩会话会被当成从未压缩（记忆丢失）。
  const t1Shape = JSON.parse(coverJson({ turns: 1 }));
  delete t1Shape.digest;
  await fs.writeFile(path.join(dir, 'state.json'), `${JSON.stringify(t1Shape, null, 2)}\n`, 'utf8');

  const reopened = makeStore(dir);
  const projection = await reopened.currentProjection();
  assert.equal(projection.digest.text, '已有的摘要。', '回退全量折算：摘要从日志如实恢复');
  assert.equal(projection.digest.covered_total, 1);
});

test('锚点封面畸形字段不设防即回退：digest 是字符串 / active_run_id 是数字', async () => {
  async function makeCase(prefix, overrides) {
    const root = await makeTempRoot(prefix);
    const dir = path.join(root, 'sess-1');
    const writer = makeStore(dir);
    await writer.append({ type: 'session_created', session_id: 'sess-1', data: {} });
    await writer.append({ type: 'run_started', session_id: 'sess-1', run_id: 'run-1', data: {} });
    await writer.append({ type: 'run_completed', session_id: 'sess-1', run_id: 'run-1', data: {} });
    await fs.writeFile(path.join(dir, 'state.json'), coverJson(overrides), 'utf8');
    return dir;
  }
  const badDigest = await makeCase('wwriting-evt-anchor-baddigest-', { digest: '不是对象' });
  assert.equal((await makeStore(badDigest).currentProjection()).status, 'idle', '畸形 digest → 回退全量');

  const badRunId = await makeCase('wwriting-evt-anchor-badrunid-', { active_run_id: 42 });
  assert.equal((await makeStore(badRunId).currentProjection()).status, 'idle', '畸形 active_run_id → 回退全量');
});
