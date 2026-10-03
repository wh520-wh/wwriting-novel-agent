import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { pathExists, safeJoin } from "./fs-utils.mjs";

// 项目领域审计日志（run_log.jsonl）：只记录章节提交、蓝图提交、导出、资料写入等
// 项目领域事实。统一 Agent 内核计划 Rule 9：不再订阅全局 event-bus，也不向
// run-events-bus 广播——ProjectAgent journal（/api/agent/snapshot + /api/project/
// events）是唯一的运行时 SSE 事件源，本模块不再是第二任务状态。
export async function appendEvent(projectRoot, event) {
  const entry = {
    event_id: randomUUID(),
    timestamp: new Date().toISOString(),
    project_id: event.project_id ?? null,
    chapter_no: event.chapter_no ?? null,
    stage: event.stage ?? null,
    severity: event.severity ?? "info",
    message: event.message ?? "",
    data: event.data ?? {},
    type: event.type
  };
  await fs.appendFile(safeJoin(projectRoot, "run_log.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

export async function readEvents(projectRoot, options = {}) {
  const logPath = safeJoin(projectRoot, "run_log.jsonl");
  if (!(await pathExists(logPath))) {
    return [];
  }

  let skipped_tail = 0;   // 文件末尾未终结行：写入中断的容忍场景
  let skipped_middle = 0; // 中间行损坏：真实数据丢失，必须落审计事件

  // isTail：该行是否为文件末尾的未终结行（无换行结尾时的最后一行）。
  function tryParse(line, isTail = false) {
    try {
      return JSON.parse(line);
    } catch {
      if (isTail) skipped_tail++;
      else skipped_middle++;
      return null;
    }
  }

  // 损坏上报：中间行 skipped>0 时把事件落进 run_log.jsonl 自身（审计可发现）。
  // 只上报、不修复；追加失败不影响读取。
  async function reportCorruption() {
    if (skipped_middle === 0) return;
    try {
      await appendEvent(projectRoot, {
        type: "event_log_corruption",
        severity: "warning",
        message: `run_log.jsonl 中间行损坏 ${skipped_middle} 行（非尾部写入中断），读取时已跳过`,
        data: { skipped_middle, skipped_tail }
      });
    } catch {
      // 审计文件自身不可写时静默（console.warn 仍在下方保留）
    }
  }

  // No limit = full read (backward compatible)
  if (!options.limit) {
    const content = await fs.readFile(logPath, "utf8");
    const lines = content.split(/\r?\n/u).filter(Boolean);
    const endsWithNewline = content.endsWith("\n");
    const events = [];
    for (let i = 0; i < lines.length; i++) {
      const parsed = tryParse(lines[i], !endsWithNewline && i === lines.length - 1);
      if (parsed !== null) events.push(parsed);
    }
    if (skipped_tail + skipped_middle > 0) {
      console.warn(`[event-log] readEvents: skipped ${skipped_tail + skipped_middle} malformed line(s) in ${logPath}`);
    }
    await reportCorruption();
    return events;
  }

  // With limit = tail read optimization
  const stat = await fs.stat(logPath);
  const fileSize = stat.size;
  if (fileSize === 0) return [];

  const CHUNK_SIZE = Math.min(fileSize, 64 * 1024);
  const handle = await fs.open(logPath, "r");
  try {
    const lines = [];
    let position = fileSize;
    let remainder = Buffer.alloc(0);
    let tailHasNewline = null; // 文件是否以换行结尾（首块覆盖文件尾，读入时判定）
    let firstChunk = true;

    while (lines.length < options.limit && position > 0) {
      const readSize = Math.min(CHUNK_SIZE, position);
      position -= readSize;
      const buffer = Buffer.alloc(readSize);
      await handle.read(buffer, 0, readSize, position);
      if (firstChunk) {
        // 首块从文件末尾读起：其结尾即文件结尾（\n 单字节，不受多字节截断影响）
        tailHasNewline = buffer[buffer.length - 1] === 0x0a;
        firstChunk = false;
      }
      // 中文跨块防线：块保持字节形态拼接，只在换行字节边界切出完整行后再解码。
      // 若先 toString 再切，一个多字节字符可能横跨两块，解码成替换字符——
      // JSON 仍合法，字段被静默改字（审计证据失真）。
      const combined = Buffer.concat([buffer, remainder]);
      const firstNewline = combined.indexOf(0x0a);
      if (firstNewline === -1) {
        remainder = combined;
        continue;
      }
      remainder = combined.subarray(0, firstNewline);
      let end = combined.length;
      while (lines.length < options.limit && end > firstNewline) {
        const start = combined.lastIndexOf(0x0a, end - 1); // 恒 >= firstNewline
        const line = combined.toString("utf8", start + 1, end).replace(/\r$/u, "");
        end = start;
        if (line.trim()) lines.unshift(line);
      }
    }

    if (lines.length < options.limit && remainder.length > 0) {
      const firstLine = remainder.toString("utf8").replace(/\r$/u, "");
      if (firstLine.trim()) lines.unshift(firstLine);
    }

    const events = [];
    for (let i = 0; i < lines.length; i++) {
      // lines 的最后一个元素恒为文件末行（或其末段）：无换行结尾时按尾行容忍
      const parsed = tryParse(lines[i], !tailHasNewline && i === lines.length - 1);
      if (parsed !== null) events.push(parsed);
    }

    if (skipped_tail + skipped_middle > 0) {
      console.warn(`[event-log] readEvents: skipped ${skipped_tail + skipped_middle} malformed line(s) in ${logPath}`);
    }
    await reportCorruption();

    return events;
  } finally {
    await handle.close();
  }
}
