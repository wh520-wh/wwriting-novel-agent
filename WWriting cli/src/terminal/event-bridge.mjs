// —— 事件桥 ——
//
// Agent 循环不提供渲染回调，实时过程只落进事件日志（Task 6 的 D16）。
// 这里做最小适配：把「事件」翻成屏幕 writer（renderer.mjs）的渲染调用，并提供一个包装器，
// 让装配会话管理器时把事件存储套一层，落盘成功的事件同时流向渲染器。
// 不改任何上游模块。
//
// createEventRenderer({ renderer, label, onDecision })
//   onDecision(decision) 可选，普通确认（非 extreme）到达时的**交互入口**。谁把它接上，谁就负责
//   把终端让给方向键选择器并把结果交回控制器——但它属于组合根（要 suspend/resume 常驻 readline、
//   要摸 io.stdin/stdout），所以这一层只转交事件，绝不认识选择器。
//   缺省 null = 当前终端给不出选择器：卡片退回「按文字答」的提示，既有路径一个字节不变。
// 事件桥对渲染器的**契约**。装配点一次性校验——缺能力在装配时炸出来并列出缺什么，
// 绝不在事件到达时静默跳过（那会让 §4.2 的常驻面板无声消失，还没人知道为什么）。
// 测试替身确实是残缺渲染器时，显式传 { partial: true } 声明「我知道我在干什么」。
import {
  activityLabel, formatCacheHit, formatDuration, formatThinkingSeconds, formatUsage, joinNotes,
  terminalStatusText,
} from './style.mjs';
// 事件里读出的事实（终态形态、耗时口径）与历史投影共用同一份定义，见 src/agent/event-facts.mjs 的说明。
import { eventMillis, reasoningDurationMs, terminalOfEvent } from '../agent/event-facts.mjs';
// 工具结果摘要与 agent 历史投影共用同一份实现（见 src/tools/tool-summary.mjs 的说明）。
import { summarizeToolResult } from '../tools/tool-summary.mjs';

const RENDERER_CONTRACT = Object.freeze([
  'printUser', 'printAssistant', 'printStatus', 'printActivity', 'setLiveQueue',
  'printDecision', 'printPlan', 'setLivePlan', 'resetThinkingPreview',
]);

export function createEventRenderer({ renderer, label = activityLabel, onDecision = null, partial = false } = {}) {
  if (!renderer) throw new Error('事件桥需要可用的渲染器。');
  if (partial !== true) {
    const missing = RENDERER_CONTRACT.filter((name) => typeof renderer[name] !== 'function');
    if (missing.length > 0) {
      throw new Error(`事件桥的渲染器缺少能力：${missing.join('、')}。残缺替身请显式传 { partial: true }。`);
    }
  }
  // 有交互入口 = 会用选择器。卡片据此少印一行提示（选项由选择器自己显示）。
  const pickerMode = typeof onDecision === 'function';
  // 排过队、还没开跑的输入：input_id → 原文（Map 插入序 = FIFO 序）。
  // 它是实时区排队清单的**唯一持有者**：每次变更整表同步给渲染器
  // （setLiveQueue），开跑/撤回后整表里没有它，实时区那一行自然消失。
  const queuedInputs = new Map();
  // 最近一份计划（plan_updated 的整表）：Run 结束时用它把实时区收成 chip 保留供回看（§4.2）。
  let lastPlan = null;
  // 工具耗时使用事件时间戳，不依赖刷新时刻。
  let activityStartedAt = null;
  // /reasoning 只重放本进程已完成轮次；全文仍存于事件日志。
  let currentRunReasoning = [];
  let lastRunReasoning = null;
  // 是否有一轮正在跑。run_started 置真、三条终态事件（run_completed / interrupted / failed）归假。
  // 它只服务 lastReasoning：**正在跑的那一轮不算「上一轮」**——见 run_started 处的注释，
  // 那是本函数的契约，之前只有注释没有代码兑现它。
  let runInFlight = false;

  // 会话边界（/resume 切换）由组合根调用：清掉绑定在**上一个会话**上的桥内状态。
  // 否则旧会话的终态事件（比如停止旧轮的 run_interrupted）会把旧计划重新挂进
  // 新会话的实时区——规格 §4.2 注记原文：「残留上一会话计划即缺陷」。
  function resetSessionState() {
    queuedInputs.clear();
    renderer.setLiveQueue([]);
    lastPlan = null;
    currentRunReasoning = [];
    lastRunReasoning = null;
    runInFlight = false;
    activityStartedAt = null;
  }

  // 排队清单 → 实时区（整表替换）。桥是清单的唯一持有者，渲染器只管画。
  function syncLiveQueue() {
    renderer.setLiveQueue([...queuedInputs.entries()].map(([input_id, text]) => ({ input_id, text })));
  }

  function handleEvent(event) {
    if (!event || typeof event.type !== 'string') return;
    const data = event.data ?? {};
    switch (event.type) {
      case 'run_started': {
        // 排队输入开跑时补上用户行（input_started 已补过时不会重复）。
        // 实时区那一行同步消失：整表里已经没有它，滚动历史里只留这一条用户行。
        const queuedText = typeof data.input_id === 'string' ? queuedInputs.get(data.input_id) : null;
        if (typeof queuedText === 'string') {
          queuedInputs.delete(data.input_id);
          renderer.printUser(queuedText);
          syncLiveQueue();
        }
        // 新一轮开始：上一轮的思考到此为止，成为 /reasoning 的重放对象。
        // 正在跑的这一轮不算「上一轮」——它还没结束，重放半截思考会误导人。
        // lastReasoning() 用 runInFlight 兑现这条契约：在跑时只认 lastRunReasoning。
        lastRunReasoning = currentRunReasoning.length > 0 ? currentRunReasoning : null;
        currentRunReasoning = [];
        runInFlight = true;
        // 思考预览另起一段：上一轮被打断时留下的半段（还挂在 thinkingPreviewOn 上）
        // 绝不能接着算进这一轮，否则新用户的思考会从旧思考的尾巴后面长出来。
        renderer.resetThinkingPreview();
        // 新 Run 清空上一轮计划（口径 A）：事件投影已清，实时区的面板同步收起；
        // Markdown 的块状态（半截围栏/表格候选）也一并作废——它们属于上一轮。
        lastPlan = null;
        renderer.setLivePlan(null);
        renderer.resetMarkdown();
        renderer.printStatus('思考中');
        break;
      }
      case 'input_started': {
        // 队列里的一条输入真正开跑：实时区的排队行由整表替换自然消失，
        // 滚动历史补一条用户行——这一刻起它的输出有主了，屏幕上不再留「排队」的残影。
        const startedText = typeof data.input_id === 'string' && typeof data.text === 'string'
          ? data.text
          : (typeof data.input_id === 'string' ? queuedInputs.get(data.input_id) : null);
        if (typeof data.input_id === 'string') queuedInputs.delete(data.input_id);
        if (typeof startedText === 'string' && startedText !== '') renderer.printUser(startedText);
        syncLiveQueue();
        break;
      }
      case 'history_applied': {
        // 只有实际省略前情（或带会话摘要）时才说明，正常载入不增加噪音。
        const kept = Number.isFinite(data.kept_turns) ? data.kept_turns : 0;
        const dropped = Number.isFinite(data.truncated_turns) ? data.truncated_turns : 0;
        const covered = Number.isFinite(data.covered_turns) ? data.covered_turns : 0;
        const digestChars = Number.isFinite(data.digest_chars) ? data.digest_chars : 0;
        // 诚实计数（规格 2026-10-06 D4）：有界读窗口被字节上限截断时，省略数只知下界 →
        // 「N+ 轮」；旧摘要事件没有 covered_total → 覆盖数不可知 → 只说覆盖了、不报数。
        const droppedExact = data.truncated_exact !== false;
        const coveredExact = data.covered_exact !== false;
        if (dropped > 0 || digestChars > 0) {
          // final: true —— 这是落进 scrollback 的一条事实，不是会被重绘抹掉的动态行。
          // 动态行只属于「此刻正在发生的事」，而「这一轮记得多少」是已经确定的结果。
          renderer.printStatus('已载入前情', {
            final: true,
            tone: 'info',
            detail: joinNotes([
              kept > 0 ? `${kept} 轮` : null,
              covered > 0 ? `摘要覆盖 ${covered} 轮` : (digestChars > 0 && !coveredExact ? '摘要覆盖更早前情' : null),
              dropped > 0 ? (droppedExact ? `省略更早 ${dropped} 轮` : `省略更早 ${dropped}+ 轮`) : null,
              digestChars > 0 ? `含会话摘要` : null,
            ]),
          });
        }
        break;
      }
      case 'memory_applied': {
        // 记忆只在读取失败或截断时提示，数字与原因放在 detail。
        if (data.state === 'unreadable') {
          // 主文案 5 字，事实进 detail（铁律 3）。final: true 是这条的全部意义（R2）：
          // 「这一轮模型没有记忆」是已经确定的结果，必须落进 scrollback，
          // 不能走会被下一次重绘抹掉的动态行。
          renderer.printStatus('记忆未载入', { final: true, tone: 'warn', detail: '本轮按无记忆继续' });
          break;
        }
        const omitted = Number.isFinite(data.omitted_chars) ? data.omitted_chars : 0;
        if (omitted > 0) {
          renderer.printStatus('已载入记忆', {
            final: true, tone: 'info', detail: `过长 · 已省略 ${omitted} 字符`,
          });
        }
        break;
      }
      case 'reasoning_completed': {
        // 一个模型轮次恰好一项思考（上游对话样式规格书:180）。
        // 耗时从**事件时间戳差**算（P20）：起点是 started_at（= 本轮模型请求发起时，R4），
        // 终点是这条事件自己的 at。算法与重演共用一份（agent/event-facts.mjs）——
        // 当场说 13 秒、重启后重演说 12 秒，就是两条算法了。
        const durationMs = reasoningDurationMs(data.started_at, event.at);
        // 预览到此为止：这一段的结论是下面那行 `思考 N 秒`，实时区里那份半截文本
        // 不该再跟着下一次模型请求一起长下去（一个 Run 可以有多个模型轮次）。
        renderer.resetThinkingPreview();
        // 终态行、压暗、不落动态行：它是已经确定的结果，不是「此刻正在发生的事」。
        renderer.printStatus(formatThinkingSeconds(durationMs), { final: true, tone: 'info' });
        currentRunReasoning.push({
          text: typeof data.text === 'string' ? data.text : '',
          durationMs,
        });
        break;
      }
      case 'model_delta':
        if (typeof data.text === 'string') renderer.printAssistant(data.text);
        break;
      case 'plan_updated':
        // update_plan 落的最新整表：滚动区留一份全表（回看），实时区挂最新一份面板。
        // **空表也是表**（整表替换语义）：模型显式清空计划时，实时区同步收起——
        // 把它当 no-op 静默吞掉，模型的「没有计划了」就成了撒谎。
        if (Array.isArray(data.items) && data.items.length > 0) renderer.printPlan(data.items);
        if (Array.isArray(data.items) && data.items.length > 0) {
          lastPlan = data.items;
          renderer.setLivePlan(data.items, { active: runInFlight });
        } else {
          lastPlan = null;
          renderer.setLivePlan(null);
        }
        break;
      case 'activity_started':
        activityStartedAt = eventMillis(event.at);
        renderer.printActivity({ state: 'running', label: label(data.tool, data.target) });
        break;
      case 'activity_finished': {
        const state = data.aborted === true ? 'stopped' : data.ok === true ? 'done' : 'failed';
        // 失败说清「为什么」，成功说清「得到了什么」（字数 / 行数 / 命中数）；
        // 慢到值得说的那一档再补上耗时。铁律 3：一条事实，就一条。
        const detail = state === 'failed'
          ? (data.message ?? null)
          : joinNotes([summarizeToolResult(data), formatDuration(eventMillis(event.at) - activityStartedAt)]);
        renderer.printActivity({ state, label: label(data.tool, data.target), detail });
        activityStartedAt = null;
        break;
      }
      case 'input_queued':
        if (typeof data.input_id === 'string' && typeof data.text === 'string') {
          queuedInputs.set(data.input_id, data.text);
        }
        syncLiveQueue();
        break;
      case 'input_withdrawn':
        // 撤回的排队输入永远不会开跑：实时区那一行随整表替换消失，
        // 用户行绝不会以后误补（它已不在清单里）。
        //
        // 但它必须**在屏幕上有个交代**：「排队已取消」终态行保留——那是已发生的交互事实，
        // 不是残影。若只是悄悄从清单删掉，用户以为它还在等，实际已经没了（无声丢数据）。
        if (typeof data.input_id === 'string') {
          if (queuedInputs.has(data.input_id)) {
            renderer.printStatus('排队已取消', { final: true, tone: 'warn', detail: '这条输入不会执行' });
          }
          queuedInputs.delete(data.input_id);
        }
        syncLiveQueue();
        break;
      case 'decision_pending': {
        // 确认提示承载状态，普通确认交给选择器；极端确认始终要求精确文字。
        renderer.printDecision(data, { picker: pickerMode });
        if (pickerMode && data.level !== 'extreme') {
          // 同步调用（Promise.resolve(fn()) 先执行 fn）：让选择器在本次 append 返回之前就接管终端。
          // 兜底 catch 只防「连 onDecision 自己都抛」这一层——绝不能让交互失败变成未处理拒绝（Node 会终止进程）。
          Promise.resolve(onDecision(data)).catch((error) => {
            renderer.printStatus('确认失败', { final: true, tone: 'warn', detail: error?.message ?? null });
          });
        }
        break;
      }
      case 'decision_resolved':
        // 答复之后紧接着就是工具结果或正文，不需要额外的实时状态行。
        break;
      case 'run_completed':
      case 'run_interrupted':
      case 'run_failed': {
        // 三条终态共用一份文案与色调（terminalStatusText）：屏幕重演要用**同一个函数**，
        // 否则重演出来的历史会比用户当时看到的更不准（R5）。
        //
        // 这一轮到此结束：/reasoning 从这一刻起把本轮思考当「上一轮」（runInFlight 归假）。
        runInFlight = false;
        // 事件形态 → 轮次形态的映射只有一处定义（agent/event-facts.mjs）：历史投影也调它。
        // 各写一份就会出现「新增一种终态原因，当场显示与重启重演各自解释」（R5）。
        const status = terminalStatusText(terminalOfEvent(event));
        // `未配置` 不是故障：引导页允许跳过 Key，用户就是想先进来写点东西。
        // 出路提示与那句主文案长在同一处（terminalStatusText 的 hint）——
        // 这里按键取用，绝不拿渲染出来的**文字**当控制流判据（改一个字那条分支就静默失效）。
        // 事件自己带的 message（只有 run_failed 有）比通用提示更具体，优先用它。
        // 铁律 3：错误只呈现一条事实。
        const detail = typeof data.message === 'string' && data.message !== ''
          ? data.message
          : (status.hint ?? null);
        renderer.printStatus(status.text, {
          final: true,
          tone: status.tone,
          note: joinNotes([formatUsage(data.usage), formatCacheHit(data.usage)]),
          detail,
        });
        // Run 结束保留计划（§4.2）：面板收成一行 chip，继续挂在实时区供回看；
        // 真正清空要等下一轮 run_started（口径 A）。
        renderer.setLivePlan(lastPlan, { active: false });
        break;
      }
      default:
        break;
    }
  }

  // 包装 Task 3 的 eventStoreFactory：落盘成功的事件转发给渲染器，其余能力原样透传。
  function wrapEventStoreFactory(eventStoreFactory) {
    if (typeof eventStoreFactory !== 'function') {
      throw new Error('事件桥需要 Task 3 的事件存储工厂。');
    }
    return (options) => {
      const store = eventStoreFactory(options);
      return {
        ...store,
        async append(partial) {
          const event = await store.append(partial);
          if (event) handleEvent(event);
          return event;
        },
        async appendBatch(partials) {
          const events = await store.appendBatch(partials);
          for (const event of events ?? []) handleEvent(event);
          return events;
        },
      };
    };
  }

  // /reasoning 的取值口。返回 null 表示「本次进程内没有可查看的思考」，
  // 命令层据此给出上游 empty 态那句原文，而不是自己编一句话。
  //
  // 契约：只给**已经跑完的上一轮**。正在跑的那一轮即使已经攒了半截思考也不算——
  // 它还会变，重放一个没成型的片段会误导人（与 run_started 处那条注释同一个契约）。
  // 跑完之后（runInFlight 归假）本轮才刚被当成「上一轮」，此时才可返回：
  // 「刚跑完就 /reasoning」是最常见的路径，那一刻 currentRunReasoning 还没被下一轮换掉。
  function lastReasoning() {
    if (runInFlight) return lastRunReasoning;
    // 上一轮没思考就答没有（缺陷猎捕报告 9）：回退到 lastRunReasoning 会把更早那一轮的
    // 思考重放出来——/effort none 或换到不回 reasoning_content 的端点之后，用户会把
    // 第一次跑的思考当成刚才那份回答的推理。回退成 null，命令层走 empty 态。
    return currentRunReasoning.length > 0 ? currentRunReasoning : null;
  }

  return { handleEvent, wrapEventStoreFactory, lastReasoning, resetSessionState };
}
