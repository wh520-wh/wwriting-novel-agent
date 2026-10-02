// 调色与纯格式层（style.mjs）的单测：用量 / 缓存 / 思考耗时 / 终态文案 / 思考预览宽度 / 用户行折行 /
// 任务计划文案。这一层的函数不碰 stdout——测它们不需要渲染器，也不需要事件桥；
// paint 直接用本层的 paintText（无色 = 纯文本断言，有色 = 钉住 §4.2 的条目形态）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatCacheHit, formatThinkingSeconds, formatUsage, paintText, planPanelLines, planTableLines,
  terminalStatusText, thinkingPreviewLines, thinkingPreviewWidth, userRows,
} from '../../src/terminal/style.mjs';
import { clipToWidth, displayWidth, padDisplayEnd } from '../../src/terminal/metrics.mjs';

const plain = (text, tone) => paintText(text, tone, false);
const colored = (text, tone) => paintText(text, tone, true);

test('formatUsage 在思考 tokens 存在时追加「（思考 800）」', () => {
  assert.equal(formatUsage({ totalTokens: 1200 }), '1.2k tokens');
  assert.equal(formatUsage({ totalTokens: 1200, reasoningTokens: 800 }), '1.2k tokens（思考 800）');
  assert.equal(formatUsage({ totalTokens: 900, reasoningTokens: 300 }), '900 tokens（思考 300）');
  // 0 与 null 都不显示：这轮没思考，挂一个「思考 0」只会让人以为强度没生效。
  assert.equal(formatUsage({ totalTokens: 1200, reasoningTokens: 0 }), '1.2k tokens');
  assert.equal(formatUsage({ totalTokens: 1200, reasoningTokens: null }), '1.2k tokens');
  assert.equal(formatUsage(null), null);
});

test('formatCacheHit 只在真的命中了缓存时给出事实（铁律 3：命中 0 不占行）', () => {
  assert.equal(formatCacheHit({ promptCacheHitTokens: 3400 }), '缓存命中 3.4k');
  assert.equal(formatCacheHit({ promptCacheHitTokens: 800 }), '缓存命中 800');
  assert.equal(formatCacheHit({ promptCacheHitTokens: 0 }), null);
  assert.equal(formatCacheHit({}), null);
  assert.equal(formatCacheHit(null), null);
});

test('formatThinkingSeconds：秒、四舍五入、最小 1（上游对话样式规格书:176）', () => {
  assert.equal(formatThinkingSeconds(12400), '思考 12 秒');
  assert.equal(formatThinkingSeconds(1200), '思考 1 秒', '最小 1 秒');
  assert.equal(formatThinkingSeconds(400), '思考 1 秒', '不足一秒也算思考过');
  assert.equal(formatThinkingSeconds(1500), '思考 2 秒', '四舍五入');
});

test('算不出耗时时回退「已完成思考」，绝不报一个 0 秒', () => {
  assert.equal(formatThinkingSeconds(null), '已完成思考');
  assert.equal(formatThinkingSeconds(NaN), '已完成思考');
  assert.equal(formatThinkingSeconds(0), '已完成思考');
  assert.equal(formatThinkingSeconds(-5), '已完成思考');
});

// —— 思考预览：内容在**当前轮**可见（实时区那块），但不进 scrollback ——

test('thinkingPreviewLines：没有内容时就是那一行状态；有内容时首行带前缀、续行按前缀宽度缩进', () => {
  assert.deepEqual(thinkingPreviewLines([], { columns: 80 }), ['思考中']);
  assert.deepEqual(thinkingPreviewLines([], { columns: 80 }), ['思考中'], '空数组与缺省一样');

  const one = thinkingPreviewLines(['主角为什么不肯离开'], { columns: 80 });
  assert.equal(one.length, 1);
  assert.equal(one[0], `思考中 · 主角为什么不肯离开`);

  const two = thinkingPreviewLines(['第一句', '第二句'], { columns: 80 });
  assert.equal(two.length, 2);
  assert.equal(two[0], '思考中 · 第一句');
  // 续行缩进 = 「思考中 · 」的显示宽度（3 个汉字 6 列 + 3 列分隔）→ 正文左对齐成一列
  assert.equal(two[1], `${' '.repeat(9)}第二句`);
  assert.equal(displayWidth(two[0].match(/^\S+ · /)[0]), 9);
});

test('thinkingPreviewLines：只显示末尾两行——旧的思考滚出实时区，不往上堆积', () => {
  const shown = thinkingPreviewLines(['一', '二', '三', '四'], { columns: 80 });
  assert.deepEqual(shown, ['思考中 · 三', `${' '.repeat(9)}四`]);
});

test('thinkingPreviewLines：终端太窄就退回只有状态行，绝不把正文挤成两三个字', () => {
  // `思考中 · ` 占 9 列，正文至少要 20 列才值得预览 → 29 列以下不做预览。
  assert.equal(thinkingPreviewWidth(29), 0, '正文只剩 19 列：不值得预览');
  assert.equal(thinkingPreviewWidth(30), 20, '刚好够一行 20 列的正文');
  assert.deepEqual(thinkingPreviewLines(['一句很长的话'], { columns: 29 }), ['思考中'], '没有内容可预览');
  assert.deepEqual(thinkingPreviewLines(['短'], { columns: 29 }), ['思考中'], '再短的话也不预览');
  assert.equal(thinkingPreviewLines(['短'], { columns: 30 })[0], '思考中 · 短');
  assert.equal(thinkingPreviewWidth(80), 80 - 9 - 1, '末尾留 1 列，避免触发终端自动折行');
});

test('thinkingPreviewLines：换行分支漏出的超宽长行在出口截到终端宽度以内（猎捕报告 6）', () => {
  // takeProseRows 的换行分支不切宽：一条 ≥72 显示列的完整逻辑行加上 9 列前缀
  // 就是 81 列的实时行，终端软折行多占一格物理行，擦除按 `\n` 数行——残留。
  const longRow = '雨'.repeat(40); // 80 显示列 > 预览宽 70
  const lines = thinkingPreviewLines([longRow], { columns: 80 });
  assert.equal(lines.length, 1);
  assert.ok(displayWidth(lines[0]) <= 79, `实时行 ${displayWidth(lines[0])} 列，会把首格留进 scrollback`);
  // 放得下的行一个字都不动
  assert.equal(thinkingPreviewLines(['主角为什么不肯离开'], { columns: 80 })[0], '思考中 · 主角为什么不肯离开');
});

test('clipToWidth：按显示宽度截断，宽字符与代理对绝不劈半（复核补测）', () => {
  // 这些宽度算术是 6/7 两条修复的地基,直接钉死:恰好整行、奇数宽挤不下双列字、
  // 代理对(𠀋 U+2000B,宽度表 0x20000–0x3fffd)整体保留。
  assert.equal(clipToWidth('雨'.repeat(45), 70), '雨'.repeat(35), '恰好 70 列整行');
  assert.equal(displayWidth(clipToWidth('雨'.repeat(45), 71)), 70, '第 36 个字放不下(72 > 71),整字让出');
  assert.equal(clipToWidth('𠀋'.repeat(5), 5), '𠀋'.repeat(2), '代理对整体保留,绝不留半个高代理位');
  assert.equal(clipToWidth('短短一行', 70), '短短一行', '放得下一个字都不动');
  assert.equal(clipToWidth('任意', 0), '', '宽度非法时给空串,绝不吐原文');
});

test('terminalStatusText 是事件桥与重演共用的那一份：四种终态 + 崩溃残留', () => {
  assert.deepEqual(terminalStatusText({ terminal: 'completed' }), { text: '已完成', tone: 'success' });
  assert.deepEqual(terminalStatusText({ terminal: 'interrupted', interruptReason: 'user_stop' }), { text: '已停止', tone: 'warn' });
  assert.deepEqual(terminalStatusText({ terminal: 'interrupted', interruptReason: 'aborted' }), { text: '已中断', tone: 'warn' });
  assert.deepEqual(terminalStatusText({ terminal: 'failed', failCode: 'MODEL_NETWORK_ERROR' }), { text: '连接中断', tone: 'error' });
  assert.deepEqual(terminalStatusText({ terminal: 'failed', failCode: 'MODEL_STREAM_ERROR' }), { text: '连接中断', tone: 'error' });
  // `未配置` 是唯一一种「用户自己能修好」的终态，所以它连出路提示一起长在这一处：
  // 事件桥按键取用 `hint`，绝不匹配主文案的文字（改一个字就会静默丢掉那条提示）。
  assert.deepEqual(terminalStatusText({ terminal: 'failed', failCode: 'MODEL_NOT_CONFIGURED' }), {
    text: '未配置',
    tone: 'warn',
    hint: '用 /model 设置模型与 API Key 后重试。',
  });
  assert.deepEqual(terminalStatusText({ terminal: 'failed', failCode: 'RUN_FAILED' }), { text: '操作失败', tone: 'error' });
  assert.deepEqual(terminalStatusText({ terminal: 'open' }), { text: '未正常结束', tone: 'warn' });
});

test('userRows 首行带 ❯ 前缀、续行缩进对齐（grokbuild 的同款做法）', () => {
  const rows = userRows('写第一章', { width: 20 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0], `❯ ${padDisplayEnd('写第一章', 18)}`);
  assert.equal(displayWidth(rows[0]), 20, '每一行都补白到内容列宽');
});

test('超出宽度时逐行切分，续行用两个空格对齐到正文起点', () => {
  const rows = userRows('一二三四五六七八九十', { width: 8 });
  assert.equal(rows.length > 1, true);
  assert.ok(rows[0].startsWith('❯ '));
  for (const row of rows.slice(1)) assert.ok(row.startsWith('  '), '续行缩进对齐');
  for (const row of rows) assert.equal(displayWidth(row), 8, '所有行同宽，色带才是齐的');
});

test('CJK 宽度算对：补白按显示宽度而不是字符数', () => {
  const [row] = userRows('临渊', { width: 12 });
  assert.equal(displayWidth(row), 12);
  assert.equal(row, `❯ ${padDisplayEnd('临渊', 10)}`);
});

test('空文本也给出恰好一行（色带不会凭空消失）', () => {
  const rows = userRows('', { width: 10 });
  assert.equal(rows.length, 1);
  assert.equal(displayWidth(rows[0]), 10);
});

// —— 任务计划文案（全表与面板的唯一来源）——

test('planTableLines：标题 + 三态标记各就各位，长步骤折行续行对齐正文列', () => {
  const lines = planTableLines([
    { summary: '通读前两章', status: 'completed' },
    { summary: `写第三章${'，这一步的说明很长'.repeat(6)}`, status: 'in_progress' },
    { summary: '检查衔接', status: 'pending' },
  ], 30, plain);
  assert.equal(lines[0], '任务计划 1/3');
  assert.equal(lines[1], '  ✓ 通读前两章');
  assert.ok(lines[2].startsWith('  ▶ 写第三章'), `首行带标记与步骤开头：${JSON.stringify(lines[2])}`);
  assert.ok(lines.slice(3).some((line) => /^ {4}\S/.test(line)), '折行续行对齐正文列');
  assert.equal(lines.at(-1), '  ◌ 检查衔接');
  for (const line of lines) assert.ok(!line.includes('\n'), '行内不带换行符，join 归调用方');
});

test('planTableLines：缺状态归一为 pending，空步骤也占一行（条目数不撒谎）', () => {
  const lines = planTableLines([{ summary: '' }, { summary: '写', status: '未知状态' }], 30, plain);
  assert.equal(lines[0], '任务计划 0/2');
  assert.equal(lines[1], '  ◌ ');
  assert.equal(lines[2], '  ◌ 写');
});

test('planTableLines：条目形态钉住 §4.2——完成压暗+删除线，进行中强调色+加粗', () => {
  const lines = planTableLines([
    { summary: '通读前两章', status: 'completed' },
    { summary: '写第三章', status: 'in_progress' },
  ], 30, colored);
  assert.ok(lines[1].includes('\x1b[2m\x1b[9m通读前两章'), `完成 = 压暗 + 删除线：${JSON.stringify(lines[1])}`);
  assert.ok(lines[2].includes('\x1b[38;5;173m\x1b[1m写第三章'), `进行中 = 强调色 + 加粗：${JSON.stringify(lines[2])}`);
});

test('planPanelLines chip：一行带当前步骤；补语超宽截断带省略号，标题与计数完整', () => {
  const chip = planPanelLines(
    [{ summary: '核对第三章时间线与人物动机是否前后一致', status: 'in_progress' }],
    { active: false, width: 24 },
    plain,
  );
  assert.equal(chip.length, 1);
  assert.ok(chip[0].startsWith('任务计划 0/1'), `标题与计数完整：${chip[0]}`);
  assert.ok(chip[0].includes('…'), '截断要可见');
  assert.ok(displayWidth(chip[0]) <= 24, `chip 不超宽：${displayWidth(chip[0])}`);
});

test('planPanelLines 运行中：窗口保进行中项，两侧给省略行；全部完成收一句', () => {
  const items = [];
  for (let i = 1; i <= 6; i += 1) items.push({ summary: `待办 ${i}`, status: 'pending' });
  items.push({ summary: '★ 正在进行的一步', status: 'in_progress' });
  const panel = planPanelLines(items, { active: true, width: 40 }, plain);
  assert.equal(panel[0], '任务计划 0/7');
  assert.ok(panel.includes('  … 前面还有 4 步'), `被裁掉的头部要有交代：${panel.join(' | ')}`);
  assert.ok(panel.some((line) => line.includes('★ 正在进行的一步')), '进行中项必须在场');

  const done = planPanelLines([{ summary: '收尾', status: 'completed' }], { active: true, width: 40 }, plain);
  assert.deepEqual(done, ['任务计划 1/1', '  ✓ 全部完成']);

  const mixed = planPanelLines(
    [...Array.from({ length: 12 }, () => ({ summary: '完', status: 'completed' })), { summary: '正在做', status: 'in_progress' }],
    { active: true, width: 40 },
    plain,
  );
  assert.ok(mixed.some((line) => line === '  ✓ 已完成 12 步'), '完成项收一行汇总');
  assert.ok(mixed.some((line) => line.includes('正在做')), '当前步骤在面板里');
});
