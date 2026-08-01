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

test('deriveFailures 为缺失 actions 的遗留卡片补空数组', () => {
  const [card] = deriveFailures({
    failures: [{ id: 'legacy', chapterNo: 2, kind: 'provider-error' }]
  });
  assert.deepEqual(card.actions, []);
});

test('interrupted drafting is terminal in the top status badge', async () => {
  const { computeAgentTruth } = await import('../../src/app-shell/agent-truth.mjs');
  const truth = computeAgentTruth({
    hasProject: true,
    agent_alive: false,
    retry_available: true,
    summary: { projectStatus: 'interrupted', currentStage: 'drafting', currentChapterNo: 2 },
    state: { interrupted_reason: 'HTTP 400' }
  });
  assert.equal(truth.display, '已中断');
  assert.equal(truth.showRetry, false);
  assert.equal(truth.refresh, false);
});
