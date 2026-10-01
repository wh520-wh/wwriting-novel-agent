// 运行控制器：把「会话 + 队列 + Agent 循环 + 权限」串成一个能跑的单 Agent。
//
// 职责边界：
//   - 会话写锁由控制器持有（open 即取锁，close 才释放）；所有提交、停止、立即、确认都在这个锁内完成；
//     同一会话的第二个写入进程只能拿到 SESSION_BUSY，只读 snapshot 仍可用（Task 3 已保证）。
//   - 单 Agent 不变量：同一时刻只有一个 run 在跑。运行中的输入进 FIFO 队列，
//     「立即」只打断当前轮并提升输入，由同一个 drain 循环接着跑，绝不启动第二个 Agent。
//   - 停止 / 输入切换一律清掉临时授权：等待确认的 await 不受 signal 约束，
//     不清就会永久挂起（控制器裁决的硬要求，不是可选优化）。
import { randomUUID } from 'node:crypto';

import { createAgentLoop } from './agent-loop.mjs';
import {
  DEFAULT_HISTORY_BUDGET_CHARS, buildHistoryMessages, projectTurns,
} from './history.mjs';
import {
  PROJECT_MEMORY_BUDGET_CHARS, buildMemoryInjection, memoryHashFor, readProjectMemory,
} from './project-memory.mjs';
import { createFileTools } from '../tools/files.mjs';
import { createPermissionState } from '../tools/permissions.mjs';

// createRunController({ sessionManager, agentLoopFactory, projectRoot, sessionId, permissions, toolsFactory, modelClient, clock, idFactory, historyBudgetChars, onNotice, onReasoningPreview })
//   sessionManager   Task 3 的 createSessionManager（open 时取会话写锁）；
//   agentLoopFactory (options) => createAgentLoop(options)，缺省直接用真实循环；
//   toolsFactory     缺省 createFileTools：循环会用「带事件的权限桥」注入真实权限状态（写入门控硬要求）。
//   onNotice(message, { inputId }) 可选：把「历史未能载入」这类降级事实送到用户可见的地方。
//                控制器不持有渲染器（终端层概念不许上行到这里），所以只做回调；
//                不传就只是「本轮静默地少了一段上下文」，功能不受影响。
//   onReasoningPreview(delta) 可选：思考正文的增量，只用于屏幕上的实时预览。
//                同样是回调而不是渲染器引用，理由与 onNotice 一样；它**不落盘**，
//                日志里仍然只有轮末那一条 reasoning_completed（P18）。
// 返回 { open, submit, stop, requestPriority, decide, snapshot, readEvents, close, permissions }。
export function createRunController({
  sessionManager,
  agentLoopFactory = (options) => createAgentLoop(options),
  projectRoot,
  sessionId = null,
  permissions = null,
  toolsFactory = (options) => createFileTools(options),
  modelClient = null,
  clock = Date.now,
  idFactory = randomUUID,
  historyBudgetChars = DEFAULT_HISTORY_BUDGET_CHARS,
  memoryBudgetChars = PROJECT_MEMORY_BUDGET_CHARS,
  readMemory = readProjectMemory,
  onNotice = null,
  onReasoningPreview = null,
} = {}) {
  if (!sessionManager || typeof sessionManager.openLatest !== 'function') {
    throw new Error('运行控制器需要可用的会话管理器。');
  }
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
    throw new Error('运行控制器需要创作目录，请用 --cwd 指定。');
  }
  const perm = permissions ?? createPermissionState({ clock, idFactory });
  // 非法预算退回默认（与 history.mjs 同一口径）：截断规则只有一处，这里只是转发。
  const historyBudget = Number.isFinite(historyBudgetChars) && historyBudgetChars > 0
    ? Math.floor(historyBudgetChars)
    : DEFAULT_HISTORY_BUDGET_CHARS;
  const notice = typeof onNotice === 'function' ? onNotice : null;

  // ADR-0006 的哈希短路缓存：只记「上一轮注入的是哪一份内容、注入的是什么」。
  // 判据是**内容哈希**，不是事件——不存在「刚 /init 过所以刷新」这种触发。
  // 缓存挂在控制器上，因此 /resume 换掉控制器（cli.mjs 的 switchSession）会重置它，
  // 代价是新控制器的第一轮多付一次前缀失效。这是可接受的：换会话本来就该失效。
  const memoryBudget = Number.isFinite(memoryBudgetChars) && memoryBudgetChars > 0
    ? Math.floor(memoryBudgetChars) : PROJECT_MEMORY_BUDGET_CHARS;
  // 哈希相同 → 复用**上一条那个对象**，不是「内容相同的另一条」。
  // 字节级一致是 ADR-0006 的原话，也是 DeepSeek 前缀缓存命中的前提。
  // 缓存里存的是**整份注入结果**（不只 message）：命中时连 state / omittedChars 也照旧复用，
  // 而它们由「原文 + 预算」决定，原文没变就没有变的那一天。
  let lastMemory = null; // { hash, built }

  let session = null;
  let active = null; // 当前轮：{ inputId, controller }
  let draining = false; // 有 drain 在跑（或已排定）：此时新输入一律进队，绝不并发开第二轮
  let stopped = false; // 用户停止：不再自动开跑队列
  // 正在跑的 drain（若有）。close() 必须等它落地之后才能释放会话锁：
  // drain 不在 writeTail 尾链上，被取消的轮仍会在锁释放后继续 emitNow('run_interrupted') → append，
  // 而追加发生在锁外，就会违反「同一会话同一时刻只允许一个写入者」。
  let drainTask = null;
  // 会话日志是单写者资源：并发 append 会抢同一个 state.json.tmp（Windows 实测 EPERM / ENOENT），
  // 而且会让内存投影的 seq 与真相源错位。提交动作与本轮循环的落盘共用一条尾链保证串行。
  // 排在保证的同时还有第二个作用：「第一条已 append、drain 尚未起」这段窗口里的后来者
  // 会看到 draining 已被占位，于是走去排队的分支，而不是自己再开一条 drain。
  let writeTail = Promise.resolve();
  function serializeWrite(task) {
    const run = writeTail.then(task, task);
    writeTail = run.then(() => {}, () => {});
    return run;
  }

  // 交给 Agent 循环的事件存储：写入同样走这条尾链，因此与排队/提交的追加不会撞车。
  function serializedEventStore(store) {
    return {
      ...store,
      append: (partial) => serializeWrite(() => store.append(partial)),
      appendBatch: (partials) => serializeWrite(() => store.appendBatch(partials)),
    };
  }

  function requireOpen(action) {
    if (!session) throw new Error(`执行${action}前需要先打开会话。`);
    return session;
  }

  // 打开会话即取写锁：openLatest 无历史时创建，否则继续最近会话。
  async function open() {
    if (session) return session;
    session = sessionId === null || sessionId === ''
      ? await sessionManager.openLatest(projectRoot)
      : await sessionManager.openById(projectRoot, sessionId);
    return session;
  }

  // 关闭会话：先收敛正在跑的轮，等它真正落地后再释放写锁。
  // 目的：被取消的轮的最后一次 append（run_interrupted）必须在锁内写完，否则锁一旦释放，
  // 另一个进程就能抢到同一会话、与这条仍在进行的 append 争 events.jsonl / state.json.tmp。
  // stop() 的语义不变（只停当前轮、不注销会话）：这里先补一次停止，避免 close 永远等一个没有被取消的
  // 模型请求（/quit 与 /resume 本就在 close 前调过 stop，这里是幂等的兜底）。
  async function close() {
    if (!session) return false;
    const handle = session;
    stop();
    // 先摘掉 session：drain 的 while 循环据此收敛、不再消费队列（队列留在投影里，交给下次打开恢复）。
    session = null;
    const running = drainTask;
    if (running !== null) {
      try {
        await running;
      } catch {
        // 轮内错误由 submit 的调用方处理；关闭路径不把错误抖给用户。
      }
    }
    await writeTail; // 兜底排空尾链上的写入（drain 自身不在尾链上，但它的 append 都在）。
    await handle.close();
    return true;
  }

  // 装配本轮的会话历史：读日志 → 投影成轮次 → 按预算截断 → 扁平 messages。
  //
  // 读的是**原始** session.eventStore，不是 serializedEventStore(...) 那个包装：包装是为了把
  // 写入串到一条尾链上（避免抢同一个 state.json.tmp），读不走尾链——用包装版反而会排在
  // 「正在跑的轮」的写之后互相等待。readAll 是纯只读，与写入并发是安全的。
  //
  // 失败一律降级为无历史并返回一条中文事实（日志损坏、I/O 错误）：失忆好过开不了工。
  // 回放历史这件事不值得让整轮失败——这与 history.mjs 忽略孤立事件是同一个判断。
  async function loadHistory(currentInputId) {
    try {
      const { events } = await session.eventStore.readAll();
      const turns = projectTurns(events);
      // 排除当前轮：run_started 在循环内部才追加，正常读不到本轮；但「立即」重跑同一条输入时
      // 日志里可能已有它自己的上一轮（或崩溃残留），那会把「这一轮说过的话」当成上下文喂回去。
      const prior = turns.filter((turn) => !(typeof currentInputId === 'string' && turn.inputId === currentInputId));
      const built = buildHistoryMessages(prior, { budgetChars: historyBudget });
      return {
        history: built.messages,
        historyMeta: {
          keptTurns: built.keptTurns,
          truncatedTurns: built.truncatedTurns,
          chars: built.usedChars,
        },
        notice: null,
      };
    } catch (error) {
      return { history: [], historyMeta: null, notice: '历史未能载入 · 从本轮上下文开始' };
    }
  }

  // 装配本轮的项目记忆：读文件 → 按内容哈希决定复用还是重建 → 交给循环注入。
  //
  // 与 loadHistory 同构的降级策略：**任何失败都收敛成「无记忆」，本轮照常跑**（D3 的选项 a）。
  // 失忆好过开不了工，读记忆这件事不值得让整轮失败。
  //
  // 但降级事实的**承载面与历史不同**（R2）：历史走 onNotice（那是一条没有 final 的动态行），
  // 记忆走 memory_applied 事件 → 渲染器的终态行。理由是这条事实必须落进 scrollback——
  // 「这一轮模型没有记忆」是已经确定的结果，不是「此刻正在发生的事」，
  // 被下一次重绘抹掉等于没说过。因此本函数**不返回 notice**，一个承载面就够。
  //
  // 三态必须分清（D4③）：
  //   missing    是常态 —— 注入一条字节恒定的短提示，不是错误，屏幕上不占行；
  //   unreadable 是异常 —— 不注入（message 为 null），但**仍然返回对象**，
  //              好让循环发一条 state:'unreadable' 的事件，渲染器据此说出降级事实；
  //   present    正常注入，超限时截断并把省略量如实报出去（铁律 6：这个数字不能只有模型知道）。
  async function loadMemory() {
    let read;
    try {
      read = await readMemory(projectRoot);
    } catch {
      // readMemory 是注入点，假实现或将来换实现都可能抛。收敛成同一态，
      // 绝不把原始异常抖给用户（铁律 3）。
      read = { state: 'unreadable', content: '', errorCode: 'READ_FAILED' };
    }
    // 先比哈希再构造（ADR-0006 的判据是内容，不是注入文本）：
    // 内容没变是绝大多数轮次的常态，而构造注入消息在超预算时要整份切行 + 逐行正则 + 拼回 8KB。
    // 缓存命中时连那一次构造都不必跑，直接复用上一条。
    const hash = memoryHashFor(read);
    if (lastMemory !== null && hash !== null && lastMemory.hash === hash) {
      // 复制**外层**对象（调用方拿到的是自己的一份，改它不会污染缓存）；
      // 内层的 message 对象是**刻意共享**的——字节级一致正是缓存命中的前提。
      return { memory: { ...lastMemory.built }, memoryCached: true };
    }
    const built = buildMemoryInjection({ state: read.state, content: read.content, budgetChars: memoryBudget });
    if (built.state === 'unreadable') {
      lastMemory = null;
      return { memory: built, memoryCached: false };
    }
    lastMemory = { hash: built.hash, built };
    return { memory: { ...built }, memoryCached: false };
  }

  // 把一条输入从队列里摘掉（按 input_id）。这是投影层正常路径之外的兜底：
  // 正常情况下 run_started 折叠时就会摘，但那一轮若没能把事件写下去，队列项会滞留成「僵尸头」，
  // 挡在所有后来的输入前面。摘除是幂等的（不在队列里就是空操作），也绝不执行任何东西。
  async function retireInput(inputId) {
    if (!session || typeof inputId !== 'string' || inputId === '') return;
    if (typeof session.withdraw !== 'function') return;
    try {
      const queued = session.projection.queue.some((item) => item.input_id === inputId);
      if (!queued) return;
      await serializeWrite(() => session.withdraw(inputId));
    } catch {
      // 摘不掉也不能让这一轮的错误被顶掉：真正要报的是原始失败。日志里还留着它的原文。
    }
  }

  // 兜底收敛一个「抛错的轮」在投影里留下的痕迹。
  //
  // 正常路径由 run_completed/interrupted/failed 三条终态之一清掉 active_run（clearActiveRun）。
  // 但轮若抛错，终态事件可能一条都没落盘 —— 投影于是永远停在 `active`、active_input_id 也留着。
  // 后果不是「显示不准」这么轻：busy 判据把 active_run_id 非空当忙碌，于是之后的每一条输入
  // 都只能排队。这里补一条 run_interrupted 把状态收敛掉（与重启恢复同一条判据、同一种事件）。
  // 只在实际有话可说（投影里确实有未闭合的 run）时才发，避免制造噪音事件。
  async function convergeActiveRun() {
    if (!session) return;
    const projection = session.projection;
    const runId = projection.active_run_id;
    if (typeof runId !== 'string' || runId === '') return;
    try {
      await serializeWrite(() => session.append({
        type: 'run_interrupted',
        run_id: runId,
        data: { reason: 'run_failed_without_terminal_event' },
      }));
      await serializeWrite(() => session.refresh());
    } catch {
      // 日志写不进去是这一轮失败的根因本身；收敛失败不该再抛一次覆盖它。
    }
  }

  // 起一轮：每轮一个 AbortController，工具由循环自己带权限桥构造。
  async function startRun(inputId, text) {
    const controller = new AbortController();
    active = { inputId, controller };
    try {
      // 开跑前先标记「轮到它了」（只对排队过的输入生效）：
      // 渲染层据此把 `排队` 行换成正常用户行，否则那两个字会一直挂在屏幕上。
      if (typeof session.markStarted === 'function') {
        await serializeWrite(() => session.markStarted(inputId));
      }
      // 历史必须在构造循环之前装配好（它是本轮的输入，不是循环的内部状态）。
      // 两者读的是**不同文件**（events.jsonl / WWRITING.md），彼此没有数据依赖，
      // 所以并发取，不必让用户干等两次磁盘往返。各自的降级策略互不影响。
      const [{ history, historyMeta, notice: noticeResult }, { memory, memoryCached }] = await Promise.all([
        loadHistory(inputId),
        loadMemory(),
      ]);
      const loop = agentLoopFactory({
        modelClient,
        toolsFactory,
        // 循环的落盘也走同一条尾链：一轮里会连续追加很多事件，
        // 与排队输入的 append 撞车就会抢同一个 state.json.tmp。
        eventStore: serializedEventStore(session.eventStore),
        permissions: perm,
        clock,
        idFactory,
        historyBudgetChars,
        sessionId: session.sessionId,
        projectRoot,
        inputId,
        text,
        signal: controller.signal,
        onReasoningPreview,
      });
      if (notice !== null && noticeResult !== null) notice(noticeResult, { inputId });
      return await loop.run({
        projectRoot,
        sessionId: session.sessionId,
        inputId,
        text,
        signal: controller.signal,
        history,
        historyMeta,
        memory,
        memoryCached,
      });
    } catch (error) {
      // 循环原则上只会 resolve 出终态，不会抛（终态事件已做成尽力送达）。
      // 万一还是抛了（构造循环失败、权限桥异常、未来改坏），这一轮就没有任何终态事件落盘：
      // 投影仍以为它在跑、队列里那一条也摘不掉。这里补两次兜底，缺一不可：
      //   ① 把输入从队列退役（否则它变成挡住后来者的僵尸头）；
      //   ② 收敛投影里未闭合的 run（否则 busy 判据让之后每条输入都只能排队）。
      // 顺序是先退役再收敛：收敛要发事件，退役要读队列，先读后写更贴合「队列是当时的事实」。
      await retireInput(inputId);
      await convergeActiveRun();
      throw error;
    } finally {
      active = null;
    }
  }

  // drain：跑完当前输入再按 FIFO 跑完队列；停止或队列空即收敛。
  //
  // **前向推进是这里唯一不可动摇的不变量**。队列项从投影里消失，靠的是 run_started 被折叠
  // （applyEvent 里把匹配 input_id 的那一项 splice 掉）。但下面三种情况下它不会消失：
  //   · 轮的落盘失败（磁盘满 / EPERM）导致 run_started 根本没进日志；
  //   · 轮在 run_started 之前就抛错；
  //   · 未来的某个事件类型不再按 input_id 摘队。
  // 一旦出现，队首会永远停在那儿，而外层会一次次重试同一条：队列只增不减、用户的输入永远轮不到。
  //
  // 两条防线缺一不可：
  //   ① 一条输入**最多跑一次**（attempted 集合）——杜绝把一次故障放大成无限重试；
  //   ② 一条输入抛错**不中断整条队列**——否则「队首坏了」会被当成「整队不跑了」，
  //      排在后面的用户输入会在下一次 submit 时被静默烧掉（比僵死更糟：那是无声的数据丢失）。
  async function drain(inputId, text) {
    draining = true;
    stopped = false;
    let result = null;
    let firstError = null;
    const attempted = new Set();
    if (typeof inputId === 'string') attempted.add(inputId);

    // 跑一条：抛错就退役它、记下错误、返回 null 让循环继续下一条。
    async function attempt(id, body) {
      try {
        return await startRun(id, body);
      } catch (error) {
        if (firstError === null) firstError = error;
        return null; // startRun 内部已把这条输入从队列退役，这里只负责继续推进。
      }
    }

    try {
      result = await attempt(inputId, text);
      // 会话被关闭（如 /quit）时同样收敛：队列交给下一次打开时的恢复逻辑处理。
      while (!stopped && session) {
        const next = session.projection.queue[0];
        if (!next) break;
        if (attempted.has(next.input_id)) {
          // 队首试过了却还留在队列里 —— 它卡住了（见上）。停在这里，绝不重复跑。
          break;
        }
        attempted.add(next.input_id);
        const outcome = await attempt(next.input_id, next.text);
        if (outcome !== null) result = outcome;
      }
    } finally {
      draining = false;
    }
    // 调用方等的是「它自己那一条」的终态。它成功就返回它的结果；
    // 它抛了错（result 仍为 null）才把错误交给调用方 —— 排在其后的输入失败不该顶掉这一点。
    if (result === null && firstError !== null) throw firstError;
    return result;
  }

  // 提交一条输入：空闲则立即开跑并接着 drain 队列，忙碌则按 FIFO 排队。
  // 停止只停当前轮：新输入一到就接着消费队列（含停在队列里的更早输入），
  // 否则停止后 projection 的 busy 判据（queue.length > 0）会让之后每条输入永远只能排队。
  async function submit({ text } = {}) {
    const handle = requireOpen('提交输入');
    // 提交动作本身也是一次事件写入，因此排在同一个尾链上（不另起一条 submit 链）：
    // 这一条链同时保证了「日志单写者」与「窗口里的后来者一定看到占位」两件事。
    // drain 不放在链上（否则排队输入要等整条队列跑完才返回）：改为在链内同步占位 `draining`。
    const plan = await serializeWrite(async () => {
      if (draining) {
        const queued = await handle.enqueue({ text });
        return { inputId: queued.input_id, queued: true, next: null };
      }
      stopped = false;
      const submitted = await handle.submit({ text });
      // 队列里还有更早的输入时从队首开始，保持 FIFO；否则跑这一条本身。
      const next = submitted.queued
        ? session.projection.queue[0]
        : { input_id: submitted.input_id, text };
      draining = true; // 占位在链内完成：drain 真正开始前，后来者就已看到它。
      return { inputId: submitted.input_id, queued: submitted.queued, next };
    });
    if (plan.next === null) return { inputId: plan.inputId, queued: plan.queued, result: null };
    // 登记正在跑的 drain：close() 要等它落地后才会释放写锁。
    const running = drain(plan.next.input_id, plan.next.text);
    drainTask = running;
    try {
      return { inputId: plan.inputId, queued: plan.queued, result: await running };
    } finally {
      if (drainTask === running) drainTask = null;
    }
  }

  // 停止：取消当前轮 + 清除临时授权，队列保留但不自动开跑（下一次 submit 或立即会接着消费）。
  function stop() {
    if (typeof perm.clearInput === 'function') perm.clearInput();
    if (!active) return { stopped: false, inputId: null };
    stopped = true;
    const { inputId, controller } = active;
    controller.abort();
    return { stopped: true, inputId };
  }

  // 立即：把排队中的输入提到队首，并打断当前轮；接下来由同一个 drain 接手，不启动第二个 Agent。
  async function requestPriority(inputId) {
    const handle = requireOpen('提升排队输入');
    // promote 也是一次会话日志写入（input_promoted）：必须和本轮循环的 append 共用同一条尾链，
    // 否则它会与循环的 appendBatch 抢同一个 state.json.tmp，在 Windows 上偶发 rename 失败。
    const promoted = await serializeWrite(() => handle.promote(inputId));
    if (active) {
      // 打断是为了跑被提升的输入，不是停止：drain 会继续跑队首。
      stopped = false;
      if (typeof perm.clearInput === 'function') perm.clearInput();
      active.controller.abort();
      return { inputId: promoted.input_id, promoted: true, interrupted: true };
    }
    // 没有正在跑的轮：提升只改顺序；同时解除停止，好让下一次提交能接着消费队列。
    stopped = false;
    return { inputId: promoted.input_id, promoted: true, interrupted: false };
  }

  // 确认：代收用户在确认卡上的选择（一次允许 / 本条输入允许同类操作 / 拒绝 / 极端确认文字）。
  async function decide(options = {}) {
    requireOpen('处理确认');
    if (typeof perm.decide !== 'function') throw new Error('当前没有待确认的操作。');
    return perm.decide(options);
  }

  // 只读快照：反映活跃轮、队列与会话状态。纯内存读取，同步返回（调用方 await 也无妨）。
  function snapshot() {
    requireOpen('查看会话状态');
    return structuredClone(session.projection);
  }

  // 「忙不忙」的**唯一口径**。忙碌 = drain 在跑（含轮与轮之间的间隙：下一条随时开跑）或
  // 当前有活跃轮。它比「投影里 active_run_id 非空」宽：占位（draining=true）先于 run_started
  // 落盘，收敛晚于 run_completed——拿投影自己猜的调用方会在这些窗口里得出相反的答案。
  // 未打开会话返回 false 而不是抛：这只读判断没有理由要求先开工。
  function isBusy() {
    return draining || active !== null;
  }

  // 投影里的活跃轮 ID（D14「有活动轮先停」用的口径：真在跑的那一轮，轮间隙不算）。
  // 未打开会话返回 null 而不是抛——想停一个不存在的轮本来就是空操作，不是错误。
  function activeRunId() {
    if (!session) return null;
    const runId = session.projection.active_run_id;
    return typeof runId === 'string' && runId !== '' ? runId : null;
  }

  // 只读取本会话的事件日志。**不取锁、不写盘、不走写入尾链**：
  // 与 loadHistory 读的是同一个 `session.eventStore`（不是 serializedEventStore 那个包装），
  // 因为 readAll 是纯只读，与写入并发是安全的；用包装版反而会排在「正在跑的轮」的写之后互相等待。
  //
  // 暴露它而不是暴露 session 本身：组合根要做的是「把日志重演到屏幕上」，
  // 它需要的是事件，不是会话句柄。给句柄就等于把写锁与投影一起交出去了。
  async function readEvents() {
    const handle = requireOpen('读取会话事件');
    const { events } = await handle.eventStore.readAll();
    return events;
  }

  return { open, submit, stop, requestPriority, decide, snapshot, isBusy, activeRunId, readEvents, close, permissions: perm };
}
