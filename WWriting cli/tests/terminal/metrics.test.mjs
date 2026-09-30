// 终端度量模块的测试：宽度口径（resolveColumns / displayWidth）与内容列宽（contentWidth）。
//
// displayWidth / clipToWidth / takeProseRows 的行为用例住在 renderer.test.mjs 与 prose.test.mjs
// （它们从 metrics.mjs 导入，测的是同一份实现）；这里钉的是 metrics 自己的口径——
// 尤其 contentWidth：大字退场后它不再随大字放宽（banner.test 旧期望 86 的来历见 metrics.mjs 头注）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { contentWidth, displayWidth, resolveColumns } from '../../src/terminal/metrics.mjs';

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
