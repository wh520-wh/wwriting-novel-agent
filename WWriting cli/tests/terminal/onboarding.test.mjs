// 模型设置向导测试：① 填入 API Key → ② 选择要用的模型。
//
// 选择器与单行读取都注入可脚本化的替身：这里只断言引导「做了什么决定、说了什么话」，
// 真的按方向键、真的读写终端的那部分由 tests/terminal/select.test.mjs 与
// tests/acceptance/main-path.test.mjs 覆盖。
//
// 两条最要紧的底线，每个用例都会碰到：
//   1. **无效的 Key 绝不保存**：Key 是先验证、后保存的，用户不会在下一次发消息时才撞墙；
//   2. **模型名从端点返回的真实列表里选**：不可能存下一个不存在的模型名。
import test from 'node:test';
import assert from 'node:assert/strict';

import { CHANGE_KEY_ID, MANUAL_MODEL_ID, PROVIDERS, createOnboarding } from '../../src/terminal/onboarding.mjs';
import { DEFAULT_BASE_URL, maskApiKey } from '../../src/model/config.mjs';

const CONFIG_PATH = 'C:/tmp/wwriting/config.json';
const KEY = 'sk-abcdefghijklmnop';
const MODELS = ['deepseek-chat', 'deepseek-reasoner'];

// 记录型渲染器：引导页只用 printStatus。
function makeRenderer() {
  const calls = [];
  return {
    calls,
    printStatus: (text, options = {}) => calls.push([text, options]),
    text: () => calls.map(([text]) => text).join('\n'),
  };
}

// 脚本化选择器：按调用顺序吐出预设结果（null = 用户取消）。
function makeSelect(script = []) {
  const prompts = [];
  return {
    prompts,
    ask: async (options) => {
      prompts.push(options);
      const next = script.length > 0 ? script.shift() : null;
      if (next === null || next === undefined) return null;
      const index = typeof next === 'number' ? next : options.items.findIndex((item) => item.id === next);
      assert.ok(index >= 0, `脚本里的选项 ${next} 不在菜单里（${options.items.map((item) => item.id).join(', ')}）`);
      return { index, item: options.items[index] };
    },
  };
}

// 脚本化单行读取：按调用顺序吐出预设行。'' = 回车（跳过），null = 输入流没了 / Ctrl+C。
function makeReadLine(script = []) {
  const prompts = [];
  return {
    prompts,
    readLine: async (options = {}) => {
      prompts.push(options);
      return script.length > 0 ? script.shift() : null;
    },
  };
}

function makeSave({ fail = null } = {}) {
  const saves = [];
  return {
    saves,
    save: async (options) => {
      if (fail !== null && fail.matches(options)) throw fail.error;
      saves.push(options);
    },
  };
}

// 现成配置：重配置模式读的就是它。
function makeLoad({
  configured = true, model = 'deepseek-chat', apiKey = KEY, baseUrl = DEFAULT_BASE_URL, fail = false,
} = {}) {
  return async () => {
    if (fail) throw Object.assign(new Error('配置文件格式不正确'), { code: 'MODEL_CONFIG_INVALID' });
    return {
      configured, model, apiKey, baseUrl, configExists: true, configPath: CONFIG_PATH,
    };
  };
}

// 验证探针的替身：valid:false 表示「端点说这个 Key 不行」。
function makeVerify({ valid = true, models = MODELS, status = null } = {}) {
  const seen = [];
  return {
    seen,
    verify: async (apiKey) => {
      seen.push(apiKey);
      if (status !== null) return status;
      return valid ? { status: 'ok', models, reason: null } : { status: 'invalid', models: [], reason: 'API Key 无效或没有权限。' };
    },
  };
}

function makeOnboarding({
  renderer = makeRenderer(),
  select = makeSelect([MANUAL_MODEL_ID]),
  readLine = makeReadLine([KEY]),
  save = makeSave().save,
  verify = makeVerify().verify,
  list = async () => MODELS,
  reconfigure = false,
  focus = null,
  // 缺省的「现状」跟着模式走：首次设置是「从没配过」，重配置才是那份现成配置。
  load = reconfigure ? makeLoad() : makeLoad({ configured: false, model: null, apiKey: null }),
} = {}) {
  return createOnboarding({
    renderer,
    select,
    readLine: readLine.readLine ?? readLine,
    configPath: CONFIG_PATH,
    save,
    verifyKey: verify.verify ?? verify,
    listModels: list,
    reconfigure,
    focus,
    load,
    env: {},
  });
}

test('厂商清单只有 DeepSeek 官方，并给出端点与拿 Key 的地址', () => {
  assert.equal(PROVIDERS.length, 1);
  assert.equal(PROVIDERS[0].id, 'deepseek');
  assert.equal(PROVIDERS[0].baseUrl, 'https://api.deepseek.com');
  assert.match(PROVIDERS[0].createKeyUrl, /^https:\/\//, '要告诉新用户去哪里创建 Key');
});

test('首次设置两步走完：粘贴 Key（当场验证）→ 从真实列表选模型', async () => {
  const renderer = makeRenderer();
  const select = makeSelect(['deepseek-reasoner']);
  const readLine = makeReadLine([KEY]);
  const verify = makeVerify();
  const { save, saves } = makeSave();
  const onboarding = makeOnboarding({
    renderer, select, readLine, save, verify,
  });

  await onboarding.start();

  // ① Key：一个字都不该问「厂商」；验证发生在保存之前。
  assert.deepEqual(verify.seen, [KEY], '拿刚输入的值去问端点');
  assert.deepEqual(saves[0], { configPath: CONFIG_PATH, apiKey: KEY });
  assert.ok(renderer.text().includes('API Key 有效 · 2 个可用模型'), '当场给出结论，用户不必等到发消息');
  assert.equal(readLine.prompts.length, 1, 'Key 只问一次');

  // ② 模型：候选就是验证时拿回来的那份列表，没有多问一次网络。
  assert.equal(select.prompts.length, 1);
  const items = select.prompts[0].items.map((item) => item.id);
  assert.deepEqual(items, [...MODELS, MANUAL_MODEL_ID]);
  assert.deepEqual(saves[1], { configPath: CONFIG_PATH, model: 'deepseek-reasoner' });
  assert.ok(renderer.text().includes('设置完成，开始吧。'));
});

test('Key 被端点拒绝：原地重问，绝不保存；第二次给对了就继续', async () => {
  const renderer = makeRenderer();
  const readLine = makeReadLine(['sk-wrong-key-000', KEY]);
  let calls = 0;
  const verify = {
    seen: [],
    verify: async (key) => {
      verify.seen.push(key);
      calls += 1;
      return calls === 1
        ? { status: 'invalid', models: [], reason: 'API Key 无效或没有权限。' }
        : { status: 'ok', models: MODELS, reason: null };
    },
  };
  const { save, saves } = makeSave();
  const onboarding = makeOnboarding({ renderer, readLine, save, verify });

  await onboarding.start();

  assert.ok(renderer.text().includes('这个 Key 被拒绝了'), '说清发生了什么');
  assert.equal(saves.some((options) => options.apiKey === 'sk-wrong-key-000'), false, '坏 Key 一个字都不落盘');
  assert.deepEqual(saves[0], { configPath: CONFIG_PATH, apiKey: KEY }, '第二次的 Key 才被保存');
  assert.equal(verify.seen.length, 2, '两个值都真的验过');
});

test('Key 验不了（断网 / 端点异常）：照常保存，但把「没验证」说清楚', async () => {
  const renderer = makeRenderer();
  const { save, saves } = makeSave();
  const onboarding = makeOnboarding({
    renderer,
    readLine: makeReadLine([KEY]),
    save,
    verify: makeVerify({ status: { status: 'unknown', models: [], reason: '无法连接 DeepSeek 服务，请检查网络后重试。' } }),
  });

  await onboarding.start();

  assert.ok(renderer.text().includes('暂时没能验证'), '不能把网络问题说成 Key 有问题');
  assert.deepEqual(saves[0], { configPath: CONFIG_PATH, apiKey: KEY }, '验不了也照常存下');
});

test('首次设置回车跳过 Key：写下最小配置（标记「问过了」）并留一条补救事实', async () => {
  const renderer = makeRenderer();
  const { save, saves } = makeSave();
  const onboarding = makeOnboarding({ renderer, readLine: makeReadLine(['']), save });

  await onboarding.start();

  assert.deepEqual(saves, [{ configPath: CONFIG_PATH }], '跳过也要落一份最小配置，否则每次启动都会再问');
  assert.ok(renderer.text().includes('已跳过设置'));
  assert.ok(renderer.text().includes('/model'), '要说清之后怎么补上');
});

test('拿不到模型列表：允许直接手输，且在真实列表里核对之后才收', async () => {
  const renderer = makeRenderer();
  const select = makeSelect([MANUAL_MODEL_ID]);
  const readLine = makeReadLine([KEY, 'deepseek-reasoner']);
  const onboarding = makeOnboarding({
    renderer,
    select,
    readLine,
    verify: makeVerify({ models: MODELS }),
    // 验证拿得到列表，所以手输的那个能被核对
  });

  await onboarding.start();

  assert.equal(select.prompts.length, 1, '先给菜单（含「自己输入」）');
  assert.ok(renderer.text().includes('设置完成'), '核对通过就正常收尾');
});

test('手输的模型名不在列表里：拒收并报出真实可用的名字，不落盘', async () => {
  const renderer = makeRenderer();
  const readLine = makeReadLine([KEY, 'deepseek-flash', 'deepseek-reasoner']);
  const { save, saves } = makeSave();
  const onboarding = makeOnboarding({
    renderer,
    // 验证返回的列表里没有 deepseek-flash（真事故：用户手打了这个不存在的名字）
    select: makeSelect([MANUAL_MODEL_ID]),
    readLine,
    save,
    verify: makeVerify({ models: MODELS }),
  });

  await onboarding.start();

  assert.ok(renderer.text().includes('列表里没有这个模型名'), '拒收要给出理由');
  assert.ok(renderer.text().includes('deepseek-chat、deepseek-reasoner'), '并把真实可用的名字摆出来');
  assert.equal(saves.some((options) => options.model === 'deepseek-flash'), false, '不存在的模型名不落盘');
  assert.deepEqual(saves.at(-1), { configPath: CONFIG_PATH, model: 'deepseek-reasoner' });
});

test('把 API Key 粘进模型名：拒收，绝不当作模型名存下去', async () => {
  const renderer = makeRenderer();
  const readLine = makeReadLine([KEY, KEY, 'deepseek-chat']);
  const { save, saves } = makeSave();
  const onboarding = makeOnboarding({
    renderer, select: makeSelect([MANUAL_MODEL_ID]), readLine, save, verify: makeVerify(),
  });

  await onboarding.start();

  assert.ok(renderer.text().includes('这看起来是 API Key，不是模型名'), '要指出它粘错了地方');
  assert.equal(
    saves.some((options) => typeof options.model === 'string' && options.model.startsWith('sk-')),
    false,
    'Key 绝不能出现在模型名那一格',
  );
});

test('设置期间敲斜杠命令：明确说清先放一放，也不把它当成 Key 存下来', async () => {
  const renderer = makeRenderer();
  const readLine = makeReadLine(['/model key', KEY]);
  const { save, saves } = makeSave();
  const onboarding = makeOnboarding({ renderer, readLine, save, verify: makeVerify() });

  await onboarding.start();

  assert.ok(renderer.text().includes('命令先放一放'));
  assert.equal(saves.some((options) => options.apiKey === '/model key'), false);
  assert.deepEqual(saves[0], { configPath: CONFIG_PATH, apiKey: KEY });
});

test('保存失败：给一条中文事实，不把人卡在向导里', async () => {
  const renderer = makeRenderer();
  const { save } = makeSave({
    fail: {
      matches: (options) => options.model !== undefined,
      error: Object.assign(new Error('无法写入模型配置文件，请检查应用数据目录的权限。'), { code: 'MODEL_CONFIG_WRITE_FAILED' }),
    },
  });
  const onboarding = makeOnboarding({
    renderer, select: makeSelect(['deepseek-chat']), readLine: makeReadLine([KEY]), save,
  });
  await onboarding.start();

  assert.ok(renderer.text().includes('无法写入模型配置文件'), '抛出的事实要落到屏幕上');
});

// —— 重新配置（/model）——

test('重配置：已有 Key 就不再问它，取一次真实列表直接让人换模型', async () => {
  const renderer = makeRenderer();
  const select = makeSelect(['deepseek-reasoner']);
  const readLine = makeReadLine([]);
  const { save, saves } = makeSave();
  const onboarding = makeOnboarding({
    renderer,
    select,
    readLine,
    save,
    reconfigure: true,
    load: makeLoad(),
  });

  await onboarding.start();

  assert.ok(renderer.text().includes('当前：deepseek-chat'));
  assert.ok(renderer.text().includes(maskApiKey(KEY)), '现状里带上脱敏后的 Key');
  assert.equal(readLine.prompts.length, 0, '根本没有走文本输入');
  assert.equal(select.prompts.length, 1, '只问一件事：模型');
  assert.deepEqual(select.prompts[0].items.map((item) => item.id), [...MODELS, MANUAL_MODEL_ID, CHANGE_KEY_ID]);
  assert.deepEqual(saves, [{ configPath: CONFIG_PATH, model: 'deepseek-reasoner' }]);
  assert.ok(renderer.text().includes('设置完成：模型 deepseek-reasoner'));
});

test('重配置：菜单里的「换 API Key」把人送回问 Key 那一步，换完接着选模型', async () => {
  const renderer = makeRenderer();
  const select = makeSelect([CHANGE_KEY_ID, 'deepseek-chat']);
  const readLine = makeReadLine(['sk-new-key-1234567890']);
  const { save, saves } = makeSave();
  const onboarding = makeOnboarding({
    renderer, select, readLine, save, reconfigure: true,
  });

  await onboarding.start();

  assert.equal(readLine.prompts.length, 1, '选「换 Key」之后才问 Key');
  assert.deepEqual(saves[0], { configPath: CONFIG_PATH, apiKey: 'sk-new-key-1234567890' });
  assert.deepEqual(saves[1], { configPath: CONFIG_PATH, model: 'deepseek-chat' });
  assert.equal(select.prompts.length, 2, '换完 Key 回到模型菜单');
});

test('重配置：focus=key（`/model key` 没给值）直接从问 Key 开始', async () => {
  const renderer = makeRenderer();
  const readLine = makeReadLine([KEY]);
  const { save, saves } = makeSave();
  const onboarding = makeOnboarding({
    renderer, select: makeSelect(['deepseek-chat']), readLine, save, reconfigure: true, focus: 'key',
  });

  await onboarding.start();

  assert.equal(readLine.prompts.length, 1);
  assert.deepEqual(saves[0], { configPath: CONFIG_PATH, apiKey: KEY });
});

test('重配置：Esc 不改动，一个字节都不写', async () => {
  const renderer = makeRenderer();
  const { save, saves } = makeSave();
  const onboarding = makeOnboarding({
    renderer, select: makeSelect([null]), save, reconfigure: true,
  });

  await onboarding.start();

  assert.deepEqual(saves, [], '取消就是取消');
  assert.ok(renderer.text().includes('未做改动。'));
  assert.equal(onboarding.changedConfig(), false);
});

test('重配置：模型名那一格存着 API Key（真实事故）会被告知，并换成真实模型名', async () => {
  const renderer = makeRenderer();
  const select = makeSelect(['deepseek-chat']);
  const { save, saves } = makeSave();
  const onboarding = makeOnboarding({
    renderer,
    select,
    save,
    reconfigure: true,
    load: makeLoad({ model: `key${KEY}` }), // 就是那份被写坏的配置
  });

  await onboarding.start();

  assert.ok(renderer.text().includes('模型名那一格之前存进了一个 API Key'), '要点名说清');
  assert.ok(!renderer.text().includes(`key${KEY}`), '那一串及其内容不该再被回显');
  // 先从那一格里把 Key 捞回来（顺便验一次），再让用户选一个真实模型覆盖掉坏值。
  assert.deepEqual(saves, [
    { configPath: CONFIG_PATH, apiKey: KEY },
    { configPath: CONFIG_PATH, model: 'deepseek-chat' },
  ]);
});

test('重配置：还没有 Key 时先问 Key，回车跳过就干净收场', async () => {
  const renderer = makeRenderer();
  const select = makeSelect([]);
  const { save, saves } = makeSave();
  const onboarding = makeOnboarding({
    renderer,
    select,
    readLine: makeReadLine(['']),
    save,
    reconfigure: true,
    load: makeLoad({ configured: false, model: null, apiKey: null }),
  });

  await onboarding.start();

  assert.ok(renderer.text().includes('尚未配置模型'));
  assert.equal(select.prompts.length, 0, '没有 Key 就不必问模型（问了也用不了）');
  assert.deepEqual(saves, [], '跳过不写任何东西');
  assert.ok(renderer.text().includes('未做改动。') === false, '明确跳过与「取消」不是一件事');
  assert.ok(renderer.text().includes('已跳过 API Key'));
});

test('重配置：从写坏的模型名里把 Key 捞回来（用户一个字符都不用重新粘贴）', async () => {
  const renderer = makeRenderer();
  const select = makeSelect(['deepseek-reasoner']);
  const readLine = makeReadLine([]); // 不该问任何东西
  const { save, saves } = makeSave();
  const verify = makeVerify(); // 那个 Key 其实是好的
  const onboarding = makeOnboarding({
    renderer,
    select,
    readLine,
    save,
    verify,
    reconfigure: true,
    // 就是用户机器上那份：模型名那一格是 `key` + 真 Key，而 api_key 那格是别的垃圾
    load: makeLoad({ model: `key${KEY}`, apiKey: 'waswdwdad' }),
  });

  await onboarding.start();

  assert.ok(renderer.text().includes('挪回 Key 的位置'), '先说明白要做什么');
  assert.ok(renderer.text().includes(`已找回 API Key：${maskApiKey(KEY)}`), '捞回来并说清是哪一个');
  assert.equal(readLine.prompts.length, 0, '一个字都不用重新输入');
  assert.deepEqual(saves[0], { configPath: CONFIG_PATH, apiKey: KEY }, '垃圾 Key 被真 Key 顶掉');
  assert.deepEqual(saves[1], { configPath: CONFIG_PATH, model: 'deepseek-reasoner' });
});

test('重配置：捞回来的 Key 是坏的，就不硬塞，照常问一次', async () => {
  const renderer = makeRenderer();
  const select = makeSelect(['deepseek-chat']);
  const readLine = makeReadLine([KEY]);
  const { save, saves } = makeSave();
  const onboarding = makeOnboarding({
    renderer,
    select,
    readLine,
    save,
    verify: makeVerify({ valid: false }),
    reconfigure: true,
    load: makeLoad({ model: `key${KEY}`, apiKey: null, configured: false }),
  });

  await onboarding.start();

  // 捞出来的那个也要过验证：不行就问一次，而不是把它当宝贝存下去。
  assert.ok(renderer.text().includes('这个 Key 被拒绝了'), '捞回来的那个也照样要过验证');
  assert.deepEqual(saves, [], '两次都没通过验证，那就一个字节都不写');
  assert.ok(renderer.text().includes('未做改动。'), '干净收场，回到对话面');
});
