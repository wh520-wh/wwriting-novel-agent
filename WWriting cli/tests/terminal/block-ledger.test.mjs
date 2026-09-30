// 屏幕块记账（block-ledger）的测试。
//
// 「擦除要上移几格」由**屏幕上已有的块**决定，不是新块——这条规律（缺陷猎捕报告 10）
// 曾只活在 select.mjs 的一个 let 变量里，现在收进 block-ledger.mjs，这里把它的
// 字节契约直接钉死：上移量、逐行先抹再写、变矮补 ERASE_BELOW、收尾归零。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createBlockLedger } from '../../src/terminal/block-ledger.mjs';

function makeSink() {
  const chunks = [];
  return {
    chunks,
    write: (text) => chunks.push(String(text)),
    text: () => chunks.join(''),
  };
}

test('首写：整块按行写出，高度记账生效', () => {
  const sink = makeSink();
  const ledger = createBlockLedger({ write: sink.write });

  ledger.writeBlock(['一', '二', '三']);
  assert.equal(sink.text(), '一\n二\n三\n');
  assert.equal(ledger.height(), 3);
});

test('重绘：上移量是上一块的高度，不是新块的高度', () => {
  const sink = makeSink();
  const ledger = createBlockLedger({ write: sink.write });
  ledger.writeBlock(['1', '2', '3', '4', '5', '6']);

  sink.chunks.length = 0;
  ledger.redraw(['a', 'b', 'c', 'd']); // 6 → 4，变矮
  assert.match(sink.text(), /^\x1b\[6A/, '上移 = 上一块高度 6');
  assert.match(sink.text(), /\x1b\[J$/, '块变矮：块尾下方不再有旧块');
  assert.equal(ledger.height(), 4);

  sink.chunks.length = 0;
  ledger.redraw(['x', 'y', 'z', 'w', 'v', 'u']); // 4 → 6，变高
  assert.match(sink.text(), /^\x1b\[4A/, '上移 = 上一块高度 4，多吃一行就会顶掉上方内容');
  assert.ok(!sink.text().includes('\x1b[J'), '块变高时不该有 ERASE_BELOW');
  assert.equal(ledger.height(), 6);
});

test('重绘：逐行先抹再写，行尾残留被清掉', () => {
  const sink = makeSink();
  const ledger = createBlockLedger({ write: sink.write });
  ledger.writeBlock(['很长很长的一行', '第二行']);

  sink.chunks.length = 0;
  ledger.redraw(['短', '行']);
  assert.match(sink.text(), /\r\x1b\[K短\n\r\x1b\[K行\n/, '每行都先 ERASE_LINE 再写');
});

test('收尾：整块换成一行（或抹掉），高度归零；归零后再重绘不上移', () => {
  const sink = makeSink();
  const ledger = createBlockLedger({ write: sink.write });
  ledger.writeBlock(['一', '二']);
  sink.chunks.length = 0;

  ledger.collapse('❯ 选中的那一行');
  assert.equal(sink.text(), '\x1b[2A\r\x1b[K❯ 选中的那一行\n\x1b[J');
  assert.equal(ledger.height(), 0);

  sink.chunks.length = 0;
  ledger.redraw(['新块']);
  assert.ok(!sink.text().startsWith('\x1b[0A'), '块已不在屏上，重绘不该上移 0 格');
  assert.match(sink.text(), /^\r\x1b\[K新块\n/);
  assert.equal(ledger.height(), 1);

  const sink2 = makeSink();
  const ledger2 = createBlockLedger({ write: sink2.write });
  ledger2.writeBlock(['一']);
  sink2.chunks.length = 0;
  ledger2.collapse(null);
  assert.equal(sink2.text(), '\x1b[1A\r\x1b[K\x1b[J', '没有收尾行时整块抹掉');
});
