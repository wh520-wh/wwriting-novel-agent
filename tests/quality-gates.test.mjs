import assert from "node:assert/strict";
import test from "node:test";
import { runTitleGate, runWordCapGate, parseChineseChapterNo, buildFactCheckMessages, parseFactCheck } from "../src/core/quality-gates.mjs";

const TITLE_BAD_SAMPLE = "# 第一章\n\n正文…\n\n## 第二章（第1章续）\n\n续写正文…";

test("runTitleGate 正确标题 passed", () => {
  const out = runTitleGate("# 第一章\n\n正文", 1);
  assert.equal(out.status, "passed");
  assert.equal(out.found_title, "第一章");
});

test("runTitleGate 错位标题 failed，含 found_title 与 line", () => {
  const out = runTitleGate(TITLE_BAD_SAMPLE, 1);
  assert.equal(out.status, "failed");
  assert.match(out.found_title, /第二章/u);
  assert.equal(out.gate, "chapter-title-gate");
  assert.ok(out.line >= 1);
});

test("runTitleGate 中文数字解析", () => {
  assert.equal(parseChineseChapterNo("第十二章"), 12);
  assert.equal(parseChineseChapterNo("第一百二十三章"), 123);
  assert.equal(parseChineseChapterNo("第9章"), 9);
});

test("runWordCapGate 超标 warning + overflow 正确", () => {
  const out = runWordCapGate(5147, { targetWords: 3300 });
  assert.equal(out.status, "warning");
  assert.equal(out.actual_words, 5147);
  assert.equal(out.max_words, 4950);
  assert.equal(out.overflow_words, 197);
  assert.equal(out.gate, "word-cap-gate");
});

test("runWordCapGate 不超标 passed", () => {
  const out = runWordCapGate(4000, { targetWords: 3300 });
  assert.equal(out.status, "passed");
  assert.equal(out.actual_words, 4000);
});

test("runWordCapGate 有价时 cost 估算 > 0", () => {
  const out = runWordCapGate(5147, { targetWords: 3300, outputPricePerMillion: 6 });
  assert.ok(out.overflow_cost_estimate > 0);
});

test("runWordCapGate 无价时 cost 估算 null", () => {
  const out = runWordCapGate(5147, { targetWords: 3300 });
  assert.equal(out.overflow_cost_estimate, null);
});

test("buildFactCheckMessages 含豁免规则", () => {
  const messages = buildFactCheckMessages({
    chapterNo: 9, draft: "正文", facts: [], timeline: []
  });
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /回忆/u); // 豁免规则
  assert.match(messages[0].content, /JSON/u);
  const user = messages[1].content;
  assert.match(user, /第 9 章/u);
});

test("parseFactCheck 解析合法输出", () => {
  const raw = '```json\n{"conflicts":[{"draft_quote":"从十二楼坠落","conflicts_with":"六楼","prior_chapter":1,"severity":"high","suggestion":"改为六楼"}]}\n```';
  const out = parseFactCheck(raw);
  assert.equal(out.ok, true);
  assert.equal(out.conflicts.length, 1);
  assert.equal(out.conflicts[0].prior_chapter, 1);
  assert.equal(out.conflicts[0].severity, "high");
});

test("parseFactCheck 畸形输出 ok:false", () => {
  assert.equal(parseFactCheck("不是 JSON").ok, false);
  assert.equal(parseFactCheck("").ok, false);
});

test("buildFactCheckMessages 不截断正文（冲突可能在章节尾部）", () => {
  const longDraft = "开头无冲突内容。".repeat(300) + "刘康从十二楼坠落。";
  assert.ok(longDraft.length > 2000, "前置条件：正文超 2000 字符");
  const messages = buildFactCheckMessages({
    chapterNo: 2,
    draft: longDraft,
    facts: [{ entity: "刘康", attribute: "坠楼楼层", value: "六楼", chapter_no: 1 }],
    timeline: []
  });
  assert.match(messages[1].content, /十二楼/u, "章节尾部内容必须进入核查输入");
});

test("parseFactCheck 解析 replace_with 字段，缺省为空串", () => {
  const raw = JSON.stringify({ conflicts: [{
    draft_quote: "从十二楼坠落",
    conflicts_with: "坠楼楼层: 六楼",
    prior_chapter: 1,
    severity: "high",
    suggestion: "建议把十二楼改成六楼以保持一致",
    replace_with: "从六楼坠落"
  }, {
    draft_quote: "时间线混乱",
    conflicts_with: "ch1 午间",
    prior_chapter: 1,
    severity: "low",
    suggestion: "复杂改动，无法机械替换"
  }] });
  const parsed = parseFactCheck(raw);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.conflicts[0].replace_with, "从六楼坠落");
  assert.equal(parsed.conflicts[1].replace_with, "");
});

test("buildFactCheckMessages 系统提示要求 replace_with 为可直接替换文字", () => {
  const messages = buildFactCheckMessages({ chapterNo: 2, draft: "x", facts: [], timeline: [] });
  assert.match(messages[0].content, /replace_with/u);
});

test("buildFactCheckMessages: 注入故事时钟 + 时间线带 raw/elapsed/anchor", () => {
  const messages = buildFactCheckMessages({
    chapterNo: 9, draft: "案发当晚他就到了。",
    facts: [{ entity: "刘康", attribute: "生死", value: "死亡", chapter_no: 1 }],
    timeline: [{ chapter_no: 7, story_time_raw: "三天后", events: ["抵达工地"],
      time: { kind: "scene", elapsed: "+3d", anchor: { type: "date", raw: "3月10日", subject: null }, confidence: "high" } }],
    storyClock: "截至第 7 章，故事时钟约为第 3 天"
  });
  const user = messages[1].content;
  assert.match(user, /三天后/u);
  assert.match(user, /\+3d/u);
  assert.match(user, /故事时钟/u);
  assert.match(user, /第 3 天/u);
});

test("buildFactCheckMessages: 无 storyClock 不渲染时钟段、兼容旧 story_time", () => {
  const messages = buildFactCheckMessages({
    chapterNo: 2, draft: "x", facts: [{ entity: "a", attribute: "b", value: "c", chapter_no: 1 }],
    timeline: [{ chapter_no: 1, story_time: "十月", events: ["e"] }]
  });
  const user = messages[1].content;
  assert.match(user, /十月/u);
  assert.doesNotMatch(user, /故事时钟/u);
});
