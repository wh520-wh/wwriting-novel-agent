import fs from "node:fs/promises";
import { loadChapterIndex, loadState } from "../project-store.mjs";
import { pathExists, safeJoin } from "../fs-utils.mjs";
import { readChatHistory } from "./chat-store.mjs";
import { buildSystemPrompt } from "./agent-protocol.mjs";

const HISTORY_WINDOW = 20;

export async function buildChatContext({ projectRoot, project, registry, userMessage }) {
  const [state, index, bookSummary, continuityMd, history] = await Promise.all([
    loadState(projectRoot).catch(() => ({})),
    loadChapterIndex(projectRoot).catch(() => ({ chapters: [] })),
    readOptional(safeJoin(projectRoot, "memory", "book_summary.md")),
    readOptional(safeJoin(projectRoot, "memory", "continuity.md")),
    readChatHistory(projectRoot, { limit: 200 })
  ]);
  const chapters = index.chapters ?? [];
  const snapshot = {
    title: project.title,
    projectStatus: state.project_status ?? "idle",
    completedChapters: chapters.filter((c) => c.status === "completed").length,
    targetChapters: project.target_chapters,
    currentChapter: state.current_chapter_no ?? null,
    currentStage: state.current_stage ?? null
  };
  const memorySection = [
    bookSummary ? `## 全书摘要\n${bookSummary}` : "",
    continuityMd ? `## 设定档案\n${continuityMd}` : ""
  ].filter(Boolean).join("\n\n");
  const systemContent = [buildSystemPrompt(registry, snapshot), memorySection].filter(Boolean).join("\n\n");

  const messages = [{ role: "system", content: systemContent }];
  const recent = history.slice(-HISTORY_WINDOW);
  const older = history.slice(0, Math.max(0, history.length - HISTORY_WINDOW));
  if (older.length > 0) {
    const digest = older.map((m) => `${m.role}: ${String(m.content ?? m.result_summary ?? "").slice(0, 80)}`).join("\n");
    messages.push({ role: "system", content: `## 早前对话提要\n${digest}` });
  }
  for (const m of recent) {
    if (m.role === "user" || m.role === "assistant") {
      messages.push({ role: m.role, content: String(m.content ?? "") });
    } else if (m.role === "tool") {
      messages.push({ role: "user", content: `[工具 ${m.tool} 结果] ${String(m.result_summary ?? "")}` });
    }
  }
  messages.push({ role: "user", content: String(userMessage ?? "") });
  return { messages, snapshot };
}

async function readOptional(filePath) {
  return (await pathExists(filePath)) ? (await fs.readFile(filePath, "utf8")).trim() : "";
}
