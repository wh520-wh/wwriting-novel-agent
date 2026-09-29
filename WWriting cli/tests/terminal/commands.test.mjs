// 斜杠命令测试：前缀解析、参数保留、未知命令、/model 三形态（输入输出都脱敏）、
// /sessions、/resume、/stop（走同一个 run controller）、/quit（先 stop 再 close）、
// 确认代收（同一个输入框收确认）与控制键（有活动轮先停、空闲才退）。
// /model 的读写直接调 Task 4 的真实接口（临时目录），只把 controller / renderer 换成可观察的替身。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DECISION_CHOICES, createCommandHandler, modelIntent, parseSlashCommand } from '../../src/terminal/commands.mjs';
import { DEFAULT_BASE_URL, loadModelConfig, maskApiKey } from '../../src/model/config.mjs';
import { versionLine } from '../../src/version.mjs';

const tempRoots = [];
after(async () => {
  await Promise.all(tempRoots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempRoot(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

// 记录型渲染器：命令层的可观察替身，只断言它收到什么，不断言它在终端上怎么排版。
function makeRenderer() {
  const calls = [];
  return {
    calls,
    printUser: (text) => calls.push(['user', text]),
    printAssistant: (text) => calls.push(['assistant', text]),
    printActivity: (entry) => calls.push(['activity', entry]),
    printStatus: (text, options = {}) => calls.push(['status', text, options]),
    printQueue: (text) => calls.push(['queue', text]),
    printDecision: (decision) => calls.push(['decision', decision]),
    clearLive: () => calls.push(['clearLive']),
    close: () => calls.push(['close']),
  };
}

function pick(calls, kind) {
  return calls.filter((call) => call[0] === kind);
}

// 记录型控制器：真实控制器由 Task 6 提供，这里只需要形状与调用记录。
// `queue` 与 `priorityResult` 供 /now 使用：提升需要「队列里有谁」才能定出队首。
function makeController({
  pending = [],
  stopResult = { stopped: true, inputId: 'i-1' },
  submitImpl = null,
  queue = [],
  priorityResult = null,
  priorityThrows = null,
} = {}) {
  const calls = { submit: [], stop: [], close: 0, decide: [], order: [], priority: [] };
  const controller = {
    snapshot: () => ({
      status: 'idle',
      active_run_id: calls.order.includes('active') ? 'run-1' : null,
      active_input_id: null,
      queue,
      transient_grants: [],
      session_id: 's-1',
    }),
    submit: (options) => {
      calls.submit.push(options);
      return submitImpl ? submitImpl(options) : Promise.resolve({ inputId: 'i-1', queued: false, result: null });
    },
    stop: () => {
      calls.stop.push(true);
      calls.order.push('stop');
      return stopResult;
    },
    requestPriority: async (inputId) => {
      calls.priority.push(inputId);
      if (priorityThrows !== null) throw priorityThrows;
      return priorityResult ?? { inputId, promoted: true, interrupted: true };
    },
    close: async () => {
      calls.close += 1;
      calls.order.push('close');
      return true;
    },
    decide: async (options) => {
      calls.decide.push(options);
      return { decisionId: options.decisionId, choice: options.choice, allowed: true };
    },
    permissions: { pending: () => pending },
  };
  return { controller, calls };
}

function makeModel({
  configPath = '/tmp/wwriting/config.json', env = {}, load = null, save = null, probe = null, list = null,
} = {}) {
  const calls = {
    load: [], save: [], probe: [], list: [],
  };
  return {
    calls,
    model: {
      configPath,
      env,
      load: (options) => {
        calls.load.push(options);
        if (load) return load(options);
        return Promise.resolve({
          provider: 'deepseek',
          baseUrl: DEFAULT_BASE_URL,
          model: 'deepseek-chat',
          apiKey: 'sk-1234567890abcdef',
          configured: true,
        });
      },
      save: (options) => {
        calls.save.push(options);
        if (save) return save(options);
        return Promise.resolve();
      },
      mask: maskApiKey,
      // 探针缺省不给：不联网的用例照常能保存，只是回显会多一句「暂时无法验证」。
      probeKey: probe === null ? null : (key) => { calls.probe.push(key); return probe(key); },
      listModels: list === null ? null : () => { calls.list.push(1); return list(); },
    },
  };
}

function makeHandler({ controller, renderer, model, ...rest } = {}) {
  return createCommandHandler({
    getController: () => controller,
    renderer,
    model: model ?? makeModel().model,
    ...rest,
  });
}

// —— Step 1：前缀解析 ——

test('parseSlashCommand：普通文本、空文本、含斜杠的正文都不算命令', () => {
  assert.equal(parseSlashCommand('写第一章'), null);
  assert.equal(parseSlashCommand('写第一章/第二章'), null);
  assert.equal(parseSlashCommand('D:/novel/第一章.md 帮我看看'), null);
  assert.equal(parseSlashCommand(''), null);
  assert.equal(parseSlashCommand('   '), null);
  assert.equal(parseSlashCommand(null), null);
  assert.equal(parseSlashCommand(undefined), null);
  assert.equal(parseSlashCommand(123), null);
});

test('parseSlashCommand：前缀解析出命令名，参数原样保留', () => {
  assert.deepEqual(parseSlashCommand('/help'), { name: 'help', args: '' });
  assert.deepEqual(parseSlashCommand('/model'), { name: 'model', args: '' });
  assert.deepEqual(parseSlashCommand('/model deepseek-chat'), { name: 'model', args: 'deepseek-chat' });
  assert.deepEqual(parseSlashCommand('/model key sk-abc123'), { name: 'model', args: 'key sk-abc123' });
  assert.deepEqual(parseSlashCommand('/resume s-001'), { name: 'resume', args: 's-001' });
  assert.deepEqual(parseSlashCommand('/  stop'), { name: '', args: 'stop' });
});

test('parseSlashCommand：容忍首尾空白、多空格与大小写；连续空白归一成一个', () => {
  assert.deepEqual(parseSlashCommand('  /model   deepseek-chat  '), { name: 'model', args: 'deepseek-chat' });
  // 连续空格压成一个：空格个数不该影响「这一行是什么意思」（`/model key  sk-abc` 与少打一个空格
  // 是同一种输入，压成两个词正是我们要的）。
  assert.deepEqual(parseSlashCommand('/MODEL key  sk-abc  '), { name: 'model', args: 'key sk-abc' });
  assert.deepEqual(parseSlashCommand('/resume\ts-001'), { name: 'resume', args: 's-001' });
  // 全角空格与零宽字符都归一掉，否则粘贴来的一行会解析成另一件事。
  assert.deepEqual(parseSlashCommand('/model\u3000key\u200b sk-abc'), { name: 'model', args: 'key sk-abc' });
});

test('parseSlashCommand：裸斜杠不是未知命令以外的任何东西', () => {
  assert.deepEqual(parseSlashCommand('/'), { name: '', args: '' });
});

// 这一组是「一次真实事故」的回归测试：用户想设 API Key，却把 Key 送进了模型名那一格。
// 配置里存下 `model: "keysk-fd72…"` 之后，每一轮请求都 401，而错误信息还把人指向 Key——
// 他就一路去查自己的 Key，再也找不到真正的问题。所以判定必须放在解析这一层。
test('modelIntent：只要这一串里出现了 Key 的样式，它就一定是 Key，不是模型名', () => {
  const key = 'sk-abcdef0123456789abcdef0123456789';
  // 正常写法
  assert.deepEqual(modelIntent(`key ${key}`), { kind: 'key', value: key });
  // 少打一个空格（粘贴时最常见）：`keysk-…` 同样必须认出来
  assert.deepEqual(modelIntent(`key${key}`), { kind: 'key', value: key });
  // 直接被粘进了模型名那一格：也按 Key 处理，并标记「它被挪到了 Key 上」
  assert.deepEqual(modelIntent(key), { kind: 'key', value: key, moved: true });
  // 不可见字符（零宽空格）不该改变判定——粘贴来的文本里常有
  assert.deepEqual(modelIntent(`key\u200b ${key}`), { kind: 'key', value: key });
});

test('modelIntent：普通模型名照常是模型，无参是向导，带空格是无效输入', () => {
  assert.deepEqual(modelIntent(''), { kind: 'dialog' });
  assert.deepEqual(modelIntent('deepseek-chat'), { kind: 'model', value: 'deepseek-chat' });
  assert.deepEqual(modelIntent('  deepseek-reasoner  '), { kind: 'model', value: 'deepseek-reasoner' });
  // 两个词：既不是模型名也不是 Key（而全角空格会被归一成普通空格，同样算两个词）
  assert.deepEqual(modelIntent('deepseek-flash deepseek-chat'), { kind: 'invalid', reason: 'space' });
  assert.deepEqual(modelIntent('deepseek-flash\u3000x'), { kind: 'invalid', reason: 'space' });
});

// —— Step 5：命令执行 ——

test('/help 列出首版六个命令，第一行是版本', async () => {
  const renderer = makeRenderer();
  const { controller } = makeController();
  const handler = makeHandler({ controller, renderer });

  assert.deepEqual(await handler.handle('/help'), { action: 'handled' });

  const lines = pick(renderer.calls, 'status');
  const text = JSON.stringify(lines);
  for (const name of ['/model', '/sessions', '/resume', '/stop', '/help', '/quit']) {
    assert.ok(text.includes(name), `帮助里应包含 ${name}`);
  }
  assert.equal(lines[0][1], versionLine(), '帮助的第一行应是「名称 + 版本」');
});

test('普通文本交给同一个 run controller，且不等待本轮结束（输入框不被阻塞）', async () => {
  const renderer = makeRenderer();
  let release = null;
  const { controller, calls } = makeController({
    submitImpl: () => new Promise((resolve) => { release = resolve; }),
  });
  const handler = makeHandler({ controller, renderer });

  const result = await handler.handle('写第一章');

  assert.deepEqual(result, { action: 'submit' });
  assert.deepEqual(calls.submit, [{ text: '写第一章' }]);
  assert.equal(pick(renderer.calls, 'close').length, 0, '不应因为未结束就关闭渲染器');
  release({ inputId: 'i-1', queued: false, result: null });
});

test('提交失败只呈现一条中文事实，不抛出、不打印技术字段', async () => {
  const renderer = makeRenderer();
  const { controller } = makeController({
    submitImpl: () => Promise.reject(Object.assign(new Error('会话已关闭，请重新打开项目。'), { code: 'SESSION_CLOSED' })),
  });
  const handler = makeHandler({ controller, renderer });

  assert.deepEqual(await handler.handle('写第一章'), { action: 'submit' });
  await new Promise((resolve) => setImmediate(resolve));

  const status = pick(renderer.calls, 'status').at(-1);
  assert.equal(status[1], '提交失败');
  assert.equal(status[2].tone, 'error');
  assert.ok(status[2].detail.includes('会话已关闭'));
  assert.ok(!JSON.stringify(renderer.calls).includes('SESSION_CLOSED'), '错误码不进主文案');
});

test('未知命令给一条中文事实并指向 /help', async () => {
  const renderer = makeRenderer();
  const { controller } = makeController();
  const handler = makeHandler({ controller, renderer });

  assert.deepEqual(await handler.handle('/foobar'), { action: 'handled' });

  const status = pick(renderer.calls, 'status').at(-1);
  assert.match(status[1], /[\u4e00-\u9fff]/);
  assert.ok(JSON.stringify(status).includes('/help'));
  assert.equal(pick(renderer.calls, 'assistant').length, 0);
});

// —— /init：进命令表，但作为普通聊天请求提交（Q1 / Q14，统一规格书:371、:374）——

function initRig() {
  const submitted = [];
  const statuses = [];
  const handler = createCommandHandler({
    getController: () => ({ submit: async ({ text }) => { submitted.push(text); return { status: 'completed' }; } }),
    renderer: { ...makeRenderer(), printStatus: (text, options) => statuses.push([text, options]) },
  });
  return { handler, submitted, statuses };
}

test('/init 原样提交给同一个 run controller，不当本地命令处理', async () => {
  const { handler, submitted } = initRig();
  const result = await handler.handle('/init');
  assert.deepEqual(submitted, ['/init'], '保留用户发送的原文');
  assert.equal(result.action, 'submit');
});

test('/init 的附加要求一并原样保留', async () => {
  const { handler, submitted } = initRig();
  await handler.handle('/init 重点记一下主角的名字和这座城');
  assert.deepEqual(submitted, ['/init 重点记一下主角的名字和这座城']);
});

test('/init 不会得到「不认识这个命令」', async () => {
  const { handler, statuses } = initRig();
  await handler.handle('/init');
  assert.equal(statuses.some(([text]) => String(text).includes('不认识')), false);
});

test('/help 的命令表里有 /init', async () => {
  const { handler, statuses } = initRig();
  await handler.handle('/help');
  assert.ok(statuses.some(([text]) => String(text).includes('/init')), '用户得找得到它');
});

test('/initialize 不被当成 /init：只认整词', async () => {
  const { handler, submitted, statuses } = initRig();
  await handler.handle('/initialize');
  assert.deepEqual(submitted, []);
  assert.ok(statuses.some(([text]) => String(text).includes('不认识')));
});

test('echoUser 打开时由终端层补用户行，默认不重复回显', async () => {
  const renderer = makeRenderer();
  const { controller } = makeController();
  const handler = makeHandler({ controller, renderer, echoUser: true });

  await handler.handle('写第一章');
  assert.deepEqual(pick(renderer.calls, 'user'), [['user', '写第一章']]);

  const other = makeRenderer();
  const second = makeHandler({ controller, renderer: other });
  await second.handle('写第二章');
  assert.equal(pick(other.calls, 'user').length, 0);
});

// —— /model ——

test('/model 无参数：显示模型、端点与脱敏后的 API Key', async () => {
  const renderer = makeRenderer();
  const { controller } = makeController();
  const handler = makeHandler({ controller, renderer });

  await handler.handle('/model');

  const lines = pick(renderer.calls, 'status').map((call) => call[1]);
  const text = lines.join('\n');
  assert.ok(text.includes('deepseek-chat'));
  assert.ok(text.includes(DEFAULT_BASE_URL));
  assert.ok(text.includes(maskApiKey('sk-1234567890abcdef')));
  assert.ok(!text.includes('sk-1234567890abcdef'), 'API Key 明文绝不能回显');
});

test('/model 无参数：未配置时给出可执行的下一步', async () => {
  const renderer = makeRenderer();
  const { controller } = makeController();
  const { model } = makeModel({
    load: () => Promise.resolve({ provider: 'deepseek', baseUrl: DEFAULT_BASE_URL, model: null, apiKey: null, configured: false }),
  });
  const handler = makeHandler({ controller, renderer, model });

  await handler.handle('/model');

  const text = pick(renderer.calls, 'status')
    .map((call) => `${call[1]}${call[2].detail ? `：${call[2].detail}` : ''}`)
    .join('\n');
  assert.ok(text.includes('未配置') || text.includes('尚未配置'));
  assert.ok(text.includes('/model'), '未配置时要给出可执行的下一步（一句 /model 就够）');
});

test('/model 无参数：配置文件损坏时报「配置损坏」，不当成未配置', async () => {
  const configPath = path.join(await makeTempRoot('wwriting-cfg-'), 'config.json');
  await fs.writeFile(configPath, '{ 这不是 JSON', 'utf8');
  const renderer = makeRenderer();
  const { controller } = makeController();
  const model = { configPath, env: {}, load: loadModelConfig, save: null, mask: maskApiKey };
  const handler = makeHandler({ controller, renderer, model });

  await handler.handle('/model');

  const status = pick(renderer.calls, 'status').at(-1);
  const text = JSON.stringify(status);
  assert.ok(text.includes('损坏'), '应提示配置损坏');
  assert.ok(!text.includes('未配置'), '损坏 ≠ 未配置');
  assert.ok(text.includes('/model'), '应指向重新设置的入口');
  assert.ok(!text.includes('MODEL_CONFIG_INVALID'), '错误码不进主文案');
});

test('/model <模型名>：只改模型，不把 API Key 一起回写（undefined = 保留原值）', async () => {
  const renderer = makeRenderer();
  const { controller } = makeController();
  const { model, calls } = makeModel();
  const handler = makeHandler({ controller, renderer, model });

  await handler.handle('/model deepseek-reasoner');

  assert.equal(calls.save.length, 1);
  assert.equal(calls.save[0].model, 'deepseek-reasoner');
  assert.equal(calls.save[0].apiKey, undefined, 'apiKey 必须是 undefined（保留原值），不能是 null');
  assert.ok('apiKey' in calls.save[0] === false || calls.save[0].apiKey === undefined);

  const status = pick(renderer.calls, 'status').at(-1);
  assert.ok(status[1].includes('模型'));
  assert.ok(status[2].detail.includes('deepseek-reasoner'));
});

test('/model key <key>：保存后只回显脱敏串，明文与错误文本都不出现', async () => {
  const renderer = makeRenderer();
  const { controller } = makeController();
  const { model, calls } = makeModel();
  const handler = makeHandler({ controller, renderer, model });
  const plaintext = 'sk-abcdef1234567890';

  await handler.handle(`/model key ${plaintext}`);

  assert.equal(calls.save.length, 1);
  assert.equal(calls.save[0].apiKey, plaintext);
  assert.equal(calls.save[0].model, undefined);

  const dump = JSON.stringify(renderer.calls);
  assert.ok(dump.includes(maskApiKey(plaintext)), '应回显脱敏串');
  assert.ok(!dump.includes(plaintext), 'API Key 明文绝不能回显');
});

test('/model key <key>：保存失败时错误事实里也不带明文 key', async () => {
  const renderer = makeRenderer();
  const { controller } = makeController();
  const plaintext = 'sk-abcdef1234567890';
  const { model } = makeModel({
    save: () => Promise.reject(new Error('无法写入模型配置文件，请检查应用数据目录的权限。')),
  });
  const handler = makeHandler({ controller, renderer, model });

  await handler.handle(`/model key ${plaintext}`);

  const status = pick(renderer.calls, 'status').at(-1);
  assert.equal(status[2].tone, 'error');
  assert.ok(status[2].detail.includes('无法写入'));
  assert.ok(!JSON.stringify(renderer.calls).includes(plaintext));
});

test('/model key 缺值时只给用法，不落盘', async () => {
  const renderer = makeRenderer();
  const { controller } = makeController();
  const { model, calls } = makeModel();
  const handler = makeHandler({ controller, renderer, model });

  await handler.handle('/model key');

  assert.equal(calls.save.length, 0);
  assert.equal(calls.load.length, 0);
  assert.ok(pick(renderer.calls, 'status').at(-1)[1].includes('/model'), '指向 /model，而不是让人背用法');
});

// —— /sessions 与 /resume ——

test('/sessions 输出会话 ID、更新时间与状态', async () => {
  const renderer = makeRenderer();
  const { controller } = makeController();
  const summaries = [
    { session_id: 's-001', status: 'idle', updated_at: '2026-09-28T01:20:00.000Z' },
    { session_id: 's-002', status: 'interrupted', updated_at: '2026-09-27T22:05:00.000Z' },
  ];
  const handler = makeHandler({ controller, renderer, listSessions: () => Promise.resolve(summaries) });

  await handler.handle('/sessions');

  const text = pick(renderer.calls, 'status').map((call) => call[1]).join('\n');
  assert.ok(text.includes('s-001'));
  assert.ok(text.includes('s-002'));
  assert.ok(text.includes('2026-09-28'));
  assert.ok(text.includes('已中断'), '状态用中文呈现');
});

test('/sessions 无历史时给一条中文事实', async () => {
  const renderer = makeRenderer();
  const { controller } = makeController();
  const handler = makeHandler({ controller, renderer, listSessions: () => Promise.resolve([]) });

  await handler.handle('/sessions');

  const text = pick(renderer.calls, 'status').map((call) => call[1]).join('\n');
  assert.match(text, /[\u4e00-\u9fff]/);
  assert.ok(text.includes('没有') || text.includes('暂无'));
});

test('/sessions 读取失败时呈现一条事实，不抛错', async () => {
  const renderer = makeRenderer();
  const { controller } = makeController();
  const handler = makeHandler({
    controller,
    renderer,
    listSessions: () => Promise.reject(new Error('无法读取会话目录。')),
  });

  await handler.handle('/sessions');

  const status = pick(renderer.calls, 'status').at(-1);
  assert.equal(status[2].tone, 'error');
  assert.ok(status[2].detail.includes('无法读取会话目录'));
});

test('/resume <会话ID> 切换会话，并回显会话 ID', async () => {
  const renderer = makeRenderer();
  const { controller } = makeController();
  const resumed = [];
  const handler = makeHandler({
    controller,
    renderer,
    resumeSession: async (sessionId) => { resumed.push(sessionId); },
  });

  await handler.handle('/resume s-002');

  assert.deepEqual(resumed, ['s-002']);
  assert.ok(JSON.stringify(pick(renderer.calls, 'status')).includes('s-002'));
});

test('/resume 缺参数或切换失败都给一条可理解的事实', async () => {
  const renderer = makeRenderer();
  const { controller } = makeController();
  const resumed = [];
  const handler = makeHandler({
    controller,
    renderer,
    resumeSession: async (sessionId) => { resumed.push(sessionId); throw new Error('会话不存在：s-404'); },
  });

  await handler.handle('/resume');
  assert.deepEqual(resumed, []);
  const usage = pick(renderer.calls, 'status').at(-1);
  assert.ok(usage[1].includes('/resume'));

  await handler.handle('/resume s-404');
  assert.deepEqual(resumed, ['s-404']);
  const failed = pick(renderer.calls, 'status').at(-1);
  assert.equal(failed[2].tone, 'error');
  assert.ok(failed[2].detail.includes('会话不存在'));
});

// —— /resume 无参：交互式挑选会话（P23）——

test('/resume 无参且有选择器时打开挑选，选中即切换', async () => {
  const resumed = [];
  const handler = createCommandHandler({
    getController: () => ({ submit: async () => ({ status: 'completed' }), snapshot: () => ({ session_id: 'old' }) }),
    renderer: makeRenderer(),
    resumeSession: async (id) => { resumed.push(id); },
    pickSession: async () => 'sess_2',
  });
  await handler.handle('/resume');
  assert.deepEqual(resumed, ['sess_2']);
});

test('挑选被取消（Esc）时不切换，也不报错', async () => {
  const resumed = [];
  const handler = createCommandHandler({
    getController: () => ({ submit: async () => ({ status: 'completed' }), snapshot: () => ({ session_id: 'old' }) }),
    renderer: makeRenderer(),
    resumeSession: async (id) => { resumed.push(id); },
    pickSession: async () => null,
  });
  const result = await handler.handle('/resume');
  assert.deepEqual(resumed, []);
  assert.equal(result.action, 'handled');
});

test('挑选器自己抛（如 suspend 失败）时收敛成「切换失败」，不变成未处理拒绝', async () => {
  // 输入层是 `void handler.handle(text)` 调用的：挑选器抛出若逃出去就是未处理拒绝
  // （Node 默认终止进程），且输入框会被留在 suspend 状态。命令层必须收敛成一条事实。
  const resumed = [];
  const renderer = makeRenderer();
  const handler = createCommandHandler({
    getController: () => ({ submit: async () => ({ status: 'completed' }), snapshot: () => ({ session_id: 'old' }) }),
    renderer,
    resumeSession: async (id) => { resumed.push(id); },
    pickSession: async () => { throw new Error('终端已关闭'); },
  });
  await handler.handle('/resume');
  assert.deepEqual(resumed, []);
  const statuses = pick(renderer.calls, 'status');
  assert.equal(statuses[0][1], '切换失败');
  assert.match(statuses[0][2]?.detail ?? '', /终端已关闭/);
});

test('没有选择器（非交互 / 管道）时退回用法提示，不静默', async () => {
  const statuses = [];
  const handler = createCommandHandler({
    getController: () => ({ submit: async () => ({ status: 'completed' }) }),
    renderer: { ...makeRenderer(), printStatus: (text, options) => statuses.push([text, options]) },
    resumeSession: async () => {},
  });
  await handler.handle('/resume');
  assert.match(statuses.map(([line]) => String(line)).join('\n'), /\/resume <会话ID>/);
});

test('/resume <会话ID> 仍然直接切换，不打开挑选', async () => {
  const picked = [];
  const resumed = [];
  const handler = createCommandHandler({
    getController: () => ({ submit: async () => ({ status: 'completed' }), snapshot: () => ({ session_id: 'old' }) }),
    renderer: makeRenderer(),
    resumeSession: async (id) => { resumed.push(id); },
    pickSession: async () => { picked.push(true); return null; },
  });
  await handler.handle('/resume abc123');
  assert.deepEqual(resumed, ['abc123']);
  assert.deepEqual(picked, []);
});

// —— /stop 与 /quit ——

test('/stop 走同一个 run controller，不再重复报告一次「已停止」', async () => {
  const renderer = makeRenderer();
  const { controller, calls } = makeController();
  const handler = makeHandler({ controller, renderer });

  const before = pick(renderer.calls, 'status').length;
  await handler.handle('/stop');

  assert.equal(calls.stop.length, 1, '停止走的是同一个控制器');
  assert.equal(calls.close, 0, '停止不是注销会话');
  // 那一轮的终态行（run_interrupted → 「已停止」）马上会说同一件事；
  // 这里再回一句就是同一个事实说两遍（铁律 3：成功不弹 Toast）。
  assert.equal(pick(renderer.calls, 'status').length, before, '/stop 成功时不额外回话');
});

test('/stop 空闲时如实说明没有在跑的任务', async () => {
  const renderer = makeRenderer();
  const { controller } = makeController({ stopResult: { stopped: false, inputId: null } });
  const handler = makeHandler({ controller, renderer });

  await handler.handle('/stop');

  const status = pick(renderer.calls, 'status').at(-1);
  assert.notEqual(status[1], '已停止', '没有运行中的轮就不能说已停止');
  assert.match(status[1], /[\u4e00-\u9fff]/);
});

test('/quit 先 stop 再 close，然后才交给退出回调（D18）', async () => {
  const renderer = makeRenderer();
  const { controller, calls } = makeController();
  const order = [];
  const handler = makeHandler({
    controller,
    renderer,
    quit: () => { order.push('quit'); },
  });

  const result = await handler.handle('/quit');

  assert.deepEqual(result, { action: 'quit' });
  assert.deepEqual(calls.order, ['stop', 'close']);
  assert.deepEqual(order, ['quit']);
});

test('/quit 即使 stop / close 出错也不把错误抛给用户', async () => {
  const renderer = makeRenderer();
  const controller = {
    stop: () => { throw new Error('已关闭'); },
    close: async () => { throw new Error('已关闭'); },
    snapshot: () => ({ active_run_id: null }),
    permissions: { pending: () => [] },
  };
  const quit = [];
  const handler = makeHandler({ controller, renderer, quit: () => { quit.push(true); } });

  assert.deepEqual(await handler.handle('/quit'), { action: 'quit' });
  assert.equal(quit.length, 1);
});

// —— 确认代收（单一对话面） ——

const WRITE_DECISION = {
  decision_id: 'dec-1',
  input_id: 'i-1',
  level: 'write',
  tool: 'write_file',
  target: '第一章.md',
  choices: ['once', 'input', 'deny'],
  confirmation_text: null,
};

test('待确认时数字键代收确认，不当作新输入提交', async () => {
  const renderer = makeRenderer();
  const { controller, calls } = makeController({ pending: [WRITE_DECISION] });
  const handler = makeHandler({ controller, renderer });

  await handler.handle('1');
  assert.deepEqual(calls.decide, [{ decisionId: 'dec-1', choice: 'once', text: null }]);
  assert.equal(calls.submit.length, 0);

  await handler.handle('2');
  assert.equal(calls.decide.at(-1).choice, 'input');

  await handler.handle('拒绝');
  assert.equal(calls.decide.at(-1).choice, 'deny');
});

test('DECISION_CHOICES 是三个普通选项的唯一来源（顺序就是选择器里的顺序）', () => {
  // 选择器的 items 与文本映射都从这一份长出来（cli.mjs / commands.mjs），
  // 断言它本身，等于同时钉住了选择器会显示什么、以及有哪些词能答得通。
  assert.deepEqual(DECISION_CHOICES, [
    { choice: 'once', label: '一次允许' },
    { choice: 'input', label: '本条输入允许同类操作' },
    { choice: 'deny', label: '拒绝' },
  ]);
});

test('文字作答：三个标签与保留的别名都答得通（choiceFor 由 DECISION_CHOICES 长出来）', async () => {
  // 每个词都真的走一遍命令层：choiceFor 是私有的，可观察的结果就是 decide 收到了什么。
  const cases = [
    ['一次允许', 'once'],
    ['允许', 'once'],
    ['本条输入允许同类操作', 'input'],
    ['拒绝', 'deny'],
    ['deny', 'deny'],
    // 数字 1/2/3 是**不对外宣传的历史别名**：卡片与选择器提示里都不出现数字（铁律 11），
    // 保留它只为不弄坏既有的「按文本作答」路径（非 TTY / 管道 / 验收用例就是这么答的）。
    ['1', 'once'],
    ['2', 'input'],
    ['3', 'deny'],
  ];
  for (const [text, choice] of cases) {
    const renderer = makeRenderer();
    const { controller, calls } = makeController({ pending: [WRITE_DECISION] });
    const handler = makeHandler({ controller, renderer });

    await handler.handle(text);
    assert.equal(calls.decide.at(-1)?.choice, choice, `「${text}」应当答成 ${choice}`);
    assert.equal(calls.submit.length, 0, `「${text}」是在答确认，不该被当成新输入`);
  }
});

test('待确认但不匹配任何选项时，文本照常作为新输入提交', async () => {
  const renderer = makeRenderer();
  const { controller, calls } = makeController({ pending: [WRITE_DECISION] });
  const handler = makeHandler({ controller, renderer });

  await handler.handle('改成第三人称');

  assert.equal(calls.decide.length, 0);
  assert.deepEqual(calls.submit, [{ text: '改成第三人称' }]);
});

test('作答表用 null 原型：constructor / __proto__ 这类键不会被当成某个选项', async () => {
  // 映射表若是普通对象字面量，`DECISION_WORDS['constructor']` 会从 Object.prototype 上
  // 捡到 Object 的构造器（一个函数）并被当成 choice 返回——那既是一个错的选择，
  // 也是一条假事实（用户明明只是打了串正文）。Object.create(null) 让这些键查得 undefined，
  // 于是文本照常作为新输入提交，权限层根本不会被碰。
  for (const text of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    const { controller, calls } = makeController({ pending: [WRITE_DECISION] });
    const handler = makeHandler({ controller, renderer: makeRenderer() });

    await handler.handle(text);

    assert.equal(calls.decide.length, 0, `「${text}」不该被当成选项作答`);
    assert.deepEqual(calls.submit, [{ text }], `「${text}」应作为普通输入提交`);
  }
});

test('极端确认只认精确原文（或明确拒绝）', async () => {
  const renderer = makeRenderer();
  const extreme = {
    decision_id: 'dec-x',
    input_id: 'i-1',
    level: 'extreme',
    tool: 'delete_file',
    target: '草稿.md',
    choices: ['confirm', 'deny'],
    confirmation_text: '确认删除 a1b2c3',
  };
  const { controller, calls } = makeController({ pending: [extreme] });
  const handler = makeHandler({ controller, renderer });

  await handler.handle('1');
  assert.equal(calls.decide.length, 0, '数字不能代替精确确认文字');
  assert.equal(calls.submit.length, 1, '不匹配就走普通提交');

  await handler.handle('确认删除 a1b2c3');
  assert.deepEqual(calls.decide.at(-1), { decisionId: 'dec-x', choice: 'confirm', text: '确认删除 a1b2c3' });

  await handler.handle('拒绝');
  assert.equal(calls.decide.at(-1).choice, 'deny');
});

test('确认已被作废时给一条中文事实，不抛出', async () => {
  const renderer = makeRenderer();
  const { controller } = makeController({ pending: [WRITE_DECISION] });
  controller.decide = async () => {
    const error = new Error('这条确认已经失效，请重新执行该操作。');
    error.code = 'PERMISSION_DECISION_NOT_FOUND';
    throw error;
  };
  const handler = makeHandler({ controller, renderer });

  await handler.handle('1');

  const status = pick(renderer.calls, 'status').at(-1);
  assert.equal(status[2].tone, 'warn');
  assert.ok(status[2].detail.includes('已经失效'));
  assert.ok(!JSON.stringify(status).includes('PERMISSION_DECISION_NOT_FOUND'));
});

// —— 控制键（Ctrl+C / EOF） ——

test('Ctrl+C：有活动轮时只停当前轮，不退出', async () => {
  const { controller, calls } = makeController();
  controller.snapshot = () => ({ active_run_id: 'run-1' });
  const quit = [];
  const handler = makeHandler({ controller, renderer: makeRenderer(), quit: () => { quit.push(true); } });

  const result = await handler.handleControl('interrupt');

  assert.deepEqual(result, { action: 'stopped' });
  assert.equal(calls.stop.length, 1);
  assert.equal(quit.length, 0);
});

test('Ctrl+C：空闲时才退出，且退出前照常 stop → close', async () => {
  const { controller, calls } = makeController();
  const quit = [];
  const handler = makeHandler({ controller, renderer: makeRenderer(), quit: () => { quit.push(true); } });

  const result = await handler.handleControl('interrupt');

  assert.deepEqual(result, { action: 'quit' });
  assert.deepEqual(calls.order, ['stop', 'close']);
  assert.deepEqual(quit, [true]);
});

test('标准输入结束（EOF）等同于退出，不硬编码退出码', async () => {
  const { controller, calls } = makeController();
  const quit = [];
  const handler = makeHandler({ controller, renderer: makeRenderer(), quit: () => { quit.push(true); } });

  assert.deepEqual(await handler.handleControl('eof'), { action: 'quit' });
  assert.deepEqual(calls.order, ['stop', 'close']);
  assert.deepEqual(quit, [true]);
});

test('未知控制事件不改变任何状态', async () => {
  const { controller, calls } = makeController();
  const handler = makeHandler({ controller, renderer: makeRenderer() });

  assert.deepEqual(await handler.handleControl('whatever'), { action: 'ignored' });
  assert.deepEqual(calls.order, []);
});

test('命令层不画任何框线：框线归输入区（它才知道框有几行）', async () => {
  const renderer = makeRenderer();
  const { controller } = makeController();
  const handler = makeHandler({ controller, renderer });

  await handler.handle('/help');

  const status = pick(renderer.calls, 'status');
  assert.ok(status.length >= 6, '/help 是多行回复');
  assert.equal(JSON.stringify(renderer.calls).includes('rule'), false, '一条线都不该由命令层写');
});

// —— /now：提升队首输入并打断当前轮（D14 的「立即」）——

test('/now 把队首输入提升，并打断当前这一轮', async () => {
  const queue = [{ input_id: 'i-q1', text: '先写这个' }, { input_id: 'i-q2', text: '再写这个' }];
  const { controller, calls } = makeController({ queue, priorityResult: { inputId: 'i-q1', promoted: true, interrupted: true } });
  const recorder = makeRenderer();
  const handler = makeHandler({ controller, renderer: recorder });

  const result = await handler.handle('/now');
  assert.equal(result.action, 'handled');
  assert.deepEqual(calls.priority, ['i-q1'], '提升的是队首那一条');
  // 打断了当前轮就不再回话：那一轮的终态行会说同一件事（与 /stop 同理）。
  assert.deepEqual(pick(recorder.calls, 'status'), [], '打断时不额外回一句');
});

test('/now 在没有运行中的轮时回一句「已提到队首」', async () => {
  const queue = [{ input_id: 'i-q1', text: '先写这个' }];
  const { controller } = makeController({ queue, priorityResult: { inputId: 'i-q1', promoted: true, interrupted: false } });
  const recorder = makeRenderer();
  const handler = makeHandler({ controller, renderer: recorder });

  const result = await handler.handle('/now');
  assert.equal(result.action, 'handled');
  const statuses = pick(recorder.calls, 'status');
  assert.equal(statuses.length, 1, '只改顺序时必须说一句，否则用户看不到任何反馈');
  assert.ok(String(statuses[0][1]).includes('已提到队首'));
});

test('/now 在队列为空时如实说明，不静默', async () => {
  const { controller, calls } = makeController({ queue: [] });
  const recorder = makeRenderer();
  const handler = makeHandler({ controller, renderer: recorder });

  const result = await handler.handle('/now');
  assert.equal(result.action, 'handled');
  assert.deepEqual(calls.priority, [], '队列空时不该调用提升');
  const statuses = pick(recorder.calls, 'status');
  assert.equal(statuses.length, 1);
  assert.ok(String(statuses[0][1]).includes('队列为空'));
});

test('/now 提升失败时给出一条中文事实', async () => {
  const queue = [{ input_id: 'i-q1', text: 'x' }];
  const { controller } = makeController({ queue, priorityThrows: Object.assign(new Error('队列为空，没有可提升的输入。'), { code: 'QUEUE_EMPTY' }) });
  const recorder = makeRenderer();
  const handler = makeHandler({ controller, renderer: recorder });

  const result = await handler.handle('/now');
  assert.equal(result.action, 'handled');
  const statuses = pick(recorder.calls, 'status');
  assert.equal(statuses.length, 1);
  assert.ok(String(statuses[0][1]).includes('提升失败'));
});

test('正文里的「立即」不会被当成命令（写作时的正常用词）', async () => {
  const { controller, calls } = makeController();
  const handler = makeHandler({ controller, renderer: makeRenderer() });

  // 「他立即转身」是小说里随处可见的句子：绝不能因为含「立即」二字就被当成命令吞掉。
  const result = await handler.handle('他立即转身，推开了那扇门。');
  assert.equal(result.action, 'submit', '含「立即」的正文必须原样提交');
  assert.deepEqual(calls.priority, [], '不该触发提升');
  assert.equal(calls.submit.length, 1);
  assert.equal(calls.submit[0].text, '他立即转身，推开了那扇门。');

  // 裸词「立即」同样不被当作命令：首版没有这个词的命令形式（只有 /now）。
  const bare = await handler.handle('立即');
  assert.equal(bare.action, 'submit', '裸词「立即」按正文提交');
});

// —— /effort：档位的唯一用户可见面（P11 / P15）——

import { EFFORT_LEVELS, unsupportedEffortReason } from '../../src/model/effort.mjs';

function fakeEffort({ supported = true, levels = ['none', 'low', 'high', 'max'], model = 'deepseek-chat', initial = null } = {}) {
  let level = initial;
  const caps = { supported, levels, source: supported ? 'official' : 'none', model, baseUrl: 'https://api.deepseek.com' };
  return {
    get: () => level,
    describe: () => (level === null ? '自动' : level),
    capability: async () => caps,
    requestLevel: async () => (level !== null ? level : (supported ? 'high' : null)),
    // 与真实 createEffortState.set **同一套拒绝逻辑**：假实现若自己编理由，
    // 就测不出「理由里到底有没有那条出路」——那正是 D9-iii 的全部意义。
    set: async (next) => {
      if (next === null || next === undefined) { level = null; return { ok: true, level: null, reason: null }; }
      if (!levels.includes(next)) {
        return { ok: false, level, reason: supported ? `${model} 只支持 ${levels.join('、')}。` : unsupportedEffortReason(caps) };
      }
      level = next;
      return { ok: true, level, reason: null };
    },
    syncWithModel: async () => ({ reset: false, level, reason: null }),
  };
}

function effortRig(effort) {
  const renderer = makeRenderer();
  const handler = createCommandHandler({
    getController: () => ({ submit: async () => ({ status: 'completed' }), stop: () => ({ stopped: false }) }),
    renderer,
    effort,
  });
  // 主文案 + detail 一起看：铁律 3 把技术细节与数字都放进 detail，
  // 只断言主文案等于什么都没断。
  const text = () => pick(renderer.calls, 'status')
    .map(([, line, options]) => [line, options?.detail].filter((part) => typeof part === 'string' && part !== '').join('：'))
    .join('\n');
  return { handler, renderer, text };
}

test('/effort 无参回显当前档位与可用档位（这是主入口，P15）', async () => {
  const { handler, text } = effortRig(fakeEffort({ initial: 'high' }));
  await handler.handle('/effort');
  assert.match(text(), /当前 high/);
  assert.match(text(), /none、low、high、max/);
});

test('/effort <档位> 生效并回一句终态', async () => {
  const effort = fakeEffort();
  const { handler, renderer } = effortRig(effort);
  await handler.handle('/effort max');
  assert.equal(effort.get(), 'max');
  const statuses = pick(renderer.calls, 'status');
  assert.ok(statuses.some(([, line, options]) => String(line).includes('max') && options?.final === true));
});

test('/effort auto 与 /effort 自动 都回到自动（R9：词汇表不能自相矛盾）', async () => {
  for (const word of ['auto', '自动', 'AUTO']) {
    const effort = fakeEffort({ initial: 'max' });
    const { handler } = effortRig(effort);
    await handler.handle(`/effort ${word}`);
    assert.equal(effort.get(), null, `${word} 应当被接受`);
  }
});

test('下一轮生效：/effort 不打断正在跑的轮（与队列语义同构）', async () => {
  const stopped = [];
  const effort = fakeEffort();
  const handler = createCommandHandler({
    getController: () => ({
      submit: async () => ({ status: 'completed' }),
      stop: () => { stopped.push(true); return { stopped: false }; },
      snapshot: () => ({ active_run_id: 'run_1', queue: [] }),
    }),
    renderer: makeRenderer(),
    effort,
  });
  await handler.handle('/effort max');
  assert.deepEqual(stopped, [], '改一个本地变量而已，绝不打断在跑的轮');
  assert.equal(effort.get(), 'max');
});

test('档位不支持时本地就拒绝，并给出可核查的出路（D9-iii：不伪装生效）', async () => {
  const { handler, text } = effortRig(fakeEffort({ supported: false, levels: [], model: 'unknown' }));
  await handler.handle('/effort high');
  assert.match(text(), /reasoning_effort_levels/);
});

test('模型只支持部分档位时，拒绝理由里列出它到底支持哪几档', async () => {
  const { handler, text } = effortRig(fakeEffort({ levels: ['low', 'high', 'max'], model: 'glm-5.3' }));
  await handler.handle('/effort none');
  assert.match(text(), /low、high、max/);
});

test('不认识的档位回一条用法，不静默', async () => {
  const { handler, text } = effortRig(fakeEffort());
  await handler.handle('/effort turbo');
  assert.match(text(), /none、low、high、max/);
});

test('/effort 无参且模型不支持时，说明禁用理由而不是假装有个档位', async () => {
  const { handler, text } = effortRig(fakeEffort({ supported: false, levels: [], model: 'unknown' }));
  await handler.handle('/effort');
  assert.match(text(), /自动/);
  assert.match(text(), /未声明思考能力/);
});

test('没有注入 effort 状态时 /effort 如实说不可用，不抛（主文案 5 字，铁律 3）', async () => {
  const { handler, renderer, text } = effortRig(null);
  await handler.handle('/effort max');
  assert.match(text(), /当前没有可用的模型配置/);
  assert.equal(pick(renderer.calls, 'status')[0][1], '档位不可用');
});

test('/help 的命令表里有 /effort', async () => {
  const { handler, text } = effortRig(fakeEffort());
  await handler.handle('/help');
  assert.match(text(), /\/effort/);
});

test('/model 无交互能力时的配置回显里带一行思考强度（P15）', async () => {
  const renderer = makeRenderer();
  const handler = createCommandHandler({
    getController: () => ({ submit: async () => ({ status: 'completed' }) }),
    renderer,
    effort: fakeEffort({ initial: 'max' }),
    model: {
      configPath: '/tmp/config.json',
      load: async () => ({
        configured: true, model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-test-0000000000000000', apiKeySource: 'file',
      }),
      mask: (key) => 'sk-****0000',
    },
  });
  await handler.handle('/model');
  const lines = pick(renderer.calls, 'status').map(([, line]) => String(line));
  assert.ok(lines.some((line) => line.includes('思考强度') && line.includes('max')));
});

test('切模型后原档位不合法 → 重置为自动并如实说一句（P16，不静默）', async () => {
  const renderer = makeRenderer();
  let synced = { reset: true, level: null, reason: 'glm-5.3 不支持 none，思考强度已回到自动。' };
  const handler = createCommandHandler({
    getController: () => ({ submit: async () => ({ status: 'completed' }) }),
    renderer,
    effort: { ...fakeEffort(), syncWithModel: async () => synced },
    model: { configPath: '/tmp/c.json', load: async () => ({ configured: true, model: 'glm-5.3', baseUrl: 'https://g/v1', apiKey: 'sk-x', apiKeySource: 'file' }), mask: () => '****', listModels: async () => ['glm-5.3'], save: async () => {} },
  });
  await handler.handle('/model glm-5.3');
  const statuses = pick(renderer.calls, 'status');
  assert.ok(statuses.some(([, line]) => line === '档位已重置'), '主文案 5 字');
  assert.ok(statuses.some(([, , options]) => String(options?.detail ?? '').includes('glm-5.3')));
});

// —— /reasoning：思考全文的唯一展示入口（P21，上游三态 :178 + 重启态，R6）——

function reasoningRig(reasoning, { supported = true } = {}) {
  const printed = [];
  const renderer = makeRenderer();
  const handler = createCommandHandler({
    getController: () => ({ submit: async () => ({ status: 'completed' }) }),
    // makeRenderer() 没有 printReasoning，用展开补上（审查核过这一点）。
    renderer: { ...renderer, printReasoning: (text) => printed.push(text) },
    getReasoning: () => reasoning,
    effort: {
      get: () => null,
      describe: () => '自动',
      capability: async () => ({ supported, levels: supported ? ['none', 'low', 'high', 'max'] : [], source: supported ? 'official' : 'none', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com' }),
      requestLevel: async () => null,
      set: async () => ({ ok: true, level: null, reason: null }),
      syncWithModel: async () => ({ reset: false, level: null, reason: null }),
    },
  });
  // 主文案 + detail 一起看：铁律 3 把长说明都放进 detail，只断言主文案等于什么都没断。
  const text = () => pick(renderer.calls, 'status')
    .map(([, line, options]) => [line, options?.detail].filter((p) => typeof p === 'string' && p !== '').join('：'))
    .join('\n');
  return { handler, printed, renderer, text };
}

test('/reasoning 灰显重放上一轮的思考全文', async () => {
  const { handler, printed } = reasoningRig([{ text: '主角叫沈砚，这座城叫临渊。', durationMs: 12000 }]);
  await handler.handle('/reasoning');
  assert.deepEqual(printed, ['主角叫沈砚，这座城叫临渊。']);
});

test('一轮里有多段思考时按顺序全部重放', async () => {
  const { handler, printed } = reasoningRig([
    { text: '第一段', durationMs: 3000 },
    { text: '第二段', durationMs: 5000 },
  ]);
  await handler.handle('/reasoning');
  assert.deepEqual(printed, ['第一段', '第二段']);
});

test('模型不支持思考时用上游 unsupported 态那句原文，主文案 ≤6 字（R6 + 铁律 3）', async () => {
  const { handler, printed, renderer, text } = reasoningRig(null, { supported: false });
  await handler.handle('/reasoning');
  assert.deepEqual(printed, []);
  assert.equal(pick(renderer.calls, 'status')[0][1], '不支持查看');
  assert.match(text(), /当前模型不支持查看/);
});

test('/reasoning 有内容时即使能力表说不支持也照样重放，不说不支持查看（R6：屏幕见过思考行就不能回假事实）', async () => {
  // 反例来源：网关的 base_url 没声明 model_capabilities、或官方新模型还没进能力表时，
  // 端点仍可能返回 reasoning_content——思考采集是**无条件**的，屏幕上已经有「思考 N 秒」，
  // 此时回「不支持查看」就是一条与屏幕矛盾的假事实（R6：比不回答更糟）。
  const { handler, printed, renderer } = reasoningRig([{ text: '网关也给了思考全文', durationMs: 7000 }], { supported: false });
  await handler.handle('/reasoning');
  assert.deepEqual(printed, ['网关也给了思考全文']);
  assert.equal(pick(renderer.calls, 'status').length, 0, '有内容只重放全文，不该再打任何状态行（连「不支持查看」都不该出现）');
});

test('支持但本次没有内容时用上游 empty 态那句原文，且它在 detail 里（R7：主文案 5 字）', async () => {
  const { handler, printed, renderer, text } = reasoningRig(null);
  await handler.handle('/reasoning');
  assert.deepEqual(printed, []);
  assert.match(text(), /没有可查看的思考内容（本次无输出或该模型不支持）/);
  assert.equal(pick(renderer.calls, 'status')[0][1], '无思考内容');
});

test('重启后（本进程内没跑过完整一轮）不说假话：如实说全文不跨重启保留（R6）', async () => {
  // 屏幕上重演了「思考 12 秒」，/reasoning 却回答「本次无输出或该模型不支持」——
  // 那是一条**假事实**，比不回答更糟。这一态必须单独说清。
  const { handler, text } = reasoningRig([]);
  await handler.handle('/reasoning');
  assert.match(text(), /全文不跨重启保留/);
});

test('空数组与 null 走同一条路径', async () => {
  const a = reasoningRig([]);
  await a.handler.handle('/reasoning');
  const b = reasoningRig(null);
  await b.handler.handle('/reasoning');
  assert.equal(a.text(), b.text());
});

test('没有注入 getReasoning 时同样给 empty 态，不抛', async () => {
  const renderer = makeRenderer();
  const handler = createCommandHandler({
    getController: () => ({ submit: async () => ({ status: 'completed' }) }),
    renderer,
  });
  await handler.handle('/reasoning');
  assert.equal(pick(renderer.calls, 'status')[0][1], '无思考内容');
});

test('/reasoning 不打断正在跑的轮（它只是查一件已经发生的事）', async () => {
  const stopped = [];
  const handler = createCommandHandler({
    getController: () => ({
      submit: async () => ({ status: 'completed' }),
      stop: () => { stopped.push(true); return { stopped: false }; },
      snapshot: () => ({ active_run_id: 'run_1', queue: [] }),
    }),
    renderer: makeRenderer(),
    getReasoning: () => [{ text: '想', durationMs: 1000 }],
  });
  await handler.handle('/reasoning');
  assert.deepEqual(stopped, []);
});

test('/help 的命令表里有 /reasoning', async () => {
  const { handler, text } = reasoningRig(null);
  await handler.handle('/help');
  assert.match(text(), /\/reasoning/);
});
