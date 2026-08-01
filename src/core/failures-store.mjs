import fs from 'node:fs';
import path from 'node:path';
import { on, CORE_EVENTS } from './event-bus.mjs';
import { normalizeFailureCard } from './derive-failure-card.mjs';

const FILE = 'failures.jsonl';

function failuresPath(projectRoot) {
  return path.join(projectRoot, FILE);
}

function writeFailures(projectRoot, cards) {
  const target = failuresPath(projectRoot);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(
    tmp,
    cards.map((card) => JSON.stringify(card)).join("\n") + (cards.length ? "\n" : "")
  );
  fs.renameSync(tmp, target);
}

// 原子追加：read → normalize → write tmp → rename（Windows 上 appendFileSync 在并发下会撕字节）
export function appendFailure(projectRoot, card) {
  const all = readFailures(projectRoot);
  all.push(normalizeFailureCard(card));
  writeFailures(projectRoot, all);
}

export function readFailures(projectRoot) {
  const target = failuresPath(projectRoot);
  if (!fs.existsSync(target)) return [];
  const cards = [];
  for (const line of fs.readFileSync(target, "utf8").split(/\r?\n/)) {
    const source = line.trim();
    if (!source) continue;
    try {
      cards.push(normalizeFailureCard(JSON.parse(source)));
    } catch {
      // 损坏行不进入 dashboard，也不妨碍后续有效记录。
    }
  }
  return cards;
}

export function markResolved(projectRoot, id, resolution) {
  const all = readFailures(projectRoot);
  for (const card of all) {
    if (card.id === id) card.resolution = resolution;
  }
  writeFailures(projectRoot, all);
}

on(CORE_EVENTS.TaskFailed, (payload) => {
  if (!payload || !payload.projectRoot || !payload.card) return;
  appendFailure(payload.projectRoot, payload.card);
});
