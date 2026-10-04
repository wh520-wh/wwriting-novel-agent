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
  DEFAULT_HISTORY_BUDGET_CHARS, buildDigestMessage, buildHistoryMessages, latestDigest, projectTurns,
} from './history.mjs';
import { runCompaction } from './compact.mjs';
import {
  PROJECT_MEMORY_BUDGET_CHARS, buildMemoryInjection, memoryHashFor, readProjectMemory,
} from './project-memory.mjs';
import { createFileTools } from '../tools/files.mjs';
import { createPermissionState } from '../tools/permissions.mjs';
import { updatePlan } from '../tools/plan.mjs';
import { ChapterToolError, createChapterService } from '../tools/chapters.mjs';
import { createMemoryService } from '../tools/memory.mjs';
import { styleStats } from '../tools/style-stats.mjs';
import { createSkillService } from '../skills/index.mjs';

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

// 默认工具工厂：文件工具之外并入 readSkill（read_skill 的实现）、updatePlan（任务计划）
// 与章节服务四件（commit/rollback/continuity/style_stats）。
// 权限口径：读与「只写应用私有存储」的操作自动放行（铁律 4「只读自动」；分类兜底在
// permissions.mjs 的 READ_TOOLS/WRITE_TOOLS——append_chapter_segment 与 rollback_chapter
// 会改写创作文件，走 write 级确认；未知工具收紧为极端，绝不默认放行）。
// 提交/入账/回滚成功结果附的固定提醒行（内容写死，不随状态变化）。上游 memory_checklist
// 的 CLI 两件化：book_summary.md / WORKLOG.md 不引入，其职能由 WWRITING.md 承担（偏差记录）。
const MEMORY_MAINTENANCE_REMINDER = '记忆维护：请依次 update_memory → 更新 WWRITING.md';

export function createDefaultToolsFactory(skillService, chapterService = null) {
  // 设定档案服务住在创作目录 memory/ 下（不依赖注入根），整厂共用一个实例。
  const memoryService = createMemoryService();
  return (options) => {
    const files = createFileTools(options);
    const tools = {
      ...files,
      readSkill: (args) => skillService.read({
        projectRoot: options.projectRoot,
        name: args?.name,
        resource: typeof args?.resource === 'string' && args.resource !== '' ? args.resource : 'SKILL.md',
      }),
      // update_plan 是纯函数工具：校验归一在这里，事件落盘（plan_updated）在循环里——
      // 工具不持有事件存储，循环按它的返回值发声（分层：tools 不 import agent）。
      updatePlan,
    };
    if (chapterService === null) return tools;

    // 提交：读当前内容（自动）→ 存版本 + 记前情（私有存储，自动）。
    // 文件不存在 / 读不出时 readFile 的中文事实原样抛出，模型能自己调整。
    tools.commitChapter = async (args) => {
      const { text } = await files.readFile({ path: args?.path });
      const committed = await chapterService.commit({
        projectRoot: options.projectRoot,
        path: args?.path,
        text,
        summary: typeof args?.summary === 'string' ? args.summary : null,
      });
      return { ...committed, memory_checklist: MEMORY_MAINTENANCE_REMINDER };
    };
    // 修订入账：读当前内容（自动）→ 存版本 + 记 revision（私有存储，自动）。
    // 文件不存在 / 读不出时 readFile 的中文事实原样抛出，模型能自己调整。
    tools.finalizeRevision = async (args) => {
      const { text } = await files.readFile({ path: args?.path });
      const finalized = await chapterService.finalizeRevision({
        projectRoot: options.projectRoot,
        path: args?.path,
        text,
        summary: typeof args?.summary === 'string' ? args.summary : null,
      });
      return { ...finalized, memory_checklist: MEMORY_MAINTENANCE_REMINDER };
    };
    // 回滚三段：读当前 → prepareRollback（存安全快照 + 取生效版本内容，私有）→ restoreFile
    // （创作目录写入，write 级确认，确认卡说的是「回滚章节」而不是「写入文件」）。
    // 顺序是刻意的：确认发生在写入前一个字节都不会动；确认拒绝只多一份私有快照，前情不受污染。
    tools.rollbackChapter = async (args) => {
      const target = await chapterService.prepareRollback({
        projectRoot: options.projectRoot,
        path: args?.path,
        currentText: (await files.readFile({ path: args?.path })).text,
      });
      if (target === null) {
        throw new ChapterToolError('这一章还没有提交过，没有可回滚的版本。', 'CHAPTER_NO_VERSION', {
          path: args?.path ?? null,
        });
      }
      const restored = await files.restoreFile({ path: args?.path, content: target.text });
      return { path: restored.path, restoredSeq: target.seq, charsNoSpace: restored.charsNoSpace, memory_checklist: MEMORY_MAINTENANCE_REMINDER };
    };
    tools.readContinuity = (args) => chapterService.readContinuity({
      projectRoot: options.projectRoot,
      budgetChars: args?.budgetChars,
    });
    // 更新设定：设定档案的唯一合法写通道（memory/ 对通用文件工具只读）。
    // 校验、合并、原子落盘都在服务里；这里只做参数转发。写级确认——确认卡说「更新设定」。
    tools.updateMemory = (args) => memoryService.update({
      projectRoot: options.projectRoot,
      path: args?.path,
      facts: Array.isArray(args?.facts) ? args.facts : [],
      timeline: Array.isArray(args?.timeline) ? args.timeline : [],
      characters: Array.isArray(args?.characters) ? args.characters : [],
    });
    tools.styleStats = async (args) => {
      const { text } = await files.readFile({ path: args?.path });
      return styleStats({ text });
    };
    return tools;
  };
}

export function createRunController({
  sessionManager,
  agentLoopFactory = (options) => createAgentLoop(options),
  projectRoot,
  sessionId = null,
  permissions = null,
  // 技能服务缺省用真实实现（内置根 = 仓库 src/skills）；测试注入临时根。
  skillService = createSkillService(),
  // 章节服务缺省用真实实现（应用私有区 = %APPDATA%/WWriting/...）；测试注入临时 appDataRoot。
  chapterService = createChapterService(),
  toolsFactory = null,
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
  const resolvedToolsFactory = toolsFactory ?? createDefaultToolsFactory(skillService, chapterService);
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
  //
  // 会话压缩（/compact）介入的唯一点：digest 覆盖的轮次（startSeq ≤ through_seq）不再进
  // messages，由摘要消息替代。摘要与剩余轮次合用同一个预算（historyBudget）——
  // 「记忆多少」的口径仍然是这一个数，不因压缩出现第二个预算。
  async function loadHistory(currentInputId) {
    try {
      const { events } = await session.eventStore.readAll();
      const turns = projectTurns(events);
      const digest = latestDigest(events);
      // 排除当前轮：run_started 在循环内部才追加，正常读不到本轮；但「立即」重跑同一条输入时
      // 日志里可能已有它自己的上一轮（或崩溃残留），那会把「这一轮说过的话」当成上下文喂回去。
      const withoutCurrent = turns.filter((turn) => !(typeof currentInputId === 'string' && turn.inputId === currentInputId));
      const prior = digest === null
        ? withoutCurrent
        : withoutCurrent.filter((turn) => Number.isFinite(turn.startSeq) && turn.startSeq > digest.throughSeq);
      const coveredTurns = withoutCurrent.length - prior.length;
      const built = buildHistoryMessages(prior, {
        budgetChars: historyBudget,
        digest: digest === null ? null : buildDigestMessage(digest.text),
      });
      return {
        history: built.messages,
        historyMeta: {
          keptTurns: built.keptTurns,
          truncatedTurns: built.truncatedTurns,
          chars: built.usedChars,
          digestChars: digest === null ? 0 : digest.text.length,
          coveredTurns,
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

  // 技能清单：每轮开跑时发现一次（与历史、记忆并发取）。只取 active 列表的
  // name/description/category 摘要喂给循环拼目录块；任何失败都降级成空数组——
  // 技能坏了最多是「这一轮没有技能可看」，绝不能拦住写作本身。
  async function loadSkillCatalog() {
    try {
      const { active } = await skillService.catalog({ projectRoot });
      return active;
    } catch {
      return [];
    }
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
  // retryOfRunId：/retry 时带上被接续那轮的 run id（只进 run_started 的 retry_of 字段，
  // 供日志与重演说明「这是同一件事的继续」；run_id 本身每轮新生成）。
  async function startRun(inputId, text, retryOfRunId = null) {
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
      // 技能清单同批并发取：每轮只发现一次（上游按 runId 缓存的同语义），失败返空数组
      // 不阻塞——技能坏了写作照常（ADR-0014）。
      const [{ history, historyMeta, notice: noticeResult }, { memory, memoryCached }, skillCatalog] =
        await Promise.all([loadHistory(inputId), loadMemory(), loadSkillCatalog()]);
      const loop = agentLoopFactory({
        modelClient,
        toolsFactory: resolvedToolsFactory,
        skillCatalog,
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
        retryOfRunId,
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
        retryOfRunId,
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
  async function drain(inputId, text, retryOfRunId = null) {
    draining = true;
    stopped = false;
    let result = null;
    let firstError = null;
    const attempted = new Set();
    if (typeof inputId === 'string') attempted.add(inputId);

    // 跑一条：抛错就退役它、记下错误、返回 null 让循环继续下一条。
    async function attempt(id, body, retryOf = null) {
      try {
        return await startRun(id, body, retryOf);
      } catch (error) {
        if (firstError === null) firstError = error;
        return null; // startRun 内部已把这条输入从队列退役，这里只负责继续推进。
      }
    }

    try {
      result = await attempt(inputId, text, retryOfRunId);
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

  // 重试（/retry）：用原输入的 input_id 与原文重跑最近失败（或非用户停止中断）的那一轮。
  //
  // 判定不在控制器：可重试轮的寻找是纯函数（history.mjs 的 findRetryableTurn），
  // 命令层先判、先回显原文，再把 { inputId, text, runId } 交到这里执行。
  // 控制器只把「能不能安全起跑」再拦一遍：忙碌、还有排队输入、参数残缺都拒绝——
  // 排队非空时重试会像普通输入一样排到队尾去，那不是用户想说的「重试刚才那次」。
  //
  // input_id 复用是刻意的：loadHistory 的「排除当前输入」因此把失败尝试整体排除出上下文；
  // run_id 不复用（思考重放按 run_id 归堆），原 id 记进 run_started 的 retry_of（规格偏差已记录）。
  async function retry({ inputId, text, runId: retryOfRunId = null } = {}) {
    const handle = requireOpen('重试上一轮');
    if (typeof inputId !== 'string' || inputId === '' || typeof text !== 'string' || text === '') {
      throw new Error('重试需要原输入的 ID 与原文。');
    }
    if (isBusy()) throw new Error('正在运行，等这一轮结束再重试。');
    if (handle.projection.queue.length > 0) {
      throw new Error('队列里还有输入，先让它们跑完再重试。');
    }
    const plan = await serializeWrite(async () => {
      if (draining) throw new Error('正在运行，等这一轮结束再重试。');
      stopped = false;
      const submitted = await handle.submit({ text, inputId });
      if (submitted.queued) {
        throw new Error('队列里还有输入，先让它们跑完再重试。');
      }
      draining = true;
      return { inputId, text };
    });
    // 复用原 input_id 重跑同一件事；失败尝试的历史天然不进这一轮的上下文。
    const running = drain(plan.inputId, plan.text, retryOfRunId);
    drainTask = running;
    try {
      return { inputId: plan.inputId, queued: false, result: await running };
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

  // 「立即」提交（Ctrl+S）：草稿本身成为下一条活动输入。与 requestPriority（/now）共用
  // 提升 + 打断 + 单一 drain 的原语，区别只在入口——/now 提升队首已有输入，这里提交
  // 刚打好的草稿。细分（规格 2026-10-05，对抗审查收口后）：
  //   · 忙碌（活动轮或 drain 在跑，含轮间隙）：入队 + 提到队首 + 打断当前轮（有活动轮时），
  //     同一个 drain 接手；
  //   · 空闲但队列非空（/stop 后残留）：入队 + 提到队首 + **补启动消费**——按「与回车相同」
  //     处理会排到队尾，违背「立即」承诺；
  //   · 空闲且队列空：与 submit 完全同一条路。
  // 硬要求：入队（input_queued）与提升（input_promoted）必须同一写入任务——单独写
  // promoted 对投影是空操作、对原语是抛错，草稿会无声丢失；abort 紧随提升之后，
  // 中间不得插入可被自然完成穿插的等待。错误由调用方整体 catch 收敛成一条中文事实。
  async function submitNow({ text } = {}) {
    const handle = requireOpen('立即提交输入');
    if (typeof text !== 'string' || text.trim() === '') {
      throw new Error('输入内容不能为空。');
    }
    if (!isBusy() && handle.projection.queue.length === 0) {
      return submit({ text });
    }
    const inputId = await serializeWrite(async () => {
      stopped = false;
      const queued = await handle.enqueue({ text });
      const promoted = await handle.promote(queued.input_id);
      return promoted.input_id;
    });
    if (active) {
      // 打断是为了跑被提升的输入，不是停止：drain 会继续跑队首（与 requestPriority 同语义）。
      if (typeof perm.clearInput === 'function') perm.clearInput();
      active.controller.abort();
      return { inputId, queued: true, promoted: true, interrupted: true, result: null };
    }
    if (draining) {
      // drain 间隙（上一轮已终、循环还活着）：下一轮迭代自然消费队首，不并起第二个 drain。
      return { inputId, queued: true, promoted: true, interrupted: false, result: null };
    }
    // 空闲且 drain 已停：提升后无人接手，这里补启动——先跑这一条，再按 FIFO 消化残留队列。
    const next = session.projection.queue[0];
    const running = drain(next.input_id, next.text);
    drainTask = running;
    try {
      return { inputId, queued: true, promoted: true, interrupted: false, result: await running };
    } finally {
      if (drainTask === running) drainTask = null;
    }
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

  // 会话压缩（/compact）：把已往对话收敛成一份摘要事件，之后的每轮以
  // 「[会话摘要] + 未覆盖轮次」开工（见 loadHistory）。
  //
  // 三条边界（比实现重要）：
  //   ① 只在**空闲**时可压缩：忙碌时抛错——压缩读的是「当时的事实」，
  //      与在跑的轮并发会产生「摘要缺了正在说的这一轮」的假账。
  //   ② 压缩看的是**全部**未覆盖轮次（含超出预算会被丢的那些）：预算在这里不设限，
  //      这正是压缩存在的意义——丢掉的轮子在丢之前被收进摘要。
  //   ③ 只做**手动**压缩：自动压缩牵扯安全点与触发时机，CLI 先不背这份复杂度
  //      （与上游的差异已记录在案：不必事事对齐）。摘要只经 digest_compacted
  //      一条事件进日志，绝不伪装成对话轮次。
  async function compact() {
    const handle = requireOpen('压缩会话');
    if (isBusy()) throw new Error('正在运行，等这一轮结束再压缩。');
    const { events } = await handle.eventStore.readAll();
    const turns = projectTurns(events);
    const digest = latestDigest(events);
    const uncovered = digest === null
      ? turns
      : turns.filter((turn) => Number.isFinite(turn.startSeq) && turn.startSeq > digest.throughSeq);
    if (uncovered.length === 0) return { status: 'empty' };
    // 已有摘要作为对话的第一条一起送压：新摘要吸收旧摘要，层层滚动向前。
    const transcript = buildHistoryMessages(uncovered, {
      budgetChars: Number.MAX_SAFE_INTEGER,
      digest: digest === null ? null : buildDigestMessage(digest.text),
    }).messages;
    const text = await runCompaction({ modelClient, messages: transcript });
    const throughSeq = handle.projection.last_seq;
    await serializeWrite(() => handle.append({
      type: 'digest_compacted',
      data: { digest: text, through_seq: throughSeq, chars: text.length, covered_turns: uncovered.length },
    }));
    return { status: 'ok', chars: text.length, turns: uncovered.length };
  }

  return { open, submit, submitNow, retry, stop, requestPriority, decide, snapshot, isBusy, activeRunId, readEvents, compact, close, permissions: perm };
}
