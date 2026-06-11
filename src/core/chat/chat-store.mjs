import crypto from "node:crypto";
import fs from "node:fs/promises";
import { pathExists, safeJoin, writeJsonAtomic, readJson } from "../fs-utils.mjs";

const HISTORY_FILE = "chat_history.jsonl";
const PENDING_FILE = "chat_pending_action.json";

export async function appendChatMessage(projectRoot, message) {
  const entry = {
    id: message.id ?? crypto.randomUUID(),
    ts: message.ts ?? new Date().toISOString(),
    ...message
  };
  await fs.appendFile(safeJoin(projectRoot, HISTORY_FILE), `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

export async function readChatHistory(projectRoot, { after = null, limit = 200 } = {}) {
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
  return data && data.status === "pending" ? data : null;
}

export async function savePendingAction(projectRoot, action) {
  const entry = {
    id: action.id ?? crypto.randomUUID(),
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
