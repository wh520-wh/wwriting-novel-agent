// 客观字数测试：主口径是「去空白字符数（含标点）」，另给汉字、拉丁词和字素三种辅助口径。
// 铁律 6：篇幅必须由本地统计决定，模型自报的数字一律不作数——这里断言调用方塞进来的
// 任何自报字段都不影响结果。
import test from 'node:test';
import assert from 'node:assert/strict';

import { countText } from '../../src/tools/count-text.mjs';

test('countText：纯中文按字计，不掺拉丁词', () => {
  const result = countText({ text: '你好世界' });
  assert.deepEqual(result, { charsNoSpace: 4, hanzi: 4, words: 0, graphemes: 4 });
});

test('countText：纯英文按拉丁词计，空格不计入主口径', () => {
  const result = countText({ text: 'hello world' });
  assert.deepEqual(result, { charsNoSpace: 10, hanzi: 0, words: 2, graphemes: 11 });
});

test('countText：中英混排 + 标点，标点计入主口径但不算汉字也不算词', () => {
  const result = countText({ text: '你好，world!' });
  assert.deepEqual(result, { charsNoSpace: 9, hanzi: 2, words: 1, graphemes: 9 });
});

test('countText：中文标点全计入主口径，且不算汉字', () => {
  const result = countText({ text: '，。！？；：' });
  assert.deepEqual(result, { charsNoSpace: 6, hanzi: 0, words: 0, graphemes: 6 });
});

test('countText：空格、制表符与换行都不计入主口径，但计入字素', () => {
  const result = countText({ text: '  a\tb\nc  ' });
  assert.equal(result.charsNoSpace, 3);
  assert.equal(result.graphemes, 9);
});

test('countText：CRLF 是一个字素，主口径只数可见字符', () => {
  const result = countText({ text: 'a\r\nb' });
  assert.deepEqual(result, { charsNoSpace: 2, hanzi: 0, words: 2, graphemes: 3 });
});

test('countText：emoji 组合按一个字素算，主口径按码点数', () => {
  const family = countText({ text: '👨‍👩‍👧' });
  assert.equal(family.graphemes, 1);
  assert.equal(family.charsNoSpace, 5);

  const thumbs = countText({ text: 'a 👍 b' });
  assert.deepEqual(thumbs, { charsNoSpace: 3, hanzi: 0, words: 2, graphemes: 5 });
});

test('countText：章节标题里的数字按词计，汉字照字计', () => {
  const result = countText({ text: '第1章 hello' });
  assert.deepEqual(result, { charsNoSpace: 8, hanzi: 2, words: 2, graphemes: 9 });
});

test('countText：空文本与纯空白文本', () => {
  assert.deepEqual(countText({ text: '' }), { charsNoSpace: 0, hanzi: 0, words: 0, graphemes: 0 });
  const blank = countText({ text: '   \n\t  ' });
  assert.deepEqual(blank, { charsNoSpace: 0, hanzi: 0, words: 0, graphemes: 7 });
});

test('countText：模型自报的字数被忽略，只认本地统计', () => {
  const text = '你好世界';
  const result = countText({ text, charsNoSpace: 9999, hanzi: 1, words: 42, reported: 12345 });

  assert.equal(result.charsNoSpace, 4);
  assert.equal(result.hanzi, 4);
  assert.equal(result.words, 0);
  assert.equal(result.graphemes, 4);
  // 返回值只有这四个本地口径，模型没有地方塞进自己的数字。
  assert.deepEqual(Object.keys(result).sort(), ['charsNoSpace', 'graphemes', 'hanzi', 'words']);
});

test('countText：非字符串文本直接报中文错误', () => {
  for (const bad of [undefined, null, 42, {}]) {
    assert.throws(
      () => countText({ text: bad }),
      (error) => error.code === 'COUNT_TEXT_INVALID_TEXT',
      `text=${String(bad)} 应被拒绝`,
    );
  }
});
