// src/app-shell/chat-derive.mjs
// 对话派生逻辑（纯函数、无 DOM）：
// - deriveSources: assistant 回答的依据 chips，从"上一条 user 之后的 ok read 工具消息"推导（证据制，不靠模型自述）。
// - deriveSuggestions: 空态建议按项目状态情境化，5 类互斥分支。
import { READ_TOOLS, toolSourceChip } from "./tool-labels.mjs";

export function deriveSources(messages, assistantMessage) {
  const list = Array.isArray(messages) ? messages : [];
  if (!assistantMessage?.id) return [];
  const idx = list.findIndex((m) => m?.id === assistantMessage.id);
  if (idx < 0) return [];
  let start = 0;
  for (let i = idx - 1; i >= 0; i -= 1) {
    if (list[i]?.role === "user") { start = i + 1; break; }
  }
  const chips = [];
  const seen = new Set();
  for (let i = start; i < idx; i += 1) {
    const m = list[i];
    if (m?.role !== "tool" || m.ok === false || !READ_TOOLS.has(m.tool)) continue;
    const chip = toolSourceChip(m.tool, m.args);
    if (!chip || seen.has(chip.label)) continue;
    seen.add(chip.label);
    chips.push({ ...chip, resultSummary: m.result_summary ?? "" });
  }
  return chips;
}

export function deriveSuggestions(data) {
  const project = data?.project ?? {};
  const summary = data?.summary ?? {};
  const chapters = data?.chapters ?? [];
  if (project.archived_at) {
    return [item("导出成书"), item("解除归档")];
  }
  const needsRevision = chapters.find((c) => c?.status === "needs_revision");
  if (needsRevision) {
    return [item(`处理第 ${needsRevision.chapter_no} 章的待修订`), item("这本书的设定是什么？"), item("目前花了多少钱？")];
  }
  const done = Number(summary.completedChapters ?? 0);
  const target = Number(summary.targetChapters ?? 0);
  if (target > 0 && done >= target) {
    return [item("导出成书"), item("把目标章节数提高 10 章再续写")];
  }
  if (done >= 1) {
    return [item(`续写下一章（第 ${done + 1} 章）`), item(`回顾第 ${done} 章的结尾`), item("目前花了多少钱？")];
  }
  // 新项目（尚无章节）：给出项目理解与首章入口。
  return [
    item("检查项目结构", "/init", { kind: "prompt" }),
    item("开始写第一章", "开始写第一章", { kind: "prompt" }),
    item("梳理人物关系", "请检查人物关系和设定冲突", { kind: "prompt" })
  ];
}

function item(label, message = label, extra = {}) {
  return { label, message, ...extra };
}
