// 客观字数：篇幅只由本地统计决定，模型自报的数字一律不作数（铁律 6）。
// 主口径 charsNoSpace = 去空白字符数（含标点）；hanzi / words / graphemes 是辅助口径。
// 统计对象只认传入的 text：调用方多加任何自报字段都会被忽略，返回值固定这四个字段。

// 字数统计错误：code 供调用方判断，message 是一条中文事实。
export class CountTextError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'CountTextError';
    this.code = code;
    this.details = details;
  }
}

// Unicode 空白（含全角空格 U+3000、制表、换行）；逐码点判断，不用 \s（漏全角）。
const WHITESPACE = /^\p{White_Space}$/u;
// 汉字：按 Script=Han 判，中文标点（，。！）不算汉字，但会计入主口径。
const HANZI = /\p{Script=Han}/u;
// 拉丁词：连续拉丁字母/数字，允许中间一个撇号（Don't 算一个词）。
const WORD = /[\p{Script=Latin}\p{Nd}]+(?:['’][\p{Script=Latin}\p{Nd}]+)*/gu;

let segmenter = null;
function graphemeCount(text) {
  // 字素簇：emoji 组合（👨‍👩‍👧）算一个，CRLF 算一个；Intl.Segmenter 随 Node 内置 ICU 提供。
  if (segmenter === null) segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });
  let count = 0;
  for (const _ of segmenter.segment(text)) count += 1;
  return count;
}

export function countText({ text } = {}) {
  if (typeof text !== 'string') {
    throw new CountTextError('要统计的内容必须是文本。', 'COUNT_TEXT_INVALID_TEXT', {
      received: typeof text,
    });
  }
  let charsNoSpace = 0;
  let hanzi = 0;
  for (const char of text) {
    if (WHITESPACE.test(char)) continue;
    charsNoSpace += 1;
    if (HANZI.test(char)) hanzi += 1;
  }
  const words = (text.match(WORD) ?? []).length;
  return { charsNoSpace, hanzi, words, graphemes: graphemeCount(text) };
}
