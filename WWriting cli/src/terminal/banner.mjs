// 启动头部的大字标识（wordmark）。
//
// 字形照着上游桌面版头部截图反推：**5 行高的方块字，一格一个字符**，字与字之间留一列空隙。
// 没有引第三方 figlet 字体，也没有把字体文件塞进来——这里只需要 8 个字形（WWriting），
// 写死最小、最好审，也最容易按参考图调整。
//
// 参考图里的字是位图/CSS 画的（方块之间有圆角描边做立体感）。终端里一格就是一个字符，
// 那种描边没法表达，所以这里保留「方块拼字」的骨架，放弃描边——字形与参考图一致，
// 质感由颜色承担。
//
// 只导出纯函数：字形与排版都能直接断言，不需要终端。

// 每格一个字符：实心是 '█'，空是空格（一定是空格，不能拿 `.` 之类的占位符——那是真字符，
// 屏幕上会显示成一串点）。
const FILL = '█';
const BLANK = ' ';

// 字形表。行数固定 5 行；宽度各不相同（i 最窄），对齐交给它自己的形状。
const GLYPHS = Object.freeze({
  W: Object.freeze([
    '█     █',
    '█     █',
    '█  █  █',
    '█ █ █ █',
    '██   ██',
  ]),
  r: Object.freeze([
    '     ',
    ' ███ ',
    '██   ',
    '█    ',
    '█    ',
  ]),
  i: Object.freeze([
    '█',
    ' ',
    '█',
    '█',
    '█',
  ]),
  t: Object.freeze([
    ' █   ',
    '███  ',
    ' █   ',
    ' █   ',
    ' ██  ',
  ]),
  n: Object.freeze([
    '     ',
    '████ ',
    '█   █',
    '█   █',
    '█   █',
  ]),
  g: Object.freeze([
    '     ',
    ' ████',
    '█   █',
    ' ████',
    '    █',
  ]),
});

export const BANNER_TEXT = 'WWriting';
export const BANNER_ROWS = 5;
// 每格放大的档位：1 格 1 字符（43 列）或 1 格 2 字符（86 列）。
// 终端格子高宽比约 1:2，所以放大时**横竖要一起放大**：只把实心块写两遍、空格仍占 1 列的话，
// 空隙会比笔画窄，字形就歪了。
export const BANNER_SCALES = Object.freeze([1, 2]);
const GAP = BLANK;

// 大字：文本 → 若干行字符串（scale=2 时每格两字符，字形比例不变）。
// 未知字符按一格空白处理（不抛错：一块横幅不该把启动搞失败）。
export function bannerLines(text = BANNER_TEXT, { scale = 1 } = {}) {
  const factor = BANNER_SCALES.includes(scale) ? scale : 1;
  const glyphs = [...String(text)].map((char) => GLYPHS[char] ?? null);
  const rows = [];
  for (let row = 0; row < BANNER_ROWS; row += 1) {
    const cells = glyphs.map((glyph) => (glyph === null ? '' : glyph[row])).join(GAP);
    rows.push(factor === 1
      ? cells
      : [...cells].map((cell) => (cell === FILL ? FILL.repeat(factor) : BLANK.repeat(factor))).join(''));
  }
  return rows;
}

// 大字的显示宽度（每格占 scale 列；取最长行即可）。
export function bannerWidth(text = BANNER_TEXT, { scale = 1 } = {}) {
  const rows = bannerLines(text, { scale });
  return rows.reduce((max, row) => Math.max(max, row.length), 0);
}

// 放得下这几档里的哪一档：优先大的；一个都放不下就返回 0（调用方据此不给大字）。
export function pickBannerScale(columns, text = BANNER_TEXT) {
  const fits = (value) => columns >= bannerWidth(text, { scale: value }) + 4;
  return [...BANNER_SCALES].reverse().find(fits) ?? 0;
}

// 内容列宽（横线的长度，不含缩进）。
// 宽终端会放大字，横线就得跟着放宽——否则大字从线上探出去，看着像没对齐；
// 窄终端仍是默认宽度。上限永远是终端宽度减缩进与右边距。
export function contentWidth(columns, { indent = 2, fallback = 78 } = {}) {
  const cols = typeof columns === 'number' && columns > 0 ? columns : 80;
  const scale = pickBannerScale(cols);
  const bannerCols = scale === 0 ? 0 : bannerWidth(BANNER_TEXT, { scale });
  const room = cols - indent - 2;
  return Math.max(1, Math.min(room, Math.max(fallback, bannerCols)));
}

export const BANNER_FILL = FILL;
export const BANNER_BLANK = BLANK;
