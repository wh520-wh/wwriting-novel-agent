// 会话压缩执行：把「已往对话」收敛成一份摘要文本（/compact 的模型调用段）。
//
// 为什么是独立一段模型调用而不是一轮普通 Agent：压缩不需要工具、不需要确认、
// 不该在事件流里留下 run_started/run_completed 的痕迹——它不是对话，是维护动作。
// 摘要本身落进 digest_compacted 事件（由 run-controller 负责），本模块只管「要一段文字」。
//
// 纯函数 + 一次 streamChat：不给 tools（DeepSeek 客户端对空 tools 不下发字段）、
// 不给 signal（/compact 只在空闲时可触发，压缩中途没有可取消的轮）。

// 摘要的系统提示：说清「这段文字将替代这些轮次」，让模型保留决策与状态而不是复述。
export const COMPACTION_SYSTEM_PROMPT = [
  '你是 WWriting 的写作 Agent。下面的对话将被收敛：你写一份给「未来的你」看的工作摘要，',
  '它以 [会话摘要] 的名义替代这些轮次进入后续上下文。',
  '必须保留：任务与目标、已定下的决定（人物、情节、文风、文件与章节状态）、当前进度、未完成的事、用户的明确偏好。',
  '不要客套，不要逐句复述，直接列事实。',
].join('');

// 压缩一次：返回摘要文本（去首尾空白，超长截到 maxChars）。
// 模型返回空（极端情况）时如实抛错——绝不用一份空摘要把对话抹掉。
export async function runCompaction({ modelClient, messages, maxChars = 6000 } = {}) {
  if (!modelClient || typeof modelClient.streamChat !== 'function') {
    throw new Error('压缩需要可用的模型客户端。');
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('没有可压缩的对话内容。');
  }
  let text = '';
  await modelClient.streamChat({
    messages: [{ role: 'system', content: COMPACTION_SYSTEM_PROMPT }, ...messages],
    onDelta: (delta) => {
      if (typeof delta === 'string') text += delta;
    },
  });
  const digest = text.trim();
  if (digest === '') throw new Error('模型没有返回摘要，会话保持原样。');
  return digest.length > maxChars ? digest.slice(0, maxChars) : digest;
}
