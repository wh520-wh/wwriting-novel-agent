#!/usr/bin/env node
// WWriting CLI 入口：本项目唯一的组合根。
// 依赖装配与生命周期（workspace store → session manager → model client → run controller
// → renderer / input / command handler）只在这里决定；各模块自己的逻辑一律调用，绝不复制。
//
// 三条必须接上的线（漏掉任何一条都会静默退化）：
//   1) 事件订阅：createEventRenderer().wrapEventStoreFactory() 包住会话管理器的 eventStoreFactory，
//      否则正文、活动行与终态都不渲染，而且不报错（D20）；
//   2) 行缓冲协作：createRenderer 的 composer 传 input.composer，否则 Run 进行中的动态行
//      会擦掉用户正在键入的内容（D19）；
//   3) 启动错误收敛：打开会话 / 模型请求 / 用户拒绝等故障各映射为「一条中文事实」。
import { pathToFileURL } from 'node:url';
import path from 'node:path';

import { ArgsError, USAGE_TEXT, parseArgs } from './cli/args.mjs';
import { fact } from './fact.mjs';
import { versionLine } from './version.mjs';
import { createWorkspaceStore, resolveAppDataRoot } from './storage/workspace-store.mjs';
import { loadInputHistory, recordInput } from './storage/input-history.mjs';
import { createSessionManager } from './session/session-manager.mjs';
import { createEventStore } from './session/event-store.mjs';
import { createRunController } from './agent/run-controller.mjs';
import { buildReplay } from './agent/replay.mjs';
import { DEFAULT_HISTORY_BUDGET_CHARS } from './agent/history.mjs';
import { readProjectMemory } from './agent/project-memory.mjs';
import { createSkillService } from './skills/index.mjs';
import { createChapterService } from './tools/chapters.mjs';
import { listRelativeFiles } from './tools/files.mjs';
import { createDeepSeekClient } from './model/deepseek-client.mjs';
import { loadModelConfig, maskApiKey, readModelState } from './model/config.mjs';
import { createEffortState } from './model/effort.mjs';
import { createRenderer } from './terminal/renderer.mjs';
import { createEventRenderer } from './terminal/event-bridge.mjs';
import { printReplay } from './terminal/replay.mjs';
import { buildExportMarkdown, writeExportFile } from './terminal/export.mjs';
import { createInputReader, isInteractiveTerminal, readOneLine } from './terminal/input.mjs';
// 让位持有计数：嵌套让位（向导期间来确认卡）只在最外层动终端，键不会被两个读取者同时消费。
import { createInputYielder } from './terminal/input-yield.mjs';
// 确认的作答语义（选项表 / 翻译 / 确认卡）只有一份：decisions.mjs（铁律 4 / 铁律 11）；
// /resume 挑选列表的行标签与 /sessions 共用 sessionRowLabel（住在 commands.mjs，
// 经 pickers.mjs 的 sessionPickerItems 消费）。
import { HELP_COMMANDS, createCommandHandler } from './terminal/commands.mjs';
import { createDecisionCard } from './terminal/decisions.mjs';
import { createMenuPicker, sessionPickerItems } from './terminal/pickers.mjs';
import { createSelector } from './terminal/select.mjs';
import { STEP_HINT, createOnboarding } from './terminal/onboarding.mjs';
// 权限模式常驻标签的文案与色调只有一份：style.mjs（工单 02；ADR-0020 的实时区 chip 已取代）。
import { MODE_TAG, MODE_TAG_TONE } from './terminal/style.mjs';

const EXIT_OK = 0;
// 启动 / 运行期故障：只呈现一条中文事实。
const EXIT_RUNTIME_ERROR = 1;
// 用法与参数错误：沿用 Task 1 的契约（既有测试钉死了 2，不得改动）。
const EXIT_ARGS_ERROR = 2;
// 没有可交互的终端：没有对话面可跑，也不该静默假装成功。
const EXIT_NOT_INTERACTIVE = 3;

// 启动形式 → 2–6 字状态行。
function startupLabel(parsed) {
  if (parsed.resume !== null) return '恢复会话';
  if (parsed.continueLatest) return '继续最近会话';
  return '开始新会话';
}

const NOT_INTERACTIVE_FACT = '需要在一个可交互的终端里运行，请在 Windows Terminal 或 PowerShell 中直接启动 wwriting。';

// 头部面板的两句固定文案：副标题说明这是什么，提示行说明第一屏能做什么。
// 长度纪律：提示行要在 80 列终端里放得下一行（≤76 显示列），断行拆词比短更难看。
const PANEL_SUBTITLE = '长篇写作智能体';
const PANEL_HINT = '直接输入开始写作 · /help · Ctrl+C 停止 · Shift+Tab 权限 · Ctrl+S 立即发送';

// 命令主入口。io 至少包含 { stdin, stdout, stderr, env, cwd }，注入后可在无 TTY 环境测试。
// 返回退出码数字；仅在真实进程入口处写入 process.exitCode。
export async function main(
  argv,
  io = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: process.cwd(),
  },
) {
  let parsed;
  try {
    parsed = parseArgs(argv, io.cwd);
  } catch (error) {
    if (error instanceof ArgsError) {
      io.stderr.write(`${error.message}\n`);
      return EXIT_ARGS_ERROR;
    }
    throw error;
  }

  if (parsed.help) {
    io.stdout.write(USAGE_TEXT);
    return EXIT_OK;
  }

  // --version：与 --help 同级，看完就走。不装配依赖、不建会话、不碰任何文件，
  // 所以启动器脚本可以在「更新之后、打开工具之前」用它读版本，而不产生任何副作用。
  if (parsed.version) {
    io.stdout.write(`${versionLine()}\n`);
    return EXIT_OK;
  }

  const projectRoot = parsed.cwd;

  // 能不能给出可交互的对话面：引导、头部面板、渲染器装配与非交互分支共用输入层的同一个判据，
  // 免得出现「引导以为能交互、输入层以为不能」的分歧。纯函数（只读 stdin/stdout/env），
  // 在组合根之前算一次，往下所有用点都是同一份。
  const interactive = isInteractiveTerminal({ stdin: io.stdin, stdout: io.stdout, env: io.env });

  // 工作区私有存储提前建（纯构造，无 I/O）：输入历史文件路径要靠它算。
  const workspaceStore = createWorkspaceStore({ appDataRoot: resolveAppDataRoot(io.env) });

  // 输入历史（规格 2026-10-07 T4/D11-D12）：每个创作目录一份，存在应用私有工作区里。
  // 启动加载播种（↑ 与 Ctrl+R 的数据源），提交入口记录；命令与正文都算输入。
  // 读不出按空历史降级，写失败静默——历史是增强，不值得让对话面为它分心。
  const inputHistoryFile = path.join(workspaceStore.directoryFor(projectRoot, 'workspace'), 'input-history.jsonl');
  const seedHistory = await loadInputHistory({ file: inputHistoryFile });
  let lastRecordedInput = null;
  async function recordInputHistory(text) {
    const recorded = await recordInput({ file: inputHistoryFile, text, previous: lastRecordedInput });
    if (recorded) lastRecordedInput = text;
  }

  // @文件引用的文件清单（规格 2026-10-07 T5/D16）：启动扫一遍，之后每次提交后刷新
  //（fire-and-forget）。失败降级空数组——菜单不开，打字照常，绝不打扰对话面。
  let fileSuggestions = [];
  async function refreshFileSuggestions() {
    try {
      fileSuggestions = await listRelativeFiles(projectRoot);
    } catch {
      fileSuggestions = [];
    }
  }
  void refreshFileSuggestions();

  // —— 组合根 ——
  // 输入读取器先建：渲染器要拿它暴露的 composer 钩子与 readline 的行缓冲协作。
  // onSubmit / onControl 只捕获下面那个 handler 常量；handler 在 start() 之前完成赋值，
  // 所以不存在「输入已经进来但命令层还没建好」的窗口。
  const input = createInputReader({
    stdin: io.stdin,
    stdout: io.stdout,
    stderr: io.stderr,
    env: io.env,
    commands: HELP_COMMANDS.map(([name]) => name),
    // 联想菜单的数据源（工单 05）：与 /help 同一张表连中文说明一起传，两处文案不分叉。
    menuCommands: HELP_COMMANDS.map(([name, description]) => ({ name, description })),
    // 输入历史（规格 2026-10-07 D12）：加载的是 oldest→newest，输入层契约要最新在前。
    history: [...seedHistory].reverse(),
    // 不 await：controller.submit() 会等到本轮 + 队列 drain 结束，await 会把输入框堵死（D15）。
    // immediate（Ctrl+S）原样透传：命令草稿与回车完全同路，「立即」只作用于普通正文。
    // 裸 `/` 由输入层丢弃（工单 06）：弹窗退役后，「空 / + 回车」不再有任何动作。
    // 提交入口顺手记历史（D11）：命令、正文、立即提交都算输入，空行到不了这里。
    // 提交后顺手刷新 @ 引用的文件清单（D16）：新写的章节立刻可以 @。
    onSubmit: (text, { immediate = false } = {}) => {
      void recordInputHistory(text);
      void refreshFileSuggestions();
      void handler.handle(text, { immediate });
    },
    onControl: (name) => { void handler.handleControl(name); },
    menuFiles: () => fileSuggestions,
  });

  // composer 只在交互会话交给渲染器：管道 / 非交互没有输入区，动态行的「就地重绘」
  // 直写路是那条路上唯一的可见交代；把 composer 交给一条永远不激活的会话，
  // 动态行就只剩「攒着」一个去处，管道里什么都看不见了。
  const renderer = createRenderer({ stdout: io.stdout, env: io.env, composer: interactive ? input.composer : null });

  // 普通权限确认的方向键选择器（铁律 11）。与 /model 向导、/resume 挑选同一套路：
  // 选择器要独占按键，常驻 readline 必须让位（suspend → 选择 → resume），让位由这一层负责。
  //
  // 只有终端真能承载选择器（`canAsk`：stdin/stdout 都是 TTY 且拿得到原始按键）才把它交给事件桥；
  // 否则注入 null——事件桥退回「按文字答」的提示卡，既有路径一个字节不变
  // （非 TTY / 管道的验收用例就是打 `1` 作答的）。
  const decisionSelector = createSelector({ stdin: io.stdin, stdout: io.stdout, env: io.env });

  // 把终端让给「自己吃按键」的一块界面（方向键选择器 / 配置向导），用完原样还回来。
  // 三处都用它（权限确认卡、/resume 挑选、/model 向导），因为漏掉一次 resume 就会把常驻
  // readline 永远留在 suspend 状态——那种故障靠复制传播，所以让位只留这一个出口。
  //
  // suspend() 挂在 try **内部**是刻意的：它自己也可能抛（终端已关 / 流被锁），
  // 放在 try 外面就会跳过 finally 的 resume。选择器 ask() 在拿不到 TTY 时返回 null，
  // 不会静默替用户做选择。
  // 嵌套（向导让位期间来一张确认卡）由持有计数兜住：只有最外层动终端，否则内层的
  // resume 会真建第二个 readline，同一份按键被两个读取者消费（缺陷猎捕报告 4）。
  const { withInputSuspended } = createInputYielder({ input });

  // 让位下的选择器会话：让位、ask、恢复与取消归一都收在 pickers.mjs，这里是它唯一的实例。
  // 每个调用方只声明自己的取消语义（挑选静默取消 / 确认卡按拒绝读）。
  // 「空 / + 回车开命令菜单」的弹窗已退役（工单 06）：命令发现交给输入中的联想菜单，
  // 这里不再有 chooseCommand——省掉「弹窗与权限确认卡抢键」的忙碌分支。
  const pick = createMenuPicker({ selector: decisionSelector, withInputSuspended });

  // 普通权限确认卡：pending → 选择器作答 → decide()。作答翻译、deny 读法、重入保护与
  // 两条事实（确认已失效 / 确认失败）都住在 decisions.mjs；这里只注入这台终端的通道。
  // canAsk 为假的终端传 null：事件桥退回「按文字答」的提示卡，既有路径一个字节不变
  // （非 TTY / 管道的验收用例就是打 `1` 作答的）。
  const onDecision = decisionSelector.canAsk
    ? createDecisionCard({
      pick,
      decide: ({ decisionId, choice, text }) => controller.decide({ decisionId, choice, text }),
      notify: (text, options) => renderer.printStatus(text, { final: true, ...options }),
    })
    : null;

  const bridge = createEventRenderer({ renderer, onDecision });
  const sessionManager = createSessionManager({
    workspaceStore,
    eventStoreFactory: bridge.wrapEventStoreFactory((options) => createEventStore(options)),
  });

  // 模型客户端每次请求都重新读配置：用户可能正是在会话里用 /model 设好 key 的，
  // 构造期快照会让刚设好的 key 直到重启都不生效。
  const configPath = workspaceStore.configPath;

  // 技能服务：组合根只建一份，控制器（每轮发现清单 + readSkill 工具）与 /skills 命令共用。
  // 服务本身无状态（每次调用重新发现），两处共享不会互相污染。
  const skillService = createSkillService();

  // 章节服务：版本快照与前情账本的应用私有存储（铁律 8），控制器里的
  // commit_chapter / rollback_chapter / read_continuity 工具都用它。
  // appDataRoot 与 workspaceStore 同源（APPDATA），同一创作目录映射到同一个私有区。
  const chapterService = createChapterService({ appDataRoot: resolveAppDataRoot(io.env) });

  // 思考强度的会话内状态（P16：跟会话走，不持久化）。
  // 每次判定都现读配置：用户可能正是在这个会话里用 /model 换的模型。
  const effortState = createEffortState({
    loadConfig: () => loadModelConfig({ configPath, env: io.env }),
  });

  const modelClient = {
    streamChat(options) {
      return loadModelConfig({ configPath, env: io.env }).then((config) => {
        // 档位在**组请求这一刻**才解析：/effort 改的是 effortState，下一轮自然带上新值，
        // 正在跑的那一轮不受影响（与队列语义同构，不需要新机制）。
        //
        // 传的是 requestLevel(config) 而**不是** get()（R8）：「自动」不等于什么都不发——
        // 模型已验证支持思考时它按 DEFAULT_EFFORT 双发，判不出能力时才一个字段都不发。
        // 直接用 get() 就会让每个会话的初始状态都在赌服务端默认，那正是 P13 禁止的。
        // config 传进去是为了省掉 requestLevel 内部再读一次同一个文件。
        return effortState.requestLevel(config).then((effort) => createDeepSeekClient({ config, effort }).streamChat(options));
      });
    },
  };

  // 拿一个 Key 去问端点「它到底能不能用」。GET /models 是这个自检最便宜的入口：
  // 它同时回答两件事——Key 有没有被接受、以及这个端点上有哪些真实模型名。
  // 设置 Key 之前先跑一次，用户当场就能看到结论，不必等到发消息才被服务端回一句 401。
  async function probeKey(apiKey) {
    let base = { baseUrl: undefined };
    try {
      base = await loadModelConfig({ configPath, env: io.env });
    } catch {
      // 配置文件坏了不该挡着这次自检：用默认端点试。
    }
    try {
      const models = await createDeepSeekClient({ config: { ...base, apiKey, configured: true } }).listModels();
      return { status: 'ok', models, reason: null };
    } catch (error) {
      const status = error?.details?.status;
      if (error?.code === 'MODEL_HTTP_ERROR' && (status === 401 || status === 403)) {
        return { status: 'invalid', models: [], reason: fact(error) };
      }
      // 连不上、端点异常、响应读不出来……都不是「Key 错了」，别用它把人引偏。
      return { status: 'unknown', models: [], reason: fact(error) };
    }
  }

  // 用当前配置里的 Key 问一次真实模型列表（`/model <模型名>` 核对、向导取候选都用它）。
  async function listModels() {
    const config = await loadModelConfig({ configPath, env: io.env });
    return createDeepSeekClient({ config }).listModels();
  }

  // 读一次模型配置状态。四态归类（ready / empty / invalid / unreadable，含损坏与挽救）
  // 在 model 层的 readModelState 里，与 /model 展示、引导 readState 共用同一份读法；
  // 这里只补本进程需要的那一件事：configExists 决定要不要走引导。
  //   invalid（JSON 损坏）当作「还没配好」——引导能把它覆盖修好；
  //   unreadable（权限、路径不对，如私有目录整个不可用）引导也救不了，不引导，
  //   只把事实带进面板，绝不让用户卡在一个点不动的菜单上。
  async function readConfigState() {
    const state = await readModelState({ configPath, env: io.env });
    return {
      ...state,
      configExists: state.state === 'invalid'
        ? false
        : state.state === 'unreadable' ? true : state.config.configExists,
    };
  }
  let configState = await readConfigState();

  // 历史预算只在这里取**一次**，然后同时喂给控制器（模型记忆）与屏幕重演。
  //
  // 为什么是同一个变量而不是两处各取默认（P25）：两边都用 `DEFAULT_HISTORY_BUDGET_CHARS`
  // 只是**今天恰好相等**——一旦将来有人把自定义预算接进 createRunController（那是它的公开参数），
  // 屏幕上重演的轮次与模型记得的轮次就会静默分叉，而分叉的方向是「模型记得、屏幕看不到」（P26）。
  // 判据只有一处定义，这与 renderer.mjs 的「判断不复制」是同一条要求。
  const historyBudgetChars = DEFAULT_HISTORY_BUDGET_CHARS;

  // 打开会话即取写锁：会话被占用、工作区不可写、日志损坏都在这里收敛成一条中文事实。
  let controller = null;
  const openController = async (sessionId) => {
    const next = createRunController({
      sessionManager,
      projectRoot,
      sessionId,
      modelClient,
      skillService,
      chapterService,
      // 显式给预算：不靠「构造函数默认值与组合根默认值是同一个常量」这种巧合。
      historyBudgetChars,
      // 控制器只负责「发生了什么」，怎么显示归组合根决定（agent 层不碰 stdout）。
      // 历史读不出来时如实说一句：用户至少要能分辨「模型失忆了」与「模型没在听」。
      onNotice: (message) => renderer.printStatus(message, { tone: 'warn' }),
      // 思考正文的实时预览：增量直接推给渲染层，**不落盘**（日志里仍然只有轮末那一条
      // reasoning_completed，P18 不动）。渲染层自己决定多久重绘一次——
      // 它只在攒满完整行时才动屏幕，所以这里可以放心按片转发。
      onReasoningPreview: (delta) => renderer.printThinkingPreview(delta),
    });
    await next.open();
    return next;
  };
  try {
    if (parsed.resume !== null) {
      controller = await openController(parsed.resume);
    } else if (parsed.continueLatest) {
      // -c：接着最近会话。无历史时 openLatest 会自己建一个（createIfMissing 默认 true）。
      controller = await openController(null);
    } else {
      // 裸启动与「带一条消息」都走这里：**开一个全新会话**。
      // 先建一个空会话拿到 ID，再走常规打开路径（控制器只认 openLatest/openById）。
      const created = await sessionManager.create(projectRoot);
      await created.close();
      controller = await openController(created.sessionId);
    }
  } catch (error) {
    io.stderr.write(`${fact(error, '无法打开会话，请稍后重试。')}\n`);
    renderer.close();
    input.stop();
    return EXIT_RUNTIME_ERROR;
  }

  // 权限模式的会话内状态（ADR-0020：跟会话走，不持久化；/resume 换控制器时重置为普通）。
  // 真相只有这一份：翻转时同步写入当前控制器的权限层（permissions.setYolo——YOLO 在
  // permissions.mjs 里只跳过 write 级确认，extreme 与项目外不放行，语义不在这里改），
  // 并同步上框线右端的常驻标签（工单 02）：双态常驻，普通也显示——用户时时刻刻都该
  // 知道下一次输入将以什么权限执行。
  let permissionYolo = false;
  const permissionMode = {
    get: () => (permissionYolo ? 'yolo' : 'normal'),
    set(value) {
      permissionYolo = value === 'yolo';
      // 控制器尚未打开时只记状态：输入层在控制器开好之后才启动，Shift+Tab 进不到那条路。
      // permissions 由 createRunController 保证非空且带 setYolo（run-controller.mjs 的返回契约）。
      if (controller !== null) controller.permissions.setYolo(permissionYolo);
      const mode = permissionMode.get();
      input.composer.setRuleTag({ text: MODE_TAG[mode], tone: MODE_TAG_TONE[mode] });
    },
  };
  // 启动即常驻（工单 02）：标签在第一次画框时就带上，不等第一次切换。
  input.composer.setRuleTag({ text: MODE_TAG.normal, tone: MODE_TAG_TONE.normal });

  // /resume：控制器的 sessionId 是构造期固定的，切换会话只能「开新控制器 → 换掉旧的」。
  async function switchSession(sessionId) {
    const current = controller;
    if (current !== null && current.snapshot().session_id === sessionId) {
      throw new Error('已经是当前会话。');
    }
    // 先开新的：新会话打不开时旧会话原样可用，不做「先关后开」的半途状态。
    const next = await openController(sessionId);
    controller = next;
    // 权限弱化状态不跨会话（ADR-0020）：新控制器的权限层默认就是普通，这里把会话内
    // 状态也拉回来（chip 同步收掉）——用户对着新会话不该被上一会话的 YOLO 静默罩着。
    permissionMode.set('normal');
    if (current !== null) {
      current.stop(); // D18：先停当前轮
      await current.close(); // 再释放旧会话的写锁——旧轮的终态事件在这里全部处理完
    }
    // 旧轮终态处理完**之后**才清桥内状态（lastPlan / 排队输入 / 思考缓存都绑定在旧会话上），
    // 然后播种新会话的计划——顺序反过来，旧计划就会在切换后重新挂回实时区（评审 P0）。
    bridge.resetSessionState();
    const plan = next.snapshot()?.plan;
    renderer.setLivePlan(Array.isArray(plan?.items) ? plan.items : null, { active: false });
  }

  // /archive 的「归档 + 开新会话接续」（规格 2026-10-07 D4）：归档事件记在当前会话，
  // 然后按裸启动的同一套（create → close → openController）换到全新会话。
  // 先归档后切换：切换失败时旧会话已带归档标记，重试 /archive 不会重复归档（事件幂等）。
  async function archiveAndStartNew() {
    await controller.archive();
    const created = await sessionManager.create(projectRoot);
    await created.close();
    await switchSession(created.sessionId);
  }

  // /export 的装配（规格 2026-10-07 D8–D10）：轮次取舍复用 buildReplay，只是不设预算——
  // 导出是显式动作，要的是全部轮次；落盘写创作目录根（用户显式命令即授权，铁律 8 的
  // 「私有历史不进创作目录」说的是应用自己默默写盘，不是用户要的导出物）。
  const exporter = {
    write: async () => {
      const snapshot = controller.snapshot();
      const events = await controller.readEvents();
      const { items, plan, keptTurns } = buildReplay(events, { budgetChars: Number.MAX_SAFE_INTEGER });
      if (keptTurns === 0) return { empty: true };
      const markdown = buildExportMarkdown({
        items,
        plan,
        meta: {
          sessionId: typeof snapshot?.session_id === 'string' ? snapshot.session_id : null,
          title: typeof snapshot?.title === 'string' ? snapshot.title : '',
          exportedAt: new Date(),
          turns: keptTurns,
        },
      });
      return { empty: false, ...(await writeExportFile({ projectRoot, markdown })) };
    },
  };

  // 退出信号：/quit 与 Ctrl+C 空闲退出都只 resolve 这一个 promise，主流程在那之后收尾。
  let finish = () => {};
  const done = new Promise((resolve) => {
    finish = resolve;
  });

  // —— 头部面板的内容 ——
  // 面板只负责排版，事实在这里现取：任何一行都不写死，也不猜。
  function modelRow() {
    // 四态归类来自 model 层的 readModelState（与 /model 展示、引导共用）。
    if (configState.state === 'unreadable') return '配置不可用 · 请检查应用数据目录的读取权限';
    // JSON 损坏与「读不出来」是两回事：损坏时引导与 /model 都能修，指路要指对——
    // 旧版把损坏也说成「配置不可用 · 检查读取权限」，用户照着查权限只会白忙一场。
    if (configState.state === 'invalid') return '配置已损坏 · 输入 /model 重新设置';
    const config = configState.config;
    if (configState.state === 'empty') return '未配置 · 输入 /model 开始设置';
    // 模型名那一格放着 API Key（真实发生过）：这一行必须点名，否则用户只会看到后面那句
    // 把他引向 Key 的「API Key 无效」，然后一路查下去。
    if (configState.corruptModel) return '模型设置已损坏 · 输入 /model 重新设置';
    const key = config.apiKeySource === 'env'
      ? `${maskApiKey(config.apiKey)}（来自环境变量）`
      : maskApiKey(config.apiKey);
    // 行尾追加思考强度，零新增行（P15：不新开 UI 区域）。
    // 「自动」也照实写出来——不写会让人分不清「没配」与「配了但没选档位」。
    return `${config.model ?? '未指定模型'} · ${key} · 思考 ${effortState.describe()}`;
  }

  async function memoryRow() {
    // 复用项目记忆模块的三态判定：面板说的与注入用的是同一份读法，
    // 就不会出现「面板说已就绪、这一轮却按缺失注入」的分歧
    // （与 renderer.mjs 那条「summarizeToolResult 只做转发、不复制判断」的注释同一个道理）。
    const read = await readProjectMemory(projectRoot);
    if (read.state === 'present') return 'WWRITING.md 已就绪';
    if (read.state === 'unreadable') return 'WWRITING.md 读不出来 · 本轮按无记忆继续';
    return 'WWRITING.md 尚未建立';
  }

  async function panelRows() {
    const snapshot = controller.snapshot();
    const sessionId = typeof snapshot?.session_id === 'string' && snapshot.session_id !== '' ? snapshot.session_id : null;
    const form = startupLabel(parsed);
    return [
      ['工作区', projectRoot],
      ['会话', sessionId === null ? form : `${form} · ${sessionId}`],
      ['模型', modelRow()],
      ['记忆', await memoryRow()],
    ];
  }

  // 模型设置向导的装配：首次设置与 `/model` 的重新配置共用同一套终端入口
  // （选择器用原始按键、文本用临时 readline），只在 reconfigure / focus 上分岔。
  //   focus: 'key' → 直接从「问 Key」那一步开始（用户敲了 /model key 但没给值）。
  function makeOnboarding({ reconfigure, focus = null }) {
    return createOnboarding({
      renderer,
      select: createSelector({ stdin: io.stdin, stdout: io.stdout, env: io.env }),
      readLine: (options = {}) => readOneLine({
        stdin: io.stdin,
        stdout: io.stdout,
        env: io.env,
        box: true,
        ...options,
      }),
      configPath,
      env: io.env,
      reconfigure,
      focus,
      // 问到的 Key 当场验证：验证与「取真实模型列表」是同一个请求（GET /models）。
      verifyKey: probeKey,
      listModels,
    });
  }

  // —— 首次使用：引导 ——
  // 位置很讲究，三条约束一起满足：
  //   1. 在「打开会话」之后 —— 私有目录不可用、日志损坏这类启动故障要先如实报出来，
  //      不能让用户对着一个走完也存不进去的菜单白填三步；
  //   2. 在对话面的 readline 建立之前 —— 引导自带输入通道（选择器用原始按键、文本用临时
  //      readline），与常驻 readline 同时存在会互相抢键；
  //   3. 只在 config.json 不存在时问一次，跳过之后不再问。
  if (!configState.configExists && interactive) {
    // 开场的面板把「接下来会发生什么」一次说清：两步、都能跳过。
    // 用户在上一版被卡住，正是因为既不知道有几步、也不知道自己在第几步。
    renderer.printIntro({
      title: versionLine(),
      subtitle: PANEL_SUBTITLE,
      rows: [['首次设置', '一个 API Key + 一个模型，两步就好；都能跳过。']],
      hint: `${STEP_HINT} · Ctrl+C 退出`,
    });
    await makeOnboarding({ reconfigure: false }).start();
    // 引导可能刚写下配置（也可能顺手修好了损坏的配置）：面板要反映最终状态，不是引导前的状态。
    configState = await readConfigState();
  }

  // 命令层：getController 是取值函数，/resume 换掉控制器后它自动指向新的那一个。
  const handler = createCommandHandler({
    getController: () => controller,
    renderer,
    listSessions: () => sessionManager.list(projectRoot),
    skills: { list: () => skillService.catalog({ projectRoot }) },
    resumeSession: (sessionId) => switchSession(sessionId),
    // /archive：归档当前会话 + 开新会话接续（规格 2026-10-07 D4）。归档语义在控制器，
    // 「开新会话」要动 sessionManager 与 switchSession，只有组合根两样都够得着。
    archiveCurrent: () => archiveAndStartNew(),
    // /export：导出的读写都在组合根——事件要经控制器读，文件要落创作目录。
    exportSession: exporter,
    // /resume 无参时的会话挑选。与 /model 向导同一套路：选择器要独占按键，
    // 而常驻 readline 会跟着一起吃键，所以先 suspend（关掉它）→ 挑选 → resume（原样建回来）。
    //
    // **选择器的真实契约**（`src/terminal/select.mjs:75-77`，用法见 `onboarding.mjs:220-247`）：
    //   items 是 `[{ id, label }]`；`ask()` resolve `{ item, index } | null`，null = 用户取消。
    pickSession: async () => {
      // 列不出来就**让它抛**：命令层的 try/catch 会把它收敛成一条 `切换失败` 的诚实事实。
      // 绝不能在这里吞掉退回 null——null 是"用户按了 Esc 取消"的返回值，命令层对它是**静默**的，
      // 于是"会话列表读不出来"就伪装成了"用户自己取消"，用户敲完 /resume 一个字都看不到。
      const sessions = await sessionManager.list(projectRoot);
      const currentId = controller?.snapshot?.().session_id ?? null;
      // 0 轮空壳的过滤与「（当前）」标注都在 sessionPickerItems（可单测）。
      const items = sessionPickerItems(sessions, currentId);
      if (items.length === 0) return null;
      const picked = await pick({
        title: '选择一个会话',
        items,
        hint: '↑/↓ 选择 · 回车切换 · Esc 取消',
        // summary: null —— 选中后整块抹掉，确认那一行由命令层的「已切换会话」来说。
        // 用默认 summary 会多打一行 `❯ <label>`，与紧接着的终态行重复（铁律 3）。
        summary: null,
        cancelSummary: null,
      });
      return picked === null ? null : picked.item.id;
    },
    // 退出清理属于生命周期，只在这个回调里收尾：/quit 已经保证 stop() → close() 在前。
    quit: () => {
      renderer.close();
      input.stop();
      finish(EXIT_OK);
    },
    // 非交互时不跑对话循环（见下），所以这里不存在「readline 没回显、需要我们补用户行」的情形。
    echoUser: false,
    effort: effortState,
    // 事件桥持有本次进程内的思考正文；命令层只取值，不持有状态。
    getReasoning: () => bridge.lastReasoning(),
    // Shift+Tab 的权限模式状态与进入 YOLO 的确认卡（让位选择器），都由命令层消费（ADR-0020）。
    permissionMode,
    pick,
    model: {
      configPath,
      env: io.env,
      probeKey,
      listModels,
      // `/model` 无参（或 `/model key` 没给值）：临时把终端交给向导。选择器要独占按键，
      // 而常驻 readline 会跟着一起吃键，所以先 suspend（关掉它）→ 跑向导 → resume（原样建回来）。
      dialog: ({ focus = null } = {}) => withInputSuspended(() => makeOnboarding({ reconfigure: true, focus }).start()),
    },
  });

  // 头部面板：启动的第一屏，也是最后一屏静态信息——再往下就是对话本身。
  // 放在 input.start() 之前：此时还没有常驻 readline，面板按顺序直写，不必和行缓冲打交道。
  if (interactive) {
    renderer.printIntro({
      title: versionLine(),
      subtitle: PANEL_SUBTITLE,
      rows: await panelRows(),
      hint: PANEL_HINT,
      // 紧跟其后的输入框自带一条上框线，两条线贴在一起只会显得屏幕发虚。
      bottomBorder: false,
    });
  }

  // 屏幕重演（P24 / P25 / P26）：重启后把上次的对话重新显示出来。
  //
  // 位置很讲究，两条约束一起满足：
  //   1. 在启动面板**之后** —— 面板回答的是「我在哪个版本、哪个目录、哪个会话」，
  //      它是第一屏的锚；重演的内容属于对话，排在它下面。
  //   2. 在常驻 readline **之前** —— 此时屏幕上还没有输入框，重演的内容按顺序直写，
  //      不必和行缓冲打交道（与面板同一条理由）。
  //
  // 不需要判断「是不是在恢复会话」：全新会话的日志里没有 run_started，
  // buildReplay 自然返回空 items，一个字节都不会写。判据是**日志里有什么**，
  // 不是「用户敲了哪个参数」——这与 ADR-0006「判据是内容不是事件」是同一种思路。
  //
  // 读不出来就什么都不重演，并如实说一句：与 loadHistory 的降级策略同构，
  // 重演历史这件事不值得让启动失败。
  if (interactive) {
    try {
      const events = await controller.readEvents();
      // 预算与模型记忆是**同一份**（P25）：屏幕上重演的与模型记得的对得上，
      // 绝不会出现「模型记得、屏幕看不到」（P26）。用的就是喂给控制器的那个变量——
      // 不是「另一处也填了同一个默认常量」，那样只是今天恰好相等。
      const { items, omittedTurns, plan } = buildReplay(events, { budgetChars: historyBudgetChars });
      printReplay({ renderer, items, omittedTurns, plan });
    } catch (error) {
      renderer.printStatus('对话未能重演', { final: true, tone: 'warn', detail: fact(error, '本次从空白屏幕开始') });
    }
  }

  // 建立 readline 监听。放在 handler 之后：输入事件一旦回调就必须能触达命令层。
  // initialText（首条位置参数）会像用户亲手敲的一样填进输入框并提交——屏幕上因此
  // 也是同一个框、同一行用户行，而不是另打一行「❯ 写第一章」。
  const started = input.start({ initialText: parsed.prompt });

  // 实时区的计划 chip（§4.2：Run 结束保留供回看）：数据源是当前会话投影，
  // 与 /resume 切会话同一条路径。必须放在输入区起来之后——此刻输入层才开始认 setLive。
  const startupPlan = controller.snapshot()?.plan;
  renderer.setLivePlan(Array.isArray(startupPlan?.items) ? startupPlan.items : null, { active: false });

  if (!started.interactive) {
    // 先同步停掉输入监听，再释放其它资源：否则管道里已经排好的行会在 await 的间隙
    // 被当成「该跑的输入」提交进来，非交互分支就不再是无副作用的。
    input.stop();
    // MinTTY 的提示已由输入层写在 stderr；这里补上一条用户可理解的事实与非零退出码。
    io.stderr.write(`${NOT_INTERACTIVE_FACT}\n`);
    await controller.close();
    renderer.close();
    return EXIT_NOT_INTERACTIVE;
  }

  await done;
  return EXIT_OK;
}

// 判断本模块是否为进程直接入口（兼容 Windows 路径）。
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exitCode = await main(process.argv.slice(2));
}
