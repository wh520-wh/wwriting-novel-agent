// 屏幕重演的排版层：把 src/agent/replay.mjs 算好的项交给渲染器画出来。
//
// 这一层**不做任何取舍**——「哪些轮该重演、预算多少」全在 agent 层（P25 / P26）。
// 分工与 renderer.mjs 里「summarizeToolResult 只做转发、不复制判断」那条注释是同一个道理：
// 判断只有一处定义，
// 两边各写一份就迟早会出现「屏幕说重演了 5 轮、模型只记得 3 轮」的分歧。
//
// 调用时机很讲究（见 cli.mjs 的装配处）：在启动面板之后、常驻 readline 建立之前。
// 此时屏幕上还没有输入框，重演的内容按顺序直写，不必和行缓冲打交道。
import { formatThinkingSeconds, terminalStatusText } from './renderer.mjs';

export function printReplay({ renderer, items = [], omittedTurns = 0 } = {}) {
  if (!renderer) throw new Error('屏幕重演需要可用的渲染器。');
  const list = Array.isArray(items) ? items : [];
  const omitted = Number.isFinite(omittedTurns) && omittedTurns > 0 ? Math.floor(omittedTurns) : 0;

  // 只在**真的省略了东西**时才占一行——与 history_applied 的「已载入前情」同一条判断：
  // 每次启动都写「已重演对话」会在屏幕上堆成噪音，而用户并不需要知道这件事在正常运转。
  if (omitted > 0) {
    renderer.printStatus('已重演对话', { final: true, tone: 'info', detail: `更早的 ${omitted} 轮未重演` });
  }

  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    switch (item.kind) {
      case 'user':
        // 走 printUser 而不是自己拼一行：用户消息的背景色带（P17）只有一处实现，
        // 重演出来的历史用户行与当场敲的那条必须长一个样。
        if (typeof item.text === 'string' && item.text !== '') renderer.printUser(item.text);
        break;
      case 'thinking':
        // 时长格式化只有 renderer 那一份定义（formatThinkingSeconds）：
        // 它的最小 1 秒、四舍五入、回退「已完成思考」三条口径不该在这里重算一遍。
        renderer.printStatus(formatThinkingSeconds(item.durationMs ?? null), { final: true, tone: 'info' });
        break;
      case 'prose':
        if (typeof item.text === 'string' && item.text !== '') renderer.printAssistant(item.text);
        break;
      case 'status': {
        // 文案与色调都来自 terminalStatusText（R5）：事件桥用的是同一个函数，
        // 所以重演出来的历史轮与刚跑完的当前轮说的是同一句话——
        // 不会一个说「已停止」另一个说「已中断」，也不会把「连接中断」糊成「操作失败」。
        // （它的 `hint` 只给当场路径用：历史轮上冒出一句「用 /model ⋯」是噪音。）
        const status = terminalStatusText(item);
        // 空文案不写：printStatus('', { final: true }) 会往 scrollback 里塞一个空行。
        // 现在的 terminalStatusText 每条路径都返回非空文案，这条守卫是第二道防线。
        if (status.text !== '') renderer.printStatus(status.text, { final: true, tone: status.tone });
        break;
      }
      default:
        // 不认识的项类型忽略，不抛：日志可能来自更早的版本，
        // 而「重演历史」这件事不值得让启动失败（与 history.mjs 忽略孤立事件同一条判断）。
        break;
    }
  }
  // printAssistant 是攒行落盘的，最后一批可能还留在缓冲区里。
  // clearLive 会把它冲掉（顺带收掉任何未闭合的动态行——重演路径上本来不该有）。
  renderer.clearLive();
}
