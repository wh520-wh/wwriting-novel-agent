// 思考强度（reasoning effort）：档位、能力判定与会话内状态。
//
// 两套并存的开关，本项目**两套都下发**（P13，出处是上游 openai-compatible.mjs:123-127 的注释原文：
// 「声明 reasoningEffortLevels 的模型一律携带 thinking:{type:"enabled"} 与 reasoning_effort——
// 绝不赌服务端默认（2026-08 实测默认值按时间窗漂移，思考内容时有时无）」）：
//   reasoning_effort  none/low/high/max —— 档位的唯一用户可见面；
//   thinking.type     enabled/disabled  —— 防默认漂移的钉子，不暴露给用户。
//
// 能力判定为什么是三层而不是一张 DeepSeek 模型名白名单（D9，审查修正）：
// base_url 是可配置的（config.mjs 的白名单字段 + DEEPSEEK_BASE_URL 环境变量优先 +
// 模型列表取自 ${baseUrl}/models），端点可以是**任意 OpenAI 兼容网关**。
// 写死模型名的白名单会把网关下本支持思考的模型静默判成不支持——反之亦然。
// 本项目的研究笔记里有真实反例：GLM-5.3 只接受 max/high/low，其余报错
// （docs/research/04-llm-api-agent-core.md:133），且 GLM-5.3 系列传 thinking:{type:"disabled"}
// 直接报错（同文件 :130）——所以「档位集合」本身也因模型而异，声明式能力字段顺带解决了这件事。
//
// 为什么不能乐观下发 + 拦截 400：grokbuild 的测试注释原文——
// 「none/minimal used to pass through and 400 on grok-4.5; reject at the TUI instead」。
// 也不做「试探一次并缓存」：那会引入一次用户看不见的额外请求。
//
// 连带事实（§六，实施时不要忘）：max_tokens 的**服务端默认值**跟着档位变
// （非思考 8K / 思考 64K / max 128K），这是真实能力差异；思考模式下 tool_choice 的
// required 与具名选择不被支持（会 400），而本项目当前 payload 根本没有 tool_choice 字段，
// 因此当前不冲突——将来若想强制调某个工具，必须先关思考。
import { DEFAULT_BASE_URL, normalizeBaseUrl } from './config.mjs';

// 四档直通（P11），与 DeepSeek 官方文档一致。**这是对上游统一行为规格书:156
// 「思考强度仅当模型已验证支持时显示 低/中/高」的刻意偏离**，理由与代价记在
// docs/adr/0009-effort-four-levels-deviate-from-upstream-copy-spec.md。
// 偏离的实质：CLI 直接对 DeepSeek，没有上游多厂商 UI 的抽象层；
// max 档是真实能力（输出上限 128K），三档抽象白丢它。
export const EFFORT_LEVELS = Object.freeze(['none', 'low', 'high', 'max']);
export const DEFAULT_EFFORT = 'high';

// 官方文档的兼容别名（§六 原文）：minimal → low，medium / xhigh → high。
// 收它们是为了让用户从别的工具带过来的肌肉记忆不至于撞墙；
// 但**不主动展示**——/help 与回显里只出现四档本名（P11 否决了中文别名方案）。
const EFFORT_ALIASES = Object.freeze({ minimal: 'low', medium: 'high', xhigh: 'high' });

// (i) 已知官方端点的内置能力表。**键是（端点, 模型名）二元组**：
// 只有 baseUrl 规范化后正好等于 DEFAULT_BASE_URL 时才查这张表，
// 网关下的同名模型一律不可信（它可能是转发的、可能是改过的、可能根本是另一个模型）。
//
// deepseek-reasoner 是思考模型，关不掉思考：集合里没有 none，
// 于是「关掉思考」这个档位对它根本不可选，也就永远不会给它下发 thinking:{type:"disabled"}。
//
// 取值出处：docs/research/06-deepseek-reasoning-effort-probe.md。
// **本计划不做真实端点实测**（2026-09-29 用户决定，取代原 Task 8 的实测步骤）：
// 「档位集合与 max_tokens 的联动」确实是服务端行为，但 **OpenAI 格式的编码规则**
// （哪一档发哪个字段）在官方「思考模式」文档里写得很清楚，照文档适配即可、不必花钱去探。
// 将来某模型行为若与文档不一致，改这张表 + 那份适配记录即可，无需重跑探针。
export const OFFICIAL_REASONING_CAPABILITIES = Object.freeze({
  'deepseek-chat': Object.freeze(['none', 'low', 'high', 'max']),
  'deepseek-reasoner': Object.freeze(['low', 'high', 'max']),
  'deepseek-v4-pro': Object.freeze(['none', 'low', 'high', 'max']),
  'deepseek-flash': Object.freeze(['none', 'low', 'high', 'max']),
});

// 一行用户输入 → 档位，或 null。大小写与首尾空白不敏感，别名归一，其余一律 null（不猜最近的）。
export function normalizeEffortLevel(value) {
  if (typeof value !== 'string') return null;
  const clean = value.trim().toLowerCase();
  if (clean === '') return null;
  const mapped = EFFORT_ALIASES[clean] ?? clean;
  return EFFORT_LEVELS.includes(mapped) ? mapped : null;
}

// `/effort` 的参数解析。**必须与 normalizeEffortLevel 分开**：
// 「用户敲了 auto / 自动」（合法的「回到自动」）与「用户敲了 turbo」（打错了）
// 在 normalizeEffortLevel 里都返回 null，分不开就会把前者也当成打错。
//
// `auto` 与 `自动` 都收（R9）：界面显示的是「自动」，输入却只认英文 auto 是词汇表自相矛盾。
// 铁律 10 要求全中文文案，P11 只豁免了**档位名**（none/low/high/max 是 API 的字面取值，
// 用户查文档要能对上），「回到自动」不是一档，没有理由强制英文。
export function parseEffortArg(value) {
  if (typeof value !== 'string') return { kind: 'invalid' };
  const clean = value.trim();
  if (clean === '') return { kind: 'show' };
  if (clean.toLowerCase() === 'auto' || clean === '自动') return { kind: 'auto' };
  const level = normalizeEffortLevel(clean);
  return level === null ? { kind: 'invalid' } : { kind: 'level', level };
}

// 把声明里的档位过滤成合法的，并按 EFFORT_LEVELS 的固定顺序排。
// 声明顺序不影响判定，但影响展示——「low、high、max」比「max、low、high」好读，
// 因为固定顺序与 /help 里列出的顺序一致，用户对照时不用重新找一遍。
function normalizeDeclared(declared) {
  if (!Array.isArray(declared)) return [];
  const wanted = declared.map((item) => normalizeEffortLevel(item)).filter((item) => item !== null);
  return EFFORT_LEVELS.filter((level) => wanted.includes(level));
}

// 三层能力判定，逐层回退。source 说明这个结论是哪一层给的——
// 它要能被用户核查，不能是个黑箱（D9-iii 的「不伪装、可核查」）。
export function resolveEffortCapability({ baseUrl, model, declared = null } = {}) {
  const endpoint = normalizeBaseUrl(baseUrl);
  const name = typeof model === 'string' && model.trim() !== '' ? model.trim() : null;

  // (ii) 配置显式声明优先：网关用户自己声明、自己负责。
  // 放在 (i) 之前是因为「用户明说的」压过「代码里写死的」——
  // 官方端点下也会出现内置表还没收录的新模型，此时声明就是唯一出路。
  const fromDeclared = normalizeDeclared(declared);
  if (name !== null && fromDeclared.length > 0) {
    return { supported: true, levels: fromDeclared, source: 'config', model: name };
  }
  // (i) 已知官方端点的内置表：零配置可用。
  if (name !== null && endpoint === DEFAULT_BASE_URL && Array.isArray(OFFICIAL_REASONING_CAPABILITIES[name])) {
    return { supported: true, levels: [...OFFICIAL_REASONING_CAPABILITIES[name]], source: 'official', model: name };
  }
  // (iii) 都没有 → 判不支持。/effort 只显示「自动」且不可选，并说清禁用理由与出路。
  return { supported: false, levels: [], source: 'none', model: name };
}

// 档位 → 要下发的请求字段。
// level 为 null（自动）或不认识时返回 null：调用方**一个 effort 字段都不加**
// （不发 `reasoning_effort`、也不发 `thinking`），所以不支持思考的模型、没配档位时，
// 请求体不会多出任何服务端可能拒收的思考字段。这一条是「基线不得变红」的关键。
// （注意这与「payload 与上线前逐字一致」不是一回事了——`max_tokens` 现在恒定下发，
// 见 deepseek-client.mjs 的 payload 一处与 ADR-0009 未决项。）
//
// **按 DeepSeek 官方「思考模式」文档的 OpenAI 格式专门适配**（截图见
// docs/research/06-deepseek-reasoning-effort-probe.md；官方表格把两件事分成两个字段：
// 「思考模式开关」= `thinking.type`（enabled/disabled），「思考强度控制」= `reasoning_effort`，
// 且 `reasoning_effort` 的枚举**只有 low/high/max，没有 none**）。所以：
//   none      → 只发 `thinking:{type:"disabled"}`，**绝不发** `reasoning_effort:"none"`
//               （OpenAI 格式没有这个取值，多发一个非法枚举会被 400 打回来）；
//   low/high/max → 双发 `reasoning_effort:<level>` + `thinking:{type:"enabled"}`（P13）。
// 这正是「不做真实端点实测」之后仍能保证不发非法请求的依据：编码规则来自官方文档，不是猜的。
export function effortRequestFields(level) {
  const normalized = normalizeEffortLevel(level);
  if (normalized === null) return null;
  if (normalized === 'none') return { thinking: { type: 'disabled' } };
  return {
    reasoning_effort: normalized,
    thinking: { type: 'enabled' },
  };
}

// 「这个模型不支持，怎么办」的那一句出路。单独抽出来是因为它有两个消费者
// （set 的拒绝理由与 /effort 的禁用说明），而两处措辞必须一致——
// 用户照着一处的话去改配置、另一处却说了别的，就再也找不到路了。
export function unsupportedEffortReason(caps) {
  if (caps.model === null) return '尚未设置模型，输入 /model 先选一个。';
  return '该模型未声明思考能力，可在配置里为它声明 reasoning_effort_levels。';
}

// 会话内的档位状态（P16：跟会话走，不持久化）。
//
// 为什么状态在这里而不在 config.json：上游把三控件定为「选择即保存为项目默认」，
// 但思考强度**依赖模型能力**，而本项目的模型可以随时切。持久化一个「项目默认档位」
// 就会在切模型后留下一个可能无效的档位；与「项目默认」的差距记在 ADR-0009 的未决项里。
//
// loadConfig 是注入点（真实实现是 config.mjs 的 loadModelConfig）：每次判定都**现读**配置，
// 因为用户可能正是在这个会话里用 /model 换的模型，构造期快照会让刚换的模型直到重启才生效
// ——这与 cli.mjs:118-126 那条注释是同一个判断。
export function createEffortState({ loadConfig } = {}) {
  if (typeof loadConfig !== 'function') {
    throw new Error('思考强度状态需要 loadConfig 才能判定当前模型的能力。');
  }
  let level = null;

  async function capability() {
    let config = null;
    try {
      config = await loadConfig();
    } catch {
      // 配置读不出来（权限、路径、JSON 坏了）不是「模型支持思考」的理由，
      // 也不是抛错的理由：按「判不出能力」处理，用户仍然能正常写作。
      config = null;
    }
    return resolveEffortCapability({
      baseUrl: config?.baseUrl,
      model: config?.model,
      declared: config?.declaredLevels ?? null,
    });
  }

  async function set(next) {
    // null = 回到「自动」：不下发任何思考字段，永远合法，不需要能力判定。
    if (next === null || next === undefined) {
      level = null;
      return { ok: true, level: null, reason: null };
    }
    const normalized = normalizeEffortLevel(next);
    if (normalized === null) {
      return { ok: false, level, reason: `没有这个档位，可用的是 ${EFFORT_LEVELS.join('、')}。` };
    }
    const caps = await capability();
    if (!caps.supported) return { ok: false, level, reason: unsupportedEffortReason(caps) };
    if (!caps.levels.includes(normalized)) {
      return { ok: false, level, reason: `${caps.model} 只支持 ${caps.levels.join('、')}。` };
    }
    level = normalized;
    return { ok: true, level, reason: null };
  }

  // 切模型之后调一次：原档位在新模型上仍然合法就保留，不合法就重置为自动并**如实说一句**。
  // 两种静默都不接受——静默保留一个无效档位会让下一轮请求 400，
  // 静默清掉会让用户以为 max 还开着。
  async function syncWithModel() {
    if (level === null) return { reset: false, level: null, reason: null };
    const caps = await capability();
    if (caps.supported && caps.levels.includes(level)) return { reset: false, level, reason: null };
    const previous = level;
    level = null;
    const why = caps.supported ? `${caps.model} 不支持 ${previous}` : `${caps.model ?? '新模型'}未声明思考能力`;
    return { reset: true, level: null, reason: `${why}，思考强度已回到自动。` };
  }

  function get() {
    return level;
  }

  // **要真正下发的档位**。这是「自动」这个词的全部含义所在（R8）。
  //
  // 「自动」绝不等于「什么都不发」——那就是赌服务端默认，而 P13 与 §六 明令禁止
  // （「2026-08 实测默认值按时间窗漂移，思考内容时有时无」）。而「自动」是每个会话的初始状态，
  // 等于默认就在赌。上游把 auto 映射到默认档位（openai-compatible.mjs:122-131），本项目照做：
  //   已验证支持思考**且默认档位在它的档位集合里** → 按 DEFAULT_EFFORT（high）双发；
  //   判不出能力，或默认档位不在它的集合里 → 一个字段都不发（发出去只会被 400 打回来）。
  // 这正是统一规格书:156「仅当模型已验证支持时」的语义。
  //
  // 后半句（`caps.levels.includes(DEFAULT_EFFORT)`）不是可有可无的防御：
  // 第 (ii) 层允许用户声明**任意子集**，`declared: ['max']` 就是一张合法的窄表
  // （GLM-5.3 只接受 max/high/low 是真的，只接受 max 的网关模型同样可以存在）。
  // 「支持思考」与「支持 high 这一档」是两件事，只判前者就会给一张不含 high 的表
  // 发出 `reasoning_effort:"high"`——正是 P12 明令禁止的乐观下发，代价是一次 400。
  // 「默认档位不在集合里」与「判不出能力」在**下发行为**上是同一件事：都不发。
  //
  // preloaded 可选：调用方（cli.mjs 的 modelClient）本来就要读一次配置，
  // 传进来就省掉重复读盘。不传则自己读。
  async function requestLevel(preloaded = null) {
    const caps = preloaded === null
      ? await capability()
      : resolveEffortCapability({
        baseUrl: preloaded.baseUrl,
        model: preloaded.model,
        declared: preloaded.declaredLevels ?? null,
      });
    if (level !== null) {
      // 防御：档位是本会话里设的，但配置可能被手工改过、或 DEEPSEEK_MODEL 换了。
      // 此时**不发**比发一个会被 400 打回来的字段好（grokbuild 的教训：能在本地拒绝就别发出去）。
      // 这里刻意**不改 level**：如实说一句的机会在 /effort 与 /model 里，
      // 在一个用户没在看的代码路径上静默改状态是最难查的那类行为。
      return caps.supported && caps.levels.includes(level) ? level : null;
    }
    // 自动（level === null）：下发默认档位，但**只在模型真的声明了它**的时候。
    // 只判 caps.supported 是不够的——「支持思考」不等于「支持 high」。
    return caps.supported && caps.levels.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : null;
  }

  // 面板行尾与 /model 输出共用的那一段文本。
  function describe() {
    return level === null ? '自动' : level;
  }

  return { get, set, capability, requestLevel, syncWithModel, describe };
}
