// 对话 agent 的输出解析与系统提示构建：容忍 ```json 围栏 / 裸 JSON / 纯文本；
// 一次只取第一个 tool call；系统提示把工具文档、调用协议与项目快照拼在一起。
import { renderToolDocs } from "./tool-registry.mjs";

export function parseAgentReply(rawText) {
  const text = String(rawText ?? "").trim();
  // 扫描全部围栏，取第一个能解析出 tool_calls 的；其余围栏（如 ```稿）留在文本/leadText 里。
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gu;
  let match;
  while ((match = fenceRe.exec(text)) !== null) {
    const parsed = tryParseToolCall(match[1].trim());
    if (parsed) {
      return {
        type: "tool_call",
        call: parsed.call,
        dropped: parsed.dropped,
        leadText: text.slice(0, match.index).trim()
      };
    }
  }
  if (text.startsWith("{")) {
    const parsed = tryParseToolCall(text);
    if (parsed) {
      return { type: "tool_call", call: parsed.call, dropped: parsed.dropped, leadText: "" };
    }
  }
  return { type: "text", text };
}

function tryParseToolCall(candidate) {
  try {
    const data = JSON.parse(candidate);
    if (Array.isArray(data?.tool_calls) && data.tool_calls.length > 0) {
      const [first, ...rest] = data.tool_calls;
      if (first?.tool) {
        return { call: { tool: String(first.tool), args: first.args ?? {} }, dropped: rest.length };
      }
    }
  } catch { /* 不是 tool call，继续扫描 */ }
  return null;
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
    "用户要开始或继续写作（如「开始写」「继续写」「写下一章」）时，调用 start_run 启动；若任务队列为空，先用 queue_chapters 排好任务再 start_run。绝不能只回复「好的，马上开始」却什么工具都不调用——那等于没动手。",
    "写类与控制类工具会先征求用户确认，被拒绝时请尊重用户决定。",
    "输出小说正文、草稿或改写片段时，把正文放进一个 ```稿 围栏块（说明文字放围栏外）；不要把工具调用 JSON 和正文混进同一个围栏。",
    "最终回答用中文，简洁、具体、基于工具返回的事实，不要编造。不要使用 emoji、颜文字或装饰性符号，也不要用项目符号堆砌花哨排版，保持专业、克制的表达。",
    "",
    "## 可用工具",
    renderToolDocs(registry),
    "",
    "## 当前项目快照",
    `书名：${snapshot.title ?? "未命名"}；状态：${snapshot.projectStatus ?? "unknown"}；` +
      `进度：${snapshot.completedChapters ?? "?"}/${snapshot.targetChapters ?? "?"} 章；当前第 ${snapshot.currentChapter ?? "?"} 章（${snapshot.currentStage ?? "?"}）。`
  ].join("\n");
}
