import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveFailureCard } from '../src/core/derive-failure-card.mjs';

const baseState = { current_chapter_no: 7, current_stage: 'reviewing' };

test('words-short kind 由 word-count gate failed 派生', () => {
  const card = deriveFailureCard({
    id: 'e1', type: 'quality_gate_failed', ts: '2026-05-31T00:00:00Z',
    chapter_no: 7, message: 'word-count gate failed',
    data: { kind: 'word_count', actual_words: 2487, expected_words: 3000 }
  }, baseState);
  assert.equal(card.kind, 'words-short');
  assert.equal(card.chapterNo, 7);
  assert.match(card.title, /字数不足/);
  assert.equal(card.actions.length, 3);
  assert.equal(card.actions[0].command.command, 'fill-words');
  assert.equal(card.actions[0].command.args.targetWords, 513);
});

test('tool-rejected kind 由 tool_call_rejected 派生', () => {
  const card = deriveFailureCard({
    id: 'e2', type: 'tool_call_rejected', ts: '2026-05-31T00:00:01Z',
    chapter_no: 7, message: 'invalid arguments',
    data: { tool: 'write_segment', code: 'invalid_args' }
  }, baseState);
  assert.equal(card.kind, 'tool-rejected');
  assert.equal(card.diagnostics.tool, 'write_segment');
});

test('budget-exhausted kind 由 model_call_budget_exhausted 派生', () => {
  const card = deriveFailureCard({
    id: 'e3', type: 'project_blocked', ts: '2026-05-31T00:00:02Z',
    chapter_no: 7, message: 'model_call_budget_exhausted',
    data: { used: 200, max: 200 }
  }, baseState);
  assert.equal(card.kind, 'budget-exhausted');
  assert.equal(card.actions[0].command.command, 'raise-budget');
});

test('provider-error 兜底 - 没匹配上的 project_blocked', () => {
  const card = deriveFailureCard({
    id: 'e4', type: 'project_blocked', ts: '2026-05-31T00:00:03Z',
    chapter_no: 7, message: 'something_weird', data: {}
  }, baseState);
  assert.equal(card.kind, 'provider-error');
});

test('body 截断到 500 字符', () => {
  const long = 'x'.repeat(2000);
  const card = deriveFailureCard({
    id: 'e5', type: 'project_blocked', ts: '2026-05-31T00:00:04Z',
    chapter_no: 7, message: long, data: {}
  }, baseState);
  assert.ok(card.body.length <= 500);
  assert.ok((card.diagnostics.rawError ?? '').length <= 500);
});

test('控制字符被清洗', () => {
  const card = deriveFailureCard({
    id: 'e6', type: 'project_blocked', ts: '2026-05-31T00:00:05Z',
    chapter_no: 7, message: 'a\x00b\x1fc\x7fd', data: {}
  }, baseState);
  assert.equal(/[\x00-\x1f\x7f]/.test(card.body), false);
});

test('id 与 event.id 一致 - 幂等去重键', () => {
  const card = deriveFailureCard({
    id: 'evt_123', type: 'quality_gate_failed', ts: '2026-05-31T00:00:06Z',
    chapter_no: 7, message: 'word-count gate failed',
    data: { kind: 'word_count', actual_words: 2900, expected_words: 3000 }
  }, baseState);
  assert.equal(card.id, 'evt_123');
});

test('review-failed kind 由 skill quality gate failed 派生', () => {
  const card = deriveFailureCard({
    id: 'e7', type: 'quality_gate_failed', ts: '2026-05-31T00:00:07Z',
    chapter_no: 7, message: 'skill quality gate failed',
    data: { failed_gates: ['coherence'] }
  }, baseState);
  assert.equal(card.kind, 'review-failed');
  assert.equal(card.actions.length, 3);
  assert.equal(card.actions[0].command.command, 'apply-review-suggestions');
});

test('unknown kind - 完全未匹配的事件类型', () => {
  const card = deriveFailureCard({
    id: 'e8', type: 'some_random_type', ts: '2026-05-31T00:00:08Z',
    chapter_no: 7, message: 'weird', data: {}
  }, baseState);
  assert.equal(card.kind, 'unknown');
  assert.equal(card.actions.length, 2);
  assert.match(card.title, /出现异常/);
});

test('tool-rejected kind 由 model_output_invalid 派生', () => {
  const card = deriveFailureCard({
    id: 'e9', type: 'project_blocked', ts: '2026-05-31T00:00:09Z',
    chapter_no: 7, message: 'model_output_invalid', data: {}
  }, baseState);
  assert.equal(card.kind, 'tool-rejected');
});
