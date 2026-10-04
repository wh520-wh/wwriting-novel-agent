// VT 解释器自测。
//
// 它是「屏幕画面」这类断言的地基：算错宽度或折行，别的用例就会以看似合理的方式失败
// （或者更糟——假通过）。所以把几条容易踩的语义钉在这里。
import test from 'node:test';
import assert from 'node:assert/strict';

import { renderScreen, screenLineOf, screenText } from './screen.mjs';

test('换行：`\\n` 在 Windows 控制台里就是回车换行（列要归零）', () => {
  assert.deepEqual(screenText('abc\ndef').split('\n'), ['abc', 'def']);
});

test('自动折行：写满一行才折，且不留多余的空白行', () => {
  assert.deepEqual(screenText('x'.repeat(25), { cols: 10 }).split('\n'), ['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx']);
});

test('待换行：正好写满一行不算折行，下一个字符才换行', () => {
  // 20 个字写满 2 行，不该凭空多出第 3 行
  assert.equal(screenText('x'.repeat(20), { cols: 10 }).split('\n').length, 2);
  assert.equal(screenText('x'.repeat(21), { cols: 10 }).split('\n').length, 3);
});

test('宽度：CJK 占两列，块元素 `█` 占一列（横幅就是用它拼的）', () => {
  assert.deepEqual(screenText('汉字', { cols: 10 }).split('\n'), ['汉字']);
  // 4 个方块字符 = 4 列；若错算成 2 列一个，10 列的屏幕会折成 8 列就换行
  assert.equal(renderScreen('████' + 'x'.repeat(6), { cols: 10 })[0], '████xxxxxx');
});

test('光标控制：CHA（列定位）、CUU/CUD（上下移）、EL/ED（抹行抹屏）', () => {
  const line = (bytes, index = 0) => renderScreen(bytes)[index];
  // 列定位：写到第 5 列再回头覆盖
  assert.equal(line('abcdefg\x1b[3GXY'), 'abXYefg');
  // 上移一行、列定位到第 2 列（CHA 是 1 基）再写：覆盖上一行的第 2、3 个字符
  assert.equal(line('abc\ndef\x1b[1A\x1b[2GXY'), 'aXY');
  // 抹到行尾：留着前半段
  assert.equal(line('abcdef\x1b[4G\x1b[K'), 'abc');
  // 抹到屏尾：光标处及其后的一切都空，之前的不动
  const fromSecondRow = renderScreen('abc\ndef\x1b[2G\x1b[0J');
  assert.deepEqual([fromSecondRow[0], fromSecondRow[1]], ['abc', 'd']);
  const fromFirstRow = renderScreen('abc\ndef\x1b[1A\x1b[3G\x1b[0J');
  assert.deepEqual([fromFirstRow[0], fromFirstRow[1]], ['ab', '']);
});

test('SGR（颜色码）只被丢弃，不影响字符位置', () => {
  assert.equal(screenText('\x1b[36m❯ \x1b[0m写第一章').trim(), '❯ 写第一章');
});

test('OSC 序列整段跳过：标题/剪贴板这类带外序列不落画面也不动光标', () => {
  // ConPTY 会在流水线里注入自己的 OSC 0 标题；不跳过就会把 `]0;…` 当正文打出来，
  // 整幅画面右移错行。BEL 与 ST（ESC \）两种收尾都要认。
  assert.equal(screenText('\x1b]0;C:\\Program Files\\node.exe\x07写第一章'), '写第一章');
  assert.equal(screenText('\x1b]52;c;aGVsbG8=\x1b\\写第一章'), '写第一章');
});

test('screenLineOf：按行号定位，找不到给 -1', () => {
  const bytes = '第一行\n第二行';
  assert.equal(screenLineOf(bytes, '第二行'), 1);
  assert.equal(screenLineOf(bytes, '没有'), -1);
});
