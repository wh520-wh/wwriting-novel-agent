// 斜杠联想菜单内核的测试（工单 04）：判据、过滤、循环高亮、补全产出，
// 以及与斜杠命令解析器的「子集不变性」——菜单开了的行，解析器必定认账。
import test from 'node:test';
import assert from 'node:assert/strict';

import { cycleIndex, fileMenu, historyMenu, slashMenu } from '../../src/terminal/menu.mjs';
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

// —— 历史搜索菜单内核（规格 2026-10-07 D13-D14）——

test('historyMenu：空查询列全部、子串大小写不敏感、顺序保持调用方给的新→旧', () => {
  const entries = ['写第三章', 'REVIEW 第2章', '写第一章', ''];
  const all = historyMenu({ query: '', entries });
  assert.deepEqual(all.matches.map((item) => item.text), ['写第三章', 'REVIEW 第2章', '写第一章'], '空串条目过滤，其余按最新在前');
  assert.equal(all.open, true);
  assert.equal(all.completion, '写第三章');

  const hit = historyMenu({ query: '第2章', entries });
  assert.deepEqual(hit.matches.map((item) => item.text), ['REVIEW 第2章']);

  const ascii = historyMenu({ query: 'review', entries });
  assert.deepEqual(ascii.matches.map((item) => item.text), ['REVIEW 第2章'], 'ASCII 大小写不敏感');

  const none = historyMenu({ query: '不存在的查询', entries });
  assert.equal(none.open, false);
  assert.deepEqual(none.matches, []);
  assert.equal(none.completion, null);
});

test('historyMenu：多行条目显示名取首行加省略号，补全是全文原文；高亮循环钳制', () => {
  const entries = ['第一行\n第二行', '单行'];
  const state = historyMenu({ query: '', entries, selected: 0 });
  assert.equal(state.matches[0].name, '第一行…');
  assert.equal(state.completion, '第一行\n第二行', '补全给全文原文');

  const cycled = historyMenu({ query: '', entries, selected: -1 });
  assert.equal(cycled.index, 1, '负越界回绕到最后一条');
  assert.equal(cycled.completion, '单行');
  assert.equal(cycled.hint, '↑/↓ 选择 · Tab/回车 补全 · Esc 收起', '历史菜单的提示行单独一份');
});

// —— @文件引用菜单内核（规格 2026-10-07 D15-D18）——

const FILES = [
  { path: '设定/人物.md' },
  { path: '第一章.md' },
  { path: 'OUTLINE.md' },
];

test('fileMenu：@ 触发不要求前面是空白、@ 与光标间无空白、查询子串大小写不敏感', () => {
  const start = fileMenu({ line: '@', cursor: 1, files: FILES });
  assert.equal(start.open, true, '光 @ 就触发（浏览全部）');
  assert.deepEqual(
    start.matches.map((item) => item.path),
    ['第一章.md', '设定/人物.md', 'OUTLINE.md'],
    '路径短者在前（按字符串长度，顶层文件排前面）',
  );

  // 中文写作的常态：@ 直接贴着正文（参照@设定），按空白分词就永远触发不了。
  const attached = fileMenu({ line: '参照@设', cursor: 4, files: FILES });
  assert.deepEqual(attached.matches.map((item) => item.path), ['设定/人物.md']);

  const ascii = fileMenu({ line: '@outline', cursor: 8, files: FILES });
  assert.deepEqual(ascii.matches.map((item) => item.path), ['OUTLINE.md'], '大小写不敏感');

  const none = fileMenu({ line: '写第一章', cursor: 4, files: FILES });
  assert.equal(none.open, false, '没有 @ 不触发');

  const closed = fileMenu({ line: '参照@设 修改', cursor: 7, files: FILES });
  assert.equal(closed.open, false, '@ 与光标之间出现空白：引用 token 已结束');

  const empty = fileMenu({ line: '@查无', cursor: 3, files: FILES });
  assert.equal(empty.open, false, '无命中不开菜单');
  assert.deepEqual(fileMenu({ line: '@设', cursor: 2, files: [] }).matches, [], '清单为空不开菜单');
});

test('fileMenu：补全替换从 @ 到光标的段且带尾空格；斜杠命令位不触发', () => {
  const completion = fileMenu({ line: '参照@设', cursor: 4, files: FILES });
  assert.equal(completion.completion, '参照设定/人物.md ', '@ 到光标的段被替换，尾空格结束引用');

  // 行首斜杠命令位（无空白）归斜杠菜单：'/' 菜单优先级更高（D18）。
  assert.equal(fileMenu({ line: '/mo', cursor: 3, files: FILES }).open, false);
  // 斜杠出现在行中只是普通字符：@ 照常触发。
  assert.equal(fileMenu({ line: '写/@设', cursor: 4, files: [{ path: '设定.md' }] }).open, true);

  const hint = fileMenu({ line: '@', cursor: 1, files: FILES });
  assert.equal(hint.hint, '↑/↓ 选择 · Tab 补全 · Esc 收起', '与斜杠菜单同一份提示行（回车语义相同）');
});
