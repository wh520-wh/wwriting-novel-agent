import fs from "node:fs/promises";
import { loadChapterIndex, loadState } from "../project-store.mjs";
import { pathExists, safeJoin } from "../fs-utils.mjs";
import { readChatHistory } from "./chat-store.mjs";
import { buildSystemPrompt } from "./agent-protocol.mjs";

const HISTORY_WINDOW = 40;

export async function buildChatContext({ projectRoot, project, registry, userMessage }) {
  const [state, index, bookSummary, continuityMd, historyRaw] = await Promise.all([
    loadState(projectRoot).catch(() => ({})),
    loadChapterIndex(projectRoot).catch(() => ({ chapters: [] })),
    readOptional(safeJoin(projectRoot, "memory", "book_summary.md")),
    readOptional(safeJoin(projectRoot, "memory", "continuity.md")),
    readChatHistory(projectRoot, { limit: 1000 })
  ]);
  // 过滤「generating」占位消息（content 为空，只供前端渲染中断条）：空 assistant 消息进模型上下文
  // 没有信息量，部分兼容端点还会拒绝。与写作循环 appendAssistant 的空 content 归一（agent-engine.mjs）一致。
  const history = historyRaw.filter((m) => !(m.role === "assistant" && !String(m.content ?? "")));
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
    const digest = older.map((m) => `${m.role}: ${String(m.content ?? m.result_summary ?? "").slice(0, 160)}`).join("\n");
    messages.push({ role: "system", content: `## 早前对话提要\n${digest}` });
  }
  // 找到历史中最后一轮连续的 tool 消息（保留全文给多工具场景）
  let lastToolRoundStartIdx = -1;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    if (recent[i].role === "tool") {
      lastToolRoundStartIdx = i;
    } else {
      break;
    }
  }
  for (let i = 0; i < recent.length; i += 1) {
    const m = recent[i];
    if (m.role === "user" || m.role === "assistant") {
      messages.push({ role: m.role, content: String(m.content ?? "") });
    } else if (m.role === "tool") {
      const summary = String(m.result_summary ?? "");
      // 历史 tool 消息 >4000 字压到 1000；最后一轮所有 tool 消息保留全文
      const trimmed = (i >= lastToolRoundStartIdx) ? summary : (summary.length > 4000 ? summary.slice(0, 1000) + "…" : summary);
      messages.push({ role: "user", content: `[工具 ${m.tool} 结果] ${trimmed}` });
    }
  }
  messages.push({ role: "user", content: String(userMessage ?? "") });
  return { messages, snapshot };
}

async function readOptional(filePath) {
  return (await pathExists(filePath)) ? (await fs.readFile(filePath, "utf8")).trim() : "";
}
