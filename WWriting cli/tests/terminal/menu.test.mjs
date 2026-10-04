// 斜杠联想菜单内核的测试（工单 04）：判据、过滤、循环高亮、补全产出，
// 以及与斜杠命令解析器的「子集不变性」——菜单开了的行，解析器必定认账。
import test from 'node:test';
import assert from 'node:assert/strict';

import { cycleIndex, slashMenu } from '../../src/terminal/menu.mjs';
import { parseSlashCommand } from '../../src/terminal/commands.mjs';

const COMMANDS = Object.freeze([
  { name: '/model', description: '设置模型与 API Key' },
  { name: '/mode-x', description: '测试同名前缀' },
  { name: '/resume', description: '切换会话' },
  { name: '/stop', description: '停止当前这一轮' },
]);

test('行首斜杠打开菜单：列出全部命中、高亮初始在第一条、补全带尾空格', () => {
  const state = slashMenu({ line: '/', commands: COMMANDS });
  assert.equal(state.open, true);
  assert.deepEqual(state.matches.map((item) => item.name), ['/model', '/mode-x', '/resume', '/stop']);
  assert.equal(state.index, 0);
  assert.equal(state.completion, '/model ');

  const filtered = slashMenu({ line: '/mo', commands: COMMANDS });
  assert.deepEqual(filtered.matches.map((item) => item.name), ['/model', '/mode-x']);
  assert.equal(filtered.completion, '/model ');
});

test('非命令位置不开菜单：行中斜杠（紧贴文字/前带空格）都是普通字符', () => {
  for (const line of ['写第一章/第二章', '写 /mo', '看 /model 吧', '前后/夹住/', '//']) {
    const state = slashMenu({ line, commands: COMMANDS });
    assert.equal(state.open, false, `「${line}」不该开菜单`);
    assert.deepEqual(state.matches, []);
    assert.equal(state.completion, null);
  }
});

test('token 打完（出现空白，含全角空格/NBSP）菜单收起——进入参数输入态', () => {
  for (const line of ['/model ', '/resume 摘要', '/mode\u3000', '/mode\u00a0']) {
    const state = slashMenu({ line, commands: COMMANDS });
    assert.equal(state.open, false, `「${JSON.stringify(line)}」token 已结束，菜单应收起`);
  }
});

test('无命中前缀视为菜单关闭', () => {
  const state = slashMenu({ line: '/zz', commands: COMMANDS });
  assert.equal(state.open, false);
  assert.deepEqual(state.matches, []);
});

test('循环高亮：越界双向回绕、大步长、非法值回 0、空表回 0', () => {
  assert.equal(cycleIndex(0, -1, 3), 2, '第一条向上 = 最后一条');
  assert.equal(cycleIndex(2, 1, 3), 0, '最后一条向下 = 第一条');
  assert.equal(cycleIndex(0, -7, 3), 2, '大步长同样回绕');
  assert.equal(cycleIndex(NaN, 1, 3), 1, 'selected 非法按 0 计');
  assert.equal(cycleIndex(1, NaN, 3), 1, 'delta 非法按 0 计');
  assert.equal(cycleIndex(0, 1, 0), 0, '空表回 0');
  assert.equal(cycleIndex(5, 0, undefined), 0, 'total 非法回 0');
});

test('selected 越界时状态机自动钳回合法位（菜单变矮后高亮不悬空）', () => {
  const state = slashMenu({ line: '/', commands: COMMANDS, selected: 99 });
  assert.equal(state.index, 3, '99 对 4 条循环钳制：99 mod 4 = 3');
  const shrunk = slashMenu({ line: '/s', commands: COMMANDS, selected: 3 });
  assert.deepEqual(shrunk.matches.map((item) => item.name), ['/stop']);
  assert.equal(shrunk.index, 0);
});

test('子集不变性：菜单打开的行解析器必定认账，正文斜杠两边都不当命令', () => {
  for (const line of ['/', '/mo', '/model', '/zz']) {
    const state = slashMenu({ line, commands: COMMANDS });
    const parsed = parseSlashCommand(line);
    assert.ok(parsed !== null, `菜单开着（${line}）解析器却不当命令`);
    assert.equal(parsed.name, line.slice(1).toLowerCase(), '解析器认领的命令名与行首 token 一致');
  }
  // 菜单不开的行，解析器行为照旧（本票不动解析器，这里钉住两侧共识）：
  assert.equal(parseSlashCommand('写/model'), null, '正文里的斜杠解析器也不当命令');
  assert.deepEqual(parseSlashCommand('/mo '), { name: 'mo', args: '' }, '带尾空格的命令行解析照旧');
});
