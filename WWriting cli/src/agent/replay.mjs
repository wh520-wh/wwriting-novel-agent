// 屏幕重演的取舍：哪些轮次重演、每轮重演什么。
//
// 为什么需要它：这个 CLI 原来**没有屏幕回放**这件事——`--continue` 只把历史回喂给模型
// （history.mjs），屏幕上从不重演过去的轮次，重启后用户面对的是一个空输入框。
// 于是会出现「模型记得、屏幕看不到」：模型张口就叫出主角的名字，用户却完全不记得自己写过。
// 本模块把「哪些轮次该重新显示出来」这件事做成纯函数，与模型记忆共用同一份预算。
//
// 两条不变量（比实现细节重要）：
//   ① 重演的轮次集合与模型记得的轮次集合是**同一批**。做法是直接问
//      buildHistoryMessages 保留了几个尾部轮次（它保留的永远是尾部连续的若干轮），
//      绝不自己再算一遍预算——两套取舍迟早会分歧，那正是要堵的洞。
//   ② 屏幕上看得见的绝不少于模型记得的**对话内容**。唯一的边界情形是「最新一轮单独就超过整个预算」，
//      此时模型拿到的是被截尾的正文，屏幕重演全文——方向是安全的（屏幕 ⊇ 模型）。
//      **已知残余缺口**：history.mjs 的 turnMessages 会把工具摘要折进喂给模型的 assistant 消息，
//      而重演不画工具行（P24），所以「模型记得某次 count_text 得到 3210 字、屏幕上没有」
//      仍然成立。这个缺口被 tests/agent/replay.test.mjs 里那条用例**钉住**，
//      取舍与代价记在 ADR-0011——不靠放松断言把它盖过去。
//
// 思考项由本模块**自己扫事件**、按 run_id 与轮次配对，不经 projectTurns（R1）：
// tests/agent/history.test.mjs:126-137 有一条铁律级守门用例，断言投影的 JSON 里
// 绝不出现 `reasoning` 字样。两边各扫一遍是刻意的分工——
// history.mjs 只喂模型（永远看不见思考），本模块只给人看。
//
// 纯函数、无 I/O、不碰 ANSI：文案与排版归 src/terminal/replay.mjs，取舍归这里。
// 因此 status 项**只带判据**（terminal / interruptReason / failCode），不带文案——
// 文案由终端层调 renderer.mjs 的 terminalStatusText 得出，事件桥与重演因此说的是同一句话（R5）。
// 思考耗时（P20：事件时间戳差，不用本地计时器）也只有一份定义，与事件桥共用——
// 理由见 event-facts.mjs 的开头：同一个「思考 N 秒」不该有两条算法，否则当场与重演会各报一个数。
import { reasoningDurationMs } from './event-facts.mjs';
import { DEFAULT_HISTORY_BUDGET_CHARS, buildHistoryMessages, projectTurns } from './history.mjs';

// 扫一遍日志，把思考项按 run_id 归堆（R1：不经 projectTurns）。
//
// 只认 reasoning_completed（P18：不落 reasoning_delta，所以也没有增量可拼）。
// 孤立的项（run_id 为 null 或对不上任何轮次）自然被丢弃——调用方按 run_id 查表，
// 查不到就是不画，绝不猜它属于哪一轮（与 projectTurns 忽略孤立事件同一条判断）。
function reasoningByRun(events) {
  const byRun = new Map();
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    if (event.type !== 'reasoning_completed') continue;
    const runId = typeof event.run_id === 'string' && event.run_id !== '' ? event.run_id : null;
    if (runId === null) continue;
    const data = event.data ?? {};
    const item = { durationMs: reasoningDurationMs(data.started_at, event.at) };
    const list = byRun.get(runId);
    if (list === undefined) byRun.set(runId, [item]);
    else list.push(item);
  }
  return byRun;
}

// 当前任务计划：与事件投影同一套口径（run_started 清空、plan_updated 整表替换），
// 扫完日志剩下的一份就是「最新计划」。重演因此与 /plan 说同一句话——
// 不可能出现「/plan 说有计划、重演说没有」的分歧（与 R5 同一条要求）。
function lastPlan(events) {
  let plan = null;
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    if (event.type === 'run_started') plan = null;
    else if (event.type === 'plan_updated') {
      plan = Array.isArray(event.data?.items) && event.data.items.length > 0 ? event.data.items : null;
    }
  }
  return plan;
}

// 一轮 → 若干重演项。顺序就是当时发生的顺序：
// 用户说话 → 模型思考（可能多段，多轮工具调用时每段一项）→ 正文 → 收尾状态。
//
// **不重演**工具过程行、确认卡、排队行（P24）：它们是过程不是内容，
// 重演出来会把几十轮的会话刷成好几屏噪音，而用户要找回的是「我们写到哪了」。
function turnItems(turn, reasoning) {
  const items = [];
  if (typeof turn.userText === 'string' && turn.userText !== '') {
    items.push({ kind: 'user', text: turn.userText });
  }
  for (const entry of reasoning) items.push({ kind: 'thinking', durationMs: entry.durationMs });
  if (typeof turn.assistantText === 'string' && turn.assistantText !== '') {
    items.push({ kind: 'prose', text: turn.assistantText });
  }
  // 只带判据、不带文案（R5）：terminalStatusText 只有 renderer.mjs 那一份定义，
  // 事件桥与重演因此不可能各说一套。
  items.push({
    kind: 'status',
    terminal: turn.terminal,
    interruptReason: turn.interruptReason ?? null,
    failCode: turn.failCode ?? null,
  });
  return items;
}

// 事件日志 → 重演项。budgetChars 缺省就是模型记忆的那一份预算（P25）。
export function buildReplay(events, { budgetChars = DEFAULT_HISTORY_BUDGET_CHARS } = {}) {
  const list = Array.isArray(events) ? events : [];
  const turns = projectTurns(list);
  if (turns.length === 0) return { items: [], omittedTurns: 0, keptTurns: 0 };

  // 问历史投影「你保留了几个尾部轮次」，然后重演**同一批**。
  // 这里刻意不复用 built.messages：那是回喂给模型的形态（工具调用被折进 assistant 文本），
  // 重演要的是原始的 turn（正文归正文、思考归思考）。
  const built = buildHistoryMessages(turns, { budgetChars });
  const keptTurns = built.keptTurns;
  const shown = keptTurns <= 0 ? [] : turns.slice(Math.max(0, turns.length - keptTurns));

  const byRun = reasoningByRun(list);
  const items = [];
  for (const turn of shown) {
    const reasoning = turn.runId === null ? [] : (byRun.get(turn.runId) ?? []);
    items.push(...turnItems(turn, reasoning));
  }
  // 当前计划附在重演末尾：用户找回的是「我们写到哪了」，最后一份计划正是答案的骨架。
  // 计划属于被重演轮次之外的**当前状态**（滚动条前面就能看到历史正文），不占轮次预算。
  const plan = lastPlan(list);
  return { items, omittedTurns: built.truncatedTurns, keptTurns, plan };
}
