// 斜杠命令：解析（纯函数）＋ 命令表（单一账本）＋ 执行（依赖注入）。
//
// 布局（命令单账本重构）：本文件是 registry——parse、表装配、handle / handleControl、
// 答确认与 submit 的核心路径、shutdown 与 Shift+Tab。17 条可执行命令按依赖形状分住四个族文件
// （commands/model.mjs、session.mjs、run.mjs、skills.mjs），每条是
// { name, description, run(args, ctx) } 的表条目；busy 拒绝等行为细节留在各自 run 里，
// 不做声明式。展示顺序（/help 两栏与联想菜单行序）横切族归属，由 DISPLAY_ORDER 统一策展；
// 表与顺序的双向覆盖在模块加载时校验，漏登记／幽灵登记当场抛错。
//
// 边界：
//   - 单一对话面：这里只解析「输入框里的这一行」，不建第二控制面。待确认的确认也在这同一个输入框里收。
//   - 不复制停止/确认逻辑：/stop 与 Ctrl+C 都调同一个 run controller（D14），/quit 的顺序是
//     stop() → close()（D18），都由控制器负责语义。
//   - /model 走 Task 4 的配置接口：apiKey 只在「显式设置」时传入（undefined = 保留原值，
//     null 会被当成显式置空而抛错，所以绝不把 load 的结果展开回传）。
//   - 文案：命令回复也是一行式结果（printStatus 终态），错误只呈现一条用户可理解的事实，
//     错误码与技术细节不进主文案。
import { loadModelConfig, maskApiKey, saveDeepSeekConfig, sanitizeInput } from '../model/config.mjs';
import { fact } from '../fact.mjs';
import { versionLine } from '../version.mjs';
// 确认的作答语义（选项表 / 文本翻译 / 「确认已失效」那句事实）只有一份：decisions.mjs。
// 这里的文字作答与确认卡的方向键作答共用同一张翻译表。
import { choiceFor, reportStaleDecision } from './decisions.mjs';
// 确认卡取消痕迹的前缀与权限确认卡同一份（decisions.mjs 也用它）。
import { MENU_CURSOR } from './select.mjs';
// 命令族：每族一个文件，只 import 自己的依赖；这里只做表装配与核心路径。
import { modelCommands } from './commands/model.mjs';
import { sessionCommands } from './commands/session.mjs';
import { runCommands } from './commands/run.mjs';
import { skillsCommands } from './commands/skills.mjs';

// /model 的参数意图解析住在模型族（commands/model.mjs），registry 代为导出：
// 它与本文件的 parseSlashCommand 同属这个模块的公开解析面。
export { modelIntent } from './commands/model.mjs';

// 解析斜杠命令：只有整行以 / 开头才算命令；参数原样保留（内部空白压成一个，首尾空白去掉）。
// 不是命令一律返回 null——普通正文里的斜杠（路径、章节名）绝不误判。
// 先过 sanitizeInput：粘贴来的文本常带零宽字符与全角空格，它们在屏幕上不可见，
// 却足以让「`/model key` + Key」这种输入被解析成另一件事。
export function parseSlashCommand(text) {
  if (typeof text !== 'string') return null;
  const trimmed = sanitizeInput(text);
  if (trimmed === '' || !trimmed.startsWith('/')) return null;
  const match = /^(\S*)\s*([\s\S]*)$/.exec(trimmed.slice(1));
  return { name: (match[1] ?? '').toLowerCase(), args: sanitizeInput(match[2] ?? '') };
}

// —— 命令表：单一账本 ——
//
// 一条命令的全部知识只记一遍：{ name, description, run(args, ctx) }。
// run 收 ctx（归一化后的依赖 ＋ reply / refuseWhenBusy 助手），缺省即「就地回答，动作 handled」；
// 旧版 HELP_COMMANDS（显示账）与 runCommand 的 switch（执行账）两张手写账由此合并。
const REGISTRY_COMMANDS = [
  // /init 是唯一一条「登记在命令表里、却按普通聊天请求提交」的命令（chat: true）：
  // 统一规格书:371 说它是一条普通聊天请求，:374 说它与其他指令走完全相同的 Agent 循环与
  // 事件流、并保留用户发送的原文与附加要求。做成本地命令就会有一处「特殊化的 /init 输出」，
  // 那正是 Q14 明确不做的。只认整词：`/initialize` 之类查不到条目，照常落到「不认识这个命令」。
  { name: 'init', description: '建立或更新项目记忆 WWRITING.md', chat: true },
  { name: 'help', description: '显示本帮助', run: async (_args, { reply }) => { for (const line of helpLines()) reply(line); } },
  // /quit 的退出顺序在 shutdown：先停当前轮，再释放会话写锁（D18），Ctrl+C/EOF 共用同一条路径。
  { name: 'quit', description: '退出', run: async (_args, { reply, shutdown }) => { reply('已退出'); await shutdown(); return 'quit'; } },
];

const TABLE = [...REGISTRY_COMMANDS, ...modelCommands, ...sessionCommands, ...runCommands, ...skillsCommands];
const TABLE_BY_NAME = new Map(TABLE.map((entry) => [entry.name, entry]));

// 展示顺序（/help 两栏与联想菜单行序）：产品策展，横切命令族的归属——
// 族文件里条目数组的顺序不代表展示顺序。
const DISPLAY_ORDER = Object.freeze([
  'init', 'model', 'effort', 'reasoning', 'plan', 'compact', 'export', 'sessions',
  'skills', 'resume', 'rename', 'archive', 'now', 'cancel', 'stop', 'retry', 'help', 'quit',
]);

// 表的一致性在模块加载时校验：重名、缺展示顺序、幽灵顺序名都当场抛错——
// 「加了一条命令但 /help 和联想菜单看不见它」这种漂移不允许静默发生。
if (TABLE_BY_NAME.size !== TABLE.length) throw new Error('命令表里有重名条目。');
const WITHOUT_ORDER = TABLE.filter((entry) => !DISPLAY_ORDER.includes(entry.name)).map((entry) => entry.name);
if (WITHOUT_ORDER.length > 0) throw new Error(`命令 ${WITHOUT_ORDER.join('、')} 已入表但没有展示顺序（DISPLAY_ORDER）。`);
const GHOST_ORDER = DISPLAY_ORDER.filter((name) => !TABLE_BY_NAME.has(name));
if (GHOST_ORDER.length > 0) throw new Error(`展示顺序里的 ${GHOST_ORDER.join('、')} 不是已登记的命令。`);

// 帮助目录从表派生：显示账不再是第二份手写账。
export const HELP_COMMANDS = Object.freeze(
  DISPLAY_ORDER.map((name) => [`/${name}`, TABLE_BY_NAME.get(name).description]),
);

// 帮助行：第一条永远是版本——用户最先想确认的就是「我现在跑的是哪个版本」，
// 与启动头部面板、`--version` 共用同一行文本。命令排成两栏，扫一眼就找到要用的那条。
function helpLines() {
  const width = Math.max(...HELP_COMMANDS.map(([name]) => name.length)) + 3;
  return [
    versionLine(),
    '',
    '可用命令',
    ...HELP_COMMANDS.map(([name, description]) => `  ${name.padEnd(width, ' ')}${description}`),
  ];
}

// createCommandHandler({ getController, renderer, listSessions, resumeSession, pickSession, quit, echoUser, model })
//   getController () => run controller：/resume 会换掉控制器实例，所以这里取的是「当前那个」。
//   renderer      createRenderer 的返回值（或同形状的实现）。
//   listSessions  () => Promise<会话摘要[]>；resumeSession (sessionId) => Promise<void>；
//   pickSession   () => Promise<会话ID|null>：`/resume` 无参时的交互式挑选（null = 用户取消）。
//                 缺省 null = 当前终端给不出挑选界面，退回用法提示而不是静默。
//                 「谁负责把终端让给选择器」由注入方决定（cli.mjs 用 input.suspend/resume）。
//   quit          () => void：真正决定怎么退出的是调用方，这里不硬编码退出码。
//   echoUser      非 TTY 下 readline 不回显时，由这里补上用户行。
//   model         { configPath, env, load, save, mask, dialog, probeKey, listModels }，
//                 缺省接 Task 4 的真实实现；dialog 是 `/model` 无参时的交互向导。
//                 probeKey(apiKey) → { status: 'ok'|'invalid'|'unknown', models, reason }：
//                 「这个 Key 能不能用」由它回答（真实实现是拿它去 GET /models），
//                 没有它就只能存下再说。
//   effort        思考强度的会话内状态 { get, set, capability, syncWithModel, describe }，
//                 缺省 null = 本进程没有模型配置可依，`/effort` 如实说不可用。
//   getReasoning  () => { text, durationMs }[]|null：本次进程内上一轮跑完的思考正文，
//                 缺省 null = 没有取值口，`/reasoning` 照常给 empty 态（不抛）。
//   permissionMode 权限模式的会话内状态 { get: () => 'normal'|'yolo', set }（ADR-0020），
//                 缺省 null = 切换不可用，Shift+Tab 如实说不可用而不是静默。
//   pick          createMenuPicker 的入口（让位 + 方向键选择器），进入 YOLO 的确认卡用它。
//                 缺省 null = 没有把关界面就不能放行：只有「变弱」这一侧（进 YOLO）需要确认，
//                 没有选择器时开启不可用（Shift+Tab 本身只在交互终端出现，这是兜底）。
//   skills        { list }：技能清单取值口，缺省 null = /skills 如实说暂不支持。
//   archiveCurrent () => Promise<void>：归档当前会话并开新会话接续（/archive）——归档语义在
//                 控制器，「开新会话」要动 sessionManager 与切换，只有组合根两样都够得着。
//   exportSession { write }：导出入口（/export），读写都在组合根——事件经控制器读，文件落创作目录。
// 返回 { handle(text), handleControl(name) }。
export function createCommandHandler({
  getController,
  renderer,
  listSessions = null,
  resumeSession = null,
  pickSession = null,
  quit = null,
  echoUser = false,
  model = {},
  effort = null,
  getReasoning = null,
  permissionMode = null,
  pick = null,
  skills = null,
  archiveCurrent = null,
  exportSession = null,
} = {}) {
  if (typeof getController !== 'function') throw new Error('命令层需要 getController 才能触达同一个 run controller。');
  if (!renderer) throw new Error('命令层需要可用的渲染器。');

  function reply(text, options = {}) {
    renderer.printStatus(text, { final: true, ...options });
  }

  function pendingDecision() {
    const controller = getController();
    const list = controller?.permissions?.pending?.();
    return Array.isArray(list) && list.length > 0 ? list[0] : null;
  }

  // 待确认优先：同一个输入框既能答确认，也能继续写东西。答不上来的文本照常当新输入。
  async function answerDecision(decision, text) {
    const choice = choiceFor(decision, text);
    if (choice === null) return false;
    try {
      await getController().decide({ decisionId: decision.decision_id, choice: choice.choice, text: choice.text });
    } catch (error) {
      // 与确认卡的方向键作答同一句事实（reportStaleDecision）：这条确认已被别处作废，如实说，不抛。
      reportStaleDecision(reply, error);
    }
    return true;
  }

  // 普通输入：交给同一个 run controller。绝不 await —— 输入框在 Agent 跑的时候必须可用（D15）。
  // immediate（Ctrl+S）与回车共用同一个错误收口：两个入口的抛错都收敛成「提交失败」一条中文事实。
  function submit(text, { immediate = false } = {}) {
    if (echoUser) renderer.printUser(text);
    Promise.resolve()
      .then(() => (immediate
        ? getController().submitNow({ text })
        : getController().submit({ text })))
      .catch((error) => reply('提交失败', { tone: 'error', detail: fact(error) }));
  }

  // 运行中不开「独占按键」的交互界面（/model 向导、/resume 挑选器）：让位持有计数只管
  // 常驻 readline，管不住向导自建的临时 readline 与此时到达的权限确认卡选择器——
  // 两个 keypress 读取者会吃同一颗键，向导里敲的数字 1 就成了确认卡上的「一次允许」。
  // 与 runModeCycle 的忙碌口径同款（controller.isBusy），只是拦的是打开界面这一步。
  function refuseWhenBusy(detail) {
    const controller = getController();
    if (controller !== null && controller.isBusy()) {
      reply('运行中', { tone: 'warn', detail });
      return true;
    }
    return false;
  }

  // 退出顺序固定：先停当前轮，再释放会话写锁（close 不 abort 正在跑的轮，D18）。
  async function shutdown() {
    const controller = getController();
    try {
      controller.stop();
    } catch {
      // 退出路径上不再把任何错误抖给用户。
    }
    try {
      await controller.close();
    } catch {
      // 同上：锁没放成也照常退出，残留锁由 Task 2 的恢复逻辑处理。
    }
    if (typeof quit === 'function') await quit();
  }

  // ctx：族条目经它拿依赖。归一化（缺省回退、类型守卫）只在这里发生一次，
  // 族文件拿到手的字段都是「可直接调用，或明确的 null」。
  const ctx = {
    getController,
    renderer,
    reply,
    refuseWhenBusy,
    shutdown,
    // 模型域（commands/model.mjs）
    configPath: model.configPath ?? null,
    env: model.env ?? process.env,
    loadConfig: model.load ?? loadModelConfig,
    saveConfig: model.save ?? saveDeepSeekConfig,
    maskKey: model.mask ?? maskApiKey,
    openModelDialog: model.dialog ?? null,
    probeKey: typeof model.probeKey === 'function' ? model.probeKey : null,
    listModels: typeof model.listModels === 'function' ? model.listModels : null,
    effortState: effort !== null && typeof effort.set === 'function' ? effort : null,
    readReasoning: typeof getReasoning === 'function' ? getReasoning : null,
    // 会话域（commands/session.mjs）
    listSessions: typeof listSessions === 'function' ? listSessions : null,
    resumeSession: typeof resumeSession === 'function' ? resumeSession : null,
    chooseSession: typeof pickSession === 'function' ? pickSession : null,
    doArchive: typeof archiveCurrent === 'function' ? archiveCurrent : null,
    exporter: exportSession !== null && typeof exportSession.write === 'function' ? exportSession : null,
    // 技能域（commands/skills.mjs）
    listSkills: skills !== null && typeof skills.list === 'function' ? skills.list : null,
    // 控制路径（Shift+Tab，ADR-0020）
    modeState: permissionMode !== null && typeof permissionMode.get === 'function' && typeof permissionMode.set === 'function'
      ? permissionMode
      : null,
    openPicker: typeof pick === 'function' ? pick : null,
  };

  async function handle(text, { immediate = false } = {}) {
    if (typeof text !== 'string') return { action: 'ignored' };
    const trimmed = text.trim();
    if (trimmed === '') return { action: 'ignored' };

    const decision = pendingDecision();
    if (decision !== null && (await answerDecision(decision, trimmed))) return { action: 'handled' };

    const parsed = parseSlashCommand(trimmed);
    const entry = parsed === null ? null : TABLE_BY_NAME.get(parsed.name);
    // 下面两条路都是「把整行原文当普通聊天请求提交」，因此共用一个出口：
    //   · 不是斜杠命令（parseSlashCommand 返回 null）；
    //   · 是标记了 chat 的表条目（目前唯一一条：/init，见表内注释）。
    if (parsed === null || entry?.chat === true) {
      // 提交的是 trimmed（整行原文），不是 parsed?.name：附加要求必须一字不落跟着走。
      // immediate（Ctrl+S）只对**普通正文**有意义——chat 条目是登记在命令表里的命令，
      // 命令草稿与回车完全同路、绝不打断/提升（ADR-0021 决定 3，复查确立）。
      submit(trimmed, { immediate: parsed === null && immediate });
      return { action: 'submit' };
    }

    // 命令的输出是一整块：它上面是上一个输入框的下框线，下面是下一个输入框的上框线，
    // 两条线就是分隔，所以这里不需要再补任何收尾线。
    return { action: await runCommand(parsed, entry) };
  }

  // 一条斜杠命令 → 一个动作。'handled'（就地回答完了）| 'quit'（正在退出）。
  // 表条目的 run 返回 'quit' 表示退出；其余返回值（含无返回值）一律 'handled'。
  // entry 由 handle 查表带入；表里查不到（unknown 命令）时为 null，走「不认识」那句事实。
  async function runCommand(parsed, entry) {
    if (!entry) {
      reply(`不认识 ${parsed.name === '' ? '这个命令' : `/${parsed.name}`}，输入 /help 查看可用命令。`, { tone: 'warn' });
      return 'handled';
    }
    return (await entry.run(parsed.args, ctx)) ?? 'handled';
  }

  // 控制键：Ctrl+C 有活动轮先停，空闲才退（D14）；EOF 与退出共用同一条路径；
  // Shift+Tab 切权限模式（ADR-0020），语义见 runModeCycle。
  async function handleControl(name) {
    if (name === 'mode-cycle') {
      await runModeCycle();
      return { action: 'handled' };
    }
    if (name !== 'interrupt' && name !== 'eof') return { action: 'ignored' };
    if (name === 'eof') {
      await shutdown();
      return { action: 'quit' };
    }
    // D14：有活动轮先停，空闲才退。activeRunId 未打开会话也返回 null（不抛），
    // 所以这里不再需要 try/catch——控制器还没开（如启动早期按 Ctrl+C）照常走退出。
    const current = getController();
    if (current !== null && current.activeRunId() !== null) {
      current.stop();
      return { action: 'stopped' };
    }
    await shutdown();
    return { action: 'quit' };
  }

  // —— Shift+Tab：权限模式二态环 普通 ↔ YOLO（ADR-0020）——
  //
  // 为什么进 YOLO 要确认卡：上游规格为开启 YOLO 规定了确认文案（「YOLO 会自动执行写入和
  // 控制操作。确认开启？」），这是权限分级（铁律 4）的把关——误按一次 Shift+Tab 不该直接
  // 解除全部写确认。切回普通是**收权**，即时生效、无需确认、不开成功状态行（铁律 3）：
  // 实时区的警示 chip 消失就是全部反馈。
  //
  // 为什么运行中不可切：翻转时必然没有运行轮，「生效时机」因此没有歧义；也避开确认卡与
  // 运行中的工具确认卡抢键。忙碌口径与 /retry 同款（controller.isBusy）。
  const YOLO_CHOICES = Object.freeze([
    Object.freeze({ id: 'confirm', label: '确认开启' }),
    Object.freeze({ id: 'cancel', label: '先不开' }),
  ]);

  async function runModeCycle() {
    if (ctx.modeState === null) {
      reply('切换不可用', { tone: 'warn', detail: '当前会话没有可切换的权限模式。' });
      return;
    }
    const controller = getController();
    if (controller !== null && controller.isBusy()) {
      reply('运行中', { tone: 'warn', detail: '权限模式等这一轮结束后再切换。' });
      return;
    }
    if (ctx.modeState.get() === 'yolo') {
      ctx.modeState.set('normal');
      return;
    }
    // 进 YOLO 是「变弱」：没有把关界面（选择器）就不能放行。
    if (ctx.openPicker === null) {
      reply('切换不可用', { tone: 'warn', detail: '进入 YOLO 需要确认，这里给不出确认界面。' });
      return;
    }
    try {
      const picked = await ctx.openPicker({
        title: 'YOLO 会自动执行写入和控制操作。确认开启？',
        items: YOLO_CHOICES, // 已是 [{ id, label }] 且冻结；选择器对 items 只读，无需克隆
        hint: '↑/↓ 选择 · 回车确认 · Esc 取消',
        // Esc 也是一次真实的决定，留一行痕迹（与权限确认卡「拒绝留痕」同理）；
        // 确认开启用默认 summary（`❯ 确认开启`），事后能看出当时选的是哪一项。
        cancelSummary: `${MENU_CURSOR} ${YOLO_CHOICES.find(({ id }) => id === 'cancel').label}`,
      });
      if (picked !== null && picked.item.id === 'confirm') ctx.modeState.set('yolo');
    } catch (error) {
      // 选择器/终端半路抛错：收敛成一条事实，绝不变成未处理拒绝（与 /model 同款）。
      reply('切换失败', { tone: 'error', detail: fact(error) });
    }
  }

  return { handle, handleControl };
}
