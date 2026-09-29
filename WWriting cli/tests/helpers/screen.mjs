// 测试助手：把「写进 stdout 的字节流」还原成终端最终画面。
//
// 为什么需要它：输入框的每一条边线都要在 readline 重绘之后再补一次，所以原始字节里
// 同一个字符串会出现好几次（旧帧 + 新帧），按字节断言只能证明「写过」，
// 证明不了「屏幕上现在长这样」。断在画面上，才是在断用户真正看到的东西。
//
// 只实现用得到的那些控制序列：光标上下左右移、列定位、清行、清屏、SGR（颜色，直接丢弃）。
// 宽度直接用渲染器那一份 displayWidth——它才是「什么算占两列」的唯一口径。
// 自己写一份宽度表的话，很容易把 U+2588 `█`（块元素，终端里是**窄**的）算成宽字符，
// 于是方块字横幅被还原成两倍宽、整幅画面对不上（踩过一次）。
import { displayWidth } from '../../src/terminal/renderer.mjs';

const ESC = '\u001b';

function cellWidth(char) {
  return displayWidth(char) || 1;
}

export function renderScreen(bytes, { cols = 100, rows = 40 } = {}) {
  const grid = Array.from({ length: rows }, () => new Array(cols).fill(' '));
  let row = 0;
  let col = 0;
  // 真实终端写满一行时不会立刻换行，而是先把光标留在最后一列（待换行），
  // 下一个可见字符到达才真正换行。少了这个迟滞，还原出来的画面会多出好几行。
  let pending = false;

  const blank = () => new Array(cols).fill(' ');

  const newRow = () => {
    row += 1;
    if (row > rows - 1) {
      grid.shift();
      grid.push(blank());
      row = rows - 1;
    }
  };

  const clamp = () => {
    if (col < 0) col = 0;
    if (col > cols - 1) col = cols - 1;
    if (row < 0) row = 0;
    if (row > rows - 1) row = rows - 1;
  };

  const put = (char) => {
    const width = cellWidth(char);
    if (pending) {
      col = 0;
      newRow();
      pending = false;
    }
    if (col + width > cols) {
      col = 0;
      newRow();
    }
    grid[row][col] = char;
    if (width === 2 && col + 1 < cols) grid[row][col + 1] = '';
    col += width;
    if (col >= cols) {
      col = cols - 1;
      pending = true;
    }
  };

  const source = String(bytes);
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === ESC) {
      const match = /^\u001b\[([0-9;?]*)([A-Za-z])/.exec(source.slice(i));
      if (match === null) continue;
      const params = match[1];
      const final = match[2];
      const first = Number.parseInt(params.replace('?', '').split(';')[0], 10);
      const n = Number.isFinite(first) && first > 0 ? first : 1;
      if (final === 'A') row -= n;
      else if (final === 'B') row += n;
      else if (final === 'C') col += n;
      else if (final === 'D') col -= n;
      else if (final === 'G') col = n - 1;
      else if (final === 'H' || final === 'f') {
        const [r, c] = params.split(';').map((value) => Number.parseInt(value, 10) || 1);
        row = r - 1;
        col = c - 1;
      } else if (final === 'K') {
        const mode = params.replace('?', '');
        const from = mode === '1' || mode === '2' ? 0 : col;
        const to = mode === '1' ? col + 1 : cols;
        for (let c = from; c < to; c += 1) if (c >= 0 && c < cols) grid[row][c] = ' ';
      } else if (final === 'J') {
        const mode = params.replace('?', '');
        if (mode === '2') {
          for (const line of grid) line.fill(' ');
        } else {
          for (let c = col; c < cols; c += 1) grid[row][c] = ' ';
          for (let r = row + 1; r < rows; r += 1) grid[r].fill(' ');
        }
      }
      pending = false;
      clamp();
      i += match[0].length - 1;
      continue;
    }
    if (char === '\n') {
      // Windows 控制台里 `\n` 就是「回车换行」（\r\n 的 LF 同样如此），所以列要归零。
      // 按 Unix raw 语义只下移不回行首的话，还原出来的画面会一行比一行往右偏。
      newRow();
      col = 0;
      pending = false;
      continue;
    }
    if (char === '\r') {
      col = 0;
      pending = false;
      continue;
    }
    if (char === '\t') {
      col += 8 - (col % 8);
      pending = false;
      clamp();
      continue;
    }
    if (char.charCodeAt(0) < 32) continue;
    put(char);
  }

  return grid.map((line) => line.join('').replace(/\s+$/, ''));
}

// 画面 → 文本（保留行结构，去掉尾部空行）。断言直接对这个字符串做。
export function screenText(bytes, options) {
  const lines = renderScreen(bytes, options);
  let last = lines.length - 1;
  while (last >= 0 && lines[last] === '') last -= 1;
  return lines.slice(0, last + 1).join('\n');
}

// 画面上第几行出现某个字符串（0 基），没有返回 -1。
export function screenLineOf(bytes, needle, options) {
  return renderScreen(bytes, options).findIndex((line) => line.includes(needle));
}
