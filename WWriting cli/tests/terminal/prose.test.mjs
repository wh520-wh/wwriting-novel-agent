// 正文管线（流式切行 + 轻量 Markdown）的测试。
//
// 为什么单独一个文件：这一段的契约是「屏幕上看到的折行必须与终端自然折行一致」，
// 与渲染器的动态行/composer 协作是两件事。纯函数直接测，落地效果再用真实渲染器验一次。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRenderer } from '../../src/terminal/renderer.mjs';
import { displayWidth, takeProseRows } from '../../src/terminal/metrics.mjs';

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

test('长逻辑行即使带换行也按阅读宽度切开，正文和多行用户消息不丢字', () => {
  const source = '长街的灯次第亮起。'.repeat(20);
  const { rows, rest } = takeProseRows(`${source}\n尾`, { width: 36 });
  assert.ok(rows.every((row) => displayWidth(row) <= 36));
  assert.equal(rows.join(''), source);
  assert.equal(rest, '尾');
});

test('中文折行不让句末标点孤立在行首，也不让开引号挂在行尾', () => {
  for (const source of ['雨从傍晚落到深夜。沈舟走进书店。', '他说：“明天见。”她点了点头。']) {
    const { rows } = takeProseRows(`${source}\n`, { width: 16 });
    assert.equal(rows.join(''), source);
    assert.ok(rows.every((row) => displayWidth(row) <= 16));
    assert.ok(rows.slice(1).every((row) => !/^[，。！？、；：”’]/.test(row)));
    assert.ok(rows.every((row) => !/[“‘]$/.test(row)));
  }
});

test('宽终端正文保持阅读列，窄终端中文行不超出屏幕', () => {
  for (const columns of [20, 40, 80, 120, 200]) {
    const stdout = makeStdout({ tty: true });
    stdout.columns = columns;
    const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' } });
    const source = '灯'.repeat(150);
    renderer.printAssistant(`${source}\n`);
    renderer.close();
    const rows = stdout.text().trimEnd().split('\n');
    assert.ok(rows.every((row) => displayWidth(row) < columns && displayWidth(row) <= 88));
    assert.equal(rows.map((row) => row.slice(2)).join(''), source);
  }
});

// —— Markdown（细粒度契约在 markdown.test.mjs，这里只做管线级抽查）——

test('行内样式：强调加粗、行内代码压暗；NO_COLOR 下只去标记、文字一个不差', () => {
  const colored = makeStdout({ tty: true });
  const rich = createRenderer({ stdout: colored, color: true });
  rich.printAssistant('**加粗**与`代码`\n');
  rich.close();
  assert.ok(colored.text().includes('\x1b[1m加粗\x1b[0m'), '上色时强调用加粗');
  assert.ok(colored.text().includes('\x1b[2m代码\x1b[0m'), '行内代码压暗');

  const plain = makeStdout({ tty: true });
  const quiet = createRenderer({ stdout: plain, env: { NO_COLOR: '1' } });
  quiet.printAssistant('**加粗**与`代码`\n');
  quiet.close();
  assert.equal(plain.text().trim(), '▌ 加粗与代码', 'NO_COLOR 下只是去掉标记，文字一个不差');
});

test('段首标记只给段落：标题与列表有自己的形态，不吃模型标记', () => {
  const stdout = makeStdout({ tty: true });
  const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' } });
  renderer.printAssistant('正文一。\n\n# 第一章\n\n- 列表项\n');
  renderer.close();
  const lines = stdout.text().split('\n');
  assert.ok(lines.includes('▌ 正文一。'), '段落首行带标记');
  assert.ok(lines.includes('  第一章'), '标题去井号、只缩进（自带强调，不再顶标记）');
  assert.ok(lines.includes('  - 列表项'), '列表项有自己的项目符号');
});

// —— 落地效果（真实渲染器）——

test('围栏代码块：围栏行不显示，块内缩进更深；块外回到正文缩进', () => {
  const stdout = makeStdout({ tty: true });
  const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' } });

  renderer.printAssistant('# 片段\n```js\nconst a = 1;\n```\n正文\n');
  renderer.close();

  const text = stdout.text();
  assert.ok(!text.includes('```'), '围栏行本身不显示');
  assert.ok(text.includes('  片段\n'), '标题去掉井号（自带强调，不顶模型标记）');
  assert.ok(text.includes('    const a = 1;\n'), '代码行缩进更深');
  assert.ok(text.includes('▌ 正文\n'), '围栏关掉之后是新的一段，带模型标记');
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
