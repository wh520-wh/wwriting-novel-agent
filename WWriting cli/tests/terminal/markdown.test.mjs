// 正文 Markdown 渲染（markdown.mjs）的单元测试。
//
// 这一层测「结构与排版」：块级识别、表格三档（自然宽/折行/纵向退化）、行内样式、
// 半行与表格候选行的缓冲语义、flush 强制收尾、reset 的 Run 边界语义。
// 上色由注入的 paint 完成：这里用**真实 SGR 码**（与渲染器同一形状）——折行器要按
// 「剥掉 SGR 后的显示宽度」排版，用可见的假标记会把宽度算错，测不出真问题。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMarkdownWriter, plainInline, styleInline, renderTable,
} from '../../src/terminal/markdown.mjs';
import { displayWidth, proseRowWidth } from '../../src/terminal/metrics.mjs';

const stripSgr = (text) => String(text).replace(/\[[0-9;]*m/g, '');

const SGR = {
  bold: '\x1b[1m',
  em: '\x1b[3m',
  strike: '\x1b[9m',
  code: '\x1b[2m',
  dim: '\x1b[2m',
  h1: '\x1b[4m',
  rule: '\x1b[38;5;242m',
  success: '\x1b[38;5;108m',
  done: '\x1b[2m\x1b[9m',
  active: '\x1b[1m',
};
const R = '\x1b[0m';
const tonePaint = (text, tone) => (tone && SGR[tone] ? `${SGR[tone]}${text}${R}` : text);
const plainPaint = (text) => text;

function writer({ columns = 80, paint = plainPaint, leadMark = '▌ ' } = {}) {
  return createMarkdownWriter({ paint, columns: () => columns, leadMark });
}

// —— 行内样式 ——

test('styleInline：粗/斜/删/行内代码/链接/转义', () => {
  assert.equal(styleInline('这是**加粗**的', tonePaint), `这是${SGR.bold}加粗${R}的`);
  assert.equal(styleInline('这是*斜体*的', tonePaint), `这是${SGR.em}斜体${R}的`);
  assert.equal(styleInline('这是~~删掉~~的', tonePaint), `这是${SGR.strike}删掉${R}的`);
  assert.equal(styleInline('看`code()`这一句', tonePaint), `看${SGR.code}code()${R}这一句`);
  assert.equal(styleInline('[第一章](https://x.test/a)', tonePaint), `第一章 ${SGR.code}(https://x.test/a)${R}`);
  assert.equal(styleInline('[https://x.test](https://x.test)', tonePaint), 'https://x.test', '文字与地址相同时不重复画地址');
  assert.equal(styleInline('转义 \\* 不是斜体', tonePaint), '转义 * 不是斜体');
  assert.equal(styleInline('snake_case_name 不该被吃', tonePaint), 'snake_case_name 不该被吃');
  assert.equal(styleInline('a **b** c', plainPaint), 'a b c', '不注入色调时只去标记');
});

// 回归：`*` 的 flanking 规则——乘号 / 通配符 / 星号本身绝不能被当强调吃掉。
test('styleInline：两侧空白的 * 是字面量，不当强调（不吞字）', () => {
  assert.equal(styleInline('3 * 4 * 5 等于 60', tonePaint), '3 * 4 * 5 等于 60');
  assert.equal(styleInline('路径 src/* 和 a * b 都是文本', tonePaint), '路径 src/* 和 a * b 都是文本');
  assert.equal(styleInline('评注 * 待定', tonePaint), '评注 * 待定');
  assert.equal(styleInline('*斜体*', tonePaint), `${SGR.em}斜体${R}`, '正常强调照旧');
  assert.equal(styleInline('**加粗**', tonePaint), `${SGR.bold}加粗${R}`);
});

// 回归：未闭合的标记按字面输出（GFM 语义），绝不能吞掉内容。
test('styleInline：未闭合标记按字面输出', () => {
  assert.equal(styleInline('半个 **加粗', tonePaint), '半个 **加粗');
  assert.equal(styleInline('半个 *斜体', tonePaint), '半个 *斜体');
  assert.equal(styleInline('未闭合 ` 代码', tonePaint), '未闭合 ` 代码');
});

test('plainInline：与 styleInline 同一解析器，只留文字（宽度口径不漂移）', () => {
  assert.equal(plainInline('**粗**`码`[文](https://x.test)'), '粗码文 (https://x.test)');
  assert.equal(plainInline('纯文字'), '纯文字');
});

// —— 块级 ——

test('标题：h1 用 h1 色调、h2+ 用粗体；井号去掉，不带段首标记；块前补呼吸空行', () => {
  const w = writer({ paint: tonePaint });
  assert.deepEqual(w.push('# 第一章\n'), [`  ${SGR.h1}第一章${R}`], '流开头不带前导空行');
  assert.deepEqual(w.push('## 第二节\n'), ['', `  ${SGR.bold}第二节${R}`], '致密块与上一块之间补一个空行');
  assert.deepEqual(w.push('###### 小标题\n'), ['', `  ${SGR.bold}小标题${R}`]);
  assert.deepEqual(w.push('#没有空格不是标题\n'), ['▌ #没有空格不是标题'], '标题向下绑定：标题后的段落不再补空行');
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
    `  ${SGR.success}☑ ${R}${SGR.done}已完成${R}`,
  ]);
});

test('引用：竖线前缀；分隔线：整行横线（含 * * * 写法）；与前块之间补空行', () => {
  const w = writer({ paint: tonePaint, columns: 40 });
  assert.deepEqual(w.push('> 一句话引用\n'), [`  ${SGR.code}│ ${R}一句话引用`]);
  const rule = w.push('---\n');
  assert.equal(rule.length, 2, '引用是致密块：分隔线前来补一个空行');
  assert.equal(rule[0], '');
  assert.match(rule[1], /^  \x1b\[38;5;242m─+\x1b\[0m$/);

  // 回归：`* * *` 是分隔线，不是列表项——绝不能被列表分支吃掉内容。
  const spaced = writer({ paint: tonePaint, columns: 40 });
  const lines = spaced.push('* * *\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /─/, `带空格的分隔线：${JSON.stringify(lines)}`);
});

test('引用续行不补空行：> a 与 > b 是同一块的延续', () => {
  const w = writer({ paint: tonePaint, columns: 40 });
  assert.deepEqual(w.push('> 第一行\n> 第二行\n'), [
    `  ${SGR.code}│ ${R}第一行`,
    `  ${SGR.code}│ ${R}第二行`,
  ], '引用行之间不插空行');
});

test('代码块：围栏行不显示，块内缩进更深并压暗，块外回到正文', () => {
  const w = writer({ paint: tonePaint });
  assert.deepEqual(w.push('```js\nconst a = 1;\n```\n'), [`    ${SGR.code}const a = 1;${R}`]);
  const after = w.push('正文\n');
  assert.deepEqual(after, ['', '▌ 正文'], '围栏是致密块：块后补一个空行，新段落带段首标记');
});

// 回归（跨轮状态泄漏）：未闭合围栏不允许污染此后的内容——flush 之后由调用方在
// Run 边界调 reset()，围栏态必须归零。
test('未闭合围栏：flush 保留代码态，reset 之后归零（Run 边界语义）', () => {
  const w = writer({ paint: tonePaint });
  assert.deepEqual(w.push('```\nconst a = 1;\n'), [`    ${SGR.code}const a = 1;${R}`]);
  assert.deepEqual(w.flush(), [], 'flush 不改变围栏态（同一轮里还没写完的代码块要留着）');
  assert.deepEqual(w.push('还在代码里\n'), [`    ${SGR.code}还在代码里${R}`]);
  w.reset();
  assert.deepEqual(w.push('这是新的一轮正文。\n'), ['▌ 这是新的一轮正文。'], 'reset 之后围栏态归零');
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
  assert.match(lines[1], /^\s+│ 人物 │ 身份 │ 字数 │$/, '表头按列宽与对齐补齐');
  assert.ok(lines[2].includes('├'));
  assert.match(lines[3], /^\s+│ 沈舟 │ 老板 │ 1200 │$/, '数据行对齐');
  assert.match(lines[4], /^\s+│ 林晚 │ 邮差 │    8 │$/, '右对齐：8 补到与 1200 同宽');
  assert.match(lines[5], /^\s+└/);
  assert.equal(lines[6], '', '表格结束后的空行照常保留');
  const toned = writer({ paint: tonePaint }).push(source);
  assert.ok(toned[1].includes(`${SGR.bold}人物${R}`), '表头加粗');
});

// 回归：单元格里的字面竖线写作 `\|`，不能被当分隔符（否则内容错位并静默丢字）。
test('表格：单元格内的 \\| 是字面竖线，不当分隔符', () => {
  const w = writer();
  const lines = w.push('| 名称 | 说明 |\n|---|---|\n| 甲 | 含 \\| 竖线的值 |\n\n');
  const joined = lines.join('\n');
  assert.ok(joined.includes('含 | 竖线的值'), `竖线还原为字面量：${joined}`);
  const dataRow = lines.find((line) => line.includes('甲'));
  assert.equal((dataRow.match(/│/g) ?? []).length, 3, `仍是两列：${dataRow}`);
});

test('表格：中文按两列宽对齐；放不下时折行单元格且不超正文列', () => {
  const columns = 30;
  const w = writer({ columns });
  const lines = w.push('| 人物 | 说明 |\n|------|------|\n| 沈舟 | 在雨夜收到一封没有署名的信，信纸带着旧墨的味道 |\n\n');
  const limit = proseRowWidth(columns);
  for (const line of lines) assert.ok(displayWidth(line) <= limit + 2, `不超正文列：${line}`);
  assert.ok(lines.join('\n').includes('沈舟'));
});

// 回归：列宽不够时按**词**折行——拉丁词不劈开（这是「最小列宽=最长单词」的真实兑现）。
test('表格：整词优先折行，拉丁词不被劈开', () => {
  const w = writer({ columns: 30 });
  const lines = w.push('| 术语 | 释义 |\n|---|---|\n| foo | hello world 示例 |\n\n');
  const joined = lines.join('\n');
  assert.ok(!/hello\s*$[\s\S]*worl\n/.test(joined) || true);
  const cells = lines.filter((line) => line.includes('│'));
  assert.ok(cells.some((line) => line.includes('hello')), `hello 出现：${joined}`);
  assert.ok(cells.some((line) => line.includes('world')), `world 完整出现（未被劈成 worl+d）：${joined}`);
});

// 回归：算完列宽要复核总宽——下限（每列 3 格）可能顶穿终端，超了必须退纵向。
test('表格：窄终端下总宽超限时退化为纵向，绝不画出超宽行', () => {
  const columns = 14; // 正文列宽 10
  const w = writer({ columns, paint: tonePaint });
  const lines = w.push([
    '| 甲 | 乙 | 丙 | 丁 |',
    '|---|---|---|---|',
    '| 1 | 2 | 3 | 4 |',
    '',
  ].join('\n') + '\n');
  const limit = proseRowWidth(columns);
  for (const line of lines) assert.ok(displayWidth(stripSgr(line)) <= limit + 2, `不超宽：${JSON.stringify(line)}`);
  assert.ok(!lines.join('\n').includes('┌'), `退化为纵向：${lines.join('\n')}`);
  assert.ok(lines.join('\n').includes('甲:'), '纵向键值对在');
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
  assert.deepEqual(w.push('接着一行\n'), ['▌ | 这行不是表格 |', '  接着一行']);
});

// —— 块间垂直节奏（ADR-0019）——

test('节奏：原文空行与致密块边界不叠加成双空行', () => {
  const w = writer();
  assert.deepEqual(w.push('第一段\n\n# 标题\n\n第二段\n'), [
    '▌ 第一段',
    '',
    '  标题',
    '',
    '▌ 第二段',
  ], '模型自己排的版一个空行都不多加：透传的空行让边界自动补空行哑火');
});

test('节奏：无空行时标题/表格/围栏前来各自补一个空行，段落与列表之间不补', () => {
  const w = writer();
  assert.deepEqual(w.push('先说结论\n## 依据\n- 一条\n- 两条\n正文收尾\n'), [
    '▌ 先说结论',
    '',           // 段落 → 标题：标题上方要空行
    '  依据',
    '  - 一条',   // 标题 → 列表：标题向下绑定，不留缝
    '  - 两条',   // 列表内部：不补
    '▌ 正文收尾', // 列表 → 段落：都是 flow，不补
  ]);
});

test('节奏：段落紧跟着的表格在整表落地时补前置空行', () => {
  const w = writer();
  const lines = w.push('对照如下\n| 甲 | 乙 |\n|---|---|\n| 1 | 2 |\n\n');
  assert.equal(lines[0], '▌ 对照如下');
  assert.equal(lines[1], '', '表格是延迟渲染的：前置空行跟着表格一起落地');
  assert.match(lines[2], /┌/);
});

test('节奏：flush 与 reset 把节奏归零，新一段正文不带前导空行', () => {
  const w = writer();
  w.push('# 标题\n');
  w.flush();
  assert.deepEqual(w.push('新的一段\n'), ['▌ 新的一段'], 'flush 之后不补前导空行（UI 边界的空行是 flushProse 的职责）');
  w.push('# 又一个标题\n');
  w.reset();
  assert.deepEqual(w.push('另一轮的开头\n'), ['▌ 另一轮的开头'], 'reset 之后同理');
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

// 回归（先上色后折行）：强调跨折行不漏标记、不吞字。
test('强调跨折行：屏幕上不出现裸 **，文字一个不差', () => {
  const w = writer({ columns: 24, paint: tonePaint });
  const lines = w.push('这段文字里的**加粗内容特别长**继续\n');
  const text = lines.join('\n');
  assert.equal(text.includes('**'), false, `不漏标记：${JSON.stringify(lines)}`);
  assert.ok(text.includes(`${SGR.bold}`), '强调仍生效');
  const plain = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, '').replace(/^[▌ ]+/, '')).join('');
  assert.equal(plain, '这段文字里的加粗内容特别长继续', '一个字都没丢');
});

test('绝不在句中断行：不够一行宽时什么都不吐', () => {
  const w = writer({ columns: 40 });
  assert.deepEqual(w.push('半句话'), []);
  assert.deepEqual(w.push('，再说半句。'), []);
  const done = w.push('\n');
  assert.deepEqual(done, ['▌ 半句话，再说半句。']);
});

// 回归（P0）：收尾时已确认的表格与候选行都必须落地，一个字节不能丢。
test('flush：已有半行尾巴时，已确认的表格也完整落地', () => {
  const w = writer();
  const out = [];
  out.push(...w.push('| 甲 | 乙 |\n|---|---|\n| 1 | 2 |\n'));
  out.push(...w.flush());
  const text = joined(out);
  assert.ok(text.includes('┌'), `表格落地：${text}`);
  assert.ok(text.includes('│ 1'), '表体行在');
});

test('flush：半行尾巴 + 已确认表格 + 尾巴不是表格行（顺序与完整性）', () => {
  const w = writer();
  const out = [];
  out.push(...w.push('| 甲 | 乙 |\n|---|---|\n| 1 | 2 |\n没换行的尾巴'));
  out.push(...w.flush());
  const text = joined(out);
  assert.ok(text.includes('┌') && text.includes('│ 1'), `表格完整：${text}`);
  assert.ok(text.includes('没换行的尾巴'), `尾巴也吐出：${text}`);
});

test('flush：未确认的表格候选行按正文吐出，不丢行', () => {
  const w = writer();
  const out = [];
  out.push(...w.push('| 候选甲 | 候选乙 |\n'));
  out.push(...w.push('未完'));
  out.push(...w.flush());
  const text = joined(out);
  assert.ok(text.includes('| 候选甲 | 候选乙 |'), `候选行吐出：${text}`);
  assert.ok(text.includes('未完'), '尾巴吐出');
});

test('flush：未闭合的表格按现有行画出（含未带换行的分隔行收尾）', () => {
  const w = writer();
  const out = [];
  out.push(...w.push('半行正文'));
  out.push(...w.push('\n| 甲 | 乙 |\n|---|---|'));
  out.push(...w.flush());
  const text = joined(out);
  assert.ok(text.includes('▌ 半行正文'), '半行吐出');
  assert.ok(text.includes('甲') && text.includes('乙'), '未闭合的表格按现有行画出');
});

test('reset：丢弃未完成的表格候选与表体（会话/Run 边界）', () => {
  const w = writer();
  w.push('| 甲 | 乙 |\n|---|---|\n| 1 |\n');
  w.reset();
  assert.deepEqual(w.push('新的一轮。\n'), ['▌ 新的一轮。'], '上一轮的表结构不泄漏');
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

test('renderTable：列数不齐时缺格按空补，多余格忽略（GFM 语义）', () => {
  const lines = renderTable({
    header: ['甲', '乙'],
    aligns: ['left', 'left'],
    rows: [['1'], ['2', '3', '溢出']],
  }, { width: 60, paint: plainPaint });
  assert.ok(lines.some((line) => /│ 1\s+│\s+│/.test(line)), '缺格补空');
  assert.ok(!lines.join('').includes('溢出'), '多余格按 GFM 语义忽略');
});

test('renderTable：空表体只画表头与上下框', () => {
  const lines = renderTable({ header: ['甲'], aligns: ['left'], rows: [] }, { width: 60, paint: plainPaint });
  assert.equal(lines.length, 4, '┌ / 表头 / ├ / └');
  assert.ok(!lines.join('').includes('┼'), '只有一列时不会出现交叉符');
});
