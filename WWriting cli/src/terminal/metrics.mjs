// 终端度量与排版：显示宽度、按宽截断与补白、按宽折行、内容列宽。
//
// 这一族全是纯函数，也是全库唯一的宽度口径：CJK / 全角占 2 列的判定（isWideCode）、
// 「末列有毒，留 1 列防终端自动折行」的口径、columns 拿不到时兜底 80——
// 都只有这一份定义。渲染器、输入层、选择器、命令层、测试地基（screen.mjs）都从这里取，
// 谁也不必再各自写一遍「Number.isFinite(columns) && columns > 0 ? ... : 80」。
//
// 出处：度量函数曾寄居在 renderer.mjs（改一条宽度规则要打开 51KB 的渲染器），
// contentWidth 曾长在 banner.mjs（字形美术文件）里，连带「大字放得下就给所有横线加宽」的
// 耦合——大字已在紧凑头部（0.1.0）退场，内容列宽回归设计上限 CONTENT_WIDTH_MAX；
// 若哪天真有需要放宽的横幅，由 printIntro 在自己的宽度上做 max，不再牵动全屏的线。

// columns 的唯一兜底口径：正数向下取整，拿不到（NaN / 0 / 负数 / 未定义）按 fallback 算。
export function resolveColumns(columns, fallback = 80) {
  return Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : fallback;
}

// CJK / 全角字符占两列，供排版与光标定位共用。
export function displayWidth(text) {
  const source = String(text);
  let width = 0;
  // 用下标循环而不是 for...of：字符串迭代器每轮都会分配一个单字符字符串，
  // 而这个函数在流式正文里是「每个字都要调一次」的热路径。
  for (let i = 0; i < source.length; i += 1) {
    const code = source.codePointAt(i);
    if (code > 0xffff) i += 1; // 代理对：高位已经算了宽度，跳过低位
    width += isWideCode(code) ? 2 : 1;
  }
  return width;
}

// 占两列的字符（CJK、全角标点、emoji 之外的 CJK 扩展区）。抽出来给 displayWidth 与 wrapCut 共用。
function isWideCode(code) {
  return (code >= 0x1100 && code <= 0x115f)
    || code === 0x2329 || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x20000 && code <= 0x3fffd);
}

// 按显示宽度补空格（CJK 标签对齐用；宽度不够就原样返回，不加不加截断）。
export function padDisplayEnd(text, width) {
  const text_ = String(text);
  const gap = width - displayWidth(text_);
  return gap > 0 ? `${text_}${' '.repeat(gap)}` : text_;
}

// 实时区不能软折行，否则按行擦除会把旧内容留在 scrollback。
export function clipToWidth(text, width) {
  const limit = Number.isFinite(width) && width > 0 ? Math.floor(width) : 0;
  if (limit < 1) return '';
  let used = 0;
  let at = 0;
  const line = String(text ?? '');
  for (let i = 0; i < line.length; i += 1) {
    const code = line.codePointAt(i);
    if (code > 0xffff) i += 1;
    const cols = isWideCode(code) ? 2 : 1;
    if (used + cols > limit) break;
    used += cols;
    at = i + 1;
  }
  return line.slice(0, at);
}

// 不把 Markdown 标记拆开，也不把中文收尾标点孤立在下一行。
const MARKER_CHARS = new Set(['*', '_', '`']);
const LINE_START_PUNCTUATION = '，。！？、；：）》」』】〕〉”’';
const LINE_END_PUNCTUATION = '（《「『【〔〈“‘';

// 一个能放下的显示宽度内，能切多少字符；放不下一整行时返回 0（继续攒）。
// 导出给 markdown.mjs「先上色后折行」用：折行决策仍走这唯一一份标点/标记避让规则。
export function wrapCut(text, width) {
  let used = 0;
  let at = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.codePointAt(i);
    if (code > 0xffff) i += 1;
    const cols = isWideCode(code) ? 2 : 1;
    if (used + cols > width) break;
    used += cols;
    at = i + 1;
  }
  if (at === 0 || at >= text.length) return 0; // 一行都放不下 / 还没攒满一行
  let cut = at;
  while (cut > 1 && (LINE_START_PUNCTUATION.includes(text[cut]) || LINE_END_PUNCTUATION.includes(text[cut - 1]))) {
    cut -= text.codePointAt(cut - 2) > 0xffff ? 2 : 1;
  }
  while (cut > 0 && MARKER_CHARS.has(text[cut - 1])) cut -= 1;
  return cut > 0 ? cut : 0;
}

// 从待发正文里切出「能落盘的完整行」→ { rows, rest }。
// rows 已经剥掉行尾换行；rest 是还不够一行的尾巴，留给下一片。
export function takeProseRows(text, { width } = {}) {
  // 不为宽度设下限：真实调用点走 proseRowWidth（那里已经兜到 20 列），
  // 这里保持「给多少就是多少」，好让切行规则可以被小宽度直接测出来。
  const limit = Number.isFinite(width) && width > 0 ? Math.floor(width) : 80;
  const rows = [];
  let rest = String(text ?? '');
  for (;;) {
    const newline = rest.indexOf('\n');
    const cut = wrapCut(newline >= 0 ? rest.slice(0, newline) : rest, limit);
    if (cut > 0) {
      rows.push(rest.slice(0, cut));
      rest = rest.slice(cut);
      continue;
    }
    if (newline >= 0) {
      rows.push(rest.slice(0, newline));
      rest = rest.slice(newline + 1);
      continue;
    }
    break;
  }
  return { rows, rest };
}

// 内容列：头部面板、正文阅读列与输入区框线共用同一份缩进与宽度，屏幕上所有横线才会对齐成一列。
export const CONTENT_INDENT = 2;
export const CONTENT_WIDTH_MAX = 78;

// 内容列宽（横线的长度，不含缩进）。上限永远是终端宽度减缩进与右边距，再宽也不铺满整个终端。
export function contentWidth(columns, { indent = CONTENT_INDENT, fallback = CONTENT_WIDTH_MAX } = {}) {
  const cols = resolveColumns(columns);
  const room = cols - indent - 2;
  return Math.max(1, Math.min(room, fallback));
}

// 宽终端仍使用阅读列，不把中文长段落拉满屏幕。
export function proseRowWidth(columns) {
  return contentWidth(columns, { indent: CONTENT_INDENT, fallback: CONTENT_WIDTH_MAX });
}

// 输入区框线的一条（上框线 / 下框线都用它）。缩进 2 格是为了让「线的起点」与
// 「提示符后面正文的起点」对齐——`❯ ` 本身占两列，落在左侧的空白里当标记。
export function ruleLine({ columns, indent = CONTENT_INDENT } = {}) {
  const width = contentWidth(columns, { indent });
  return `${' '.repeat(Math.max(0, indent))}${'─'.repeat(width)}`;
}
