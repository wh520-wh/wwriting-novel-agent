// 模型设置向导：首次使用的引导，以及 `/model` 打开的重新配置，共用这一套。
//   ① 填入 API Key  →  ② 选择要用的模型
//
// 每一步都只有一个问题、一个出口：
//   - Key 当场验证（GET /models）：有效才保存，被拒就原地重问。用户不会再遇到
//     「看起来存进去了，发消息时却是 401」这种隔了一层才发现的问题。
//   - 模型从端点返回的**真实列表**里选，所以不可能选中不存在的模型名
//     （真实事故：用户手打了 `deepseek-flash`，之后每轮请求都在服务端失败）。
//   - 每一步都能跳过：没有 Key 也照样进得来，只是发消息时会提示「未配置」。
//
// 关于 Key 的输入：**不再做隐藏回显**。那套做法（覆写 readline 的私有出口）既脆弱又难懂，
// 屏幕上只留下一个空提示符，用户根本看不出自己粘进去没有；代价是密钥会留在终端 scrollback 里，
// 这个取舍由用户拍板。展示环节（配置行、确认行）依旧只出现脱敏串。
//
// 输入通道自带：选择器用原始按键（readline 已让开），文本用临时的 readline（readOneLine）。
// 首次引导跑在对话面的 readline 建立之前，`/model` 则先 suspend 再跑，两者都不会互相抢键。
import { DEFAULT_BASE_URL, loadModelConfig, readModelState, looksLikeApiKey, maskApiKey, sanitizeInput, saveDeepSeekConfig, verifyAndSaveApiKey } from '../model/config.mjs';
import { fact } from '../fact.mjs';

// 厂商清单：目前只开发 DeepSeek 一个（首版只接官方端点）。
// createKeyUrl 是给用户看的「去哪拿 Key」，这是新用户最缺的那条信息。
export const PROVIDERS = Object.freeze([
  {
    id: 'deepseek',
    label: 'DeepSeek 官方',
    baseUrl: DEFAULT_BASE_URL,
    createKeyUrl: 'https://platform.deepseek.com',
  },
]);

// 菜单里的两个特殊项：「自己输入模型名」与「换 API Key」。
// 换 Key 不另开一步菜单——它就挂在模型列表里，多打一个键就能到。
export const MANUAL_MODEL_ID = '__manual__';
export const CHANGE_KEY_ID = '__change_key__';

export const STEP_KEY = '① 填入 API Key';
export const STEP_MODEL = '② 选择要用的模型';
export const STEP_HINT = '↑/↓ 选择 · 回车确认 · Esc 跳过这步';
const SELECT_HINT = '↑/↓ 选择 · 回车确认 · Esc 不改动';

// createOnboarding({
//   renderer, select, readLine, configPath,
//   save, load, env, reconfigure, focus, verifyKey, listModels,
// })
//   select    createSelector(...) 的返回值——上下键选择
//   readLine  readOneLine 的偏函数，问 Key / 问模型名用
//   verifyKey (apiKey) => Promise<{ status: 'ok'|'invalid'|'unknown', models, reason }>
//             拿这个 Key 去问端点「它能不能用」，顺便把真实模型列表带回来。没有它就只能存下再说。
//   listModels () => Promise<string[]>：用配置里现有的 Key 取列表（重新配置时用）
//   reconfigure  false = 首次设置；true = `/model` 打开的重新配置（不问已经有的东西）
//   focus        'key' 表示直接从「问 Key」开始（`/model key` 没给值时就送到这里）
// 返回 { start, isActive, changedConfig }
export function createOnboarding({
  renderer,
  select,
  readLine,
  configPath,
  save = saveDeepSeekConfig,
  load = loadModelConfig,
  env = process.env,
  reconfigure = false,
  focus = null,
  verifyKey = null,
  listModels = null,
} = {}) {
  if (!renderer || typeof renderer.printStatus !== 'function') {
    throw new Error('引导页需要一个可用的渲染器。');
  }

  const provider = PROVIDERS[0];
  let active = false;
  let changed = false;

  // 正文缩进两格表示「这是上一条标题的结果」，标题本身不缩进——一屏看下来就是一条清单。
  const say = (text) => renderer.printStatus(text, { final: true });
  const result = (text) => renderer.printStatus(`  ${text}`, { final: true });
  const warn = (text) => renderer.printStatus(text, { final: true, tone: 'warn' });

  // 现在是什么。读不出来（含损坏）按「还没配好」算：向导本来就是来修它的。
  // 四态归类与「损坏 + 挽救」的判定都在 model 层的 readModelState 里，
  // 与头部面板、/model 展示共用同一份读法——这里只做「归到向导自己的形状」。
  async function readState() {
    const state = await readModelState({ configPath, env, load });
    if (state.config === null) {
      return { hasKey: false, model: null, corruptModel: false, salvagedKey: null, apiKey: null, baseUrl: DEFAULT_BASE_URL };
    }
    const config = state.config;
    return {
      hasKey: config.configured === true,
      model: state.corruptModel ? null : config.model,
      corruptModel: state.corruptModel,
      salvagedKey: state.salvagedKey,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    };
  }

  // 用户敲了斜杠命令：这里正开着交互流程，命令先放一放——但要说清怎么出去，
  // 免得它被当成 API Key 或模型名存进去（上一个版本真踩过这个坑）。
  function isCommandLike(text) {
    return typeof text === 'string' && text.trimStart().startsWith('/');
  }

  async function saveQuietly(patch, failureNote) {
    try {
      await save({ configPath, ...patch });
      changed = true;
      return true;
    } catch (error) {
      warn(fact(error, failureNote));
      return false;
    }
  }

  // 拿配置里现有的 Key 取真实模型列表（重新配置时先跑一次：顺便确认这个 Key 现在还能用）。
  async function tryList() {
    if (typeof listModels !== 'function') return [];
    result('正在向端点要可用模型……');
    try {
      return await listModels();
    } catch (error) {
      warn(fact(error, '没能取到模型列表，可以自己输入模型名。'));
      return [];
    }
  }

  // —— ① API Key ——
  // 返回 { state: 'saved'|'skipped'|'cancelled', models }
  async function askKey() {
    say(reconfigure ? '填入 API Key' : STEP_KEY);
    result(`在 ${provider.createKeyUrl} 创建后粘贴进来，回车即验证。`);
    result('直接回车 = 先跳过（发消息时会提示「未配置」）。');
    for (;;) {
      const line = await readLine({});
      // 输入流没了或用户按了 Ctrl+C：这不是「跳过」，是「退出这一步」——
      // 一步步问下去的流程最要紧的就是每个岔口都有干净的出口。
      if (line === null) return { state: 'cancelled', models: [] };
      const key = sanitizeInput(line);
      if (key === '') return { state: 'skipped', models: [] };
      if (isCommandLike(key)) {
        warn('设置还没结束，命令先放一放；想退出按 Ctrl+C。');
        continue;
      }

      // 先验证再保存的纪律住在 model 层的 verifyAndSaveApiKey（/model key 与挽救路径共用）。
      // 把还在输入的 Key 直接存下去，用户要到下一次发消息才知道它是错的，
      // 那时屏幕上出现的是一句「API Key 无效」——他只会怀疑自己抄错了 Key。
      const step = await verifyAndSaveApiKey({ apiKey: key, configPath, probeKey: verifyKey, save });
      if (step.outcome === 'rejected') {
        warn(`这个 Key 被拒绝了：${step.verdict.reason}`);
        result('重新粘贴一次，或直接回车跳过。');
        continue;
      }
      if (step.outcome === 'failed') {
        warn(fact(step.error, '保存 API Key 失败，请稍后再试。'));
        return { state: 'cancelled', models: [] };
      }
      if (step.verdict.status === 'ok') {
        result(`API Key 有效 · ${step.verdict.models.length} 个可用模型`);
        return { state: 'saved', models: step.verdict.models };
      }
      result(`API Key 已保存（暂时没能验证：${step.verdict.reason}）`);
      return { state: 'saved', models: [] };
    }
  }

  // —— ② 模型 ——
  // 手输模型名。两道守卫：
  //   1. 以 API Key 样式出现的一律拒收（那多半是粘错了地方）；
  //   2. 手里有真实列表时，不在列表里的一律拒收（`deepseek-flash` 这类名字就是没有的）。
  // 返回模型名或 null（回车返回上一级）。
  async function askModelName(models) {
    result('输入模型名（回车返回）');
    for (;;) {
      const line = await readLine({});
      if (line === null) return null;
      const name = sanitizeInput(line);
      if (name === '') return null;
      if (isCommandLike(name)) {
        warn('设置还没结束，命令先放一放；想退出按 Ctrl+C。');
        continue;
      }
      if (looksLikeApiKey(name)) {
        warn('这看起来是 API Key，不是模型名。');
        result('输入模型名（回车返回）');
        continue;
      }
      if (models.length > 0 && !models.includes(name)) {
        warn(`列表里没有这个模型名：可用 ${models.join('、')}`);
        result('输入模型名（回车返回）');
        continue;
      }
      return name;
    }
  }

  async function askModel(initialModels) {
    let models = initialModels;
    for (;;) {
      if (models.length === 0) models = await tryList();
      if (!reconfigure) say(STEP_MODEL);
      const items = [
        ...models.map((id) => ({ id, label: id })),
        { id: MANUAL_MODEL_ID, label: '✎ 自己输入模型名' },
      ];
      if (reconfigure && (await readState()).hasKey) {
        items.push({ id: CHANGE_KEY_ID, label: '⌘ 换 API Key' });
      }
      const chosen = await select.ask({
        title: null,
        items,
        hint: reconfigure ? SELECT_HINT : STEP_HINT,
        // 选中不收尾：确认行由 start() 在存下之后打，免得存失败还先报成功。
        summary: null,
        cancelSummary: null,
      });
      if (chosen === null) return null;

      if (chosen.item.id === CHANGE_KEY_ID) {
        const outcome = await askKey();
        if (outcome.state === 'saved') models = outcome.models.length > 0 ? outcome.models : await tryList();
        continue; // 换完 Key 回来接着选模型（列表可能已经不一样了）
      }
      if (chosen.item.id === MANUAL_MODEL_ID) {
        const name = await askModelName(models);
        if (name !== null) return name;
        continue; // 手输被跳过：回到菜单，而不是把整个向导关掉
      }
      return chosen.item.id;
    }
  }

  async function start() {
    active = true;
    const before = await readState();

    if (reconfigure) {
      // 先把「现在是什么」摆出来：用户做的每个选择都要能对照现状。
      if (before.hasKey) {
        const endpoint = before.baseUrl === DEFAULT_BASE_URL ? '' : ` · 端点 ${before.baseUrl}`;
        say(`当前：${before.model ?? '未设置模型'} · ${maskApiKey(before.apiKey)}${endpoint}`);
      } else {
        say('尚未配置模型。');
      }
    if (before.corruptModel && before.salvagedKey === null) {
      // 理论上进不来（两个判据用的是同一个形状），留一条兜底：坏了就说清楚要重设。
      result('模型名那一格之前存进了一个 API Key，选一个真实模型就会覆盖它。');
    }
    }

    let models = [];
    let hasKey = before.hasKey;

    if (before.corruptModel) {
      result('模型名那一格之前存进了一个 API Key，会把它挪回 API Key 的位置。');
    }

    // 从被写坏的那一格把 Key 捞回来：先验一次。通过就直接修好配置——那一格里的 Key
    // 通常正是用户当初想设的那个，捞回来他一个字符都不用重新粘贴。
    // 注意不能只在「本来没有 Key」时才试：真实那份配置里 api_key 那一格是别的垃圾值，
    // `configured` 为真，可它根本不能用。
    if (before.salvagedKey !== null) {
      const step = await verifyAndSaveApiKey({ apiKey: before.salvagedKey, configPath, probeKey: verifyKey, save });
      if (step.outcome === 'rejected') {
        // 捞出来的那个也不好使：当作没配好，正常问一次。
        hasKey = false;
      } else if (step.outcome === 'saved') {
        result(`已找回 API Key：${maskApiKey(before.salvagedKey)}`);
        hasKey = true;
        models = step.verdict.models;
      } else {
        warn(fact(step.error, '找回的 API Key 没能存下来。'));
      }
    }

    // 要问 Key 的两种情况：用户点名要换（/model key 没给值），或者压根还没有。
    const askForKey = focus === 'key' || !hasKey;
    if (askForKey) {
      const outcome = await askKey();
      if (outcome.state === 'saved') {
        models = outcome.models;
      } else {
        active = false;
        if (reconfigure) {
          if (outcome.state === 'cancelled') {
            say('未做改动。');
            return;
          }
          warn('已跳过 API Key：发消息时会提示「未配置」，输入 /model 随时可以补上。');
          return;
        }
        // 首次设置：跳过也要写下一份最小配置，标记「问过了」，否则每次启动都会再问一遍。
        await saveQuietly({}, '无法保存配置，下次启动会再问一次。');
        warn('已跳过设置：发消息时会提示「未配置」，输入 /model 随时可以补上。');
        return;
      }
    } else if (reconfigure) {
      // 已经有 Key：取一次真实列表（顺便确认这个 Key 现在还能用）。
      models = await tryList();
    }

    const model = await askModel(models);
    active = false;
    if (model === null) {
      // 重新配置时 Esc 是「不改动」，不是失败。
      if (reconfigure) {
        say('未做改动。');
        return;
      }
      warn('还没选模型：发消息时会提示「未配置」，输入 /model 随时可以补上。');
      return;
    }
    if (!(await saveQuietly({ model }, '保存模型失败，请稍后重试。'))) return;
    say(reconfigure ? `设置完成：模型 ${model}` : '设置完成，开始吧。');
  }

  return {
    start,
    isActive: () => active,
    changedConfig: () => changed,
  };
}
