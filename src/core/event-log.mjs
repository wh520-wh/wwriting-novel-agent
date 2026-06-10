import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { pathExists, safeJoin } from "./fs-utils.mjs";
import { on, CORE_EVENTS } from "./event-bus.mjs";

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

  // No limit = full read (backward compatible)
  if (!options.limit) {
    const events = (await fs.readFile(logPath, "utf8"))
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
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

    return lines.map((line) => JSON.parse(line));
  } finally {
    await handle.close();
  }
}

export async function tailEvents(projectRoot, n) {
  return readEvents(projectRoot, { limit: n });
}

on(CORE_EVENTS.TaskFailed, (payload) => {
  if (!payload || !payload.projectRoot) return;
  const error = payload.error;
  // Fire-and-forget: don't block the emit caller on a disk write.
  // Errors are logged by the bus's Promise.allSettled path.
  void appendEvent(payload.projectRoot, {
    type: "task-failed",
    severity: "error",
    message: error?.message ?? "task failed",
    data: {
      taskId: payload.taskId,
      stage: payload.options?.stage ?? null,
      error: error ? String(error.message || error) : undefined
    }
  });
});

on(CORE_EVENTS.ChapterWritten, (payload) => {
  if (!payload || !payload.projectRoot) return;
  void appendEvent(payload.projectRoot, {
    type: "chapter-written",
    message: "chapter written",
    data: {
      path: payload.path,
      chapterId: payload.chapterId
    }
  });
});
