// /plan、/compact、/stop、/now、/cancel、/retry：跑 run controller 的命令族。
// 全部只吃 getController ＋ reply/renderer——不碰存储、不碰模型配置；表条目见 commands.mjs。
// /retry 的可重试判定与历史投影共用同一份纯函数（history.mjs）：命令层先判、先回显原文，
// 控制器只负责「能不能安全起跑」的再拦截。
import { fact } from '../../fact.mjs';
import { findRetryableTurn } from '../../agent/history.mjs';

export const runCommands = [
  { name: 'plan', description: '查看当前任务计划', run: runPlanCommand },
  { name: 'compact', description: '把已往对话收敛成摘要，释放上下文', run: runCompactCommand },
  { name: 'stop', description: '停止当前这一轮', run: runStopCommand },
  { name: 'now', description: '提升队首输入，打断当前这一轮', run: runNowCommand },
  { name: 'cancel', description: '撤回队首排队输入', run: runCancelCommand },
  { name: 'retry', description: '重跑最近一次失败或中断的轮次', run: runRetryCommand },
];

// 排队原文 → 撤回详情的一行摘要：取首行、压空白、按码点截 40 字，多行/超长加省略号。
function clipOneLine(text) {
  const raw = typeof text === 'string' ? text : '';
  const lines = raw.split(/\r?\n/);
  const firstLine = (lines[0] ?? '').trim().replace(/\s+/g, ' ');
  const points = Array.from(firstLine);
  const truncated = points.length > 40 || lines.some((line, index) => index > 0 && line.trim() !== '');
  return `${points.slice(0, 40).join('')}${truncated ? '…' : ''}`;
}

// /plan：任务计划的按需回看（P10「折叠态即回看态」在终端的第二入口——
// Run 当场那份已随 plan_updated 落进 scrollback，这里看的是**当前**一份，
// 重启后 / 下一轮开始后仍可问「刚才那轮计划到哪了」）。
async function runPlanCommand(_args, ctx) {
  const { reply, renderer, getController } = ctx;
  const snapshot = getController().snapshot();
  const plan = snapshot?.plan ?? null;
  if (plan === null || !Array.isArray(plan.items) || plan.items.length === 0) {
    reply('暂无计划', { tone: 'info', detail: '多步任务进行时显示当前计划' });
    return;
  }
  renderer.printPlan(plan.items);
}

// /compact：手动压缩（CLI 有意不做自动压缩——触发时机与安全点的复杂度不值得）。
// 只在空闲时可用：与在跑的轮并发会造出「摘要缺了正在说的这轮」的假账（控制器再拦一次）。
async function runCompactCommand(_args, ctx) {
  const { reply, renderer, getController } = ctx;
  const controller = getController();
  if (controller.isBusy()) {
    reply('运行中', { tone: 'warn', detail: '等这一轮结束再压缩。' });
    return;
  }
  renderer.printStatus('压缩中');
  try {
    const result = await controller.compact();
    if (result.status === 'empty') {
      reply('还没有可压缩的对话');
      return;
    }
    reply('已压缩', { tone: 'success', detail: `${result.turns} 轮收敛成 ${result.chars} 字摘要` });
  } catch (error) {
    reply('压缩失败', { tone: 'error', detail: fact(error) });
  }
}

// 停止只停当前这一轮：不解锁会话、不清空队列（D14）。清空队列会让「停止后接着写」丢内容。
// 真的停下来了就不再回一句「已停止」——那一轮的终态行马上会说同一件事（铁律 3：成功不弹 Toast）。
// 空闲时相反，必须如实说明：否则用户会以为自己的停止没生效。
function runStopCommand(_args, ctx) {
  const { reply, getController } = ctx;
  const result = getController().stop();
  if (!(result && result.stopped === true)) reply('空闲中');
}

// 「立即」：把队首那条输入提上来跑，打断当前轮（D14 的语义，由控制器实现）。
//
// 为什么必须是命令而不是裸词：写作正文里「立即」是个正常词（「他立即转身」），
// 裸词触发会吞掉用户的正文。斜杠命令与既有命令集同构，也天然没有误判风险。
//
// 队列为空时如实说明，不静默：否则用户以为提升生效了，实际上什么都没有发生。
async function runNowCommand(_args, ctx) {
  const { reply, getController } = ctx;
  const controller = getController();
  const snapshot = controller.snapshot();
  const queue = Array.isArray(snapshot.queue) ? snapshot.queue : [];
  if (queue.length === 0) {
    reply('队列为空');
    return;
  }
  const head = queue[0];
  const inputId = head && typeof head.input_id === 'string' ? head.input_id : null;
  if (inputId === null) {
    reply('队列为空');
    return;
  }
  try {
    const result = await controller.requestPriority(inputId);
    // 打断了当前轮就不再回话：那一轮的终态行会说同一件事（与 /stop 同理）。
    // 没在跑的时候只改了顺序，这时必须说一句，否则用户看不到任何反馈。
    if (!(result && result.interrupted === true)) reply('已提到队首', { tone: 'success' });
  } catch (error) {
    reply('提升失败', { tone: 'error', detail: fact(error) });
  }
}

// /cancel：撤回队首排队输入（规格 2026-10-07 D7）。与 /now 对称——那边把队首提上来跑，
// 这边把队首拿掉不跑。运行中可用（撤回本来就是排队场景的动作）；队列空与 /now 同句。
// 屏幕反馈零新增：撤回事件的「排队已取消」终态行与实时区整表替换由事件桥负责。
async function runCancelCommand(_args, ctx) {
  const { reply, getController } = ctx;
  const controller = getController();
  if (typeof controller.withdrawQueued !== 'function') {
    reply('暂不支持撤回。', { tone: 'warn' });
    return;
  }
  try {
    const withdrawn = await controller.withdrawQueued();
    if (withdrawn === null) {
      reply('队列为空');
      return;
    }
    reply('已撤回', { tone: 'success', detail: clipOneLine(withdrawn.text) });
  } catch (error) {
    reply('撤回失败', { tone: 'error', detail: fact(error) });
  }
}

// /retry：把最近一次失败（或非用户停止的中断）的轮次用原输入重跑。
//
// 原文在这里回显成用户行：/retry 不是那条输入本身，readline 没有回显它的机会，
// 不补这一行屏幕上就只剩输出凭空开始，看不出是同一件事的继续。
// 成功起跑后不再多话：思考中/终态行自己会接上（铁律 3：成功不弹 Toast）。
// 失败/中断的终态行不加「可 /retry」提示（铁律 2：状态只在当前轮；发现靠 / 菜单）。
async function runRetryCommand(_args, ctx) {
  const { reply, renderer, getController } = ctx;
  const controller = getController();
  if (controller.isBusy()) {
    reply('运行中', { tone: 'warn', detail: '等这一轮结束再重试。' });
    return;
  }
  const snapshot = controller.snapshot();
  if (Array.isArray(snapshot.queue) && snapshot.queue.length > 0) {
    reply('队列里还有输入', { tone: 'warn', detail: '先让它们跑完再重试。' });
    return;
  }
  let retryable = null;
  try {
    // 有界读（规格 2026-10-06 D5）：判定只看最近一轮——窗口内见到 run_started 即是
    // 完整的最后一轮（日志按 seq 追加，窗口是后缀，见到任何 run_started 必含最新的那个）。
    // 窗口截到轮中途才回退全量读；读不出 ≠ 没有：读日志失败必须如实说读失败，
    // 绝不冒充「没有可重试的失败轮次。」（铁律 3 同源：检测失败不代表检测通过，也不代表检测结果为否）。
    // 窗口大小（256KiB）是 event-store readTail 的默认值（TAIL_CHUNK_BYTES），这里无参透传——
    // 存储调优常量只住在 event-store，不进命令层。
    const tail = await controller.readTailEvents();
    const lastTurnComplete = tail.events.some((event) => event.type === 'run_started');
    retryable = lastTurnComplete
      ? findRetryableTurn(tail.events)
      : findRetryableTurn(await controller.readEvents());
  } catch (error) {
    reply('无法重试', { tone: 'error', detail: fact(error) });
    return;
  }
  if (retryable === null) {
    reply('没有可重试的失败轮次。');
    return;
  }
  renderer.printUser(retryable.text);
  try {
    await controller.retry(retryable);
  } catch (error) {
    reply('重试失败', { tone: 'error', detail: fact(error) });
  }
}
