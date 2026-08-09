// Journal 分段物理层测试（统一 Agent 内核计划 Task 4 Step 1/2）。
//
// tests/agent/ 是允许测试内部 seam 的目录：本文件直接导入
// src/core/agent/journal-segments.mjs（深模块内部实现），覆盖：
//   - 分段轮转：events/transcript 各注入小阈值（maxSegmentBytes:512、
//     maxSegmentRecords:4、indexStride:2），11 条记录产生 3 个 segment；
//   - 倒序/分页读取：event readTail({limit:5}) 返回 seq 7–11、
//     readBefore({beforeSeq:7,limit:3}) 返回 seq 4–6、
//     transcript readAfter({afterSeq:8}) 只返回 transcript_seq 9–11；
//     两条读取都未调用全文件 readFile seam（注入即抛错的 seam）；
//   - 恢复 1：最后一个 segment 的末尾半行自动截断，前面完整事件可读；
//   - 恢复 2：.index.json 缺失或 JSON 损坏时从 segment 重建；
//   - 恢复 3：中间 segment 存在非法行时文件重命名为 .corrupt，
//     page 返回 { gaps: [{ start_seq, end_seq, reason: "segment_corrupt" }] }，
//     前后健康段仍可读；
//   - 迁移 4：旧 events.jsonl / transcript.jsonl 分别只迁移一次，原文件改名为
//     events.legacy.jsonl / transcript.legacy.jsonl；事件 seq/event_id/session_id
//     不变；旧 transcript 按原顺序补 transcript_seq，不改 role/content/tool_call_id；
//   - 轮转前 fsync + sealed 索引 + generation 轮转 hook 存在。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  INDEX_STRIDE,
  SEGMENT_MAX_BYTES,
  SEGMENT_MAX_RECORDS,
  createJournalSegmentStore
} from "../../src/core/agent/journal-segments.mjs";

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function makeRoot(t, name = "segments-root") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `wwriting-segments-${name}-`));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

// 紧凑事件（足够小，使 4 条 < 512 字节——记录数轮转先于字节数轮转）。
function events(from, to) {
  return Array.from({ length: to - from + 1 }, (_, i) => {
    const seq = from + i;
    return { schema_version: 2, seq, event_id: `evt-${seq}`, session_id: "sess-1", type: "input_queued" };
  });
}

function transcriptRecords(from, to) {
  return Array.from({ length: to - from + 1 }, (_, i) => {
    const seq = from + i;
    return { transcript_seq: seq, role: "user", content: `t${seq}` };
  });
}

// 简写：注入小阈值的 store（与 brief 形状一致）。root 必须是 store 的实际根目录
//（如 <tmpdir>/events）；manifest 默认落在其父目录，避免共享系统临时目录。
function makeStore(root, { streamName = "events", readFile = fs.readFile } = {}) {
  return createJournalSegmentStore({
    root,
    streamName,
    maxSegmentRecords: 4,
    maxSegmentBytes: 512,
    indexStride: 2,
    readFile
  });
}

async function segmentFiles(root) {
  const names = await fs.readdir(root);
  return names.filter((name) => /^\d{8}\.jsonl$/u.test(name)).sort();
}

// ---------------------------------------------------------------------------
// Step 1：分段轮转与倒序读取
// ---------------------------------------------------------------------------

test("分段轮转：events/transcript 各 11 条产生 3 个 segment；readTail/readBefore/readAfter 按 brief 返回", async (t) => {
  const root = await makeRoot(t);
  const eventsRoot = path.join(root, "events");
  const transcriptRoot = path.join(root, "transcript");
  const seamCalls = [];
  const throwingSeam = async (file) => {
    seamCalls.push(file);
    throw new Error("全文件 readFile seam 不应在常规读取中被调用");
  };

  const store = createJournalSegmentStore({
    root: eventsRoot,
    streamName: "events",
    maxSegmentRecords: 4,
    maxSegmentBytes: 512,
    indexStride: 2,
    readFile: throwingSeam
  });
  const transcriptStore = createJournalSegmentStore({
    root: transcriptRoot,
    streamName: "transcript",
    maxSegmentRecords: 4,
    maxSegmentBytes: 512,
    indexStride: 2,
    readFile: throwingSeam
  });
  await store.load();
  await transcriptStore.load();
  await store.append(events(1, 11));
  await transcriptStore.append(transcriptRecords(1, 11));

  // 每条流产生 3 个 segment（4+4+3）
  assert.equal((await segmentFiles(eventsRoot)).length, 3, "events 流应产生 3 个 segment");
  assert.equal((await segmentFiles(transcriptRoot)).length, 3, "transcript 流应产生 3 个 segment");

  // event readTail：最新 5 条 = seq 7–11
  assert.deepEqual((await store.readTail({ limit: 5 })).events.map((e) => e.seq), [7, 8, 9, 10, 11]);
  // event readBefore：seq 7 之前 3 条 = seq 4–6
  assert.deepEqual((await store.readBefore({ beforeSeq: 7, limit: 3 })).events.map((e) => e.seq), [4, 5, 6]);
  // transcript readAfter：只返回 transcript_seq 9–11
  assert.deepEqual(
    (await transcriptStore.readAfter({ afterSeq: 8 })).events.map((r) => r.transcript_seq),
    [9, 10, 11]
  );

  // 两条读取都未调用全文件 readFile seam
  assert.deepEqual(seamCalls, [], "readTail/readBefore/readAfter 不得调用全文件 readFile seam");
});

// Task 4 回归钉：活动段 fd 随上一批次关闭（Windows rename 兼容）后，下一次 append
// 跨段轮转时 rotate 必须重开可写句柄 fsync——修前用 "r" 只读句柄 fsync，Windows 抛
// EPERM（本机实测），跨批次轮转即 append 失败、运行中 Run 被判失败。
test("跨批次轮转：fd 已随上一批次关闭时 rotate 重开可写句柄 fsync，跨段追加成功", async (t) => {
  const root = await makeRoot(t, "rotate-fd");
  const eventsRoot = path.join(root, "events");
  const store = createJournalSegmentStore({
    root: eventsRoot,
    streamName: "events",
    maxSegmentRecords: 2,
    indexStride: 1
  });
  await store.load();
  // 每个批次结束 fd 关闭；第 2 个批次起每次都在 fd 关闭的旧段上轮转
  await store.append(events(1, 2));
  await store.append(events(3, 4));
  await store.append(events(5, 6));
  await store.append(events(7, 8));
  assert.equal((await segmentFiles(eventsRoot)).length, 4, "每 2 条一个 segment（4 个）");
  const page = await store.readAfter({ afterSeq: 0 });
  assert.deepEqual(page.events.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8], "跨段追加后全部记录可读");
  // 轮转后旧段 sealed 索引已原子写（fsync 完成后才封存）
  const sealed = JSON.parse(await fs.readFile(path.join(eventsRoot, "00000001.index.json"), "utf8"));
  assert.equal(sealed.sealed, true, "轮转段 sealed 索引必须落盘");
});

// ---------------------------------------------------------------------------
// Step 2：恢复与迁移
// ---------------------------------------------------------------------------

test("恢复 1：最后一个 segment 的末尾半行自动截断，前面完整事件可读", async (t) => {
  const root = await makeRoot(t, "recovery-tail");
  const storeRoot = path.join(root, "events");
  const store = makeStore(storeRoot);
  await store.load();
  await store.append(events(1, 5));

  // 模拟崩溃：向当前（最后一个）segment 追加半行
  const newest = (await segmentFiles(storeRoot)).at(-1);
  await fs.appendFile(path.join(storeRoot, newest), '{"partial', "utf8");

  // 全新 store 实例（模拟进程重启）load 时截断修复
  const reloaded = makeStore(storeRoot);
  await reloaded.load();
  const tail = await reloaded.readTail({ limit: 10 });
  assert.deepEqual(tail.events.map((e) => e.seq), [1, 2, 3, 4, 5], "半行被截断，完整事件仍可读");
  assert.deepEqual(tail.gaps, [], "尾部半行不是缺口");
  // 文件已截断为完整行：后续 append 正常衔接
  await reloaded.append(events(6, 7));
  assert.deepEqual((await reloaded.readTail({ limit: 10 })).events.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7]);
});

test("恢复 2：.index.json 缺失或 JSON 损坏时从 segment 重建", async (t) => {
  const root = await makeRoot(t, "recovery-index");
  const storeRoot = path.join(root, "events");
  const store = makeStore(storeRoot);
  await store.load();
  await store.append(events(1, 9)); // 3 个 segment

  // 删除全部索引
  for (const name of await fs.readdir(storeRoot)) {
    if (name.endsWith(".index.json")) await fs.rm(path.join(storeRoot, name));
  }
  const reloaded = makeStore(storeRoot);
  await reloaded.load();
  assert.deepEqual(
    (await reloaded.readTail({ limit: 10 })).events.map((e) => e.seq),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
    "索引缺失时应从 segment 重建并完整可读"
  );

  // JSON 损坏的索引同样重建
  for (const name of await fs.readdir(storeRoot)) {
    if (name.endsWith(".index.json")) await fs.writeFile(path.join(storeRoot, name), "{{{ not json", "utf8");
  }
  const reloaded2 = makeStore(storeRoot);
  await reloaded2.load();
  assert.deepEqual(
    (await reloaded2.readTail({ limit: 10 })).events.map((e) => e.seq),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
    "索引 JSON 损坏时应从 segment 重建并完整可读"
  );
});

test("恢复 3：中间 segment 非法行 → 重命名 .corrupt，page 返回 gaps，前后健康段仍可读", async (t) => {
  const root = await makeRoot(t, "recovery-corrupt");
  const storeRoot = path.join(root, "events");
  const store = makeStore(storeRoot);
  await store.load();
  await store.append(events(1, 12)); // 3 个 segment：1-4 / 5-8 / 9-12

  // 手工向中间 segment（00000002.jsonl）注入非法行，并删除其索引：
  // load 在重建索引时扫描到非法行 → 隔离为 .corrupt + manifest 记录 gap
  const middle = path.join(storeRoot, "00000002.jsonl");
  const lines = (await fs.readFile(middle, "utf8")).split("\n");
  lines.splice(1, 0, "{broken json");
  await fs.writeFile(middle, lines.join("\n"), "utf8");
  await fs.rm(path.join(storeRoot, "00000002.index.json"), { force: true });

  const reloaded = makeStore(storeRoot);
  await reloaded.load();
  // 坏段被隔离重命名
  assert.equal(await pathExists(path.join(storeRoot, "00000002.jsonl.corrupt")), true, "坏段应重命名为 .corrupt");

  // 前后健康段仍可读，page 返回 gap（含损坏范围）
  const tail = await reloaded.readTail({ limit: 10 });
  assert.deepEqual(tail.gaps, [{ start_seq: 5, end_seq: 8, reason: "segment_corrupt" }]);
  const seqs = tail.events.map((e) => e.seq);
  assert.deepEqual(seqs, [1, 2, 3, 4, 9, 10, 11, 12], "前后健康段可读，坏段范围被跳过并报告为 gap");

  const before = await reloaded.readBefore({ beforeSeq: 9, limit: 10 });
  assert.deepEqual(before.events.map((e) => e.seq), [1, 2, 3, 4], "坏段前的健康段仍可读");
  assert.deepEqual(before.gaps, tail.gaps);
});

test("迁移 4：旧 events.jsonl/transcript.jsonl 各迁移一次，改名 .legacy.jsonl；seq/event_id/session_id 不变；transcript 补 transcript_seq", async (t) => {
  const root = await makeRoot(t, "migrate-legacy");
  const eventsLegacy = path.join(root, "events.jsonl");
  await fs.writeFile(
    eventsLegacy,
    events(1, 4).map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8"
  );
  const eventsStore = makeStore(path.join(root, "segments", "events"));
  await eventsStore.load();
  await eventsStore.importLegacy({ filePath: eventsLegacy, kind: "events" });

  // 原文件改名为 events.legacy.jsonl
  assert.equal(await pathExists(eventsLegacy), false, "events.jsonl 迁移后应被改名");
  assert.equal(await pathExists(path.join(root, "events.legacy.jsonl")), true);
  // 事件 seq/event_id/session_id 不变
  const migrated = (await eventsStore.readAfter({ afterSeq: 0 })).events;
  assert.deepEqual(migrated.map((e) => e.seq), [1, 2, 3, 4]);
  assert.deepEqual(migrated.map((e) => e.event_id), ["evt-1", "evt-2", "evt-3", "evt-4"]);
  assert.equal(migrated.every((e) => e.session_id === "sess-1"), true);

  // 只迁移一次：legacy 文件再次出现（模拟迁移后重新复制）→ 已迁移，只改名不重复导入
  await fs.writeFile(
    eventsLegacy,
    events(1, 4).map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8"
  );
  await eventsStore.importLegacy({ filePath: eventsLegacy, kind: "events" });
  assert.equal((await eventsStore.readAfter({ afterSeq: 0 })).events.length, 4, "不得重复导入");

  // transcript：按原顺序补 transcript_seq，不改 role/content/tool_call_id
  const transcriptLegacy = path.join(root, "transcript.jsonl");
  const legacyTranscriptRecords = [
    { role: "user", content: "旧问题", tool_call_id: null },
    { role: "assistant", content: "旧回答" },
    { role: "tool", content: "旧工具结果", tool_call_id: "tc-legacy-1" }
  ];
  await fs.writeFile(
    transcriptLegacy,
    legacyTranscriptRecords.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf8"
  );
  const transcriptStore = makeStore(path.join(root, "segments", "transcript"), { streamName: "transcript" });
  await transcriptStore.load();
  await transcriptStore.importLegacy({ filePath: transcriptLegacy, kind: "transcript" });
  assert.equal(await pathExists(path.join(root, "transcript.legacy.jsonl")), true, "transcript.jsonl 迁移后应被改名");
  const records = (await transcriptStore.readAfter({ afterSeq: 0 })).events;
  assert.deepEqual(records.map((r) => r.transcript_seq), [1, 2, 3], "旧 transcript 按原顺序补 transcript_seq");
  const normalized = records.map(({ transcript_seq: _seq, ...rest }) => rest);
  assert.deepEqual(normalized, legacyTranscriptRecords, "role/content/tool_call_id 不得被改写");
});

test("legacy 迁移校验：中间 seq 缺口拒绝导入且不产生半份 segments", async (t) => {
  const root = await makeRoot(t, "migrate-gap");
  const eventsLegacy = path.join(root, "events.jsonl");
  const broken = events(1, 2).concat(events(4, 4));
  await fs.writeFile(
    eventsLegacy,
    broken.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8"
  );
  const store = makeStore(path.join(root, "segments", "events"));
  await store.load();
  await assert.rejects(
    () => store.importLegacy({ filePath: eventsLegacy, kind: "events" }),
    /seq 缺口/
  );
  // 拒绝后不产生任何 segment 数据，原文件未被改名
  assert.equal((await segmentFiles(path.join(root, "segments", "events"))).length, 0);
  assert.equal(await pathExists(eventsLegacy), true);
  assert.equal(await pathExists(path.join(root, "events.legacy.jsonl")), false);
});

test("sealed 索引与 generation 轮转 hook：fsync 后封存旧段、manifest 记录旧 generation", async (t) => {
  const root = await makeRoot(t, "rotate-gen");
  const storeRoot = path.join(root, "events");
  const store = makeStore(storeRoot);
  await store.load();
  await store.append(events(1, 9)); // 3 个 segment（前两个 sealed）
  const manifest = store.manifest;
  assert.equal(typeof manifest.generation_id, "string");
  assert.equal(manifest.generation_id.length > 0, true);
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.last_event_seq, 9);

  // 检查封存段的索引 sealed:true
  const index1 = JSON.parse(await fs.readFile(path.join(storeRoot, "00000001.index.json"), "utf8"));
  assert.equal(index1.sealed, true, "轮转后的旧段索引必须 sealed:true");
  assert.equal(index1.segment_id, 1);
  assert.equal(index1.end_seq, 4);
  // 活动段（id 3）未封存：load 状态里 sealed 必须为 false（不足 stride 时可能无索引文件）
  const info = await store.load();
  const seg3 = info.segments.find((s) => s.id === 3);
  assert.equal(seg3.sealed, false, "活动段索引不得 sealed");

  // generation 轮转 hook：移动到 historyDir 并记录旧 generation、新 generation 从空开始
  const historyDir = path.join(root, "degraded-history");
  const result = await store.startGeneration({ historyDir, reason: "recovery_degraded" });
  assert.notEqual(result.generation_id, manifest.generation_id, "轮转后必须生成新 generation_id");
  assert.equal(await pathExists(path.join(historyDir, `${manifest.generation_id}-events`)), true, "旧段应移入历史目录");
  assert.equal((await eventsStoreCount(store)), 0, "新 generation 从空开始");
  assert.equal(store.manifest.generations.length, 1);
  assert.equal(store.manifest.generations[0].reason, "recovery_degraded");
  assert.equal(store.manifest.generations[0].end_seq, 9);
  // 新 generation 可立即写入（不复用旧 seq）
  await store.append(events(1, 2));
  assert.deepEqual((await store.readTail({ limit: 10 })).events.map((e) => e.seq), [1, 2]);
});

async function eventsStoreCount(store) {
  const tail = await store.readTail({ limit: null });
  return tail.events.length;
}

test("恢复 3b：非满中间坏段的 gap 不吞并健康后继段（后继落在旧名义范围内）", async (t) => {
  const root = await makeRoot(t, "recovery-corrupt-successor");
  const storeRoot = path.join(root, "events");
  await fs.mkdir(storeRoot, { recursive: true });
  // 手工构造三段：seg1=[1,2]、seg2=[3,4]+非法行（坏段，仅 2 条合法记录——非满段）、
  // seg3=[5,6]（健康后继）。旧实现对非满坏段按 maxSegmentRecords 外推名义范围 [3,6]，
  // 会把 seg3 整段吞成 gap；修复后必须只覆盖 [3,4]。
  await fs.writeFile(path.join(storeRoot, "00000001.jsonl"), events(1, 2).map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  await fs.writeFile(path.join(storeRoot, "00000002.jsonl"), events(3, 4).map((e) => JSON.stringify(e)).join("\n") + "\n" + "{broken\n", "utf8");
  await fs.writeFile(path.join(storeRoot, "00000003.jsonl"), events(5, 6).map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

  const store = makeStore(storeRoot);
  const info = await store.load();
  assert.equal(await pathExists(path.join(storeRoot, "00000002.jsonl.corrupt")), true, "坏段应被隔离");
  assert.deepEqual(info.gaps, [{ start_seq: 3, end_seq: 4, reason: "segment_corrupt" }], "gap 只覆盖坏段名义范围");
  assert.equal(info.last_seq, 6, "last_seq 与可读事件一致（健康后继在列）");
  const tail = await store.readTail({ limit: 10 });
  assert.deepEqual(tail.events.map((e) => e.seq), [1, 2, 5, 6], "健康后继段必须可读，不得被吞并");
  const after = await store.readAfter({ afterSeq: 4 });
  assert.deepEqual(after.events.map((e) => e.seq), [5, 6], "gap 之后的后继段可读");
  const before = await store.readBefore({ beforeSeq: 5, limit: 10 });
  assert.deepEqual(before.events.map((e) => e.seq), [1, 2], "gap 之前的健康段可读");
});

test("后台索引重建：load 立即返回尾部页，重建作为 AbortSignal 保护的后台任务继续", async (t) => {
  const root = await makeRoot(t, "rebuild-bg");
  const storeRoot = path.join(root, "events");
  const store = makeStore(storeRoot);
  await store.load();
  await store.append(events(1, 11)); // 3 个 segment
  // 删除全部索引 → 模拟缺索引（后台重建的慢速 seam）
  for (const name of await fs.readdir(storeRoot)) {
    if (name.endsWith(".index.json")) await fs.rm(path.join(storeRoot, name));
  }

  const bg = createJournalSegmentStore({
    root: storeRoot,
    streamName: "events",
    maxSegmentRecords: 4,
    maxSegmentBytes: 512,
    indexStride: 2,
    rebuildDelayMs: 40
  });
  const info = await bg.load({ rebuildMode: "background" });
  // load 立即返回：尾部页立即可用（不阻塞在重建上）
  const tail = await bg.readTail({ limit: 10 });
  assert.deepEqual(tail.events.map((e) => e.seq), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  // 重建仍在进行（索引尚未写回）
  assert.equal(await pathExists(path.join(storeRoot, "00000002.index.json")), false, "后台重建不应阻塞 load 的尾部页");
  // 等待后台任务完成 → 索引补齐
  assert.ok(info.rebuilding, "background load 应返回 rebuilding promise");
  await info.rebuilding;
  assert.equal(await pathExists(path.join(storeRoot, "00000002.index.json")), true, "重建应补齐索引");
  assert.equal(await pathExists(path.join(storeRoot, "00000001.index.json")), true);
  assert.equal(await pathExists(path.join(storeRoot, "00000003.index.json")), true);

  // AbortSignal：已中止的 load 不启动后台重建，懒扫描仍可读
  const controller = new AbortController();
  controller.abort();
  const ab = createJournalSegmentStore({
    root: storeRoot,
    streamName: "events",
    maxSegmentRecords: 4,
    maxSegmentBytes: 512,
    indexStride: 2,
    rebuildDelayMs: 40
  });
  const abInfo = await ab.load({ rebuildMode: "background", signal: controller.signal });
  assert.equal(abInfo.rebuilding, null, "已中止的 load 不得启动后台重建");
  const abTail = await ab.readTail({ limit: 10 });
  assert.equal(abTail.events.length, 10, "懒扫描仍可读取尾部页");
});

// 常量契约（brief 固定值）
test("固定常量：SEGMENT_MAX_BYTES / SEGMENT_MAX_RECORDS / INDEX_STRIDE", () => {
  assert.equal(SEGMENT_MAX_BYTES, 16 * 1024 * 1024);
  assert.equal(SEGMENT_MAX_RECORDS, 25_000);
  assert.equal(INDEX_STRIDE, 256);
});

// ---------------------------------------------------------------------------
// Task 5：顺序流式导出（streamAll）与共享 manifest 的 generation 轮转
// ---------------------------------------------------------------------------

test("Task 5 streamAll：顺序 yield 健康记录，坏段缺口经 gaps 单独报告且不 yield", async (t) => {
  const root = await makeRoot(t, "export-streamall");
  const storeRoot = path.join(root, "events");
  const store = makeStore(storeRoot);
  await store.load();
  await store.append(events(1, 12)); // 3 个 segment：1-4 / 5-8 / 9-12

  // 手工向中间 segment 注入非法行并删除索引 → load 隔离为 gap [5,8]
  const middle = path.join(storeRoot, "00000002.jsonl");
  const lines = (await fs.readFile(middle, "utf8")).split("\n");
  lines.splice(1, 0, "{broken json");
  await fs.writeFile(middle, lines.join("\n"), "utf8");
  await fs.rm(path.join(storeRoot, "00000002.index.json"), { force: true });

  const reloaded = makeStore(storeRoot);
  await reloaded.load();
  const yielded = [];
  for await (const record of reloaded.streamAll()) yielded.push(record);
  assert.deepEqual(
    yielded.map((r) => r.seq),
    [1, 2, 3, 4, 9, 10, 11, 12],
    "streamAll 必须跳过坏段、按 seq 顺序 yield 健康记录"
  );
  assert.deepEqual(reloaded.gaps, [{ start_seq: 5, end_seq: 8, reason: "segment_corrupt" }], "坏段范围经 gaps 单独报告");
  assert.equal(yielded.some((r) => JSON.stringify(r).includes("broken")), false, "隔离文件原文不得被 yield");
});

// I3 修复：索引有效但内容位腐的 sealed 段必须被懒隔离，读取返回缺口而非原始损坏错误。
function writeIndexFile(root, segmentId, { startSeq, endSeq, count, sealed = true }) {
  return fs.writeFile(
    path.join(root, `${String(segmentId).padStart(8, "0")}.index.json`),
    JSON.stringify({
      schema_version: 1,
      segment_id: segmentId,
      start_seq: startSeq,
      end_seq: endSeq,
      event_count: count,
      bytes: 0,
      offsets: [{ seq: startSeq, byte: 0 }],
      sealed
    }) + "\n",
    "utf8"
  );
}

test("I3：索引有效但内容位腐的 sealed 段 → 首次读抛结构化 SEGMENT_GAP 并隔离，随后健康段可读", async (t) => {
  const root = await makeRoot(t, "recovery-sealed-rot");
  const storeRoot = path.join(root, "events");
  await fs.mkdir(storeRoot, { recursive: true });
  // 三段：seg1=[1,2]、seg2=[3,4]+非法行（索引仍声称 [3,4]，load 信任索引不扫描）、
  // seg3=[5,6]（健康后继）。
  await fs.writeFile(path.join(storeRoot, "00000001.jsonl"), events(1, 2).map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  await writeIndexFile(storeRoot, 1, { startSeq: 1, endSeq: 2, count: 2 });
  await fs.writeFile(path.join(storeRoot, "00000002.jsonl"), events(3, 4).map((e) => JSON.stringify(e)).join("\n") + "\n" + "{broken\n", "utf8");
  await writeIndexFile(storeRoot, 2, { startSeq: 3, endSeq: 4, count: 2 });
  await fs.writeFile(path.join(storeRoot, "00000003.jsonl"), events(5, 6).map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  await writeIndexFile(storeRoot, 3, { startSeq: 5, endSeq: 6, count: 2 });

  const store = makeStore(storeRoot);
  const info = await store.load();
  assert.deepEqual(info.gaps, [], "索引有效：load 阶段不隔离（懒扫描不覆盖 sealed 段）");
  assert.equal(info.last_seq, 6, "load 后 last_seq 正常（索引被信任）");

  // 首次读命中坏段：结构化 SEGMENT_GAP（不是原始"段损坏"文本错误）
  await assert.rejects(() => store.readTail({ limit: 10 }), (e) => e.code === "SEGMENT_GAP");
  // 隔离完成后：坏段改名、gap 记录精确、健康段可读
  assert.equal(await pathExists(path.join(storeRoot, "00000002.jsonl.corrupt")), true, "坏段应重命名为 .corrupt");
  assert.deepEqual(store.gaps, [{ start_seq: 3, end_seq: 4, reason: "segment_corrupt" }], "gap 只覆盖坏段范围");
  const tail = await store.readTail({ limit: 10 });
  assert.deepEqual(tail.events.map((e) => e.seq), [1, 2, 5, 6], "健康段可读，gap 范围跳过");
  assert.deepEqual(tail.gaps, [{ start_seq: 3, end_seq: 4, reason: "segment_corrupt" }]);
  const after = await store.readAfter({ afterSeq: 4 });
  assert.deepEqual(after.events.map((e) => e.seq), [5, 6], "gap 之后的后继段可读");
  const before = await store.readBefore({ beforeSeq: 5, limit: 10 });
  assert.deepEqual(before.events.map((e) => e.seq), [1, 2], "gap 之前的健康段可读");
});

test("I3：活动段索引之后的尾部损坏 → load 不拒绝，隔离为 gap（工作区可打开）", async (t) => {
  const root = await makeRoot(t, "recovery-active-tail-rot");
  const storeRoot = path.join(root, "events");
  await fs.mkdir(storeRoot, { recursive: true });
  // 活动段：索引指向 seq 1（byte 0），但内容在索引之后有带换行的损坏行——
  // 不是无换行半行（load 的截断不处理它），refreshActiveTail 必须隔离而非抛错。
  await fs.writeFile(
    path.join(storeRoot, "00000001.jsonl"),
    events(1, 2).map((e) => JSON.stringify(e)).join("\n") + "\n" + "{broken\n",
    "utf8"
  );
  await writeIndexFile(storeRoot, 1, { startSeq: 1, endSeq: 2, count: 2, sealed: false });

  const store = makeStore(storeRoot);
  const info = await store.load(); // 必须不 reject
  assert.equal(await pathExists(path.join(storeRoot, "00000001.jsonl.corrupt")), true, "损坏尾部必须隔离为 .corrupt");
  assert.deepEqual(info.gaps, [{ start_seq: 1, end_seq: 2, reason: "segment_corrupt" }], "gap 覆盖整段（保守下界）");
  assert.equal(info.last_seq, 0, "隔离后无健康记录");
  assert.deepEqual((await store.readTail({ limit: 10 })).events, [], "隔离后读取为空而非抛错");
});

test("Task 5 startGeneration 共享 manifest：双流以同一 oldGenerationId 轮转，历史归属一致", async (t) => {
  const root = await makeRoot(t, "rotate-shared-gen");
  const eventsRoot = path.join(root, "events");
  const transcriptRoot = path.join(root, "transcript");
  const manifestPath = path.join(root, "journal-manifest.json");
  const eventsStore = createJournalSegmentStore({
    root: eventsRoot,
    streamName: "events",
    manifestPath,
    maxSegmentRecords: 4,
    maxSegmentBytes: 512,
    indexStride: 2
  });
  const transcriptStore = createJournalSegmentStore({
    root: transcriptRoot,
    streamName: "transcript",
    manifestPath,
    maxSegmentRecords: 4,
    maxSegmentBytes: 512,
    indexStride: 2
  });
  await eventsStore.load();
  await transcriptStore.load();
  await eventsStore.append(events(1, 5));
  await transcriptStore.append(transcriptRecords(1, 3));
  const oldGenerationId = eventsStore.manifest.generation_id;
  assert.equal(transcriptStore.manifest.generation_id, oldGenerationId, "双流共享同一 generation_id");

  // 双流轮转必须归属同一旧 generation（共享 manifest：第二次轮转若不固定
  // oldGenerationId 会把新 events generation id 误记为 transcript 的旧 id）。
  // 以 manifest 文件为真相（各自 in-memory manifest 在另一流轮转后可能滞后）。
  const historyDir = path.join(root, "cleared-history", "ts");
  const r1 = await eventsStore.startGeneration({ historyDir, reason: "user_clear", oldGenerationId });
  const r2 = await transcriptStore.startGeneration({ historyDir, reason: "user_clear", oldGenerationId });
  assert.equal(r1.old_generation_id, oldGenerationId);
  assert.equal(r2.old_generation_id, oldGenerationId);
  const manifestOnDisk = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.equal(manifestOnDisk.generations.length, 2, "manifest 记录两条旧 generation");
  assert.equal(manifestOnDisk.generations[0].generation_id, oldGenerationId);
  assert.equal(manifestOnDisk.generations[1].generation_id, oldGenerationId, "transcript 轮转不得误用新 events generation id");
  assert.notEqual(manifestOnDisk.generation_id, oldGenerationId, "当前 generation 必须是新 id");
  assert.equal(await pathExists(path.join(historyDir, `${oldGenerationId}-events`)), true, "旧 events 段移入历史目录");
  assert.equal(await pathExists(path.join(historyDir, `${oldGenerationId}-transcript`)), true, "旧 transcript 段移入历史目录");

  // 新 generation 从空开始，两流可立即写入（不复用旧 seq）
  await eventsStore.append(events(1, 2));
  assert.deepEqual((await eventsStore.readTail({ limit: 10 })).events.map((e) => e.seq), [1, 2]);
  await transcriptStore.append(transcriptRecords(1, 1));
  assert.deepEqual((await transcriptStore.readTail({ limit: 10 })).events.map((r) => r.transcript_seq), [1]);
});
