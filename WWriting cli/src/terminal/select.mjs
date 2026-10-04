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

import { paintText, resolveColor } from './style.mjs';
import { clipToWidth, displayWidth, padDisplayEnd, resolveColumns, takeProseRows } from './metrics.mjs';
import { createBlockLedger } from './block-ledger.mjs';

// 光标行标记（与 grokbuild 一致）。
export const MENU_CURSOR = '❯';
export const MENU_UNSELECTED = ' ';

// 默认操作提示：把可用按键一次说清，别让用户试。
export const DEFAULT_HINT = '↑/↓ 选择 · 回车确认 · Esc 跳过';

const ERASE_LINE = '\r\x1b[K';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

// 可见窗口：光标始终在窗口内（照 grokbuild 的 scroll_offset）。
export function menuWindow(count, selected, maxRows) {
  if (count <= maxRows) return { start: 0, end: count };
  const start = Math.min(Math.max(0, selected - maxRows + 1), count - maxRows);
  return { start, end: start + maxRows };
}

// 菜单块 → 若干行文本。title 一行、items 各一行、hint 一行（可选），中间可能插入滚动提示。
// color=false（NO_COLOR）时只剩 `❯` 标记；选择本身不依赖颜色。
export function menuLines({ title = null, items = [], selected = 0, hint = null, color = false, maxRows = 10, columns = 80 }) {
  const lines = [];
  const width = Math.max(4, resolveColumns(columns) - 1);
  const fit = (text) => displayWidth(text) <= width ? text : `${clipToWidth(text, width - 1)}…`;
  const labelWidth = Math.min(14, Math.max(...items.map((item) => displayWidth(item.label)), 0) + 2);
  if (title !== null) lines.push(paintText(fit(title), 'strong', color));
  const { start, end } = menuWindow(items.length, selected, maxRows);
  if (start > 0) lines.push(paintText(fit(`  … 上面还有 ${start} 项`), 'info', color));
  for (let index = start; index < end; index += 1) {
    const marked = index === selected;
    const prefix = marked ? MENU_CURSOR : MENU_UNSELECTED;
    const { label, description } = items[index];
    const text = `${prefix} ${label}`;
    const detail = typeof description === 'string' && description !== '' ? description : null;
    if (detail !== null && displayWidth(`${prefix} ${padDisplayEnd(label, labelWidth)}${detail}`) <= width) {
      const head = `${prefix} ${padDisplayEnd(label, labelWidth)}`;
      lines.push(`${marked ? paintText(head, 'accent', color) : head}${paintText(detail, 'info', color)}`);
    } else {
      lines.push(marked ? paintText(fit(text), 'accent', color) : fit(text));
      if (marked && detail !== null) {
        const rows = takeProseRows(`${detail}\n`, { width: Math.max(1, width - 2) }).rows;
        lines.push(...rows.slice(0, 2).map((row, i) => paintText(`  ${i === 1 && rows.length > 2 ? clipToWidth(row, width - 3) + '…' : row}`, 'info', color)));
      }
    }
  }
  if (end < items.length) lines.push(paintText(fit(`  … 下面还有 ${items.length - end} 项`), 'info', color));
  if (hint !== null) lines.push(paintText(fit(`  ${hint}`), 'info', color));
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
  // 屏幕块记账：「这块此刻在屏上占几行、擦除上移几格」收在 block-ledger 里
  // （缺陷猎捕报告 10 的机制有了唯一住址），选择器只负责画什么。
  const ledger = createBlockLedger({ write: (text) => stdout.write(text) });
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
    const build = () => menuLines({ title, items, selected, hint, color: useColor,
      maxRows: Math.max(1, Math.min(maxRows, (stdout.rows || 24) - 7)), columns: stdout.columns });
    let block = build();

    // 让出当前行（可能残留一个空提示行），再把菜单块写出来；
    // 之后每次重绘都「上移整块高度 → 逐行抹掉重写」，块尾始终停在新行的行首。
    stdout.write(ERASE_LINE);
    ledger.writeBlock(block);

    // 流是否已经在流动：菜单要 resume() 才能收到按键，但结束之后必须还回去——
    // 引导结束到对话面 readline 建立之间有一段空窗，此时若流还在 flowing，
    // 写进来的输入会因为没有 'data' 监听者而被直接丢掉（真实踩到：引导后第一条消息丢失）。
    const wasFlowing = stdin.readableFlowing === true;
    readline.emitKeypressEvents(stdin);
    try {
      stdin.setRawMode(true);
    } catch {
      // 极少数终端不支持 raw：那就退回非交互，不假装能选。
      ledger.collapse(null);
      return null;
    }
    stdin.resume();
    // 光标藏起来：选的时候光标停在块里没有意义，还会随重绘乱跳。
    // 这是光标控制码、不是颜色，所以 NO_COLOR 下照常。
    stdout.write(HIDE_CURSOR);

    return new Promise((resolve) => {
      let finished = false;
      const finish = (result, summaryLine) => {
        finished = true;
        stdin.removeListener('keypress', onKey);
        // 这里**刻意不恢复** raw 模式（曾按 wasRaw 恢复，真机 ConPTY 走查发现会吞键）：
        // 「raw false→true」紧挨着输出活动翻转时，宿主会丢掉恢复后第一波按键——
        // 而本应用里 ask() 结束后只有两条路：紧跟新建 readline（构造函数自己会设 raw=true），
        // 或 rl.close()（Node 关闭时自己翻回 raw=false，退出路径的卫生由它兜住）。
        // 两条路都不需要这里代劳，少一次翻转就没有竞态。
        if (!wasFlowing && typeof stdin.pause === 'function') stdin.pause();
        stdout.write(SHOW_CURSOR);
        ledger.collapse(summaryLine);
        resolve(result);
      };

      const onKey = (sequence, key) => {
        try {
          const action = menuAction(key, { selected, count: items.length });
          if (action === null) return;
          if (action.type === 'move') {
            if (action.selected !== selected) {
              selected = action.selected;
              block = build();
              ledger.redraw(block);
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
            ledger.redraw(block);
          }
          const item = items[index];
          // summary 可以是 null——那表示「整块抹掉」，确认行由调用方自己打（引导页就是这么用的）。
          finish({ item, index }, typeof summary === 'function' ? summary(item) : null);
        } catch (error) {
          // 按键处理半路炸了：finish 没跑成，光标还藏在块里——不还回去，整个会话从此没有光标。
          // 只补光标恢复，不吞异常：该炸的照样炸出来（与原语义一致），只是不再留下不可逆的副作用。
          if (!finished) stdout.write(SHOW_CURSOR);
          throw error;
        }
      };

      stdin.on('keypress', onKey);
    });
  }

  // 块的写出 / 重绘 / 收尾机制（上移量、逐行先抹再写、变矮补 ERASE_BELOW、高度归零）
  // 都在 block-ledger 里；选择器这里不再手写一遍。

  return { ask, canAsk };
}
