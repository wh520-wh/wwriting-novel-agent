// 思考强度的档位、能力判定与会话内状态。
//
// 这里钉住的是 D9 的三层能力来源。为什么不能乐观下发：grokbuild 的测试注释原文——
// 「none/minimal used to pass through and 400 on grok-4.5; reject at the TUI instead」。
// 能在本地拒绝的，就别发出去让 API 打回来：代价是用户等一个来回 + 看到一条看不懂的错。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_EFFORT, EFFORT_LEVELS, createEffortState,
  effortRequestFields, normalizeEffortLevel, parseEffortArg, resolveEffortCapability,
} from '../../src/model/effort.mjs';
import { DEFAULT_BASE_URL } from '../../src/model/config.mjs';

const GATEWAY = 'https://open.bigmodel.cn/api/paas/v4';

test('档位就是 API 的四档，默认 high（P11 / §六）', () => {
  assert.deepEqual([...EFFORT_LEVELS], ['none', 'low', 'high', 'max']);
  assert.equal(DEFAULT_EFFORT, 'high');
});

test('官方文档的兼容别名被归一化：minimal→low，medium/xhigh→high', () => {
  assert.equal(normalizeEffortLevel('minimal'), 'low');
  assert.equal(normalizeEffortLevel('medium'), 'high');
  assert.equal(normalizeEffortLevel('xhigh'), 'high');
  assert.equal(normalizeEffortLevel('MAX'), 'max');
  assert.equal(normalizeEffortLevel('  low  '), 'low');
});

test('中文别名**不**被接受（P11：不给「哪个词对应哪个档」留歧义）', () => {
  for (const word of ['关', '低', '高', '最强']) assert.equal(normalizeEffortLevel(word), null);
});

test('不认识的档位返回 null，绝不猜一个最近的', () => {
  for (const value of ['turbo', '', null, 3, undefined]) assert.equal(normalizeEffortLevel(value), null);
});

test('low/high/max 双发 thinking:{type:"enabled"} + reasoning_effort（P13）', () => {
  for (const level of ['low', 'high', 'max']) {
    assert.deepEqual(effortRequestFields(level), { reasoning_effort: level, thinking: { type: 'enabled' } });
  }
});

test('none 只发 thinking:{type:"disabled"}，不发 reasoning_effort（官方 OpenAI 格式的枚举不含 none）', () => {
  assert.deepEqual(effortRequestFields('none'), { thinking: { type: 'disabled' } });
});

test('档位为 null（自动）或未知档位都不下发任何思考字段', () => {
  assert.equal(effortRequestFields(null), null);
  assert.equal(effortRequestFields('turbo'), null);
});

test('(i) 官方端点 + 官方清单里的模型 → 内置能力，零配置可用', () => {
  const caps = resolveEffortCapability({ baseUrl: DEFAULT_BASE_URL, model: 'deepseek-chat', declared: null });
  assert.deepEqual({ supported: caps.supported, source: caps.source }, { supported: true, source: 'official' });
  // 钉**字面量**档位集合：拿 OFFICIAL_REASONING_CAPABILITIES['deepseek-chat'] 来比是同义反复
  // （函数返回的就是那张表，表变了两边一起变），钉不住「内置表被改错」这条回归。
  assert.deepEqual(caps.levels, ['none', 'low', 'high', 'max']);
});

test('(i) 端点带尾斜杠也算官方端点（normalizeBaseUrl 的同一份语义）', () => {
  assert.equal(resolveEffortCapability({ baseUrl: `${DEFAULT_BASE_URL}/`, model: 'deepseek-chat' }).source, 'official');
});

test('(i) 键是（端点, 模型名）二元组：网关下的同名模型不可信', () => {
  const caps = resolveEffortCapability({ baseUrl: GATEWAY, model: 'deepseek-chat', declared: null });
  assert.deepEqual({ supported: caps.supported, source: caps.source }, { supported: false, source: 'none' });
});

test('(ii) 配置显式声明，档位集合按声明走（GLM-5.3 只接受 max/high/low）', () => {
  const caps = resolveEffortCapability({ baseUrl: GATEWAY, model: 'glm-5.3', declared: ['max', 'high', 'low'] });
  assert.deepEqual({ supported: caps.supported, source: caps.source }, { supported: true, source: 'config' });
  assert.deepEqual(caps.levels, ['low', 'high', 'max'], '按 EFFORT_LEVELS 固定顺序返回');
  assert.equal(caps.levels.includes('none'), false, '声明里没有 none，就不会下发 thinking:{type:"disabled"}');
});

test('(ii) 声明里混进不认识的档位时剔掉它，其余照用', () => {
  const caps = resolveEffortCapability({ baseUrl: 'https://g/v1', model: 'm', declared: ['high', 'turbo', 'max'] });
  assert.deepEqual(caps.levels, ['high', 'max']);
});

test('(ii) 声明是空数组或全是废值 → 等于没声明', () => {
  assert.equal(resolveEffortCapability({ baseUrl: 'https://g/v1', model: 'm', declared: [] }).supported, false);
  assert.equal(resolveEffortCapability({ baseUrl: 'https://g/v1', model: 'm', declared: ['turbo'] }).supported, false);
});

test('(ii) 用户明说的压过代码里写死的：官方端点下声明也能生效', () => {
  const caps = resolveEffortCapability({ baseUrl: DEFAULT_BASE_URL, model: 'deepseek-chat', declared: ['max'] });
  assert.deepEqual({ source: caps.source, levels: caps.levels }, { source: 'config', levels: ['max'] });
});

test('(iii) 都没有 → 判不支持，levels 为空', () => {
  const caps = resolveEffortCapability({ baseUrl: 'https://g/v1', model: 'unknown-model', declared: null });
  assert.deepEqual({ supported: caps.supported, source: caps.source, levels: caps.levels },
    { supported: false, source: 'none', levels: [] });
});

test('模型未设置时不支持：没有模型名就没有能力可判', () => {
  assert.equal(resolveEffortCapability({ baseUrl: DEFAULT_BASE_URL, model: null }).supported, false);
});

// —— 会话内状态（P16：跟会话走 + 切模型时校验）——

const stateFor = (config) => createEffortState({ loadConfig: async () => config });
const OFFICIAL = { baseUrl: DEFAULT_BASE_URL, model: 'deepseek-chat', declaredLevels: null };

test('初始为「自动」（null），describe 报「自动」', () => {
  const state = stateFor(OFFICIAL);
  assert.equal(state.get(), null);
  assert.equal(state.describe(), '自动');
});

test('set 一个模型支持的档位 → 生效', async () => {
  const state = stateFor(OFFICIAL);
  assert.deepEqual(await state.set('max'), { ok: true, level: 'max', reason: null });
  assert.equal(state.get(), 'max');
  assert.equal(state.describe(), 'max');
});

test('set 一个该模型不支持的档位 → 本地就拒绝，并说清它支持哪几档', async () => {
  const state = stateFor({ baseUrl: GATEWAY, model: 'glm-5.3', declaredLevels: ['max', 'high', 'low'] });
  const result = await state.set('none');
  assert.equal(result.ok, false);
  assert.equal(state.get(), null, '拒绝了就不改状态');
  assert.match(result.reason, /low、high、max/);
});

test('set 一个根本不认识的档位 → 拒绝并列出四档', async () => {
  const result = await stateFor(OFFICIAL).set('turbo');
  assert.equal(result.ok, false);
  assert.match(result.reason, /none、low、high、max/);
});

test('模型不支持思考时 set 被拒绝，并给出配置的出路（D9-iii：不伪装生效、可核查）', async () => {
  const state = stateFor({ baseUrl: 'https://g/v1', model: 'unknown', declaredLevels: null });
  const result = await state.set('high');
  assert.equal(result.ok, false);
  assert.match(result.reason, /reasoning_effort_levels/);
  assert.equal(state.get(), null);
});

test('切到不支持思考的模型：syncWithModel 重置为自动并如实说一句（P16）', async () => {
  let config = OFFICIAL;
  const state = createEffortState({ loadConfig: async () => config });
  await state.set('max');
  config = { baseUrl: 'https://g/v1', model: 'unknown', declaredLevels: null };
  const synced = await state.syncWithModel();
  assert.equal(synced.reset, true);
  assert.equal(state.get(), null);
  assert.match(synced.reason, /unknown/, '点名是哪个模型不支持');
});

test('切到同样支持的模型：档位保留，不重置也不说话', async () => {
  let config = OFFICIAL;
  const state = createEffortState({ loadConfig: async () => config });
  await state.set('low');
  config = { ...OFFICIAL, model: 'deepseek-chat' };
  assert.deepEqual(await state.syncWithModel(), { reset: false, level: 'low', reason: null });
});

test('切到档位集合更窄的模型：原档位不在集合里才重置', async () => {
  let config = OFFICIAL;
  const state = createEffortState({ loadConfig: async () => config });
  await state.set('none');
  // deepseek-reasoner 是思考模型，关不掉思考：集合里没有 none。
  config = { ...OFFICIAL, model: 'deepseek-reasoner' };
  const synced = await state.syncWithModel();
  assert.equal(synced.reset, true);
  assert.equal(state.get(), null);
});

test('配置读不出来时按「判不出能力」处理，不抛（失忆好过开不了工）', async () => {
  const state = createEffortState({ loadConfig: async () => { throw new Error('MODEL_CONFIG_UNREADABLE'); } });
  assert.equal((await state.capability()).supported, false);
  assert.equal((await state.set('high')).ok, false);
  assert.equal(state.get(), null);
});

test('set(null) 回到自动，永远合法（不需要能力判定）', async () => {
  const state = stateFor({ baseUrl: 'https://g/v1', model: 'unknown', declaredLevels: null });
  assert.deepEqual(await state.set(null), { ok: true, level: null, reason: null });
  assert.equal(state.describe(), '自动');
});

// —— 「自动」到底下发什么（R8：绝不赌服务端默认）——

test('自动 + 模型已验证支持 → 下发 DEFAULT_EFFORT，不是「什么都不发」', async () => {
  const state = stateFor(OFFICIAL);
  assert.equal(state.get(), null);
  assert.equal(await state.requestLevel(), DEFAULT_EFFORT);
  assert.deepEqual(effortRequestFields(await state.requestLevel()),
    { reasoning_effort: 'high', thinking: { type: 'enabled' } });
});

test('自动 + 判不出能力 → 一个字段都不发（发出去只会被 400 打回来）', async () => {
  const state = stateFor({ baseUrl: 'https://g/v1', model: 'unknown', declaredLevels: null });
  assert.equal(await state.requestLevel(), null);
});

test('自动 + 声明里没有默认档位 → 也不发：支持思考不等于支持 high（P12 不放眼下发）', async () => {
  // 第 (ii) 层允许声明任意子集，`['max']` 是一张合法且真实存在的窄表。
  // 只判 supported 就会给这张表发出 reasoning_effort:"high"——那正是「乐观下发」，
  // 代价是一次 400。默认档位不在集合里，与「判不出能力」在下发行为上是同一件事。
  const narrow = stateFor({ baseUrl: GATEWAY, model: 'glm-5.3', declaredLevels: ['max'] });
  assert.equal(await narrow.requestLevel(), null);
  assert.equal(effortRequestFields(await narrow.requestLevel()), null, '一个字段都不加');

  // 声明里补上 high 之后就照常下发。
  const broad = stateFor({ baseUrl: GATEWAY, model: 'glm-5.3', declaredLevels: ['max', 'high'] });
  assert.equal(await broad.requestLevel(), 'high');
  assert.deepEqual(effortRequestFields(await broad.requestLevel()),
    { reasoning_effort: 'high', thinking: { type: 'enabled' } });
});

test('显式档位原样下发', async () => {
  const state = stateFor(OFFICIAL);
  await state.set('max');
  assert.equal(await state.requestLevel(), 'max');
});

test('配置被手工改成不支持的模型后，requestLevel 退回不发，且不静默改动 get()', async () => {
  let config = OFFICIAL;
  const state = createEffortState({ loadConfig: async () => config });
  await state.set('max');
  config = { baseUrl: 'https://g/v1', model: 'unknown', declaredLevels: null };
  assert.equal(await state.requestLevel(), null, '绝不发一个会被 400 打回来的字段');
  assert.equal(state.get(), 'max', '如实说一句的机会在 /effort 与 /model，不在这里静默改状态');
});

test('requestLevel 可以接一份已读好的配置，省掉重复读盘', async () => {
  let reads = 0;
  const state = createEffortState({ loadConfig: async () => { reads += 1; return OFFICIAL; } });
  assert.equal(await state.requestLevel(OFFICIAL), DEFAULT_EFFORT);
  assert.equal(reads, 0, '传了 preloaded 就不该再读一次');
});

// —— /effort 参数解析（R9：auto 与 自动 同义，且都与「打错了」区分开）——

test('parseEffortArg 把四种意图分开', () => {
  assert.deepEqual(parseEffortArg(''), { kind: 'show' });
  assert.deepEqual(parseEffortArg('   '), { kind: 'show' });
  assert.deepEqual(parseEffortArg('auto'), { kind: 'auto' });
  assert.deepEqual(parseEffortArg('自动'), { kind: 'auto' }, '界面显示「自动」，输入也认「自动」');
  assert.deepEqual(parseEffortArg('AUTO'), { kind: 'auto' });
  assert.deepEqual(parseEffortArg('max'), { kind: 'level', level: 'max' });
  assert.deepEqual(parseEffortArg('xhigh'), { kind: 'level', level: 'high' }, '官方别名照收');
  assert.deepEqual(parseEffortArg('turbo'), { kind: 'invalid' });
  assert.deepEqual(parseEffortArg(null), { kind: 'invalid' });
});

test('没有 loadConfig 就构造不出来：能力判定不能靠猜', () => {
  assert.throws(() => createEffortState({}), /loadConfig/);
});
