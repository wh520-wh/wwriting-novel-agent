// 选择器测试：纯逻辑（菜单行 / 按键归约 / 滚动窗口）+ 驱动（原始按键 → 选项）。
//
// 交互契约对齐 grokbuild 的选择器：↑/↓（或 k/j）移动、回车确认、数字直选、Esc 取消；
// 光标行用 `❯` 标出，NO_COLOR 下不靠颜色也能看出选中的是哪一行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { displayWidth } from '../../src/terminal/metrics.mjs';
import { screenText } from '../helpers/screen.mjs';

import {
  MENU_CURSOR,
  createSelector,
  menuAction,
  menuLines,
  menuWindow,
} from '../../src/terminal/select.mjs';

const ITEMS = [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }, { id: 'c', label: '丙' }];

// 记录写入的内存 stdout。
function makeSink({ tty = true } = {}) {
  const chunks = [];
  return {
    isTTY: tty,
    columns: 80,
    write(text) { chunks.push(String(text)); return true; },
    text: () => chunks.join(''),
  };
}

// 伪 TTY stdin：能发 'keypress'，记录 setRawMode 的调用。
function makeFakeStdin() {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.isRaw = false;
  const rawCalls = [];
  stream.setRawMode = (value) => { rawCalls.push(value); stream.isRaw = value; };
  stream.rawCalls = rawCalls;
  return stream;
}

function press(stdin, name, sequence = undefined) {
  stdin.emit('keypress', sequence ?? name, { name, sequence: sequence ?? name, ctrl: false });
}

function pressCtrlC(stdin) {
  stdin.emit('keypress', '\x03', { name: 'c', sequence: '\x03', ctrl: true });
}

// —— 纯逻辑 ——

test('menuLines：光标行用 ❯ 标出，其余行用空格占位；标题与操作提示各一行', () => {
  const lines = menuLines({ title: '① 模型厂商', items: ITEMS, selected: 1, hint: '↑/↓ 选择' });

  assert.equal(lines[0], '① 模型厂商');
  assert.equal(lines[1], '  甲');
  assert.equal(lines[2], `${MENU_CURSOR} 乙`, '光标在第 2 项');
  assert.equal(lines[3], '  丙');
  assert.equal(lines[4], '  ↑/↓ 选择');
});

test('menuLines：不给颜色时一个 ANSI 字节都没有（NO_COLOR），选择仍看得见', () => {
  const plain = menuLines({ title: '标题', items: ITEMS, selected: 0, hint: '提示', color: false });
  assert.equal(plain.some((line) => line.includes('\x1b')), false);
  assert.ok(plain[1].startsWith(MENU_CURSOR));

  const colored = menuLines({ title: '标题', items: ITEMS, selected: 0, hint: '提示', color: true });
  assert.ok(colored[1].includes('\x1b['), '有颜色时光标行上色');
});

test('menuWindow：项数不超上限时全显示；超出时窗口跟着光标滚动', () => {
  assert.deepEqual(menuWindow(3, 0, 10), { start: 0, end: 3 });
  // 12 项、窗口 5 行：光标在最后一行时窗口贴底，光标始终可见。
  assert.deepEqual(menuWindow(12, 0, 5), { start: 0, end: 5 });
  assert.deepEqual(menuWindow(12, 11, 5), { start: 7, end: 12 });
  const mid = menuWindow(12, 6, 5);
  assert.ok(mid.start <= 6 && 6 < mid.end, '光标必须在窗口内');
});

test('menuLines：窗口外的项用「还有 N 项」提示，不静默截断', () => {
  const lines = menuLines({ items: Array.from({ length: 8 }, (_, i) => ({ id: `i${i}`, label: `第 ${i} 项` })), selected: 7, maxRows: 3 });
  assert.ok(lines.some((line) => line.includes('上面还有')), '上方被折叠要有提示');
  assert.ok(lines.some((line) => line.includes('第 7 项')), '光标项必须在可见范围内');
});

test('窄窗口菜单不软折行，选中项仍可查看描述；NO_COLOR 选择不依赖颜色', () => {
  const lines = menuLines({ columns: 40, selected: 0, title: '会话', hint: '↑/↓ 选择 · 回车确认 · Esc 取消',
    items: [{ id: 'a', label: '昨天的会话', description: '80a922de-22c1-43fa-95d6-001dc8807677' },
      { id: 'b', label: '长'.repeat(40) }] });
  assert.ok(lines.every((line) => displayWidth(line) < 40));
  assert.ok(lines.some((line) => line.includes('80a922de-22c1-43fa-95d6-001dc8807677')));
  assert.ok(lines.some((line) => line.startsWith('❯ ')));
});

test('描述从两行收成一行时，重绘与 Esc 取消不留下菜单残影', async () => {
  const stdin = makeFakeStdin();
  const stdout = makeSink();
  stdout.columns = 40;
  const pending = createSelector({ stdin, stdout, env: { NO_COLOR: '1' } }).ask({ title: '选择模型',
    items: [{ id: 'a', label: '第一项', description: '说明'.repeat(25) }, { id: 'b', label: '第二项' }] });
  press(stdin, 'down');
  const screen = screenText(stdout.text(), { cols: 40 });
  assert.ok(screen.includes('❯ 第二项'));
  assert.equal(screen.includes('说明'), false);
  press(stdin, 'escape');
  await pending;
  assert.equal(screenText(stdout.text(), { cols: 40 }), '');
});

test('menuAction：↑/↓ 与 k/j 移动、回车确认、Esc 与 Ctrl+C 取消、数字直选', () => {
  assert.deepEqual(menuAction({ name: 'down' }, { selected: 0, count: 3 }), { type: 'move', selected: 1 });
  assert.deepEqual(menuAction({ name: 'up' }, { selected: 1, count: 3 }), { type: 'move', selected: 0 });
  assert.deepEqual(menuAction({ name: 'down', sequence: 'j' }, { selected: 0, count: 3 }), { type: 'move', selected: 1 });
  assert.deepEqual(menuAction({ name: 'up', sequence: 'k' }, { selected: 1, count: 3 }), { type: 'move', selected: 0 });
  assert.deepEqual(menuAction({ name: 'down' }, { selected: 0, count: 1 }), { type: 'move', selected: 0 }, '只有一个选项时不动');
  assert.deepEqual(menuAction({ name: 'up' }, { selected: 0, count: 3 }), { type: 'move', selected: 0 }, '到顶就不再上');
  assert.deepEqual(menuAction({ name: 'return' }, { selected: 2, count: 3 }), { type: 'confirm' });
  assert.deepEqual(menuAction({ name: 'escape' }, { selected: 0, count: 3 }), { type: 'cancel' });
  assert.deepEqual(menuAction({ name: 'c', ctrl: true }, { selected: 0, count: 3 }), { type: 'cancel' });
  assert.deepEqual(menuAction({ name: '2', sequence: '2' }, { selected: 0, count: 3 }), { type: 'select', selected: 1 });
  assert.equal(menuAction({ name: '9', sequence: '9' }, { selected: 0, count: 3 }), null, '超出范围的数字键忽略');
  assert.equal(menuAction({ name: 'x', sequence: 'x' }, { selected: 0, count: 3 }), null, '无关按键忽略');
});

// —— 驱动：真的按键盘 ——

test('ask：↓ 移动光标、回车确认，选中项收成一行摘要', async () => {
  const stdin = makeFakeStdin();
  const stdout = makeSink();
  const selector = createSelector({ stdin, stdout, env: { NO_COLOR: '1' } });
  assert.equal(selector.canAsk, true);

  const pending = selector.ask({
    title: '① 模型厂商',
    items: ITEMS,
    summary: (item) => `已选：${item.label}`,
  });

  await new Promise((resolve) => setImmediate(resolve));
  press(stdin, 'down');
  await new Promise((resolve) => setImmediate(resolve));
  press(stdin, 'return');

  const result = await pending;
  assert.equal(result.index, 1);
  assert.equal(result.item.id, 'b');

  const text = stdout.text();
  assert.ok(text.includes(`${MENU_CURSOR} 甲`), '首屏光标在第一项');
  // 块高 = 标题 1 + 选项 3 + 操作提示 1；重绘靠整块上移再重写，块尾始终停在新行行首。
  assert.ok(text.includes('\x1b[5A'), '重绘时整块上移');
  assert.ok(text.includes(`${MENU_CURSOR} 乙`), '移动后光标到第二项');
  assert.ok(text.includes('已选：乙'), '收尾压成一行摘要进 scrollback');
  assert.ok(text.includes('\x1b[J'), '块的多余行被抹掉');
  // 契约（真机 ConPTY 走查改定）：选择器只在进入时开一次 raw，结束**不得**自行翻回——
  // 「false→true」紧挨输出活动翻转会吞掉宿主的第一波按键；后续 raw 的开关归
  // 下一个 readline 的构造（true）与 rl.close()（false）管，两条路都覆盖。
  assert.deepEqual(stdin.rawCalls, [true], '选择器结束后不得再翻 raw 模式');
  assert.equal(stdin.isRaw, true);
});

test('ask：数字键直选并立刻确认', async () => {
  const stdin = makeFakeStdin();
  const selector = createSelector({ stdin, stdout: makeSink(), env: {} });

  const pending = selector.ask({ items: ITEMS, summary: (item) => `已选：${item.label}` });
  await new Promise((resolve) => setImmediate(resolve));
  press(stdin, '3', '3');

  const result = await pending;
  assert.equal(result.index, 2);
  assert.equal(result.item.id, 'c');
});

test('ask：Esc 取消返回 null，并按 cancelSummary 收尾', async () => {
  const stdin = makeFakeStdin();
  const stdout = makeSink();
  const selector = createSelector({ stdin, stdout, env: {} });

  const pending = selector.ask({ items: ITEMS, cancelSummary: '（已跳过）' });
  await new Promise((resolve) => setImmediate(resolve));
  press(stdin, 'escape');

  assert.equal(await pending, null);
  assert.ok(stdout.text().includes('（已跳过）'));
  // 取消路径同样不翻 raw（真机 ConPTY 吞键竞态，见 ask 确认路径那条契约）。
  assert.deepEqual(stdin.rawCalls, [true]);
});

test('ask：Ctrl+C 等同取消（不把用户困在菜单里）', async () => {
  const stdin = makeFakeStdin();
  const selector = createSelector({ stdin, stdout: makeSink(), env: {} });

  const pending = selector.ask({ items: ITEMS });
  await new Promise((resolve) => setImmediate(resolve));
  pressCtrlC(stdin);

  assert.equal(await pending, null);
});

test('ask：非交互或没有选项时不假装能选，直接返回 null', async () => {
  const selector = createSelector({ stdin: makeFakeStdin(), stdout: makeSink({ tty: false }), env: {} });
  assert.equal(selector.canAsk, false);
  assert.equal(await selector.ask({ items: ITEMS }), null);

  const interactive = createSelector({ stdin: makeFakeStdin(), stdout: makeSink(), env: {} });
  assert.equal(await interactive.ask({ items: [] }), null);
});

test('redrawBlock 用上一块的高度上移：块高摆动时不再吃掉菜单上方一行（猎捕报告 10）', async () => {
  // 15 项 / 窗口 10：块高随「上面还有 N 项」「下面还有 M 项」的出现消失在 12↔13 间摆动。
  // 块尾锚在光标处、动的是顶边——上移量必须等于**上一块**的高度；用新块高度，
  // 块变高时多吃上方一行，块变矮时残留块顶一行。
  const stdout = makeSink();
  const stdin = makeFakeStdin();
  const selector = createSelector({ stdin, stdout, env: { NO_COLOR: '1' } });
  const items = Array.from({ length: 15 }, (_, i) => ({ id: `i${i}`, label: `第 ${i} 项` }));
  const heightAt = (selected) => menuLines({ items, selected, maxRows: 10 }).length;

  const pending = selector.ask({ items, hint: null });
  await new Promise((resolve) => setImmediate(resolve));

  const expected = [];
  for (let selected = 0; selected < 14; selected += 1) {
    expected.push(heightAt(selected)); // 从 selected 移到 selected+1：上移量 = 当前块高
    press(stdin, 'down');
  }
  const duringMoves = stdout.text(); // 回车前截取：排除收尾 collapse 的那次 cursorUp
  press(stdin, 'return');
  await pending;

  const ups = [...duringMoves.matchAll(/\x1b\[(\d+)A/g)].map((match) => Number(match[1]));
  assert.deepEqual(ups, expected, `每次重绘的上移量必须等于上一块高度：${JSON.stringify(ups)}`);
});
