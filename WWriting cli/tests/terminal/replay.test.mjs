// 屏幕重演的排版：把 src/agent/replay.mjs 算出来的项交给渲染器画出来。
// 这一层不做任何取舍——「哪些轮该重演」是 agent 层的事（P25 / P26）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { printReplay } from '../../src/terminal/replay.mjs';
import { createRenderer } from '../../src/terminal/renderer.mjs';
import { screenText } from '../helpers/screen.mjs';

function makeStdout() {
  const chunks = [];
  return { isTTY: false, columns: 100, write: (text) => { chunks.push(String(text)); return true; }, text: () => chunks.join('') };
}

function replay(items, omittedTurns = 0) {
  const stdout = makeStdout();
  const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' } });
  printReplay({ renderer, items, omittedTurns });
  renderer.close();
  return screenText(stdout.text());
}

test('四种项各归各位：用户行、思考行、正文、收尾状态行', () => {
  const shown = replay([
    { kind: 'user', text: '写第一章' },
    { kind: 'thinking', durationMs: 12000 },
    { kind: 'prose', text: '第一章写好了。' },
    { kind: 'status', terminal: 'completed', interruptReason: null, failCode: null },
  ]);
  assert.equal(shown, [
    '❯ 写第一章',
    '思考 12 秒',
    '▌ 第一章写好了。',
    '', // 正文 → 终态行之间的呼吸空行（ADR-0019 的 UI 边界 gap）
    '已完成',
  ].join('\n'));
});

test('状态文案来自 terminalStatusText：中断/连接失败/未配置各说各的（R5）', () => {
  // 重演出来的历史轮必须与用户当时看到的**逐字一致**。
  // 原计划让 agent 层自己写一张表，结果把所有中断都说成「已停止」、
  // 所有失败都说成「操作失败」——那比重演更糟，它让用户以为上次是正常停的。
  assert.equal(replay([{ kind: 'status', terminal: 'interrupted', interruptReason: 'user_stop', failCode: null }]), '已停止');
  assert.equal(replay([{ kind: 'status', terminal: 'interrupted', interruptReason: 'aborted', failCode: null }]), '已中断');
  assert.equal(replay([{ kind: 'status', terminal: 'failed', interruptReason: null, failCode: 'MODEL_NETWORK_ERROR' }]), '连接中断');
  assert.equal(replay([{ kind: 'status', terminal: 'failed', interruptReason: null, failCode: 'MODEL_NOT_CONFIGURED' }]), '未配置');
  assert.equal(replay([{ kind: 'status', terminal: 'failed', interruptReason: null, failCode: 'RUN_FAILED' }]), '操作失败');
  assert.equal(replay([{ kind: 'status', terminal: 'open', interruptReason: null, failCode: null }]), '未正常结束');
});

test('错误码只作判据，绝不上屏（铁律 3）', () => {
  const shown = replay([{ kind: 'status', terminal: 'failed', interruptReason: null, failCode: 'MODEL_NETWORK_ERROR' }]);
  assert.equal(shown.includes('MODEL_NETWORK_ERROR'), false);
});

test('算不出耗时的思考项回退「已完成思考」', () => {
  assert.equal(replay([{ kind: 'thinking', durationMs: null }]), '已完成思考');
});

test('有省略时开头如实说一句，数字进 detail（P25）', () => {
  const shown = replay([{ kind: 'user', text: '写第十章' }], 7);
  assert.equal(shown, ['已重演对话：更早的 7 轮未重演', '❯ 写第十章'].join('\n'));
});

test('没有省略时不占那一行（铁律 3：正常运转的事不需要汇报）', () => {
  assert.equal(replay([{ kind: 'user', text: 'hi' }], 0), '❯ hi');
});

test('没有任何项也没有省略时一个字节都不写（全新会话的启动路径）', () => {
  const stdout = makeStdout();
  const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' } });
  printReplay({ renderer, items: [], omittedTurns: 0 });
  renderer.close();
  assert.equal(stdout.text(), '', '连 clearLive 都不该写出字节');
});

test('重演项里的正文走的是渲染器那条路：轻量 Markdown 与折行都照常', () => {
  const shown = replay([{ kind: 'prose', text: '# 第一章\n\n他**转身**走了。' }]);
  assert.ok(shown.includes('第一章'), '标题去掉井号');
  assert.ok(shown.includes('他转身走了。'), '强调去掉星号');
});

test('不认识的项类型被忽略，不抛（日志可能来自更早的版本）', () => {
  assert.equal(replay([{ kind: 'whatever', text: 'x' }, { kind: 'user', text: 'hi' }]), '❯ hi');
});

test('printReplay 在没有 renderer 时抛出来：装配错了就该炸，不该静默什么都不画', () => {
  assert.throws(() => printReplay({ items: [] }), /渲染器/);
});

test('重演末尾附上当前计划（printPlan 同一份排版）', () => {
  const stdout = makeStdout();
  const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' } });
  printReplay({
    renderer,
    items: [
      { kind: 'user', text: '改这三章' },
      { kind: 'status', terminal: 'completed', interruptReason: null, failCode: null },
    ],
    plan: [
      { summary: '改第二章', status: 'completed' },
      { summary: '改第三章', status: 'in_progress' },
    ],
  });
  renderer.close();
  const shown = screenText(stdout.text());
  assert.ok(shown.includes('❯ 改这三章'));
  assert.ok(shown.includes('任务计划 1/2'), '计划标题要出现');
  assert.ok(shown.includes('▶ 改第三章'));
  // 计划在轮次之后：找回状态时「最后一份计划」就是答案的骨架。
  assert.ok(shown.indexOf('任务计划') > shown.indexOf('已完成'));
});

test('没有计划时重演不多画任何东西', () => {
  const shown = replay([{ kind: 'user', text: '继续' }]);
  assert.equal(shown.includes('任务计划'), false);
});
