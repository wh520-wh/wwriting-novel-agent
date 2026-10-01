// 统计文风（style_stats）：客观的文本形态指标，供模型自查节奏与对话密度。
// 与 count_text 同一条铁律 6：数字只由本地统计得出，模型自报不作数。
// 全部指标都可从 text 单独复算——纯函数、零依赖、逐条可断言。
import { countText } from './count-text.mjs';

// 统计错误：message 是一条中文事实，code 供调用方判断。
export class StyleStatsError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'StyleStatsError';
    this.code = code;
    this.details = details;
  }
}

// 对话段：中文引号「」与“”包裹的内容（不嵌套；嵌套引号按最外层截取——
// 统计口径要的是「对话大概占多少」，不是精确的引号配对）。
const DIALOGUE = /[「“]([^「」“”]*)[」”]/g;

export function styleStats({ text } = {}) {
  if (typeof text !== 'string') {
    throw new StyleStatsError('要统计的内容必须是文本。', 'STYLE_STATS_INVALID_TEXT', {
      received: typeof text,
    });
  }
  const { charsNoSpace, hanzi } = countText({ text });

  // 段落：按空行切（连续空白行只算一个分界），非空段计数。
  const paragraphs = text.split(/\n[ \t]*\n+/).filter((part) => part.trim() !== '').length;

  // 句子：按中英文句末标点切，去掉纯空白段。
  const sentenceParts = text.split(/[。！？!?；;…]+/).map((part) => part.trim()).filter((part) => part !== '');
  const sentences = sentenceParts.length;
  const longestSentence = sentenceParts.reduce((max, part) => Math.max(max, part.length), 0);
  // 平均句长按主口径算（含标点均摊），整数就够——这是节奏量感，不是测量报告。
  const avgSentence = sentences > 0 ? Math.round(charsNoSpace / sentences) : 0;

  // 对话占比：引号内字符（去空白）占全文主口径的百分比。
  let dialogueChars = 0;
  for (const match of text.matchAll(DIALOGUE)) {
    dialogueChars += countText({ text: match[1] ?? '' }).charsNoSpace;
  }
  const dialogueRatio = charsNoSpace > 0 ? Math.round((dialogueChars / charsNoSpace) * 100) : 0;

  return { charsNoSpace, hanzi, paragraphs, sentences, avgSentence, longestSentence, dialogueRatio };
}
