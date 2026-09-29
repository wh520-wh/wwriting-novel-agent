// 输入让位的持有计数（缺陷猎捕报告 4）。
//
// 让位只有一个出口（cli.mjs 的 withInputSuspended），但让位会**嵌套**：/model 向导
// 或 /resume 挑选让位期间，Run 还在跑，此刻到达的权限确认卡会再进一次让位。
// input.suspend() 是幂等的（readline 已关时 no-op），input.resume() 却会**真的**
// 建一个常驻 readline——不计数的话，内层任务的 finally 会抢在外层结束前把输入
// 建回来，同一份按键被两个读取者同时消费：向导里输入的 API Key 会被当作聊天
// 消息提交给模型（input.mjs 头注明令禁止的「同一套按键上再起一个读取者」）。
//
// 持有计数：suspend 只在最外层发生一次，resume 也只在最外层的 finally 发生一次。
export function createInputYielder({ input } = {}) {
  if (!input || typeof input.suspend !== 'function' || typeof input.resume !== 'function') {
    throw new Error('创建输入让位需要可 suspend/resume 的输入层。');
  }
  let depth = 0;
  async function withInputSuspended(task) {
    const outermost = depth === 0;
    depth += 1;
    try {
      if (outermost) input.suspend();
      return await task();
    } finally {
      depth -= 1;
      if (depth === 0) input.resume();
    }
  }
  return { withInputSuspended };
}
