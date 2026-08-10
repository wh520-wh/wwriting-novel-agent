// src/core/agent/journal-segments.mjs
//
// Journal 分段物理层（统一 Agent 内核计划 Task 4）。把 events/transcript 的单一
// 全读 JSONL 换成可轮转的 segment 文件 + 可重建的稀疏索引，让百万事件 journal
// 也能快速打开（Task 5 分页、Task 14 基准依赖本层；后续任务不重写它）。
//
// 磁盘布局（agentDir = storageRoot）：
//   segments/
//     events/      00000001.jsonl + 00000001.index.json + …（每个 stream 一个目录）
//     transcript/  00000001.jsonl + 00000001.index.json + …
//   journal-manifest.json  —— 可删除重建的派生数据（generation/roots/last seqs/gaps）
//   session.json           —— 可重建 projection（journal 负责，不在此层）
//   migration.json         —— journal 迁移标记
//   checkpoints/           —— 预留目录
//
// 不变量：
//   - 事件 JSONL 是真相；journal-manifest.json 与 .index.json 都是派生数据，
//     缺失/损坏时可从 segment 重建（load 时自动做）；
//   - 常量固定：SEGMENT_MAX_BYTES / SEGMENT_MAX_RECORDS / INDEX_STRIDE；
//   - 索引形状固定：{ schema_version, segment_id, start_seq, end_seq, event_count,
//     bytes, offsets: [{ seq, byte }], sealed }；offsets 落在 1, 1+stride, …；
//   - 活动 segment 每 indexStride 条事件或轮转时原子刷新索引；轮转前先 fsync
//     当前文件，再把索引标记 sealed:true，最后创建下一段；
//   - 常规读取（readTail/readBefore/readAfter）只按索引做有界字节读取，绝不整段
//     全读；readFile seam 只用于一次性 legacy 导入（注入后任何常规读取经过它都会
//     被测试立刻发现）；
//   - 中间坏段不能静默跳过：load 重建索引发现非法行时把整段改名为 .corrupt 并在
//     manifest 记录 gap（start_seq/end_seq/reason），历史 API 返回 gap 信息；
//     最后一个 segment 的尾部半行（崩溃痕迹）自动截断；
//   - 旧单体 events.jsonl/transcript.jsonl 一次性迁移：导入后原文件改名为
//     *.legacy.jsonl，幂等（store 已有记录且不落后时只改名不重复导入）。
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, pathExists, writeFileAtomic } from "../fs-utils.mjs";

export const SEGMENT_MAX_BYTES = 16 * 1024 * 1024;
export const SEGMENT_MAX_RECORDS = 25_000;
export const INDEX_STRIDE = 256;

export const SEGMENT_RE = /^(\d{8})\.jsonl$/u;

function segmentName(id) {
  return `${String(id).padStart(8, "0")}.jsonl`;
}

function indexName(id) {
  return `${String(id).padStart(8, "0")}.index.json`;
}

function fail(message) {
  throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultManifest(generationId) {
  return {
    schema_version: 1,
    generation_id: generationId ?? randomUUID(),
    events_root: "segments/events",
    transcript_root: "segments/transcript",
    last_event_seq: 0,
    last_transcript_seq: 0,
    gaps: [],
    generations: []
  };
}

// 把 Buffer 按 \n 拆成 { text, startByte, hasNewline }（字节级，UTF-8 断点仍精确）。
function splitBufferLines(buffer) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0x0a) {
      lines.push({ text: buffer.toString("utf8", start, i), startByte: start, hasNewline: true });
      start = i + 1;
    }
  }
  if (start < buffer.length) {
    lines.push({ text: buffer.toString("utf8", start), startByte: start, hasNewline: false });
  }
  return lines;
}

// 解析一段完整行数据；非末尾非法行视为损坏。返回 { records }，损坏时抛错。
function parseJsonLines(buffer) {
  const lines = splitBufferLines(buffer);
  const records = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.text.trim() === "") continue;
    try {
      records.push(JSON.parse(line.text));
    } catch {
      // 末尾无换行的半行 = 崩溃痕迹（load 已截断；防御性容忍）；
      // 其余非法行 = 段损坏，必须抛错而非猜测跳过。
      if (i === lines.length - 1 && !line.hasNewline) break;
      throw new Error(`segment 第 ${i + 1} 行不是合法 JSON（段损坏）`);
    }
  }
  return { records };
}

// ---------------------------------------------------------------------------
// createJournalSegmentStore：单 stream 的分段存储
// ---------------------------------------------------------------------------

export function createJournalSegmentStore({
  root,
  streamName = "events",
  maxSegmentRecords = SEGMENT_MAX_RECORDS,
  maxSegmentBytes = SEGMENT_MAX_BYTES,
  indexStride = INDEX_STRIDE,
  readFile = fs.readFile, // 全文件读取 seam：只用于 legacy 导入；常规读取不经过它
  generationId = null,
  manifestPath = null, // 默认 <agentDir>/journal-manifest.json
  rebuildDelayMs = 0 // 测试 seam：模拟慢速后台索引重建（默认 0）
} = {}) {
  if (typeof root !== "string" || root.length === 0) fail("root 必须是 segment 目录");
  if (streamName !== "events" && streamName !== "transcript") fail(`streamName 必须是 events|transcript：${String(streamName)}`);
  const resolvedRoot = path.resolve(root);
  const manifestFile = manifestPath ?? path.join(path.dirname(resolvedRoot), "journal-manifest.json");
  const seqField = streamName === "transcript" ? "transcript_seq" : "seq";

  let segments = []; // [{ id, path, indexPath, index, startSeq, endSeq, count, bytes, offsets, fd }]
  let activeSegment = null;
  let lastSeq = 0;
  let manifest = null;
  let gaps = []; // 只含本 stream 的缺口（manifest 按 stream 命名空间隔离）
  let loadedFlag = false;

  async function readManifestFile() {
    try {
      const raw = await fs.readFile(manifestFile, "utf8");
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async function ensureManifest() {
    if (manifest) return manifest;
    const existing = await readManifestFile();
    if (existing && typeof existing.generation_id === "string") {
      manifest = existing;
      return manifest;
    }
    manifest = defaultManifest(generationId);
    await writeFileAtomic(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  }

  // manifest 是共享派生数据（events/transcript 两流共用同一文件）：读-改-写合并。
  async function updateManifest(mutator) {
    const current = (await readManifestFile()) ?? manifest ?? (await ensureManifest());
    const next = { ...current, ...mutator(current) };
    manifest = next;
    await writeFileAtomic(manifestFile, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  // 返回只含本 stream 的缺口（去掉 manifest 内的 stream 命名空间字段）。
  function visibleGaps() {
    return gaps.map(({ stream: _stream, ...rest }) => rest);
  }

  function isGapSegment(segment) {
    return gaps.some(
      (gap) => segment.startSeq >= gap.start_seq && segment.endSeq <= gap.end_seq
    );
  }

  // 坏段的名义范围。健康后继存在时精确取 [prev.end+1, next.start-1]——绝不吞并
  // 字节有效的后继段（旧实现对非满坏段按 maxSegmentRecords 外推，会把落在该窗口内
  // 的健康段整段标记为 gap）；后继元数据未知（也是坏段/未建索引）或坏段即最新段时，
  // 按已解析记录数取保守下界（坏行之后的记录不可信）。
  function buildGapRange(segment, parsedCount) {
    const idx = segments.findIndex((s) => s.id === segment.id);
    const prev = idx > 0 ? segments[idx - 1] : null;
    const next = idx >= 0 && idx < segments.length - 1 ? segments[idx + 1] : null;
    const startSeq = prev ? prev.endSeq + 1 : 1;
    const endSeq =
      next && Number.isInteger(next.startSeq)
        ? next.startSeq - 1
        : startSeq + Math.max(0, parsedCount - 1);
    return { start_seq: startSeq, end_seq: endSeq };
  }

  async function isolateSegment(segment, gap) {
    await segment.fd?.close().catch(() => {});
    await fs.rename(segment.path, `${segment.path}.corrupt`).catch(() => {});
    await fs.rename(segment.indexPath, `${segment.indexPath}.corrupt`).catch(() => {});
    segments = segments.filter((s) => s.id !== segment.id);
    if (activeSegment?.id === segment.id) activeSegment = null;
    const next = await updateManifest((current) => ({
      gaps: [...(current.gaps ?? []), gap]
    }));
    gaps = next.gaps.filter((g) => g.stream === streamName);
    return gap;
  }

  function buildIndex(segment, { sealed }) {
    return {
      schema_version: 1,
      segment_id: segment.id,
      start_seq: segment.startSeq,
      end_seq: segment.endSeq,
      event_count: segment.count,
      bytes: segment.bytes,
      offsets: segment.offsets,
      sealed
    };
  }

  async function writeIndex(segment, { sealed }) {
    segment.index = buildIndex(segment, { sealed });
    await writeFileAtomic(segment.indexPath, `${JSON.stringify(segment.index, null, 2)}\n`);
  }

  async function readIndex(segment) {
    try {
      const raw = await fs.readFile(segment.indexPath, "utf8");
      const index = JSON.parse(raw);
      if (index?.schema_version !== 1 || index?.segment_id !== segment.id) return null;
      if (!Array.isArray(index.offsets)) return null;
      return index;
    } catch {
      return null;
    }
  }

  // 扫描一个 segment（≤16MB 有界）：解析行、构建 offsets、检测损坏。不写索引。
  // 返回 { corrupt: true, parsedCount }（坏段）/ { empty: true }（空文件）/ {}（成功，
  // 且把 startSeq/endSeq/count/bytes/offsets 写入 segment）。
  async function scanSegment(segment) {
    const buffer = await fs.readFile(segment.path);
    const lines = splitBufferLines(buffer);
    const offsets = [];
    let byte = 0;
    let count = 0;
    let firstSeq = null;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.text.trim() === "") continue;
      let record;
      try {
        record = JSON.parse(line.text);
      } catch {
        if (i === lines.length - 1 && !line.hasNewline) break; // 尾部半行（load 已截断）
        return { corrupt: true, parsedCount: count };
      }
      if (count === 0) firstSeq = record[seqField];
      if (count % indexStride === 0) offsets.push({ seq: record[seqField], byte });
      byte += Buffer.byteLength(line.text, "utf8") + 1;
      count += 1;
    }
    if (count === 0) return { empty: true };
    segment.startSeq = firstSeq;
    segment.endSeq = firstSeq + count - 1;
    segment.count = count;
    segment.bytes = byte;
    segment.offsets = offsets;
    return {};
  }

  // 重建索引 = 扫描 + 原子写索引。遇到非法行返回 gap 信号由调用方隔离。
  async function rebuildIndex(segment) {
    const outcome = await scanSegment(segment);
    if (outcome.corrupt || outcome.empty) return outcome;
    await writeIndex(segment, { sealed: false });
    return {};
  }

  // 坏段信号：读路径在懒扫描（background 模式）发现损坏时隔离并抛出，由 journal
  // 识别后走缺口恢复；inline 模式下 load 已隔离，读路径不会遇到。
  function segmentGapError() {
    const error = new Error("segment 损坏已隔离为缺口（SEGMENT_GAP）");
    error.code = "SEGMENT_GAP";
    return error;
  }

  // 懒元数据：background 模式下未重建的段在首次读取时扫描（memoized）。发现损坏时
  // 隔离 + 记录 gap + 抛 SEGMENT_GAP（调用方决定降级路径）。
  async function ensureSegmentMetadata(segment) {
    if (Number.isInteger(segment.count)) return;
    const outcome = await scanSegment(segment);
    if (outcome.corrupt) {
      await isolateSegment(segment, {
        ...buildGapRange(segment, outcome.parsedCount),
        reason: "segment_corrupt",
        stream: streamName
      });
      throw segmentGapError();
    }
    if (outcome.empty) {
      await fs.rm(segment.path, { force: true });
      await fs.rm(segment.indexPath, { force: true });
      segments = segments.filter((s) => s.id !== segment.id);
      if (activeSegment?.id === segment.id) activeSegment = null;
    }
  }

  // 只检查最新 segment 尾部：末尾半行（崩溃痕迹）自动截断，随后索引失效 → 重建。
  async function truncateTrailingPartial(segment) {
    let handle = null;
    try {
      handle = await fs.open(segment.path, "r");
      const stat = await handle.stat();
      if (stat.size === 0) return;
      const tailSize = Math.min(stat.size, 64 * 1024);
      const tail = Buffer.alloc(tailSize);
      await handle.read(tail, 0, tailSize, stat.size - tailSize);
      if (tail[tail.length - 1] === 0x0a) return; // 以换行结束：无半行
      // 从尾部向前找最后一个完整行边界；只保留到最后一个 '\n' 之后
      let lastNewline = -1;
      for (let i = tail.length - 1; i >= 0; i -= 1) {
        if (tail[i] === 0x0a) {
          lastNewline = i;
          break;
        }
      }
      const truncateAt = stat.size - tail.length + lastNewline + 1;
      if (truncateAt === stat.size) return;
      await handle.close();
      handle = null;
      await fs.truncate(segment.path, truncateAt);
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  // 活动段索引可能落后于实际文件（索引在 stride 点写入）：从最后一个 offset 起
  // 读到 EOF 校正 count/endSeq/bytes（有界读取：至多 stride + 尾部记录）。
  // 返回 true 表示索引已失效（offset 越过文件尾），需要重建；返回
  // { corrupt: true } 表示索引之后的尾部出现非法行（I3 修复：视为段损坏，调用方
  // 走隔离路径——绝不让 load 因单个坏行拒绝打开工作区）。
  async function refreshActiveTail(segment) {
    const offsets = segment.offsets ?? [];
    const lastOffset = offsets.at(-1);
    if (!lastOffset) return false;
    const handle = await fs.open(segment.path, "r");
    try {
      const stat = await handle.stat();
      if (lastOffset.byte > stat.size) return true; // 截短后 offset 失效
      const chunk = Buffer.alloc(stat.size - lastOffset.byte);
      await handle.read(chunk, 0, chunk.length, lastOffset.byte);
      let records;
      try {
        ({ records } = parseJsonLines(chunk));
      } catch {
        return { corrupt: true };
      }
      segment.count = (offsets.length - 1) * indexStride + records.length;
      segment.endSeq = segment.startSeq + segment.count - 1;
      segment.bytes = lastOffset.byte + chunk.length;
      return false;
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async function loadIfNeeded() {
    if (!loadedFlag) await load();
  }

  // 后台索引重建：为所有未建索引（缺/坏）的段补写索引，AbortSignal 可在段间中断。
  // 发现坏段时隔离并记录 gap。供 background 模式的 detached 后台任务调用。
  async function rebuildMissingIndexes({ signal } = {}) {
    let rebuilt = 0;
    for (const segment of [...segments]) {
      if (signal?.aborted) break;
      if (segment.index) continue; // 已有索引（懒扫描只填元数据，不算已建索引）
      if (rebuildDelayMs > 0) await sleep(rebuildDelayMs);
      const outcome = await scanSegment(segment);
      if (outcome.corrupt) {
        await isolateSegment(segment, {
          ...buildGapRange(segment, outcome.parsedCount),
          reason: "segment_corrupt",
          stream: streamName
        });
      } else if (outcome.empty) {
        await fs.rm(segment.path, { force: true });
        await fs.rm(segment.indexPath, { force: true });
        segments = segments.filter((s) => s.id !== segment.id);
        if (activeSegment?.id === segment.id) activeSegment = null;
      } else {
        await writeIndex(segment, { sealed: false });
        rebuilt += 1;
      }
    }
    if (segments.length > 0) lastSeq = segments.at(-1).endSeq;
    return { rebuilt, gaps: visibleGaps() };
  }

  async function load({ signal, rebuildMode = "inline" } = {}) {
    // 重复 load（如迁移后刷新）先关闭上一个活动段句柄，防止 fd 泄漏与
    // Windows 下目录 rename 因占用文件失败
    if (activeSegment?.fd) {
      await activeSegment.fd.close().catch(() => {});
      activeSegment.fd = null;
    }
    await ensureDir(resolvedRoot);
    await ensureManifest();
    gaps = (manifest.gaps ?? []).filter((g) => g.stream === streamName);
    // 1. 列出 segment 文件（.corrupt 不匹配 SEGMENT_RE，天然被排除）
    const names = (await fs.readdir(resolvedRoot)).filter((name) => SEGMENT_RE.test(name)).sort();
    segments = names.map((name) => ({
      id: Number(name.slice(0, 8)),
      path: path.join(resolvedRoot, name),
      indexPath: path.join(resolvedRoot, indexName(Number(name.slice(0, 8))))
    }));
    // 2. 只检查最新 segment 尾部（截断半行）
    if (segments.length > 0 && !signal?.aborted) {
      await truncateTrailingPartial(segments.at(-1));
    }
    // 3. pass 1：读取全部已有索引。隔离决策需要后继段元数据，坏段必须等所有健康段
    // 元数据就绪后再隔离（两遍），否则 gap 范围会误吞健康后继。
    const deferred = []; // 索引缺失/损坏的段
    for (const segment of segments) {
      if (signal?.aborted) break;
      const index = await readIndex(segment);
      if (index) {
        segment.index = index;
        segment.startSeq = index.start_seq;
        segment.endSeq = index.end_seq;
        segment.count = index.event_count;
        segment.bytes = index.bytes;
        segment.offsets = index.offsets;
      } else {
        deferred.push(segment);
      }
    }
    // 3. pass 2：处理缺失/损坏索引的段（inline 全量扫描；background 只扫最新段，
    // 其余段懒扫描——load 立即返回，索引重建作为 AbortSignal 保护的后台任务继续）
    const corrupt = [];
    const empties = [];
    for (const segment of deferred) {
      if (signal?.aborted) break;
      if (rebuildMode === "background" && segment.id !== segments.at(-1)?.id) continue;
      const outcome = await scanSegment(segment);
      if (outcome.corrupt) {
        corrupt.push({ segment, parsedCount: outcome.parsedCount });
      } else if (outcome.empty) {
        empties.push(segment);
      } else if (rebuildMode === "inline") {
        await writeIndex(segment, { sealed: false });
      }
    }
    for (const segment of empties) {
      // 空 segment（轮转后未写入即崩溃）：删除空文件与残留索引
      await fs.rm(segment.path, { force: true });
      await fs.rm(segment.indexPath, { force: true });
      segments = segments.filter((s) => s.id !== segment.id);
    }
    // 3c. 隔离坏段（此刻所有健康段元数据已知，gap 范围精确）
    for (const { segment, parsedCount } of corrupt) {
      if (signal?.aborted) break;
      await isolateSegment(segment, {
        ...buildGapRange(segment, parsedCount),
        reason: "segment_corrupt",
        stream: streamName
      });
    }
    // 3d. 活动段索引可能落后于实际文件：从最后一个 offset 校正（有界读取）
    if (rebuildMode === "inline" && segments.length > 0 && !signal?.aborted) {
      const newest = segments.at(-1);
      if (newest.index) {
        const tail = await refreshActiveTail(newest);
        if (tail === true || tail?.corrupt === true) {
          // 索引失效（截短）或索引之后的尾部损坏：全量扫描重建/隔离。
          const outcome = await rebuildIndex(newest);
          if (outcome.corrupt) {
            await isolateSegment(newest, {
              ...buildGapRange(newest, outcome.parsedCount),
              reason: "segment_corrupt",
              stream: streamName
            });
          } else if (outcome.empty) {
            await fs.rm(newest.path, { force: true });
            await fs.rm(newest.indexPath, { force: true });
            segments = segments.filter((s) => s.id !== newest.id);
          }
        }
      }
    }
    // 4. 打开活动段句柄（轮转/fsync 用）
    for (const segment of segments) {
      segment.fd = null;
    }
    if (segments.length > 0) {
      activeSegment = segments.at(-1);
      activeSegment.fd = await fs.open(activeSegment.path, "a");
    } else {
      activeSegment = null;
    }
    lastSeq = segments.length > 0 ? segments.at(-1).endSeq : 0;
    // 5. 刷新 manifest 的 last seqs（派生数据，可能落后于 append）
    await updateManifest((current) =>
      streamName === "events" ? { last_event_seq: lastSeq } : { last_transcript_seq: lastSeq }
    );
    loadedFlag = true;
    // background 模式：索引重建作为受 AbortSignal 保护的后台任务继续（detached）。
    let rebuilding = null;
    if (rebuildMode === "background" && !signal?.aborted) {
      rebuilding = rebuildMissingIndexes({ signal });
      rebuilding.catch(() => {});
    }
    return {
      segments: segments.map((s) => ({
        id: s.id,
        start_seq: s.startSeq,
        end_seq: s.endSeq,
        count: s.count,
        bytes: s.bytes,
        sealed: s.index?.sealed ?? false
      })),
      gaps: visibleGaps(),
      last_seq: lastSeq,
      rebuilding
    };
  }

  async function rotate() {
    if (activeSegment) {
      const old = activeSegment;
      // 轮转前先 fsync 当前文件。句柄通常已随上次 append 关闭（Windows rename
      // 兼容，见 append）：关闭后重新打开做 fsync，保持"sealed 段落盘"的持久性
      // 语义不因句柄策略改变而弱化。
      //
      // 重开必须用可写句柄（"r+"）：Windows 上只读句柄（"r"）调用 fsync 抛
      // EPERM（本机实测）。"r+" 不改变文件内容/追加位置语义，且要求文件已存在
      //（轮转对象必然是已写过的活动段，天然满足）。
      if (old.fd) {
        await old.fd.sync();
        await old.fd.close();
      } else {
        const syncFd = await fs.open(old.path, "r+");
        try {
          await syncFd.sync();
        } finally {
          await syncFd.close();
        }
      }
      old.fd = null;
      // 把索引标记 sealed:true（原子写）
      await writeIndex(old, { sealed: true });
    }
    const nextId = (activeSegment?.id ?? 0) + 1;
    // 注意：批次内 lastSeq 尚未更新，新段的 start_seq 必须从当前活动段的 endSeq 推导
    const nextStartSeq = (activeSegment?.endSeq ?? lastSeq) + 1;
    const segPath = path.join(resolvedRoot, segmentName(nextId));
    const fd = await fs.open(segPath, "a");
    activeSegment = {
      id: nextId,
      path: segPath,
      indexPath: path.join(resolvedRoot, indexName(nextId)),
      fd,
      count: 0,
      bytes: 0,
      startSeq: nextStartSeq,
      endSeq: nextStartSeq - 1,
      offsets: [],
      index: null
    };
    segments.push(activeSegment);
  }

  async function append(records) {
    if (!Array.isArray(records) || records.length === 0) return;
    await loadIfNeeded();
    let expected = lastSeq + 1;
    const stamped = [];
    for (const record of records) {
      if (record == null || typeof record !== "object" || Array.isArray(record)) {
        fail(`${streamName} 记录必须是对象`);
      }
      const seq = record[seqField];
      if (!Number.isInteger(seq)) fail(`${streamName} 记录必须携带整数 ${seqField}`);
      if (seq !== expected) fail(`${streamName} seq 缺口：应为 ${expected}，实际 ${String(seq)}`);
      stamped.push({ line: `${JSON.stringify(record)}\n`, seq });
      expected += 1;
    }
    // 逐条追加；超限（记录数/字节数）先轮转：fsync 当前文件 → 索引 sealed:true → 创建下一段
    for (const { line, seq } of stamped) {
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (
        activeSegment == null ||
        activeSegment.count >= maxSegmentRecords ||
        activeSegment.bytes + lineBytes > maxSegmentBytes
      ) {
        await rotate();
      }
      if (activeSegment.count % indexStride === 0) {
        activeSegment.offsets.push({ seq, byte: activeSegment.bytes });
      }
      if (activeSegment.fd == null) {
        // 句柄已在批次结束后关闭（见下）：下次 append 按需重开
        activeSegment.fd = await fs.open(activeSegment.path, "a");
      }
      await activeSegment.fd.write(line, "utf8");
      activeSegment.count += 1;
      activeSegment.bytes += lineBytes;
      activeSegment.endSeq = seq;
      // 活动段每 indexStride 条事件原子刷新索引
      if (activeSegment.count % indexStride === 0) {
        await writeIndex(activeSegment, { sealed: false });
      }
    }
    lastSeq = expected - 1;
    // manifest 的 last seqs 是派生数据，但保持新鲜（append 后原子刷新，read-modify-write）
    await updateManifest((current) =>
      streamName === "events" ? { last_event_seq: lastSeq } : { last_transcript_seq: lastSeq }
    );
    // Windows：目录 rename（Task 3 会话迁移的 moveSessionEntries、clear-history 轮转）
    // 在目录内存在打开句柄时会 EPERM。批次写完即关闭活动段句柄——下次 append 按需
    // 重开（见上），本 store 不再长期占用段文件，含段目录的 rename 不再被阻塞。
    if (activeSegment?.fd) {
      await activeSegment.fd.close().catch(() => {});
      activeSegment.fd = null;
    }
  }

  // 最近字节偏移：index 中最后一个 offset.seq <= target 的 byte；无索引 → 0。
  function byteOffsetFor(segment, targetSeq) {
    const offsets = segment.offsets ?? segment.index?.offsets ?? [];
    let byte = 0;
    for (const offset of offsets) {
      if (offset.seq > targetSeq) break;
      byte = offset.byte;
    }
    return byte;
  }

  // 读取 [fromByte, toByte] 并解析为记录数组。非法行（非尾部半行）表示段损坏：
  // I3 修复——索引有效但内容位腐的 sealed 段在这里被懒隔离（重命名 .corrupt +
  // manifest 记录 gap），并抛结构化 SEGMENT_GAP 交给 journal 走缺口恢复/重试读取，
  // 绝不把原始"段损坏"错误抛给上层阻塞工作区打开。
  async function readSegmentChunk(segment, fromByte, toByte = null) {
    const handle = await fs.open(segment.path, "r");
    let handleClosed = false;
    try {
      const stat = await handle.stat();
      if (stat.isDirectory()) {
        // 段文件被同名目录替换（外部破坏/占用）：与旧 fs.readFile 语义一致的 EISDIR
        const error = new Error("EISDIR: illegal operation on a directory, read");
        error.code = "EISDIR";
        error.syscall = "read";
        throw error;
      }
      const start = Math.max(0, fromByte);
      const end = toByte == null ? stat.size : Math.min(stat.size, toByte);
      if (end <= start) return [];
      const buffer = Buffer.alloc(end - start);
      await handle.read(buffer, 0, buffer.length, start);
      let records;
      try {
        ({ records } = parseJsonLines(buffer));
      } catch {
        // 先关闭句柄再隔离（Windows 下 rename 需要句柄释放）。
        await handle.close().catch(() => {});
        handleClosed = true;
        const outcome = await scanSegment(segment);
        const parsedCount =
          outcome?.corrupt === true ? outcome.parsedCount : Number.isInteger(segment.count) ? segment.count : 0;
        await isolateSegment(segment, {
          ...buildGapRange(segment, parsedCount),
          reason: "segment_corrupt",
          stream: streamName
        });
        throw segmentGapError();
      }
      return records;
    } finally {
      if (!handleClosed) await handle.close().catch(() => {});
    }
  }

  async function readTail({ limit, signal } = {}) {
    await loadIfNeeded();
    const events = [];
    let remaining = limit == null ? Infinity : limit;
    for (let i = segments.length - 1; i >= 0 && remaining > 0; i -= 1) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const segment = segments[i];
      if (isGapSegment(segment)) continue; // 坏段已在 manifest 记录，跳过
      await ensureSegmentMetadata(segment); // background 模式下懒扫描未建索引的段
      const want = Math.min(remaining, segment.count);
      if (want <= 0) continue;
      const startSeq = segment.endSeq - want + 1;
      const fromByte = byteOffsetFor(segment, startSeq);
      const records = await readSegmentChunk(segment, fromByte, null);
      const taken = records
        .filter((record) => record[seqField] >= startSeq && record[seqField] <= segment.endSeq)
        .slice(-want);
      events.unshift(...taken);
      remaining -= taken.length;
    }
    return { events, gaps: visibleGaps() };
  }

  async function readBefore({ beforeSeq, limit, signal } = {}) {
    await loadIfNeeded();
    const events = [];
    let remaining = limit == null ? Infinity : limit;
    const targetEnd = beforeSeq - 1;
    for (let i = segments.length - 1; i >= 0 && remaining > 0; i -= 1) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const segment = segments[i];
      if (isGapSegment(segment)) continue;
      await ensureSegmentMetadata(segment);
      if (segment.startSeq > targetEnd) continue; // 该段整体在目标之后
      const available = Math.max(0, Math.min(segment.count, targetEnd - segment.startSeq + 1));
      const take = Math.min(remaining, available);
      if (take <= 0) continue;
      const lastRecordSeq = Math.min(segment.endSeq, targetEnd);
      const startSeq = lastRecordSeq - take + 1;
      const fromByte = byteOffsetFor(segment, startSeq);
      const records = await readSegmentChunk(segment, fromByte, null);
      const taken = records
        .filter((record) => record[seqField] >= startSeq && record[seqField] <= targetEnd)
        .slice(-take);
      events.unshift(...taken);
      remaining -= taken.length;
    }
    return { events, gaps: visibleGaps() };
  }

  async function readAfter({ afterSeq = 0, limit, signal } = {}) {
    await loadIfNeeded();
    const events = [];
    let remaining = limit == null ? Infinity : limit;
    const targetStart = afterSeq + 1;
    for (let i = 0; i < segments.length && remaining > 0; i += 1) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const segment = segments[i];
      if (isGapSegment(segment)) continue;
      await ensureSegmentMetadata(segment);
      if (segment.endSeq < targetStart) continue;
      const skip = Math.max(0, targetStart - segment.startSeq);
      const take = Math.min(remaining, segment.count - skip);
      if (take <= 0) continue;
      const startSeq = segment.startSeq + skip;
      const fromByte = byteOffsetFor(segment, startSeq);
      const records = await readSegmentChunk(segment, fromByte, null);
      const taken = records.filter((record) => record[seqField] >= startSeq).slice(0, take);
      events.push(...taken);
      remaining -= taken.length;
    }
    return { events, gaps: visibleGaps() };
  }

  // 顺序流式导出（Task 5 export 复用）：按序 yield 健康段的记录。
  // 调用方必须先处理 manifest 中的 gaps（坏段不在此迭代里 yield）。
  async function* streamAll({ signal } = {}) {
    await loadIfNeeded();
    for (const segment of segments) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      if (isGapSegment(segment)) continue;
      await ensureSegmentMetadata(segment);
      const records = await readSegmentChunk(segment, 0, null);
      for (const record of records) yield record;
    }
  }

  // 一次性 legacy 导入：events.jsonl / transcript.jsonl → segments，原文件改名
  // *.legacy.jsonl。幂等：store 已有记录且不落后于 legacy 时只改名不重复导入。
  async function importLegacy({ filePath, kind, signal } = {}) {
    if (kind !== "events" && kind !== "transcript") {
      fail(`importLegacy kind 必须是 events|transcript：${String(kind)}`);
    }
    await loadIfNeeded();
    const buffer = await readFile(filePath); // 全文件读取 seam（仅此路径使用）
    const lines = splitBufferLines(buffer);
    const records = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const line = lines[i];
      if (line.text.trim() === "") continue;
      try {
        records.push(JSON.parse(line.text));
      } catch {
        // 最后一行无法解析 = 崩溃痕迹（与旧 readEventsFile 的尾部截断语义一致：
        // 无论是否带尾随换行都丢弃该行）；其余非法行 = 中间损坏，必须拒绝。
        if (i === lines.length - 1) break;
        throw new Error(`legacy ${path.basename(filePath)} 第 ${i + 1} 行不是合法 JSON（日志损坏，存在中间缺口）`);
      }
    }
    if (kind === "events") {
      for (let i = 0; i < records.length; i += 1) {
        if (records[i].seq !== i + 1) {
          throw new Error(`events.jsonl 存在 seq 缺口：第 ${i + 1} 条应为 ${i + 1}，实际 ${String(records[i].seq)}`);
        }
      }
    } else {
      records.forEach((record, i) => {
        record.transcript_seq = i + 1;
      });
    }
    const legacyMax = kind === "events" ? (records.at(-1)?.seq ?? 0) : records.length;
    if (lastSeq >= legacyMax) {
      // 已迁移：只改名，不重复导入
      await renameLegacy(filePath);
      return records.length;
    }
    if (lastSeq > 0) {
      throw new Error(`legacy ${path.basename(filePath)} 与现有 segments 不一致（last=${lastSeq}，legacy 最大=${legacyMax}）`);
    }
    await append(records);
    await renameLegacy(filePath);
    return records.length;
  }

  async function renameLegacy(filePath) {
    const target = path.join(
      path.dirname(filePath),
      path.basename(filePath).replace(/\.jsonl$/u, ".legacy.jsonl")
    );
    if (await pathExists(target)) await fs.rm(target, { force: true });
    await fs.rename(filePath, target);
  }

  // generation 轮转 hook（Task 5 clear-history 使用；本任务只要求 hook 与 manifest
  // 字段存在）。把当前 segments 目录移动到 historyDir 下（保留可读历史），manifest
  // 记录旧 generation 的位置与可读范围，随后重置为新 generation（新 segments 从空
  // 开始、不复用旧 seq/事件 id）。
  //
  // oldGenerationId：events/transcript 两流共享同一个 manifest 文件，clear-history
  // 需要把两流的旧数据归属到同一个旧 generation id。第二次轮转若不固定该 id，
  // 会读到第一次轮转刚写入的新 generation id，把 transcript 历史误记到不存在的
  // 新 generation 名下。Task 5 调用方（journal.clearHistory）先取 manifest 的当前
  // generation_id 再传给两次轮转；缺省（不传）时保持旧行为（用 manifest 当前 id）。
  async function startGeneration({ historyDir, reason = "user_clear", oldGenerationId = null } = {}) {
    await loadIfNeeded();
    const current = manifest ?? (await ensureManifest());
    const oldId = oldGenerationId ?? current.generation_id;
    const dirName = `${oldId}-${streamName}`;
    const target = path.join(historyDir, dirName);
    await ensureDir(path.dirname(target));
    if (activeSegment?.fd) {
      await activeSegment.fd.sync().catch(() => {});
      await activeSegment.fd.close().catch(() => {});
      activeSegment.fd = null;
    }
    if (segments.length > 0) {
      await fs.rename(resolvedRoot, target);
    } else {
      await ensureDir(target);
    }
    const next = await updateManifest((cur) => ({
      generation_id: randomUUID(),
      gaps: [],
      generations: [
        ...(cur.generations ?? []),
        {
          generation_id: oldId,
          path: path.relative(path.dirname(manifestFile), target) || dirName,
          stream: streamName,
          start_seq: 1,
          end_seq: lastSeq,
          reason,
          moved_at: new Date().toISOString()
        }
      ]
    }));
    // 重置本 store 为新 generation
    segments = [];
    activeSegment = null;
    lastSeq = 0;
    gaps = [];
    loadedFlag = false;
    await load();
    return { generation_id: manifest.generation_id, old_generation_id: oldId, moved_to: target };
  }

  // generation 轮转回滚（Task 5 clearHistory 故障恢复）：把 fromDir 下已移走的旧
  // segments 目录移回原位置，移除本流在 manifest 中的轮转记录并恢复旧
  // generation_id（双流共享 manifest，两次 restore 写同一 oldId，幂等），重置
  // store 内存状态并重新加载。未实际轮转过的流调用它只做 manifest 对齐 + 重载。
  // 返回 { restored, generation_id }。
  async function restoreGeneration({ fromDir, generationId = null } = {}) {
    await loadIfNeeded();
    const current = manifest ?? (await ensureManifest());
    const oldId = generationId ?? current.generation_id;
    const dirName = `${oldId}-${streamName}`;
    const source = path.join(fromDir, dirName);
    if (await pathExists(source)) {
      if (activeSegment?.fd) {
        await activeSegment.fd.sync().catch(() => {});
        await activeSegment.fd.close().catch(() => {});
        activeSegment.fd = null;
      }
      if (!(await pathExists(resolvedRoot))) {
        await fs.rename(source, resolvedRoot);
      } else {
        // 两种可能：目标目录从未真正移动（rename 失败前 ensureDir 只创建了空目录），
        // 或 startGeneration 成功后的 load() 已把原目录重建为空壳——都只移走空目录，
        // 绝不覆盖可能存在的真实数据。
        const rootEntries = await fs.readdir(resolvedRoot).catch(() => []);
        if (rootEntries.length === 0) {
          await fs.rm(resolvedRoot, { recursive: true, force: true });
          await fs.rename(source, resolvedRoot);
        } else {
          // 异常现场（目标非空）：保留源目录不删，仅告警——不猜测销毁数据。
          console.warn(`[journal-segments] restoreGeneration 无法移回 ${source}：目标 ${resolvedRoot} 非空`);
        }
      }
    }
    await updateManifest((cur) => ({
      generation_id: oldId,
      generations: (cur.generations ?? []).filter((g) => !(g.stream === streamName && g.generation_id === oldId))
    }));
    segments = [];
    activeSegment = null;
    lastSeq = 0;
    gaps = [];
    loadedFlag = false;
    await load();
    return { restored: true, generation_id: oldId };
  }

  return {
    load,
    append,
    readTail,
    readBefore,
    readAfter,
    streamAll,
    importLegacy,
    startGeneration,
    restoreGeneration,
    rebuildMissingIndexes,
    get manifest() {
      return manifest;
    },
    get gaps() {
      // 只暴露本 stream 的缺口（manifest 按 stream 命名空间隔离）
      return visibleGaps();
    },
    get lastSeq() {
      return lastSeq;
    },
    get loaded() {
      return loadedFlag;
    }
  };
}
