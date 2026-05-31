import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveBadges } from '../../src/app-shell/agent-truth.mjs';

const base = {
  hasProject: true,
  summary: { completedChapters: 3, targetChapters: 100, estimatedCost: 4.0 },
  project: { budget_config: { max_cost: 5.0 } },
  skills: { items: [{ name: 'cliffhanger', enabled_in_project: true }, { name: 'other', enabled_in_project: false }] },
  sources: { count: 5, latest: [{ captured_at: '2026-05-31T00:00:00Z' }] },
  review: { generated_at: '2026-05-31T00:00:00Z' }
};

test('cost level: 80% warning', () => {
  const b = deriveBadges({ ...base, summary: { ...base.summary, estimatedCost: 4.5 } });
  assert.equal(b.cost.level, 'warning');
});

test('cost level: over budget', () => {
  const b = deriveBadges({ ...base, summary: { ...base.summary, estimatedCost: 5.5 } });
  assert.equal(b.cost.level, 'over');
});

test('research newSinceLastVisit 计算', () => {
  const lastSeen = { research: '2026-05-30T00:00:00Z' };
  const b = deriveBadges(base, '/path/A', lastSeen);
  assert.equal(b.research.newSinceLastVisit, true);
  const b2 = deriveBadges(base, '/path/A', { research: '2026-05-31T01:00:00Z' });
  assert.equal(b2.research.newSinceLastVisit, false);
});

test('chapters done/total + skills enabledCount', () => {
  const b = deriveBadges(base);
  assert.equal(b.chapters.done, 3);
  assert.equal(b.chapters.total, 100);
  assert.equal(b.skills.enabledCount, 1);
});
