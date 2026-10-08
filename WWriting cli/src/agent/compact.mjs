// 会话压缩执行：把「已往对话」收敛成一份摘要文本（/compact 的模型调用段）。
//
// 为什么是独立一段模型调用而不是一轮普通 Agent：压缩不需要工具、不需要确认、
// 不该在事件流里留下 run_started/run_completed 的痕迹——它不是对话，是维护动作。
// 摘要本身落进 digest_compacted 事件（由 run-controller 负责），本模块只管「要一段文字」。
//
// 不给 tools（DeepSeek 客户端对空 tools 不下发字段）；长历史按窗口分批请求，
// 自动压缩沿用当前轮的 signal，停止时不发布半份摘要。
import { estimateChars, buildDigestMessage } from './history.mjs';
import { inputBudgetChars, resolveModelLimits } from '../model/model-limits.mjs';

// 摘要的系统提示：说清「这段文字将替代这些轮次」，让模型保留决策与状态而不是复述。
export const COMPACTION_SYSTEM_PROMPT = [
  '你是 WWriting 的写作 Agent。下面的对话将被收敛：你写一份给「未来的你」看的工作摘要，',
  '它以 [会话摘要] 的名义替代这些轮次进入后续上下文。',
  '必须保留：任务与目标、已定下的决定（人物、情节、文风、文件与章节状态）、当前进度、未完成的事、用户的明确偏好。',
  '完整保留人物关系与变化、时间线、伏笔的埋设和回收、约束与修改原因；按需要详细记录，不为缩短字数省略事实。',
  '不要客套，不要逐句复述，直接列事实。',
].join('');

// 超出模型输入窗口时分批吸收；不截断原文，也不截断模型摘要。
// 模型返回空（极端情况）时如实抛错——绝不用一份空摘要把对话抹掉。
export async function runCompaction({ modelClient, messages, signal = null, budgetChars = null } = {}) {
  if (!modelClient || typeof modelClient.streamChat !== 'function') {
    throw new Error('压缩需要可用的模型客户端。');
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('没有可压缩的对话内容。');
  }
  const budget = budgetChars ?? inputBudgetChars(await modelClient.getLimits?.() ?? resolveModelLimits());
  const system = { role: 'system', content: COMPACTION_SYSTEM_PROMPT };
  async function summarize(batch) {
    if (signal?.aborted) throw Object.assign(new Error('已停止压缩。'), { code: 'MODEL_ABORTED' });
    let text = '';
    const result = await modelClient.streamChat({
      messages: [system, ...batch], signal,
      onDelta: (delta) => { if (typeof delta === 'string') text += delta; },
    });
    if (signal?.aborted) throw Object.assign(new Error('已停止压缩。'), { code: 'MODEL_ABORTED' });
    if (result?.finishReason === 'length') throw new Error('摘要未完整生成，会话保持原样。');
    const digest = text.trim();
    if (digest === '') throw new Error('模型没有返回摘要，会话保持原样。');
    return digest;
  }
  if (JSON.stringify([system, ...messages]).length <= budget) return summarize(messages);
  // 历史长于一个请求时，逐段把旧摘要和下一段原文一起送入；所有段成功才由调用方落盘。
  const transcript = messages.map((message) => JSON.stringify(message)).join('\n');
  let digest = '';
  for (let offset = 0; offset < transcript.length;) {
    const prefix = digest === '' ? [] : [buildDigestMessage(digest)];
    const room = budget - estimateChars([system, ...prefix]) - 64;
    if (room < 2) throw new Error('摘要仍超出模型窗口，会话保持原样。');
    let end = Math.min(offset + room, transcript.length);
    if (end < transcript.length && /[\uD800-\uDBFF]/u.test(transcript[end - 1])) end -= 1;
    digest = await summarize([...prefix, { role: 'user', content: transcript.slice(offset, end) }]);
    offset = end;
  }
  return digest;
}

// 工具轮次增长也检查窗口。保留系统、项目记忆、当前指令与最新完整工具交换，
// 只把更早的上下文收敛；历史日志与已执行副作用均保持原样。
export async function fitContext({ modelClient, messages, tools, signal, onCompact, prefixLength = 1 }) {
  const budget = inputBudgetChars(await modelClient.getLimits?.() ?? resolveModelLimits())
    - JSON.stringify(tools ?? []).length;
  if (JSON.stringify(messages).length <= budget) return;
  const start = prefixLength;
  let current = messages.length - 1;
  while (current > start && messages[current].role !== 'user') current -= 1;
  let latest = messages.length;
  for (let i = current + 1; i < messages.length; i += 1) {
    if (messages[i].role === 'assistant' && messages[i].tool_calls?.length) latest = i;
  }
  const preserved = [...messages.slice(0, start), messages[current], ...messages.slice(latest)];
  if (JSON.stringify(preserved).length >= budget) throw new Error('当前输入或工具结果超出模型窗口，原始记录已保留。');
  const older = [...messages.slice(start, current), ...messages.slice(current + 1, latest)];
  if (older.length === 0) throw new Error('当前输入超出模型窗口，原始记录已保留。');
  onCompact?.('压缩中');
  const digest = buildDigestMessage(await runCompaction({ modelClient, messages: older, signal }));
  if (JSON.stringify([...preserved, digest]).length > budget) throw new Error('压缩后仍超出模型窗口，原始记录已保留。');
  messages.splice(start, messages.length - start, digest, messages[current], ...messages.slice(latest));
}
