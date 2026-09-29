// 重启恢复：进程崩溃后重新打开会话时的收敛规则。
// 规则（恢复绝不自动执行任何输入、绝不开始新的 Run）：
//   1. 未闭合的 Run（投影 active_run_id 非空）追加 run_interrupted 收敛为 interrupted；
//   2. 排队输入是用户数据，原样保留，绝不自动开始执行；
//   3. 被打断轮次的活跃输入不重新排队：其文本保留在事件日志中，需用户手动重发；
//   4. 恢复事实以 session_recovered 事件落盘，投影 status 置为 interrupted，
//      直到下一次 run_started 才回到 active。
// 干净关闭的会话重新打开时 recoverSession 不追加任何事件（幂等）。
export async function recoverSession({ eventStore, truncatedTail = false } = {}) {
  if (!eventStore || typeof eventStore.rebuildProjection !== 'function' || typeof eventStore.appendBatch !== 'function') {
    throw new Error('恢复需要有效的事件存储。');
  }
  const { projection } = await eventStore.rebuildProjection();
  // 单一活跃 Run 不变量：同一时刻最多一个未闭合 Run。
  const interruptedRunIds = projection.active_run_id === null ? [] : [projection.active_run_id];
  if (interruptedRunIds.length === 0) {
    return { recovered: false, interruptedRunIds, events: [] };
  }
  const events = await eventStore.appendBatch([
    { type: 'run_interrupted', run_id: interruptedRunIds[0], data: { reason: 'process_exited' } },
    {
      type: 'session_recovered',
      data: {
        runs: interruptedRunIds,
        queued_count: projection.queue.length,
        truncated_tail: truncatedTail === true,
      },
    },
  ]);
  return { recovered: true, interruptedRunIds, events };
}
