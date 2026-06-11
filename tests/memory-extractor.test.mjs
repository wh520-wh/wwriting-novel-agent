import assert from "node:assert/strict";
import test from "node:test";
import { buildMemoryExtractionMessages, parseMemoryExtraction } from "../src/core/memory-extractor.mjs";

test("buildMemoryExtractionMessages 包含章节正文与既有记忆", () => {
  const messages = buildMemoryExtractionMessages({
    chapterNo: 9,
    chapterContent: "沈泽走到北围墙。",
    bookSummary: "# 全书摘要\n\n前八章概述。",
    continuityMarkdown: "## 刘康\n- 坠楼楼层: 六楼 (第1章)"
  });
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /JSON/u);
  const user = messages[1].content;
  assert.match(user, /沈泽走到北围墙/u);
  assert.match(user, /前八章概述/u);
  assert.match(user, /坠楼楼层/u);
  assert.match(user, /第 9 章/u);
});

test("parseMemoryExtraction 解析带围栏的合法输出", () => {
  const raw = '```json\n{"summary":"新摘要","facts":[{"entity":"刘康","attribute":"坠楼楼层","value":"六楼","chapter_no":1,"quote":"六楼。"}],"timeline":[{"chapter_no":9,"story_time":"十月下旬","events":["沈泽探查北围墙"]}],"characters":[{"name":"沈泽","traits":["谨慎"],"status":"存活","chapter_no":9}]}\n```';
  const parsed = parseMemoryExtraction(raw);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.summary, "新摘要");
  assert.equal(parsed.facts.length, 1);
  assert.equal(parsed.facts[0].entity, "刘康");
  assert.equal(parsed.timeline[0].chapter_no, 9);
  assert.equal(parsed.characters[0].name, "沈泽");
});

test("parseMemoryExtraction 对畸形输出返回 ok:false 不抛异常", () => {
  assert.equal(parseMemoryExtraction("我无法输出 JSON").ok, false);
  assert.equal(parseMemoryExtraction('{"summary": 123}').ok, false);
  assert.equal(parseMemoryExtraction("").ok, false);
});

test("parseMemoryExtraction 裁剪超长 summary 到 2000 字", () => {
  const long = "字".repeat(3000);
  const parsed = parseMemoryExtraction(JSON.stringify({ summary: long, facts: [], timeline: [], characters: [] }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.summary.length, 2000);
});
