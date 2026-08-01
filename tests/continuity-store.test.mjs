import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadContinuity, mergeExtraction, saveContinuity, renderContinuityMarkdown,
  loadContinuityState, saveContinuityState
} from "../src/core/continuity-store.mjs";

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

test("水位读写", async () => {
  const root = await tmpProject();
  assert.equal((await loadContinuityState(root)).last_extracted_chapter, 0);
  await saveContinuityState(root, { last_extracted_chapter: 9 });
  assert.equal((await loadContinuityState(root)).last_extracted_chapter, 9);
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
  assert.equal(data.schema_version, 2);
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
