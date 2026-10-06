// 斜杠命令：解析（纯函数）+ 执行（依赖注入）。
//
// 边界：
//   - 单一对话面：这里只解析「输入框里的这一行」，不建第二控制面。待确认的确认也在这同一个输入框里收。
//   - 不复制停止/确认逻辑：/stop 与 Ctrl+C 都调同一个 run controller（D14），/quit 的顺序是
//     stop() → close()（D18），都由控制器负责语义。
//   - /model 走 Task 4 的配置接口：apiKey 只在「显式设置」时传入（undefined = 保留原值，
//     null 会被当成显式置空而抛错，所以绝不把 load 的结果展开回传）。
//   - 文案：命令回复也是一行式结果（printStatus 终态），错误只呈现一条用户可理解的事实，
//     错误码与技术细节不进主文案。
import { loadModelConfig, looksLikeApiKey, readModelState, verifyAndSaveApiKey, maskApiKey, sanitizeInput, saveDeepSeekConfig } from '../model/config.mjs';
import { EFFORT_LEVELS, parseEffortArg, unsupportedEffortReason } from '../model/effort.mjs';
import { fact } from '../fact.mjs';
import { versionLine } from '../version.mjs';
import { padDisplayEnd } from './metrics.mjs';
// 技能目录的标签映射只有一份：agent-loop（提示词层）是权威，/skills 的列法照抄它。
import { SKILL_CATEGORY_TAGS } from '../agent/agent-loop.mjs';
// /retry 的可重试判定与历史投影共用同一份纯函数（history.mjs）：命令层先判、先回显原文，
// 控制器只负责「能不能安全起跑」的再拦截。
import { findRetryableTurn } from '../agent/history.mjs';
// 确认的作答语义（选项表 / 文本翻译 / 「确认已失效」那句事实）只有一份：decisions.mjs。
// 这里的文字作答与确认卡的方向键作答共用同一张翻译表。
import { choiceFor, reportStaleDecision } from './decisions.mjs';
// 确认卡取消痕迹的前缀与权限确认卡同一份（decisions.mjs 也用它）。
import { MENU_CURSOR } from './select.mjs';

// /model 的三行配置：左列按显示宽度对齐，值和启动头部面板同一种读法。
const CONFIG_COLUMN = 10;
function row(label, value) {
  return `${padDisplayEnd(label, CONFIG_COLUMN)}${value}`;
}

// 一行 `/model …` 的参数 → 意图。纯函数，两件事一次说清：
//   { kind: 'dialog' }                     无参 = 打开交互式设置向导
//   { kind: 'key', value }                 要设 API Key
//   { kind: 'model', value }               要设模型
//   { kind: 'invalid', reason: 'space' }   一串里带了空格，不是模型名也不是 Key
//
// 为什么要「猜」：用户设 Key 时会走错格（`/model sk-…`），粘贴时还会少打一个空格
// （`/model keysk-…`）——两种都真的发生过。它们共同的后果是 Key 被当成模型名存下去，
// 于是每一轮请求都带着一个不存在的模型名出去、换回一句「API Key 无效」，
// 人就一路去查自己的 Key，再也找不到真正的问题。所以这两件事必须在解析这一层就分开：
// **只要这一串里出现了 Key 的样式，它就一定是 Key，不是模型名。**
// 排队原文 → 撤回详情的一行摘要：取首行、压空白、按码点截 40 字，多行/超长加省略号。
function clipOneLine(text) {
  const raw = typeof text === 'string' ? text : '';
  const lines = raw.split(/\r?\n/);
  const firstLine = (lines[0] ?? '').trim().replace(/\s+/g, ' ');
  const points = Array.from(firstLine);
  const truncated = points.length > 40 || lines.some((line, index) => index > 0 && line.trim() !== '');
  return `${points.slice(0, 40).join('')}${truncated ? '…' : ''}`;
}

export function modelIntent(args) {
  const clean = sanitizeInput(args);
  if (clean === '') return { kind: 'dialog' };
  const gap = clean.indexOf(' ');
  const head = (gap === -1 ? clean : clean.slice(0, gap)).toLowerCase();
  const rest = gap === -1 ? '' : clean.slice(gap + 1);
  if (head === 'key') return { kind: 'key', value: rest };
  // `keysk-…`：`key` 与 Key 之间的空格没敲进去（粘贴时最常见）。整串当 Key。
  if (head.startsWith('key') && looksLikeApiKey(`${head.slice(3)}${rest}`)) {
    return { kind: 'key', value: `${head.slice(3)}${rest}` };
  }
  if (looksLikeApiKey(clean)) return { kind: 'key', value: clean, moved: true };
  if (rest !== '') return { kind: 'invalid', reason: 'space' };
  return { kind: 'model', value: clean };
}

export const HELP_COMMANDS = Object.freeze([
  ['/init', '建立或更新项目记忆 WWRITING.md'],
  ['/model', '设置模型与 API Key'],
  ['/effort', '思考强度：/effort none|low|high|max|自动'],
  ['/reasoning', '查看上一轮的思考全文'],
  ['/plan', '查看当前任务计划'],
  ['/compact', '把已往对话收敛成摘要，释放上下文'],
  ['/export', '把本会话全部对话导出为 markdown'],
  ['/sessions', '查看会话列表'],
  ['/skills', '查看已发现的技能'],
  ['/resume', '切换会话：/resume <会话 ID>'],
  ['/rename', '给当前会话起名：/rename <标题>'],
  ['/archive', '归档当前会话并开新会话接续'],
  ['/now', '提升队首输入，打断当前这一轮'],
  ['/cancel', '撤回队首排队输入'],
  ['/stop', '停止当前这一轮'],
  ['/retry', '重跑最近一次失败或中断的轮次'],
  ['/help', '显示本帮助'],
  ['/quit', '退出'],
]);

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

// 会话状态 → 人话（会话列表用）。
const SESSION_STATUS = Object.freeze({
  idle: '空闲',
  active: '运行中',
  interrupted: '已中断',
  archived: '已归档',
});

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

// 会话更新时间 → 人话。只经下面的 sessionRowLabel 出现在屏幕上：
// 同一批会话在两处必须用同一份读法，否则会各说一套时间。
function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return typeof iso === 'string' ? iso : '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 会话 → 一行事实：ID + 时间 + 状态 + 轮数。`/sessions` 与 `/resume` 的挑选列表共用这一份。
//
// 为什么必须共用（与 formatTime 同一条理由，但代价更大）：两处各拼一遍已经**当场分叉**过——
// 挑选列表只认 `archived`、其余一律退化成「N 轮」，于是同一批会话在 /sessions 里说「已中断」、
// 在挑选列表里说不出来，而挑选时恰恰需要「哪个是我昨天那个、它还活不活」。
// 「哪个是当前会话」这种**调用侧的语境**留给调用方自己追加，不进这里。
export function sessionRowLabel(session, { includeId = true } = {}) {
  const status = SESSION_STATUS[session?.status] ?? session?.status ?? '';
  const turns = Number.isFinite(session?.turns) ? `${session.turns} 轮` : '';
  // 标题（规格 2026-10-07 D6）：非空时行首——它才是「哪本是哪本书」的第一辨认物；
  // 为空时该段不存在，行与旧实现逐字一致。
  const title = typeof session?.title === 'string' && session.title !== '' ? session.title : '';
  return [title, includeId ? session?.session_id : '', formatTime(session?.updated_at), status, turns]
    .filter((part) => part !== '' && part !== undefined)
    .join('  ');
}

// 普通确认的三个选项（DECISION_CHOICES）、文本作答映射与 choiceFor 翻译
// 都住在 decisions.mjs——选择器路径与文字路径共用同一份，这里只做消费方。

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
} = {}) {
  if (typeof getController !== 'function') throw new Error('命令层需要 getController 才能触达同一个 run controller。');
  if (!renderer) throw new Error('命令层需要可用的渲染器。');

  const configPath = model.configPath ?? null;
  const env = model.env ?? process.env;
  const loadConfig = model.load ?? loadModelConfig;
  const saveConfig = model.save ?? saveDeepSeekConfig;
  const maskKey = model.mask ?? maskApiKey;
  const openModelDialog = model.dialog ?? null;
  const probeKey = typeof model.probeKey === 'function' ? model.probeKey : null;
  const listModels = typeof model.listModels === 'function' ? model.listModels : null;
  const effortState = effort !== null && typeof effort.set === 'function' ? effort : null;
  const readReasoning = typeof getReasoning === 'function' ? getReasoning : null;
  const modeState = permissionMode !== null && typeof permissionMode.get === 'function' && typeof permissionMode.set === 'function'
    ? permissionMode
    : null;
  const openPicker = typeof pick === 'function' ? pick : null;
  const chooseSession = typeof pickSession === 'function' ? pickSession : null;
  const listSkills = skills !== null && typeof skills.list === 'function' ? skills.list : null;
  const doArchive = typeof archiveCurrent === 'function' ? archiveCurrent : null;

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

  // —— /model：一条命令，三种走法 ——
  async function runModelCommand(args) {
    const intent = modelIntent(args);

    if (intent.kind === 'dialog') {
      // 无参 = 打开交互式设置向导（重新选模型 / 补 Key、换 Key），由组合根注入。
      // 没有交互能力时（单元测试、非交互、管道）退回「打印当前配置」——这条路一直是可用的兜底。
      if (refuseWhenBusy('模型设置等这一轮结束后再打开。')) return;
      if (typeof openModelDialog === 'function') {
        await openModelDialog({ focus: null });
        return;
      }
      await showModelConfig();
      return;
    }

    if (intent.kind === 'key') {
      // `/model key` 后面没给值：直接把人送进问 Key 的那一步，而不是让他再背一条用法。
      if (intent.value === '') {
        if (refuseWhenBusy('模型设置等这一轮结束后再打开。')) return;
        if (typeof openModelDialog === 'function') {
          await openModelDialog({ focus: 'key' });
          return;
        }
        reply('输入 /model 即可设置 API Key。', { tone: 'warn' });
        return;
      }
      if (intent.moved === true) {
        reply('这看起来是 API Key', { tone: 'info', detail: '已按 API Key 处理（模型名请用 /model <模型名>）' });
      }
      await applyApiKey(intent.value);
      return;
    }

    if (intent.kind === 'invalid') {
      reply('模型名不能有空格', { tone: 'warn', detail: '用法：/model <模型名> · /model key <Key>' });
      return;
    }

    await applyModel(intent.value);
  }

  // 设置 API Key：**先验证，再保存**。
  // 顺序很重要：把还在输入的 Key 直接存下去，用户要到下一次发消息才知道它是错的，
  // 那时屏幕上出现的是一句「API Key 无效」——他只会怀疑自己抄错了 Key，而真正的问题
  // 可能是别的东西（模型名、端点、额度）。当场验证一次，答案立刻就有。
  async function applyApiKey(value) {
    const key = sanitizeInput(value);
    if (key === '') {
      reply('API Key 不能为空。', { tone: 'warn' });
      return;
    }
    // 先验证再保存的纪律住在 model 层的 verifyAndSaveApiKey（向导与挽救路径共用）。
    const step = await verifyAndSaveApiKey({ apiKey: key, configPath, probeKey, save: saveConfig });
    if (step.outcome === 'rejected') {
      reply('这个 Key 被拒绝了', {
        tone: 'error',
        detail: '没有保存。核对后再试一次：/model key <你的 Key>',
      });
      return;
    }
    if (step.outcome === 'failed') {
      reply('保存失败', { tone: 'error', detail: fact(step.error) });
      return;
    }
    const tail = step.verdict.status === 'ok'
      ? `已验证，可用模型 ${step.verdict.models.length} 个`
      : `暂时无法验证（${step.verdict.reason}）`;
    reply('密钥已更新', { tone: 'success', detail: `${maskKey(key)} · ${tail}` });
  }

  // 设置模型名：能拿到真实列表就对着它核对——写错一个字母不会当场报错，而是等到发消息时
  // 换回一句莫名其妙的 HTTP 错误（真实事故：`deepseek-flash` 这类不存在的名字被存了下来）。
  async function applyModel(value) {
    const name = sanitizeInput(value);
    if (name === '') {
      reply('模型名不能为空。', { tone: 'warn' });
      return;
    }
    let known = null;
    if (listModels !== null) {
      try {
        known = await listModels();
      } catch {
        known = null; // 核对不了就照常保存：没有 Key 或连不上时不该挡着用户改配置。
      }
    }
    if (Array.isArray(known) && known.length > 0 && !known.includes(name)) {
      reply('列表里没有这个模型名', {
        tone: 'warn',
        detail: `可用：${known.join('、')}`,
      });
      return;
    }
    try {
      await saveConfig({ configPath, model: name });
    } catch (error) {
      reply('保存失败', { tone: 'error', detail: fact(error) });
      return;
    }
    // 切模型之后立刻校验档位（P16）：原档位在新模型上不合法就重置为自动，
    // 并**如实说一句**。两种静默都不接受——静默保留一个无效档位会让下一轮请求 400，
    // 静默清掉会让用户以为 max 还开着。
    if (effortState !== null && typeof effortState.syncWithModel === 'function') {
      const synced = await effortState.syncWithModel();
      if (synced.reset === true && typeof synced.reason === 'string') {
        reply('档位已重置', { tone: 'warn', detail: synced.reason });
      }
    }
    reply('模型已更新', {
      tone: 'success',
      detail: Array.isArray(known) && known.length > 0 ? `${name} · 已在可用列表里` : name,
    });
  }

  // —— /effort：档位的唯一用户可见面（P11 四档直通 / P15 不新开 UI 区域）——
  //
  // 生效时机是**下一轮**：这里只改一个本地变量，下一次组请求时带上。
  // 与既有的队列语义天然同构（控制器本来就是「正在跑的一轮不变、下一条输入生效」），
  // 因此不需要新机制，也绝不去打断在跑的轮——那是 /stop 与 /now 的事。
  async function runEffortCommand(args) {
    if (effortState === null) {
      reply('档位不可用', { tone: 'warn', detail: '当前没有可用的模型配置。' });
      return;
    }
    const intent = parseEffortArg(sanitizeInput(args));
    const caps = await effortState.capability();

    // 无参 = 回显当前档位 + 可用档位（grokbuild 的做法，这是主入口）。
    if (intent.kind === 'show') {
      if (!caps.supported) {
        reply('思考 自动', { tone: 'info', detail: unsupportedEffortReason(caps) });
        return;
      }
      reply(`当前 ${effortState.describe()}`, {
        tone: 'info',
        detail: `可用 ${caps.levels.join('、')} · 自动 = 按默认档位下发 · 下一轮生效`,
      });
      return;
    }
    if (intent.kind === 'invalid') {
      reply('档位不可用', { tone: 'warn', detail: `可用的是 ${EFFORT_LEVELS.join('、')}，或「自动」。` });
      return;
    }

    // 能在本地拒绝的，就别发出去让 API 打回来（grokbuild 的教训）。
    const result = await effortState.set(intent.kind === 'auto' ? null : intent.level);
    if (!result.ok) {
      // 主文案守住 2–6 字，理由进 detail（铁律 3）。
      reply('档位不可用', { tone: 'warn', detail: result.reason });
      return;
    }
    reply(`思考 ${effortState.describe()}`, { tone: 'success', detail: '下一轮生效' });
  }

  // —— /reasoning：思考全文的**按需**入口（P21，对齐上游对话样式规格书:117 的
  // 「reasoning 内容的唯一展示入口是 §4.9」）——
  //
  // 与实时区的关系：正在想的时候，最近两行已经贴在框的上方（printThinkingPreview），
  // 但那只活在当前那一瞬、跑完就没了。**全文**（`max` 档可能几万字符）只在用户开口问时
  // 才画出来，落进 scrollback 供回看——这条命令就是那个「开口问」的入口。
  //
  // 为什么不做成展开/折叠：终端没有折叠组件，所以走「实时两行 + 命令查看」而不是 grokbuild 的 ctrl+e——
  // CLI 的键盘被常驻 readline 占着，加全局键位复杂且会与输入抢键。
  //
  // 有内容时（无论能力表怎么说）不进下面的归类，直接灰显重放全文；**没内容**时用户实际会看到
  // **两条**不同主文案（R6：原计划只做了两态，把 unsupported 丢了）：
  //   不支持查看   能力表明确说不支持思考 → 5 字主文案（铁律 3），
  //                上游那句原文 `当前模型不支持查看` 进 detail
  //   无思考内容   其余一切「没内容」的情形**合并**成这一条：模型支持但本轮没有思考、
  //                本进程还没跑过任何一轮（重启之后）、以及未注入档位状态（连能力都没查）。
  //                它的 detail 里**始终**带着「全文不跨重启保留」那句，把「本进程无轮」与
  //                「本轮无思考」两种可能一并说清——合并而不区分是刻意的：重启后屏幕上明明
  //                重演了「思考 12 秒」，此时只答「本次无输出或该模型不支持」才是**假事实**。
  // 换言之，用户看到的是「两条主文案 + 一句始终在场的重启说明」，不是三条各自成句的答复。
  async function runReasoningCommand() {
    // 先读内容，**再**用能力判定归类（R6）。顺序不能反：思考采集是**无条件**的
    // （deepseek-client.mjs 收到 reasoning_content 就经 onReasoning 回调，不看能力表），
    // 所以「屏幕上出现过思考行」与「能力表说支持」可以不一致——网关的 base_url 没声明
    // model_capabilities、或官方新模型还没进表时，端点仍可能返回 reasoning_content。
    // 此时若先看能力、回一句「不支持查看」，就是一条与屏幕矛盾的**假事实**——而铁律 3/R6
    // 说这比不回答更糟。
    const parts = readReasoning === null ? null : readReasoning();
    const hasContent = Array.isArray(parts)
      && parts.some((part) => typeof part?.text === 'string' && part.text !== '');
    if (hasContent) {
      for (const part of parts) {
        const body = part?.text;
        if (typeof body !== 'string' || body === '') continue;
        // 渲染器没有这个能力时（测试替身 / 自定义渲染器）安静跳过，不让输入框崩掉。
        if (typeof renderer.printReasoning === 'function') renderer.printReasoning(body);
      }
      return;
    }
    // **没有内容时**才用能力判定**归类**原因：模型根本不支持思考 → 说「不支持查看」；
    // 支持但本次没有 → empty 态。主文案 5 字（铁律 3 / R7），上游那句原文进 detail。
    if (effortState !== null && typeof effortState.capability === 'function') {
      const caps = await effortState.capability();
      if (caps.supported === false) {
        reply('不支持查看', { tone: 'info', detail: '当前模型不支持查看' });
        return;
      }
    }
    // 上游那句 22 字的原文放 detail——它是**展开详情**级别的说明，
    // 不是状态行主文案（R7：原计划把它当主文案用，超了 2–6 字三倍多）。
    // 「全文不跨重启保留」同时说明了「重启后只重演耗时」，不再复述一遍。
    reply('无思考内容', {
      tone: 'info',
      detail: '没有可查看的思考内容（本次无输出或该模型不支持）· 全文不跨重启保留',
    });
  }

  async function showModelConfig() {
    // 状态归类（四态 + 损坏标记）来自 model 层的 readModelState，与头部面板、引导共用同一份读法。
    const state = await readModelState({ configPath, env, load: loadConfig });
    if (state.state === 'invalid') {
      reply('配置已损坏', { tone: 'error', detail: '请用 /model 重新设置。' });
      return;
    }
    if (state.state === 'unreadable') {
      reply('读取失败', { tone: 'error', detail: fact(state.error) });
      return;
    }
    const config = state.config;
    if (state.state === 'empty') {
      reply('尚未配置模型', { tone: 'warn', detail: '输入 /model 开始设置' });
      return;
    }
    // 一行一项、左列对齐（与启动头部面板同一套观感），扫一眼就知道现在用的是哪套配置。
    // 模型名那格被写坏时，那格里是 Key（真实事故的形状）：只给脱敏串——
    // 旧版在这里把整串 Key 打进了终端，恰恰违反本模块「Key 不上屏」的硬约束。
    reply(row('模型', state.corruptModel ? maskKey(config.model) : (config.model ?? '未设置')));
    reply(row('端点', config.baseUrl));
    reply(row('API Key', maskKey(config.apiKey)));
    // 思考强度与模型是绑在一起的（切模型会重置档位），所以这两件事本来就该一起看（P15）。
    if (effortState !== null) reply(row('思考强度', effortState.describe()));
    // 环境变量会盖住配置文件里的 Key（临时覆盖，计划就这么定的）。不说出来的话，
    // 用户会对着「我明明配好了」百思不得其解——所以这一行必须点名。
    if (config.apiKeySource === 'env') {
      reply('API Key 来自环境变量 DEEPSEEK_API_KEY', { tone: 'warn', detail: '它当前覆盖了配置文件里的设置' });
    }
    // 配置是给人看的，也要告诉人怎么改——「不知道怎么配」正是新用户卡住的地方。
    reply('修改：输入 /model', { tone: 'info' });
    // 已经写坏的那种（模型名位置上放着 API Key）要点名说清，否则用户只会看到后面那句
    // 让人越走越远的「API Key 无效」。
    if (state.corruptModel) {
      reply('模型名那一行看起来是 API Key', { tone: 'warn', detail: '输入 /model 重新设置，会帮你清掉' });
    }
  }

  async function runSessionsCommand() {
    if (typeof listSessions !== 'function') {
      reply('暂不支持查看会话。', { tone: 'warn' });
      return;
    }
    let sessions;
    try {
      sessions = await listSessions();
    } catch (error) {
      reply('读取失败', { tone: 'error', detail: fact(error) });
      return;
    }
    if (!Array.isArray(sessions) || sessions.length === 0) {
      reply('没有可用会话。');
      return;
    }
    for (const session of sessions) {
      reply(sessionRowLabel(session));
    }
  }

  // /skills：技能清单只读列出。纯信息输出，没有任何选择交互（铁律 1/11）；
  // 技能怎么装/删 = 往目录里放/删文件夹（ADR-0013，v1 不做导入/删除命令）。
  // 来源标签照桌面版：项目 / 全局 / 随应用分发 / 内置。
  const SKILL_SOURCE_LABELS = Object.freeze({ project: '项目', global: '全局', bundled: '随应用分发', builtin: '内置' });
  async function runSkillsCommand() {
    if (listSkills === null) {
      reply('暂不支持查看技能。', { tone: 'warn' });
      return;
    }
    let catalog;
    try {
      catalog = await listSkills();
    } catch (error) {
      reply('读取失败', { tone: 'error', detail: fact(error) });
      return;
    }
    const active = Array.isArray(catalog?.active) ? catalog.active : [];
    const shadowed = Array.isArray(catalog?.shadowed) ? catalog.shadowed : [];
    const errors = Array.isArray(catalog?.errors) ? catalog.errors : [];
    if (active.length === 0 && shadowed.length === 0 && errors.length === 0) {
      reply('未发现技能。', { detail: '把技能文件夹放进 ~/.wwriting/skills 或项目 skills/ 目录即生效。' });
      return;
    }
    if (active.length > 0) {
      reply(`生效 ${active.length}`);
      for (const skill of active) {
        const tag = SKILL_CATEGORY_TAGS[skill?.category ?? ''];
        const label = tag ? `- [${tag}] ${skill.name}` : `- ${skill.name}`;
        reply(`${label}（${SKILL_SOURCE_LABELS[skill?.source] ?? skill?.source ?? '未知'}）：${typeof skill?.description === 'string' ? skill.description : ''}`);
      }
    }
    if (shadowed.length > 0) {
      reply(`被覆盖 ${shadowed.length}`);
      for (const skill of shadowed) {
        reply(`${skill?.name}（${SKILL_SOURCE_LABELS[skill?.source] ?? skill?.source ?? '未知'}）：被更高优先级同名技能覆盖，不生效。`);
      }
    }
    if (errors.length > 0) {
      reply(`解析失败 ${errors.length}`);
      for (const item of errors) {
        const name = String(item?.dir ?? '').split(/[\\/]/u).pop();
        reply(`${name}：${item?.error ?? '解析失败'}`);
      }
    }
  }

  // /plan：任务计划的按需回看（P10「折叠态即回看态」在终端的第二入口——
  // Run 当场那份已随 plan_updated 落进 scrollback，这里看的是**当前**一份，
  // 重启后 / 下一轮开始后仍可问「刚才那轮计划到哪了」）。
  async function runPlanCommand() {
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
  async function runCompactCommand() {
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

  async function runResumeCommand(args) {
    if (typeof resumeSession !== 'function') {
      reply('暂不支持切换会话。', { tone: 'warn' });
      return;
    }
    let target = args;
    // 无参 = 打开交互式挑选（P23，对齐 `claude` 的会话选择）。
    // 挑选器要独占按键，而常驻 readline 会跟着一起吃键，所以让位由**注入方**负责
    // （cli.mjs 里用 input.suspend() → 挑选 → input.resume()，与 /model 向导同一套路）。
    if (target === '') {
      if (refuseWhenBusy('会话挑选等这一轮结束后再打开。')) return;
      if (chooseSession === null) {
        reply('/resume <会话ID>', { tone: 'warn', detail: '当前终端不支持交互式挑选。' });
        return;
      }
      try {
        target = await chooseSession();
      } catch (error) {
        // 挑选器自己抛（例如它内部 suspend() 失败）必须在这里收敛：输入层是
        // `void handler.handle(text)` 调用的，未捕获的抛出会变成**未处理拒绝**（Node 默认终止进程），
        // 而且输入框会被留在 suspend 状态。与下面 resumeSession 失败共用同一句事实。
        reply('切换失败', { tone: 'error', detail: fact(error) });
        return;
      }
      // Esc 取消：什么都不做，也什么都不说。屏幕上刚刚闪过的菜单已经收起来了，
      // 再补一句「已取消」只是噪音（铁律 3：成功不弹 Toast，取消同理）。
      if (typeof target !== 'string' || target === '') return;
    }
    try {
      await resumeSession(target);
      reply('已切换会话', { tone: 'success', detail: target });
    } catch (error) {
      reply('切换失败', { tone: 'error', detail: fact(error) });
    }
  }

  // 停止只停当前这一轮：不解锁会话、不清空队列（D14）。清空队列会让「停止后接着写」丢内容。
  // 真的停下来了就不再回一句「已停止」——那一轮的终态行马上会说同一件事（铁律 3：成功不弹 Toast）。
  // 空闲时相反，必须如实说明：否则用户会以为自己的停止没生效。
  function runStopCommand() {
    const result = getController().stop();
    if (!(result && result.stopped === true)) reply('空闲中');
  }

  // 「立即」：把队首那条输入提上来跑，打断当前轮（D14 的语义，由控制器实现）。
  //
  // 为什么必须是命令而不是裸词：写作正文里「立即」是个正常词（「他立即转身」），
  // 裸词触发会吞掉用户的正文。斜杠命令与既有命令集同构，也天然没有误判风险。
  //
  // 队列为空时如实说明，不静默：否则用户以为提升生效了，实际上什么都没有发生。
  async function runNowCommand() {
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

  // /rename：给当前会话起名（规格 2026-10-07 D3）。无参 = 回显当前标题——
  // 「我起过名字没有」是这条命令最常见的开场，直接答比甩一句用法更有用。
  async function runRenameCommand(args) {
    const controller = getController();
    const title = sanitizeInput(args);
    if (title === '') {
      const current = typeof controller.snapshot === 'function' ? controller.snapshot()?.title ?? '' : '';
      reply(current === '' ? '还没有标题' : current, { tone: 'info', detail: '用法：/rename <标题>' });
      return;
    }
    if (typeof controller.renameSession !== 'function') {
      reply('暂不支持改名。', { tone: 'warn' });
      return;
    }
    try {
      const result = await controller.renameSession(title);
      reply('已重命名', { tone: 'success', detail: result.title });
    } catch (error) {
      reply('改名失败', { tone: 'error', detail: fact(error) });
    }
  }

  // /archive：归档当前会话并开新会话接续（规格 2026-10-07 D4）。「收起来」与「继续写」
  // 是一次动作——归档后当前会话不再出现在 -c 与挑选列表里，人却还坐在终端前，
  // 留在一个已归档的会话里打字只会制造「已归档却还在写」的矛盾状态。
  // 忙碌拒绝：归档半轮（终态还没落盘）是假账。
  async function runArchiveCommand() {
    if (doArchive === null) {
      reply('暂不支持归档。', { tone: 'warn' });
      return;
    }
    if (refuseWhenBusy('归档等这一轮结束后再进行。')) return;
    try {
      await doArchive();
      reply('已归档', { tone: 'success', detail: '已开新会话接续' });
    } catch (error) {
      reply('归档失败', { tone: 'error', detail: fact(error) });
    }
  }

  // /cancel：撤回队首排队输入（规格 2026-10-07 D7）。与 /now 对称——那边把队首提上来跑，
  // 这边把队首拿掉不跑。运行中可用（撤回本来就是排队场景的动作）；队列空与 /now 同句。
  // 屏幕反馈零新增：撤回事件的「排队已取消」终态行与实时区整表替换由事件桥负责。
  async function runCancelCommand() {
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
  async function runRetryCommand() {
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
      const tail = await controller.readTailEvents({ maxBytes: 256 * 1024 });
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
    if (modeState === null) {
      reply('切换不可用', { tone: 'warn', detail: '当前会话没有可切换的权限模式。' });
      return;
    }
    const controller = getController();
    if (controller !== null && controller.isBusy()) {
      reply('运行中', { tone: 'warn', detail: '权限模式等这一轮结束后再切换。' });
      return;
    }
    if (modeState.get() === 'yolo') {
      modeState.set('normal');
      return;
    }
    // 进 YOLO 是「变弱」：没有把关界面（选择器）就不能放行。
    if (openPicker === null) {
      reply('切换不可用', { tone: 'warn', detail: '进入 YOLO 需要确认，这里给不出确认界面。' });
      return;
    }
    try {
      const picked = await openPicker({
        title: 'YOLO 会自动执行写入和控制操作。确认开启？',
        items: YOLO_CHOICES, // 已是 [{ id, label }] 且冻结；选择器对 items 只读，无需克隆
        hint: '↑/↓ 选择 · 回车确认 · Esc 取消',
        // Esc 也是一次真实的决定，留一行痕迹（与权限确认卡「拒绝留痕」同理）；
        // 确认开启用默认 summary（`❯ 确认开启`），事后能看出当时选的是哪一项。
        cancelSummary: `${MENU_CURSOR} ${YOLO_CHOICES.find(({ id }) => id === 'cancel').label}`,
      });
      if (picked !== null && picked.item.id === 'confirm') modeState.set('yolo');
    } catch (error) {
      // 选择器/终端半路抛错：收敛成一条事实，绝不变成未处理拒绝（与 /model 同款）。
      reply('切换失败', { tone: 'error', detail: fact(error) });
    }
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

  async function handle(text, { immediate = false } = {}) {
    if (typeof text !== 'string') return { action: 'ignored' };
    const trimmed = text.trim();
    if (trimmed === '') return { action: 'ignored' };

    const decision = pendingDecision();
    if (decision !== null && (await answerDecision(decision, trimmed))) return { action: 'handled' };

    // 下面两条路都是「把整行原文当普通聊天请求提交」，因此共用一个出口：
    //   · 不是斜杠命令（parseSlashCommand 返回 null）；
    //   · 是 `/init` —— 唯一一条**登记在命令表里、却按普通聊天请求提交**的命令。
    //
    // 为什么 /init 不进 runCommand 的 switch：统一规格书:371 说它是一条普通聊天请求，
    // :374 说它与其他指令走完全相同的 Agent 循环与事件流、并保留用户发送的原文与附加要求。
    // 做成本地命令就会有一处「特殊化的 /init 输出」，那正是 Q14 明确不做的。
    // 只认整词 `init`，`/initialize` 之类照常落到「不认识这个命令」。
    const parsed = parseSlashCommand(trimmed);
    if (parsed === null || parsed.name === 'init') {
      // 提交的是 trimmed（整行原文），不是 parsed?.name：附加要求必须一字不落跟着走。
      // immediate（Ctrl+S）只对**普通正文**有意义——/init 是登记在命令表里的命令，
      // 命令草稿与回车完全同路、绝不打断/提升（ADR-0021 决定 3，复查确立）。
      submit(trimmed, { immediate: parsed === null && immediate });
      return { action: 'submit' };
    }

    // 命令的输出是一整块：它上面是上一个输入框的下框线，下面是下一个输入框的上框线，
    // 两条线就是分隔，所以这里不需要再补任何收尾线。
    return { action: await runCommand(parsed) };
  }

  // 一条斜杠命令 → 一个动作。返回 'handled'（就地回答完了）| 'quit'（正在退出）。
  async function runCommand(parsed) {
    switch (parsed.name) {
      case 'model':
        await runModelCommand(parsed.args);
        return 'handled';
      case 'effort':
        await runEffortCommand(parsed.args);
        return 'handled';
      case 'reasoning':
        await runReasoningCommand();
        return 'handled';
      case 'plan':
        await runPlanCommand();
        return 'handled';
      case 'compact':
        await runCompactCommand();
        return 'handled';
      case 'sessions':
        await runSessionsCommand();
        return 'handled';
      case 'skills':
        await runSkillsCommand();
        return 'handled';
      case 'resume':
        await runResumeCommand(parsed.args);
        return 'handled';
      case 'stop':
        runStopCommand();
        return 'handled';
      case 'retry':
        await runRetryCommand();
        return 'handled';
      case 'now':
        await runNowCommand();
        return 'handled';
      case 'cancel':
        await runCancelCommand();
        return 'handled';
      case 'rename':
        await runRenameCommand(parsed.args);
        return 'handled';
      case 'archive':
        await runArchiveCommand();
        return 'handled';
      case 'help':
        for (const line of helpLines()) reply(line);
        return 'handled';
      case 'quit':
        reply('已退出');
        await shutdown();
        return 'quit';
      default:
        reply(`不认识 ${parsed.name === '' ? '这个命令' : `/${parsed.name}`}，输入 /help 查看可用命令。`, { tone: 'warn' });
        return 'handled';
    }
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

  return { handle, handleControl };
}
