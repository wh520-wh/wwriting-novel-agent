// 章节服务：「章节即事务」在 CLI 的落地——提交快照、回滚、前情账本。
//
// 存储边界（铁律 8）：版本快照与前情账本是**应用私有历史**，只落在
// `<appDataRoot>/WWriting/workspaces/<workspace-id>/chapters/`，绝不进创作目录。
// 布局：
//   chapters/ledger.jsonl            — 追加式账本（提交与回滚快照都记，kind 区分）
//   chapters/versions/<相对路径>/NNNN.txt — 每个章节路径的版本快照，按 seq 递增
//
// 职责边界：本模块只管**私有存储**；读写创作文件与权限确认住在文件工具与
// 默认工具工厂（run-controller）——回滚 = 先读当前（自动）→ prepareRollback（私有写，自动）
// → restoreFile（创作目录写入，需确认）三段组装，任何一段失败都不会留下「账本说了谎」的状态。
import path from 'node:path';
import fsp from 'node:fs/promises';

import { countText } from './count-text.mjs';
import { resolveAppDataRoot, workspaceIdForPath } from '../storage/workspace-store.mjs';

// 服务错误：message 是一条中文事实，code 供调用方判断（铁律 3）。
export class ChapterToolError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'ChapterToolError';
    this.code = code;
    this.details = details;
  }
}

const DEFAULT_CONTINUITY_BUDGET = 4000;
const MAX_SUMMARY_CHARS = 200;

// 相对路径的防呆（纵深防御：上游 files.readFile 已归一，这里再拦一次）：
// 绝不允许 '..' 段或空段进版本目录。
function safeSegments(relPath) {
  const segments = String(relPath).split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0 || segments.some((segment) => segment === '..')) {
    throw new ChapterToolError('章节路径不合法。', 'CHAPTER_PATH_INVALID', { path: relPath });
  }
  return segments;
}

// createChapterService({ appDataRoot, fs, clock })
//   appDataRoot 应用私有数据根，缺省按环境解析（与 workspaceStore 同一口径）；测试注入临时目录。
//   fs 可注入（测试用内存实现）。
export function createChapterService({ appDataRoot = resolveAppDataRoot(), fs = fsp, clock = Date.now } = {}) {
  if (typeof appDataRoot !== 'string' || appDataRoot.trim() === '') {
    throw new ChapterToolError('章节服务需要应用私有数据根目录。', 'CHAPTER_ROOT_INVALID', { appDataRoot });
  }

  // workspaceIdForPath 是纯函数；按 projectRoot 现算并缓存，避免每章提交都重哈希。
  const idCache = new Map();
  function rootFor(projectRoot) {
    if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
      throw new ChapterToolError('章节服务需要创作目录。', 'CHAPTER_PROJECT_ROOT_INVALID', { projectRoot });
    }
    let id = idCache.get(projectRoot);
    if (id === undefined) {
      id = workspaceIdForPath(projectRoot);
      idCache.set(projectRoot, id);
    }
    return path.join(appDataRoot, 'WWriting', 'workspaces', id, 'chapters');
  }

  // 账本：读全部行（坏行跳过——账本损坏不值得让写作失败，如实少记）。
  async function readLedger(projectRoot) {
    let raw = '';
    try {
      raw = await fs.readFile(path.join(rootFor(projectRoot), 'ledger.jsonl'), 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      throw new ChapterToolError('无法读取章节账本。', 'CHAPTER_LEDGER_UNREADABLE', { cause: error?.code });
    }
    const entries = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed !== null && typeof parsed === 'object') entries.push(parsed);
      } catch {
        continue; // 崩溃残留的半行：跳过，不中断整本账。
      }
    }
    return entries;
  }

  async function appendLedger(projectRoot, entry) {
    const ledgerPath = path.join(rootFor(projectRoot), 'ledger.jsonl');
    await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
    await fs.appendFile(ledgerPath, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  function versionPath(projectRoot, relPath, seq) {
    const segments = safeSegments(relPath);
    return path.join(rootFor(projectRoot), 'versions', ...segments, `${String(seq).padStart(4, '0')}.txt`);
  }

  // 该路径的下一个版本号：账本里（任何 kind）出现过的最大 seq + 1。
  // 快照文件本身不作数——账本是真相源，孤儿快照（账本没记上）不占号。
  function nextSeq(entries, relPath) {
    const max = entries.reduce(
      (n, entry) => (entry.kind !== undefined && entry.path === relPath && Number.isInteger(entry.seq) ? Math.max(n, entry.seq) : n),
      0,
    );
    return max + 1;
  }

  // 提交：存版本 + 记账（前情条目）。只写私有存储，创作文件不动。
  async function commit({ projectRoot, path: relPath, text, summary = null } = {}) {
    if (typeof relPath !== 'string' || relPath.trim() === '') {
      throw new ChapterToolError('要提交的章节路径不能为空。', 'CHAPTER_PATH_INVALID', { path: relPath });
    }
    if (typeof text !== 'string' || text === '') {
      throw new ChapterToolError('要提交的章节内容是空的。', 'CHAPTER_TEXT_EMPTY', { path: relPath });
    }
    const entries = await readLedger(projectRoot);
    const seq = nextSeq(entries, relPath);
    const counted = countText({ text });
    const target = versionPath(projectRoot, relPath, seq);
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, text, 'utf8');
    } catch (error) {
      throw new ChapterToolError('无法保存章节版本。', 'CHAPTER_VERSION_WRITE_FAILED', {
        path: relPath,
        errorCode: error?.code,
      });
    }
    const note = typeof summary === 'string' && summary.trim() !== '' ? summary.trim().slice(0, MAX_SUMMARY_CHARS) : null;
    const entry = {
      at: new Date(clock()).toISOString(),
      kind: 'commit',
      path: relPath,
      seq,
      chars: counted.charsNoSpace,
      summary: note,
    };
    await appendLedger(projectRoot, entry);
    return { path: relPath, seq, charsNoSpace: counted.charsNoSpace };
  }

  // 回滚准备：找到最近一次**提交**版本（回滚快照不算——那是安全网，不是可回滚目标）；
  // 先把当前内容存为新版本再返回要恢复的内容。返回 null = 这个路径没有提交过。
  async function prepareRollback({ projectRoot, path: relPath, currentText } = {}) {
    if (typeof relPath !== 'string' || relPath.trim() === '') {
      throw new ChapterToolError('要回滚的章节路径不能为空。', 'CHAPTER_PATH_INVALID', { path: relPath });
    }
    const entries = await readLedger(projectRoot);
    const lastCommit = [...entries].reverse().find((entry) => entry.kind === 'commit' && entry.path === relPath);
    if (lastCommit === undefined || !Number.isInteger(lastCommit.seq)) return null;

    // 安全网：回滚前把当前内容存档（kind=rollback_save）。确认被拒绝时它只是多一份快照，
    // 不污染前情；确认通过后它保证「回滚」本身永远可再回滚。
    if (typeof currentText === 'string') {
      const seq = nextSeq(entries, relPath);
      const target = versionPath(projectRoot, relPath, seq);
      try {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, currentText, 'utf8');
        await appendLedger(projectRoot, {
          at: new Date(clock()).toISOString(),
          kind: 'rollback_save',
          path: relPath,
          seq,
          chars: countText({ text: currentText }).charsNoSpace,
          summary: null,
        });
      } catch (error) {
        throw new ChapterToolError('无法保存回滚前的安全快照。', 'CHAPTER_VERSION_WRITE_FAILED', {
          path: relPath,
          errorCode: error?.code,
        });
      }
    }

    try {
      const text = await fs.readFile(versionPath(projectRoot, relPath, lastCommit.seq), 'utf8');
      return { seq: lastCommit.seq, text };
    } catch (error) {
      throw new ChapterToolError('提交的版本读不出来，无法回滚。', 'CHAPTER_VERSION_UNREADABLE', {
        path: relPath,
        seq: lastCommit.seq,
        errorCode: error?.code,
      });
    }
  }

  // 前情：全部提交按时间正序各占一行（`路径 · N 字 · 摘要`），从最新往前装进预算。
  // 摘要缺失的提交只有路径与字数——绝不编一句出来。
  async function readContinuity({ projectRoot, budgetChars = DEFAULT_CONTINUITY_BUDGET } = {}) {
    const budget = Number.isFinite(budgetChars) && budgetChars > 0 ? Math.floor(budgetChars) : DEFAULT_CONTINUITY_BUDGET;
    const entries = await readLedger(projectRoot);
    const commits = entries.filter((entry) => entry.kind === 'commit');
    const lines = commits.map((entry) => {
      const chars = Number.isFinite(entry.chars) ? entry.chars : '?';
      const summary = typeof entry.summary === 'string' && entry.summary !== '' ? ` · ${entry.summary}` : '';
      return `${entry.path} · ${chars} 字${summary}`;
    });
    const kept = [];
    let used = 0;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const cost = lines[i].length + 1;
      if (used + cost > budget) break;
      kept.unshift(lines[i]);
      used += cost;
    }
    return {
      text: kept.join('\n'),
      entries: kept.length,
      commits: commits.length,
      truncated: kept.length < commits.length,
    };
  }

  return { commit, prepareRollback, readContinuity, rootFor: (projectRoot) => rootFor(projectRoot) };
}
