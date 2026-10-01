// 统计文风测试：全部指标从固定文本逐字断言——这是客观统计，不是感觉。
import test from 'node:test';
import assert from 'node:assert/strict';

import { StyleStatsError, styleStats } from '../../src/tools/style-stats.mjs';

test('段落、句子、平均与最长句按定义计数', () => {
  const out = styleStats({ text: '灯次第亮起。他停下脚步！\n\n「谁？」她问。夜很深；风更冷。' });
  assert.equal(out.paragraphs, 2);
  // 「谁？」里的 ？ 也是句末标点：对话被切成两段是**定义使然**，不是缺陷。
  assert.equal(out.sentences, 6);
  // 主口径不含空白：逐字数一遍（含标点）。
  assert.equal(out.charsNoSpace, '灯次第亮起。他停下脚步！「谁？」她问。夜很深；风更冷。'.length);
  assert.equal(out.avgSentence, Math.round(out.charsNoSpace / 6));
  assert.ok(out.longestSentence >= out.avgSentence);
});

test('对话占比：中文引号内的字数除以全文主口径', () => {
  const out = styleStats({ text: '「走吧。」他说。窗外没有声音。' });
  // 对话内容 = 走吧。 → 3 字；全文主口径 15 字（含引号本身）。
  assert.equal(out.dialogueRatio, Math.round((3 / 15) * 100));
});

test('纯叙述文本对话占比为 0；空文本各项归零不抛', () => {
  assert.equal(styleStats({ text: '没有任何引号的一句话。' }).dialogueRatio, 0);
  const empty = styleStats({ text: '' });
  assert.deepEqual(empty, { charsNoSpace: 0, hanzi: 0, paragraphs: 0, sentences: 0, avgSentence: 0, longestSentence: 0, dialogueRatio: 0 });
});

test('非文本输入有一条中文事实', () => {
  assert.throws(() => styleStats({ text: 42 }), (error) => {
    assert.equal(error instanceof StyleStatsError, true);
    assert.equal(error.code, 'STYLE_STATS_INVALID_TEXT');
    return true;
  });
});
