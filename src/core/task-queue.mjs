import { randomUUID } from "node:crypto";
import { readJson, safeJoin, writeJsonAtomic } from "./fs-utils.mjs";
import { compileWritingTasks, makeResumeContract } from "./task-contract.mjs";

export const TASK_QUEUE_SCHEMA_VERSION = 3;

const TERMINAL_STATUSES = new Set(["completed", "interrupted", "cancelled", "blocked"]);
const ACTIVE_STATUSES = new Set(["running", "cancelling"]);

export class TaskQueue {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.queuePath = safeJoin(projectRoot, "task_queue.json");
    this.state = createEmptyState();
    this.lock = Promise.resolve();
  }

  async load() {
    const loaded = await readJson(this.queuePath, createEmptyState());
    const previousVersion = typeof loaded?.schema_version === "number" ? loaded.schema_version : 1;
    const needsMigration = previousVersion < TASK_QUEUE_SCHEMA_VERSION;
    this.state = normalizeState(loaded, { migrateContracts: needsMigration });
    if (needsMigration) {
      await this.save();
    }
    return this.getState();
  }

  async enqueue(instruction, { mode = "auto", contract } = {}) {
    return this.withLock(async () => {
      await this.load();
    const now = timestamp();
    const task = {
      id: `task-${randomUUID()}`,
      index: nextIndex(this.state.tasks),
      instruction,
      contract: contract ? clone(contract) : null,
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
      if (this.state.tasks.some((candidate) => ACTIVE_STATUSES.has(candidate.status))) {
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
      if (this.state.tasks.some((candidate) => ACTIVE_STATUSES.has(candidate.status))) {
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

  async markCancelling(taskId, reason = "用户停止") {
    return this.withLock(async () => {
      await this.load();
      const task = this.findTask(taskId);
      if (!task || !ACTIVE_STATUSES.has(task.status)) {
        return null;
      }
      if (task.status !== "cancelling") {
        const now = timestamp();
        task.status = "cancelling";
        task.error = reason;
        task.updatedAt = now;
        await this.save();
      }
      return clone(task);
    });
  }

  // 把排队/运行/取消中的任务直接置为 blocked。仅在「项目级阻塞」这种前置校验里使用，
  // 避免在 run-start 后再调用 queue.block（它要求任务已经在 running）。
  async markBlocked(taskId, reason) {
    return this.withLock(async () => {
      await this.load();
      const task = this.findTask(taskId);
      if (!task || TERMINAL_STATUSES.has(task.status)) {
        return null;
      }
      const now = timestamp();
      task.status = "blocked";
      task.completedAt = now;
      task.updatedAt = now;
      task.error = reason ?? "blocked";
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
      if (ACTIVE_STATUSES.has(task.status) && (!taskId || task.id === taskId)) {
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
    if (this.state.tasks.some((candidate) => ACTIVE_STATUSES.has(candidate.status))) {
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

  const countMatch = /^(写|续写)(\d+|[一二三四五六七八九十])章$/u.exec(text);
  if (countMatch) {
    const [, verb, countText] = countMatch;
    const count = parseChapterCount(countText);
    if (!Number.isInteger(count) || count < 1) {
      return [text];
    }
    return Array.from({ length: count }, (_, offset) => `${verb}第${current + offset}章`);
  }

  return [text];
}

// 中文数字章数解析（与 task-contract.compileWritingTasks 的 parseChapterCount 对齐；
// 「写三章」与「写3章」行为一致，避免 chat 的 queue_chapters 把中文数字退化成自由指令）。
function parseChapterCount(token) {
  const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (map[token] !== undefined) return map[token];
  return Number(token);
}

function createEmptyState() {
  const now = timestamp();
  return {
    schema_version: TASK_QUEUE_SCHEMA_VERSION,
    tasks: [],
    updatedAt: now
  };
}

function normalizeState(value, { migrateContracts = false } = {}) {
  const state = {
    schema_version: TASK_QUEUE_SCHEMA_VERSION,
    tasks: Array.isArray(value?.tasks) ? value.tasks.map((task) => normalizeTask(task, { migrateContracts })) : [],
    updatedAt: value?.updatedAt ?? timestamp()
  };
  state.tasks.sort((a, b) => a.index - b.index);
  return state;
}

function normalizeTask(task, { migrateContracts = false } = {}) {
  const now = timestamp();
  const status = task.status ?? "queued";
  const recovery = task.recovery && typeof task.recovery === "object" ? clone(task.recovery) : null;
  const hasContract = Object.hasOwn(task, "contract") && task.contract != null;
  const migration = migrateContracts && !hasContract ? migrateContract(task, status, recovery) : {};
  const normalized = {
    id: task.id ?? `task-${randomUUID()}`,
    index: task.index ?? 0,
    instruction: task.instruction ?? "",
    mode: task.mode ?? "auto",
    status: migration.status ?? status,
    createdAt: task.createdAt ?? now,
    startedAt: task.startedAt ?? null,
    completedAt: task.completedAt ?? (TERMINAL_STATUSES.has(migration.status ?? status) ? now : null),
    updatedAt: task.updatedAt ?? now,
    error: migration.error ?? task.error ?? null,
    stages: Array.isArray(task.stages) ? task.stages : [],
    currentStage: task.currentStage ?? null,
    heartbeatAt: task.heartbeatAt ?? null,
    ...(migration.contract ? { contract: migration.contract } : hasContract ? { contract: clone(task.contract) } : {}),
    ...(typeof task.source === "string" ? { source: task.source } : {}),
    ...(recovery ? { recovery } : {}),
    ...(Object.hasOwn(task, "result") ? { result: task.result } : {})
  };
  return normalized;
}

function migrateContract(task, status, recovery) {
  const isRecovery = task.source === "project_state_recovery";
  const recoveryChapter = recovery?.chapterNo;
  const recoveryTarget = recovery?.targetChapters;

  if (isRecovery || status === "cancelled" || status === "interrupted") {
    const chapterNo = Number(recoveryChapter) > 0 ? Number(recoveryChapter) : 1;
    return { contract: makeResumeContract(chapterNo) };
  }

  const text = String(task.instruction ?? "").trim();
  const precise = /^(写|续写)第(\d+)章(?:[，,\s].*)?$/u.exec(text);
  if (precise) {
    const chapter = Number(precise[2]);
    const target = Number(recoveryTarget) > 0 ? Number(recoveryTarget) : Math.max(chapter, 1);
    try {
      const compiled = compileWritingTasks(text, { currentChapter: chapter, targetChapters: target });
      if (Array.isArray(compiled) && compiled.length > 0 && compiled[0].contract) {
        return { contract: clone(compiled[0].contract) };
      }
    } catch (_) {
      // fall through to legacy block
    }
  }

  if (status === "running") {
    if (Number(recoveryChapter) > 0) {
      return { contract: makeResumeContract(Number(recoveryChapter)) };
    }
    return {
      status: "blocked",
      error: "legacy_task_contract_unresolved"
    };
  }

  return {
    status: "blocked",
    error: "legacy_task_contract_unresolved"
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
