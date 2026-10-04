// 正文 Markdown 渲染（规格书 §4.10 的终端落地）：GFM 子集语义的增量块级解析 + 行内样式。
//
// 为什么手写而不是引 marked（ADR-0016）：正文是**流式写进 scrollback** 的，渲染器逐行
// 落盘、不能重排已写出的内容；marked 面向「拿到整篇再渲染」。本模块的契约因此是增量的：
// 能定的立刻吐出去，定不了的（表格候选行、半行）先攒着，但攒的东西有明确上界——
// 只有「可能是表格」的一行会等下一行，正常段落按行宽该吐就吐（流式感不损失）。
//
// 渲染顺序：**先上色、后折行**。折行器认识自己发出的 SGR（宽度按纯文本算，续行重开
// 生效中的样式），因此强调跨折行不会把 `**` 漏到屏幕上，也不会把半个标记吞掉。
//
// 语义范围（对齐 GFM，超出的按普通文本降级并保持原文可见）：
//   块级：标题（#..######）、段落、无序/有序列表（缩进嵌套 ≤3 层、- [ ] 任务项）、
//         引用（>，可嵌套）、分隔线（--- / * * *）、围栏代码（``` 起始，语言标记不解析）、
//         表格（**行需带前导竖线**——模型输出惯例；分隔行决定对齐）；
//   行内：`代码`、**粗**、*斜*、~~删除线~~、[文本](链接)、反斜杠转义（含 `\|`）。
//   不做（按原文输出，不静默吞）：图片（`![alt](url)` → `alt (url)`）、原始 HTML、脚注、
//   引用内的子块、嵌套强调、setext 标题、`~` 单击（GFM 本就不算删除线）。
//
// 块间垂直节奏（ADR-0019）：模型原文的空行照旧 1:1 透传；此外致密块（围栏代码、
// 表格、引用、分隔线）与相邻块之间、标题的**上方**自动补一个空行——决策键是 prevBlock，
// 收口在 needAir，绝不与原文空行叠加成双空行。段落与列表是 flow，互相之间不加自动空行；
// 标题向下绑定（标题与它引出的内容之间不留缝）。
import {
  CONTENT_INDENT, clipToWidth, displayWidth, proseRowWidth, takeProseRows, wrapCut,
} from './metrics.mjs';

const FENCE = /^\s*```/;
// 分隔线：允许标记之间带空格（CommonMark 的 `* * *` / `- - -`），否则会被列表项吃掉。
const HR = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const QUOTE = /^ {0,3}>/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const TASK_ITEM = /^\[([ xX])\]\s+(.*)$/;
const TABLE_ROW_START = /^\s*[|｜]/;
const TABLE_SEPARATOR = /^\s*[|｜]?\s*:?-{1,}:?\s*(?:[|｜]\s*:?-{1,}:?\s*)*[|｜]?\s*$/;

// 「半行暂时不能当段落软折行」的开头：等它成整行再判类型，避免把表格行/列表项切碎。
const HOLD_START = /^\s*(?:[|｜>#`]|[-*+]\s|\d{1,3}[.)]\s)/;

const MIN_COLUMN_WIDTH = 3;
const MAX_TABLE_ROW_LINES = 4;
const VERTICAL_RULE_WIDTH = 40;
const MAX_LIST_DEPTH = 3;
const ESCAPABLE = /[\\`*_~[\]()#+\-.!>|｜]/;

// 「撞上它要补呼吸空行」的块种类（ADR-0019）：致密块 + 引用。
// 上一块是段落/列表时，只有这些种类前来才在边界上补空行；段落与列表之间不补。
const AIR_ABOVE = new Set(['heading', 'code', 'table', 'quote', 'hr']);

const blank = (text) => String(text).trim() === '';
// 含行内标记/链接/转义的半行先不软折行（见 emitParagraph 的说明）。
const MARKERISH = /[*_~`[\]\\]/;
const spaces = (count) => ' '.repeat(Math.max(0, count));

function isSeparatorRow(line) {
  return TABLE_SEPARATOR.test(line) && /[|｜]/.test(line);
}

// —— 折行（先上色后折行） ——

const SGR = /\x1b\[[0-9;]*m/g;
// 只认识本模块发出的 SGR：样式开关（1/2/3/4/9）与颜色（38;5;N / 48;5;N）。其余原样透传。
const SGR_OPEN = /^\x1b\[([0-9;]+)m$/;

function stripSgr(text) {
  return String(text).replace(SGR, '');
}

// 带样式文本 → 按显示宽度折行。返回 [{ text: 上色行, width: 纯文本宽 }]。
// 每行结尾补 reset、续行开头重开生效中的样式——这就是「跨折行不漏标记」的全部机制。
function wrapStyled(styled, width, { wordWrap = false } = {}) {
  const limit = Math.max(1, Number.isFinite(width) ? Math.floor(width) : 80);
  const source = String(styled ?? '');
  if (source === '') return [{ text: '', width: 0 }];

  // 1) 切成 (字符, 生效码集合) 序列；同时记录纯文本。
  const chars = [];
  let active = [];
  let plain = '';
  let i = 0;
  while (i < source.length) {
    if (source[i] === '\x1b') {
      const match = SGR_OPEN.exec(source.slice(i, source.indexOf('m', i) + 1));
      if (match !== null) {
        const codes = match[1];
        active = codes === '0' ? [] : [...active, `\x1b[${codes}m`];
        i += match[0].length;
        continue;
      }
    }
    const code = source.codePointAt(i);
    const ch = String.fromCodePoint(code);
    chars.push({ ch, codes: active });
    plain += ch;
    i += ch.length;
  }

  // 2) 逐行切：wordWrap 走「整词优先」，否则走正文的标点/标记避让规则（wrapCut）。
  //    输出按「码变化才写转义」序列化：行尾补 reset、续行按需重开——行文字因此始终
  //    是自洽的（复制一行出去也不会带上半截样式）。
  const rows = [];
  let at = 0;
  while (at < chars.length) {
    const rest = plain.slice(at);
    let cut = wordWrap ? wordAwareCut(rest, limit) : wrapCut(rest, limit);
    if (cut <= 0) {
      // 标点/标记避让把整个切口退光了（比如一长串字面星号收尾）：按显示宽度硬切，
      // 宁可切在字中间也不让行超出终端（超宽会被终端自行折行，打乱 scrollback）。
      let used = 0;
      cut = 0;
      for (const ch of rest) {
        const w = displayWidth(ch);
        if (used + w > limit && used > 0) break;
        used += w;
        cut += ch.length;
      }
      if (cut === 0) cut = rest.length; // 连一个字符都放不下（极端宽度）：整段一行，避免死循环
    }
    const slice = chars.slice(at, at + cut);
    let text = '';
    let codeState = '';
    for (const char of slice) {
      const codes = char.codes.join('');
      if (codes !== codeState) text += `\x1b[0m${codes}`;
      text += char.ch;
      codeState = codes;
    }
    if (codeState !== '') text += '\x1b[0m';
    rows.push({ text, width: displayWidth(plain.slice(at, at + cut)) });
    at += cut;
  }
  return rows;
}

// 整词优先的切分（表格单元格用）：中文可逐字断，拉丁词整词搬行，超长词才硬切。
function wordAwareCut(text, width) {
  const units = [];
  let i = 0;
  while (i < text.length) {
    const code = text.codePointAt(i);
    const ch = String.fromCodePoint(code);
    if (/\s/.test(ch)) {
      units.push({ text: ch, kind: 'space' });
    } else if (/[\w]/.test(ch) && code < 0x2e80) {
      let word = ch;
      let j = i + ch.length;
      while (j < text.length) {
        const nextCode = text.codePointAt(j);
        const next = String.fromCodePoint(nextCode);
        if (!(/[\w]/.test(next) && nextCode < 0x2e80)) break;
        word += next;
        j += next.length;
      }
      units.push({ text: word, kind: 'word' });
      i = j;
      continue;
    } else {
      units.push({ text: ch, kind: 'char' });
    }
    i += ch.length;
  }

  let lineWidth = 0;
  let cut = 0; // 已接纳到 rest 的哪个位置
  let cursor = 0;
  let pendingSpace = 0;
  for (const unit of units) {
    const unitWidth = displayWidth(unit.text);
    if (unit.kind === 'space') {
      if (lineWidth === 0) { cursor += unit.text.length; continue; }
      pendingSpace += unit.text.length;
      continue;
    }
    if (lineWidth + unitWidth <= width) {
      lineWidth += unitWidth;
      cursor += pendingSpace + unit.text.length;
      pendingSpace = 0;
      cut = cursor;
      continue;
    }
    // 放不下：整词搬下一行（如果它自己一行放得下且当前行已有内容）。
    if (unitWidth <= width && lineWidth > 0) break;
    // 单词就超宽：硬切到行宽。
    if (unitWidth > width) {
      let used = 0;
      let take = 0;
      for (const ch of unit.text) {
        const w = displayWidth(ch);
        if (used + w > width && used > 0) break;
        used += w;
        take += ch.length;
      }
      cut = cursor + take;
      break;
    }
    cursor += unit.text.length + pendingSpace;
    pendingSpace = 0;
    cut = cursor;
    lineWidth = unitWidth;
  }
  void pendingSpace;
  return cut > 0 ? cut : Math.min(text.length, 1);
}

// —— 行内样式 ——

const INLINE_TONES = ['bold', 'em', 'strike'];

// 应用一组色调：多个同时生效时依次包一层（paint 的 reset 在文字之后，嵌套安全）。
function applyTones(text, tones, paint) {
  let out = text;
  for (const tone of tones) out = paint(out, tone);
  return out;
}

// 行内扫描：转义 → 行内代码 → 链接 → 粗/斜/删（状态开关式，flanking 规则见下）。
// 刻意不做嵌套强调与 setext 等 GFM 长尾（见文件头「不做」清单）——但**绝不吞字**：
// 不构成强调的标记一律按字面输出。
export function styleInline(text, paint) {
  const s = String(text ?? '');
  const open = { bold: false, em: false, strike: false };
  let out = '';
  let seg = '';
  const tonesOf = () => INLINE_TONES.filter((tone) => open[tone]);
  const flush = () => {
    if (seg === '') return;
    out += applyTones(seg, tonesOf(), paint);
    seg = '';
  };
  // 开启标记的两个条件：右侧非空白（左翼），且**本行后面确实存在可闭合的标记**——
  // 未闭合的 `**半个` 因此按字面输出（GFM 语义），绝不吞掉标记。
  // single=true 时只认「孤立」的单字符标记：`**` 里的星号不算 `*` 的闭合。
  const hasCloser = (from, mark, single) => {
    let at = s.indexOf(mark, from);
    while (at !== -1) {
      const isolated = single !== true || (s[at - 1] !== mark && s[at + 1] !== mark);
      if (isolated && !/\s/.test(s[at - 1] ?? ' ')) return true;
      at = s.indexOf(mark, at + mark.length);
    }
    return false;
  };
  const toggle = (tone, kind, prev, next, mark, rest, single) => {
    // kind='close' 要求左侧非空白（右翼）——`3 * 4 * 5`、`src/*` 因此不被当强调吃。
    if (kind === 'open') {
      if (open[tone]) return false;
      if (next === undefined || /\s/.test(next)) return false;
      if (!hasCloser(rest, mark, single)) return false;
      flush();
      open[tone] = true;
      return true;
    }
    if (!open[tone]) return false;
    if (prev === undefined || /\s/.test(prev)) return false;
    flush();
    open[tone] = false;
    return true;
  };

  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length && ESCAPABLE.test(s[i + 1])) {
      seg += s[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i) {
        flush();
        out += paint(s.slice(i + 1, end), 'code');
        i = end + 1;
        continue;
      }
    }
    if (s.startsWith('**', i) || s.startsWith('__', i)) {
      const mark = s.slice(i, i + 2);
      // `_` 的粗体只在词边界成立（snake_case__x 不被吃）。
      const wordSafe = mark === '**' || !/[\w]/.test(s[i - 1] ?? ' ');
      if (wordSafe) {
        if (toggle('bold', 'close', s[i - 1], s[i + 2], mark, i + 2)) { i += 2; continue; }
        if (toggle('bold', 'open', s[i - 1], s[i + 2], mark, i + 2)) { i += 2; continue; }
      }
    }
    if (s.startsWith('~~', i)) {
      if (toggle('strike', 'close', s[i - 1], s[i + 2], '~~', i + 2)) { i += 2; continue; }
      if (toggle('strike', 'open', s[i - 1], s[i + 2], '~~', i + 2)) { i += 2; continue; }
    }
    if (ch === '*' || ch === '_') {
      // 孤立判定：`**` / `__` 里的字符属于双标记，交给上面的粗体分支。
      const isolated = s[i - 1] !== ch && s[i + 1] !== ch;
      const wordSafe = isolated && (ch === '*' || (!/[\w]/.test(s[i - 1] ?? ' ') && !/[\w]/.test(s[i + 1] ?? ' ')));
      if (wordSafe) {
        if (toggle('em', 'close', s[i - 1], s[i + 1], ch, i + 1, true)) { i += 1; continue; }
        if (toggle('em', 'open', s[i - 1], s[i + 1], ch, i + 1, true)) { i += 1; continue; }
      }
    }
    if (ch === '[') {
      const closeText = s.indexOf(']', i + 1);
      if (closeText > i && s[closeText + 1] === '(') {
        const closeUrl = s.indexOf(')', closeText + 2);
        if (closeUrl > closeText + 1) {
          const label = s.slice(i + 1, closeText);
          const url = s.slice(closeText + 2, closeUrl);
          if (label === '') {
            flush();
            out += paint(url, 'code');
          } else {
            seg += styleInline(label, paint);
            if (label !== url) seg += ` ${paint(`(${url})`, 'code')}`;
          }
          i = closeUrl + 1;
          continue;
        }
      }
    }
    seg += ch;
    i += 1;
  }
  flush();
  return out;
}

// 去掉标记、只留文字（表宽计算、标题等要「显示宽度」的地方用）。
// 直接复用同一个解析器，paint 换成恒等函数——两处规则因此不可能漂移。
export function plainInline(text) {
  return styleInline(text, (value) => value);
}

// —— 表格 ——

// 按**未转义**的竖线切单元格：GFM 里单元格内的字面竖线写作 `\|`，不能当分隔符。
function splitUnescapedPipes(body) {
  const cells = [];
  let current = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '\\' && i + 1 < body.length) {
      current += ch + body[i + 1];
      i += 1;
      continue;
    }
    if (ch === '|' || ch === '｜') {
      cells.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current);
  return cells;
}

function splitRow(line) {
  let body = String(line).trim();
  if (/^[|｜]/.test(body)) body = body.slice(1);
  if (/[|｜]$/.test(body) && !/\\[|｜]$/.test(body)) body = body.slice(0, -1);
  return splitUnescapedPipes(body).map((cell) => cell.trim());
}

function alignmentsOf(separatorCells) {
  return separatorCells.map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });
}

// 列的最小宽度 = 不可断行的最长单元。拉丁词不可断；中文可以逐字断行，
// 因此按字算（照搬 CC 的「按空格切最长词」会让整句中文变成巨型不可断词，
// 三列表格在窄终端被压成每列 3 格宽——中文场景必须逐字看）。
function unbreakableWidth(text) {
  let longest = 0;
  let run = 0; // 连续 ASCII 词的累计宽
  for (let i = 0; i < text.length; i += 1) {
    const code = text.codePointAt(i);
    if (code > 0xffff) i += 1;
    const ch = String.fromCodePoint(code);
    if (/[\w]/.test(ch) && code < 0x2e80) {
      run += displayWidth(ch);
      longest = Math.max(longest, run);
    } else {
      run = 0;
      longest = Math.max(longest, displayWidth(ch));
    }
  }
  return longest;
}

function idealAndMin(cells) {
  let ideal = MIN_COLUMN_WIDTH;
  let min = MIN_COLUMN_WIDTH;
  for (const cell of cells) {
    const plain = plainInline(cell);
    ideal = Math.max(ideal, displayWidth(plain));
    min = Math.max(min, unbreakableWidth(plain));
  }
  return { ideal, min };
}

function padAligned(text, shownWidth, target, align) {
  const gap = Math.max(0, target - shownWidth);
  if (align === 'right') return `${spaces(gap)}${text}`;
  if (align === 'center') {
    const left = Math.floor(gap / 2);
    return `${spaces(left)}${text}${spaces(gap - left)}`;
  }
  return `${text}${spaces(gap)}`;
}

// 单元格 → 已上色、按列宽折好的行（整词优先）。
function cellRows(raw, columnWidth, { paint, header = false } = {}) {
  const styled = header ? paint(plainInline(raw), 'bold') : styleInline(raw, paint);
  return wrapStyled(styled, columnWidth, { wordWrap: true });
}

// 表格 → 显示行（不含缩进，由调用方加）。
// 三档：自然宽横排 → 按列折行 → 行高超 4 行或**总宽超可用宽度**时退化为纵向。
export function renderTable(table, { width, paint }) {
  const { header, aligns, rows } = table;
  const columns = header.length;
  const overhead = 1 + columns * 3; // │ + 每列「空格+内容+空格+│」
  const avail = Math.max(1, Number.isFinite(width) && width > 0 ? Math.floor(width) : 80) - overhead;

  const stats = header.map((_, index) => idealAndMin([header[index], ...rows.map((row) => row[index] ?? '')]));
  const totalIdeal = stats.reduce((sum, s) => sum + s.ideal, 0);
  const totalMin = stats.reduce((sum, s) => sum + s.min, 0);

  let columnWidths;
  if (totalIdeal <= avail) {
    columnWidths = stats.map((s) => s.ideal);
  } else { // 先给每列最小宽，再按「离理想宽最近」补齐——短表头不该为长文本列陪绑折行
    columnWidths = stats.map((s) => s.min);
    let extra = avail - totalMin;
    while (extra > 0) {
      let best = -1;
      for (let i = 0; i < columnWidths.length; i += 1) {
        const gap = stats[i].ideal - columnWidths[i];
        if (gap <= 0) continue;
        if (best === -1 || gap < stats[best].ideal - columnWidths[best]) best = i;
      }
      if (best === -1) break;
      columnWidths[best] += 1;
      extra -= 1;
    }
  }

  const headerRows = header.map((cell, index) => cellRows(cell, columnWidths[index], { paint, header: true }));
  const bodyRows = rows.map((row) => header.map((_, index) => cellRows(row[index] ?? '', columnWidths[index], { paint })));
  const maxRowLines = Math.max(1, ...bodyRows.map((cells) => Math.max(...cells.map((r) => r.length))));

  // 总宽复核：列宽下界（MIN_COLUMN_WIDTH）可能把总宽顶穿终端——画出来会被终端硬折行，
  // 把 scrollback 打乱（metrics 的「末列有毒」口径）。超了就退纵向。
  const totalWidth = 1 + columnWidths.reduce((sum, w) => sum + w + 3, 0);
  const limitWidth = Number.isFinite(width) && width > 0 ? Math.floor(width) : 80;
  if (maxRowLines > MAX_TABLE_ROW_LINES || totalWidth > limitWidth) {
    return renderVertical(table, { width: limitWidth, paint });
  }

  const lines = [];
  const border = (left, mid, cross, right) => left
    + columnWidths.map((w, index) => `${mid.repeat(w + 2)}${index < columns - 1 ? cross : right}`).join('');
  lines.push(paint(border('┌', '─', '┬', '┐'), 'rule'));
  const rowLines = (cells) => {
    const height = Math.max(...cells.map((r) => r.length));
    const rendered = [];
    for (let lineIndex = 0; lineIndex < height; lineIndex += 1) {
      let text = paint('│', 'rule');
      for (let col = 0; col < columns; col += 1) {
        const cell = cells[col][lineIndex] ?? { text: '', width: 0 };
        text += ` ${padAligned(cell.text, cell.width, columnWidths[col], aligns[col])} ${paint('│', 'rule')}`;
      }
      rendered.push(text);
    }
    return rendered;
  };
  lines.push(...rowLines(headerRows));
  lines.push(paint(border('├', '─', '┼', '┤'), 'rule'));
  for (const cells of bodyRows) lines.push(...rowLines(cells));
  lines.push(paint(border('└', '─', '┴', '┘'), 'rule'));
  return lines;
}

// 纵向退化：每行数据 = 若干「表头: 值」，行与行之间一条横线（Claude Code 同款）。
// 表头/值都按可用宽度重新折行，绝不超出内容列。
function renderVertical(table, { width, paint }) {
  const { header, rows } = table;
  const limit = Math.max(1, Number.isFinite(width) && width > 0 ? Math.floor(width) : 80);
  const out = [];
  const rule = paint('─'.repeat(Math.min(limit, VERTICAL_RULE_WIDTH)), 'rule');
  rows.forEach((row, rowIndex) => {
    if (rowIndex > 0) out.push(rule);
    header.forEach((headRaw, col) => {
      let label = plainInline(headRaw) || `第 ${col + 1} 列`;
      if (displayWidth(label) + 4 > limit) label = clipToWidth(label, Math.max(1, limit - 4));
      const labelWidth = displayWidth(label);
      const value = styleInline(row[col] ?? '', paint);
      const firstWidth = Math.max(1, limit - labelWidth - 3);
      const wrapped = wrapStyled(value, firstWidth, { wordWrap: true });
      const first = wrapped[0] ?? { text: '', width: 0 };
      out.push(`${paint(`${label}:`, 'bold')} ${first.text}`);
      const rest = wrapped.slice(1);
      if (rest.length > 0) {
        const contWidth = Math.max(1, limit - 2);
        const tailText = rest.map((r) => stripSgr(r.text)).join(' ');
        for (const line of wrapStyled(tailText, contWidth, { wordWrap: true })) {
          out.push(`  ${line.text}`);
        }
      }
    });
  });
  return out;
}

// —— 增量块级解析 ——

// 用法：writer.push(delta) → 可立即写出的显示行；writer.flush() → 强制清空所有缓冲；
// writer.reset() → 丢弃未完成的块状态（Run 边界：不许上一轮的半截围栏污染下一轮）。
// columns 用函数传入：终端宽度随时可变，每次排版都现读。
export function createMarkdownWriter({
  paint, columns, indent = CONTENT_INDENT, leadMark = null,
} = {}) {
  if (typeof paint !== 'function') throw new Error('Markdown writer 需要一个 paint 函数。');
  if (typeof columns !== 'function') throw new Error('Markdown writer 需要 columns 取值函数。');

  const width = () => proseRowWidth(columns());
  const pad = spaces(indent);
  const lead = leadMark === null ? pad : leadMark;

  let buffer = '';
  let mode = 'idle'; // idle | para | code | table-candidate | table
  let paraTail = ''; // 当前段落行里「还不到一行宽」的尾巴（原文，含标记）
  let leadDone = false; // 本段是否已落过段首标记
  let candidate = null; // 表格候选行（等下一行是不是分隔行）
  let tableRows = []; // 已确认的表格原始行（含表头与分隔行）
  let prevBlock = 'none'; // none | blank | flow | quote | dense —— 块间垂直节奏的决策键

  // 块边界要不要补一个呼吸空行（ADR-0019）。prev 是致密块或引用时，除引用续行外都补；
  // prev 是段落/列表时只有撞上致密块才补；none（流开头）与 blank（原文空行刚透传过）永不补。
  function needAir(current) {
    if (prevBlock === 'none' || prevBlock === 'blank') return false;
    if (prevBlock === 'flow') return AIR_ABOVE.has(current);
    return current !== 'quote';
  }

  // 一段文本按行宽折行、逐行加上前缀：首行 prefix、续行 contPrefix；先上色后折行。
  function pushStyled(out, raw, { prefix, contPrefix, limit }) {
    const rows = wrapStyled(styleInline(raw, paint), limit);
    rows.forEach((row, index) => out.push(`${index === 0 ? prefix : contPrefix}${row.text}`));
  }

  // 完整的一行按给定行宽折行（不经行内样式；代码块用）。
  function pushCode(out, raw, limit) {
    const { rows, rest } = takeProseRows(`${raw}\n`, { width: limit });
    const all = rest === '' ? rows : [...rows, rest];
    for (const row of all) out.push(`${pad}  ${paint(row, 'code')}`);
  }

  // complete=true 表示这是完整的一行（尾部全部吐出去）；false 表示半行，不够一行的
  // 尾巴留在 paraTail 里等续文。半行**不做行内样式扫描**——半个标记会被误当字面量。
  function emitParagraph(out, text, { complete = false } = {}) {
    mode = 'para';
    const limit = width();
    const prefix = leadDone ? pad : lead;
    if (!complete) {
      // 半行软折行：**只对没有任何标记字符的纯文本**做——整词/标记可能被后续文字补齐，
      // 先折后上色会把一对 `**` 劈到两行、裸标记漏到屏幕上。带标记的半行等换行再排
      // （多数情况下一瞬间就到），纯文本段落照旧逐行冒出。
      if (MARKERISH.test(text)) {
        paraTail = text;
        return;
      }
      const { rows, rest } = takeProseRows(text, { width: limit });
      if (rows.length > 0) {
        if (needAir('para')) out.push('');
        rows.forEach((row, index) => {
          out.push(`${index === 0 ? prefix : pad}${row}`);
        });
        leadDone = true;
        prevBlock = 'flow';
      }
      paraTail = rest;
      return;
    }
    // 完整行：先按换行切**逻辑行**，再逐逻辑行「先上色、后折行」——强调跨折行不漏标记。
    const logical = String(text).split('\n');
    if (needAir('para') && logical.length > 0) out.push('');
    logical.forEach((line, lineIndex) => {
      const head = lineIndex === 0 ? prefix : pad;
      for (const row of wrapStyled(styleInline(line, paint), limit)) out.push(`${head}${row.text}`);
    });
    if (logical.length > 0) {
      leadDone = true;
      prevBlock = 'flow';
    }
    paraTail = '';
  }

  function closeParagraph() {
    paraTail = '';
    leadDone = false;
    if (mode === 'para') mode = 'idle';
  }

  function emitHeading(out, depth, text) {
    if (needAir('heading')) out.push('');
    const tone = depth === 1 ? 'h1' : 'bold';
    const limit = Math.max(1, width());
    for (const row of wrapStyled(plainInline(text), limit)) out.push(`${pad}${paint(row.text, tone)}`);
    // 标题只在**上方**要空行：它归属下方的内容，标题与列表/代码之间不留缝（向下绑定）。
    prevBlock = 'flow';
  }

  function emitQuote(out, line) {
    if (needAir('quote')) out.push('');
    const depth = Math.min((line.match(/^\s*(?:>\s*)+/) ?? [''])[0].split('>').length - 1, MAX_LIST_DEPTH);
    const text = line.replace(/^\s*(?:>\s*)+/, '');
    const barCount = Math.max(1, depth);
    const barPlain = '│ '.repeat(barCount);
    const bar = paint(barPlain, 'dim');
    const limit = Math.max(1, width() - displayWidth(barPlain));
    for (const row of wrapStyled(styleInline(text, paint), limit)) out.push(`${pad}${bar}${row.text}`);
    prevBlock = 'quote';
  }

  function emitListItem(out, indentText, marker, content) {
    if (needAir('list')) out.push('');
    const sourceIndent = indentText.replace(/\t/g, '  ');
    const depth = Math.min(Math.floor(sourceIndent.length / 2), MAX_LIST_DEPTH);
    const headPad = `${pad}${spaces(depth * 2)}`;
    const task = TASK_ITEM.exec(content);
    const checked = task !== null && task[1].toLowerCase() === 'x';
    let glyph;
    let rest = content;
    if (task !== null) {
      glyph = checked ? '☑ ' : '☐ ';
      rest = task[2];
    } else if (/^\d/.test(marker)) {
      glyph = `${marker} `;
    } else {
      glyph = '- ';
    }
    const markerWidth = displayWidth(glyph);
    const limit = Math.max(1, width() - depth * 2 - markerWidth);
    const head = `${headPad}${checked ? paint(glyph, 'success') : glyph}`;
    const cont = `${headPad}${spaces(markerWidth)}`;
    const rows = wrapStyled(styleInline(rest, paint), limit);
    rows.forEach((row, index) => {
      const body = checked ? paint(plainInline(row.text), 'done') : row.text;
      out.push(`${index === 0 ? head : cont}${body}`);
    });
    prevBlock = 'flow';
  }

  function emitTable(out) {
    if (needAir('table')) out.push('');
    const rows = tableRows;
    tableRows = [];
    mode = 'idle';
    prevBlock = 'dense';
    const header = splitRow(rows[0] ?? '');
    const aligns = alignmentsOf(splitRow(rows[1] ?? ''));
    while (aligns.length < header.length) aligns.push('left');
    const body = rows.slice(2).map(splitRow);
    for (const line of renderTable({ header, aligns, rows: body }, { width: width(), paint })) {
      out.push(`${pad}${line}`);
    }
  }

  function handleTableCandidate(out, line) {
    if (isSeparatorRow(line)) {
      tableRows = [candidate, line];
      candidate = null;
      mode = 'table';
      return;
    }
    const held = candidate;
    candidate = null;
    mode = 'idle';
    if (held !== null) emitParagraph(out, held, { complete: true });
    handleLine(out, line);
  }

  function handleLine(out, line) {
    for (;;) {
      if (mode === 'code') {
        if (FENCE.test(line)) {
          mode = 'idle';
        } else {
          pushCode(out, line, Math.max(1, width() - 2));
        }
        return;
      }
      if (mode === 'table') {
        if (TABLE_ROW_START.test(line)) {
          tableRows.push(line);
          return;
        }
        emitTable(out);
        continue; // 这一行交给下面的常规判定
      }
      if (mode === 'table-candidate') {
        handleTableCandidate(out, line);
        return;
      }
      if (FENCE.test(line)) {
        closeParagraph();
        if (needAir('code')) out.push('');
        mode = 'code';
        prevBlock = 'dense';
        return;
      }
      if (blank(line)) {
        closeParagraph();
        out.push('');
        prevBlock = 'blank';
        return;
      }
      if (HR.test(line)) {
        closeParagraph();
        if (needAir('hr')) out.push('');
        out.push(`${pad}${paint('─'.repeat(Math.max(1, width())), 'rule')}`);
        prevBlock = 'dense';
        return;
      }
      const head = HEADING.exec(line);
      if (head !== null) {
        closeParagraph();
        emitHeading(out, head[1].length, head[2]);
        return;
      }
      if (QUOTE.test(line)) {
        closeParagraph();
        emitQuote(out, line);
        return;
      }
      const item = LIST_ITEM.exec(line);
      if (item !== null) {
        closeParagraph();
        emitListItem(out, item[1], item[2], item[3]);
        return;
      }
      if (TABLE_ROW_START.test(line)) {
        candidate = line;
        mode = 'table-candidate';
        return;
      }
      emitParagraph(out, line, { complete: true });
      return;
    }
  }

  function drain() {
    const out = [];
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl === -1) break;
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (paraTail !== '') {
        line = paraTail + line;
        paraTail = '';
      }
      handleLine(out, line);
    }
    // 半行：只有「不可能是块级开头」的那些才当场按段落软折行吐出去
    if (buffer !== '' && (mode === 'para' || mode === 'idle') && !HOLD_START.test(buffer)) {
      emitParagraph(out, paraTail + buffer);
      buffer = '';
    } else if (mode === 'para') {
      paraTail += buffer;
      buffer = '';
    }
    return out;
  }

  // 强制收尾。顺序很重要（曾经的缺陷）：先把「差一个换行」的表格结构认下来并落地，
  // 再吐尾巴——绝不能让收尾路径把已确认的表格/候选行整块丢掉。
  function flush() {
    const out = [];
    let tail = paraTail + buffer;
    paraTail = '';
    buffer = '';
    if (tail !== '' && mode === 'table-candidate' && isSeparatorRow(tail)) {
      tableRows = [candidate, tail];
      candidate = null;
      tail = '';
      mode = 'table';
    } else if (tail !== '' && mode === 'table' && TABLE_ROW_START.test(tail)) {
      tableRows.push(tail);
      tail = '';
    }
    if (mode === 'table') {
      emitTable(out);
    } else if (mode === 'table-candidate') {
      const held = candidate;
      candidate = null;
      mode = 'idle';
      if (held !== null) emitParagraph(out, held, { complete: true });
    }
    if (tail !== '') {
      if (mode === 'code') pushCode(out, tail, Math.max(1, width() - 2));
      else emitParagraph(out, tail, { complete: true });
    }
    // flush 的使用场景就是「马上要写别的东西」：段落到此为止，下一片正文是新的一段
    // （工具行之后模型再开口要重新带段首标记）。节奏状态一并归零——下一段正文永远
    // 不带前导空行（与 UI 行之间的空行是 flushProse 的 gap 职责，不归这里管）。
    closeParagraph();
    prevBlock = 'none';
    return out;
  }

  // 丢弃一切未完成的块状态（不含已吐出的行）。Run/会话边界调用：上一轮的半截围栏、
  // 表格候选行绝不允许泄漏到下一轮。
  function reset() {
    buffer = '';
    paraTail = '';
    candidate = null;
    tableRows = [];
    leadDone = false;
    mode = 'idle';
    prevBlock = 'none';
  }

  return {
    push(text = '') {
      buffer += String(text).replace(/\r\n?/g, '\n');
      return drain();
    },
    flush,
    reset,
  };
}
