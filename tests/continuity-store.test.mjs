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
