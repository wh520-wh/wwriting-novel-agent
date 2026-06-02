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
  const events = (await fs.readFile(logPath, "utf8"))
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return options.limit ? events.slice(-options.limit) : events;
}

on(CORE_EVENTS.TaskFailed, (payload) => {
  try {
    if (!payload || !payload.projectRoot) return;
    const error = payload.error;
    appendEvent(payload.projectRoot, {
      type: "task-failed",
      severity: "error",
      message: error?.message ?? "task failed",
      data: {
        taskId: payload.taskId,
        stage: payload.options?.stage ?? null,
        error: error ? String(error.message || error) : undefined
      }
    });
  } catch (e) {
    console.error("event-log: failed to record task:failed:", e);
  }
});

on(CORE_EVENTS.ChapterWritten, (payload) => {
  try {
    if (!payload || !payload.projectRoot) return;
    appendEvent(payload.projectRoot, {
      type: "chapter-written",
      message: "chapter written",
      data: {
        path: payload.path,
        chapterId: payload.chapterId
      }
    });
  } catch (e) {
    console.error("event-log: failed to record chapter:written:", e);
  }
});
