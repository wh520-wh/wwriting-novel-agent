// 会话历史投影：把事件日志折算成「可以回喂给模型的对话轮次」，并按预算截断。
//
// 为什么需要它：`--continue` 恢复出来的历史原本只是**给人看的**——模型每轮只拿到
// system + 当轮输入，等于每次都在失忆状态下重新开工。长篇写作是长程任务，失忆等于每章重开。
// 本模块把日志里已有的可见内容重建为对话上下文，让「记得住」成为产品事实。
//
// 三条不可动摇的边界：
//   ① **不新增真相源**：历史完全派生于 events.jsonl，不写第二份对话记录，不改事件 schema。
//   ② **不重放副作用**：投影只做纯只读的文本重建。历史里的工具调用只是上下文陈述，
//      绝不能变成「再执行一次 write_file」——铁律 4 的权限分级不能被回放绕开。
//   ③ **私有 reasoning 不回流**：`reasoning_content` 经 reasoning_completed 事件进了日志，
//      但本模块**整个忽略**那种事件（走 default 分支），投影里没有它、messages 里也没有它。
//      需要把思考呈现给人的是 src/agent/replay.mjs，它自己扫事件——
//      分工是「history 只喂模型、replay 只给人看」，两边各扫一遍是刻意的，不是重复。
//
// 纯函数、无 I/O、无依赖：预算与截断规则因此可以被逐条断言，不必先起一个会话。
import { terminalOfEvent } from './event-facts.mjs';
import { summarizeToolResult } from '../tools/tool-summary.mjs';

// 历史预算（字符数，不是 token）。默认 24000 字符：
// 中文正文约 1 字符 ≈ 1 token 量级，这个量级既容得下前面几章的上下文，
// 又给当轮输出与系统提示留足空间。**这是估算值，不与模型自报的 token 数混用**——
// 精确计数需要 tokenizer，本项目不引第三方依赖。
export const DEFAULT_HISTORY_BUDGET_CHARS = 24000;

// 一轮里单个工具调用的上下文陈述。只带名字、目标与结果摘要，
// **不带参数原文与工具输出正文**：那不是对话上下文，那是把整章正文重灌一遍。
function toolLine(use) {
  const label = use.name || '工具';
  const where = typeof use.target === 'string' && use.target !== '' ? ` ${use.target}` : '';
  const verdict = use.ok ? '' : '（失败）';
  const detail = typeof use.summary === 'string' && use.summary !== '' ? ` · ${use.summary}` : '';
  return `${label}${where}${verdict}${detail}`;
}

// 事件序列 → Turn[]。按 seq 顺序扫描，遇到 run_started 开一轮。
//
// 孤立事件（没有归属的 run_started 的 activity / 终态）一律忽略，不抛错：
// 日志可能来自更早的版本，或正处于崩溃残留状态，而**回放历史这件事不值得让整轮开工失败**。
export function projectTurns(events) {
  if (!Array.isArray(events)) return [];
  const turns = [];
  let current = null;
  // call_id → 该工具调用在 tools 数组里的下标，用于把 activity_finished 配对回 activity_started。
  let callIndex = new Map();

  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    const data = event.data ?? {};
    switch (event.type) {
      case 'run_started': {
        // 上一个 run_started 没有终态（崩溃残留）：保留它，标为 open，由下一次开工时的
        // 恢复逻辑去收敛；这里只如实呈现，不猜测它成功了。
        current = {
          inputId: typeof data.input_id === 'string' ? data.input_id : null,
          runId: typeof event.run_id === 'string' ? event.run_id : null,
          // 轮的起点 seq：会话压缩（/compact）按它判断「哪些轮已被摘要覆盖」。
          startSeq: event.seq,
          userText: typeof data.text === 'string' ? data.text : '',
          assistantText: '',
          tools: [],
          terminal: 'open',
          // 终态的原因与错误码。**只用于选屏幕上那一句文案**（terminalStatusText），
          // turnMessages 绝不读它们——错误码不该进模型上下文（铁律 3 同源）。
          //
          // 字段名刻意避开 `reasoning` 字样：tests/agent/history.test.mjs 的守门用例断言
          // `JSON.stringify(turns)` 里不出现 `reasoning`，那是铁律级的约束，
          // 一个叫 `reason` 的字段会让下一个改这里的人误判（R1 / R5）。
          interruptReason: null,
          failCode: null,
        };
        callIndex = new Map();
        turns.push(current);
        break;
      }
      case 'activity_started': {
        if (current === null) break;
        const index = current.tools.length;
        current.tools.push({
          name: typeof data.tool === 'string' ? data.tool : '',
          target: typeof data.target === 'string' ? data.target : null,
          ok: true,
          summary: null,
        });
        // call_id 可能为 null（模型没给 id）：那就不建映射，finished 会按顺序兜底。
        if (typeof data.call_id === 'string' && data.call_id !== '') callIndex.set(data.call_id, index);
        break;
      }
      case 'activity_finished': {
        if (current === null) break;
        let index = typeof data.call_id === 'string' && data.call_id !== ''
          ? callIndex.get(data.call_id)
          : undefined;
        // 没有 call_id 配对：退回「最后一条还没收尾的调用」，比丢掉这条结果强。
        if (index === undefined) {
          for (let i = current.tools.length - 1; i >= 0; i -= 1) {
            if (current.tools[i].summary === null && current.tools[i].ok === true) {
              index = i;
              break;
            }
          }
        }
        if (index === undefined || index === null || !current.tools[index]) break;
        const use = current.tools[index];
        use.ok = data.ok !== false;
        use.summary = summarizeToolResult(data);
        break;
      }
      // 三条终态共用一段收尾：把事件翻成轮次形态（terminal / interruptReason / failCode）
      // 之后 current 就闭合了。映射本身住在 event-facts.mjs —— 事件桥也调同一个函数，
      // 各写一份就会在新增一种终态原因时让「当场显示」与「重启重演」各自解释（R5）。
      case 'run_completed':
      case 'run_interrupted':
      case 'run_failed': {
        if (current === null) break;
        // 完成轮的正文以 run_completed.text 为准（权威全文）：delta 累加只是它的过程，
        // 日志截断时会缺开头。被取消的轮不带 text，已累积的可见正文是真实产出，保留它——
        // 用户停止不代表「那段话没说过」，模型也不该以为自己是空手收场的。
        if (event.type === 'run_completed') {
          current.assistantText = typeof data.text === 'string' ? data.text : '';
        }
        Object.assign(current, terminalOfEvent(event));
        current = null;
        break;
      }
      case 'model_delta': {
        if (current === null) break;
        // 可见正文的增量。只在没有 run_completed.text 时才是唯一来源（中断/失败轮）。
        if (typeof data.text === 'string') current.assistantText += data.text;
        break;
      }
      default:
        break;
    }
  }
  // 收尾：`completed` 轮的 assistantText 以 run_completed.text 为准（权威全文），
  // 因为 delta 累加可能因日志截断而缺了开头。这里做一次覆盖，确保两者不会各说一半。
  for (const turn of turns) {
    if (turn.terminal === 'completed' && turn.assistantText !== '') {
      // run_completed.text 已经是全文，delta 累加只是它的过程；若两者长度不同，以完成事件为准。
      // 已被 run_completed 分支赋值过，这里无需再动——保留此段作为规则说明的锚点。
      continue;
    }
  }
  return turns;
}

// 一轮 → 两条消息（user + assistant）。工具调用折进 assistant 的文本里：
// 对话上下文需要的是「它当时做了什么、拿到了什么」，而不是原样的 tool_calls 协议结构
// （那需要 id、参数 JSON 与后续 tool 消息严格配套，录回来既脆又长得没边）。
function turnMessages(turn) {
  const assistantParts = [];
  if (turn.tools.length > 0) {
    assistantParts.push(turn.tools.map((use) => `· ${toolLine(use)}`).join('\n'));
  }
  if (turn.assistantText !== '') assistantParts.push(turn.assistantText);
  if (turn.terminal === 'interrupted') assistantParts.push('（这一轮被停止，内容保持原样。）');
  if (turn.terminal === 'failed') assistantParts.push('（这一轮执行失败。）');
  if (turn.terminal === 'open') assistantParts.push('（这一轮未正常结束。）');

  const messages = [{ role: 'user', content: turn.userText }];
  // assistant 为空（比如工具都没跑、正文也没出）时补一个占位：对话序列里空 content 会被
  // 某些服务端拒绝，而占位能如实说明「这一轮没有产出」。
  messages.push({
    role: 'assistant',
    content: assistantParts.length > 0 ? assistantParts.join('\n\n') : '（这一轮没有产出任何内容。）',
  });
  return messages;
}

// 轮次集合的可见字符合计——与 buildHistoryMessages 的预算同一把尺（turnMessages + estimateChars）。
// 有界读的停止判据用它：窗口内完整轮的字符合计装满预算后，更早的轮次必被预算丢弃，
// 不读它们不改变装配结果（规格 2026-10-06 D4）。
export function estimateTurnsChars(turns) {
  if (!Array.isArray(turns)) return 0;
  let total = 0;
  for (const turn of turns) total += estimateChars(turnMessages(turn));
  return total;
}

// 逐条消息的字面长度。工具摘要已经在文本里，直接量字符串就够——
// 不引 tokenizer，也就不会与模型自报的 token 数（run_completed.usage）混为一谈。
export function estimateChars(messages) {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const message of messages) {
    if (message && typeof message.content === 'string') total += message.content.length;
  }
  return total;
}

// 从最近一轮往前收，直到加上下一轮会超预算为止；返回的序列保持时间正序。
//
// 截断策略的原则（比公式重要，实现者可调阈值但必须守住这四条）：
//   ① **用户输入永不截断** —— 那是指令，截半句会让模型误读意图；
//   ② 单轮超预算时**保留该轮、只截 assistant 正文的尾部** —— 丢掉最新上下文比丢半段正文更糟；
//   ③ 被丢掉的更早轮次如实计入 `truncatedTurns`，供渲染层说明「省略了多少」；
//   ④ 预算连一轮都放不下时返回空数组（不是 null），调用方无需分支。
//
// digest（可选）：/compact 产出的会话摘要消息。它插在**最前**、计入预算——
// 「摘要 + 未覆盖轮次」合计不得超预算，与「轮次」同一本账（否则预算名存实亡）。
// 摘要本身永不截断：它是被刻意压缩过的产物，再截就二次失真；超预算时宁可不放轮次。
export function buildHistoryMessages(turns, { budgetChars = DEFAULT_HISTORY_BUDGET_CHARS, digest = null } = {}) {
  const list = Array.isArray(turns) ? turns : [];
  const budget = Number.isFinite(budgetChars) && budgetChars > 0 ? Math.floor(budgetChars) : DEFAULT_HISTORY_BUDGET_CHARS;
  const digestMessage = digest !== null && typeof digest.content === 'string' && digest.content !== '' ? digest : null;
  const digestCost = digestMessage === null ? 0 : estimateChars([digestMessage]);
  const room = Math.max(0, budget - digestCost);
  if (list.length === 0) {
    const messages = digestMessage === null ? [] : [digestMessage];
    return { messages, truncatedTurns: 0, usedChars: digestCost, keptTurns: 0 };
  }

  const kept = [];
  let used = 0;

  for (let i = list.length - 1; i >= 0; i -= 1) {
    const messages = turnMessages(list[i]);
    const cost = estimateChars(messages);
    if (used + cost <= room) {
      kept.unshift(...messages);
      used += cost;
      continue;
    }
    // 放不下：如果这还是最新的一轮（kept 为空），按原则 ② 部分保留；
    // 否则停止收集，剩下的更早轮次全部计入 truncatedTurns。
    if (kept.length === 0) {
      const trimmed = trimNewest(messages, room);
      if (trimmed !== null) {
        kept.unshift(...trimmed.messages);
        used += trimmed.usedChars;
      }
    }
    break;
  }

  const keptTurns = kept.length === 0 ? 0 : countKeptTurns(kept);
  // truncatedTurns 按「被丢掉的轮数」计：总轮数减去实际保留下来的轮数。
  const truncatedTurns = Math.max(0, list.length - keptTurns);
  const messages = digestMessage === null ? kept : [digestMessage, ...kept];
  return { messages, truncatedTurns, usedChars: used + digestCost, keptTurns };
}

// 最新一轮超预算时的部分保留：保用户输入（永不截），把 assistant 正文按剩余预算截尾。
function trimNewest(messages, budget) {
  const user = messages[0];
  const assistant = messages[1];
  const userCost = estimateChars([user]);
  if (userCost > budget) {
    // 连用户输入都放不下（极窄预算或超长输入）：放不下就不放，返回 null 让调用方空手开工。
    // 不截用户输入是有意为之——截半句指令比不提供历史危险得多。
    return null;
  }
  const room = budget - userCost;
  const text = typeof assistant.content === 'string' ? assistant.content : '';
  // 从尾部截：最新的内容离「现在」最近，信息量最大。
  const sliced = text.length > room ? text.slice(text.length - room) : text;
  const trimmed = [
    { role: 'user', content: user.content },
    { role: 'assistant', content: sliced === '' ? '（这一轮没有产出任何内容。）' : sliced },
  ];
  return { messages: trimmed, usedChars: estimateChars(trimmed) };
}

// kept 是扁平的消息数组，轮数 = user 消息的条数（每轮恰好一条 user）。
function countKeptTurns(messages) {
  let count = 0;
  for (const message of messages) {
    if (message && message.role === 'user') count += 1;
  }
  return count;
}

// —— 会话压缩（/compact）——
//
// 摘要是「已往对话的替代品」：它以一条合成 user 消息的身份插在项目记忆之后、
// 未覆盖轮次之前（与记忆同一位置语义，ADR-0008 的前缀缓存理由同样适用——
// 摘要只在下次 /compact 时才变，其余每轮字节恒定，缓存照常命中）。

export const DIGEST_MARKER = '[会话摘要]';

// 摘要文本 → 注入消息。调用方不自己拼：标记与格式只有这一处定义。
export function buildDigestMessage(text) {
  return { role: 'user', content: `${DIGEST_MARKER}\n${text}` };
}

// 日志里最近一次压缩的摘要（没有则 null）。digest_compacted 走事件存储的 default 分支，
// 不进投影——它只在装配历史时按需扫一遍，不值得为它常驻状态。
export function latestDigest(events) {
  let digest = null;
  for (const event of events) {
    if (event === null || typeof event !== 'object' || event.type !== 'digest_compacted') continue;
    const data = event.data ?? {};
    if (typeof data.digest === 'string' && data.digest !== '') {
      digest = {
        text: data.digest,
        throughSeq: Number.isInteger(data.through_seq) ? data.through_seq : 0,
        // 压缩时刻已被摘要覆盖的轮次总数（= 当时全部轮次）。旧事件没有该字段 → null，
        // 消费方据此把「摘要覆盖 N 轮」降级为不带数字的说法（诚实计数，规格 2026-10-06 D4）。
        coveredTotal: Number.isInteger(data.covered_total) && data.covered_total >= 0 ? data.covered_total : null,
      };
    }
  }
  return digest;
}

// /retry 的可重试判定（统一行为规格书 §4.1 的 CLI 口径）：**只看最近一条终态**——
// run_failed 一律可重试；run_interrupted 里用户主动停止（user_stop）不可重试（停止语义干净），
// 其余原因（进程退出、崩溃恢复、无终态收敛）都是「没跑完」，可以重发。
// 最近终态是已完成、或根本没有轮次 → null（命令层据此说「没有可重试的失败轮次。」）。
//
// 原文取自轮次里的 run_started 文本——它与该输入提交事件里的原文逐字一致
// （run_started 的 text 就来自 input_submitted），不必再扫一遍提交事件。
// input_id 或原文缺失（畸形残留）同样不可重试：没有可复用的东西就绝不编造。
export function findRetryableTurn(events) {
  const turns = projectTurns(events);
  if (turns.length === 0) return null;
  const last = turns[turns.length - 1];
  // open 轮是未收敛的崩溃残留：恢复逻辑会先把它收敛成 interrupted，这里不猜。
  if (last.terminal === 'open') return null;
  const retryable = last.terminal === 'failed'
    || (last.terminal === 'interrupted' && last.interruptReason !== 'user_stop');
  if (!retryable) return null;
  if (typeof last.inputId !== 'string' || last.inputId === '') return null;
  if (typeof last.userText !== 'string' || last.userText === '') return null;
  return {
    inputId: last.inputId,
    runId: last.runId,
    text: last.userText,
    terminal: last.terminal,
    interruptReason: last.interruptReason,
  };
}
