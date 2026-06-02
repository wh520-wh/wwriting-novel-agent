import fs from 'node:fs';
import path from 'node:path';
import { on, CORE_EVENTS } from './event-bus.mjs';

const FILE = 'failures.jsonl';

// 原子追加：read → push → write tmp → rename（Windows 上 appendFileSync 在并发下会撕字节）
export function appendFailure(projectRoot, card) {
  const p = path.join(projectRoot, FILE);
  const all = readFailures(projectRoot);
  all.push(card);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, all.map(c => JSON.stringify(c)).join('\n') + '\n');
  fs.renameSync(tmp, p);
}

export function readFailures(projectRoot) {
  const p = path.join(projectRoot, FILE);
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf8');
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* 跳过损坏行 */ }
  }
  return out;
}

export function markResolved(projectRoot, id, resolution) {
  const p = path.join(projectRoot, FILE);
  const all = readFailures(projectRoot);
  for (const card of all) {
    if (card.id === id) card.resolution = resolution;
  }
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, all.map(c => JSON.stringify(c)).join('\n') + (all.length ? '\n' : ''));
  fs.renameSync(tmp, p);
}

export const FAILURES_FILE = FILE;

on(CORE_EVENTS.TaskFailed, (payload) => {
  try {
    if (!payload || !payload.projectRoot || !payload.card) return;
    appendFailure(payload.projectRoot, payload.card);
  } catch (e) {
    console.error("failures-store: failed to record task:failed:", e);
  }
});
