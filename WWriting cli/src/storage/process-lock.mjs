// 跨进程会话锁：用 mkdir(lockPath) 原子抢占（同一时刻只允许一个写入进程）。
// 锁目录固定包含四个标记文件：pid、session_id、started_at、workspace_root。
// stale 规则：持锁 PID 在本机仍存在（或存在但不可信号）时绝不判 stale；
// 无法确认进程存活时，只有锁龄超过 staleAfterMs 才允许恢复；
// started_at 不可读（建完目录即崩溃/断电）时以锁目录 mtime 估算锁龄，超过阈值同样可恢复；
// 恢复前先把原锁整体改名留证（先记录 owner，再清理原路径）；
// owner 落盘失败会自动清掉刚抢占的锁目录并抛中文错误，绝不留下无主锁。
import { mkdir, writeFile, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

// 会话锁错误：code 用于程序判断（SESSION_BUSY 等），message 是简体中文人话。
export class SessionLockError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'SessionLockError';
    this.code = code;
    this.details = details;
  }
}

// 探测本机进程存活：'alive' 存在；'dead' 确认不存在（ESRCH）；'unknown' 无法确认（EPERM 等）。
function defaultProbeAlive(pid) {
  // pid <= 0 会波及进程组或无效，按“无法确认”处理，绝不误判。
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    return error && error.code === 'ESRCH' ? 'dead' : 'unknown';
  }
}

// 尽力读取锁目录里的 owner 现场；缺文件返回 null，不抛错（半写入的锁按未知处理）。
async function readOwner(lockPath) {
  async function readMarker(name) {
    try {
      return (await readFile(path.join(lockPath, name), 'utf8')).trim();
    } catch {
      return null;
    }
  }
  const pidRaw = await readMarker('pid');
  const startedRaw = await readMarker('started_at');
  const pid = pidRaw === null ? null : Number.parseInt(pidRaw, 10);
  const startedAt = startedRaw === null ? null : Number.parseInt(startedRaw, 10);
  return {
    pid: Number.isFinite(pid) ? pid : null,
    startedAt: Number.isFinite(startedAt) ? startedAt : null,
    sessionId: await readMarker('session_id'),
    workspaceRoot: await readMarker('workspace_root'),
  };
}

async function writeOwner(lockPath, owner, writeFileImpl = writeFile) {
  const markers = {
    pid: String(owner.pid),
    session_id: owner.sessionId ?? '',
    started_at: String(owner.startedAt),
    workspace_root: owner.workspaceRoot ?? '',
  };
  await Promise.all(
    Object.entries(markers).map(([name, content]) => writeFileImpl(path.join(lockPath, name), content, 'utf8')),
  );
}

// started_at 不可读时的锁龄回退：取锁目录 mtime 估算。
// 空目录的 mtime 即创建时刻（胜者建完目录就崩溃的现场）；已落盘的目录 mtime ≈ 最后写入时刻。
// stat 失败按 0 处理：宁可当作刚出现，绝不凭空判过期。
async function dirAgeMs(lockPath, now) {
  try {
    const stats = await stat(lockPath);
    return Math.max(0, now - stats.mtimeMs);
  } catch {
    return 0;
  }
}

// 裁决已有锁：返回 { action: 'busy' | 'recover', ...事实 }。
// 事实全部进入 SESSION_BUSY 的错误详情，供“等待或改用新会话”的提示与折叠详情使用。
function judgeExisting(existing, { now, staleAfterMs, isAlive, fallbackAgeMs = 0 }) {
  // started_at 不可读（建完目录即崩溃/断电的残留）时回退用锁目录 mtime 估算锁龄，避免永远 busy。
  const ageMs = existing.startedAt === null ? fallbackAgeMs : Math.max(0, now - existing.startedAt);
  if (existing.pid === null) {
    return ageMs > staleAfterMs
      ? { action: 'recover', alive: 'unknown', ageMs }
      : { action: 'busy', alive: 'unknown', ageMs, reason: '无法读取持锁进程信息' };
  }
  const probe = isAlive(existing.pid);
  if (probe === 'alive') {
    // PID 仍存在：无论锁龄多久都不判 stale。
    return { action: 'busy', alive: 'alive', ageMs, reason: '持锁进程仍在运行' };
  }
  if (probe === 'dead') {
    // PID 确认已不存在：过期锁，先记录 owner 再清理。
    return { action: 'recover', alive: 'dead', ageMs };
  }
  // 无法确认存活（EPERM 等）：只有超过 staleAfterMs 才允许恢复。
  return ageMs > staleAfterMs
    ? { action: 'recover', alive: 'unknown', ageMs }
    : { action: 'busy', alive: 'unknown', ageMs, reason: '无法确认持锁进程是否存活，且锁龄未超过等待阈值' };
}

function busyMessage(verdict, existing) {
  const tail = '，可等待对方结束，或改用新会话。';
  if (verdict.reason === '无法读取持锁进程信息') return `无法读取会话锁的持有信息${tail}`;
  if (verdict.alive === 'alive') return `会话正被另一个进程使用（PID ${existing.pid}）${tail}`;
  return `无法确认会话锁的持有进程（PID ${existing.pid}）是否还在运行${tail}`;
}

// 获取会话锁。
// lockPath：锁目录路径（父目录不存在会自动创建）；pid：当前进程 ID。
// staleAfterMs：无法确认持锁进程存活时的等待阈值（毫秒），超过才允许恢复。
// sessionId / workspaceRoot 可选，写入锁目录作为 owner 现场。
// clock 可注入（毫秒时间戳）；isAlive 可注入（返回 'alive' | 'dead' | 'unknown'），测试用。
// writeFileImpl 为标记文件写入实现（测试注入口，默认 fs/promises 的 writeFile）。
// 成功返回 { release, owner }；已有有效锁抛 SessionLockError（code = 'SESSION_BUSY'，简体中文消息）。
export async function acquireSessionLock(lockPath, {
  pid,
  staleAfterMs = 30_000,
  sessionId = '',
  workspaceRoot = '',
  clock = Date.now,
  isAlive = defaultProbeAlive,
  writeFileImpl = writeFile,
} = {}) {
  if (typeof lockPath !== 'string' || lockPath.trim() === '') {
    throw new SessionLockError('会话锁路径不能为空。', 'SESSION_LOCK_INVALID_PATH', { lockPath });
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new SessionLockError('会话锁需要有效的进程 ID。', 'SESSION_LOCK_INVALID_PID', { pid });
  }

  // 锁的父目录先就位；真正的抢占只由不带 recursive 的 mkdir(lockPath) 完成。
  await mkdir(path.dirname(lockPath), { recursive: true });

  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      // 原子抢占：目录已存在时 mkdir 抛 EEXIST，胜负在这一步决定。
      await mkdir(lockPath);
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        throw new SessionLockError(`无法创建会话锁：${lockPath}`, 'SESSION_LOCK_CREATE_FAILED', {
          lockPath,
          cause: error && error.code,
        });
      }
      const now = clock();
      const existing = await readOwner(lockPath);
      // started_at 不可读时用锁目录 mtime 回退估算锁龄（半写入/崩溃残留场景）。
      const fallbackAgeMs = existing.startedAt === null ? await dirAgeMs(lockPath, now) : 0;
      const verdict = judgeExisting(existing, { now, staleAfterMs, isAlive, fallbackAgeMs });
      if (verdict.action === 'busy') {
        throw new SessionLockError(busyMessage(verdict, existing), 'SESSION_BUSY', {
          lockPath,
          ownerPid: existing.pid,
          ownerSessionId: existing.sessionId,
          ownerWorkspaceRoot: existing.workspaceRoot,
          ownerStartedAt: existing.startedAt,
          ageMs: verdict.ageMs,
          alive: verdict.alive,
          reason: verdict.reason,
          staleAfterMs,
        });
      }
      // 恢复：先把原锁整体改名留证（记录 owner），原路径随即被清出；改名失败交给下一轮重新裁决。
      try {
        await rename(lockPath, `${lockPath}.stale-${clock()}-${attempt}`);
      } catch {
        // 原锁可能已被其他进程恢复；不做删除，下一轮 mkdir 重新抢占裁决。
      }
      continue;
    }

    // 抢占成功：落盘 owner 现场；落盘失败则清掉刚抢占的目录，绝不留下无主锁。
    const startedAt = clock();
    const owner = { pid, sessionId, workspaceRoot, startedAt, lockPath };
    try {
      await writeOwner(lockPath, owner, writeFileImpl);
    } catch (error) {
      try {
        await rm(lockPath, { recursive: true, force: true });
      } catch {
        // 清理失败不掩盖原始失败；残留空目录退化为“started_at 不可读”场景，靠锁龄规则仍可恢复。
      }
      throw new SessionLockError(`无法写入会话锁的持有信息：${lockPath}`, 'SESSION_LOCK_WRITE_FAILED', {
        lockPath,
        errorCode: error && error.code,
      });
    }

    let released = false;
    // 释放：只在锁仍属于自己时删除；不属于当前 owner 的锁绝不删除。幂等。
    const release = async () => {
      if (released) return false;
      released = true;
      const current = await readOwner(lockPath);
      const isMine = current.pid === pid
        && current.startedAt === startedAt
        && (current.sessionId ?? '') === String(sessionId ?? '');
      if (!isMine) return false;
      await rm(lockPath, { recursive: true, force: true });
      return true;
    };

    return { release, owner };
  }

  // 连续多轮都被别人抢先：对用户而言仍然是“会话被占用”。
  throw new SessionLockError('多个进程正在争抢同一会话，请稍后重试，或改用新会话。', 'SESSION_BUSY', {
    lockPath,
    attempts: MAX_ATTEMPTS,
  });
}
