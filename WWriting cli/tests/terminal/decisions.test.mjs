// 决策作答语义的测试：翻译表（choiceFor）、确认卡（createDecisionCard）与失效事实。
//
// 这一组分支原先内联在 cli.mjs 的 onDecision 闭包里，只有 acceptance 级别才碰得到；
// 收进 decisions.mjs 之后在单元层钉死——尤其是「取消落在拒绝这一侧」的安全语义与重入保护。
import test from 'node:test';
import assert from 'node:assert/strict';

import { DECISION_CHOICES, choiceFor, createDecisionCard, reportStaleDecision } from '../../src/terminal/decisions.mjs';

function makeDeferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

test('DECISION_CHOICES：三个普通选项，顺序就是选择器里的顺序（铁律 4）', () => {
  assert.deepEqual(DECISION_CHOICES.map(({ choice, label }) => [choice, label]), [
    ['once', '一次允许'],
    ['input', '本条输入允许同类操作'],
    ['deny', '拒绝'],
  ]);
});

test('choiceFor：普通确认认标签、同义词；数字 1/2/3 是不宣传的历史别名', () => {
  assert.equal(choiceFor({ level: 'write' }, '一次允许').choice, 'once');
  assert.equal(choiceFor({ level: 'write' }, '本条输入允许同类操作').choice, 'input');
  assert.equal(choiceFor({ level: 'write' }, '拒绝').choice, 'deny');
  assert.equal(choiceFor({ level: 'write' }, '允许').choice, 'once', '卡片提示里用的那个词');
  assert.equal(choiceFor({ level: 'write' }, 'deny').choice, 'deny');
  assert.equal(choiceFor({ level: 'write' }, '1').choice, 'once', '隐藏别名不进任何提示');
  assert.equal(choiceFor({ level: 'write' }, '3').choice, 'deny');
  assert.equal(choiceFor({ level: 'write' }, '随便说说'), null, '答不上来就交给普通输入');
});

test('choiceFor：极端确认只认当次确认文字或明确拒绝，YOLO 与模型都不得代填（铁律 4）', () => {
  const decision = { level: 'extreme', confirmation_text: '删除目录 大纲' };
  assert.deepEqual(choiceFor(decision, '删除目录 大纲'), { choice: 'confirm', text: '删除目录 大纲' });
  assert.equal(choiceFor(decision, ' 删除目录 大纲'), null, '前后多一个空白都不行');
  assert.deepEqual(choiceFor(decision, '拒绝'), { choice: 'deny', text: null });
  assert.deepEqual(choiceFor(decision, 'deny'), { choice: 'deny', text: null });
  assert.deepEqual(choiceFor(decision, '2'), { choice: 'deny', text: null });
  assert.equal(choiceFor(decision, '一次允许'), null, '普通选项在极端关卡不算数');
  assert.deepEqual(choiceFor({ level: 'extreme' }, '拒绝'), { choice: 'deny', text: null }, '没有确认文字时仍可拒绝');
});

function makeCardHarness({ pickImpl, decideImpl } = {}) {
  const calls = { decide: [], notify: [], pick: [] };
  const card = createDecisionCard({
    pick: async (options) => {
      calls.pick.push(options);
      return pickImpl(options);
    },
    decide: async (args) => {
      calls.decide.push(args);
      if (decideImpl?.throw) throw decideImpl.throw;
      return undefined;
    },
    notify: (text, options) => calls.notify.push([text, options]),
  });
  return { card, calls };
}

test('确认卡：把选择器的答案交给 decide，参数就是权限层的形状', async () => {
  const { card, calls } = makeCardHarness({ pickImpl: async () => ({ item: { id: 'input' }, index: 1 }) });
  await card({ decision_id: 'd1' });
  assert.deepEqual(calls.decide, [{ decisionId: 'd1', choice: 'input', text: null }]);
  assert.deepEqual(calls.notify, [], '正常作答不产生任何事实行');
});

test('确认卡：取消落在安全的一侧——null 按拒绝读', async () => {
  const { card, calls } = makeCardHarness({ pickImpl: async () => null });
  await card({ decision_id: 'd2' });
  assert.deepEqual(calls.decide, [{ decisionId: 'd2', choice: 'deny', text: null }]);
});

test('确认卡：cancelSummary 留一行拒绝记录，Esc 不该和「什么都没发生」长得一样', async () => {
  const { card, calls } = makeCardHarness({ pickImpl: async () => null });
  await card({ decision_id: 'd3' });
  assert.match(calls.pick[0].cancelSummary, /拒绝/);
  assert.equal(calls.pick[0].title, null, '卡片已在 scrollback，选择器不重复同一句');
  assert.match(calls.pick[0].hint, /Esc\/Ctrl\+C 拒绝/);
});

test('确认卡：重入保护——一张卡在答的时候，后来的 pending 不再开卡', async () => {
  const gate = makeDeferred();
  const decided = [];
  let pickCount = 0;
  const card = createDecisionCard({
    pick: async () => {
      pickCount += 1;
      await gate.promise;
      return { item: { id: 'once' }, index: 0 };
    },
    decide: async (args) => { decided.push(args.choice); },
    notify: () => {},
  });

  const first = card({ decision_id: 'd1' });
  const second = card({ decision_id: 'd2' }); // 第一张还开着：这条必须被忽略
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(pickCount, 1, '同一时刻只有一张卡');
  assert.deepEqual(decided, ['once'], '第二个 pending 没有被顺手答掉');
});

test('确认卡：decide 抛错收敛成「确认已失效」一条事实，不外抛', async () => {
  const { card, calls } = makeCardHarness({
    pickImpl: async () => ({ item: { id: 'once' }, index: 0 }),
    decideImpl: { throw: new Error('run finished') },
  });
  await assert.doesNotReject(card({ decision_id: 'd1' }));
  assert.equal(calls.notify.length, 1);
  assert.equal(calls.notify[0][0], '确认已失效');
  assert.equal(calls.notify[0][1].tone, 'warn');
});

test('确认卡：选择器抛错收敛成「确认失败」；之后还能再答（复位）', async () => {
  let calls = 0;
  const notes = [];
  const card = createDecisionCard({
    pick: async () => {
      calls += 1;
      if (calls === 1) throw new Error('选择器坏了');
      return { item: { id: 'deny' }, index: 2 };
    },
    decide: async () => {},
    notify: (text, options) => notes.push([text, options]),
  });

  await assert.doesNotReject(card({ decision_id: 'd1' }));
  assert.deepEqual(notes[0], ['确认失败', { tone: 'warn', detail: '选择器坏了' }]);
  await card({ decision_id: 'd2' });
  assert.equal(calls, 2, 'finally 复位：第二次 pending 照常开卡');
  assert.deepEqual(notes[1], undefined, '重试成功不产生事实行');
});

test('reportStaleDecision：失效事实只有这一个住址，选择器与文字路径共用', () => {
  const notes = [];
  reportStaleDecision((text, options) => notes.push([text, options]), new Error('这条确认已被别处作废'));
  assert.equal(notes[0][0], '确认已失效');
  assert.equal(notes[0][1].tone, 'warn');
  assert.equal(notes[0][1].detail, '这条确认已被别处作废');
});
