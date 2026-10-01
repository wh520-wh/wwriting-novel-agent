// DeepSeek 模型配置：只读写 <appDataRoot>/WWriting/config.json（Task 2 的 workspaceStore.configPath）。
// 字段白名单固定为 provider / base_url / model / api_key / model_capabilities；读取时忽略未知字段，
// 保存时只写这几个。
// 环境变量优先于配置文件（DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / DEEPSEEK_MODEL），
// 只作临时覆盖，绝不写回文件——API Key 只落在本机配置文件里（铁律 8）。
// 硬约束：key 绝不出现在错误文本、错误详情或普通日志里；对外展示一律走 maskApiKey。
// 默认端点固定为官方地址；默认模型不硬编码（由 /model 设置），未设置时 model 为 null。
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_BASE_URL = 'https://api.deepseek.com';
// model_capabilities 是**可选**字段：网关用户按模型 id 声明它支持哪些思考档位
// （D9 的第 (ii) 层）。它必须在白名单里——saveDeepSeekConfig 只写 CONFIG_FIELDS 列出的字段，
// 漏了它就会在用户下次 /model 改配置时把手工声明静默删掉（一种无声的数据丢失）。
export const CONFIG_FIELDS = Object.freeze(['provider', 'base_url', 'model', 'api_key', 'model_capabilities']);

// 不可见字符：零宽空格/连接符/方向标记、字节序标记、词连接符。粘贴来的文本里最常见，
// 它们在屏幕上完全看不见，却会让 `key` 与 Key 之间那个空格「消失」——于是整串被当成模型名。
// 一次真实事故就是这样：配置里存下 `model: "keysk-…"`，之后每轮请求都 401，人却一直在查自己的 Key。
const INVISIBLE = /[\u200b-\u200f\u2060\ufeff\u180e]/g;

// 输入归一化：去掉不可见字符、把全角空格当空格、把连续空白压成一个空格、首尾去空白。
// 所有「用户敲进来的一行」都先过这里再解析，解析规则就只需要面对一种形态的输入。
export function sanitizeInput(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(INVISIBLE, '')
    .replace(/[\u3000\u00a0\t\r\n]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

// 「这看起来是 API Key」：`sk-` 后面跟一串足够长的密钥样式字符（真 Key 是 sk- + 32 位）。
//
// 刻意**不**要求 sk- 出现在串首或前面是分隔符：`/model key sk-…` 少打一个空格时会变成
// `keysk-…`，而 `keysk-…` 正是真实事故里被存进模型名那一格的值——前面那份写法要求
// 「sk- 前不是字母数字」，于是刚好把它漏掉了。用长度做判据：模型名里不会出现 16 个
// 连着的密钥样式字符。
export function looksLikeApiKey(value) {
  return typeof value === 'string' && /sk-[A-Za-z0-9_-]{16,}/i.test(value);
}

// 从一个「模型名」里把 API Key 捞出来：`keysk-fd72…` 这种被粘错位置的值里，Key 是完整的。
// 真实事故留下的配置就长这样，捞回来比让人重新去平台复制一次友好得多。
// 与 looksLikeApiKey 同居一处：两把尺子量的是同一种形状，分开放就一定会漂。
export function salvageKeyFromModel(model) {
  if (typeof model !== 'string') return null;
  const match = /(sk-[A-Za-z0-9_-]{16,})/i.exec(model);
  return match === null ? null : match[1];
}

// 模型配置错误：code 用于程序判断，message 是简体中文人话（绝不含 key）。
export class ModelConfigError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'ModelConfigError';
    this.code = code;
    this.details = details;
  }
}

// 脱敏展示：长 key 只留前 3 位与后 4 位；短 key 一个字符都不露；未设置给中文文案。
export function maskApiKey(apiKey) {
  if (typeof apiKey !== 'string' || apiKey.trim() === '') return '未设置';
  const key = apiKey.trim();
  if (key.length < 12) return '****';
  return `${key.slice(0, 3)}****${key.slice(-4)}`;
}

// 读取环境变量：空白视为未设置。
function envValue(env, name) {
  const value = env == null ? undefined : env[name];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

// 端点规范化：去掉末尾斜杠，避免拼接出 //chat/completions。
// 与流式客户端共用同一份语义，配置里读出什么地址，请求就打到什么地址。
export function normalizeBaseUrl(value) {
  if (typeof value !== 'string') return DEFAULT_BASE_URL;
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed === '' ? DEFAULT_BASE_URL : trimmed;
}

// 取白名单里的字符串字段；缺失、非字符串或空白一律视为 null。
// 顺带过一遍 sanitizeInput：手工编辑过的文件里带不可见字符时，读出来就是干净的。
// 与流式客户端共用：key / model 的 trim 规则只有这一处定义。
export function pickString(source, field) {
  const value = source[field];
  if (typeof value !== 'string') return null;
  const clean = sanitizeInput(value);
  return clean === '' ? null : clean;
}

// 取出「当前这个模型」声明的思考档位。形状不对（不是对象套数组）一律当没声明，
// 绝不抛：配置文件是用户手工编辑的，写错一个括号不该让他连模型都用不了。
// 归一化与顺序由 effort.mjs 的 normalizeDeclared 负责，这里只做**取出来**这一件事——
// 「什么档位算合法」只有一处定义，配置层不复制那份判断。
function pickDeclaredLevels(source, model) {
  const table = source.model_capabilities;
  if (table === null || typeof table !== 'object' || Array.isArray(table)) return null;
  if (typeof model !== 'string' || model === '') return null;
  const entry = table[model];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const levels = entry.reasoning_effort_levels;
  return Array.isArray(levels) ? levels.filter((item) => typeof item === 'string') : null;
}

function assertConfigPath(configPath) {
  if (typeof configPath !== 'string' || configPath.trim() === '') {
    throw new ModelConfigError('配置文件路径不能为空。', 'MODEL_CONFIG_INVALID_PATH', { configPath });
  }
}

// 读配置文件：文件不存在（Task 2 的已知行为）视为尚未配置，返回空配置；
// 内容不是有效 JSON 对象时抛中文错误——静默当成未配置会让用户以为自己的 key 丢了。
// 抛出的错误文本只含路径，绝不回显文件内容（可能含 key）。
// exists 用来区分「从没配置过」（首次使用，值得引导）与「配置过但没填 key」（用户已做过选择）。
async function readConfigFile(configPath) {
  let text;
  try {
    text = await readFile(configPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {
        provider: null, base_url: null, model: null, api_key: null,
        model_capabilities: null, exists: false,
      };
    }
    throw new ModelConfigError('无法读取模型配置文件，请检查应用数据目录的权限。', 'MODEL_CONFIG_UNREADABLE', {
      configPath,
      errorCode: error && error.code,
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ModelConfigError(
      '模型配置文件格式不正确，请重新设置模型配置（/model）。',
      'MODEL_CONFIG_INVALID',
      { configPath },
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ModelConfigError('模型配置文件格式不正确，请重新设置模型配置（/model）。', 'MODEL_CONFIG_INVALID', {
      configPath,
    });
  }
  const source = parsed;
  return {
    provider: pickString(source, 'provider'),
    base_url: pickString(source, 'base_url'),
    model: pickString(source, 'model'),
    api_key: pickString(source, 'api_key'),
    model_capabilities: source.model_capabilities ?? null,
    exists: true,
  };
}

// 保存用的读取：文件损坏时按空配置继续——用户此刻正在显式重设配置，
// 用「文件坏了就不能改」挡住他反而更糟。
async function readConfigFileForSave(configPath) {
  try {
    return await readConfigFile(configPath);
  } catch (error) {
    if (error instanceof ModelConfigError && error.code === 'MODEL_CONFIG_INVALID') return {};
    throw error;
  }
}

export async function loadModelConfig({ configPath, env = process.env } = {}) {
  assertConfigPath(configPath);
  const file = await readConfigFile(configPath);
  const envKey = envValue(env, 'DEEPSEEK_API_KEY');
  const apiKey = envKey ?? file.api_key;
  // 环境变量覆盖模型名时，声明也必须跟着换：能力判定的键是「实际在用的那个模型」，
  // 不是「配置文件里写的那个」。判错了就会给一个不支持的模型下发思考字段。
  const model = envValue(env, 'DEEPSEEK_MODEL') ?? file.model;
  return {
    provider: 'deepseek',
    baseUrl: normalizeBaseUrl(envValue(env, 'DEEPSEEK_BASE_URL') ?? file.base_url),
    model,
    apiKey,
    // 这个 key 是从哪来的。环境变量优先于文件（临时覆盖），但对用户来说「我明明配好了」
    // 和「实际在用的是环境变量里那个」是两件完全不同的事——不说清楚，人只会一直查自己的配置。
    apiKeySource: apiKey === null ? null : (envKey !== null ? 'env' : 'file'),
    // configured 只问一件事：有没有可用的 key。模型未设置由 /model 单独提示。
    configured: apiKey !== null,
    // 配置文件是否存在：首次使用（false）才值得走引导，跳过过引导的用户不会每次都被问。
    configExists: file.exists,
    // 当前模型声明的思考档位（D9 的第 (ii) 层）。null = 没声明，交给 effort.mjs 逐层回退。
    declaredLevels: pickDeclaredLevels(file, model),
  };
}

// 读一次配置并归成**一份状态**：面板（modelRow）、/model 展示、引导 readState 过去各判一遍，
// 「配置损坏怎么说」已经当场分叉过——判定只有这一处，三个消费方共用同一份读法。
//
// 四态：
//   ready       配了 key，可用。model 那格仍可能是被写坏的——corruptModel 单独说，不并进状态。
//   empty       文件读到了，但还没有可用的 key（含从没配置过）。
//   invalid     JSON 损坏——重设一次就能修好（引导能覆盖它），不该与「读不出来」混为一谈。
//   unreadable  读不出来（权限 / 路径）——引导也救不了，只能如实报一条事实。
//
// 损坏与挽救：model 那格里是 API Key（真实事故的形状）时 corruptModel=true，
// salvagedKey 是从那格里捞出来的完整 Key——引导拿它免一次「请重新粘贴」。
// 损坏不影响 state：api_key 那格有值就算配过（哪怕它不能用），这是 loadModelConfig 的原语义。
// load 是注入点（命令层把 model.load 转交进来，测试也走这条缝），形状必须与 loadModelConfig 一致。
export async function readModelState({ configPath, env = process.env, load = loadModelConfig } = {}) {
  try {
    const config = await load({ configPath, env });
    const corruptModel = looksLikeApiKey(config.model);
    return {
      state: config.configured ? 'ready' : 'empty',
      config,
      corruptModel,
      salvagedKey: corruptModel ? salvageKeyFromModel(config.model) : null,
      error: null,
    };
  } catch (error) {
    return {
      state: error?.code === 'MODEL_CONFIG_INVALID' ? 'invalid' : 'unreadable',
      config: null,
      corruptModel: false,
      salvagedKey: null,
      error,
    };
  }
}

// 保存 DeepSeek 配置：只写白名单字段，保留已有的 provider / base_url；
// 先写同目录临时文件再 rename（Windows 上 rename 可覆盖同名文件），不依赖 POSIX mode。
//
// 两道防线（这里是最后一道）：
//   1. 写入前一律 sanitizeInput：不可见字符不该进配置文件；
//   2. **模型名位置上是 API Key 就拒收**——这个形状的配置会一路错到 401 上，
//      而错误信息会把人指向 Key（他就再也找不到真正的问题了）。调用方（/model、向导）
//      本该在更早的地方就把 Key 分派到 Key 那一格，走到这里说明有代码漏了路由。
export async function saveDeepSeekConfig({ configPath, apiKey, model } = {}) {
  assertConfigPath(configPath);
  const cleanKey = apiKey === undefined ? undefined : sanitizeInput(apiKey);
  const cleanModel = model === undefined ? undefined : sanitizeInput(model);
  if (cleanKey !== undefined && cleanKey === '') {
    throw new ModelConfigError('API Key 不能为空。', 'MODEL_CONFIG_INVALID_KEY', { configPath });
  }
  if (cleanModel !== undefined && cleanModel === '') {
    throw new ModelConfigError('模型名不能为空。', 'MODEL_CONFIG_INVALID_MODEL', { configPath });
  }
  if (cleanModel !== undefined && looksLikeApiKey(cleanModel)) {
    throw new ModelConfigError(
      '模型名里出现了 API Key 的样式，已拒绝保存；设置 API Key 请用 /model key。',
      'MODEL_CONFIG_INVALID_MODEL',
      { configPath },
    );
  }

  const current = await readConfigFileForSave(configPath);
  const next = {
    provider: current.provider ?? 'deepseek',
    base_url: current.base_url ?? DEFAULT_BASE_URL,
    model: cleanModel === undefined ? current.model : cleanModel,
    api_key: cleanKey === undefined ? current.api_key : cleanKey,
    // 手工声明的能力表原样带过去：/model 改的是模型名与 Key，
    // 没有理由顺手把用户为网关模型写的 reasoning_effort_levels 删掉。
    model_capabilities: current.model_capabilities ?? null,
  };
  // 空字段不落盘，文件保持可手工编辑的最小形态。
  const payload = {};
  for (const field of CONFIG_FIELDS) {
    if (next[field] !== null && next[field] !== undefined) payload[field] = next[field];
  }

  await mkdir(path.dirname(configPath), { recursive: true });
  const tmpPath = `${configPath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  try {
    await rename(tmpPath, configPath);
  } catch (error) {
    throw new ModelConfigError('无法写入模型配置文件，请检查应用数据目录的权限。', 'MODEL_CONFIG_WRITE_FAILED', {
      configPath,
      errorCode: error && error.code,
    });
  }
}

// 「验证并保存一把 Key」的唯一入口。/model key（命令层）与向导的问 Key 步骤、
// 挽救回来的 Key 过去各写一遍「先验证再保存」——顺序是纪律：先落盘的话，用户要到
// 下一次发消息才知道 Key 是错的，那时屏幕上的只有一句「API Key 无效」。
// 纪律只有一处定义，三处调用；**渲染归调用方**（卡片文案与向导语本来就该长得不一样）。
//   outcome: 'saved'    已保存（verdict.status: 'ok' | 'unknown'）
//            'rejected' 端点拒绝了这把 Key，**没有落盘**（verdict 原样带回）
//            'failed'   保存动作本身失败（error 原样带回，由调用方渲染事实）
// 没有 probeKey 时按 unknown 继续（与引导的兜底同型）：存下再说，好过存不进去。
export async function verifyAndSaveApiKey({ apiKey, configPath, probeKey = null, save = saveDeepSeekConfig } = {}) {
  const verdict = typeof probeKey === 'function'
    ? await probeKey(apiKey)
    : { status: 'unknown', models: [], reason: '本机无法验证' };
  if (verdict.status === 'invalid') return { outcome: 'rejected', verdict };
  try {
    await save({ configPath, apiKey });
  } catch (error) {
    return { outcome: 'failed', error };
  }
  return { outcome: 'saved', verdict };
}
