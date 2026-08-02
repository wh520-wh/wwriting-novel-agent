// 模型输出解析工具集：从 agent-engine.mjs 提取的纯函数，负责把模型网关返回值
// （OpenAI-compatible 格式）拆成 tool_call / assistant 消息 / usage 估算等结构。
// 全部为无状态纯函数，不依赖项目状态、文件 I/O 或 agent-engine 内部上下文，
// 可独立单测。
//
// 注意：chat/agent-protocol.mjs 有同名 parseToolCallArguments 但兜底语义不同
// （那边解析失败返回 {} 供对话 agent 链路使用，这里返回 null 表示"无有效参数"），
// 两者不可直接合并。

// 原生 tool_calls 的 arguments 可能已是对象（部分代理返回）或 JSON 字符串；解析失败给 null。
export function parseToolCallArguments(argumentsValue) {
  if (argumentsValue && typeof argumentsValue === "object") {
    return argumentsValue;
  }
  if (typeof argumentsValue !== "string") {
    return null;
  }
  try {
    return JSON.parse(argumentsValue);
  } catch {
    return null;
  }
}

export function parseJsonOutputText(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    return null;
  }
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/u);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

// 解析模型一轮返回的全部 tool_calls(并行 function calling)。
// 写作 agent 循环需要全部执行并回填,保证 transcript 里每个 tool_call 都有对应 role=tool 结果
// (OpenAI/DeepSeek 硬性契约:tool_calls 与 tool 结果必须 1:1,否则下一轮 400)。
export function parseOpenAIToolCalls(raw) {
  const message = raw?.choices?.[0]?.message;
  if (!Array.isArray(message?.tool_calls) || message.tool_calls.length === 0) {
    return [];
  }
  return message.tool_calls.map((tc) => {
    if (!tc) return null;
    return {
      type: "tool_call",
      id: tc.id ?? null,
      tool: tc.function?.name ?? tc.name ?? null,
      input: parseToolCallArguments(tc.function?.arguments ?? tc.arguments)
    };
  }).filter(Boolean);
}

// 写作 agent 循环(runWritingAgentLoop)每轮的主 output 取首个 tool_call(向后兼容)。
// 其余 tool_call 由 runWritingAgentLoop 的 executeTool 回调在本轮内顺序执行+回填(Task 2)。
export function parseOpenAIToolCall(raw) {
  const calls = parseOpenAIToolCalls(raw);
  if (calls.length > 0) {
    return calls[0];
  }
  const message = raw?.choices?.[0]?.message;
  if (message?.function_call) {
    return {
      type: "tool_call",
      id: null,
      tool: message.function_call.name ?? null,
      input: parseToolCallArguments(message.function_call.arguments)
    };
  }
  return null;
}

export function parseGatewayToolOutput(gatewayResult) {
  const openAIToolCall = parseOpenAIToolCall(gatewayResult.raw);
  if (openAIToolCall) {
    return openAIToolCall;
  }
  if (gatewayResult.raw?.output) {
    return gatewayResult.raw.output;
  }
  const parsedText = parseJsonOutputText(gatewayResult.text);
  if (parsedText) {
    return parsedText;
  }
  return {
    type: "status_message",
    message: gatewayResult.text
  };
}

// 从模型网关返回结果中提取 assistant 消息（OpenAI-compatible 格式），
// 用于装入 ToolTranscript 供下一轮回放。content 为空串时归一为 null，
// 保证 appendAssistant 不会写入空 content 字段。
export function extractAssistantMessage(modelCall) {
  const message = modelCall?.raw?.choices?.[0]?.message ?? {};
  return {
    content: typeof message.content === "string" && message.content ? message.content : null,
    tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : null,
    reasoning_content: typeof message.reasoning_content === "string" ? message.reasoning_content : null
  };
}

// 恢复裁剪：pending 文件可能落在「模型已决策、工具未执行」的崩溃窗口；检查所有 assistant
// 轮次的 tool_calls 是否全部有对应 role=tool 结果，从首个不完整轮次(含 side 部分回填的
// 崩溃窗口:主+side1 已回填、side2 未回填)起裁剪，让模型从最后一个完整轮次重新决策，
// 避免 tool_calls 无结果的非法消息形状（真实 API 会 400）。原版只看尾部连续 assistant,
// 会漏判"尾部是 tool 但前面 assistant 有悬空"。
export function trimUnresolvedAssistantTurns(transcript) {
  const messages = transcript.messages;
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg?.role !== "assistant" || !Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) {
      continue;
    }
    const allResolved = msg.tool_calls.every((tc) => {
      if (!tc.id) return true; // null id 不算悬空(与 pendingToolCalls 一致)
      return messages.slice(i + 1).some((m) => m.role === "tool" && m.tool_call_id === tc.id);
    });
    if (!allResolved) {
      messages.length = i; // 裁剪此 assistant 及之后所有消息
      return;
    }
  }
}

export function estimateMockUsage(prompt, output) {
  const inputTokens = Math.max(1, Math.ceil(String(prompt ?? "").length / 4));
  const outputText = JSON.stringify(output ?? "");
  const outputTokens = Math.max(1, Math.ceil(outputText.length / 4));
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens
  };
}

export function checkpointModelExtras(modelCall) {
  if (!modelCall) {
    return {};
  }
  return {
    context_package_hash: modelCall.context_package_hash,
    prompt_block_hashes: modelCall.prompt_block_hashes,
    model_calls: [modelCall],
    usage_reports: [modelCall.usage_report],
    cost_summary: modelCall.cost_summary,
    cache_report: modelCall.cache_report,
    cache_key: modelCall.cache_key,
    skill_hooks: modelCall.skill_hooks ?? []
  };
}
