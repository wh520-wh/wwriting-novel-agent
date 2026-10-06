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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const INPUT_HISTORY_CAP = 500;

// 读历史：返回 oldest→newest 的原文数组（去空、去坏行、截尾到 cap）。
export async function loadInputHistory({ file, cap = INPUT_HISTORY_CAP } = {}) {
  if (typeof file !== 'string' || file === '') throw new Error('读输入历史需要文件路径。');
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    return []; // 读不出（权限/损坏）按空历史降级：历史是增强，不值得让启动失败。
  }
  const texts = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed?.text === 'string' && parsed.text !== '') texts.push(parsed.text);
    } catch {
      // 坏行跳过：半行崩溃残留、手工编辑都不拖垮整份历史。
    }
  }
  return texts.length > cap ? texts.slice(-cap) : texts;
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
  const fs = fsImpl ?? { mkdir, writeFile };
  const entry = `${JSON.stringify({ at: new Date(clock()).toISOString(), text })}\n`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, entry, { encoding: 'utf8', flag: 'a' });
  } catch {
    return false;
  }
  // 超限压缩（尽力而为）：只在「本次写完肯定超限」时重写一次截尾文件。
  // 按行数近似判定（每行至少一个换行），多压一次无害。
  try {
    const texts = await loadInputHistory({ file, cap: cap + 1 });
    if (texts.length > cap) {
      const kept = texts.slice(-cap);
      const body = kept
        .map((keptText) => JSON.stringify({ at: new Date(clock()).toISOString(), text: keptText }))
        .join('\n');
      await fs.writeFile(file, `${body}\n`, { encoding: 'utf8' });
    }
  } catch {
    // 压缩失败不影响本次记录。
  }
  return true;
}
