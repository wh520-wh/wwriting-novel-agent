// src/core/word-count.mjs —— 客观字数统计（Task 9 结构化计数口径）。
//
// stripMarkdown()（旧口径）保留给既有调用方（skills/hooks 等文本清洗）；
// count_text 工具与 countEffectiveWords() 使用 stripMarkdownForCount() +
// analyzeTextCount()（brief Step 2 逐字）：
//   - 只剔除 Markdown 标记（frontmatter/代码块/内联代码/注释/图片/HTML/标题
//     标记/链接目标），保留链接显示文字与标题文字；
//   - effective_count = cjk + latin_words + numeric_tokens（纯标点与空白不计）；
//   - 每个统计字段独立客观计算，不做任何通过/失败判定（冻结契约 §2.2）。
export function stripMarkdownForCount(source) {
  return String(source ?? "")
    .replace(/^---\r?\n[\s\S]*?\r?\n---\s*/u, "")
    .replace(/```[\s\S]*?```/gu, "")
    .replace(/`[^`\n]*`/gu, "")
    .replace(/<!--([\s\S]*?)-->/gu, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/<[^>]+>/gu, "")
    .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
    .replace(/[*_>#|{}~]/gu, " ");
}

export function analyzeTextCount(source) {
  const visible = stripMarkdownForCount(source);
  const cjk = visible.match(/\p{Script=Han}/gu) ?? [];
  const withoutCjk = visible.replace(/\p{Script=Han}/gu, " ");
  const latin = withoutCjk.match(/[A-Za-z]+(?:'[A-Za-z]+)?/gu) ?? [];
  const numbers = withoutCjk.match(/\d+(?:\.\d+)?/gu) ?? [];
  const punctuation = visible.match(/\p{P}/gu) ?? [];
  const nonWhitespace = visible.match(/\S/gu) ?? [];
  return {
    cjk_characters: cjk.length,
    latin_words: latin.length,
    numeric_tokens: numbers.length,
    punctuation_characters: punctuation.length,
    non_whitespace_characters: nonWhitespace.length,
    effective_count: cjk.length + latin.length + numbers.length
  };
}

export function countEffectiveWords(source) {
  return analyzeTextCount(source).effective_count;
}

export function stripMarkdown(source) {
  return String(source ?? "")
    .replace(/^---[\s\S]*?---\s*/u, "")
    .replace(/```[\s\S]*?```/gu, "")
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/^\s{0,3}#{1,6}\s+.*$/gmu, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/[*_`>#|[\](){}~-]/gu, " ");
}
