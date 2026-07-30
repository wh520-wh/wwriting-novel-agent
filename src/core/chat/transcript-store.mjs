// §5.1: Transcript store — 每轮对话模型 I/O 的完整落盘记录，供排查。
// 写入失败只 warn 不阻断主流程。
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { safeJoin } from "../fs-utils.mjs";

const TRANSCRIPT_FILE = "chat_transcript.jsonl";

export async function appendTranscript(projectRoot, entry) {
  const record = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    ...entry
  };
  try {
    await fs.appendFile(safeJoin(projectRoot, TRANSCRIPT_FILE), `${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    console.warn("[transcript] 写入失败:", error.message);
  }
  return record;
}
