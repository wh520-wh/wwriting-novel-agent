// /model、/effort、/reasoning：模型配置与思考强度的命令族。
// 只吃 ctx 里模型域的依赖（configPath/env/load/save/mask/dialog/probeKey/listModels、
// effortState、readReasoning）＋ reply/refuseWhenBusy 两个核心助手；表条目见 commands.mjs。
import { looksLikeApiKey, readModelState, verifyAndSaveApiKey, sanitizeInput } from '../../model/config.mjs';
import { EFFORT_LEVELS, parseEffortArg, unsupportedEffortReason } from '../../model/effort.mjs';
import { fact } from '../../fact.mjs';
import { padDisplayEnd } from '../metrics.mjs';

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

export const modelCommands = [
  { name: 'model', description: '设置模型与 API Key', run: runModelCommand },
  { name: 'effort', description: '思考强度：/effort none|low|high|max|自动', run: runEffortCommand },
  { name: 'reasoning', description: '查看上一轮的思考全文', run: runReasoningCommand },
];

// —— /model：一条命令，三种走法 ——
async function runModelCommand(args, ctx) {
  const { reply, refuseWhenBusy, openModelDialog } = ctx;
  const intent = modelIntent(args);

  if (intent.kind === 'dialog') {
    // 无参 = 打开交互式设置向导（重新选模型 / 补 Key、换 Key），由组合根注入。
    // 没有交互能力时（单元测试、非交互、管道）退回「打印当前配置」——这条路一直是可用的兜底。
    if (refuseWhenBusy('模型设置等这一轮结束后再打开。')) return;
    if (typeof openModelDialog === 'function') {
      await openModelDialog({ focus: null });
      return;
    }
    await showModelConfig(ctx);
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
    await applyApiKey(intent.value, ctx);
    return;
  }

  if (intent.kind === 'invalid') {
    reply('模型名不能有空格', { tone: 'warn', detail: '用法：/model <模型名> · /model key <Key>' });
    return;
  }

  await applyModel(intent.value, ctx);
}

// 设置 API Key：**先验证，再保存**。
// 顺序很重要：把还在输入的 Key 直接存下去，用户要到下一次发消息才知道它是错的，
// 那时屏幕上出现的是一句「API Key 无效」——他只会怀疑自己抄错了 Key，而真正的问题
// 可能是别的东西（模型名、端点、额度）。当场验证一次，答案立刻就有。
async function applyApiKey(value, ctx) {
  const { reply, configPath, probeKey, saveConfig, maskKey } = ctx;
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
async function applyModel(value, ctx) {
  const { reply, listModels, saveConfig, configPath, effortState } = ctx;
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
async function runEffortCommand(args, ctx) {
  const { reply, effortState } = ctx;
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
async function runReasoningCommand(_args, ctx) {
  const { reply, renderer, readReasoning, effortState } = ctx;
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

async function showModelConfig(ctx) {
  const { reply, configPath, env, loadConfig, maskKey, effortState } = ctx;
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
