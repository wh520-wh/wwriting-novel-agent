// 跨进程会话锁测试：mkdir 原子抢占、释放、并发竞争、stale owner 处理。
// 全部使用 os.tmpdir() 下的临时目录；活 PID 用当前进程，死 PID 用已退出的子进程，不依赖环境运气。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { acquireSessionLock } from '../../src/storage/process-lock.mjs';

// 临时目录登记：测试结束时统一删除。
const tempRoots = [];
after(async () => {
  await Promise.all(tempRoots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempRoot(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

// 固定时钟：毫秒时间戳，锁龄断言完全确定。
const FIXED_MS = 1758900000000;
const fixedClock = () => FIXED_MS;

// 本机一个确认已退出的进程 PID（缓存，避免每个用例都起子进程）。
let deadPidPromise = null;
function deadPid() {
  if (!deadPidPromise) {
    deadPidPromise = new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
      child.on('close', () => resolve(child.pid));
      child.on('error', reject);
    });
  }
  return deadPidPromise;
}

// 伪造一把遗留锁：直接落盘四个标记文件，模拟崩溃进程留下的现场。
async function fakeLock(lockPath, { pid, startedAt, sessionId = 'old-session', workspaceRoot = 'D:\\old-novel' }) {
  await fs.mkdir(lockPath, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(lockPath, 'pid'), String(pid), 'utf8'),
    fs.writeFile(path.join(lockPath, 'session_id'), sessionId, 'utf8'),
    fs.writeFile(path.join(lockPath, 'started_at'), String(startedAt), 'utf8'),
    fs.writeFile(path.join(lockPath, 'workspace_root'), workspaceRoot, 'utf8'),
  ]);
}

async function readMarker(lockPath, name) {
  return fs.readFile(path.join(lockPath, name), 'utf8');
}

test('抢占成功：锁目录包含 pid、session_id、started_at、workspace_root', async () => {
  const tempRoot = await makeTempRoot('wwriting-lock-claim-');
  const lockPath = path.join(tempRoot, 'locks', 'session-1');

  const { release, owner } = await acquireSessionLock(lockPath, {
    pid: process.pid,
    staleAfterMs: 1000,
    sessionId: 'sess-1',
    workspaceRoot: 'D:\\novel',
    clock: fixedClock,
  });
  try {
    assert.equal(existsSync(lockPath), true);
    assert.equal(await readMarker(lockPath, 'pid'), String(process.pid));
    assert.equal(await readMarker(lockPath, 'session_id'), 'sess-1');
    assert.equal(await readMarker(lockPath, 'started_at'), String(FIXED_MS));
    assert.equal(await readMarker(lockPath, 'workspace_root'), 'D:\\novel');
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.sessionId, 'sess-1');
    assert.equal(owner.workspaceRoot, 'D:\\novel');
    assert.equal(owner.startedAt, FIXED_MS);
    assert.equal(owner.lockPath, lockPath);
  } finally {
    await release();
  }
});

test('并发抢锁：两个调用方同时抢同一锁，只有一个成功，另一个报 SESSION_BUSY', async () => {
  const tempRoot = await makeTempRoot('wwriting-lock-race-');
  const lockPath = path.join(tempRoot, 'locks', 'session-1');
  const options = { pid: process.pid, staleAfterMs: 60_000, clock: fixedClock };

  const settled = await Promise.allSettled([
    acquireSessionLock(lockPath, { ...options, sessionId: 'a' }),
    acquireSessionLock(lockPath, { ...options, sessionId: 'b' }),
  ]);

  const fulfilled = settled.filter((r) => r.status === 'fulfilled');
  const rejected = settled.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);

  const error = rejected[0].reason;
  assert.equal(error.code, 'SESSION_BUSY');
  assert.match(error.message, /[\u4e00-\u9fff]/);

  await fulfilled[0].value.release();
  assert.equal(existsSync(lockPath), false);
});

test('释放后第二个调用方抢锁成功', async () => {
  const tempRoot = await makeTempRoot('wwriting-lock-release-');
  const lockPath = path.join(tempRoot, 'locks', 'session-1');

  const first = await acquireSessionLock(lockPath, { pid: process.pid, staleAfterMs: 1000, clock: fixedClock });
  assert.equal(await first.release(), true);
  assert.equal(existsSync(lockPath), false);

  const second = await acquireSessionLock(lockPath, { pid: process.pid, staleAfterMs: 1000, clock: fixedClock });
  assert.equal(second.owner.pid, process.pid);
  assert.equal(await second.release(), true);
});

test('release 幂等：重复释放不抛错', async () => {
  const tempRoot = await makeTempRoot('wwriting-lock-idem-');
  const lockPath = path.join(tempRoot, 'locks', 'session-1');

  const { release } = await acquireSessionLock(lockPath, { pid: process.pid, staleAfterMs: 1000, clock: fixedClock });
  assert.equal(await release(), true);
  assert.equal(await release(), false);
  assert.equal(existsSync(lockPath), false);
});

test('锁中 PID 仍存活时不判 stale：无论锁龄多久都是 SESSION_BUSY', async () => {
  const tempRoot = await makeTempRoot('wwriting-lock-alive-');
  const lockPath = path.join(tempRoot, 'locks', 'session-1');
  // 远古 started_at，但持锁进程（本进程）还活着：不许恢复。
  await fakeLock(lockPath, { pid: process.pid, startedAt: 1000 });

  await assert.rejects(
    acquireSessionLock(lockPath, { pid: process.pid, staleAfterMs: 1, clock: fixedClock }),
    (error) => {
      assert.equal(error.code, 'SESSION_BUSY');
      assert.match(error.message, /[\u4e00-\u9fff]/);
      assert.equal(error.details.alive, 'alive');
      assert.equal(error.details.ownerPid, process.pid);
      return true;
    },
  );
  // 原锁完好未被清理。
  assert.equal(await readMarker(lockPath, 'pid'), String(process.pid));
});

test('死 PID 的过期锁：先记录 owner 再清理，随后抢占成功', async () => {
  const tempRoot = await makeTempRoot('wwriting-lock-dead-');
  const lockPath = path.join(tempRoot, 'locks', 'session-1');
  const crashedPid = await deadPid();
  await fakeLock(lockPath, { pid: crashedPid, startedAt: 1000 });

  const { release, owner } = await acquireSessionLock(lockPath, {
    pid: process.pid,
    staleAfterMs: 1_000_000_000,
    sessionId: 'new-session',
    clock: fixedClock,
  });
  try {
    assert.equal(owner.pid, process.pid);
    assert.equal(await readMarker(lockPath, 'pid'), String(process.pid));
    assert.equal(await readMarker(lockPath, 'session_id'), 'new-session');

    // 恢复事实已记录：旁边留下 stale 记录目录，内含原 owner 的 pid。
    const siblings = await fs.readdir(path.dirname(lockPath));
    const records = siblings.filter((name) => name.startsWith('session-1.stale-'));
    assert.equal(records.length, 1);
    assert.equal(await readMarker(path.join(path.dirname(lockPath), records[0]), 'pid'), String(crashedPid));
  } finally {
    await release();
  }
});

test('无法确认持锁进程存活且锁龄未超过 staleAfterMs：不恢复，报 SESSION_BUSY', async () => {
  const tempRoot = await makeTempRoot('wwriting-lock-unknown-');
  const lockPath = path.join(tempRoot, 'locks', 'session-1');
  await fakeLock(lockPath, { pid: 424242, startedAt: FIXED_MS });

  await assert.rejects(
    acquireSessionLock(lockPath, {
      pid: process.pid,
      staleAfterMs: 10_000,
      clock: fixedClock,
      isAlive: () => 'unknown',
    }),
    (error) => {
      assert.equal(error.code, 'SESSION_BUSY');
      assert.match(error.message, /[\u4e00-\u9fff]/);
      // 恢复判断所需事实全部写入错误详情。
      assert.equal(error.details.alive, 'unknown');
      assert.equal(error.details.ownerPid, 424242);
      assert.equal(error.details.ageMs, 0);
      assert.equal(error.details.staleAfterMs, 10_000);
      return true;
    },
  );
  assert.equal(existsSync(lockPath), true);
});

test('无法确认持锁进程存活但锁龄超过 staleAfterMs：允许恢复并记录原 owner', async () => {
  const tempRoot = await makeTempRoot('wwriting-lock-unknown-old-');
  const lockPath = path.join(tempRoot, 'locks', 'session-1');
  await fakeLock(lockPath, { pid: 424242, startedAt: FIXED_MS - 20_000 });

  const { release, owner } = await acquireSessionLock(lockPath, {
    pid: process.pid,
    staleAfterMs: 10_000,
    clock: fixedClock,
    isAlive: () => 'unknown',
  });
  try {
    assert.equal(owner.pid, process.pid);
    const siblings = await fs.readdir(path.dirname(lockPath));
    const records = siblings.filter((name) => name.startsWith('session-1.stale-'));
    assert.equal(records.length, 1);
    assert.equal(await readMarker(path.join(path.dirname(lockPath), records[0]), 'pid'), '424242');
  } finally {
    await release();
  }
});

test('release 不删除不属于当前 owner 的锁', async () => {
  const tempRoot = await makeTempRoot('wwriting-lock-foreign-');
  const lockPath = path.join(tempRoot, 'locks', 'session-1');

  const { release } = await acquireSessionLock(lockPath, {
    pid: process.pid,
    staleAfterMs: 1000,
    sessionId: 'mine',
    clock: fixedClock,
  });

  // 模拟锁被他人接管：原位写入另一 owner 的现场。
  await fakeLock(lockPath, { pid: process.pid, startedAt: 999999, sessionId: 'someone-else' });

  assert.equal(await release(), false);
  assert.equal(existsSync(lockPath), true);
  assert.equal(await readMarker(lockPath, 'session_id'), 'someone-else');
  assert.equal(await readMarker(lockPath, 'started_at'), '999999');
});

test('SESSION_BUSY 错误消息为简体中文人话，不带堆栈', async () => {
  const tempRoot = await makeTempRoot('wwriting-lock-message-');
  const lockPath = path.join(tempRoot, 'locks', 'session-1');
  await fakeLock(lockPath, { pid: process.pid, startedAt: FIXED_MS });

  await assert.rejects(
    acquireSessionLock(lockPath, { pid: process.pid, staleAfterMs: 1000, clock: fixedClock }),
    (error) => {
      assert.match(error.message, /[\u4e00-\u9fff]/);
      assert.doesNotMatch(error.message, /\n?\s+at /);
      assert.doesNotMatch(error.message, /^Error:/);
      return true;
    },
  );
});

test('无效参数：空路径或非法 PID 抛中文错误', async () => {
  const tempRoot = await makeTempRoot('wwriting-lock-args-');
  await assert.rejects(acquireSessionLock('', { pid: process.pid, staleAfterMs: 1000 }), /[\u4e00-\u9fff]/);
  await assert.rejects(
    acquireSessionLock(path.join(tempRoot, 'locks', 's'), { pid: 0, staleAfterMs: 1000 }),
    /[\u4e00-\u9fff]/,
  );
  await assert.rejects(
    acquireSessionLock(path.join(tempRoot, 'locks', 's'), { pid: 'abc', staleAfterMs: 1000 }),
    /[\u4e00-\u9fff]/,
  );
});

test('空锁目录（胜者建完目录即崩溃）：刚出现时仍 SESSION_BUSY，锁目录保留', async () => {
  const tempRoot = await makeTempRoot('wwriting-lock-empty-fresh-');
  const lockPath = path.join(tempRoot, 'locks', 'session-1');
  // 只有目录、没有任何标记文件：pid 与 started_at 都不可读，锁龄回退用目录 mtime（≈现在）。
  await fs.mkdir(lockPath, { recursive: true });

  await assert.rejects(
    acquireSessionLock(lockPath, { pid: process.pid, staleAfterMs: 60_000 }),
    (error) => {
      assert.equal(error.code, 'SESSION_BUSY');
      assert.match(error.message, /[\u4e00-\u9fff]/);
      assert.equal(error.details.alive, 'unknown');
      assert.equal(typeof error.details.ageMs, 'number');
      assert.ok(error.details.ageMs < 60_000, `新空目录锁龄应远小于阈值，实际 ${error.details.ageMs}ms`);
      return true;
    },
  );
  assert.equal(existsSync(lockPath), true);
});

test('空锁目录（崩溃残留）：锁龄（目录 mtime）超过 staleAfterMs 后可恢复抢占', async () => {
  const tempRoot = await makeTempRoot('wwriting-lock-empty-old-');
  const lockPath = path.join(tempRoot, 'locks', 'session-1');
  await fs.mkdir(lockPath, { recursive: true });
  // 把锁目录 mtime 拨回 60 秒前：模拟“建完目录就崩溃”的旧现场。
  const past = new Date(Date.now() - 60_000);
  await fs.utimes(lockPath, past, past);

  const { release, owner } = await acquireSessionLock(lockPath, {
    pid: process.pid,
    staleAfterMs: 10_000,
    sessionId: 'after-crash',
  });
  try {
    assert.equal(owner.pid, process.pid);
    assert.equal(await readMarker(lockPath, 'pid'), String(process.pid));
    assert.equal(await readMarker(lockPath, 'session_id'), 'after-crash');
    // 恢复前已留证：旁边留下原空目录的 stale 记录目录。
    const siblings = await fs.readdir(path.dirname(lockPath));
    const records = siblings.filter((name) => name.startsWith('session-1.stale-'));
    assert.equal(records.length, 1);
  } finally {
    await release();
  }
});

test('落盘 owner 失败：抛中文 SessionLockError，清理刚抢占的锁目录，且可重新抢占', async () => {
  const tempRoot = await makeTempRoot('wwriting-lock-writefail-');
  const lockPath = path.join(tempRoot, 'locks', 'session-1');

  // 注入可失败的写依赖：started_at 落盘时模拟 I/O 错误，其余标记正常写入。
  const failingWrite = async (filePath, content, options) => {
    if (path.basename(filePath) === 'started_at') {
      throw Object.assign(new Error('injected io failure'), { code: 'EIO' });
    }
    return fs.writeFile(filePath, content, options);
  };

  await assert.rejects(
    acquireSessionLock(lockPath, {
      pid: process.pid,
      staleAfterMs: 1000,
      writeFileImpl: failingWrite,
    }),
    (error) => {
      assert.equal(error.code, 'SESSION_LOCK_WRITE_FAILED');
      assert.match(error.message, /[\u4e00-\u9fff]/);
      assert.doesNotMatch(error.message, /\n?\s+at /);
      assert.equal(error.details.errorCode, 'EIO');
      assert.equal(error.details.lockPath, lockPath);
      return true;
    },
  );
  // 刚抢占的锁目录已被清理，不残留无主锁。
  assert.equal(existsSync(lockPath), false);
  // 清理后可正常抢占并释放。
  const second = await acquireSessionLock(lockPath, { pid: process.pid, staleAfterMs: 1000 });
  assert.equal(second.owner.pid, process.pid);
  assert.equal(await second.release(), true);
});
