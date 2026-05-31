import { randomUUID } from "node:crypto";
import { readJson, safeJoin, writeJsonAtomic } from "./fs-utils.mjs";

export const TASK_QUEUE_SCHEMA_VERSION = 2;

const TERMINAL_STATUSES = new Set(["completed", "interrupted", "cancelled", "blocked"]);

export class TaskQueue {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.queuePath = safeJoin(projectRoot, "task_queue.json");
    this.state = createEmptyState();
    this.lock = Promise.resolve();
  }

  async load() {
    const loaded = await readJson(this.queuePath, createEmptyState());
    this.state = normalizeState(loaded);
    return this.getState();
  }

  async enqueue(instruction, { mode = "auto" } = {}) {
    return this.withLock(async () => {
      await this.load();
    const now = timestamp();
    const task = {
      id: `task-${randomUUID()}`,
      index: nextIndex(this.state.tasks),
      instruction,
      mode,
      status: "queued",
      createdAt: now,
      startedAt: null,
      completedAt: null,
      updatedAt: now,
      error: null,
      stages: [],
      currentStage: null,
      heartbeatAt: null
    };
    this.state.tasks.push(task);
    await this.save();
    return clone(task);
    });
  }

  async createRecoveryTask({ instruction, mode = "write", currentStage = "queued", recovery = {} } = {}) {
    return this.withLock(async () => {
      await this.load();
      if (this.state.tasks.some((candidate) => candidate.status === "running")) {
        return null;
      }
      const now = timestamp();
      const task = {
        id: `task-${randomUUID()}`,
        index: nextIndex(this.state.tasks),
        instruction: String(instruction ?? "").trim() || "继续当前写作任务",
        mode,
        status: "running",
        source: "project_state_recovery",
        recovery: {
          ...recovery,
          source: "project_state",
          createdAt: now
        },
        createdAt: now,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        error: recovery?.reason ?? null,
        stages: [],
        currentStage,
        heartbeatAt: now
      };
      this.state.tasks.push(task);
      await this.save();
      return clone(task);
    });
  }

  async promoteNext() {
    return this.withLock(async () => {
      await this.load();
      if (this.state.tasks.some((candidate) => candidate.status === "running")) {
        return null;
      }
      const task = this.state.tasks.find((candidate) => candidate.status === "queued");
      if (!task) {
        return null;
      }
      const now = timestamp();
      task.status = "running";
      task.startedAt = now;
      task.updatedAt = now;
      task.heartbeatAt = now;
      await this.save();
      return clone(task);
    });
  }

  async complete(taskId, result) {
    return this.withLock(async () => {
      await this.load();
    const task = this.findTask(taskId);
    if (!task || task.status !== "running") {
      return null;
    }
    const now = timestamp();
    task.status = "completed";
    task.completedAt = now;
    task.updatedAt = now;
    task.result = result ?? null;
    task.error = null;
    await this.save();
    return clone(task);
    });
  }

  async interrupt(taskId, error) {
    return this.withLock(async () => {
      await this.load();
    const task = this.findTask(taskId);
    if (!task || task.status !== "running") {
      return null;
    }
    markInterrupted(task, normalizeError(error));
    await this.save();
    return clone(task);
    });
  }

  async cancel(taskId, reason) {
    return this.withLock(async () => {
      await this.load();
    const task = this.findTask(taskId);
    if (!task || task.status !== "queued") {
      return null;
    }
    const now = timestamp();
    task.status = "cancelled";
    task.completedAt = now;
    task.updatedAt = now;
    task.error = reason ?? null;
    await this.save();
    return clone(task);
    });
  }

  async block(taskId, reason) {
    return this.withLock(async () => {
      await this.load();
    const task = this.findTask(taskId);
    if (!task || task.status !== "running") {
      return null;
    }
    markBlocked(task, reason ?? "blocked");
    await this.save();
    return clone(task);
    });
  }

  async abortRunning(reason, taskId = null) {
    return this.withLock(async () => {
      await this.load();
    const aborted = [];
    for (const task of this.state.tasks) {
      if (task.status === "running" && (!taskId || task.id === taskId)) {
        markCancelled(task, reason ?? "aborted");
        aborted.push(clone(task));
      }
    }
    if (aborted.length > 0) {
      await this.save();
    }
    return aborted;
    });
  }

  async updateRunning(taskId, patch = {}) {
    return this.withLock(async () => {
      await this.load();
    const task = this.findTask(taskId);
    if (!task || task.status !== "running") {
      return null;
    }
    const now = timestamp();
    task.updatedAt = now;
    task.currentStage = patch.currentStage ?? task.currentStage;
    task.heartbeatAt = patch.heartbeatAt ?? now;
    task.progressText = patch.progressText ?? task.progressText;
    if (task.currentStage) {
      const existing = task.stages.find((stage) => stage.name === task.currentStage);
      if (existing) {
        existing.status = "running";
        existing.updatedAt = now;
      } else {
        task.stages.push({ name: task.currentStage, status: "running", startedAt: now, updatedAt: now });
      }
    }
    await this.save();
    return clone(task);
    });
  }

  async retry(taskId) {
    return this.withLock(async () => {
      await this.load();
    const task = this.findTask(taskId);
    if (!task || !["interrupted", "cancelled"].includes(task.status)) {
      return null;
    }
    if (this.state.tasks.some((candidate) => candidate.status === "running")) {
      return null;
    }
    const now = timestamp();
    task.status = "running";
    task.startedAt = now;
    task.completedAt = null;
    task.updatedAt = now;
    task.error = null;
    task.heartbeatAt = now;
    await this.save();
    return clone(task);
    });
  }

  getState() {
    return clone(this.state);
  }

  findTask(taskId) {
    return this.state.tasks.find((task) => task.id === taskId) ?? null;
  }

  async save() {
    this.state.updatedAt = timestamp();
    await writeJsonAtomic(this.queuePath, this.state);
  }

  async withLock(operation) {
    const run = this.lock.then(operation, operation);
    this.lock = run.catch(() => {});
    return run;
  }
}

export function expandInstruction(instruction, { currentChapter = 1 } = {}) {
  const text = String(instruction).trim();
  const current = Number(currentChapter);
  if (!Number.isInteger(current) || current < 1) {
    return [text];
  }

  const rangeMatch = /^(写|续写|写完|一直写)到第(\d+)章$/u.exec(text);
  if (rangeMatch) {
    const [, verb, targetText] = rangeMatch;
    const target = Number(targetText);
    const outputVerb = verb === "续写" ? "续写" : "写";
    return chapterRange(current, target, outputVerb);
  }

  const countMatch = /^(写|续写)(\d+)章$/u.exec(text);
  if (countMatch) {
    const [, verb, countText] = countMatch;
    const count = Number(countText);
    if (!Number.isInteger(count) || count < 1) {
      return [text];
    }
    return Array.from({ length: count }, (_, offset) => `${verb}第${current + offset}章`);
  }

  return [text];
}

function createEmptyState() {
  const now = timestamp();
  return {
    schema_version: TASK_QUEUE_SCHEMA_VERSION,
    tasks: [],
    updatedAt: now
  };
}

function normalizeState(value) {
  const state = {
    schema_version: TASK_QUEUE_SCHEMA_VERSION,
    tasks: Array.isArray(value?.tasks) ? value.tasks.map(normalizeTask) : [],
    updatedAt: value?.updatedAt ?? timestamp()
  };
  state.tasks.sort((a, b) => a.index - b.index);
  return state;
}

function normalizeTask(task) {
  const now = timestamp();
  return {
    id: task.id ?? `task-${randomUUID()}`,
    index: task.index ?? 0,
    instruction: task.instruction ?? "",
    mode: task.mode ?? "auto",
    status: task.status ?? "queued",
    createdAt: task.createdAt ?? now,
    startedAt: task.startedAt ?? null,
    completedAt: task.completedAt ?? (TERMINAL_STATUSES.has(task.status) ? now : null),
    updatedAt: task.updatedAt ?? now,
    error: task.error ?? null,
    stages: Array.isArray(task.stages) ? task.stages : [],
    currentStage: task.currentStage ?? null,
    heartbeatAt: task.heartbeatAt ?? null,
    ...(typeof task.source === "string" ? { source: task.source } : {}),
    ...(task.recovery && typeof task.recovery === "object" ? { recovery: clone(task.recovery) } : {}),
    ...(Object.hasOwn(task, "result") ? { result: task.result } : {})
  };
}

function nextIndex(tasks) {
  return tasks.reduce((max, task) => Math.max(max, task.index ?? 0), 0) + 1;
}

function markInterrupted(task, error) {
  const now = timestamp();
  task.status = "interrupted";
  task.completedAt = now;
  task.updatedAt = now;
  task.error = error;
}

function markCancelled(task, error) {
  const now = timestamp();
  task.status = "cancelled";
  task.completedAt = now;
  task.updatedAt = now;
  task.error = error;
}

function markBlocked(task, error) {
  const now = timestamp();
  task.status = "blocked";
  task.completedAt = now;
  task.updatedAt = now;
  task.error = error;
}

function normalizeError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return error ?? null;
}

function chapterRange(current, target, verb) {
  if (!Number.isInteger(target) || target < current) {
    return [];
  }
  return Array.from({ length: target - current + 1 }, (_, offset) => `${verb}第${current + offset}章`);
}

function timestamp() {
  return new Date().toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
