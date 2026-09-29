// 正文管线（流式切行 + 轻量 Markdown）的测试。
//
// 为什么单独一个文件：这一段的契约是「屏幕上看到的折行必须与终端自然折行一致」，
// 与渲染器的动态行/composer 协作是两件事。纯函数直接测，落地效果再用真实渲染器验一次。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRenderer, displayWidth, renderProseRow, takeProseRows,
} from '../../src/terminal/renderer.mjs';

function makeStdout({ tty = false } = {}) {
  const chunks = [];
  return {
    isTTY: tty,
    write(text) { chunks.push(String(text)); return true; },
    text() { return chunks.join(''); },
  };
}

// —— 切行 ——

test('takeProseRows：真实换行优先，其次按显示宽度切；CJK 按 2 列算', () => {
  // 尾部没有换行的那一截留在 rest 里：它可能还会被续上，落盘要等它凑成整行（或 Run 结束）。
  assert.deepEqual(takeProseRows('甲\n乙', { width: 40 }), { rows: ['甲'], rest: '乙' });

  // 行宽 6 列 → 一行只放得下 3 个汉字（每个占 2 列）
  const { rows, rest } = takeProseRows('字'.repeat(5), { width: 6 });
  assert.deepEqual(rows, ['字字字']);
  assert.equal(rest, '字字', '不够一行的尾巴留给下一片');
});

test('takeProseRows：不足一行就不切，绝不为了早点显示而在句子中间断行', () => {
  const { rows, rest } = takeProseRows('半句话', { width: 40 });
  assert.deepEqual(rows, [], '短于一行时什么都不落盘');
  assert.equal(rest, '半句话');
});

test('takeProseRows：行尾不让标记结尾，否则屏幕上会漏出半个 **', () => {
  const source = `${'a'.repeat(3)}**bold**`;
  const { rows, rest } = takeProseRows(source, { width: 5 });

  assert.equal(rows[0], 'aaa', '把 ** 整个让到下一行，别劈成半对');
  for (const row of rows) {
    assert.ok(!/[*_`]$/.test(row), `行尾不能是标记：${row}`);
  }
  assert.equal(rows.join('') + rest, source, '一个字都没丢，也没多');
});

test('takeProseRows：一次能吃下多少行就吃多少（写出次数与行数同量级）', () => {
  const { rows, rest } = takeProseRows('一\n二\n三\n尾', { width: 40 });
  assert.deepEqual(rows, ['一', '二', '三']);
  assert.equal(rest, '尾');
});

// —— 轻量 Markdown ——

test('renderProseRow：标题去井号、强调加粗、行内代码压暗', () => {
  assert.equal(renderProseRow('# 第一章', { color: false }), '  第一章');
  assert.equal(renderProseRow('**加粗**与`代码`', { color: false }), '  加粗与代码');
  assert.ok(renderProseRow('**加粗**', { color: true }).includes('\x1b[1m'), '上色时强调用加粗');
  assert.ok(renderProseRow('`代码`', { color: true }).includes('\x1b[2m'), '行内代码压暗');
  assert.equal(renderProseRow('# 标题', { color: true }), `  \x1b[1m标题\x1b[0m`, '标题整行加粗');
  assert.equal(renderProseRow('code();', { code: true, color: false }), '    code();', '代码块比正文再进 2 格');
  assert.equal(renderProseRow('**甲**`乙`', { color: false }).trim(), '甲乙', 'NO_COLOR 下只是去掉标记，文字一个不差');
  assert.equal(renderProseRow('普通一行'), '  普通一行', '不含标记的行只加内容列缩进');
});

test('renderProseRow：段首换成模型标记 ▌，正文起点不变；代码行不吃这个标记', () => {
  // 标记占两列，与默认缩进等宽——所以首行的正文与续行仍然对齐成一列（屏幕上是一块整齐的正文）。
  assert.equal(renderProseRow('正文', { lead: '▌ ' }), '▌ 正文');
  assert.equal(displayWidth(renderProseRow('正文', { lead: '▌ ' }).match(/^\S+ /)[0]), 2, '标记占两列');
  assert.equal(renderProseRow('# 标题', { color: true, lead: '▌ ' }), `▌ \x1b[1m标题\x1b[0m`, '标题同样带标记');
  assert.equal(renderProseRow('空行不吃标记', { lead: '▌ ' }).startsWith('▌ '), true);
  assert.equal(renderProseRow('   ', { lead: '▌ ' }), '', '空行连标记一起省掉（不留尾随空格）');
  assert.equal(renderProseRow('code();', { code: true, lead: '▌ ' }), '    code();', '代码行只认缩进');
});

// —— 落地效果（真实渲染器）——

test('围栏代码块：围栏行不显示，块内缩进更深；块外回到正文缩进', () => {
  const stdout = makeStdout({ tty: true });
  const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' } });

  renderer.printAssistant('# 片段\n```js\nconst a = 1;\n```\n正文\n');
  renderer.close();

  const text = stdout.text();
  assert.ok(!text.includes('```'), '围栏行本身不显示');
  assert.ok(text.includes('▌ 片段\n'), '标题去掉井号、带模型标记，正文起点落在内容列');
  assert.ok(text.includes('    const a = 1;\n'), '代码行缩进更深');
  assert.ok(text.includes('  正文\n'), '围栏关掉之后回到正文的缩进');
});

test('长段落一次落盘成多行，每行都不超过行宽（与终端自然折行一致）', () => {
  const stdout = makeStdout({ tty: true });
  stdout.columns = 40;
  const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' } });

  renderer.printAssistant('字'.repeat(120));
  renderer.close();

  const rows = stdout.text().split('\n').filter((line) => line.includes('字'));
  assert.ok(rows.length >= 4, `按行宽切开（实际 ${rows.length} 行）`);
  for (const row of rows.slice(0, -1)) {
    assert.ok(displayWidth(row) <= 40, `每行都在行宽内：${displayWidth(row)}`);
  }
  assert.equal(rows.join('').replace(/[▌ ]/g, ''), '字'.repeat(120), '一个字都没丢，也没多');
  // 标记只出现在段首那一行：每行都顶一个 `▌` 会把屏幕糊成一片竖线。
  assert.equal(rows.filter((row) => row.startsWith('▌ ')).length, 1, '一整段只有一个模型标记');
});

test('正文里的连续空行原样保留，不会被行宽逻辑吃掉；空行前后各起一段', () => {
  const stdout = makeStdout({ tty: true });
  const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' } });

  renderer.printAssistant('前\n\n后\n');
  renderer.close();

  assert.ok(stdout.text().includes('▌ 前\n\n▌ 后\n'), '段落之间的空行是正文的一部分，两段各带标记');
});

test('工具行打断正文：工具行之后模型再开口，那一行重新带标记（确实是新的一段）', () => {
  const stdout = makeStdout({ tty: true });
  const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' } });

  renderer.printAssistant('先看一眼。\n');
  renderer.printActivity({ state: 'done', label: '读取文件 大纲.md' });
  renderer.printAssistant('看完了。\n');
  renderer.close();

  const lines = stdout.text().split('\n');
  assert.ok(lines.includes('▌ 先看一眼。'), '第一段带标记');
  assert.ok(lines.includes('✓ 读取文件 大纲.md'), '工具行有自己的标记，与模型标记不同形');
  assert.ok(lines.includes('▌ 看完了。'), '工具行切断了段落，模型再开口是新的一段');
});

test('正文续行不带标记：一段正文跨多次 flush 也只标首行', () => {
  const stdout = makeStdout({ tty: true });
  stdout.columns = 20;
  const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' } });

  renderer.printAssistant('甲乙丙丁\n');
  renderer.printAssistant('戊己庚辛\n');
  renderer.close();

  const lines = stdout.text().split('\n');
  assert.ok(lines.includes('▌ 甲乙丙丁'));
  assert.ok(lines.includes('  戊己庚辛'), '同一段的第二行只缩进');
});
