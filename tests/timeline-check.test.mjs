import assert from "node:assert/strict";
import test from "node:test";
import { parseElapsedToken, parseDateRaw, parseAnchorValue, computeStoryClock, describeStoryClock, checkTimeline, summarizeTimelineViolations } from "../src/core/timeline-check.mjs";

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

const an = (chapter_no, kind, anchor, confidence = "high") => ({
  chapter_no, events: ["e"], story_time_raw: anchor?.raw ?? "",
  time: { kind, elapsed: null, anchor, confidence }
});

test("checkTimeline: 带年份日期倒退报 time_reversal", () => {
  const { violations } = checkTimeline([
    an(3, "scene", { type: "date", raw: "2021年3月10日" }),
    an(5, "scene", { type: "date", raw: "2021年3月5日" })
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, "time_reversal");
  assert.equal(violations[0].chapter_no, 5);
  assert.equal(violations[0].prior_chapter, 3);
});

test("checkTimeline: 不带年份月日（跨年）不误报", () => {
  const { violations } = checkTimeline([
    an(3, "scene", { type: "date", raw: "12月20日" }),
    an(5, "scene", { type: "date", raw: "1月5日" })
  ]);
  assert.equal(violations.length, 0);
});

test("checkTimeline: 闪回不算倒流", () => {
  const { violations } = checkTimeline([
    an(3, "scene", { type: "date", raw: "2021年3月10日" }),
    an(5, "flashback", { type: "date", raw: "2021年3月5日" })
  ]);
  assert.equal(violations.length, 0);
});

test("checkTimeline: 同 subject 年龄倒退报 anchor_conflict", () => {
  const { violations } = checkTimeline([
    an(2, "scene", { type: "age", raw: "20岁", subject: "主角" }),
    an(6, "scene", { type: "age", raw: "18岁", subject: "主角" })
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, "anchor_conflict");
  assert.equal(violations[0].chapter_no, 6);
});

test("checkTimeline: 空 subject 的不同年龄不串桶误报", () => {
  const { violations } = checkTimeline([
    an(2, "scene", { type: "age", raw: "40岁", subject: null }),
    an(6, "scene", { type: "age", raw: "18岁", subject: null })
  ]);
  assert.equal(violations.length, 0);
});

test("checkTimeline: 低置信不判", () => {
  const { violations } = checkTimeline([
    an(3, "scene", { type: "date", raw: "2021年3月10日" }, "high"),
    an(5, "scene", { type: "date", raw: "2021年3月5日" }, "low")
  ]);
  assert.equal(violations.length, 0);
});

test("summarizeTimelineViolations: 用传入章号、含建议", () => {
  const note = summarizeTimelineViolations(
    [{ type: "time_reversal", chapter_no: 5, prior_chapter: 3, severity: "high", detail: "", suggestion: "建议调整其一" }], 5);
  assert.match(note, /第 ?5 ?章/u);
  assert.match(note, /建议/u);
});
