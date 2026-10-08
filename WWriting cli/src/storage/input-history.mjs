// 输入历史持久化（规格 2026-10-07 T4/D11-D12）：每个工作区一份 JSONL，跨进程可用。
//
// 布局（应用私有区，铁律 8）：`<workspaceDir>/input-history.jsonl`，每行 `{ at, text }`。
// 记录点在组合根的提交入口（onSubmit）：命令、普通正文、Ctrl+S 的立即提交都算输入；
// 空行与裸 `/` 在输入层本就不提交，到不了这里。
//
// 纪律：
//   - 相邻去重由调用方声明（`previous` = 上一条已记录的原文）：连续重发同一条不产生重复行。
//   - 上限 500 条：load 时截尾；发现文件超限顺手重写压缩（写失败静默——历史是增强，
//     绝不让一次 I/O 抖动打扰对话面）。
//   - 坏行跳过不抛：手工编辑、半行崩溃残留都不该让「读历史」失败。
import * as fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const INPUT_HISTORY_CAP = 500;

// 读历史：返回 oldest→newest 的原文数组（去空、去坏行、截尾到 cap）。
export async function loadInputHistory({ file, cap = INPUT_HISTORY_CAP, fsImpl = null } = {}) {
  if (typeof file !== 'string' || file === '') throw new Error('读输入历史需要文件路径。');
  const fs = fsImpl ?? fsp;
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return []; // 读不出（权限/损坏）按空历史降级：历史是增强，不值得让启动失败。
  }
  let entries = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed?.text === 'string' && parsed.text !== '') entries.push(parsed);
    } catch {
      // 坏行跳过：半行崩溃残留、手工编辑都不拖垮整份历史。
    }
  }
  if (entries.length > cap) {
    entries = entries.slice(-cap);
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      // 保留原时间戳；写好后才替换，压缩失败不能截断旧历史。
      await fs.writeFile(tmp, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
      await fs.rename(tmp, file);
    } catch {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }
  return entries.map((entry) => entry.text);
}

// 记一条输入。`previous` 是调用方记忆里上一条已记录的原文：相同即跳过（相邻去重）。
// 返回是否真的落了一行；写失败静默返回 false（调用方无需也不该为此打扰用户）。
// fsImpl 可注入（测试替身）。
export async function recordInput({
  file, text, previous = null, clock = Date.now, cap = INPUT_HISTORY_CAP, fsImpl = null,
} = {}) {
  if (typeof file !== 'string' || file === '') return false;
  if (typeof text !== 'string' || text.trim() === '') return false;
  if (text === previous) return false;
  const fs = fsImpl ?? fsp;
  const entry = `${JSON.stringify({ at: new Date(clock()).toISOString(), text })}\n`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, entry, { encoding: 'utf8', flag: 'a' });
  } catch {
    return false;
  }
  await loadInputHistory({ file, cap, fsImpl: fs });
  return true;
}
