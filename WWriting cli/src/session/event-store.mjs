// 会话事件存储：events.jsonl 是唯一真相源，state.json 只是可随时重建的投影缓存。
// 写入顺序固定：先一次性追加完整 JSONL 行，再用“同目录临时文件 + rename”原子更新 state.json。
// 不完整的尾行（进程在写入途中崩溃的残留）不是事件：只读视角直接忽略；
// 写模式下被截断，并追加 log_tail_truncated 恢复事件留证（复用被丢弃尾行的 seq，日志 seq 保持从 1 连续）。
// 本模块不做跨进程加锁；写入方（会话管理器的会话句柄）必须先持有 session lock 再调用。
import { mkdir, readFile, writeFile, rename, open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const EVENT_SCHEMA_VERSION = 1;

// 有界读（readTail）的字节块步长。测试可经 createEventStore 的 tailChunkBytes 注入小值，
// 专门锤跨块行拼接与多字节字符跨界。
const TAIL_CHUNK_BYTES = 256 * 1024;

// 锚点校验窗（tryLoadFromAnchor）：只需罩住最后一个写入批次，见 tryLoadFromAnchor 的注释。
const ANCHOR_WINDOW_BYTES = 1024 * 1024;

// 锚点封面校验：形状齐全才可作投影初值。turns 与 digest 的在位**共同**兼作版本标记：
// 封面化（T1）先于摘要进投影（T2），只查 turns 会放行「有 turns 无 digest」的中间形状——
// 那种封面命中锚点会把已压缩会话当成从未压缩（被覆盖轮次以原文回灌上下文，记忆丢失），
// 所以两个键必须同时在位，缺一律回退全量折算，重开一次即被 repair 重写成新形状。
function validAnchorProjection(state) {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return false;
  if (typeof state.session_id !== 'string' || state.session_id === '') return false;
  if (!Number.isInteger(state.last_seq) || state.last_seq < 0) return false;
  if (!Number.isInteger(state.turns) || state.turns < 0) return false;
  if (typeof state.status !== 'string' || state.status === '') return false;
  if (typeof state.updated_at !== 'string' || state.updated_at === '') return false;
  if (!Array.isArray(state.queue) || !Array.isArray(state.transient_grants)) return false;
  if (!('digest' in state)) return false;
  if (state.digest !== null && (typeof state.digest !== 'object' || Array.isArray(state.digest))) return false;
  if (state.active_run_id !== null && typeof state.active_run_id !== 'string') return false;
  if (state.active_input_id !== null && typeof state.active_input_id !== 'string') return false;
  if (state.active_input !== null && (typeof state.active_input !== 'object' || Array.isArray(state.active_input))) return false;
  if (state.plan !== null && (typeof state.plan !== 'object' || Array.isArray(state.plan))) return false;
  return true;
}

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
  // 当前生效的会话摘要（/compact 的产物，规格 2026-10-06 回填）。fold 见过每一条
  // digest_compacted，摘要「有没有、是什么、覆盖到哪」因此是 O(1) 的投影事实——
  // loadHistory 据此定向回读（untilSeq = through_seq），绝不需要为找摘要扫描日志。
  // covered_total = 摘要生效时被覆盖的轮次总数；旧事件没有该字段 → null（消费方降级为
  // 不带数字的说法）。文本只进投影与 state.json，绝不伪装成对话轮次（铁律同 /compact）。
  digest: null,
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
    case 'session_renamed':
      // 标题只认非空字符串（规格 2026-10-07 D1）：清空标题不是一次改名该干的事，
      // 畸形数据不更新只推进 seq（与 digest_compacted 同纪律）。
      if (typeof data.title === 'string' && data.title !== '') projection.title = data.title;
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
        const queuedItem = from !== -1 ? projection.queue.splice(from, 1)[0] : null;
        const previousActiveText = projection.active_input_id === inputId
          ? projection.active_input?.text ?? null
          : null;
        projection.active_input_id = inputId;
        projection.active_input = {
          input_id: inputId,
          // 输入文本三级回退（规格 2026-10-06 D6）：排队项自带 → 已是活跃输入的原文 →
          // inputs Map。跨锚点打开时 Map 是空的（输入全文不进封面），排队跨锚点开的轮由
          // 队列项兜住。都不命中只剩 null——只影响投影展示字段；历史装配的轮次文本来自
          // run_started.data.text 事件本体，不经过这里。
          text: queuedItem?.text ?? previousActiveText ?? state.inputs.get(inputId)?.text ?? null,
        };
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
    case 'digest_compacted': {
      // 只认有效摘要（与 history.latestDigest 同判据）；畸形数据不更新，只推进 seq。
      if (typeof data.digest === 'string' && data.digest !== '') {
        projection.digest = {
          text: data.digest,
          through_seq: Number.isInteger(data.through_seq) ? data.through_seq : 0,
          covered_total: Number.isInteger(data.covered_total) && data.covered_total >= 0
            ? data.covered_total
            : null,
        };
      }
      break;
    }
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

export function createEventStore({ sessionDir, clock = Date.now, idFactory = randomUUID, tailChunkBytes = TAIL_CHUNK_BYTES } = {}) {
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

  // —— 有界读（规格 2026-10-06 D3）：从 EOF 按字节块向前回读，只取预算内的尾部事实 ——
  //
  // 全量读（readRaw）的仪式——seq 全程连续校验——属于「重建真相」；有界读只服务三个
  // 消费方：loadHistory 读到预算装满、/retry 读最后一轮、打开锚点校验尾窗（T3）。
  // 停止三态：fileStart（到达文件起点，结果即全量）/ seqBoundary（已收集到 seq ≤ untilSeq
  // 的事件，返回前滤除）/ byteLimit（字节上限——窗口最老一端可能截在轮中途，消费方据此
  // 扩窗、退全量、或按「N+」口径计数）。seq 全程连续校验不在此做；逐行仍走 parseLine，
  // 坏行照抛不静默。
  //
  // 跨块拼接的簿记（0x0a 字节切安全：换行字节不出现在 UTF-8 多字节序列里，readRaw 同款注释）：
  // 后读的块处于更低的字节区。一个跨块行的**尾段**在晚读的块里（首段到首个换行为止），
  // **头段**在早读的块里（末个换行之后到块尾）——carry 就是这条待拼的尾段，随回读逐块向文件
  // 前方传递。到文件起点仍未闭合的 carry 即最后一行的头，拼接收尾。
  async function readTail({ maxBytes = TAIL_CHUNK_BYTES, untilSeq = 0 } = {}) {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error('readTail 需要正整数 maxBytes。');
    if (!Number.isInteger(untilSeq) || untilSeq < 0) throw new Error('readTail 需要非负整数 untilSeq。');

    let handle;
    try {
      handle = await open(eventsPath, 'r');
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return { events: [], truncatedTail: false, stop: 'fileStart', keepBytes: 0, removedBytes: 0 };
      }
      throw new Error(`无法读取事件日志：${eventsPath}`, { cause: error });
    }

    try {
      const { size } = await handle.stat();
      if (size === 0) {
        return { events: [], truncatedTail: false, stop: 'fileStart', keepBytes: 0, removedBytes: 0 };
      }

      const emptyBuffer = Buffer.alloc(0);
      const found = []; // 每块一组的完整行（组内字节升序；组间按回读次序 = 文件降序）。
      let carry = null;
      let partialMode = false; // 残行仍向上延伸中（残行可跨多块，见下）。
      let truncatedTail = false;
      let removedBytes = 0;
      let readBytes = 0;
      let stop = null;
      let pos = size;
      let firstChunk = true;

      while (pos > 0 && stop === null) {
        const budgetLeft = maxBytes - readBytes;
        if (budgetLeft <= 0) { stop = 'byteLimit'; break; }
        const chunkSize = Math.min(tailChunkBytes, pos, budgetLeft);
        const chunk = Buffer.alloc(chunkSize);
        const { bytesRead } = await handle.read(chunk, 0, chunkSize, pos - chunkSize);
        if (bytesRead === 0) { stop = 'fileStart'; break; } // 防御：文件在读取途中变小。
        pos -= bytesRead;
        readBytes += bytesRead;
        const atFileStart = pos === 0;

        const parts = [];
        let lineStart = 0;
        for (let i = 0; i < bytesRead; i += 1) {
          if (chunk[i] === 0x0a) { parts.push(chunk.subarray(lineStart, i)); lineStart = i + 1; }
        }
        const lastPart = chunk.subarray(lineStart);

        const chunkLines = []; // 本块发现的完整行，升序。
        if (firstChunk) {
          firstChunk = false;
          // EOF 尾行不完整 = 崩溃残留，不是事件（与 readRaw 同判据）。残尾 = lastPart，弃。
          truncatedTail = lastPart.length > 0;
          removedBytes = lastPart.length;
          partialMode = truncatedTail && parts.length === 0; // 残行是否还向上跨块。
          if (parts.length > 0) {
            // 首块无 carry 可拼：lastPart 即使像行头也只是残尾，不参与拼接。
            if (atFileStart) chunkLines.push(parts[0]);
            else carry = parts[0]; // 跨下界行的尾段，等更早的块拼它的行头。
            for (let i = 1; i < parts.length; i += 1) chunkLines.push(parts[i]);
          }
          // parts.length === 0：整块都是残尾——无完整行、无 carry，落到下方统一判停。
        } else if (partialMode) {
          // 残行仍在向上延伸：整块无换行 → 整块都是残行；遇到换行 → 残行在本块的
          // lastPart 处收口（头段计入残尾），其余段恢复常规处理（carry 必为 null——
          // 残行独占 EOF 一侧，没有真实行跨过它与上块的边界）。
          if (parts.length === 0) {
            removedBytes += bytesRead;
          } else {
            removedBytes += lastPart.length;
            partialMode = false;
            if (atFileStart) chunkLines.push(parts[0]);
            else carry = parts[0];
            for (let i = 1; i < parts.length; i += 1) chunkLines.push(parts[i]);
          }
        } else if (parts.length === 0) {
          // 整块无换行：整块是跨上界行的**头**段，与 carry（它的尾）拼接；
          // 到文件起点即收尾成完整行，否则它仍是中间 fragment，继续作为 carry 下传。
          const joined = Buffer.concat([lastPart, carry ?? emptyBuffer]);
          if (atFileStart) chunkLines.push(joined);
          else carry = joined;
        } else {
          if (atFileStart) chunkLines.push(parts[0]);
          for (let i = 1; i < parts.length; i += 1) chunkLines.push(parts[i]);
          // 末段（本块最高偏移）是跨上界行的**头**，与 carry（它的尾）拼成完整行；
          // carry 为 null 只发生在首块——首块已把 lastPart 当残尾弃掉，不拼。
          if (carry !== null) chunkLines.push(Buffer.concat([lastPart, carry]));
          carry = atFileStart ? null : parts[0];
        }

        if (chunkLines.length > 0) found.push(chunkLines);

        if (stop === null) {
          if (atFileStart) stop = 'fileStart';
          else if (readBytes >= maxBytes) stop = 'byteLimit';
          else if (untilSeq > 0 && chunkLines.length > 0) {
            // 本块最早一行（chunkLines[0]）的 seq ≤ untilSeq 即越过边界；多余的低 seq 行最后滤除。
            const earliest = parseLine(chunkLines[0].toString('utf8'), 0);
            if (earliest.seq <= untilSeq) stop = 'seqBoundary';
          }
        }
      }

      // 组间倒排（回读次序 → 文件次序），组内本就升序。
      // ⚠️ removedBytes / keepBytes 的语义边界：窗口被 byteLimit 截断**且零完整行**时，
      // removedBytes 只是窗口视图值（= 已读字节数），不是真实残尾长——keepBytes 会偏大。
      // 当前唯一消费方 tryLoadFromAnchor 被「锚点命中 ⟹ 残尾起点必在窗内 ⟹ 簿记精确」
      // 这条蕴含关系守卫；未来任何在 byteLimit 状态下拿这两个值截断日志的消费者必须先扩窗。
      const lines = [];
      for (let i = found.length - 1; i >= 0; i -= 1) lines.push(...found[i]);
      const events = lines.map((line) => parseLine(line.toString('utf8'), 0));
      events.sort((a, b) => a.seq - b.seq);
      const filtered = untilSeq > 0 ? events.filter((event) => event.seq > untilSeq) : events;
      return { events: filtered, truncatedTail, stop, keepBytes: size - removedBytes, removedBytes };
    } finally {
      await handle.close();
    }
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
    const anchor = await tryLoadFromAnchor();
    if (anchor !== null) {
      cache = anchor;
      return cache;
    }
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

  // 锚点快路（规格 2026-10-06 T3/D6）：state.json 是每次 append 都原子重写的投影缓存，
  // 校验 last_seq 在尾部窗口真实在册后，以它为投影初值、只增量重放其后的增量事件——
  // 打开大会话不再全量折算。任何一环不成立（封面缺失/损坏/形状不对/last_seq 不在窗内）
  // 都整体回退全量折算：锚点是快路，不是信任的替代品（ADR-0001 纪律不变）。
  //
  // 窗口取 1 MiB 的理由：last_seq 对应的事件是最后一次成功 append 的最后一条（state.json
  // 紧随其后原子重写），只可能落在日志末尾一个批次内；单条事件最大也就思考正文量级，
  // 1 MiB 绰绰有余。找不到即视为脱节，宁可全量也不赌。
  async function tryLoadFromAnchor() {
    let state;
    try {
      state = JSON.parse(await readFile(statePath, 'utf8'));
    } catch {
      return null; // 缺失 / 损坏：走全量。
    }
    if (!validAnchorProjection(state)) return null;
    let tail;
    try {
      tail = await readTail({ maxBytes: ANCHOR_WINDOW_BYTES });
    } catch {
      return null; // 尾窗内有坏行等读取异常：走全量。
    }
    const anchorEvent = tail.events.find((event) => event.seq === state.last_seq);
    if (anchorEvent === undefined || anchorEvent.session_id !== state.session_id) return null;

    const projection = state;
    const fold = { projection, inputs: new Map() };
    for (const event of tail.events) {
      if (event.seq > state.last_seq) applyEvent(fold, event);
    }
    rememberedSessionId = state.session_id;
    tailInfo = {
      state: tail.truncatedTail ? 'truncated' : 'clean',
      keepBytes: tail.keepBytes,
      removedBytes: tail.removedBytes,
    };
    return { fold };
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

  return { append, appendBatch, readAll, readTail, tail, rebuildProjection, repair, currentProjection };
}
