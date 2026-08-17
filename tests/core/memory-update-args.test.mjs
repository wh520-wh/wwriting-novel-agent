// 第九轮：update_memory 工具参数归一化纯函数。
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeMemoryUpdateArgs, normalizeTimeField } from "../../src/core/memory-extractor.mjs";

test("条目级 chapter_no 缺省继承顶层 chapter_no", () => {
  const out = normalizeMemoryUpdateArgs({
    chapter_no: 3,
    facts: [{ entity: "林晚", attribute: "职业", value: "记者" }],
    characters: [{ name: "林晚", traits: ["冷静"], chapter_no: 2 }]
  });
  assert.equal(out.chapter_no, 3);
  assert.equal(out.facts[0].chapter_no, 3);
  assert.equal(out.characters[0].chapter_no, 2, "显式 chapter_no 不被覆盖");
});

test("非法条目被过滤，数组上限 50", () => {
  const facts = Array.from({ length: 60 }, (_, i) => ({ entity: `e${i}`, attribute: "a", value: "v" }));
  facts.push({ entity: "缺属性" }); // 缺 attribute → 过滤
  const out = normalizeMemoryUpdateArgs({ chapter_no: 1, facts });
  assert.equal(out.facts.length, 50);
});

test("quote/story_time/events/traits 阈值裁剪", () => {
  const out = normalizeMemoryUpdateArgs({
    chapter_no: 1,
    facts: [{ entity: "x", attribute: "y", value: "z", quote: "字".repeat(100) }],
    timeline: [{ story_time_raw: "原".repeat(100), events: ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9", "e10", "e11"] }],
    characters: [{ name: "c", traits: ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10", "t11"] }]
  });
  assert.equal(out.facts[0].quote.length, 80);
  assert.equal(out.timeline[0].events.length, 10);
  assert.equal(out.characters[0].traits.length, 10);
});

test("time 字段归一化：非法 kind 回落 scene、confidence 只认 high", () => {
  const time = normalizeTimeField({ kind: "dream", elapsed: "+3d", anchor: { type: "date", raw: "2021年3月" }, confidence: "high" });
  assert.deepEqual(time, { kind: "dream", elapsed: "+3d", anchor: { type: "date", raw: "2021年3月", subject: null }, confidence: "high" });
  const fallback = normalizeTimeField({ kind: "nope", elapsed: "昨天", confidence: "maybe" });
  assert.equal(fallback.kind, "scene");
  assert.equal(fallback.elapsed, null);
  assert.equal(fallback.confidence, "low");
});
