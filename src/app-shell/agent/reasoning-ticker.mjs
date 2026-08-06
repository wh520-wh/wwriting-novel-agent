// src/app-shell/agent/reasoning-ticker.mjs —— 运行中思考摘要的文本 ticker（Task 6 Step 2）。
//
// Ticker 只控制运行中摘要：把 reasoning_delta 的增量文本切分为完整语义片段
// （断点为换行或 。！？.!?；;），当前片段至少停留 dwellMs，积压只保留最新完整
// 片段，finish() 立即停止计时并返回未展示的文本。详情区永远使用持久化完整
// reasoning（item.text），不使用 ticker 文本拼装原文。
//
// scheduler 注入（默认 globalThis）以便测试用 fake clock 确定性推进计时。
export function createReasoningTicker({ onDisplay, dwellMs = 800, scheduler = globalThis } = {}) {
  let current = "";       // 当前展示中的完整片段
  let pendingLatest = ""; // 计时期间到达的最新完整片段（积压只保留最新）
  let carry = "";         // 尚未构成完整片段的尾段
  let timer = null;

  const BREAK = /[\n。！？.!?；;]/;

  function clearTimer() {
    if (timer != null) {
      scheduler.clearTimeout(timer);
      timer = null;
    }
  }

  function scheduleTimer() {
    if (timer != null) return;
    timer = scheduler.setTimeout(() => {
      timer = null;
      if (pendingLatest.length > 0) {
        current = pendingLatest;
        pendingLatest = "";
        onDisplay(current);
        scheduleTimer(); // 新片段同样至少停留 dwellMs
      }
    }, dwellMs);
  }

  function push(delta) {
    if (typeof delta !== "string" || delta.length === 0) return;
    let rest = carry + delta;
    carry = "";
    let latest = null;
    let match = BREAK.exec(rest);
    while (match) {
      const end = match.index + match[0].length;
      latest = rest.slice(0, end);
      rest = rest.slice(end);
      match = BREAK.exec(rest);
    }
    carry = rest; // 未完成尾段
    if (latest == null) return; // 本段仍不构成完整片段
    pendingLatest = latest;     // 积压只保留最新完整片段
    if (timer == null) {
      current = pendingLatest;
      pendingLatest = "";
      onDisplay(current);
      scheduleTimer();
    }
  }

  function finish() {
    clearTimer();
    const leftover = (pendingLatest || "") + carry;
    pendingLatest = "";
    carry = "";
    current = "";
    return leftover;
  }

  function reset() {
    clearTimer();
    current = "";
    pendingLatest = "";
    carry = "";
  }

  return { push, finish, reset };
}
