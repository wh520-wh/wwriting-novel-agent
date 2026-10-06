// 让位下的选择器会话（createMenuPicker）与 /resume 挑选列表的测试。
//
// 「漏包一次 withInputSuspended 就双读取者吃键」原先靠三处手工重复来防、没有任何测试能抓；
// 收进 pickers.mjs 之后，让位包裹与取消归一在这里单元层钉死。
// （（当前）标注与 0 轮过滤原先也是零覆盖的闭包分支，现在由 sessionPickerItems 直接可测。）
import test from 'node:test';
import assert from 'node:assert/strict';

import { createMenuPicker, sessionPickerItems } from '../../src/terminal/pickers.mjs';

test('pick：ask 真的跑在让位区间里，结束之后把结果原样交回', async () => {
  let inside = null;
  const order = [];
  const pick = createMenuPicker({
    selector: {
      ask: async (options) => {
        inside = options;
        order.push('ask');
        return { item: { id: '/model' }, index: 2 };
      },
    },
    withInputSuspended: async (fn) => {
      order.push('suspend');
      const result = await fn();
      order.push('resume');
      return result;
    },
  });

  const picked = await pick({ title: '命令', items: [{ id: '/model', label: '/model' }] });
  assert.deepEqual(order, ['suspend', 'ask', 'resume'], '让位包住整个 ask');
  assert.equal(inside.title, '命令');
  assert.deepEqual(picked, { item: { id: '/model' }, index: 2 });
});

test('pick：取消（null/undefined）归一为调用方声明的语义', async () => {
  let result = null;
  const pick = createMenuPicker({
    selector: { ask: async () => result },
    withInputSuspended: (fn) => fn(),
  });

  result = null;
  assert.equal(await pick({ canceled: 'deny' }), 'deny', 'null → 调用方声明的取消语义');
  result = undefined;
  assert.equal(await pick({ canceled: 'deny' }), 'deny', 'undefined 与 null 同样算取消');
  result = null;
  assert.equal(await pick({}), null, '不声明时默认 null（静默取消）');
  result = { item: { id: 'x' }, index: 0 };
  assert.deepEqual(await pick({ canceled: 'deny' }), { item: { id: 'x' }, index: 0 });
});

test('pick：选择器抛错原样冒泡——怎么呈现是调用方的策略', async () => {
  const pick = createMenuPicker({
    selector: { ask: async () => { throw new Error('boom'); } },
    withInputSuspended: (fn) => fn(),
  });
  await assert.rejects(pick({}), /boom/);
});

test('pick：构造缺件直接报错，不带病上岗', () => {
  assert.throws(() => createMenuPicker({ withInputSuspended: (fn) => fn() }));
  assert.throws(() => createMenuPicker({ selector: { ask: async () => null } }));
});

function session(id, turns, { updated = '2026-09-30T10:00:00.000Z', status = 'idle', title = '书名' } = {}) {
  return { session_id: id, turns, status, updated_at: updated, title };
}

test('sessionPickerItems：0 轮空壳不进挑选列表，除非它就是当前会话（P23）', () => {
  const sessions = [
    session('壳-a', 0),
    session('有内容的', 3),
    session('壳-当前', 0),
  ];
  const items = sessionPickerItems(sessions, '壳-当前');
  assert.deepEqual(items.map((item) => item.id), ['有内容的', '壳-当前'],
    '别的 0 轮壳被滤掉（保持列表原有顺序）；当前会话即使是壳也留下（用户正站在它上面）');
});

test('sessionPickerItems：已归档会话不进挑选列表（规格 2026-10-07 D5 改判旧行为）', () => {
  // 旧行为是「带轮数的归档会话保留」；/archive（D4）落地后归档就是「收起来」，
  // 挑选列表是「接着写」的入口，已归档不再出现。/sessions（查看）仍列它，
  // 行标签的「已归档」读法由 commands.test.mjs 的 sessionRowLabel 用例钉住。
  const items = sessionPickerItems([session('已归档', 5, { status: 'archived' })], null);
  assert.deepEqual(items.map((item) => item.id), []);
});

test('sessionPickerItems：当前会话标「（当前）」，说明行是会话 ID，行标签不带原始 ID', () => {
  const items = sessionPickerItems([session('sess-1', 2)], 'sess-1');
  assert.equal(items.length, 1);
  assert.ok(items[0].label.endsWith('（当前）'));
  assert.ok(!items[0].label.includes('sess-1'), '挑选列表不印 ID（说明行才放它）');
  assert.equal(items[0].description, 'sess-1');
});

test('sessionPickerItems：与 /sessions 共用同一份行标签（时间 / 状态 / 轮数）', () => {
  const items = sessionPickerItems([session('sess-1', 2)], null);
  assert.match(items[0].label, /2026-09-30/);
  assert.match(items[0].label, /2 轮/);
});

test('sessionPickerItems：空列表与空当前会话都安全', () => {
  assert.deepEqual(sessionPickerItems([], null), []);
  assert.deepEqual(sessionPickerItems([session('壳', 0)], null), [], '全部是壳：列表为空（命令层退回提示）');
});

test('sessionPickerItems：当前会话即使已归档也保留并标「（当前）」', () => {
  const sessions = [
    { session_id: 'a', turns: 3, status: 'archived', updated_at: '2026-10-07T08:00:00', title: '刚归档' },
    { session_id: 'b', turns: 5, status: 'idle', updated_at: '2026-10-07T09:00:00', title: '在写' },
  ];
  // 刚 /archive 切走的瞬间它还在屏幕上，列表里要能对上号。
  const items = sessionPickerItems(sessions, 'a');
  assert.deepEqual(items.map((item) => item.id), ['a', 'b']);
  assert.match(items[0].label, /（当前）/);
});
