// 从事件里读出的事实：终态形态与耗时口径。
//
// 为什么单独一个模块：这两件事各有两个消费者，且分处两层——
//   · **终态形态**（事件 → completed / interrupted / failed + 原因 + 错误码）：事件的
//     **落盘侧**（history.mjs 的 projectTurns）与**上屏侧**（terminal/event-bridge.mjs）
//     都要把它翻成同一个形状，再交给 terminalStatusText 出文案；
//   · **思考耗时**（两个时间戳 → 毫秒）：当场路径（事件桥）与重启后的重演（replay.mjs）都要算。
// 各写一份的代价不是「多几行」，而是**会分叉**：重演出来的历史于是比用户当时看到的更不准，
// 而那正是 R5 要堵的洞（也曾真的发生过：重演把所有中断都说成「已停止」）。
// 所以判据只有一处定义，两个消费者都 import 这一份——与 summarizeToolResult 下沉到
// src/tools/tool-summary.mjs 是同一条要求。
//
// 纯函数、无 I/O、不碰 ANSI 与终端宽度：所以两边都能用（agent 层不得依赖终端层）。
// 反过来历史投影也只从事件读形态，不反向依赖渲染任何东西。

// 事件里的 at（ISO 字符串）→ 毫秒。拿不到返回 NaN，调用方一律按「别报耗时」处理。
export function eventMillis(at) {
  return typeof at === 'string' ? Date.parse(at) : NaN;
}

// 思考耗时从**事件时间戳差**算，不从本地计时器算（P20）：
// grokbuild 的教训是本地计时器会冻成 0ms，而重启之后本地计时器根本不存在，
// 时间戳是唯一还能算的依据。算不出就返回 null，渲染层据此回退「已完成思考」。
export function reasoningDurationMs(startedAt, completedAt) {
  const from = eventMillis(startedAt);
  const to = eventMillis(completedAt);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const span = to - from;
  return span > 0 ? span : null;
}

// 三条终态事件 → 轮次形态（Turn 的 terminal / interruptReason / failCode 三个字段）。
// 不是终态事件返回 null，调用方据此走自己的分支。
//
// `data.reason` 只在 run_interrupted 上有，`data.code` 只在 run_failed 上有，缺了就传 null，
// terminalStatusText 自己会走对分支。字段名刻意避开 `reasoning` 字样：history 的守门用例
// 断言投影的 JSON 里绝不出现那个词（铁律级的约束），一个叫 `reason` 的字段会让下一个人误判。
export function terminalOfEvent(event) {
  if (event === null || typeof event !== 'object') return null;
  const data = event.data ?? {};
  if (event.type === 'run_completed') {
    return { terminal: 'completed', interruptReason: null, failCode: null };
  }
  if (event.type === 'run_interrupted') {
    return {
      terminal: 'interrupted',
      interruptReason: typeof data.reason === 'string' ? data.reason : null,
      failCode: null,
    };
  }
  if (event.type === 'run_failed') {
    return {
      terminal: 'failed',
      interruptReason: null,
      failCode: typeof data.code === 'string' ? data.code : null,
    };
  }
  return null;
}
