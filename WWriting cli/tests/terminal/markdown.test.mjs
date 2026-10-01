// 正文 Markdown 渲染（markdown.mjs）的单元测试。
//
// 这一层测「结构与排版」：块级识别、表格三档（自然宽/折行/纵向退化）、行内样式、
// 半行与表格候选行的缓冲语义、flush 的强制收尾。上色由注入的 paint 记录，
// 真实颜色归渲染器（renderer.test / prose.test 的落地效果用例）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMarkdownWriter, plainInline, styleInline, renderTable,
} from '../../src/terminal/markdown.mjs';
import { displayWidth, proseRowWidth } from '../../src/terminal/metrics.mjs';

// 记录色调的 paint：`[bold]文字[/]`。null 色调不加记录（等价 NO_COLOR 的「只去标记」）。
const tonePaint = (text, tone) => (tone ? `[${tone}]${text}[/]` : text);
const plainPaint = (text) => text;

function writer({ columns = 80, paint = plainPaint, leadMark = '▌ ' } = {}) {
  return createMarkdownWriter({ paint, columns: () => columns, leadMark });
}

// —— 行内样式 ——

test('styleInline：粗/斜/删/行内代码/链接/转义', () => {
  assert.equal(styleInline('这是**加粗**的', tonePaint), '这是[bold]加粗[/]的');
  assert.equal(styleInline('这是*斜体*的', tonePaint), '这是[em]斜体[/]的');
  assert.equal(styleInline('这是~~删掉~~的', tonePaint), '这是[strike]删掉[/]的');
  assert.equal(styleInline('看`code()`这一句', tonePaint), '看[code]code()[/]这一句');
  assert.equal(styleInline('[第一章](https://x.test/a)', tonePaint), '第一章 [code](https://x.test/a)[/]');
  assert.equal(styleInline('[https://x.test](https://x.test)', tonePaint), 'https://x.test', '文字与地址相同时不重复画地址');
  assert.equal(styleInline('转义 \\* 不是斜体', tonePaint), '转义 * 不是斜体');
  assert.equal(styleInline('snake_case_name 不该被吃', tonePaint), 'snake_case_name 不该被吃');
  assert.equal(styleInline('a **b** c', plainPaint), 'a b c', '不注入色调时只去标记');
});

test('plainInline：与 styleInline 同一解析器，只留文字（宽度口径不漂移）', () => {
  assert.equal(plainInline('**粗**`码`[文](https://x.test)'), '粗码文 (https://x.test)');
  assert.equal(plainInline('纯文字'), '纯文字');
});

// —— 块级 ——

test('标题：h1 用 h1 色调、h2+ 用粗体；井号去掉，不带段首标记', () => {
  const w = writer({ paint: tonePaint });
  assert.deepEqual(w.push('# 第一章\n'), ['  [h1]第一章[/]']);
  assert.deepEqual(w.push('## 第二节\n'), ['  [bold]第二节[/]']);
  assert.deepEqual(w.push('###### 小标题\n'), ['  [bold]小标题[/]']);
  assert.deepEqual(w.push('#没有空格不是标题\n'), ['▌ #没有空格不是标题']);
});

test('段落：首行带段首标记、续行缩进；空行分两段、各自带标记', () => {
  const w = writer();
  assert.deepEqual(w.push('第一段第一行\n第一段第二行\n\n第二段\n'), [
    '▌ 第一段第一行',
    '  第一段第二行',
    '',
    '▌ 第二段',
  ]);
});

test('列表：无序、有序、嵌套、任务项', () => {
  const w = writer({ paint: tonePaint });
  assert.deepEqual(w.push('- 一项\n- 二项\n'), ['  - 一项', '  - 二项']);
  assert.deepEqual(w.push('1. 先写\n2. 再改\n'), ['  1. 先写', '  2. 再改']);
  assert.deepEqual(w.push('  - 嵌套一层\n'), ['    - 嵌套一层']);
  assert.deepEqual(w.push('- [ ] 未完成\n- [x] 已完成\n'), [
    '  ☐ 未完成',
    '  [success]☑ [/][done]已完成[/]',
  ]);
});

test('引用：竖线前缀；分隔线：整行横线', () => {
  const w = writer({ paint: tonePaint, columns: 40 });
  assert.deepEqual(w.push('> 一句话引用\n'), ['  [dim]│ [/]一句话引用']);
  const rule = w.push('---\n');
  assert.equal(rule.length, 1);
  assert.match(rule[0], /^  \[rule\]─+\[\/\]$/);
});

test('代码块：围栏行不显示，块内缩进更深并压暗，块外回到正文', () => {
  const w = writer({ paint: tonePaint });
  assert.deepEqual(w.push('```js\nconst a = 1;\n```\n'), ['    [code]const a = 1;[/]']);
  const after = w.push('正文\n');
  assert.deepEqual(after, ['▌ 正文'], '代码块结束之后是新的一段，带段首标记');
});

// —— 表格 ——

test('表格：自然宽横排，表头加粗，对齐按分隔行（左/中/右）', () => {
  const source = [
    '| 人物 | 身份 | 字数 |',
    '|:-----|:----:|-----:|',
    '| 沈舟 | 老板 | 1200 |',
    '| 林晚 | 邮差 | 8 |',
    '',
  ].join('\n') + '\n';
  const lines = writer().push(source);
  assert.equal(lines.length, 7);
  assert.match(lines[0], /^\s+┌/);
  assert.match(lines[1], /^\s+│ 人物 │ 身份 │ 字数 │$/, '左右各留一格、居中列两侧补空格');
  assert.ok(lines[2].includes('├'));
  assert.match(lines[3], /^\s+│ 沈舟 │ 老板 │ 1200 │$/, '右对齐列贴右');
  assert.match(lines[4], /^\s+│ 林晚 │ 邮差 │    8 │$/, '右对齐：8 补到与 1200 同宽');
  assert.match(lines[5], /^\s+└/);
  assert.equal(lines[6], '', '表格结束后的空行照常保留');
  const toned = writer({ paint: tonePaint }).push(source);
  assert.ok(toned[1].includes('[bold]人物[/]'), '表头加粗');
});

test('表格：中文按两列宽对齐；放不下时折行单元格', () => {
  const w = writer({ columns: 40 });
  const lines = w.push('| 甲 | 乙 |\n|---|---|\n| 一二三四五六七 | 九十 |\n\n');
  // 40 列 → 正文列宽 36，两列放得下（各 14/4 左右）；这里只验证总量不超宽
  for (const line of lines) assert.ok(displayWidth(line) <= 40, `不超宽：${line}`);
  const joined = lines.join('\n');
  assert.ok(joined.includes('一二三四五六七'), '完整内容都在');
});

test('表格：超出可用宽度时按列折行，行不超宽', () => {
  const columns = 30;
  const w = writer({ columns });
  const lines = w.push('| 人物 | 说明 |\n|------|------|\n| 沈舟 | 在雨夜收到一封没有署名的信，信纸带着旧墨的味道 |\n\n');
  const limit = proseRowWidth(columns);
  for (const line of lines) assert.ok(displayWidth(line) <= limit + 2, `不超正文列：${line}`);
  assert.ok(lines.join('\n').includes('沈舟'));
  const bodyRows = lines.filter((line) => line.includes('│') && !line.includes('─'));
  assert.ok(bodyRows.length >= 4, `长单元格折成多行（实际 ${bodyRows.length} 行）`);
});

test('表格：折行超过四行时退化为纵向「表头: 值」，行间横线', () => {
  const w = writer({ columns: 26 });
  const lines = w.push([
    '| 人物 | 身份 | 说明 |',
    '|------|------|------|',
    '| 沈舟 | 书店老板 | 在雨夜收到一封没有署名的信，信纸带着旧墨的味道 |',
    '',
  ].join('\n') + '\n');
  const joined = lines.join('\n');
  assert.ok(!joined.includes('┌'), '不画表格框');
  assert.ok(/人物:/.test(joined) && /身份:/.test(joined) && /说明:/.test(joined), '纵向键值对');
});

test('表格：候选行在确认前不吐；确认后才整表落地', () => {
  const w = writer();
  assert.deepEqual(w.push('| 甲 | 乙 |\n'), [], '只有一行数据时不能确定是表格（还没见到分隔行）');
  const confirmed = w.push('|---|---|\n| 1 | 2 |\n\n');
  assert.ok(joined(confirmed).includes('├'), '分隔行到达后确认表格');
  assert.match(joined(confirmed), /│ 1\s+│ 2\s+│/, '表体行跟着出来');
});

test('表格：非分隔行的下一行让候选行回到正文（不是表格）', () => {
  const w = writer();
  assert.deepEqual(w.push('| 这行不是表格 |\n'), [], '整行到达也要等下一行判分隔行');
  // 下一行不是分隔行：两行同属一段——候选行带段首标记，后一行只缩进（中间没有空行分不了段）。
  assert.deepEqual(w.push('接着一行\n'), ['▌ | 这行不是表格 |', '  接着一行']);
});

function joined(lines) {
  return lines.join('\n');
}

// —— 流式与冲刷 ——

test('长段落逐片软折行：够一行宽就吐，不够的尾巴留着等续文', () => {
  const w = writer({ columns: 20 }); // 正文列宽 16
  const first = w.push('字'.repeat(20));
  assert.ok(first.length >= 1, '够宽就立刻吐出去，不等换行');
  assert.ok(first.every((line) => displayWidth(line) <= 20));
  const second = w.push('字'.repeat(4) + '\n');
  const all = [...first, ...second];
  assert.equal(all.map((line) => line.replace(/^[▌ ]+/, '')).join(''), '字'.repeat(24));
  assert.equal(all.filter((line) => line.startsWith('▌ ')).length, 1, '整段只有一个段首标记');
});

test('绝不在句中断行：不够一行宽时什么都不吐', () => {
  const w = writer({ columns: 40 });
  assert.deepEqual(w.push('半句话'), []);
  assert.deepEqual(w.push('，再说半句。'), []);
  const done = w.push('\n');
  assert.deepEqual(done, ['▌ 半句话，再说半句。']);
});

test('flush：未闭合的表格、候选行与半行全部吐出，一个字不丢', () => {
  const w = writer();
  const out = [];
  out.push(...w.push('半行正文'));
  out.push(...w.push('\n| 甲 | 乙 |\n|---|---|'));
  out.push(...w.flush());
  const text = joined(out);
  assert.ok(text.includes('▌ 半行正文'), '半行吐出');
  assert.ok(text.includes('甲') && text.includes('乙'), '未闭合的表格按现有行画出');
});

test('表格候选行是块级开头时不软折行：等整行到达再判类型', () => {
  const w = writer({ columns: 20 });
  assert.deepEqual(w.push('| 一行很长很长的表格内容还没写完'), [], '不把可能的表格行当段落吐出去');
});

test('空输入与纯空白不产生任何输出', () => {
  const w = writer();
  assert.deepEqual(w.push(''), []);
  assert.deepEqual(w.push('\n'), ['']);
  assert.deepEqual(w.flush(), []);
});

// —— 直接调用 renderTable 的边界 ——

test('renderTable：列数不齐时缺格按空补，多余格忽略', () => {
  const lines = renderTable({
    header: ['甲', '乙'],
    aligns: ['left', 'left'],
    rows: [['1'], ['2', '3', '溢出']],
  }, { width: 60, paint: plainPaint });
  assert.ok(lines.some((line) => /│ 1\s+│\s+│/.test(line)), '缺格补空');
  assert.ok(!lines.join('').includes('溢出'), '多余格忽略');
});

test('renderTable：空表体只画表头与上下框', () => {
  const lines = renderTable({ header: ['甲'], aligns: ['left'], rows: [] }, { width: 60, paint: plainPaint });
  assert.equal(lines.length, 4, '┌ / 表头 / ├ / └');
  assert.ok(!lines.join('').includes('┼'), '只有一列时不会出现交叉符');
});
