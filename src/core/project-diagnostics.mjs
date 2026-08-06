// src/core/project-diagnostics.mjs —— 项目诊断（统一 Agent 内核计划 Task 9 重写）。
//
// 稳定领域 loader：只消费项目领域审计（run_log.jsonl）、成本/缓存文件，以及注入的
// ProjectAgent.snapshot() 结果（{ session, events }）。不 import 任何 agent 内部
// 模块或旧状态读写（loadState 一类入口已随 Task 9 删除）；运行状态一律来自
// snapshot（计划 Rule 9：dashboard/diagnostics 需要运行状态时只消费
// ProjectAgent.snapshot() 的结果）。
import { readFile } from "node:fs/promises";
import path from "node:path";
import { readEvents } from "./event-log.mjs";
import { loadChapterIndex } from "./project-store.mjs";

export async function loadProjectDiagnostics(projectRoot, { agentSnapshot = null } = {}) {
  const session = agentSnapshot?.session ?? null;
  const run = session?.active_run ?? null;

  const [events, chapterIndex, costSummary, cacheReport] = await Promise.all([
    readEvents(projectRoot, { limit: 20 }),
    loadChapterIndex(projectRoot).catch(() => ({ chapters: [] })),
    readJsonOrNull(path.join(projectRoot, "cost.json")),
    readJsonOrNull(path.join(projectRoot, "cache_report.json"))
  ]);

  return {
    ok: true,
    project: {
      status: session?.status ?? "unknown",
      stage: run?.status ?? null,
      chapter: deriveCurrentChapter(chapterIndex),
      reason: run?.status && ["failed", "interrupted", "cancelled"].includes(run.status)
        ? run.status
        : null
    },
    queue: summarizeSession(session, run),
    recentEvents: events.slice(-20).reverse(),
    modelErrors: events.filter((event) => isModelError(event)).slice(-5).reverse(),
    costHealth: {
      calls: costSummary?.calls ?? 0,
      retries: costSummary?.retries ?? 0,
      unpricedCalls: costSummary?.unpricedCalls ?? 0,
      costAvailable: costSummary?.costAvailable ?? false,
      estimatedCost: costSummary?.estimatedCost ?? 0,
      maxCacheVersion: maxCacheVersion(cacheReport),
      lastCacheHitRate: cacheReport?.last_call?.cacheHitRate ?? null,
      lastStableChanged: cacheReport?.last_call?.stableChanged ?? null
    },
    recoveryHint: buildRecoveryHint(session, run)
  };
}

// 当前章节从章节索引推导（计划 Rule 9：current_chapter_no 由用户目标、活动 Run 与
// 章节索引推导；无任何证据时回落 1）。
function deriveCurrentChapter(chapterIndex) {
  const chapters = Array.isArray(chapterIndex?.chapters) ? chapterIndex.chapters : [];
  const committed = chapters.filter((chapter) => chapter.status === "completed");
  if (committed.length > 0) {
    const max = Math.max(...committed.map((chapter) => Number(chapter.chapter_no) || 0));
    return max >= 1 ? max + 1 : 1;
  }
  return 1;
}

// Session/Run 摘要（旧 queue 摘要的 Session 投影版：同一项目一次只执行一个 Run）。
function summarizeSession(session, run) {
  const queuedInputs = Array.isArray(session?.queued_inputs) ? session.queued_inputs : [];
  const runActive = Boolean(run);
  return {
    total: queuedInputs.length + (runActive ? 1 : 0),
    runningCount: runActive ? 1 : 0,
    queuedCount: queuedInputs.length,
    interruptedCount: run?.status === "interrupted" ? 1 : 0,
    cancelledCount: run?.status === "cancelled" ? 1 : 0,
    blockedCount: 0,
    completedCount: 0,
    recentTasks: queuedInputs.slice(-10).reverse()
  };
}

function isModelError(event) {
  const type = String(event.type ?? "");
  const message = String(event.message ?? "");
  return /model|provider|timeout|transport/u.test(type) || /model|provider|timeout|transport/u.test(message);
}

function buildRecoveryHint(session, run) {
  const status = session?.status ?? "unknown";
  const runStatus = run?.status ?? null;
  if (runStatus === "failed" || runStatus === "interrupted") {
    return { action: "retry", message: "项目被中断。可以使用重试或恢复继续旧任务。" };
  }
  if (runStatus === "cancelled") {
    return { action: "resume", message: "项目已停止。可以恢复项目，软件会创建恢复任务。" };
  }
  if (status === "running" || status === "waiting_user" || status === "interrupting" || status === "stopping") {
    return { action: "wait-or-stop", message: "项目正在运行。等待完成，或先停止当前任务。" };
  }
  return { action: "none", message: "当前没有需要处理的恢复动作。" };
}

function maxCacheVersion(cacheReport) {
  const versions = Object.values(cacheReport?.entries ?? {})
    .map((entry) => entry?.cacheVersion)
    .filter((v) => Number.isFinite(v));
  return versions.length ? Math.max(...versions) : null;
}

async function readJsonOrNull(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}
