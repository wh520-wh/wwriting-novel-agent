import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveFailures } from '../../src/app-shell/agent-truth.mjs';

test('deriveFailures 返回带 chapter 内序号的卡片列表', () => {
  const dashboard = {
    failures: [
      { id: 'a', chapterNo: 7, kind: 'words-short', ts: '2026-05-31T00:00:00Z' },
      { id: 'b', chapterNo: 7, kind: 'tool-rejected', ts: '2026-05-31T00:00:01Z' },
      { id: 'c', chapterNo: 8, kind: 'words-short', ts: '2026-05-31T00:00:02Z' }
    ]
  };
  const out = deriveFailures(dashboard);
  assert.equal(out.length, 3);
  assert.equal(out[0].seq, 1);
  assert.equal(out[1].seq, 2);
  assert.equal(out[2].seq, 1);  // 新章节重新从 1 开始
});

test('deriveFailures 处理空 / 缺失 failures', () => {
  assert.deepEqual(deriveFailures({}), []);
  assert.deepEqual(deriveFailures({ failures: null }), []);
});
