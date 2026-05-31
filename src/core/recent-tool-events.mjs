import fs from 'node:fs';
import path from 'node:path';

const KEEP = 20;
const TOOL_TYPES = new Set(['tool_call', 'tool_call_requested', 'tool_call_rejected']);

export function makeToolEventsCache() {
  return new Map();
}

export function readRecentToolEvents(projectRoot, { cache } = {}) {
  const p = path.join(projectRoot, 'run_log.jsonl');
  if (!fs.existsSync(p)) return [];
  const stat = fs.statSync(p);
  if (cache) {
    const hit = cache.get(projectRoot);
    if (hit && hit.mtimeMs === stat.mtimeMs) return hit.data;
  }
  const raw = fs.readFileSync(p, 'utf8');
  const out = [];
  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0 && out.length < KEEP; i--) {
    const s = lines[i].trim();
    if (!s) continue;
    try {
      const ev = JSON.parse(s);
      if (TOOL_TYPES.has(ev.type)) out.push(ev);
    } catch { /* skip */ }
  }
  if (cache) cache.set(projectRoot, { mtimeMs: stat.mtimeMs, data: out });
  return out;
}
