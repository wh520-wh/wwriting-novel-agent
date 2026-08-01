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

test('遗留 model-error 卡片读取时规范化并可稳定处理', () => {
  const dir = makeProject();
  appendFailure(dir, {
    type: 'model-error',
    chapter_no: 2,
    message: 'OpenAI-compatible provider returned HTTP 400.',
    ts: '2026-08-01T01:00:00Z',
    data: { reason: 'interrupted' }
  });

  const first = readFailures(dir);
  assert.equal(first.length, 1);
  assert.ok(first[0].id.startsWith('legacy_'));
  assert.equal(first[0].kind, 'provider-error');
  assert.ok(first[0].actions.length > 0);

  markResolved(dir, first[0].id, { action: 'retry-segment', submittedAt: '2026-08-01T01:05:00Z' });
  const second = readFailures(dir);
  assert.equal(second[0].id, first[0].id);
  assert.deepEqual(second[0].resolution, {
    action: 'retry-segment',
    submittedAt: '2026-08-01T01:05:00Z'
  });
});
