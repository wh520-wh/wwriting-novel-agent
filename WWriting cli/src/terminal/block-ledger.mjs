// 屏幕块记账：「整块重绘」的东西（选择器菜单）画在屏幕上时占了几行、擦除要上移几格。
//
// 这条规律的口径是唯一的：**上移量由屏幕上已有的块决定，不是新块**——块高在两次重绘之间
// 变大时用新块高度上移会多吃上方一行，变矮就会残留块顶（缺陷猎捕报告 10）。
// 它原先只活在 select.mjs 的一个 let 变量与三个手写函数里；现在有了独立的、可单测的住址，
// 下一个「整块重绘」的交互直接来这里取，不必再手写一遍同一套上移/先抹再写/变矮补擦。
//
// 只服务「块尾锚在光标处、动的是顶边」的整块重绘；输入区的框线归输入层所有（ADR-0003），
// 那块的几何随 readline 光标浮动，不在这条模型里。

const ERASE_LINE = '\r\x1b[K';
const ERASE_BELOW = '\x1b[J';
const cursorUp = (lines) => `\x1b[${lines}A`;

// createBlockLedger({ write }) → { writeBlock, redraw, collapse, height }
//   write 是唯一的出口（测试注入收集器）；块「此刻在屏上的高度」是这个模块唯一的内部状态。
export function createBlockLedger({ write } = {}) {
  if (typeof write !== 'function') {
    throw new Error('块记账需要一个 write 出口。');
  }
  let onScreenHeight = 0; // 0 = 块不在屏幕上

  // 首写：整块按行写出（调用方保证光标已在块的起始行）。
  function writeBlock(lines) {
    for (const line of lines) write(`${line}\n`);
    onScreenHeight = lines.length;
  }

  // 重绘：先按**上一块**高度上移到块顶，逐行先抹再写；新块变矮时块尾下方不再有旧块，补 ERASE_BELOW。
  function redraw(lines) {
    if (onScreenHeight > 0) write(cursorUp(onScreenHeight));
    for (const line of lines) write(`${ERASE_LINE}${line}\n`);
    if (lines.length < onScreenHeight) write(ERASE_BELOW);
    onScreenHeight = lines.length;
  }

  // 收尾：整块换成一行（summaryLine 为 null 时整块抹掉），块尾留在新行行首，高度归零。
  function collapse(summaryLine = null) {
    write(cursorUp(onScreenHeight));
    write(ERASE_LINE);
    if (summaryLine !== null && summaryLine !== undefined) write(`${summaryLine}\n`);
    write(ERASE_BELOW);
    onScreenHeight = 0;
  }

  return { writeBlock, redraw, collapse, height: () => onScreenHeight };
}
