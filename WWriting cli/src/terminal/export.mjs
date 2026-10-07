// /export：把会话的全部对话导出为 markdown（规格 2026-10-07 T3）。
//
// 分工与屏幕重演同一条纪律——取舍不复制：
//   - 「哪些轮次、每轮什么内容」由 agent/replay.mjs 的 buildReplay 给出（本层只消费 items），
//     导出与屏幕重演、模型记忆说的是同一套事实；导出不设预算是调用方的事（D8）。
//   - 终态文案用 style.mjs 的 terminalStatusText（R5 同源）：导出的「已完成」与屏幕上
//     那一行是同一句话，不会各说一套。思考耗时同理（formatThinkingSeconds）。
//   - 本模块只做两件事：items → markdown 文本（纯函数），以及把文本写进创作目录根
//     （重名自动后缀，`wx` 探测绝不覆盖已有文件）。
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { formatThinkingSeconds, terminalStatusText } from './style.mjs';

// 本地时间 → `YYYY-MM-DD HH:mm`（meta 用）。与 session-row.mjs 的 formatTime 各自服务
// 不同场合（那边是会话列表行，这边是导出头），格式一致是刻意的——同一份时间在
// 屏幕与导出物里长一个样。
function formatDateTime(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 本地时间 → `YYYYMMDD-HHmmss`（文件名用，精确到秒才不会同分钟内互相挤）。
function fileStamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

// 一个重演项 → markdown 行块（无则返回空串）。
function itemToMarkdown(item) {
  if (item === null || typeof item !== 'object') return '';
  switch (item.kind) {
    case 'user':
      return typeof item.text === 'string' && item.text !== ''
        ? `## 用户\n\n${item.text}\n`
        : '';
    case 'thinking': {
      const text = formatThinkingSeconds(item.durationMs ?? null);
      return text === '' ? '' : `*${text}*\n`;
    }
    case 'prose':
      return typeof item.text === 'string' && item.text !== '' ? `${item.text}\n` : '';
    case 'status': {
      // 只带判据的 status 项在这里才翻译成文案（R5）：terminalStatusText 是唯一定义。
      const status = terminalStatusText(item);
      return status.text === '' ? '' : `*${status.text}*\n`;
    }
    default:
      return '';
  }
}

// 任务计划 → 任务清单。完成打勾，进行中注一句（markdown 任务清单没有「进行中」的形状）。
function planToMarkdown(plan) {
  if (!Array.isArray(plan) || plan.length === 0) return '';
  const lines = plan.map((step) => {
    const text = typeof step?.text === 'string' ? step.text : '';
    if (step?.status === 'completed') return `- [x] ${text}`;
    if (step?.status === 'in_progress') return `- [ ] ${text}（进行中）`;
    return `- [ ] ${text}`;
  });
  return `---\n\n## 任务计划\n\n${lines.join('\n')}\n`;
}

// 重演项 + 计划 + 头部 meta → 完整 markdown 文本。纯函数，不碰文件系统。
export function buildExportMarkdown({ items = [], plan = null, meta = {} } = {}) {
  const list = Array.isArray(items) ? items : [];
  const header = [
    '# 对话导出',
    '',
    `- 会话：${typeof meta.sessionId === 'string' && meta.sessionId !== '' ? meta.sessionId : '—'}`,
    `- 标题：${typeof meta.title === 'string' && meta.title !== '' ? meta.title : '—'}`,
    `- 导出时间：${formatDateTime(meta.exportedAt instanceof Date ? meta.exportedAt : new Date(0))}`,
    `- 轮数：${Number.isFinite(meta.turns) ? Math.floor(meta.turns) : 0}`,
    '',
    '---',
    '',
  ];
  const body = list.map(itemToMarkdown).filter((block) => block !== '');
  return [...header, ...body, planToMarkdown(plan)].join('\n');
}

// 写创作目录根（规格 2026-10-07 D10）：`对话导出-<时间戳>.md`，重名自动 -2…-99。
// flag 'wx' 探测重名：已有的导出文件绝不覆盖。99 次仍冲突如实抛错。
export async function writeExportFile({ projectRoot, markdown, clock = Date.now, fsImpl = null } = {}) {
  if (typeof projectRoot !== 'string' || projectRoot === '') {
    throw new Error('导出需要创作目录。');
  }
  const fs = fsImpl ?? { writeFile };
  const stamp = fileStamp(new Date(clock()));
  for (let n = 1; n <= 99; n += 1) {
    const name = n === 1 ? `对话导出-${stamp}.md` : `对话导出-${stamp}-${n}.md`;
    try {
      await fs.writeFile(path.join(projectRoot, name), markdown, { encoding: 'utf8', flag: 'wx' });
      return { name, path: path.join(projectRoot, name) };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw new Error(`无法写入导出文件：${name}`, { cause: error });
      }
    }
  }
  throw new Error('同一秒的导出文件重名太多，请稍后重试。');
}
