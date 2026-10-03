// journal 锚点增量重放回归（2026-10-03 修复 buildState/degradedState 的
// const session 重赋值）。断言设计（2026-10-03 审查修正）：
// - 批次取 INDEX_STRIDE 的整数倍，让段索引覆盖到尾部——否则锚定增量的 readAfter
//   对未索引区间也从字节 0 读整段，落后锚点与最新锚点的全段读取天然相差一次，
//   断言在正确代码上误报；
// - 「最新锚点」必须在 append 完成之后读取——先读后追加会让两个测量场景同构
//   （都重放尾事件），const 回归下双双回退全量、断言照样通过（恒真空，已复现）。
// 现行代码：behind 1 次 == latest 1 次；const 回归副本：behind 2 > latest 1（已验证）。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentJournal } from "../../src/core/agent/journal.mjs";
import { INDEX_STRIDE } from "../../src/core/agent/journal-segments.mjs";

test("锚点之后存在健康事件时走增量重放，不退回全量", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-anchor-incr-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const journal = createAgentJournal({ projectRoot: root });
  await journal.load();
  // INDEX_STRIDE 整数倍：索引覆盖全部追加，readAfter 走 offsets 定位
  await journal.appendBatch(
    Array.from({ length: INDEX_STRIDE * 2 }, () => ({ type: "memory_file_restored", payload: { file: "worklog" } }))
  );
  const sessionPath = path.join(root, ".wwriting", "agent", "session.json");
  // 时序关键：最新锚点在 append 完成后读取
  const latestAnchor = await fs.readFile(sessionPath, "utf8");
  await journal.append({ type: "memory_file_restored", payload: { file: "book_summary" } });

  const anchorObj = JSON.parse(latestAnchor);
  anchorObj.last_seq = Number(anchorObj.last_seq) - 1;
  const oneEventBehind = JSON.stringify(anchorObj, null, 2) + String.fromCharCode(10);

  const segmentDir = path.join(root, ".wwriting", "agent", "segments", "events");
  const segmentFiles = (await fs.readdir(segmentDir)).filter((f) => f.endsWith(".jsonl"));
  const sizes = new Map();
  for (const file of segmentFiles) {
    sizes.set(path.join(segmentDir, file), (await fs.stat(path.join(segmentDir, file))).size);
  }

  // 全量重放的唯一签名是 eventsStore.streamAll（buildState 的回退分支专用）：
  // 按调用栈把全段读归因到 streamAll，对段索引陈旧性免疫——增量重放与全量回退
  // 在单段日志上的全段读取次数可能巧合相同，但 streamAll 只在全量重放时出现在
  // 读取栈里。锚点落后一条时 streamAll 的读取数必须为 0。
  async function countStreamAllFullReads(anchor) {
    await fs.writeFile(sessionPath, anchor);
    let streamAllFullReads = 0;
    const originalOpen = fs.open;
    fs.open = async (file, flags, ...rest) => {
      const handle = await originalOpen(file, flags, ...rest);
      const key = String(file);
      if (sizes.has(key) && flags === "r") {
        const originalRead = handle.read.bind(handle);
        handle.read = async (buffer, offset, length, position, ...rest2) => {
          if (position === 0 && length === sizes.get(key)) {
            const stack = new Error().stack ?? "";
            if (stack.includes("streamAll")) streamAllFullReads += 1;
          }
          return originalRead(buffer, offset, length, position, ...rest2);
        };
      }
      return handle;
    };
    try {
      await createAgentJournal({ projectRoot: root }).load();
    } finally {
      fs.open = originalOpen;
    }
    return streamAllFullReads;
  }

  const streamAllAtLatest = await countStreamAllFullReads(latestAnchor);
  const streamAllOneBehind = await countStreamAllFullReads(oneEventBehind);
  assert.equal(streamAllAtLatest, 0, "最新锚点（零尾事件）不得触发全量重放");
  assert.equal(
    streamAllOneBehind,
    0,
    "锚点只落后一条健康事件时必须走增量重放（streamAll 全段读取应为 0）——const 回归会使它回退全量"
  );
});
