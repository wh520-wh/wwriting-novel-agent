import test from 'node:test';
import assert from 'node:assert/strict';
import { FAILURE_COMMANDS, validateFailureCommand } from '../src/shared/failure-commands.mjs';

test('FAILURE_COMMANDS 包含所有 13 个命令', () => {
  const expected = [
    'retry-segment', 'retry-with-prompt', 'pause-here',
    'accept-current-words', 'skip-segment', 'fill-words',
    'raise-budget', 'raise-cost-budget', 'raise-token-budget',
    'switch-model', 'apply-review-suggestions',
    'accept-review-current', 'manual-review-handoff'
  ].sort();
  assert.deepEqual(Object.keys(FAILURE_COMMANDS).sort(), expected);
});

test('validateFailureCommand 拒绝未知命令', () => {
  const res = validateFailureCommand('unknown-cmd', {});
  assert.equal(res.ok, false);
  assert.match(res.error, /未知命令/);
});

test('validateFailureCommand 拒绝缺失必填参数', () => {
  const res = validateFailureCommand('fill-words', {});
  assert.equal(res.ok, false);
  assert.match(res.error, /targetWords/);
});

test('validateFailureCommand 校验数值上界', () => {
  const res = validateFailureCommand('fill-words', { targetWords: 999999 });
  assert.equal(res.ok, false);
  assert.match(res.error, /50000/);
});

test('validateFailureCommand 通过合法调用', () => {
  const res = validateFailureCommand('fill-words', { targetWords: 500 });
  assert.equal(res.ok, true);
});

test('validateFailureCommand 拒绝过长 prompt', () => {
  const res = validateFailureCommand('retry-with-prompt', { prompt: 'x'.repeat(2001) });
  assert.equal(res.ok, false);
  assert.match(res.error, /2000/);
});
