// src/core/agent/context-checkpoints.mjs
//
// Task 7：active context checkpoint 不可变存储与候选→提交时序。
//
// 磁盘布局（agentDir 与 journal 的 agentDir 相同）：
//   active-context.json                 —— 指针：只保存
//                                          { schema_version:1, checkpoint_id, commit_id,
//                                            committed_at, source_seq_end, sha256 }
//   compaction-commit-<commit_id>.json  —— 跨 active 指针与 Journal 的提交 marker
//                                          （含完整 completed payload、旧/新指针 hash、
//                                          预写 event_id）
//   checkpoints/context-<checkpoint_id>.json      —— 不可变正式 checkpoint（完整
//                                          ActiveContextCheckpointV1，读回校验 hash）
//   checkpoints/.candidate-<checkpoint_id>.json  —— 候选临时文件（提交前）
//
// 固定数据契约（计划 §2，字段名逐字使用）：
//
// // ActiveContextCheckpointV1
// // {
// //   schema_version: 1,
// //   checkpoint_id: string,
// //   source_checkpoint_id: string | null,
// //   source_seq: { start: number, end: number },
// //   source_transcript_seq: { start: number, end: number },
// //   configured_model_id: string,
// //   provider_model_id: string,
// //   trigger: "automatic" | "manual",
// //   summary: CompactionSummaryV1,
// //   recent_messages: Array<object>,
// //   open_tool_calls: Array<object>,
// //   reload_from_workspace: string[],
// //   estimated_tokens: number,
// //   created_at: string,
// //   sha256: string
// // }
//
// candidate→commit 时序（brief Step 4，严格固定；每一步提供故障注入 hook）：
//   read old active checkpoint
//   → write candidate temp（writeCandidate）
//   → complete response + parse + validate（coordinator 经 compaction-prompt.mjs +
//     validateCandidate；commitCandidate 内部防御性复验）
//   → write immutable final checkpoint
//   → read-back + hash verify
//   → write commit marker（含完整 completed payload、旧/新指针 hash、预写 event_id）
//   → atomically replace active-context.json
//   → append context_compaction_completed（event_id 预先写入 marker）
//   → delete commit marker
// 失败/取消/半截输出/切换前任一写入失败只清理候选并追加 failed/cancelled（由 Task 8
// coordinator 负责事件）；指针切换后的崩溃由 marker 在 reconcileAfterCrash 补齐 Journal。
//
// reconcileAfterCrash({ journal }) 固定裁决（brief Step 4）：
//   1. marker 存在、active 指针仍是旧 checkpoint：删除未提交正式文件/候选/marker，
//      旧上下文继续生效；started/running 未有终态时追加
//      context_compaction_failed(error_code:"commit_not_switched")。
//   2. marker 存在、active 指针是新 checkpoint、Journal 尚无 marker 中的 completed
//      event_id：用 marker 保存的完整 payload 补写同一 context_compaction_completed，
//      再删除 marker。
//   3. marker 存在、active 指针和 completed 都已是新值：只删除 marker。
//   4. active 指针指向新 checkpoint 但 marker 缺失且 Journal 无 completed：视为存储
//      损坏，抛可诊断错误（checkpoint_corrupt），不得猜测回滚。
//   另外：无 marker 时清理所有候选文件，以及未被 active 指针或任何 marker 引用的
//     孤儿正式文件（覆盖 marker 写入前崩溃的现场）。
//
// journal 最小接口（真实 journal.mjs 满足；Task 7 测试用同接口 fake）：
//   journal.read({ afterSeq = 0, limit }): Promise<Array<event>>   —— 事件读取（seq 升序）
//   journal.append(event): Promise<stampedEvent>                    —— 追加事件；
//     尊重预写 event_id（与 journal.mjs stampEvent 的 base.event_id ?? idFactory() 一致）。
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ensureDir, pathExists, readJson, safeJoin, sha256, writeJsonAtomic } from "../fs-utils.mjs";
import { validateCompactionSummary, validateSummaryShape } from "./compaction-prompt.mjs";

export const ACTIVE_CONTEXT_FILENAME = "active-context.json";
export const POINTER_SCHEMA_VERSION = 1;
export const CHECKPOINT_SCHEMA_VERSION = 1;
export const COMMIT_MARKER_SCHEMA_VERSION = 1;
export const FORMAL_PREFIX = "context-";
export const CANDIDATE_PREFIX = ".candidate-";
export const COMMIT_MARKER_PREFIX = "compaction-commit-";

// 完成/失败/取消事件 payload 的固定字段（计划 §2；不可用值写 null，不得改名）。
export const COMPACTION_PAYLOAD_FIELDS = Object.freeze([
  "compaction_id",
  "trigger",
  "attempt",
  "source_checkpoint_id",
  "checkpoint_id",
  "source_seq",
  "source_transcript_seq",
  "provider_model_id",
  "estimated_tokens_before",
  "estimated_tokens_after",
  "released_tokens",
  "summary_schema_version",
  "duration_ms",
  "validation",
  "error_code",
  "cancel_reason"
]);

export const COMPACTION_EVENT_TYPES = Object.freeze([
  "context_compaction_started",
  "context_compaction_running",
  "context_compaction_cancel_requested",
  "context_compaction_completed",
  "context_compaction_failed",
  "context_compaction_cancelled",
  "context_compaction_noop"
]);

const COMPACTION_NON_TERMINAL = new Set([
  "context_compaction_started",
  "context_compaction_running",
  "context_compaction_cancel_requested"
]);

// 候选→提交时序每一步（故障注入 fault 名）。
export const COMMIT_STEPS = Object.freeze([
  "writeFinalCheckpoint",
  "readBackVerify",
  "writeMarker",
  "replacePointer",
  "appendCompleted",
  "deleteMarker"
]);

function fail(message) {
  throw new Error(message);
}

function defaultClock() {
  return Date.now();
}

function defaultIdFactory() {
  return randomUUID();
}

function normalizeAt(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) fail(`非法时间值: ${String(value)}`);
  return date.toISOString();
}

function checkpointError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeCandidate(input) {
  if (input != null && typeof input === "object" && !Array.isArray(input) && "candidate" in input) {
    return input.candidate;
  }
  return input;
}

function assertSafeCheckpointId(id) {
  if (typeof id !== "string" || id.length === 0 || id.length > 200) {
    throw checkpointError("checkpoint_invalid_id", `checkpoint_id 非法：必须是非空字符串（长度 ≤ 200）`);
  }
  if (/[\\/]|\.\./u.test(id) || id === "." || id === "..") {
    throw checkpointError("checkpoint_invalid_id", `checkpoint_id 非法（禁止路径分隔符或 ..）：${JSON.stringify(id)}`);
  }
}

function formalFilePath(root, checkpointId) {
  assertSafeCheckpointId(checkpointId);
  return safeJoin(root, "checkpoints", `${FORMAL_PREFIX}${checkpointId}.json`);
}

function candidateFilePath(root, checkpointId) {
  assertSafeCheckpointId(checkpointId);
  return safeJoin(root, "checkpoints", `${CANDIDATE_PREFIX}${checkpointId}.json`);
}

function commitMarkerFilePath(root, commitId) {
  assertSafeCheckpointId(commitId);
  return safeJoin(root, `${COMMIT_MARKER_PREFIX}${commitId}.json`);
}

// 稳定 JSON 序列化（排序键），用于 checkpoint 内容 hash：sha256 字段自身被排除，
// 避免自引用；读回校验时对同一内容重新计算。
function canonicalStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(",")}}`;
}

function checkpointContentHash(checkpoint) {
  if (checkpoint == null || typeof checkpoint !== "object") return null;
  const { sha256: _ignored, ...rest } = checkpoint;
  return sha256(canonicalStringify(rest));
}

function verifyCheckpointHash(checkpoint) {
  if (checkpoint == null || typeof checkpoint !== "object") {
    return { ok: false, reason: "checkpoint_not_object" };
  }
  if (typeof checkpoint.sha256 !== "string" || checkpoint.sha256.length === 0) {
    return { ok: false, reason: "missing_sha256" };
  }
  const expected = checkpointContentHash(checkpoint);
  return { ok: expected === checkpoint.sha256, reason: expected === checkpoint.sha256 ? null : "hash_mismatch" };
}

function emptyPointer() {
  return {
    schema_version: POINTER_SCHEMA_VERSION,
    checkpoint_id: null,
    commit_id: null,
    committed_at: null,
    source_seq_end: null,
    sha256: null
  };
}

function requireSeqRange(value, name) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw checkpointError("checkpoint_schema", `checkpoint schema 校验失败：${name} 必须是 { start, end } 对象`);
  }
  if (!Number.isInteger(value.start) || !Number.isInteger(value.end) || value.start < 0 || value.end < value.start) {
    throw checkpointError("checkpoint_schema", `checkpoint schema 校验失败：${name} 必须是 start ≤ end 的非负整数`);
  }
}

function seqRangeEqual(a, b) {
  if (a == null || b == null) return false;
  return a.start === b.start && a.end === b.end;
}

function resolveTargetTokens(sourceState) {
  if (sourceState?.target_tokens != null && Number.isFinite(sourceState.target_tokens)) {
    return sourceState.target_tokens;
  }
  const window = sourceState?.effective_context_window;
  if (typeof window === "number" && Number.isFinite(window) && window > 0) {
    return Math.round(window * 0.25);
  }
  return Infinity;
}

// 候选整体校验（结构化错误）：整体 schema → 摘要 schema → 保护字段 →
// source seq 一致 → token 目标。返回预提交校验报告。
function validateCheckpointCandidate(candidate, sourceState) {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw checkpointError("checkpoint_schema", "checkpoint schema 校验失败：必须是对象");
  }
  if (candidate.schema_version !== CHECKPOINT_SCHEMA_VERSION) {
    throw checkpointError(
      "checkpoint_schema",
      `checkpoint schema 校验失败：schema_version 必须是 ${CHECKPOINT_SCHEMA_VERSION}，实际为 ${JSON.stringify(candidate.schema_version)}`
    );
  }
  if (typeof candidate.checkpoint_id !== "string" || candidate.checkpoint_id.length === 0) {
    throw checkpointError("checkpoint_schema", "checkpoint schema 校验失败：checkpoint_id 必须是非空字符串");
  }
  requireSeqRange(candidate.source_seq, "source_seq");
  requireSeqRange(candidate.source_transcript_seq, "source_transcript_seq");
  if (typeof candidate.configured_model_id !== "string" || candidate.configured_model_id.length === 0) {
    throw checkpointError("checkpoint_schema", "checkpoint schema 校验失败：configured_model_id 必须是非空字符串");
  }
  if (typeof candidate.provider_model_id !== "string" || candidate.provider_model_id.length === 0) {
    throw checkpointError("checkpoint_schema", "checkpoint schema 校验失败：provider_model_id 必须是非空字符串");
  }
  if (!["automatic", "manual"].includes(candidate.trigger)) {
    throw checkpointError("checkpoint_schema", `checkpoint schema 校验失败：trigger 非法: ${JSON.stringify(candidate.trigger)}`);
  }
  if (candidate.summary === null || typeof candidate.summary !== "object" || Array.isArray(candidate.summary)) {
    throw checkpointError("checkpoint_summary_schema", "checkpoint summary schema 校验失败：summary 必须是对象");
  }
  if (!Array.isArray(candidate.recent_messages)) {
    throw checkpointError("checkpoint_schema", "checkpoint schema 校验失败：recent_messages 必须是数组");
  }
  if (!Array.isArray(candidate.open_tool_calls)) {
    throw checkpointError("checkpoint_schema", "checkpoint schema 校验失败：open_tool_calls 必须是数组");
  }
  if (!Array.isArray(candidate.reload_from_workspace)) {
    throw checkpointError("checkpoint_schema", "checkpoint schema 校验失败：reload_from_workspace 必须是数组");
  }
  if (typeof candidate.estimated_tokens !== "number" || !Number.isFinite(candidate.estimated_tokens) || candidate.estimated_tokens < 0) {
    throw checkpointError("checkpoint_schema", "checkpoint schema 校验失败：estimated_tokens 必须是非负有限数字");
  }
  if (typeof candidate.created_at !== "string" || candidate.created_at.length === 0) {
    throw checkpointError("checkpoint_schema", "checkpoint schema 校验失败：created_at 必须是非空字符串");
  }
  if (candidate.sha256 != null && typeof candidate.sha256 !== "string") {
    throw checkpointError("checkpoint_schema", "checkpoint schema 校验失败：sha256 必须是字符串或缺失（提交时计算）");
  }

  try {
    validateSummaryShape(candidate.summary);
  } catch (error) {
    throw checkpointError("checkpoint_summary_schema", error?.message ?? "checkpoint summary schema 校验失败");
  }
  try {
    validateCompactionSummary(candidate.summary, sourceState);
  } catch (error) {
    throw checkpointError("checkpoint_protected_state", error?.message ?? "checkpoint 保护字段校验失败");
  }
  if (sourceState?.source_seq != null && !seqRangeEqual(candidate.source_seq, sourceState.source_seq)) {
    throw checkpointError(
      "checkpoint_source_seq_mismatch",
      `checkpoint 校验失败：source_seq ${JSON.stringify(candidate.source_seq)} 与源状态 ${JSON.stringify(sourceState.source_seq)} 不一致`
    );
  }
  if (sourceState?.source_transcript_seq != null && !seqRangeEqual(candidate.source_transcript_seq, sourceState.source_transcript_seq)) {
    throw checkpointError(
      "checkpoint_source_seq_mismatch",
      `checkpoint 校验失败：source_transcript_seq ${JSON.stringify(candidate.source_transcript_seq)} 与源状态 ${JSON.stringify(sourceState.source_transcript_seq)} 不一致`
    );
  }
  const target = resolveTargetTokens(sourceState);
  if (Number.isFinite(target) && candidate.estimated_tokens > target) {
    throw checkpointError(
      "checkpoint_target_exceeded",
      `checkpoint 校验失败：estimated_tokens ${candidate.estimated_tokens} 超过目标 ${target}（target）`
    );
  }
  return { schema_ok: true, protected_state_ok: true, target_ok: true, hash_ok: false };
}

// 完整 completed payload（计划 §2 固定字段；不可用值写 null）。candidate 提供
// 结构化事实，commitEvent.payload 提供运行期元数据，两者合并后不可缺失字段。
function buildCompletedPayload({ candidate, commitEvent, validation }) {
  const meta = commitEvent?.payload ?? {};
  const payload = {
    compaction_id: meta.compaction_id ?? null,
    trigger: candidate.trigger ?? null,
    attempt: meta.attempt ?? 1,
    source_checkpoint_id: candidate.source_checkpoint_id ?? null,
    checkpoint_id: candidate.checkpoint_id,
    source_seq: candidate.source_seq ?? null,
    source_transcript_seq: candidate.source_transcript_seq ?? null,
    provider_model_id: candidate.provider_model_id ?? null,
    estimated_tokens_before: meta.estimated_tokens_before ?? null,
    estimated_tokens_after: meta.estimated_tokens_after ?? candidate.estimated_tokens ?? null,
    released_tokens: meta.released_tokens ?? null,
    summary_schema_version: 1,
    duration_ms: meta.duration_ms ?? null,
    validation,
    error_code: null,
    cancel_reason: null
  };
  // 契约完整性守卫：固定字段一个都不能少（不可用值已写 null）。
  for (const field of COMPACTION_PAYLOAD_FIELDS) {
    if (!(field in payload)) {
      throw checkpointError("checkpoint_payload_schema", `completed payload 缺少固定字段 ${field}`);
    }
  }
  return payload;
}

function buildPointer({ finalized, commitId, clock }) {
  return {
    schema_version: POINTER_SCHEMA_VERSION,
    checkpoint_id: finalized.checkpoint_id,
    commit_id: commitId,
    committed_at: normalizeAt(clock()),
    source_seq_end: finalized.source_seq?.end ?? null,
    sha256: finalized.sha256
  };
}

function buildCommitMarker({ before, finalized, commitId, commitEvent, validation, clock }) {
  return {
    schema_version: COMMIT_MARKER_SCHEMA_VERSION,
    commit_id: commitId,
    event_id: commitEvent?.event_id ?? null,
    checkpoint_id: finalized.checkpoint_id,
    old_pointer: {
      checkpoint_id: before.checkpoint_id ?? null,
      sha256: before.sha256 ?? null,
      source_seq_end: before.source_seq_end ?? null
    },
    new_pointer: {
      checkpoint_id: finalized.checkpoint_id,
      sha256: finalized.sha256,
      source_seq_end: finalized.source_seq?.end ?? null
    },
    payload: buildCompletedPayload({ candidate: finalized, commitEvent, validation }),
    written_at: normalizeAt(clock())
  };
}

function injectFault(faults, stepName, phase) {
  if (faults == null) return;
  if (phase === "before" && faults.failBefore === stepName) {
    throw checkpointError("checkpoint_write_failed", `故障注入：模拟 ${stepName} 写入失败`);
  }
  if (phase === "after" && faults.crashAfter === stepName) {
    throw checkpointError("checkpoint_crash_fault", `故障注入：模拟在 ${stepName} 之后进程崩溃`);
  }
}

async function removeIfExists(targetPath) {
  try {
    await fs.unlink(targetPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function createContextCheckpointStore({ agentDir, clock = defaultClock, idFactory = defaultIdFactory } = {}) {
  if (typeof agentDir !== "string" || agentDir.length === 0) {
    fail("agentDir 必须是非空路径");
  }
  const root = path.resolve(agentDir);
  const pointerPath = path.join(root, ACTIVE_CONTEXT_FILENAME);
  const checkpointsDir = path.join(root, "checkpoints");

  // 读取 active 指针。文件缺失/形状非法返回空指针形状（checkpoint_id: null）；
  // 存储损坏的裁决由 reconcileAfterCrash 负责，readActive 不抛错阻塞发送。
  async function readActive() {
    const pointer = await readJson(pointerPath, null);
    if (pointer == null || typeof pointer !== "object" || Array.isArray(pointer)) return emptyPointer();
    if (pointer.checkpoint_id == null) return emptyPointer();
    return pointer;
  }

  // 候选临时文件：checkpoints/.candidate-<checkpoint_id>.json（writeJsonAtomic）。
  async function writeCandidate(input) {
    const candidate = normalizeCandidate(input);
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw checkpointError("checkpoint_candidate_schema", "候选 checkpoint schema 校验失败：必须是对象");
    }
    if (typeof candidate.checkpoint_id !== "string" || candidate.checkpoint_id.length === 0) {
      throw checkpointError("checkpoint_candidate_schema", "候选 checkpoint schema 校验失败：缺少 checkpoint_id");
    }
    const filePath = candidateFilePath(root, candidate.checkpoint_id);
    await ensureDir(checkpointsDir);
    try {
      await writeJsonAtomic(filePath, candidate);
    } catch (error) {
      throw checkpointError("checkpoint_write_failed", `候选 checkpoint 写入失败：${error?.message ?? String(error)}`);
    }
    return filePath;
  }

  // 候选校验（coordinator 在模型响应后调用）：返回 { schema_ok, protected_state_ok,
  // target_ok, hash_ok: false }；任何校验失败抛结构化错误（code + message）。
  async function validateCandidate(input, sourceState = {}) {
    return validateCheckpointCandidate(normalizeCandidate(input), sourceState);
  }

  // 清理候选文件（失败/取消路径）。
  async function discardCandidate(candidateId) {
    if (typeof candidateId !== "string" || candidateId.length === 0) return;
    await removeIfExists(candidateFilePath(root, candidateId));
  }

  // 候选→提交完整时序（brief Step 4 严格顺序 + 每步故障注入 hook）：
  //   readActive → writeCandidate(外部) → validate(外部+内部防御) →
  //   writeFinalCheckpoint → readBackVerify → writeMarker → replacePointer →
  //   appendCompleted → deleteMarker。
  // 返回 { checkpoint_id, commit_id, event_id, sha256, checkpoint_file, pointer,
  // validation }，供 Task 8 coordinator 继续推进状态机。
  async function commitCandidate(input, options = {}) {
    const candidate = normalizeCandidate(input);
    const { journal = null, commitEvent = null, sourceState = {}, faults = {} } = options ?? {};

    const before = await readActive();
    // 内部防御性复验：brief Step 1 直接对 commitCandidate 注入非法候选也必须拒绝。
    const validation = validateCheckpointCandidate(candidate, sourceState);

    // 不可变正式 checkpoint：写入前计算内容 hash（排除 sha256 自身），写入后读回复核。
    await injectFault(faults, "writeFinalCheckpoint", "before");
    const finalized = { ...candidate, sha256: checkpointContentHash(candidate) };
    const finalPath = formalFilePath(root, finalized.checkpoint_id);
    await ensureDir(checkpointsDir);
    try {
      await writeJsonAtomic(finalPath, finalized);
    } catch (error) {
      throw checkpointError("checkpoint_write_failed", `正式 checkpoint 写入失败：${error?.message ?? String(error)}`);
    }
    await injectFault(faults, "writeFinalCheckpoint", "after");

    await injectFault(faults, "readBackVerify", "before");
    const readBack = await readJson(finalPath, null);
    const hashCheck = verifyCheckpointHash(readBack);
    if (!hashCheck.ok) {
      throw checkpointError("checkpoint_hash_mismatch", `checkpoint 读回 hash 校验失败：${hashCheck.reason}`);
    }
    await injectFault(faults, "readBackVerify", "after");

    // 提交 marker：完整 completed payload + 旧/新指针（含 hash）+ 预写 event_id。
    await injectFault(faults, "writeMarker", "before");
    const commitId = idFactory();
    const marker = buildCommitMarker({
      before,
      finalized,
      commitId,
      commitEvent,
      validation: { ...validation, hash_ok: true },
      clock
    });
    if (marker.event_id == null) {
      throw checkpointError("checkpoint_commit_requires_journal", "commitCandidate 需要带 event_id 的 commitEvent");
    }
    const markerPath = commitMarkerFilePath(root, commitId);
    try {
      await writeJsonAtomic(markerPath, marker);
    } catch (error) {
      throw checkpointError("checkpoint_write_failed", `提交 marker 写入失败：${error?.message ?? String(error)}`);
    }
    await injectFault(faults, "writeMarker", "after");

    // 原子替换 active 指针：writeJsonAtomic（临时文件 + fsync + rename），
    // 旧指针永远不被覆盖成半文件。
    await injectFault(faults, "replacePointer", "before");
    const pointer = buildPointer({ finalized, commitId, clock });
    try {
      await writeJsonAtomic(pointerPath, pointer);
    } catch (error) {
      throw checkpointError("checkpoint_write_failed", `active 指针写入失败：${error?.message ?? String(error)}`);
    }
    await injectFault(faults, "replacePointer", "after");

    // 追加 completed 事件（event_id 预先写入 marker；journal 尊重预写 event_id）。
    await injectFault(faults, "appendCompleted", "before");
    if (journal == null) {
      throw checkpointError("checkpoint_commit_requires_journal", "commitCandidate 需要 journal 才能追加 completed 事件");
    }
    await journal.append({ event_id: marker.event_id, type: "context_compaction_completed", payload: marker.payload });
    await injectFault(faults, "appendCompleted", "after");

    // 删除提交 marker。
    await injectFault(faults, "deleteMarker", "before");
    await removeIfExists(markerPath);
    await injectFault(faults, "deleteMarker", "after");

    return {
      checkpoint_id: finalized.checkpoint_id,
      commit_id: commitId,
      event_id: marker.event_id,
      sha256: finalized.sha256,
      checkpoint_file: finalPath,
      pointer,
      validation: marker.payload.validation
    };
  }

  // 列出 agentDir 下的提交 marker（升序）。
  async function listCommitMarkers() {
    const files = await fs.readdir(root).catch(() => []);
    return files
      .filter((name) => name.startsWith(COMMIT_MARKER_PREFIX) && name.endsWith(".json"))
      .sort();
  }

  // 清理候选文件 + 未被 active 指针或任何 marker 引用的孤儿正式文件。
  // 引用集合必须同时包含 marker.checkpoint_id（新指针）与 marker.old_pointer.checkpoint_id
  //（源 checkpoint）——裁决 1/2/3 处理期间源 checkpoint 是旧上下文的正式文件，不得清理。
  async function sweepOrphans(pointer, markers, report) {
    const referenced = new Set(markers.map((marker) => marker.checkpoint_id));
    for (const marker of markers) {
      if (marker.old_pointer?.checkpoint_id != null) referenced.add(marker.old_pointer.checkpoint_id);
    }
    if (pointer.checkpoint_id != null) referenced.add(pointer.checkpoint_id);
    const files = await fs.readdir(checkpointsDir).catch(() => []);
    for (const name of files) {
      const targetPath = path.join(checkpointsDir, name);
      if (name.startsWith(CANDIDATE_PREFIX)) {
        await removeIfExists(targetPath);
        report.cleaned.push(`checkpoints/${name}`);
        continue;
      }
      if (name.startsWith(FORMAL_PREFIX) && name.endsWith(".json")) {
        const id = name.slice(FORMAL_PREFIX.length, name.length - ".json".length);
        if (!referenced.has(id)) {
          await removeIfExists(targetPath);
          report.cleaned.push(`checkpoints/${name}`);
        }
      }
    }
  }

  async function journalHasEventId(journal, eventId) {
    if (eventId == null) return false;
    const events = await journal.read({ afterSeq: 0 });
    return events.some((event) => event?.event_id === eventId);
  }

  async function hasCompletedForCheckpoint(journal, checkpointId) {
    const events = await journal.read({ afterSeq: 0 });
    return events.some(
      (event) => event?.type === "context_compaction_completed" && event?.payload?.checkpoint_id === checkpointId
    );
  }

  // 该 compaction_id 最近一次压缩事件是否无终态（started/running/cancel_requested）。
  async function hasNonTerminalCompaction(journal, compactionId) {
    if (compactionId == null) return false;
    const events = await journal.read({ afterSeq: 0 });
    let latest = null;
    for (const event of events) {
      if (!COMPACTION_EVENT_TYPES.includes(event?.type)) continue;
      if (event?.payload?.compaction_id !== compactionId) continue;
      latest = event;
    }
    return latest != null && COMPACTION_NON_TERMINAL.has(latest.type);
  }

  function buildFailedPayload(marker, errorCode) {
    return {
      ...(marker.payload ?? {}),
      error_code: errorCode,
      cancel_reason: null
    };
  }

  // 崩溃对账（brief Step 4 四个固定裁决 + 孤儿清理）。返回
  // { status: "noop" | "reconciled" | "corrupt", verdict, cleaned, appended, error }。
  async function reconcileAfterCrash({ journal } = {}) {
    if (journal == null) {
      throw checkpointError("checkpoint_reconcile_requires_journal", "reconcileAfterCrash 需要 journal");
    }
    const report = { status: "noop", verdict: null, cleaned: [], appended: [], error: null };
    const pointer = await readActive();
    const markerNames = await listCommitMarkers();
    const markers = [];
    for (const name of markerNames) {
      const parsed = await readJson(path.join(root, name), null);
      if (parsed != null && typeof parsed === "object") markers.push(parsed);
    }
    await sweepOrphans(pointer, markers, report);

    if (markers.length === 0) {
      // 裁决 4：active 指针指向新 checkpoint 但 marker 缺失且 Journal 无 completed
      // → 存储损坏，暴露可诊断错误，不得猜测回滚。
      if (pointer.checkpoint_id != null) {
        const completed = await hasCompletedForCheckpoint(journal, pointer.checkpoint_id);
        const formalExists = await pathExists(formalFilePath(root, pointer.checkpoint_id));
        if (!completed || !formalExists) {
          const error = checkpointError(
            "checkpoint_corrupt",
            `存储损坏：active 指针指向 checkpoint ${pointer.checkpoint_id}，但缺少提交 marker，且 Journal 无对应 context_compaction_completed 事件（不得猜测回滚）`
          );
          error.checkpoint_id = pointer.checkpoint_id;
          report.status = "corrupt";
          report.verdict = "4_storage_corrupt";
          report.error = error;
          throw error;
        }
      }
      return report;
    }

    for (const marker of markers) {
      const markerName = markerNames[markers.indexOf(marker)];
      const switched = pointer.checkpoint_id === marker.checkpoint_id;
      const completedPresent = await journalHasEventId(journal, marker.event_id);
      if (!switched) {
        // 裁决 1：旧上下文继续生效；删除未提交正式文件与 marker；非终态追加 failed。
        await removeIfExists(formalFilePath(root, marker.checkpoint_id));
        await removeIfExists(path.join(root, markerName));
        report.cleaned.push(`checkpoints/${FORMAL_PREFIX}${marker.checkpoint_id}.json`);
        report.cleaned.push(markerName);
        if (await hasNonTerminalCompaction(journal, marker.payload?.compaction_id)) {
          await journal.append({
            type: "context_compaction_failed",
            payload: buildFailedPayload(marker, "commit_not_switched")
          });
          report.appended.push("context_compaction_failed");
        }
        report.verdict = "1_pointer_not_switched";
      } else if (!completedPresent) {
        // 裁决 2：用 marker 保存的完整 payload 补写同一 completed（同 event_id），再删 marker。
        await journal.append({ event_id: marker.event_id, type: "context_compaction_completed", payload: marker.payload });
        await removeIfExists(path.join(root, markerName));
        report.appended.push("context_compaction_completed");
        report.cleaned.push(markerName);
        report.verdict = "2_completed_reappended";
      } else {
        // 裁决 3：指针与 completed 都已是新值，只删 marker。
        await removeIfExists(path.join(root, markerName));
        report.cleaned.push(markerName);
        report.verdict = "3_marker_cleaned";
      }
    }
    report.status = "reconciled";
    return report;
  }

  return {
    readActive,
    writeCandidate,
    validateCandidate,
    commitCandidate,
    discardCandidate,
    reconcileAfterCrash
  };
}
