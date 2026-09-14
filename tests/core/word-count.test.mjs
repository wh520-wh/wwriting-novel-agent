import assert from "node:assert/strict";
import test from "node:test";
import { analyzeTextCount, countEffectiveWords, stripMarkdownForCount } from "../../src/core/word-count.mjs";

test("countEffectiveWords 委托新统计口径：frontmatter/注释剔除，标题文字计入有效字数", () => {
  const text = `---
title: Hidden
---
# 标题不算正文

<!-- segment:1 -->
雨夜里他收到信。The clue returns in 2026.`;
  // stripMarkdownForCount 只去掉 frontmatter、注释与标题标记（# ），标题文字
  //「标题不算正文」计入：6 汉字 + 正文 7 汉字 + The/clue/returns/in 4 词 + 2026 1 个数字。
  assert.equal(countEffectiveWords(text), 18);
});

test("analyzeTextCount 保留链接文字但忽略 URL、代码和 Markdown 标记", () => {
  const result = analyzeTextCount(`---
title: x
---
# 第一章
[主角](https://example.com) 有 2 个 plan。

\`code\`
\`\`\`js
const x = 1
\`\`\``);
  // 手算：visible = "第一章\n主角 有 2 个 plan。"
  //   cjk = 第/一/章/主/角/有/个 = 7
  //   latin = plan = 1
  //   numeric = 2 = 1
  //   punctuation = 。 = 1
  //   non_whitespace = 第一章(3) 主角(2) 有(1) 2(1) 个(1) plan(4) 。(1) = 13
  //   effective = 7 + 1 + 1 = 9
  assert.deepEqual(result, {
    cjk_characters: 7,
    latin_words: 1,
    numeric_tokens: 1,
    punctuation_characters: 1,
    non_whitespace_characters: 13,
    effective_count: 9
  });
});

test("analyzeTextCount 忽略图片、HTML 标签和空白，只计非空白可见字符", () => {
  const result = analyzeTextCount(`![封面图](cover.png)\n<p>雨夜。</p>  \n\n  主角\n\t回家`);
  // 手算：visible = "\n雨夜。  \n\n  主角\n\t回家"
  //   cjk = 雨/夜/主/角/回/家 = 6
  //   punctuation = 。 = 1
  //   non_whitespace = 雨夜。(3) 主角(2) 回家(2) = 7
  //   effective = 6
  assert.deepEqual(result, {
    cjk_characters: 6,
    latin_words: 0,
    numeric_tokens: 0,
    punctuation_characters: 1,
    non_whitespace_characters: 7,
    effective_count: 6
  });
});

test("analyzeTextCount 英文缩写与小数数字各算一个词/token", () => {
  const result = analyzeTextCount("It's 3.14 meters.");
  // 手算：visible = "It's 3.14 meters."
  //   cjk = 0
  //   latin = It's / meters = 2（缩写按一个词）
  //   numeric = 3.14 = 1（小数按一个 token）
  //   punctuation = \p{P}：'（缩写撇号）+ 3.14 的 . + 句末 . = 3
  //   non_whitespace = It's(4) 3.14(4) meters(6) .(1) = 15
  //   effective = 0 + 2 + 1 = 3
  assert.deepEqual(result, {
    cjk_characters: 0,
    latin_words: 2,
    numeric_tokens: 1,
    punctuation_characters: 3,
    non_whitespace_characters: 15,
    effective_count: 3
  });
});

test("stripMarkdownForCount 是确定性纯函数：空输入/非字符串容错", () => {
  assert.equal(stripMarkdownForCount(undefined), "");
  assert.equal(stripMarkdownForCount(null), "");
  assert.equal(stripMarkdownForCount(""), "");
  assert.equal(stripMarkdownForCount("   "), "   ");
});
