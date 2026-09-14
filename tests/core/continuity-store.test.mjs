import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadContinuity, mergeExtraction, saveContinuity, renderContinuityMarkdown
} from "../../src/core/continuity-store.mjs";

async function tmpProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-continuity-"));
  await fs.mkdir(path.join(root, "memory"), { recursive: true });
  return root;
}

test("loadContinuity 无文件时返回空结构", async () => {
  const root = await tmpProject();
  const data = await loadContinuity(root);
  assert.deepEqual(data.facts, []);
  assert.deepEqual(data.timeline, []);
  assert.deepEqual(data.characters, []);
});

test("mergeExtraction 新事实追加，同实体同属性新值标记冲突", () => {
  const base = { schema_version: 1, facts: [
    { entity: "刘康", attribute: "坠楼楼层", value: "六楼", chapter_no: 1, quote: "六楼。", conflict_with: null }
  ], timeline: [], characters: [] };
  const merged = mergeExtraction(base, {
    facts: [{ entity: "刘康", attribute: "坠楼楼层", value: "十二楼", chapter_no: 2, quote: "十二楼。" }],
    timeline: [{ chapter_no: 2, story_time: "次日", events: ["去工地"] }],
    characters: [{ name: "老马", traits: ["观察敏锐"], status: "存活", chapter_no: 2 }]
  });
  const floors = merged.facts.filter((f) => f.attribute === "坠楼楼层");
  assert.equal(floors.length, 2);
  assert.equal(floors[1].conflict_with, "第1章: 六楼");
  assert.equal(merged.timeline.length, 1);
  assert.equal(merged.characters[0].name, "老马");
});

test("mergeExtraction 同实体同属性同值去重（幂等）", () => {
  const base = { schema_version: 1, facts: [
    { entity: "刘康", attribute: "坠楼楼层", value: "六楼", chapter_no: 1, quote: "六楼。", conflict_with: null }
  ], timeline: [], characters: [] };
  const merged = mergeExtraction(base, {
    facts: [{ entity: "刘康", attribute: "坠楼楼层", value: "六楼", chapter_no: 1, quote: "六楼。" }],
    timeline: [], characters: []
  });
  assert.equal(merged.facts.length, 1);
});

test("characters 同名合并：traits 并集、status 取新", () => {
  const base = { schema_version: 1, facts: [], timeline: [], characters: [
    { name: "刘康", traits: ["叼着不点的烟"], status: "存活", chapter_no: 1 }
  ] };
  const merged = mergeExtraction(base, {
    facts: [], timeline: [],
    characters: [{ name: "刘康", traits: ["放高利贷"], status: "已死亡", chapter_no: 1 }]
  });
  assert.equal(merged.characters.length, 1);
  assert.deepEqual(merged.characters[0].traits, ["叼着不点的烟", "放高利贷"]);
  assert.equal(merged.characters[0].status, "已死亡");
});

test("save + load 往返一致，且渲染 markdown 同步落盘", async () => {
  const root = await tmpProject();
  const data = mergeExtraction(await loadContinuity(root), {
    facts: [{ entity: "沈泽", attribute: "能力", value: "意念致死", chapter_no: 1, quote: "他去死就好了。" }],
    timeline: [{ chapter_no: 1, story_time: "十月", events: ["能力觉醒"] }],
    characters: [{ name: "沈泽", traits: ["谨慎"], status: "存活", chapter_no: 1 }]
  });
  await saveContinuity(root, data);
  const reloaded = await loadContinuity(root);
  assert.equal(reloaded.facts[0].value, "意念致死");
  const md = await fs.readFile(path.join(root, "memory", "continuity.md"), "utf8");
  assert.match(md, /沈泽/u);
  assert.match(md, /意念致死/u);
  assert.match(md, /第1章/u);
});

test("renderContinuityMarkdown 含冲突标记", () => {
  const md = renderContinuityMarkdown({ schema_version: 1, facts: [
    { entity: "刘康", attribute: "坠楼楼层", value: "十二楼", chapter_no: 2, quote: "", conflict_with: "第1章: 六楼" }
  ], timeline: [], characters: [] });
  assert.match(md, /⚠.*冲突.*第1章: 六楼/u);
});

test("mergeExtraction: 写入 v2 timeline（raw + time）", () => {
  const merged = mergeExtraction(
    { schema_version: 2, facts: [], timeline: [], characters: [] },
    { facts: [], characters: [], timeline: [
      { chapter_no: 5, story_time_raw: "三日后", events: ["上工地"],
        time: { kind: "scene", elapsed: "+3d", anchor: null, confidence: "high" } } ] }
  );
  assert.equal(merged.timeline.length, 1);
  assert.equal(merged.timeline[0].story_time_raw, "三日后");
  assert.equal(merged.timeline[0].time.elapsed, "+3d");
});

test("loadContinuity: v1 节点惰性迁移为 v2", async () => {
  const root = await tmpProject();
  await fs.writeFile(path.join(root, "memory", "continuity.json"), JSON.stringify({
    schema_version: 1, facts: [], characters: [],
    timeline: [{ chapter_no: 1, story_time: "十月", events: ["觉醒"] }]
  }), "utf8");
  const data = await loadContinuity(root);
  assert.equal(data.schema_version, 3);
  const t = data.timeline[0];
  assert.equal(t.story_time_raw, "十月");
  assert.equal(t.time.kind, "scene");
  assert.equal(t.time.confidence, "low");
  assert.equal(t.time.elapsed, null);
});

test("renderContinuityMarkdown: 时间线优先 raw 并带 time 摘要", () => {
  const md = renderContinuityMarkdown({ schema_version: 2, facts: [], characters: [], timeline: [
    { chapter_no: 5, story_time_raw: "三日后", events: ["上工地"],
      time: { kind: "scene", elapsed: "+3d", anchor: null, confidence: "high" } } ] });
  assert.match(md, /第5章/u);
  assert.match(md, /三日后/u);
  assert.match(md, /\+3d/u);
  assert.match(md, /上工地/u);
});

test("renderContinuityMarkdown: null 章号 timeline 渲染为未标章号而非第null章", () => {
  const md = renderContinuityMarkdown({ schema_version: 2, facts: [], characters: [], timeline: [
    { chapter_no: null, story_time_raw: "某个夜晚", events: ["夜谈"],
      time: { kind: "scene", elapsed: null, anchor: null, confidence: "low" } } ] });
  assert.doesNotMatch(md, /第null章/u);
  assert.match(md, /未标章号/u);
  assert.match(md, /夜谈/u);
});

test("migrateTimelineNode: 透传的畸形 time 被规范化", () => {
  const merged = mergeExtraction(
    { schema_version: 2, facts: [], timeline: [], characters: [] },
    { facts: [], characters: [], timeline: [
      { chapter_no: 5, story_time_raw: "x", events: ["e"],
        time: { kind: "weird", elapsed: "三天", anchor: "bad", confidence: "maybe" } } ] }
  );
  const t = merged.timeline[0].time;
  assert.equal(t.kind, "scene");
  assert.equal(t.elapsed, null);
  assert.equal(t.anchor, null);
  assert.equal(t.confidence, "low");
});

// ---------------------------------------------------------------------------
// 第十六轮 T3：foreshadows 伏笔台账（continuity v3）
// ---------------------------------------------------------------------------

test("foreshadows: open 去重追加、paid 精确匹配销账", () => {
  const base = { schema_version: 3, facts: [], timeline: [], characters: [], foreshadows: [
    { content: "怀表背面刻字", planted_chapter: 2, expected_payoff_hint: "身世揭晓", status: "open", paid_chapter: null }
  ] };
  const merged = mergeExtraction(base, { foreshadows: [
    { content: "怀表背面刻字", chapter_no: 3, status: "open" },
    { content: "管家左手疤痕", chapter_no: 3, status: "open", expected_payoff_hint: "凶手身份" },
    { content: "怀表背面刻字", chapter_no: 7, status: "paid" }
  ] });
  assert.equal(merged.foreshadows.length, 2);
  assert.equal(merged.schema_version, 3, "合并时版本号归一（v3）");
  const watch = merged.foreshadows.find((f) => f.content === "怀表背面刻字");
  assert.equal(watch.status, "paid");
  assert.equal(watch.paid_chapter, 7);
  assert.equal(watch.planted_chapter, 2);
  const scar = merged.foreshadows.find((f) => f.content === "管家左手疤痕");
  assert.equal(scar.status, "open");
  assert.equal(scar.planted_chapter, 3);
});

test("foreshadows: 无字段旧文件兼容，渲染给「无记录」", () => {
  const merged = mergeExtraction(
    { schema_version: 2, facts: [], timeline: [], characters: [] },
    { foreshadows: [{ content: "新伏笔", chapter_no: 1, status: "open" }] }
  );
  assert.equal(merged.foreshadows.length, 1);
  const md = renderContinuityMarkdown({ schema_version: 3, facts: [], timeline: [], characters: [] });
  assert.match(md, /## 伏笔台账/u);
  assert.match(md, /无记录/u);
});

test("foreshadows: paid 无匹配 open 条目时静默忽略", () => {
  const merged = mergeExtraction(
    { schema_version: 3, facts: [], timeline: [], characters: [], foreshadows: [] },
    { foreshadows: [{ content: "不存在的伏笔", chapter_no: 5, status: "paid" }] }
  );
  assert.equal(merged.foreshadows.length, 0);
});

test("foreshadows: 渲染分未收/已收两组", () => {
  const md = renderContinuityMarkdown({ schema_version: 3, facts: [], timeline: [], characters: [], foreshadows: [
    { content: "已收伏笔", planted_chapter: 1, expected_payoff_hint: "", status: "paid", paid_chapter: 4 },
    { content: "未收伏笔", planted_chapter: 2, expected_payoff_hint: "后文揭晓", status: "open", paid_chapter: null }
  ] });
  const openIdx = md.indexOf("【未收】");
  const paidIdx = md.indexOf("【已收】");
  assert.ok(openIdx > 0 && paidIdx > 0, "两组都要渲染");
  assert.ok(md.includes("【未收】第2章埋设：未收伏笔（回收提示：后文揭晓）"));
  assert.ok(md.includes("【已收】第1章埋设 → 第4章回收：已收伏笔"));
});
