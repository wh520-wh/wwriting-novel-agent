// 会话事件存储：events.jsonl 是唯一真相源，state.json 只是可随时重建的投影缓存。
// 写入顺序固定：先一次性追加完整 JSONL 行，再用“同目录临时文件 + rename”原子更新 state.json。
// 不完整的尾行（进程在写入途中崩溃的残留）不是事件：只读视角直接忽略；
// 写模式下被截断，并追加 log_tail_truncated 恢复事件留证（复用被丢弃尾行的 seq，日志 seq 保持从 1 连续）。
// 本模块不做跨进程加锁；写入方（会话管理器的会话句柄）必须先持有 session lock 再调用。
import { mkdir, readFile, writeFile, rename, open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const EVENT_SCHEMA_VERSION = 1;

// —— 投影折算（纯逻辑）：把事件序列折叠为会话当前状态 ——

const blankProjection = () => ({
  session_id: null,
  status: 'idle',
  active_run_id: null,
  active_input_id: null,
  active_input: null,
  queue: [],
  transient_grants: [],
  title: '',
  created_at: null,
  updated_at: null,
  last_seq: 0,
  // 真实对话轮次 = run_started 的条数（与 history.projectTurns 的口径逐字一致，含 open/重试轮）。
  // 随投影落进 state.json：list() 据此出「封面摘要」，不再为轮次全量读日志（规格 2026-10-06 D1）。
  turns: 0,
  // 当前任务计划（上一条 plan_updated 的整表，含 status）。null = 没有（Run 开始时清空，
  // 对齐上游统一行为规格书 §4.2 生命周期口径 A「新 Run 的 run_started 清空上一轮计划」；
  // Run 结束不清——scrollback 与 /plan 都要能回看）。
  plan: null,
});

function newFoldState() {
  return { projection: blankProjection(), inputs: new Map() };
}

function queueIndexOf(projection, inputId) {
  return projection.queue.findIndex((item) => item.input_id === inputId);
}

// Run 终态（完成 / 中断 / 失败）：清空当前轮并清空运行期间累积的临时授权。
function clearActiveRun(projection) {
  projection.active_run_id = null;
  projection.active_input_id = null;
  projection.active_input = null;
  projection.transient_grants = [];
  projection.status = 'idle';
}

function applyEvent(state, event) {
  const projection = state.projection;
  const data = event.data ?? {};
  const text = typeof data.text === 'string' ? data.text : null;
  switch (event.type) {
    case 'session_created':
      projection.session_id = event.session_id;
      projection.status = 'idle';
      projection.title = typeof data.title === 'string' ? data.title : '';
      projection.created_at = event.at;
      break;
    case 'session_archived':
      projection.status = 'archived';
      break;
    case 'input_submitted': {
      state.inputs.set(data.input_id, { input_id: data.input_id, text });
      projection.active_input_id = data.input_id;
      projection.active_input = { input_id: data.input_id, text };
      break;
    }
    case 'input_queued': {
      state.inputs.set(data.input_id, { input_id: data.input_id, text });
      projection.queue.push({ input_id: data.input_id, text, queued_at: event.at });
      break;
    }
    case 'input_promoted': {
      // 「立即」：只移动这一个输入到队首，其余保持 FIFO。
      const from = queueIndexOf(projection, data.input_id);
      if (from > 0) projection.queue.unshift(...projection.queue.splice(from, 1));
      break;
    }
    case 'input_withdrawn': {
      const from = queueIndexOf(projection, data.input_id);
      if (from !== -1) projection.queue.splice(from, 1);
      break;
    }
    case 'run_started': {
      projection.status = 'active';
      projection.active_run_id = event.run_id;
      // 新一轮开始：上一轮的任务计划随之作废（口径 A）。本轮没有计划就一直是 null，
      // /plan 与重演据此如实说「暂无」，绝不拿上一轮的旧计划冒充当前状态。
      projection.plan = null;
      projection.turns += 1;
      const inputId = typeof data.input_id === 'string' ? data.input_id : null;
      if (inputId !== null) {
        const from = queueIndexOf(projection, inputId);
        if (from !== -1) projection.queue.splice(from, 1);
        projection.active_input_id = inputId;
        projection.active_input = { input_id: inputId, text: state.inputs.get(inputId)?.text ?? null };
      }
      break;
    }
    case 'plan_updated': {
      // 整表替换：以本次 items 为准。畸形数据（非数组）不更新，只推进 seq。
      projection.plan = Array.isArray(data.items)
        ? { run_id: event.run_id ?? null, items: data.items }
        : projection.plan;
      break;
    }
    case 'run_completed':
    case 'run_interrupted':
    case 'run_failed':
      clearActiveRun(projection);
      break;
    case 'permission_granted':
      // 运行期临时授权：只存在于此轮，Run 终态时整体清空。
      projection.transient_grants.push(data.grant !== undefined ? data.grant : data);
      break;
    case 'session_recovered':
      projection.status = 'interrupted';
      break;
    default:
      // 未知事件类型（如未来任务新增的 activity/decision 事件）只推进 updated_at / last_seq。
      break;
  }
  projection.updated_at = event.at;
  projection.last_seq = event.seq;
  return state;
}

export function foldEvents(events) {
  const state = newFoldState();
  for (const event of events) applyEvent(state, event);
  return state.projection;
}

// —— 事件存储 ——

export function createEventStore({ sessionDir, clock = Date.now, idFactory = randomUUID } = {}) {
  if (typeof sessionDir !== 'string' || sessionDir.trim() === '') {
    throw new Error('事件存储需要有效的会话目录。');
  }
  const eventsPath = path.join(sessionDir, 'events.jsonl');
  const statePath = path.join(sessionDir, 'state.json');
  const stateTmpPath = path.join(sessionDir, 'state.json.tmp');

  // 写入方内存投影：锁内单写者，与日志始终一致；首次写入时从日志完整重建。
  let cache = null;
  let rememberedSessionId = null;
  // 尾行状态：'unknown'（未读过日志）/ 'clean' / 'truncated'（有不完整尾行待截断）。
  let tailInfo = { state: 'unknown', keepBytes: 0, removedBytes: 0 };

  const nowIso = () => new Date(clock()).toISOString();

  async function ensureDir() {
    await mkdir(sessionDir, { recursive: true });
  }

  function parseLine(line, lineNo) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`事件日志第 ${lineNo} 行损坏，无法作为事件解析。`, { cause: error });
    }
    if (
      parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
      || !Number.isInteger(parsed.seq) || parsed.seq < 1
      || typeof parsed.type !== 'string' || parsed.type === ''
    ) {
      throw new Error(`事件日志第 ${lineNo} 行不是有效的事件记录。`);
    }
    return parsed;
  }

  // 读原始日志：完整行才是事件；没有以换行结尾的最后一行视为崩溃残留，不算事件。
  async function readRaw() {
    let buf;
    try {
      buf = await readFile(eventsPath);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return { events: [], truncatedTail: false, keepBytes: 0, removedBytes: 0 };
      }
      throw new Error(`无法读取事件日志：${eventsPath}`, { cause: error });
    }
    const text = buf.toString('utf8');
    const truncatedTail = text.length > 0 && !text.endsWith('\n');
    const lastNewline = buf.lastIndexOf(0x0a); // 换行字节在 UTF-8 多字节序列中不会出现，字节截断安全。
    const keepBytes = truncatedTail ? lastNewline + 1 : buf.length;
    const removedBytes = buf.length - keepBytes;

    const completeLines = text.split('\n').slice(0, -1);
    const events = [];
    for (let i = 0; i < completeLines.length; i++) {
      const line = completeLines[i];
      if (line.trim() === '') continue;
      events.push(parseLine(line, i + 1));
    }
    // 密度校验：seq 必须从 1 起严格连续（截断恢复复用被丢弃尾行的 seq，仍然连续）。
    for (let i = 0; i < events.length; i++) {
      if (events[i].seq !== i + 1) {
        throw new Error(`事件日志 seq 不连续：第 ${i + 1} 个事件的 seq 应为 ${i + 1}，实际为 ${events[i].seq}。`);
      }
    }
    return { events, truncatedTail, keepBytes, removedBytes };
  }

  async function readAll() {
    const { events, truncatedTail } = await readRaw();
    return { events, truncatedTail };
  }

  async function tail(n) {
    if (!Number.isInteger(n) || n < 0) {
      throw new Error('tail 需要非负整数参数。');
    }
    const { events } = await readRaw();
    return n === 0 ? [] : events.slice(-n);
  }

  // 从日志重建投影：纯只读，可安全用于无锁 snapshot 与跨进程查看。
  async function rebuildProjection() {
    const { events, truncatedTail } = await readRaw();
    return { projection: foldEvents(events), truncatedTail };
  }

  async function loadForWrite() {
    if (cache) return cache;
    const raw = await readRaw();
    rememberedSessionId = raw.events.length > 0 ? raw.events[0].session_id : rememberedSessionId;
    const fold = newFoldState();
    for (const event of raw.events) applyEvent(fold, event);
    cache = { fold };
    tailInfo = {
      state: raw.truncatedTail ? 'truncated' : 'clean',
      keepBytes: raw.keepBytes,
      removedBytes: raw.removedBytes,
    };
    return cache;
  }

  // 当前内存投影（写入方视角；首次调用时从日志重建）。
  async function currentProjection() {
    await loadForWrite();
    return cache.fold.projection;
  }

  function buildEvent(partial, seq) {
    if (partial === null || typeof partial !== 'object' || Array.isArray(partial)) {
      throw new Error('事件必须是对象。');
    }
    if (typeof partial.type !== 'string' || partial.type.trim() === '') {
      throw new Error('事件类型 type 不能为空。');
    }
    const data = partial.data === undefined ? {} : partial.data;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('事件数据 data 必须是对象。');
    }
    const runId = partial.run_id === undefined ? null : partial.run_id;
    if (runId !== null && (typeof runId !== 'string' || runId === '')) {
      throw new Error('事件的 run_id 必须是非空字符串或 null。');
    }
    const sessionId = partial.session_id === undefined ? rememberedSessionId : partial.session_id;
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new Error('事件缺少 session_id，无法追加。');
    }
    const eventId = typeof partial.event_id === 'string' && partial.event_id !== ''
      ? partial.event_id
      : String(idFactory());
    return {
      schema_version: EVENT_SCHEMA_VERSION,
      seq,
      event_id: eventId,
      at: nowIso(),
      type: partial.type,
      session_id: sessionId,
      run_id: runId,
      data,
    };
  }

  async function truncateLog(keepBytes) {
    const handle = await open(eventsPath, 'r+');
    try {
      await handle.truncate(keepBytes);
    } finally {
      await handle.close();
    }
  }

  // state.json 原子更新：写同目录临时文件后 rename 覆盖。
  async function writeStateAtomic(projection) {
    await writeFile(stateTmpPath, `${JSON.stringify(projection, null, 2)}\n`, 'utf8');
    await rename(stateTmpPath, statePath);
  }

  // 追加一批事件：先全部构建校验（失败不留副作用），再截断残留尾行（如有）、
  // 一次性追加完整 JSONL 行、折叠进内存投影、原子更新 state.json。
  async function appendBatch(partials) {
    if (!Array.isArray(partials)) {
      throw new Error('appendBatch 需要事件数组。');
    }
    await ensureDir();
    await loadForWrite();
    const needsRepair = tailInfo.state === 'truncated';
    const pending = needsRepair && rememberedSessionId
      ? [{ type: 'log_tail_truncated', data: { removed_bytes: tailInfo.removedBytes } }, ...partials]
      : partials;
    const baseSeq = cache.fold.projection.last_seq;
    const events = pending.map((partial, index) => buildEvent(partial, baseSeq + 1 + index));
    if (events.length > 0) {
      // 记住本批事件归属的会话，后续追加未写 session_id 时沿用。
      rememberedSessionId = events[events.length - 1].session_id;
    }

    if (needsRepair) {
      await truncateLog(tailInfo.keepBytes);
      tailInfo = { state: 'clean', keepBytes: tailInfo.keepBytes, removedBytes: 0 };
    }
    if (events.length === 0) return [];
    await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, {
      encoding: 'utf8',
      flag: 'a',
    });
    for (const event of events) applyEvent(cache.fold, event);
    await writeStateAtomic(cache.fold.projection);
    return events;
  }

  async function append(partial) {
    return (await appendBatch([partial]))[0];
  }

  // 打开修复：截断不完整尾行（有完整事件时记录 log_tail_truncated 恢复事件），
  // 并无论缓存是否损坏都从日志重建 state.json，保证写前的缓存与真相源一致。
  async function repair() {
    await ensureDir();
    await loadForWrite();
    const truncated = tailInfo.state === 'truncated';
    if (truncated) {
      await appendBatch([]);
    } else {
      await writeStateAtomic(cache.fold.projection);
    }
    return { truncatedTail: truncated };
  }

  return { append, appendBatch, readAll, tail, rebuildProjection, repair, currentProjection };
}
