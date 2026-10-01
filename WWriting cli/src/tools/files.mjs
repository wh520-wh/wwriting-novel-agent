// 创作目录内的文件工具：读取自动放行，写入/修改原子落盘，任何越出创作目录的访问一律拒绝。
// 边界三条：先相对化再验证位于 projectRoot；符号链接按真实路径再验一次；目标若是目录不许写。
// 写入只走「同目录临时文件 + rename」：要么整篇落地，要么一个字节都不留（铁律 5）。
import path from 'node:path';
import fsp from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

import { countText } from './count-text.mjs';
// 路径包含判定只有一份定义（安全判定，两边绝不能漂移）：来自权限层。
import { isInside } from './permissions.mjs';

// 文件工具错误：message 是一条中文事实，code 与 errorCode 只进折叠详情。
export class FileToolError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'FileToolError';
    this.code = code;
    this.details = details;
  }
}

// 取消：name 用 AbortError 兼容调用方的取消判断，code 保留本模块的语义。
function abortError() {
  const error = new FileToolError('操作已取消，文件保持原样。', 'TOOL_ABORTED', { aborted: true });
  error.name = 'AbortError';
  return error;
}

function ioError(message, code, error, extra = {}) {
  return new FileToolError(message, code, { errorCode: error && error.code, ...extra });
}

export function createFileTools({ projectRoot, signal = null, permissions = null, fs: fsImpl = fsp } = {}) {
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
    throw new FileToolError('创作目录不能为空，请用 --cwd 指定创作目录。', 'TOOL_PROJECT_ROOT_INVALID', {
      projectRoot,
    });
  }
  const rootResolved = path.resolve(projectRoot);
  let rootRealPromise = null;

  function throwIfAborted() {
    if (signal && signal.aborted) throw abortError();
  }

  // 写入与修改必须先过权限层（铁律 4）：门在任何写盘动作之前，未授权就一个字节都不写。
  // fail-closed：没注入 permissions 视同未授权——「谁忘了调就未确认直接落盘」正是要堵的洞。
  async function authorizeWrite(tool, target) {
    if (!permissions || typeof permissions.request !== 'function') {
      throw new FileToolError('未获得写入授权，请先确认。', 'TOOL_WRITE_UNAUTHORIZED', { tool, target });
    }
    const decision = await permissions.request({ tool, target, projectRoot: rootResolved });
    if (!decision || decision.allowed !== true) {
      throw new FileToolError('这次修改未获授权，文件保持原样。', 'TOOL_WRITE_DENIED', {
        tool,
        target,
        reason: decision ? decision.reason : null,
      });
    }
  }

  // 创作目录的真实路径：项目根本身也可能是链接，取一次就够，之后复用。
  function rootRealPath() {
    if (rootRealPromise === null) {
      rootRealPromise = fsImpl.realpath(rootResolved).catch((error) => {
        if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return rootResolved;
        throw ioError('无法访问创作目录。', 'TOOL_ROOT_UNREADABLE', error, { projectRoot });
      });
    }
    return rootRealPromise;
  }

  // 真实路径：目标还不存在时（新建文件）逐级向上找到最近的已存在祖先。
  async function realpathExisting(target) {
    let current = target;
    for (;;) {
      try {
        return await fsImpl.realpath(current);
      } catch (error) {
        if (!error || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) {
          throw ioError('无法访问这个路径。', 'TOOL_PATH_UNREADABLE', error, { target });
        }
        const parent = path.dirname(current);
        if (parent === current) return current;
        current = parent;
      }
    }
  }

  // 所有工具共用的入口：相对化 → 越界判定 → 真实路径判定。
  async function resolveSafePath(target) {
    if (typeof target !== 'string' || target.trim() === '') {
      throw new FileToolError('文件路径不能为空。', 'TOOL_PATH_INVALID', { target });
    }
    const requested = target.trim();
    const abs = path.resolve(rootResolved, requested);
    if (!isInside(rootResolved, abs)) {
      throw new FileToolError('这个路径在创作目录之外，已阻止访问。', 'TOOL_PATH_OUTSIDE_PROJECT', {
        target: requested,
      });
    }
    // 符号链接可以指向目录外的实体：解析后按真实路径再判一次。
    const real = await realpathExisting(abs);
    if (!isInside(await rootRealPath(), real)) {
      throw new FileToolError('这个路径指向创作目录之外，已阻止访问。', 'TOOL_PATH_OUTSIDE_PROJECT', {
        target: requested,
      });
    }
    return abs;
  }

  function displayPath(abs) {
    return path.relative(rootResolved, abs).split(path.sep).join('/');
  }

  async function statOrNull(abs) {
    try {
      return await fsImpl.stat(abs);
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw ioError('无法访问这个文件。', 'TOOL_IO_FAILED', error, { path: displayPath(abs) });
    }
  }

  function assertNotDirectory(stat, abs) {
    if (stat && stat.isDirectory()) {
      throw new FileToolError('目标是一个目录，不能当文件写入。', 'TOOL_TARGET_IS_DIRECTORY', {
        path: displayPath(abs),
      });
    }
  }

  async function readTextFile(abs) {
    let stat;
    try {
      stat = await fsImpl.stat(abs);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        throw new FileToolError('这个文件不存在。', 'TOOL_TARGET_NOT_FOUND', { path: displayPath(abs) });
      }
      throw ioError('无法访问这个文件。', 'TOOL_IO_FAILED', error, { path: displayPath(abs) });
    }
    assertNotDirectory(stat, abs);
    try {
      return await fsImpl.readFile(abs, 'utf8');
    } catch (error) {
      if (error && error.code === 'EISDIR') assertNotDirectory(stat, abs);
      throw ioError('无法读取这个文件。', 'TOOL_IO_FAILED', error, { path: displayPath(abs) });
    }
  }

  // 递归遍历：返回按路径排序的 { abs, isDirectory }，listFiles 与 searchFiles 共用一套遍历。
  async function walkTree(dirAbs) {
    const found = [];
    const stack = [dirAbs];
    while (stack.length > 0) {
      const current = stack.pop();
      let entries;
      try {
        entries = await fsImpl.readdir(current, { withFileTypes: true });
      } catch (error) {
        throw ioError('无法列出这个目录。', 'TOOL_IO_FAILED', error, { path: displayPath(current) });
      }
      for (const entry of entries) {
        const entryAbs = path.join(current, entry.name);
        if (entry.isDirectory()) {
          found.push({ abs: entryAbs, isDirectory: true });
          stack.push(entryAbs);
          continue;
        }
        if (entry.isFile()) found.push({ abs: entryAbs, isDirectory: false });
      }
    }
    found.sort((a, b) => (a.abs < b.abs ? -1 : a.abs > b.abs ? 1 : 0));
    return found;
  }

  async function readDirEntry(abs) {
    try {
      return await fsImpl.readdir(abs, { withFileTypes: true });
    } catch (error) {
      throw ioError('无法列出这个目录。', 'TOOL_IO_FAILED', error, { path: displayPath(abs) });
    }
  }

  function toEntry(abs, isDirectory) {
    return isDirectory ? { path: `${displayPath(abs)}/`, type: 'dir' } : { path: displayPath(abs), type: 'file' };
  }

  // 原子写入：同目录临时文件 → 取消检查 → rename。取消点在 rename 之前，所以不留半文件。
  async function atomicWrite(abs, content) {
    const dir = path.dirname(abs);
    const tmpPath = path.join(dir, `${path.basename(abs)}.wwriting-${randomBytes(6).toString('hex')}.tmp`);
    try {
      await fsImpl.mkdir(dir, { recursive: true });
      await fsImpl.writeFile(tmpPath, content, 'utf8');
      throwIfAborted();
      await fsImpl.rename(tmpPath, abs);
    } catch (error) {
      await fsImpl.rm(tmpPath, { force: true }).catch(() => {});
      if (error instanceof FileToolError) throw error;
      throw ioError('写入失败，文件保持原样。', 'TOOL_WRITE_FAILED', error, { path: displayPath(abs) });
    }
  }

  async function listFiles({ path: target = '.', recursive = false } = {}) {
    throwIfAborted();
    const abs = await resolveSafePath(target);
    const stat = await statOrNull(abs);
    if (!stat) {
      throw new FileToolError('这个目录不存在。', 'TOOL_TARGET_NOT_FOUND', { path: displayPath(abs) });
    }
    if (!stat.isDirectory()) {
      throw new FileToolError('这个路径不是目录。', 'TOOL_TARGET_NOT_DIRECTORY', { path: displayPath(abs) });
    }
    if (recursive) {
      return { entries: (await walkTree(abs)).map((entry) => toEntry(entry.abs, entry.isDirectory)) };
    }
    const entries = (await readDirEntry(abs)).map((entry) => {
      const entryAbs = path.join(abs, entry.name);
      return toEntry(entryAbs, entry.isDirectory());
    });
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { entries };
  }

  async function readFile({ path: target } = {}) {
    throwIfAborted();
    const abs = await resolveSafePath(target);
    const text = await readTextFile(abs);
    return { path: displayPath(abs), text };
  }

  async function searchFiles({ pattern, path: target = '.', maxResults = 50 } = {}) {
    throwIfAborted();
    if (typeof pattern !== 'string' || pattern === '') {
      throw new FileToolError('搜索内容不能为空。', 'TOOL_PATTERN_INVALID', { pattern });
    }
    const limit = Number.isFinite(maxResults) && maxResults > 0 ? Math.floor(maxResults) : 50;
    const abs = await resolveSafePath(target);
    const stat = await statOrNull(abs);
    if (!stat) {
      throw new FileToolError('这个目录不存在。', 'TOOL_TARGET_NOT_FOUND', { path: displayPath(abs) });
    }
    if (!stat.isDirectory()) {
      throw new FileToolError('这个路径不是目录。', 'TOOL_TARGET_NOT_DIRECTORY', { path: displayPath(abs) });
    }

    const matches = [];
    let truncated = false;
    for (const entry of await walkTree(abs)) {
      if (entry.isDirectory) continue;
      let text;
      try {
        text = await fsImpl.readFile(entry.abs, 'utf8');
      } catch {
        continue; // 读不出（权限、二进制）就跳过，不因此中断整次搜索。
      }
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].includes(pattern)) continue;
        if (matches.length >= limit) {
          truncated = true;
          break;
        }
        matches.push({ path: displayPath(entry.abs), lineNumber: index + 1, text: lines[index] });
      }
      if (truncated) break;
    }
    return { matches, truncated };
  }

  async function writeFile({ path: target, content } = {}) {
    throwIfAborted();
    if (typeof content !== 'string') {
      throw new FileToolError('写入内容必须是文本。', 'TOOL_CONTENT_INVALID', { received: typeof content });
    }
    const abs = await resolveSafePath(target);
    // 越界先被硬边界挡掉，再过权限层，然后才动磁盘。
    await authorizeWrite('write_file', target);
    const stat = await statOrNull(abs);
    assertNotDirectory(stat, abs);
    // 字数一律由本地统计得出，模型自报不作数（铁律 6）。
    const counted = countText({ text: content });
    await atomicWrite(abs, content);
    return { path: displayPath(abs), charsNoSpace: counted.charsNoSpace };
  }

  async function editFile({ path: target, oldText, newText, replaceAll = false } = {}) {
    throwIfAborted();
    if (typeof oldText !== 'string' || oldText === '') {
      throw new FileToolError('要替换的原文不能为空。', 'TOOL_EDIT_INVALID', { field: 'oldText' });
    }
    if (typeof newText !== 'string') {
      throw new FileToolError('替换后的内容必须是文本。', 'TOOL_EDIT_INVALID', { field: 'newText' });
    }
    const abs = await resolveSafePath(target);
    await authorizeWrite('edit_file', target);
    const original = await readTextFile(abs);

    const occurrences = original.split(oldText).length - 1;
    if (occurrences === 0) {
      throw new FileToolError('文件里找不到要替换的内容。', 'TOOL_EDIT_NOT_FOUND', { path: displayPath(abs) });
    }
    if (occurrences > 1 && !replaceAll) {
      throw new FileToolError('要替换的内容出现多次，请给出更长的原文或明确替换全部。', 'TOOL_EDIT_AMBIGUOUS', {
        path: displayPath(abs),
        occurrences,
      });
    }
    // split/join 是字面量替换；String.replace 的替换串会把 $$/$&/$`/$' 当替换模式解释，
    // 单处与全替换就会落盘成两种内容（project-memory 的 R10 同因）。走到这里 occurrences ≥ 1，
    // 且非全替换时 occurrences === 1，split/join 与「只换一处」逐字等价。
    const next = original.split(oldText).join(newText);
    throwIfAborted();
    const counted = countText({ text: next });
    await atomicWrite(abs, next);
    return { path: displayPath(abs), charsNoSpace: counted.charsNoSpace, replacements: occurrences };
  }

  // 追加正文（append_chapter_segment 的落盘）：读旧文 → 拼接 → 原子写入。
  // append 也不能留半文件（铁律 5 同源）：不用 fs.appendFile——半截追加崩溃后
  // 既不完整也没有临时文件可回退，拼全再原子换名与整篇写入走同一条路。
  async function appendFile({ path: target, content } = {}) {
    throwIfAborted();
    if (typeof content !== 'string' || content === '') {
      throw new FileToolError('追加的内容必须是文本且不能为空。', 'TOOL_CONTENT_INVALID', {
        received: typeof content,
      });
    }
    const abs = await resolveSafePath(target);
    await authorizeWrite('append_chapter_segment', target);
    const stat = await statOrNull(abs);
    assertNotDirectory(stat, abs);
    const original = stat === null ? '' : await readTextFile(abs);
    const next = original + content;
    throwIfAborted();
    const counted = countText({ text: next });
    await atomicWrite(abs, next);
    return { path: displayPath(abs), charsNoSpace: counted.charsNoSpace };
  }

  // 章节回滚的落盘：授权标签是「回滚章节」（确认卡要让人知道在确认什么），
  // 原子写入与 write_file 走同一条路。内容由章节服务提供（版本快照），这里只管安全落盘。
  async function restoreFile({ path: target, content } = {}) {
    throwIfAborted();
    if (typeof content !== 'string') {
      throw new FileToolError('回滚的内容必须是文本。', 'TOOL_CONTENT_INVALID', { received: typeof content });
    }
    const abs = await resolveSafePath(target);
    await authorizeWrite('rollback_chapter', target);
    const stat = await statOrNull(abs);
    assertNotDirectory(stat, abs);
    const counted = countText({ text: content });
    await atomicWrite(abs, content);
    return { path: displayPath(abs), charsNoSpace: counted.charsNoSpace };
  }

  return { listFiles, readFile, searchFiles, writeFile, editFile, appendFile, restoreFile, countText };
}
