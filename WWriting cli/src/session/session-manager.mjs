// 会话管理器：会话选择（--continue / --resume）、FIFO 队列状态机与跨进程独占写入。
//
// 布局约定（全部位于应用私有工作区目录，绝不进入创作目录）：
//   sessions/<session-id>/events.jsonl   事件日志（真相源）
//   sessions/<session-id>/state.json     投影缓存（可随时从日志重建）
//   locks/<session-id>                   会话写锁（复用 acquireSessionLock，一会话一把）
//
// 并发约定：
//   openLatest / openById / create 返回的会话句柄持有写锁，句柄上的全部写入都在锁内完成；
//   第二个进程（或本进程的第二次打开）拿不到写锁时收到 SESSION_BUSY；
//   snapshot 与 list 只读、不取锁，第二个进程始终可以查看。
import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireSessionLock } from '../storage/process-lock.mjs';
import { createEventStore, foldEvents } from './event-store.mjs';
import { recoverSession } from './recovery.mjs';
// 轮次数由历史投影给出（真实对话轮次，不是事件数）。
import { projectTurns } from '../agent/history.mjs';

const HANDLE_MARKER = 'wwriting-session-handle';

function assertHandle(handle, action) {
  if (!handle || handle.__kind !== HANDLE_MARKER) {
    throw new Error(`执行 ${action} 前需要先通过 openLatest、openById 或 create 打开会话。`);
  }
}

export function createSessionManager({
  workspaceStore,
  eventStoreFactory = (options) => createEventStore(options),
  clock = Date.now,
  idFactory = randomUUID,
  pid = process.pid,
  staleAfterMs = 30_000,
} = {}) {
  if (
    !workspaceStore
    || typeof workspaceStore.ensure !== 'function'
    || typeof workspaceStore.sessionsRoot !== 'function'
    || typeof workspaceStore.directoryFor !== 'function'
  ) {
    throw new Error('创建会话管理器需要有效的 workspaceStore。');
  }

  function sessionDirFor(projectRoot, sessionId) {
    return path.join(workspaceStore.sessionsRoot(projectRoot), sessionId);
  }

  function lockPathFor(projectRoot, sessionId) {
    return path.join(workspaceStore.directoryFor(projectRoot, 'locks'), sessionId);
  }

  // 会话 ID 的入口校验（宽松口径：只禁危险字符，不强制 UUID 形状）。
  // ID 会原样进 path.join 的尾部，而 sessions 与 locks 是同级兄弟目录：含分隔符或「..」的
  // ID 会把锁路径归一化成会话目录本身，锁抢占按 mtime 判 stale 后会把整个会话目录改名搬走
  // （缺陷猎捕报告第 2 条）。正常来源（randomUUID、list() 回填、选择器）不会命中任何禁令；
  // 控制字符一并禁掉，错误文案才不会把转义序列写进终端。
  function assertUsableSessionId(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new Error('会话 ID 不能为空。');
    }
    if (sessionId.length > 128) {
      throw new Error(`会话 ID 过长（${sessionId.length} 字符，上限 128）。`);
    }
    for (let i = 0; i < sessionId.length; i += 1) {
      const ch = sessionId[i];
      if (sessionId.charCodeAt(i) < 32 || sessionId.charCodeAt(i) === 127) {
        throw new Error(`会话 ID 含有不允许的控制字符（码位 ${sessionId.charCodeAt(i)}）。`);
      }
      if (ch === '/' || ch === '\\' || ch === ':') {
        throw new Error(`会话 ID 含有不允许的字符：「${ch}」。`);
      }
    }
    if (sessionId.includes('..')) {
      throw new Error('会话 ID 不能包含「..」。');
    }
  }

  async function hasEventLog(sessionDir) {
    try {
      await stat(path.join(sessionDir, 'events.jsonl'));
      return true;
    } catch (error) {
      if (error && error.code === 'ENOENT') return false;
      throw new Error(`无法检查会话目录：${sessionDir}`, { cause: error });
    }
  }

  async function acquireLock(projectRoot, sessionId) {
    const workspace = await workspaceStore.ensure(projectRoot);
    return acquireSessionLock(lockPathFor(projectRoot, sessionId), {
      pid,
      staleAfterMs,
      sessionId,
      workspaceRoot: workspace.workspaceDir,
      clock,
    });
  }

  // 打开即修复：日志尾行修复 → 重启恢复 → 载入投影。
  async function openWriter(projectRoot, sessionId, sessionDir) {
    const lock = await acquireLock(projectRoot, sessionId);
    try {
      const store = eventStoreFactory({ sessionDir, clock, idFactory });
      const repairResult = await store.repair();
      await recoverSession({ eventStore: store, truncatedTail: repairResult.truncatedTail });
      const projection = await store.currentProjection();
      return makeHandle({ sessionId, sessionDir, lock, store, projection });
    } catch (error) {
      await lock.release();
      throw error;
    }
  }

  function makeHandle({ sessionId, sessionDir, lock, store, projection }) {
    const handle = {
      __kind: HANDLE_MARKER,
      sessionId,
      directory: sessionDir,
      eventStore: store,
      projection,
      // 重新从存储载入当前投影。
      async refresh() {
        handle.projection = await store.currentProjection();
        return handle.projection;
      },
      // 提交新输入：空闲（无运行、无活跃输入、队列空）时成为活跃输入；忙碌时按 FIFO 排队。
      // inputId 可选（/retry 用）：复用原输入的 ID 重跑同一件事——历史装配的
      // 「排除当前输入」因此天然把失败尝试整体排除出上下文，不需要任何特判。
      async submit({ text, inputId } = {}) {
        if (typeof text !== 'string' || text.trim() === '') {
          throw new Error('输入内容不能为空。');
        }
        const id = inputId === undefined || inputId === null ? String(idFactory()) : inputId;
        if (typeof id !== 'string' || id === '') {
          throw new Error('输入 ID 必须是非空字符串。');
        }
        const current = await store.currentProjection();
        const busy = current.active_run_id !== null
          || current.active_input_id !== null
          || current.queue.length > 0;
        await store.append(busy
          ? { type: 'input_queued', data: { input_id: id, text } }
          : { type: 'input_submitted', data: { input_id: id, text } });
        handle.projection = await store.currentProjection();
        return { input_id: id, queued: busy };
      },
      // 显式排队：始终追加到队尾。
      async enqueue({ text } = {}) {
        if (typeof text !== 'string' || text.trim() === '') {
          throw new Error('输入内容不能为空。');
        }
        const inputId = String(idFactory());
        await store.append({ type: 'input_queued', data: { input_id: inputId, text } });
        handle.projection = await store.currentProjection();
        return { input_id: inputId };
      },
      // 「立即」：把指定的一个排队输入提升到队首，其余保持 FIFO；实际打断由上层控制器完成。
      async promote(inputId) {
        if (typeof inputId !== 'string' || inputId === '') {
          throw new Error('提升排队输入需要输入 ID。');
        }
        const current = await store.currentProjection();
        if (current.queue.length === 0) {
          throw new Error('队列为空，没有可提升的输入。');
        }
        if (!current.queue.some((item) => item.input_id === inputId)) {
          throw new Error(`排队输入不存在或已撤回：${inputId}`);
        }
        await store.append({ type: 'input_promoted', data: { input_id: inputId } });
        handle.projection = await store.currentProjection();
        return { input_id: inputId };
      },
      // 撤回一个排队输入。
      async withdraw(inputId) {
        if (typeof inputId !== 'string' || inputId === '') {
          throw new Error('撤回排队输入需要输入 ID。');
        }
        const current = await store.currentProjection();
        if (!current.queue.some((item) => item.input_id === inputId)) {
          throw new Error(`排队输入不存在或已撤回：${inputId}`);
        }
        await store.append({ type: 'input_withdrawn', data: { input_id: inputId } });
        handle.projection = await store.currentProjection();
        return { input_id: inputId };
      },
      // 队列里的一条输入真正开跑前，先记一笔。
      //
      // 为什么需要它：`排队` 那一行原本会一直赖在屏幕上——消费队列时没有任何事件标记
      // 「轮到它了」，用户看到的是「排队」二字挂了很久，然后是凭空冒出来的输出，分不清
      // 属于哪一条（队列按 FIFO 消费，可能就是更早的那条）。渲染层据此把排队行换成
      // 正常的用户行，屏幕上的账才对得上。
      //
      // 只对**排队过的**输入发：当场敲的那条已经由 readline 回显过，再发一次就会画两行。
      async markStarted(inputId) {
        if (typeof inputId !== 'string' || inputId === '') return null;
        const current = await store.currentProjection();
        const queued = current.queue.find((item) => item.input_id === inputId);
        if (!queued) return null; // 没排过队（当场提交的）或已撤回：不发，保持事件日志干净。
        await store.append({
          type: 'input_started',
          data: { input_id: inputId, text: queued.text ?? null },
        });
        handle.projection = await store.currentProjection();
        return { input_id: inputId, text: queued.text ?? null };
      },
      // 运行期事件（run_*、decision_* 等）由上层通过会话存储追加，写入同样在锁内。
      append: (partial) => store.append(partial),
      appendBatch: (partials) => store.appendBatch(partials),
      // 释放写锁（幂等）。
      async close() {
        return lock.release();
      },
    };
    return handle;
  }

  // 新建会话：生成会话 ID、建立目录、写入 session_created。无历史才创建由 openLatest 把关。
  async function create(projectRoot, { title = '' } = {}) {
    if (typeof title !== 'string') {
      throw new Error('会话标题必须是字符串。');
    }
    await workspaceStore.ensure(projectRoot);
    const sessionId = String(idFactory());
    const sessionDir = sessionDirFor(projectRoot, sessionId);
    try {
      await mkdir(sessionDir);
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        throw new Error(`会话 ID 已存在：${sessionId}`);
      }
      throw new Error(`无法创建会话目录：${sessionDir}`, { cause: error });
    }
    const lock = await acquireLock(projectRoot, sessionId);
    try {
      const store = eventStoreFactory({ sessionDir, clock, idFactory });
      await store.append({ type: 'session_created', session_id: sessionId, data: { title } });
      const projection = await store.currentProjection();
      return makeHandle({ sessionId, sessionDir, lock, store, projection });
    } catch (error) {
      await lock.release();
      throw error;
    }
  }

  async function openById(projectRoot, sessionId) {
    assertUsableSessionId(sessionId);
    await workspaceStore.ensure(projectRoot);
    const sessionDir = sessionDirFor(projectRoot, sessionId);
    if (!(await hasEventLog(sessionDir))) {
      throw new Error(`会话不存在：${sessionId}`);
    }
    return openWriter(projectRoot, sessionId, sessionDir);
  }

  // --continue：选 updated_at 最大的**有内容**非归档会话；无历史时按 createIfMissing 决定是否创建。
  //
  // 为什么要跳过 0 轮会话：裸启动会先建一个空会话、再按 ID 打开它（ADR-0010），
  // 那个空壳立刻带上最新的 updated_at。若只按 updated_at 取最大，`-c`（用户心里想的
  // 是「接着上次的活干」）就会打开这个空壳，而不是用户真正写过的那部作品。
  // 所以先在**有 turn** 的候选里取最新；只有全部候选都是空的（用户确实还没写过任何东西）
  // 才退回最新的那个——否则全新目录里 `-c` 会挑不出任何会话。
  async function openLatest(projectRoot, { createIfMissing = true } = {}) {
    const summaries = await list(projectRoot);
    const candidates = summaries.filter((summary) => summary.status !== 'archived');
    if (candidates.length === 0) {
      return createIfMissing ? create(projectRoot) : null;
    }
    // turns 由 list() 的投影给出（真实对话轮次，不是事件数）。
    const withContent = candidates.filter((summary) => (summary.turns ?? 0) > 0);
    const pool = withContent.length > 0 ? withContent : candidates;
    let latest = pool[0];
    for (const summary of pool) {
      if (summary.updated_at > latest.updated_at) latest = summary;
    }
    return openById(projectRoot, latest.session_id);
  }

  // 只读快照：不取锁、不落盘。缓存缺失或损坏时直接从日志在内存重建。
  async function snapshot(projectRoot, sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new Error('会话 ID 不能为空。');
    }
    const sessionDir = sessionDirFor(projectRoot, sessionId);
    if (!(await hasEventLog(sessionDir))) {
      throw new Error(`会话不存在：${sessionId}`);
    }
    const store = eventStoreFactory({ sessionDir, clock, idFactory });
    return (await store.rebuildProjection()).projection;
  }

  async function list(projectRoot) {
    const sessionsDir = workspaceStore.sessionsRoot(projectRoot);
    let entries;
    try {
      entries = await readdir(sessionsDir, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      throw new Error(`无法读取会话目录：${sessionsDir}`, { cause: error });
    }
    const summaries = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sessionDir = path.join(sessionsDir, entry.name);
      if (!(await hasEventLog(sessionDir))) continue;
      const store = eventStoreFactory({ sessionDir, clock, idFactory });
      // 同一趟读里同时拿到投影与轮次：rebuildProjection 本来就已把日志全量读了一遍，
      // 再为轮次多读一次 log 是白花的 I/O。
      const { events } = await store.readAll();
      const projection = foldEvents(events);
      summaries.push({
        session_id: projection.session_id ?? entry.name,
        status: projection.status,
        title: projection.title,
        created_at: projection.created_at,
        updated_at: projection.updated_at,
        last_seq: projection.last_seq,
        // 轮次数是**真实对话轮次**（run_started 的条数），不是事件数。
        // 绝不能把 last_seq 当轮次数显示：一轮对话会产生几十条事件，
        // 那样算出来的数字会让用户对「这个会话有多少上下文」判断离谱。
        turns: projectTurns(events).length,
      });
    }
    summaries.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
    return summaries;
  }

  return {
    openLatest,
    openById,
    create,
    submit: async (handle, options) => {
      assertHandle(handle, 'submit');
      return handle.submit(options);
    },
    enqueue: async (handle, options) => {
      assertHandle(handle, 'enqueue');
      return handle.enqueue(options);
    },
    promote: async (handle, inputId) => {
      assertHandle(handle, 'promote');
      return handle.promote(inputId);
    },
    withdraw: async (handle, inputId) => {
      assertHandle(handle, 'withdraw');
      return handle.withdraw(inputId);
    },
    snapshot,
    list,
  };
}
