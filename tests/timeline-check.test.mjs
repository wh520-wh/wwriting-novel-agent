import assert from "node:assert/strict";
import test from "node:test";
import { parseElapsedToken, parseDateRaw, parseAnchorValue, computeStoryClock, describeStoryClock } from "../src/core/timeline-check.mjs";

test("parseElapsedToken: 合法 token 转小时", () => {
  assert.equal(parseElapsedToken("+0"), 0);
  assert.equal(parseElapsedToken("+12h"), 12);
  assert.equal(parseElapsedToken("+3d"), 72);
  assert.equal(parseElapsedToken("+2w"), 336);
  assert.equal(parseElapsedToken("+1mo"), 720);
  assert.equal(parseElapsedToken("+1y"), 8760);
});

test("parseElapsedToken: 非法/空返回 null", () => {
  assert.equal(parseElapsedToken(null), null);
  assert.equal(parseElapsedToken("三天后"), null);
  assert.equal(parseElapsedToken("-3d"), null);
  assert.equal(parseElapsedToken(""), null);
});

test("parseDateRaw: 带年份可比较，YYYYMMDD 单调（含跨年）", () => {
  const a = parseDateRaw("2021年3月10日");
  const b = parseDateRaw("2021年3月5日");
  assert.equal(a.comparable, true);
  assert.equal(b.comparable, true);
  assert.ok(a.value > b.value);
  // 跨年：2020年12月31日 应早于 2021年1月1日
  assert.ok(parseDateRaw("2020年12月31日").value < parseDateRaw("2021年1月1日").value);
  // 中文数字等价
  assert.equal(parseDateRaw("二千零二十一年三月五日").value, parseDateRaw("2021年3月5日").value);
});

test("parseDateRaw: 不带年份 → comparable:false（防跨年误报）", () => {
  assert.equal(parseDateRaw("3月10日").comparable, false);
  assert.equal(parseDateRaw("某天"), null);
  assert.equal(parseDateRaw("10日").comparable, false);
});

test("parseAnchorValue: age 取整数年龄，date 走日期，named/空→null", () => {
  assert.deepEqual(parseAnchorValue({ type: "age", raw: "20岁" }), { unit: "year", value: 20 });
  assert.deepEqual(parseAnchorValue({ type: "age", raw: "二十岁" }), { unit: "year", value: 20 });
  assert.equal(parseAnchorValue({ type: "date", raw: "2021年3月10日" }).comparable, true);
  assert.equal(parseAnchorValue({ type: "named", raw: "登基大典" }), null);
  assert.equal(parseAnchorValue(null), null);
});

const sc = (chapter_no, elapsed, extra = {}) => ({
  chapter_no, events: ["e"], story_time_raw: extra.raw ?? "",
  time: { kind: extra.kind ?? "scene", elapsed, anchor: extra.anchor ?? null, confidence: extra.confidence ?? "high" }
});

test("computeStoryClock: 累加 elapsed 得第几天", () => {
  const { perChapter, latest } = computeStoryClock([
    sc(1, null), sc(2, "+1d"), sc(3, "+3d")
  ]);
  assert.equal(perChapter.get(1).day, 0);
  assert.equal(perChapter.get(2).day, 1);
  assert.equal(perChapter.get(3).day, 4);
  assert.equal(latest.chapter_no, 3);
  assert.equal(latest.certain, true);
});

test("computeStoryClock: 中间 elapsed=null 标记不确定", () => {
  const { latest } = computeStoryClock([sc(1, null), sc(2, null), sc(3, "+2d")]);
  assert.equal(latest.certain, false);
});

test("computeStoryClock: flashback 不进主链", () => {
  const { perChapter } = computeStoryClock([
    sc(1, null), sc(2, "+1d"), sc(3, "+0", { kind: "flashback" }), sc(4, "+2d")
  ]);
  assert.equal(perChapter.has(3), false);
  assert.equal(perChapter.get(4).day, 3);
});

test("describeStoryClock: 生成喂提示的摘要", () => {
  assert.match(describeStoryClock([sc(1, null), sc(2, "+3d")]), /第 ?2 ?章/u);
  assert.match(describeStoryClock([sc(1, null), sc(2, "+3d")]), /第 ?3 ?天/u);
  assert.equal(describeStoryClock([]), "");
});
