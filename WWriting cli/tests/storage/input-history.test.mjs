// 输入历史持久化（规格 2026-10-07 T4/D11）：JSONL 记录、相邻去重、坏行跳过、
// 上限截尾与压缩、写失败静默。真实临时目录，零 mock（写失败用注入的 fs 替身）。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { INPUT_HISTORY_CAP, loadInputHistory, recordInput } from '../../src/storage/input-history.mjs';

const tempRoots = [];
after(async () => {
  await Promise.all(tempRoots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempRoot(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

test('load：缺失与空文件都是空历史；坏行跳过；顺序 oldest→newest', async () => {
  const root = await makeTempRoot('wwriting-hist-load-');
  assert.deepEqual(await loadInputHistory({ file: path.join(root, '不存在.jsonl') }), []);

  const file = path.join(root, 'history.jsonl');
  await fs.writeFile(file, [
    JSON.stringify({ at: '2026-10-07T01:00:00.000Z', text: '第一条' }),
    '这行是坏的{',
    '',
    JSON.stringify({ at: '2026-10-07T02:00:00.000Z', text: '第二条' }),
  ].join('\n'), 'utf8');
  assert.deepEqual(await loadInputHistory({ file }), ['第一条', '第二条']);
});

test('record：追加一行；与 previous 相同跳过；空文本跳过', async () => {
  const root = await makeTempRoot('wwriting-hist-record-');
  const file = path.join(root, 'nested', 'history.jsonl');

  assert.equal(await recordInput({ file, text: '写第一章', clock: () => 0 }), true);
  assert.equal(await recordInput({ file, text: '写第一章', previous: '写第一章', clock: () => 1 }), false, '相邻去重');
  assert.equal(await recordInput({ file, text: '   ', clock: () => 2 }), false, '空文本不记');
  assert.equal(await recordInput({ file, text: '写第二章', clock: () => 3000 }), true);

  const raw = await fs.readFile(file, 'utf8');
  const lines = raw.trim().split('\n');
  assert.equal(lines.length, 2, '去重与空文本都不产生行');
  assert.deepEqual(JSON.parse(lines[0]), { at: '1970-01-01T00:00:00.000Z', text: '写第一章' });
  assert.deepEqual(JSON.parse(lines[1]), { at: '1970-01-01T00:00:03.000Z', text: '写第二章' });
});

test('record：超上限后加载只留尾部，文件被压缩重写', async () => {
  const root = await makeTempRoot('wwriting-hist-cap-');
  const file = path.join(root, 'history.jsonl');
  const cap = 5;
  for (let i = 1; i <= cap + 2; i += 1) {
    await recordInput({ file, text: `输入-${i}`, clock: () => i * 1000, cap });
  }
  const loaded = await loadInputHistory({ file, cap });
  assert.equal(loaded.length, cap);
  assert.deepEqual(loaded, Array.from({ length: cap }, (_, i) => `输入-${i + 3}`), '留的是最新 5 条');
  // 压缩后文件里不再有多余的行（重写而不是只截视图）。
  const raw = await fs.readFile(file, 'utf8');
  assert.equal(raw.trim().split('\n').length, cap);
  assert.equal(INPUT_HISTORY_CAP, 500, '默认上限是 500（契约钉住）');
});

test('record：写失败静默返回 false，绝不抛到对话面', async () => {
  const root = await makeTempRoot('wwriting-hist-fail-');
  const failing = {
    mkdir: async () => {},
    writeFile: async () => {
      throw new Error('EPERM');
    },
  };
  const result = await recordInput({ file: path.join(root, 'history.jsonl'), text: '写第一章', fsImpl: failing });
  assert.equal(result, false, '写失败不抛，只如实返回没记上');
});
