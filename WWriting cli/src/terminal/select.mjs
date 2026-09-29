// 上下键选择器（inline 渲染，不切 alternate screen）。
//
// 交互契约照搬 grokbuild 的选择器（Desktop/grokbuild源码 的 xai-grok-pager）：
//   ↑/↓（或 k/j）移动 · 回车确认 · 数字直选 · Esc 取消
// 渲染也照它的行视图：`❯` 标出光标行、选中行高亮、超出窗口时滚动、光标始终可见。
//
// 为什么不用「输入序号」：面对「模型厂商：1 DeepSeek 官方」这种提示，新用户会直接把自己的答案
// （模型名、API Key）敲进去，然后被拒绝——这正是要消灭的体验。选择器让人「选」而不是「猜」，
// 也就不存在「输错」这个状态。
//
// 纯逻辑与终端 I/O 分开：menuLines / menuAction 是纯函数（可单测），createSelector 只负责读写终端。
import readline from 'node:readline';

import { paintText, resolveColor } from './renderer.mjs';

// 光标行标记（与 grokbuild 一致）。
export const MENU_CURSOR = '❯';
export const MENU_UNSELECTED = ' ';

// 默认操作提示：把可用按键一次说清，别让用户试。
export const DEFAULT_HINT = '↑/↓ 选择 · 回车确认 · Esc 跳过';

const ERASE_LINE = '\r\x1b[K';
const ERASE_BELOW = '\x1b[J';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const cursorUp = (lines) => `\x1b[${lines}A`;

// 可见窗口：光标始终在窗口内（照 grokbuild 的 scroll_offset）。
export function menuWindow(count, selected, maxRows) {
  if (count <= maxRows) return { start: 0, end: count };
  const start = Math.min(Math.max(0, selected - maxRows + 1), count - maxRows);
  return { start, end: start + maxRows };
}

// 菜单块 → 若干行文本。title 一行、items 各一行、hint 一行（可选），中间可能插入滚动提示。
// color=false（NO_COLOR）时只剩 `❯` 标记；选择本身不依赖颜色。
export function menuLines({ title = null, items = [], selected = 0, hint = null, color = false, maxRows = 10 }) {
  const lines = [];
  if (title !== null) lines.push(paintText(title, 'accent', color));
  const { start, end } = menuWindow(items.length, selected, maxRows);
  if (start > 0) lines.push(paintText(`  … 上面还有 ${start} 项`, 'info', color));
  for (let index = start; index < end; index += 1) {
    const marked = index === selected;
    const prefix = marked ? MENU_CURSOR : MENU_UNSELECTED;
    const text = `${prefix} ${items[index].label}`;
    lines.push(marked ? paintText(text, 'accent', color) : text);
  }
  if (end < items.length) lines.push(paintText(`  … 下面还有 ${items.length - end} 项`, 'info', color));
  if (hint !== null) lines.push(paintText(`  ${hint}`, 'info', color));
  return lines;
}

// 一个按键 → 一个动作。返回 null 表示这个键与菜单无关（原样忽略，不报错）。
export function menuAction(key, { selected = 0, count = 0 } = {}) {
  const name = key && typeof key.name === 'string' ? key.name : '';
  const sequence = key && typeof key.sequence === 'string' ? key.sequence : '';
  const ctrl = Boolean(key && key.ctrl);

  if (name === 'up' || sequence === 'k') return { type: 'move', selected: Math.max(0, selected - 1) };
  if (name === 'down' || sequence === 'j') return { type: 'move', selected: Math.min(count - 1, selected + 1) };
  if (name === 'home') return { type: 'move', selected: 0 };
  if (name === 'end') return { type: 'move', selected: Math.max(0, count - 1) };
  if (name === 'return' || name === 'enter' || sequence === '\r' || sequence === '\n') return { type: 'confirm' };
  if (name === 'escape') return { type: 'cancel' };
  if (ctrl && name === 'c') return { type: 'cancel' };
  // 数字直选：老习惯（1 就是第一项）也照顾上，但不再是唯一入口。
  if (/^[1-9]$/.test(sequence)) {
    const index = Number(sequence) - 1;
    if (index < count) return { type: 'select', selected: index };
  }
  return null;
}

// createSelector({ stdin, stdout, env, color }) → { ask, canAsk }
//   ask({ title, items, hint, initialIndex, summary, cancelSummary }) → Promise<{ item, index }|null>
//     items: [{ id, label }]；null 表示用户取消（Esc / Ctrl+C）。
//     summary(item)      选中后把整块收成一行（进 scrollback），默认 `❯ label`。
//     cancelSummary      取消时收成的一行，默认 null（整块抹掉）。
//   非交互（没有 TTY 或拿不到原始按键）时 canAsk 为 false，ask 直接返回 null——
//   引导页只在可交互时启动，所以这条路径不会静默替用户做选择。
export function createSelector({ stdin, stdout, env = process.env, color } = {}) {
  const useColor = resolveColor({ color, env, stdout });
  // 屏幕上此刻这块菜单的高度（0 = 没画着）。重绘的上移量必须用它：块尾锚在光标处、
  // 动的是顶边，用**新块**高度上移时，块高在两次重绘之间变大就会多吃上方一行、
  // 变矮就会残留块顶一行（缺陷猎捕报告 10）。
  let onScreenHeight = 0;
  const canAsk = Boolean(
    stdin
    && typeof stdin.on === 'function'
    && typeof stdin.setRawMode === 'function'
    && stdin.isTTY
    && stdout
    && typeof stdout.write === 'function'
    && stdout.isTTY,
  );

  async function ask({
    title = null,
    items = [],
    hint = DEFAULT_HINT,
    initialIndex = 0,
    summary = (item) => `${MENU_CURSOR} ${item.label}`,
    cancelSummary = null,
    maxRows = 10,
  } = {}) {
    if (!Array.isArray(items) || items.length === 0) return null;
    if (!canAsk) return null;

    let selected = Math.min(Math.max(0, initialIndex), items.length - 1);
    const build = () => menuLines({ title, items, selected, hint, color: useColor, maxRows });
    let block = build();

    // 让出当前行（可能残留一个空提示行），再把菜单块写出来；
    // 之后每次重绘都「上移整块高度 → 逐行抹掉重写」，块尾始终停在新行的行首。
    stdout.write(ERASE_LINE);
    writeBlock(block);
    onScreenHeight = block.length;

    const wasRaw = stdin.isRaw === true;
    // 流是否已经在流动：菜单要 resume() 才能收到按键，但结束之后必须还回去——
    // 引导结束到对话面 readline 建立之间有一段空窗，此时若流还在 flowing，
    // 写进来的输入会因为没有 'data' 监听者而被直接丢掉（真实踩到：引导后第一条消息丢失）。
    const wasFlowing = stdin.readableFlowing === true;
    readline.emitKeypressEvents(stdin);
    try {
      stdin.setRawMode(true);
    } catch {
      // 极少数终端不支持 raw：那就退回非交互，不假装能选。
      collapse(block.length, null);
      return null;
    }
    stdin.resume();
    // 光标藏起来：选的时候光标停在块里没有意义，还会随重绘乱跳。
    // 这是光标控制码、不是颜色，所以 NO_COLOR 下照常。
    stdout.write(HIDE_CURSOR);

    return new Promise((resolve) => {
      const finish = (result, summaryLine) => {
        stdin.removeListener('keypress', onKey);
        try {
          stdin.setRawMode(wasRaw);
        } catch {
          // 恢复失败不影响结果，忽略。
        }
        if (!wasFlowing && typeof stdin.pause === 'function') stdin.pause();
        stdout.write(SHOW_CURSOR);
        collapse(block.length, summaryLine);
        resolve(result);
      };

      const onKey = (sequence, key) => {
        const action = menuAction(key, { selected, count: items.length });
        if (action === null) return;
        if (action.type === 'move') {
          if (action.selected !== selected) {
            selected = action.selected;
            block = build();
            redrawBlock(block);
          }
          return;
        }
        if (action.type === 'cancel') {
          finish(null, cancelSummary);
          return;
        }
        const index = action.type === 'select' ? action.selected : selected;
        if (action.type === 'select' && index !== selected) {
          selected = index;
          block = build();
          redrawBlock(block);
        }
        const item = items[index];
        // summary 可以是 null——那表示「整块抹掉」，确认行由调用方自己打（引导页就是这么用的）。
        finish({ item, index }, typeof summary === 'function' ? summary(item) : null);
      };

      stdin.on('keypress', onKey);
    });
  }

  function writeBlock(lines) {
    for (const line of lines) stdout.write(`${line}\n`);
  }

  function redrawBlock(lines) {
    if (onScreenHeight > 0) stdout.write(cursorUp(onScreenHeight));
    // 逐行先抹再写：新行比旧行短时，行尾残留也会被清掉。
    for (const line of lines) stdout.write(`${ERASE_LINE}${line}\n`);
    if (lines.length < onScreenHeight) stdout.write(ERASE_BELOW); // 新块变矮：块尾下方不再有旧块
    onScreenHeight = lines.length;
  }

  // 收尾：把整块换成一行（或整块抹掉），块尾留在新行行首。
  function collapse(height, summaryLine) {
    stdout.write(cursorUp(height));
    stdout.write(ERASE_LINE);
    if (summaryLine !== null && summaryLine !== undefined) stdout.write(`${summaryLine}\n`);
    stdout.write(ERASE_BELOW);
    onScreenHeight = 0; // 块已不在屏幕上
  }

  return { ask, canAsk };
}
