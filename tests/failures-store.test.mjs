import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { appendFailure, readFailures, markResolved } from '../src/core/failures-store.mjs';

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwriting-failures-'));
  return dir;
}

test('appendFailure 追加并 readFailures 读出', () => {
  const dir = makeProject();
  appendFailure(dir, { id: 'e1', kind: 'words-short', title: '字数不足' });
  appendFailure(dir, { id: 'e2', kind: 'tool-rejected', title: '工具被拒' });
  const all = readFailures(dir);
  assert.equal(all.length, 2);
  assert.equal(all[0].id, 'e1');
  assert.equal(all[1].id, 'e2');
});

test('readFailures 跳过损坏行', () => {
  const dir = makeProject();
  appendFailure(dir, { id: 'good1', kind: 'unknown' });
  fs.appendFileSync(path.join(dir, 'failures.jsonl'), '\n{this is not json\n');
  appendFailure(dir, { id: 'good2', kind: 'unknown' });
  const all = readFailures(dir);
  assert.equal(all.length, 2);
  assert.deepEqual(all.map(f => f.id), ['good1', 'good2']);
});

test('readFailures - 文件不存在返回空数组', () => {
  const dir = makeProject();
  assert.deepEqual(readFailures(dir), []);
});

test('markResolved 更新对应条目', () => {
  const dir = makeProject();
  appendFailure(dir, { id: 'e1', kind: 'words-short', resolution: null });
  markResolved(dir, 'e1', { action: 'fill-words', submittedAt: '2026-05-31T00:00:00Z' });
  const all = readFailures(dir);
  assert.equal(all[0].resolution.action, 'fill-words');
});
