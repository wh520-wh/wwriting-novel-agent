import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readRecentToolEvents, makeToolEventsCache } from '../src/core/recent-tool-events.mjs';

function makeProjectWithLog(events) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwriting-rte-'));
  const p = path.join(dir, 'run_log.jsonl');
  fs.writeFileSync(p, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  return dir;
}

test('只返回 tool_call* 类型，倒序，最多 20 条', () => {
  const events = [];
  for (let i = 0; i < 30; i++) {
    events.push({ id: `t${i}`, type: 'tool_call', tool: 'w', ts: `2026-05-31T00:00:${String(i).padStart(2,'0')}Z` });
    events.push({ id: `o${i}`, type: 'other', ts: '2026-05-31T00:00:00Z' });
  }
  const dir = makeProjectWithLog(events);
  const out = readRecentToolEvents(dir);
  assert.equal(out.length, 20);
  assert.equal(out[0].id, 't29');
  assert.equal(out[19].id, 't10');
});

test('mtime 短路: 文件未变化返回缓存', () => {
  const dir = makeProjectWithLog([
    { id: 'a', type: 'tool_call', tool: 'w', ts: '2026-05-31T00:00:00Z' }
  ]);
  const cache = makeToolEventsCache();
  const a = readRecentToolEvents(dir, { cache });
  const b = readRecentToolEvents(dir, { cache });
  assert.equal(a, b);
});

test('mtime 变化时返回新数据', async () => {
  const dir = makeProjectWithLog([{ id: 'a', type: 'tool_call', tool: 'w', ts: '...' }]);
  const cache = makeToolEventsCache();
  readRecentToolEvents(dir, { cache });
  await new Promise(r => setTimeout(r, 20));
  fs.appendFileSync(path.join(dir, 'run_log.jsonl'), JSON.stringify({ id: 'b', type: 'tool_call', tool: 'w', ts: '...' }) + '\n');
  const out = readRecentToolEvents(dir, { cache });
  assert.equal(out.length, 2);
});

test('文件不存在返回空数组', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwriting-rte-empty-'));
  assert.deepEqual(readRecentToolEvents(dir), []);
});
