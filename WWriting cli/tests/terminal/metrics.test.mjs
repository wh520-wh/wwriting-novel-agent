// 终端度量模块的测试：宽度口径（resolveColumns / displayWidth）与内容列宽（contentWidth）。
//
// displayWidth / clipToWidth / takeProseRows 的行为用例住在 renderer.test.mjs 与 prose.test.mjs
// （它们从 metrics.mjs 导入，测的是同一份实现）；这里钉的是 metrics 自己的口径——
// 尤其 contentWidth：大字退场后它不再随大字放宽（banner.test 旧期望 86 的来历见 metrics.mjs 头注）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { contentWidth, displayWidth, fullWidthRuleLine, fullWidthRuleParts, resolveColumns } from '../../src/terminal/metrics.mjs';

test('resolveColumns：正数向下取整，拿不到就兜底', () => {
  assert.equal(resolveColumns(120), 120);
  assert.equal(resolveColumns(80.9), 80, '小数列数向下取整');
  assert.equal(resolveColumns(0), 80, '0 列拿不到，按 80');
  assert.equal(resolveColumns(-5), 80, '负数按 80');
  assert.equal(resolveColumns(NaN), 80);
  assert.equal(resolveColumns(undefined), 80);
  assert.equal(resolveColumns(undefined, 100), 100, '兜底值可以换');
});

test('displayWidth：CJK 占两列、代理对不劈半、块元素是窄字符', () => {
  assert.equal(displayWidth('ab'), 2);
  assert.equal(displayWidth('中文'), 4);
  assert.equal(displayWidth('\u{20089}'), 2, 'U+20089 是扩展区宽字符（代理对整体算 2 列）');
  assert.equal(displayWidth('█'), 1, 'U+2588 块元素按窄字符算（真实终端如此，踩过一次）');
});

test('contentWidth：按终端宽度内缩，上限 78，再宽也不铺满整个终端', () => {
  assert.equal(contentWidth(80), 76, '80 列终端：去掉 2 格缩进与 2 格右边距');
  assert.equal(contentWidth(120), 78, '宽终端回到设计上限，不再为大字放宽');
  assert.equal(contentWidth(120), contentWidth(90), '任何宽度下内容列只由上限与终端决定，不乱飘');
  assert.equal(contentWidth(200), 78, '再宽也不铺满整个终端');
  assert.equal(contentWidth(50), 46, '终端更窄时以终端为准');
  assert.equal(contentWidth(undefined), 76, '拿不到列数就按 80 算');
  assert.equal(contentWidth(4), 1, '放不下时下限 1，不出负数');
});

test('fullWidthRuleLine：输入区全宽横线——顶格、宽 = 列数 − 1（末列有毒口径）', () => {
  assert.equal(fullWidthRuleLine({ columns: 80 }), '─'.repeat(79), '80 列终端：79 条线，顶格无缩进，末列留白');
  assert.equal(displayWidth(fullWidthRuleLine({ columns: 120, indent: 0 })), 119, '120 列终端铺到 119 列');
  assert.equal(displayWidth(fullWidthRuleLine({ columns: 120, indent: 3 })), 119, 'indent 留给整块缩进的调用方：缩进计入整行，整行仍只占列数 − 1');
  assert.equal(fullWidthRuleLine({ columns: undefined }), '─'.repeat(79), '列数拿不到按 80 兜底');
  assert.equal(fullWidthRuleLine({ columns: 1 }), '─', '放不下时下限 1，不出负数');
});

test('fullWidthRuleParts：标签嵌右端、右留 2 格、整行仍占列数 − 1、放不下只画线', () => {
  const parts = fullWidthRuleParts({ columns: 80, tag: 'Normal' });
  assert.equal(parts.rule, '─'.repeat(70), '横线补足：79 − 6（标签）− 1（间隙）− 2（右边距）');
  assert.equal(parts.tag, 'Normal');
  assert.equal(parts.pad, '  ');
  assert.equal(displayWidth(`${parts.rule} ${parts.tag}${parts.pad}`), 79, '整行（含 1 格间隙）仍只占列数 − 1');
  assert.deepEqual(
    fullWidthRuleParts({ columns: 80, tag: '' }),
    { rule: '─'.repeat(79), tag: '', pad: '' },
    '无标签 = 素线（下框线与问询框线的形态）',
  );
  const narrow = fullWidthRuleParts({ columns: 8, tag: 'Normal' });
  assert.deepEqual(narrow, { rule: '─'.repeat(7), tag: '', pad: '' }, '放不下时只画线：标签是增强，线是骨架');
});

