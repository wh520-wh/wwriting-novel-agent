// 对话 agent 的输出解析与系统提示构建：容忍 ```json 围栏 / 裸 JSON / 纯文本；
// 一次只取第一个 tool call；系统提示把工具文档、调用协议与项目快照拼在一起。
import { renderToolDocs } from "./tool-registry.mjs";

export function parseAgentReply(rawText) {
  const text = String(rawText ?? "").trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(text);
  const candidate = fenced ? fenced[1].trim() : (text.startsWith("{") ? text : null);
  if (candidate) {
    try {
      const data = JSON.parse(candidate);
      if (Array.isArray(data?.tool_calls) && data.tool_calls.length > 0) {
        const [first, ...rest] = data.tool_calls;
        if (first?.tool) {
          return {
            type: "tool_call",
            call: { tool: String(first.tool), args: first.args ?? {} },
            dropped: rest.length,
            leadText: fenced ? text.slice(0, fenced.index).trim() : ""
          };
        }
      }
    } catch { /* fallthrough to text */ }
  }
  return { type: "text", text };
}

export function buildSystemPrompt(registry, snapshot = {}) {
  return [
    "你是 WWriting 的小说项目协作智能体。你和用户共同运营一个长篇写作项目。",
    "你可以直接回答，也可以调用工具查询或操作项目。",
    "",
    "## 调用工具的方式",
    "当需要工具时，输出一个 JSON 围栏块（一次只调用一个工具），格式：",
    '```json',
    '{"tool_calls":[{"tool":"工具名","args":{}}]}',
    '```',
    "工具结果会回给你，然后你继续决定下一步（再调工具或给出最终回答）。",
    "下方快照与记忆里已有的信息可以直接引用；它们没有覆盖的细节（如正文原文、具体段落内容），必须先调用读工具查证再回答，不要凭印象编造。",
    "用户要求修改正文、设定或项目时，调用对应的写工具发起操作，不要只口头答应。",
    "写类与控制类工具会先征求用户确认，被拒绝时请尊重用户决定。",
    "最终回答用中文，简洁、具体、基于工具返回的事实，不要编造。",
    "",
    "## 可用工具",
    renderToolDocs(registry),
    "",
    "## 当前项目快照",
    `书名：${snapshot.title ?? "未命名"}；状态：${snapshot.projectStatus ?? "unknown"}；` +
      `进度：${snapshot.completedChapters ?? "?"}/${snapshot.targetChapters ?? "?"} 章；当前第 ${snapshot.currentChapter ?? "?"} 章（${snapshot.currentStage ?? "?"}）。`
  ].join("\n");
}
