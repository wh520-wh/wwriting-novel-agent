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

  let skipped_lines = 0;

  // Helper to safely parse a JSON line
  function tryParse(line) {
    try {
      return JSON.parse(line);
    } catch {
      skipped_lines++;
      return null;
    }
  }

  // No limit = full read (backward compatible)
  if (!options.limit) {
    const lines = (await fs.readFile(logPath, "utf8")).split(/\r?\n/u).filter(Boolean);
    const events = [];
    for (const line of lines) {
      const parsed = tryParse(line);
      if (parsed !== null) events.push(parsed);
    }
    if (skipped_lines > 0) {
      console.warn(`[event-log] readEvents: skipped ${skipped_lines} malformed line(s) in ${logPath}`);
    }
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
    let remainder = "";

    while (lines.length < options.limit && position > 0) {
      const readSize = Math.min(CHUNK_SIZE, position);
      position -= readSize;
      const buffer = Buffer.alloc(readSize);
      await handle.read(buffer, 0, readSize, position);
      const chunk = buffer.toString("utf8");
      const combined = chunk + remainder;
      const parts = combined.split(/\r?\n/u);
      remainder = parts.shift();
      for (let i = parts.length - 1; i >= 0 && lines.length < options.limit; i--) {
        if (parts[i].trim()) {
          lines.unshift(parts[i]);
        }
      }
    }

    if (lines.length < options.limit && remainder.trim()) {
      lines.unshift(remainder);
    }

    const events = [];
    for (const line of lines) {
      const parsed = tryParse(line);
      if (parsed !== null) events.push(parsed);
    }

    if (skipped_lines > 0) {
      console.warn(`[event-log] readEvents: skipped ${skipped_lines} malformed line(s) in ${logPath}`);
    }

    return events;
  } finally {
    await handle.close();
  }
}
