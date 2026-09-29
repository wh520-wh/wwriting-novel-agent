// 头部大字标识的测试。
//
// 字形是照着上游桌面版头部的截图反推的（方块字、5 行高、一格一个字符），所以这里既断言
// 「形状成立」（行数、等宽、只有实心与空格），也断言它真的在面板上按预期落位。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BANNER_FILL, BANNER_ROWS, BANNER_TEXT, bannerLines, bannerWidth, contentWidth, pickBannerScale,
} from '../../src/terminal/banner.mjs';
import { createRenderer } from '../../src/terminal/renderer.mjs';

test('大字：五行、等宽、只有实心格与空格', () => {
  const rows = bannerLines();

  assert.equal(rows.length, BANNER_ROWS);
  assert.equal(BANNER_TEXT, 'WWriting', '标识就是应用名');
  for (const row of rows) {
    assert.equal(row.length, bannerWidth(), `每行等宽：${JSON.stringify(row)}`);
    assert.equal(/[^█ ]/.test(row), false, '除实心格与空格外不该有别的字符');
    assert.equal(row.startsWith(' '), false, '左侧不留空列（缩进交给面板）');
  }
  // 首尾两列都该有笔画：W 的左竖与 g 的右弧——否则说明字形被裁掉了。
  assert.ok(rows.every((row) => row[0] === BANNER_FILL), '第一列是 W 的左竖');
  assert.ok(rows.some((row) => row[row.length - 1] === BANNER_FILL), '最后一列是 g 的右弧');
});

test('大字：放大一档时横竖一起放大，字形比例不变', () => {
  const small = bannerLines();
  const large = bannerLines(BANNER_TEXT, { scale: 2 });

  assert.equal(large.length, BANNER_ROWS, '行数不变');
  for (let row = 0; row < BANNER_ROWS; row += 1) {
    assert.equal(large[row].length, small[row].length * 2, '每格占两列');
    for (let i = 0; i < small[row].length; i += 1) {
      const filled = small[row][i] === BANNER_FILL;
      assert.equal(large[row][i * 2] === BANNER_FILL, filled, '同一格的实心状态必须一致');
      assert.equal(large[row][i * 2 + 1] === BANNER_FILL, filled, '实心格要连写两遍，空格也要占两格');
    }
  }
  assert.equal(bannerWidth(BANNER_TEXT, { scale: 2 }), bannerWidth() * 2);
});

test('大字：按终端宽度挑档位，放不下就不给', () => {
  assert.equal(pickBannerScale(200), 2, '宽终端用大的');
  assert.equal(pickBannerScale(90), 2);
  assert.equal(pickBannerScale(86), 1, '刚好放得下小号');
  assert.equal(pickBannerScale(44), 0, '比大字还窄就不给');
  assert.equal(pickBannerScale(20), 0);
});

test('内容列宽：按终端宽度内缩，宽终端为大字放宽但不铺满', () => {
  assert.equal(contentWidth(80), 76, '80 列终端：去掉 2 格缩进与 2 格右边距');
  assert.equal(contentWidth(120), 86, '宽终端为大字放宽到 86');
  assert.equal(contentWidth(120), contentWidth(90), '够放大字的区间里宽度一致，不随终端乱飘');
  assert.equal(contentWidth(200), 86, '再宽也不铺满整个终端');
  assert.equal(contentWidth(50), 46, '终端更窄时以终端为准');
  assert.equal(contentWidth(undefined), 76, '拿不到列数就按 80 算');
});

test('面板：大字在身份行之上，横线跟着大字放宽；NO_COLOR 下不上色', () => {
  const chunks = [];
  const stdout = {
    isTTY: true,
    columns: 120,
    write(text) { chunks.push(String(text)); return true; },
  };
  const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' } });

  renderer.printIntro({
    title: 'WWriting 0.1.0',
    subtitle: '长篇写作智能体（命令行版）',
    banner: bannerLines(BANNER_TEXT, { scale: 2 }),
    rows: [['工作区', 'D:\\Novels\\星坠之城']],
    hint: '直接输入开始写作',
  });
  renderer.close();

  const text = chunks.join('');
  const lines = text.split('\n');
  assert.ok(lines[0].startsWith(`  ${BANNER_FILL}`), '大字在第一行，缩进 2 格');
  assert.equal(lines[BANNER_ROWS].includes('WWriting 0.1.0'), true, '第 6 行才是身份行');
  assert.ok(!text.includes('\x1b['), 'NO_COLOR 下一个 ANSI 字节都不该有');

  const rule = lines[BANNER_ROWS + 1].trimEnd();
  assert.equal(rule.startsWith('  ─'), true, '横线缩进与大字一致');
  assert.equal(rule.length - 2, bannerWidth(BANNER_TEXT, { scale: 2 }), '横线与大字同宽');
});
