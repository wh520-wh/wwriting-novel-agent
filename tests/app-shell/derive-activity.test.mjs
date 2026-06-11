import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveActivity } from '../../src/app-shell/agent-truth.mjs';

function dash(overrides = {}) {
  return {
    hasProject: true,
    agent_alive: true,
    summary: {
      projectStatus: 'running', currentStage: 'drafting',
      currentChapterNo: 7, completedChapters: 3, targetChapters: 100,
      estimatedCost: 0.18, costAvailable: true, modelCalls: 12
    },
    state: { current_chapter_no: 7, current_stage: 'drafting', stage_entered_at: '2026-05-31T00:00:00Z' },
    recent_tool_events: [{ id: 'e1', type: 'tool_call', data: { tool: 'write_segment' }, ts: '2026-05-31T00:02:00Z' }],
    chapters: [{ chapter_no: 7, status: 'drafting', actual_words: 1200 }],
    ...overrides
  };
}

test('running: full fields', () => {
  const a = deriveActivity(dash(), new Date('2026-05-31T00:02:14Z').getTime());
  assert.equal(a.mode, 'running');
  assert.equal(a.stage, 'drafting');
  assert.equal(a.chapterNo, 7);
  assert.equal(a.segCurrent, null);
  assert.equal(a.segTotal, null);
  assert.equal(a.lastTool.name, 'write_segment');
  assert.equal(typeof a.elapsedMs, 'number');
  assert.equal(a.spentCost, 0.18);
});

test('blocked mode', () => {
  const a = deriveActivity(dash({
    agent_alive: false,
    summary: { projectStatus: 'blocked', currentStage: 'blocked' }
  }));
  assert.equal(a.mode, 'blocked');
});

test('empty recent_tool_events gives lastTool null', () => {
  const a = deriveActivity(dash({ recent_tool_events: [] }));
  assert.equal(a.lastTool, null);
});

test('empty chapters does not error', () => {
  const a = deriveActivity(dash({ chapters: [] }));
  assert.ok(a);
  assert.equal(a.segCurrent, null);
});

test('idle mode', () => {
  const a = deriveActivity(dash({
    agent_alive: false,
    summary: { projectStatus: 'idle', currentStage: 'queued' }
  }));
  assert.equal(a.mode, 'idle');
});
