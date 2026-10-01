// 正文 Markdown 渲染（规格书 §4.10 的终端落地）：GFM 子集语义的增量块级解析 + 行内样式。
//
// 为什么手写而不是引 marked（ADR-0016）：正文是**流式写进 scrollback** 的，渲染器逐行
// 落盘、不能重排已写出的内容；marked 面向「拿到整篇再渲染」。本模块的契约因此是增量的：
// 能定的立刻吐出去，定不了的（表格候选行、半行）先攒着，但攒的东西有明确上界——
// 只有「可能是表格」的一行会等下一行，正常段落按行宽该吐就吐（流式感不损失）。
//
// 语义范围（对齐 GFM，超出的按普通文本降级）：
//   块级：标题（#..######）、段落、无序/有序列表（含缩进嵌套与 - [ ] 任务项）、
//         引用（>，可嵌套）、分隔线（---）、围栏代码、表格；
//   行内：`代码`、**粗**、*斜*、~~删除线~~、[文本](链接)、反斜杠转义。
//   图片 / HTML / 脚注 / 表格内换行不做，按原文降级。
//
// 表格排版（借 Claude Code 的 MarkdownTable 策略）：列宽先按内容取自然宽；放不下就按
// 各列最小宽（最长单词）分配剩余空间；还放不下就等比压缩并允许拆词；单元格折行后行高
// 超过 4 行则整表退化为纵向「表头: 值」格式（窄终端可读性更好）。表头行加粗，
// 分隔行决定对齐（左/中/右），中文按 2 列宽计算（metrics 的唯一口径）。
import {
  CONTENT_INDENT, displayWidth, proseRowWidth, takeProseRows,
} from './metrics.mjs';

const FENCE = /^\s*```/;
const HR = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const QUOTE = /^ {0,3}>/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const TASK_ITEM = /^\[([ xX])\]\s+(.*)$/;
const TABLE_ROW_START = /^\s*[|｜]/;
const TABLE_SEPARATOR = /^\s*[|｜]?\s*:?-{1,}:?\s*(?:[|｜]\s*:?-{1,}:?\s*)*[|｜]?\s*$/;

// 「半行暂时不能当段落软折行」的开头：等它成整行再判类型，避免把表格行/列表项切碎。
const HOLD_START = /^\s*(?:[|｜>#`]|[-*+]\s|\d{1,3}[.)]\s)/;

export const MIN_COLUMN_WIDTH = 3;
export const MAX_TABLE_ROW_LINES = 4;
const VERTICAL_RULE_WIDTH = 40;
const MAX_LIST_DEPTH = 3;

const blank = (text) => String(text).trim() === '';

// —— 行内样式 ——

// 单行内联样式：转义 → 行内代码 → 粗体 → 删除线 → 强调 → 链接。
// paint(text, tone) 由调用方注入（NO_COLOR / 测试替身因此都只是换一个 paint）。
export function styleInline(text, paint) {
  const s = String(text ?? '');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    // 反斜杠转义：\* → *，\\ → \
    if (ch === '\\' && i + 1 < s.length && /[\\`*_~[\]()#+\-.!>|]/.test(s[i + 1])) {
      out += s[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i) {
        out += paint(s.slice(i + 1, end), 'code');
        i = end + 1;
        continue;
      }
    }
    if (s.startsWith('**', i) || s.startsWith('__', i)) {
      const mark = s.slice(i, i + 2);
      const end = s.indexOf(mark, i + 2);
      if (end > i + 2 && !s.slice(i + 2, end).includes('\n')) {
        out += paint(s.slice(i + 2, end), 'bold');
        i = end + 2;
        continue;
      }
    }
    if (s.startsWith('~~', i)) {
      const end = s.indexOf('~~', i + 2);
      if (end > i + 2) {
        out += paint(s.slice(i + 2, end), 'strike');
        i = end + 2;
        continue;
      }
    }
    if (ch === '*' || ch === '_') {
      const end = s.indexOf(ch, i + 1);
      const inner = end > i + 1 ? s.slice(i + 1, end) : '';
      // `_` 强调只在词边界上成立（snake_case 不能被吃掉）；`*` 不做限制。
      const boundary = ch === '*'
        || (!/[\w]/.test(s[i - 1] ?? ' ') && !/[\w]/.test(s[end + 1] ?? ' '));
      if (end > i + 1 && !inner.includes('\n') && boundary) {
        out += paint(inner, 'em');
        i = end + 1;
        continue;
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
            out += paint(url, 'code');
          } else {
            out += styleInline(label, paint);
            if (label !== url) out += ` ${paint(`(${url})`, 'code')}`;
          }
          i = closeUrl + 1;
          continue;
        }
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

// 去掉标记、只留文字（表宽计算、标题等要「显示宽度」的地方用）。
// 直接复用 styleInline 的解析器，paint 换成恒等函数——两处规则因此不可能漂移。
export function plainInline(text) {
  return styleInline(text, (value) => value);
}

// —— 表格 ——

function splitRow(line) {
  let body = String(line).trim();
  body = body.replace(/^[|｜]/, '').replace(/[|｜]$/, '');
  return body.split(/[|｜]/).map((cell) => cell.trim());
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

function padAligned(text, shownWidth, target, align) {
  const gap = Math.max(0, target - shownWidth);
  if (align === 'right') return `${' '.repeat(gap)}${text}`;
  if (align === 'center') {
    const left = Math.floor(gap / 2);
    return `${' '.repeat(left)}${text}${' '.repeat(gap - left)}`;
  }
  return `${text}${' '.repeat(gap)}`;
}

function cellLines(raw, columnWidth) {
  const { rows, rest } = takeProseRows(`${raw}\n`, { width: columnWidth });
  return rest === '' ? rows : [...rows, rest];
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

// 表格 → 显示行（不含缩进，由调用方加）。竖向退化在窄终端下比硬挤成多行格子可读。
export function renderTable(table, { width, paint }) {
  const { header, aligns, rows } = table;
  const columns = header.length;
  const overhead = 1 + columns * 3; // │ + 每列「空格+内容+空格+│」
  const avail = Math.max(1, Number.isFinite(width) && width > 0 ? Math.floor(width) : 80) - overhead;

  const stats = header.map((_, index) => idealAndMin([header[index], ...rows.map((row) => row[index] ?? '')]));
  const totalIdeal = stats.reduce((sum, s) => sum + s.ideal, 0);
  const totalMin = stats.reduce((sum, s) => sum + s.min, 0);

  let columnWidths;
  let needHardWrap = false;
  if (totalIdeal <= avail) {
    columnWidths = stats.map((s) => s.ideal);
  } else if (totalMin <= avail) {
    // 先把「离理想宽最近」的列补齐，再喂长列：短表头（人物/身份）不该为了长文本列
    // 陪绑折行；剩下的空间最后全归超长列（它反正要折行）。
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
  } else {
    needHardWrap = true;
    const scale = avail / totalMin;
    columnWidths = stats.map((s) => Math.max(Math.floor(s.min * scale), MIN_COLUMN_WIDTH));
  }

  const wrapCell = (raw, columnWidth) => {
    const lines = cellLines(raw, columnWidth);
    if (!needHardWrap) return lines;
    // 允许拆词：把超宽的长词硬切到列宽内
    return lines.flatMap((line) => (displayWidth(line) <= columnWidth ? [line] : hardSplit(line, columnWidth)));
  };

  const headerLines = header.map((cell, index) => wrapCell(cell, columnWidths[index]));
  const bodyLines = rows.map((row) => header.map((_, index) => wrapCell(row[index] ?? '', columnWidths[index])));
  const maxRowLines = Math.max(
    1,
    ...bodyLines.map((cells) => Math.max(...cells.map((lines) => lines.length))),
  );

  if (maxRowLines > MAX_TABLE_ROW_LINES) return renderVertical(table, { width, paint });

  const lines = [];
  const border = (left, mid, cross, right) => left
    + columnWidths.map((w, index) => `${mid.repeat(w + 2)}${index < columns - 1 ? cross : right}`).join('');
  lines.push(paint(border('┌', '─', '┬', '┐'), 'rule'));
  const rowLine = (cells, { bold = false, isHeader = false } = {}) => {
    const height = Math.max(...cells.map((c) => c.length));
    const rendered = [];
    for (let lineIndex = 0; lineIndex < height; lineIndex += 1) {
      let text = paint('│', 'rule');
      for (let col = 0; col < columns; col += 1) {
        const raw = cells[col][lineIndex] ?? '';
        const shown = plainInline(raw);
        const styled = isHeader || bold ? paint(shown, 'bold') : styleInline(raw, paint);
        const widthShown = displayWidth(shown);
        text += ` ${padAligned(styled, widthShown, columnWidths[col], aligns[col])} ${paint('│', 'rule')}`;
      }
      rendered.push(text);
    }
    return rendered;
  };
  lines.push(...rowLine(headerLines, { isHeader: true }));
  lines.push(paint(border('├', '─', '┼', '┤'), 'rule'));
  for (const cells of bodyLines) lines.push(...rowLine(cells));
  lines.push(paint(border('└', '─', '┴', '┘'), 'rule'));
  return lines;
}

function hardSplit(text, width) {
  const out = [];
  let rest = text;
  while (displayWidth(rest) > width) {
    let cut = 0;
    let used = 0;
    for (let i = 0; i < rest.length; i += 1) {
      const code = rest.codePointAt(i);
      if (code > 0xffff) i += 1;
      const cols = displayWidth(String.fromCodePoint(code));
      if (used + cols > width) break;
      used += cols;
      cut = i + (code > 0xffff ? 1 : 0) + 1;
    }
    if (cut === 0) break;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest !== '') out.push(rest);
  return out;
}

// 纵向退化：每行数据 = 若干「表头: 值」，行与行之间一条横线（Claude Code 同款）。
function renderVertical(table, { width, paint }) {
  const { header, rows } = table;
  const out = [];
  const rule = paint('─'.repeat(Math.min(Math.max(1, width), VERTICAL_RULE_WIDTH)), 'rule');
  rows.forEach((row, rowIndex) => {
    if (rowIndex > 0) out.push(rule);
    header.forEach((headRaw, col) => {
      const label = plainInline(headRaw) || `第 ${col + 1} 列`;
      const value = plainInline(row[col] ?? '');
      if (value === '') return;
      const firstWidth = Math.max(10, width - displayWidth(label) - 3);
      const { rows: firstRows, rest } = takeProseRows(`${value}\n`, { width: firstWidth });
      const lines = rest === '' ? firstRows : [...firstRows, rest];
      const head = paint(`${label}:`, 'bold');
      out.push(`${head} ${styleInline(lines[0] ?? '', paint)}`);
      const tail = lines.slice(1).join(' ');
      if (tail !== '') {
        const contWidth = Math.max(10, width - 3);
        out.push(...takeProseRows(`${tail}\n`, { width: contWidth }).rows.map((line) => `  ${styleInline(line, paint)}`));
      }
    });
  });
  return out;
}

// —— 增量块级解析 ——

// 用法：writer.push(delta) → 可立即写出的显示行；writer.flush() → 强制清空所有缓冲。
// columns 用函数传入：终端宽度随时可变，每次排版都现读。
export function createMarkdownWriter({
  paint, columns, indent = CONTENT_INDENT, leadMark = null,
} = {}) {
  if (typeof paint !== 'function') throw new Error('Markdown writer 需要一个 paint 函数。');
  if (typeof columns !== 'function') throw new Error('Markdown writer 需要 columns 取值函数。');

  const width = () => proseRowWidth(columns());
  const pad = ' '.repeat(Math.max(0, indent));
  const lead = leadMark === null ? pad : leadMark;

  let buffer = '';
  let mode = 'idle'; // idle | para | code | table-candidate | table
  let paraTail = ''; // 当前段落行里「还不到一行宽」的尾巴（原文，含标记）
  let leadDone = false; // 本段是否已落过段首标记
  let candidate = null; // 表格候选行（等下一行是不是分隔行）
  let tableRows = []; // 已确认的表格原始行（含表头与分隔行）

  // 一行文本按给定前缀排版：首行用 prefix，续行用 contPrefix；正文行内样式照常。
  // complete=true 表示这是完整的一行（末尾补 \n，尾部全部吐出去）；false 表示半行，
  // 不够一行的尾巴留在 paraTail 里等续文。
  function emitParagraph(out, text, { complete = false } = {}) {
    mode = 'para';
    const limit = width();
    const prefix = leadDone ? pad : lead;
    const { rows, rest } = takeProseRows(complete ? `${text}\n` : text, { width: limit });
    rows.forEach((row, index) => {
      const head = index === 0 ? prefix : pad;
      out.push(`${head}${styleInline(row, paint)}`);
    });
    if (rows.length > 0) leadDone = true;
    paraTail = complete ? '' : rest;
  }

  function closeParagraph() {
    paraTail = '';
    leadDone = false;
    if (mode === 'para') mode = 'idle';
  }

  function emitCode(out, text) {
    const limit = Math.max(1, width() - 2);
    const { rows, rest } = takeProseRows(`${text}\n`, { width: limit });
    const all = rest === '' ? rows : [...rows, rest];
    for (const row of all) out.push(`${pad}  ${paint(row, 'code')}`);
  }

  function emitHeading(out, depth, text) {
    const tone = depth === 1 ? 'h1' : 'bold';
    const limit = Math.max(1, width());
    const { rows, rest } = takeProseRows(`${plainInline(text)}\n`, { width: limit });
    const all = rest === '' ? rows : [...rows, rest];
    for (const row of all) out.push(`${pad}${paint(row, tone)}`);
  }

  function emitQuote(out, line) {
    const depth = Math.min((line.match(/^\s*(?:>\s*)+/) ?? [''])[0].split('>').length - 1, MAX_LIST_DEPTH);
    const text = line.replace(/^\s*(?:>\s*)+/, '');
    const bar = paint('│ '.repeat(Math.max(1, depth)), 'dim');
    const limit = Math.max(1, width() - 2 * Math.max(1, depth));
    const { rows, rest } = takeProseRows(`${text}\n`, { width: limit });
    const all = rest === '' ? rows : [...rows, rest];
    for (const row of all) out.push(`${pad}${bar}${styleInline(row, paint)}`);
  }

  function emitListItem(out, indentText, marker, content) {
    const sourceIndent = indentText.replace(/\t/g, '  ');
    const depth = Math.min(Math.floor(sourceIndent.length / 2), MAX_LIST_DEPTH);
    const headPad = `${pad}${'  '.repeat(depth)}`;
    const task = TASK_ITEM.exec(content);
    let glyph = marker;
    let rest = content;
    if (task !== null) {
      const checked = task[1].toLowerCase() === 'x';
      glyph = checked ? '☑ ' : '☐ ';
      rest = task[2];
    } else if (/^\d/.test(marker)) {
      glyph = `${marker} `;
    } else {
      glyph = '- ';
    }
    const markerWidth = displayWidth(glyph);
    const limit = Math.max(1, width() - depth * 2 - markerWidth);
    const { rows, rest: tail } = takeProseRows(`${rest}\n`, { width: limit });
    const all = rows.length === 0 && tail === '' ? [''] : (tail === '' ? rows : [...rows, tail]);
    const checked = task !== null && task[1].toLowerCase() === 'x';
    all.forEach((row, index) => {
      const head = index === 0 ? `${headPad}${checked ? paint(glyph, 'success') : glyph}` : `${headPad}${' '.repeat(markerWidth)}`;
      const body = checked ? paint(plainInline(row), 'done') : styleInline(row, paint);
      out.push(`${head}${body}`);
    });
  }

  function emitTable(out) {
    const rows = tableRows;
    tableRows = [];
    mode = 'idle';
    const header = splitRow(rows[0] ?? '');
    const aligns = alignmentsOf(splitRow(rows[1] ?? ''));
    while (aligns.length < header.length) aligns.push('left');
    const body = rows.slice(2).map(splitRow);
    for (const line of renderTable({ header, aligns, rows: body }, { width: width(), paint })) {
      out.push(`${pad}${line}`);
    }
  }

  function handleTableCandidate(out, line) {
    if (TABLE_SEPARATOR.test(line) && /[|｜]/.test(line)) {
      tableRows = [candidate, line];
      candidate = null;
      mode = 'table';
      return true;
    }
    const held = candidate;
    candidate = null;
    mode = 'idle';
    if (held !== null) emitParagraph(out, held, { complete: true });
    handleLine(out, line);
    return true;
  }

  function handleLine(out, line) {
    for (;;) {
      if (mode === 'code') {
        if (FENCE.test(line)) {
          mode = 'idle';
        } else {
          emitCode(out, line);
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
        mode = 'code';
        return;
      }
      if (blank(line)) {
        closeParagraph();
        out.push('');
        return;
      }
      if (HR.test(line)) {
        closeParagraph();
        out.push(`${pad}${paint('─'.repeat(Math.max(1, width())), 'rule')}`);
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
      paraTail = paraTail + buffer;
      buffer = '';
    }
    return out;
  }

  function flush() {
    const out = [];
    let tail = paraTail + buffer;
    paraTail = '';
    buffer = '';
    // 收尾时把「差一个换行」的表格行也认下来：未终结的分隔行让候选行成表，
    // 未终结的数据行并进已确认的表——绝不把表格结构当正文吐出去。
    if (tail !== '' && mode === 'table-candidate' && TABLE_SEPARATOR.test(tail) && /[|｜]/.test(tail)) {
      tableRows = [candidate, tail];
      candidate = null;
      tail = '';
      mode = 'table';
    } else if (tail !== '' && mode === 'table' && TABLE_ROW_START.test(tail)) {
      tableRows.push(tail);
      tail = '';
    }
    if (tail !== '') {
      if (mode === 'code') emitCode(out, tail);
      else emitParagraph(out, tail, { complete: true });
    }
    if (mode === 'table') emitTable(out);
    else if (mode === 'table-candidate') {
      const held = candidate;
      candidate = null;
      mode = 'idle';
      if (held !== null) emitParagraph(out, held, { complete: true });
    }
    // flush 的使用场景就是「马上要写别的东西」：段落到此为止，下一片正文是新的一段
    // （旧渲染器靠 write() 清 proseOpen 达到同一效果——工具行之后模型再开口要重新带标记）。
    closeParagraph();
    return out;
  }

  return {
    push(text = '') {
      buffer += String(text).replace(/\r\n?/g, '\n');
      return drain();
    },
    flush,
  };
}
