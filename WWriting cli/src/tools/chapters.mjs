// 章节服务：「章节即事务」在 CLI 的落地——提交快照、回滚、前情账本。
//
// 存储边界（铁律 8）：版本快照与前情账本是**应用私有历史**，只落在
// `<appDataRoot>/WWriting/workspaces/<workspace-id>/chapters/`，绝不进创作目录。
// 布局：
//   chapters/ledger.jsonl            — 追加式账本（提交、修订入账与回滚快照都记，kind 区分）
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

  // 「生效版本」只有提交与修订入账两种：回滚目标与前情口径都只认它俩
  //（rollback_save 是安全网，永远不算生效版本）——判定只有这一处。
  function isEffectiveEntry(entry) {
    return entry.kind === 'commit' || entry.kind === 'revision';
  }

  // 生效版本入账（提交与修订入账共用同一条七步）：存快照 + 记账本 + 回报口径字数。
  // kind 由调用方定，门禁在调用方——这里只管「如实记一条生效版本」。
  async function recordEffectiveVersion({ projectRoot, relPath, text, summary, kind }) {
    const entries = await readLedger(projectRoot);
    const seq = nextSeq(entries, relPath);
    const counted = countText({ text });
    await writeVersionFile(projectRoot, relPath, seq, text, '无法保存章节版本。');
    const note = typeof summary === 'string' && summary.trim() !== '' ? summary.trim().slice(0, MAX_SUMMARY_CHARS) : null;
    await appendLedger(projectRoot, {
      at: new Date(clock()).toISOString(),
      kind,
      path: relPath,
      seq,
      chars: counted.charsNoSpace,
      summary: note,
    });
    return { path: relPath, seq, charsNoSpace: counted.charsNoSpace };
  }

  // 提交：存版本 + 记账（前情条目）。只写私有存储，创作文件不动。
  async function commit({ projectRoot, path: relPath, text, summary = null } = {}) {
    if (typeof relPath !== 'string' || relPath.trim() === '') {
      throw new ChapterToolError('要提交的章节路径不能为空。', 'CHAPTER_PATH_INVALID', { path: relPath });
    }
    if (typeof text !== 'string' || text === '') {
      throw new ChapterToolError('要提交的章节内容是空的。', 'CHAPTER_TEXT_EMPTY', { path: relPath });
    }
    return recordEffectiveVersion({ projectRoot, relPath, text, summary, kind: 'commit' });
  }

  // 修订入账（上游 round8 D2 的 CLI 适配）：把**已提交**章节的当前内容重新入账。
  // 分工照上游：commit 管草稿→定稿，这里管定稿之后又改过的重新入账；账本记 revision
  // 条目，不伪装成第二次定稿。门禁方向照上游 chapter_not_committed：
  // 从未提交过的路径拒绝，一个字节都不写——修订只认「已经在册」的章节。
  async function finalizeRevision({ projectRoot, path: relPath, text, summary = null } = {}) {
    if (typeof relPath !== 'string' || relPath.trim() === '') {
      throw new ChapterToolError('要入账的章节路径不能为空。', 'CHAPTER_PATH_INVALID', { path: relPath });
    }
    if (typeof text !== 'string' || text === '') {
      throw new ChapterToolError('要入账的章节内容是空的。', 'CHAPTER_TEXT_EMPTY', { path: relPath });
    }
    const entries = await readLedger(projectRoot);
    if (!entries.some((entry) => entry.kind === 'commit' && entry.path === relPath)) {
      throw new ChapterToolError('这一章还没有提交过，修订无处入账；请先提交章节。', 'CHAPTER_NOT_COMMITTED', {
        path: relPath,
      });
    }
    return recordEffectiveVersion({ projectRoot, relPath, text, summary, kind: 'revision' });
  }

  // 版本快照落盘：目录惰性创建 + 整文件写入，提交与修订入账共用同一条路。
  async function writeVersionFile(projectRoot, relPath, seq, text, failMessage) {
    const target = versionPath(projectRoot, relPath, seq);
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, text, 'utf8');
    } catch (error) {
      throw new ChapterToolError(failMessage, 'CHAPTER_VERSION_WRITE_FAILED', {
        path: relPath,
        errorCode: error?.code,
      });
    }
    return target;
  }

  // 回滚准备：找到最近一次**生效**版本（提交或修订入账——上游 round8 D4：回滚恢复
  // 最近生效版本；回滚快照不算——那是安全网，不是可回滚目标）；
  // 先把当前内容存为新版本再返回要恢复的内容。返回 null = 这个路径没有提交过。
  async function prepareRollback({ projectRoot, path: relPath, currentText } = {}) {
    if (typeof relPath !== 'string' || relPath.trim() === '') {
      throw new ChapterToolError('要回滚的章节路径不能为空。', 'CHAPTER_PATH_INVALID', { path: relPath });
    }
    const entries = await readLedger(projectRoot);
    const lastEffective = [...entries].reverse().find((entry) => isEffectiveEntry(entry) && entry.path === relPath);
    if (lastEffective === undefined || !Number.isInteger(lastEffective.seq)) return null;

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
      const text = await fs.readFile(versionPath(projectRoot, relPath, lastEffective.seq), 'utf8');
      return { seq: lastEffective.seq, text };
    } catch (error) {
      throw new ChapterToolError('生效版本读不出来，无法回滚。', 'CHAPTER_VERSION_UNREADABLE', {
        path: relPath,
        seq: lastEffective.seq,
        errorCode: error?.code,
      });
    }
  }

  // 前情：每章按**最新生效版本**（提交或修订入账）取字数与摘要，按首次提交顺序各占一行
  // （`路径 · N 字 · 摘要`），从最新往前装进预算。修订没给新摘要时沿用上一次的——
  // 没给新摘要不等于撤销旧摘要；摘要缺失且从没有过的绝不编一句出来。
  async function readContinuity({ projectRoot, budgetChars = DEFAULT_CONTINUITY_BUDGET } = {}) {
    const budget = Number.isFinite(budgetChars) && budgetChars > 0 ? Math.floor(budgetChars) : DEFAULT_CONTINUITY_BUDGET;
    const entries = await readLedger(projectRoot);
    const effective = new Map(); // path → { chars, summary }；Map 保插入序 = 首次提交序
    for (const entry of entries) {
      if (entry.kind !== 'commit' && entry.kind !== 'revision') continue;
      const previous = effective.get(entry.path);
      effective.set(entry.path, {
        chars: Number.isFinite(entry.chars) ? entry.chars : previous?.chars ?? '?',
        summary: typeof entry.summary === 'string' && entry.summary !== ''
          ? entry.summary
          : previous?.summary ?? null,
      });
    }
    const lines = [...effective].map(([entryPath, state]) => {
      const summary = typeof state.summary === 'string' && state.summary !== '' ? ` · ${state.summary}` : '';
      return `${entryPath} · ${state.chars} 字${summary}`;
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
      // 有生效版本的**章数**（每章一行；revision 不虚增、重复提交也不）。
      // 名字不叫 commits：它已经不等于 commit 条目数了（同名会骗下一个读它的人）。
      chapters: effective.size,
      truncated: kept.length < effective.size,
    };
  }

  return { commit, finalizeRevision, prepareRollback, readContinuity, rootFor: (projectRoot) => rootFor(projectRoot) };
}
