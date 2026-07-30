import crypto from "node:crypto";
import fs from "node:fs/promises";
import { pathExists, safeJoin, writeJsonAtomic, readJson } from "../fs-utils.mjs";

const HISTORY_FILE = "chat_history.jsonl";
const PENDING_FILE = "chat_pending_action.json";

export async function appendChatMessage(projectRoot, message) {
  const entry = {
    ...message,
    id: message.id ?? crypto.randomUUID(),
    ts: message.ts ?? new Date().toISOString()
  };
  await fs.appendFile(safeJoin(projectRoot, HISTORY_FILE), `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

export async function readChatHistory(projectRoot, { after = null, limit = 1000 } = {}) {
  const file = safeJoin(projectRoot, HISTORY_FILE);
  if (!(await pathExists(file))) return [];
  const lines = (await fs.readFile(file, "utf8")).split("\n").filter(Boolean);
  const messages = [];
  for (const line of lines) {
    try { messages.push(JSON.parse(line)); } catch { /* skip bad line */ }
  }
  let result = messages;
  if (after) {
    const idx = result.findIndex((m) => m.id === after);
    result = idx >= 0 ? result.slice(idx + 1) : result;
  }
  if (limit > 0 && result.length > limit) result = result.slice(-limit);
  return result;
}

export async function loadPendingAction(projectRoot) {
  const data = await readJson(safeJoin(projectRoot, PENDING_FILE), null);
  // Return any non-cleared pending (pending for fresh, executed for idempotent resume)
  return data && data.status !== "cleared" ? data : null;
}

export async function savePendingAction(projectRoot, action) {
  const entry = {
    id: action.id ?? crypto.randomUUID(),
    idempotency_key: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    status: "pending",
    ...action
  };
  await writeJsonAtomic(safeJoin(projectRoot, PENDING_FILE), entry);
  return entry;
}

export async function clearPendingAction(projectRoot) {
  await writeJsonAtomic(safeJoin(projectRoot, PENDING_FILE), { status: "cleared" });
  return null;
}

// §3.3: Atomically update pending action status (executing / executed)
// Used for idempotency handshake: before executeTool -> "executing", after -> "executed"
export async function updatePendingStatus(projectRoot, idempotencyKey, status, outcome = null) {
  const current = await readJson(safeJoin(projectRoot, PENDING_FILE), {});
  // §3.3 Key-match guard: if pending file has a different idempotency_key, another
  // concurrent operation has taken over — clear the stale pending and abort.
  if (current.idempotency_key && current.idempotency_key !== idempotencyKey) {
    await writeJsonAtomic(safeJoin(projectRoot, PENDING_FILE), { status: "cleared" });
    throw new Error(
      `Idempotency key mismatch: pending has key ${current.idempotency_key}, expected ${idempotencyKey}`
    );
  }
  const updated = {
    ...current,
    idempotency_key: idempotencyKey,
    status,
    updated_at: new Date().toISOString()
  };
  if (outcome != null) {
    updated.cachedOutcome = outcome;
  }
  await writeJsonAtomic(safeJoin(projectRoot, PENDING_FILE), updated);
  return updated;
}
