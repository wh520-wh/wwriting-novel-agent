// DeepSeek 模型配置测试：环境变量优先、缺 key 未配置、默认端点、非法 JSON、脱敏。
// 全部使用 os.tmpdir() 下的临时目录，绝不触碰真实 %APPDATA%。
// 硬约束：任何断言都不得让真实 key 出现在错误文本里，测试自身也不打印 key 原文。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import {
  DEFAULT_BASE_URL,
  CONFIG_FIELDS,
  ModelConfigError,
  loadModelConfig,
  saveDeepSeekConfig,
  looksLikeApiKey,
  maskApiKey,
  normalizeBaseUrl,
  pickString,
  sanitizeInput,
} from '../../src/model/config.mjs';

// 临时目录登记：测试结束时统一删除。
const tempRoots = [];
after(async () => {
  await Promise.all(tempRoots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempRoot(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

// 一份不会与真实凭证混淆的假 key。
const FILE_KEY = 'sk-file0000000000FILE';
const ENV_KEY = 'sk-env1111111111ENV';

async function writeConfig(configPath, content) {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, content, 'utf8');
}

test('配置文件不存在时视为未配置，端点用默认值，不抛错', async () => {
  const tempRoot = await makeTempRoot('wwriting-model-missing-');
  const configPath = path.join(tempRoot, 'WWriting', 'config.json');

  const config = await loadModelConfig({ configPath, env: {} });

  assert.equal(config.provider, 'deepseek');
  assert.equal(config.configured, false);
  assert.equal(config.apiKey, null);
  assert.equal(config.model, null);
  assert.equal(config.baseUrl, DEFAULT_BASE_URL);
  assert.equal(DEFAULT_BASE_URL, 'https://api.deepseek.com');
});

test('读取配置文件：只取白名单字段，忽略其他字段', async () => {
  const tempRoot = await makeTempRoot('wwriting-model-read-');
  const configPath = path.join(tempRoot, 'WWriting', 'config.json');
  await writeConfig(configPath, JSON.stringify({
    provider: 'deepseek',
    base_url: 'https://file.example.com/v1/',
    model: 'deepseek-chat',
    api_key: FILE_KEY,
    yolo: true,
    workspace_id: 'ws_ignored',
  }));

  const config = await loadModelConfig({ configPath, env: {} });

  assert.equal(config.configured, true);
  assert.equal(config.apiKey, FILE_KEY);
  assert.equal(config.model, 'deepseek-chat');
  // 末尾斜杠被规范化掉，拼接路径时不会出现双斜杠。
  assert.equal(config.baseUrl, 'https://file.example.com/v1');
});

test('环境变量优先于配置文件：key 被覆盖，未设置的字段仍取文件值', async () => {
  const tempRoot = await makeTempRoot('wwriting-model-env-key-');
  const configPath = path.join(tempRoot, 'WWriting', 'config.json');
  await writeConfig(configPath, JSON.stringify({
    base_url: 'https://file.example.com',
    model: 'deepseek-chat',
    api_key: FILE_KEY,
  }));

  const config = await loadModelConfig({ configPath, env: { DEEPSEEK_API_KEY: ENV_KEY } });

  assert.equal(config.apiKey, ENV_KEY);
  assert.equal(config.model, 'deepseek-chat');
  assert.equal(config.baseUrl, 'https://file.example.com');
});

test('环境变量 DEEPSEEK_BASE_URL / DEEPSEEK_MODEL 同样覆盖配置文件', async () => {
  const tempRoot = await makeTempRoot('wwriting-model-env-all-');
  const configPath = path.join(tempRoot, 'WWriting', 'config.json');
  await writeConfig(configPath, JSON.stringify({
    base_url: 'https://file.example.com',
    model: 'deepseek-chat',
    api_key: FILE_KEY,
  }));

  const config = await loadModelConfig({
    configPath,
    env: {
      DEEPSEEK_BASE_URL: 'https://env.example.com/',
      DEEPSEEK_MODEL: 'deepseek-reasoner',
    },
  });

  assert.equal(config.baseUrl, 'https://env.example.com');
  assert.equal(config.model, 'deepseek-reasoner');
  // 未提供的 key 仍回落到文件。
  assert.equal(config.apiKey, FILE_KEY);
});

test('空的环境变量视为未设置，不覆盖配置文件', async () => {
  const tempRoot = await makeTempRoot('wwriting-model-env-blank-');
  const configPath = path.join(tempRoot, 'WWriting', 'config.json');
  await writeConfig(configPath, JSON.stringify({ api_key: FILE_KEY, model: 'deepseek-chat' }));

  const config = await loadModelConfig({ configPath, env: { DEEPSEEK_API_KEY: '   ', DEEPSEEK_MODEL: '' } });

  assert.equal(config.apiKey, FILE_KEY);
  assert.equal(config.model, 'deepseek-chat');
});

test('缺少 API Key 时 configured 为 false（文件缺字段或为空白）', async () => {
  const tempRoot = await makeTempRoot('wwriting-model-nokey-');
  const noField = path.join(tempRoot, 'WWriting', 'a.json');
  await writeConfig(noField, JSON.stringify({ model: 'deepseek-chat' }));
  const blank = path.join(tempRoot, 'WWriting', 'b.json');
  await writeConfig(blank, JSON.stringify({ model: 'deepseek-chat', api_key: '   ' }));

  assert.equal((await loadModelConfig({ configPath: noField, env: {} })).configured, false);
  const blankConfig = await loadModelConfig({ configPath: blank, env: {} });
  assert.equal(blankConfig.configured, false);
  assert.equal(blankConfig.apiKey, null);
  // 没有 key 时模型信息仍然可读，供 /model 提示补哪一样。
  assert.equal(blankConfig.model, 'deepseek-chat');
});

test('非法 JSON 抛中文错误，且错误文本与详情都不回显 key', async () => {
  const tempRoot = await makeTempRoot('wwriting-model-badjson-');
  const configPath = path.join(tempRoot, 'WWriting', 'config.json');
  await writeConfig(configPath, `{"api_key":"${FILE_KEY}","model":"deepseek-chat"`);

  await assert.rejects(
    () => loadModelConfig({ configPath, env: {} }),
    (error) => {
      assert.ok(error instanceof ModelConfigError);
      assert.match(error.message, /[\u4e00-\u9fff]/);
      assert.equal(error.message.includes(FILE_KEY), false);
      assert.equal(JSON.stringify(error.details).includes(FILE_KEY), false);
      return true;
    },
  );
});

test('配置文件不是对象（字符串 / 数组）同样按无效处理', async () => {
  const tempRoot = await makeTempRoot('wwriting-model-badshape-');
  const asString = path.join(tempRoot, 'WWriting', 'a.json');
  await writeConfig(asString, `"${FILE_KEY}"`);
  const asArray = path.join(tempRoot, 'WWriting', 'b.json');
  await writeConfig(asArray, `["${FILE_KEY}"]`);

  for (const configPath of [asString, asArray]) {
    await assert.rejects(
      () => loadModelConfig({ configPath, env: {} }),
      (error) => {
        assert.ok(error instanceof ModelConfigError);
        assert.match(error.message, /[\u4e00-\u9fff]/);
        assert.equal(error.message.includes(FILE_KEY), false);
        return true;
      },
    );
  }
});

test('配置路径为空抛中文错误', async () => {
  await assert.rejects(() => loadModelConfig({ configPath: '', env: {} }), /[\u4e00-\u9fff]/);
  await assert.rejects(() => loadModelConfig({ env: {} }), /[\u4e00-\u9fff]/);
});

test('saveDeepSeekConfig：父目录自动创建，写临时文件后 rename，不留临时文件', async () => {
  const tempRoot = await makeTempRoot('wwriting-model-save-');
  const configPath = path.join(tempRoot, 'WWriting', 'config.json');

  await saveDeepSeekConfig({ configPath, apiKey: FILE_KEY, model: 'deepseek-chat' });

  assert.equal(existsSync(configPath), true);
  const entries = await fs.readdir(path.join(tempRoot, 'WWriting'));
  assert.deepEqual(entries, ['config.json']);

  const config = await loadModelConfig({ configPath, env: {} });
  assert.equal(config.configured, true);
  assert.equal(config.apiKey, FILE_KEY);
  assert.equal(config.model, 'deepseek-chat');
});

test('saveDeepSeekConfig：只写白名单字段，保留已有 provider 与 base_url', async () => {
  const tempRoot = await makeTempRoot('wwriting-model-whitelist-');
  const configPath = path.join(tempRoot, 'WWriting', 'config.json');
  await writeConfig(configPath, JSON.stringify({
    provider: 'deepseek',
    base_url: 'https://keep.example.com',
    model: 'deepseek-chat',
    yolo: true,
  }));

  await saveDeepSeekConfig({ configPath, apiKey: FILE_KEY });

  const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
  for (const key of Object.keys(raw)) {
    assert.ok(CONFIG_FIELDS.includes(key), `不应写入白名单外字段：${key}`);
  }
  assert.equal(raw.provider, 'deepseek');
  assert.equal(raw.base_url, 'https://keep.example.com');
  assert.equal(raw.api_key, FILE_KEY);
  // 未提供的 model 保留原值，不被清空。
  assert.equal(raw.model, 'deepseek-chat');
});

test('saveDeepSeekConfig：空 key 或空模型名抛中文错误，且不动已有文件', async () => {
  const tempRoot = await makeTempRoot('wwriting-model-save-guard-');
  const configPath = path.join(tempRoot, 'WWriting', 'config.json');
  await writeConfig(configPath, JSON.stringify({ api_key: FILE_KEY, model: 'deepseek-chat' }));

  await assert.rejects(() => saveDeepSeekConfig({ configPath, apiKey: '   ' }), (error) => {
    assert.ok(error instanceof ModelConfigError);
    assert.match(error.message, /[\u4e00-\u9fff]/);
    return true;
  });
  await assert.rejects(() => saveDeepSeekConfig({ configPath, model: '' }), /[\u4e00-\u9fff]/);

  const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(raw.api_key, FILE_KEY);
  assert.equal(raw.model, 'deepseek-chat');
});

test('normalizeBaseUrl / pickString：归一化只有这一份实现，供流式客户端复用', () => {
  assert.equal(normalizeBaseUrl('https://a.example.com/'), 'https://a.example.com');
  assert.equal(normalizeBaseUrl('https://a.example.com///'), 'https://a.example.com');
  assert.equal(normalizeBaseUrl('  https://a.example.com  '), 'https://a.example.com');
  assert.equal(normalizeBaseUrl('   '), DEFAULT_BASE_URL);
  assert.equal(normalizeBaseUrl(null), DEFAULT_BASE_URL);

  assert.equal(pickString({ apiKey: `  ${FILE_KEY}  ` }, 'apiKey'), FILE_KEY);
  assert.equal(pickString({ apiKey: '   ' }, 'apiKey'), null);
  assert.equal(pickString({ apiKey: 123 }, 'apiKey'), null);
  assert.equal(pickString({}, 'apiKey'), null);
});

test('maskApiKey：只露首尾，绝不回显完整 key；短 key 与未设置另有文案', () => {
  const key = 'sk-abcdefghijklmnopqrstuvwxyz012345';
  const masked = maskApiKey(key);
  assert.notEqual(masked, key);
  assert.equal(key.includes(masked), false);
  assert.match(masked, /\*/);
  assert.equal(masked.startsWith('sk-'), true);
  assert.equal(masked.endsWith('2345'), true);

  // 过短的 key 一个字符都不露。
  assert.equal(maskApiKey('sk-short'), '****');
  assert.equal(maskApiKey('   '), '未设置');
  assert.equal(maskApiKey(null), '未设置');
  assert.equal(maskApiKey(undefined), '未设置');
});

// —— configExists：区分「从没配置过」（值得引导一次）与「配过但没填 key」——

test('configExists：文件不存在为 false；存在（哪怕没有 key）为 true', async () => {
  const tempRoot = await makeTempRoot('wwriting-model-exists-');
  const configPath = path.join(tempRoot, 'WWriting', 'config.json');

  const missing = await loadModelConfig({ configPath, env: {} });
  assert.equal(missing.configExists, false, '从没配置过 → 该走首次引导');
  assert.equal(missing.configured, false);

  // 用户在引导里跳过 Key 时写下的就是这份「只有厂商与端点」的配置：
  // 文件存在（不再重复引导），但依然算未配置。
  await saveDeepSeekConfig({ configPath });
  const skipped = await loadModelConfig({ configPath, env: {} });
  assert.equal(skipped.configExists, true, '跳过之后不该再问第二遍');
  assert.equal(skipped.configured, false, '没有 key 就还是未配置');
  assert.equal(skipped.apiKey, null);
  assert.equal(skipped.model, null);
  assert.equal(skipped.baseUrl, DEFAULT_BASE_URL);
});

test('configExists：环境变量临时给的 key 不影响「文件是否存在」', async () => {
  const tempRoot = await makeTempRoot('wwriting-model-exists-env-');
  const configPath = path.join(tempRoot, 'WWriting', 'config.json');

  const config = await loadModelConfig({ configPath, env: { DEEPSEEK_API_KEY: ENV_KEY } });

  assert.equal(config.configured, true, '环境变量能临时顶上一个 key');
  assert.equal(config.configExists, false, '但它不是「配置过」的证据');
});

// —— 输入归一化与「这看起来是 API Key」——
//
// 这一组来自一次真实事故：用户想设 API Key，敲的却是 `/model key` 加上粘贴的 Key，
// 而两者之间的空格没进去。整串 `keysk-…` 于是落进了模型名那一格，之后每一轮请求
// 都带着一个不存在的模型名出去、换回一句「API Key 无效」——人被指到了完全错误的方向。

test('sanitizeInput：去掉不可见字符、全角空格当空格、连续空白压成一个', () => {
  assert.equal(sanitizeInput('  a  b  '), 'a b');
  assert.equal(sanitizeInput('key\u200b sk-abc'), 'key sk-abc', '零宽空格不该把两个词粘在一起');
  assert.equal(sanitizeInput('key\u3000sk-abc'), 'key sk-abc', '全角空格也是分隔');
  assert.equal(sanitizeInput('\ufeffsk-abc'), 'sk-abc', 'BOM 要清掉');
  assert.equal(sanitizeInput(null), '');
  assert.equal(sanitizeInput(undefined), '');
});

test('looksLikeApiKey：认得出 sk- 开头的长串，也认得出被粘错的 keysk-…', () => {
  assert.equal(looksLikeApiKey('sk-abcdef0123456789abcdef0123456789'), true);
  // 少打一个空格：`key` + Key 粘成一串，前面的字母**不能**成为漏判的理由
  assert.equal(looksLikeApiKey('keysk-abcdef0123456789abcdef0123456789'), true);
  assert.equal(looksLikeApiKey('Bearer sk-abcdef0123456789abcdef0123456789'), true);
  // 正常的东西都不该被误判
  assert.equal(looksLikeApiKey('deepseek-chat'), false);
  assert.equal(looksLikeApiKey('deepseek-reasoner'), false);
  assert.equal(looksLikeApiKey('sk-short'), false, '太短的串不算（模型名可能有类似片段）');
  assert.equal(looksLikeApiKey(null), false);
  assert.equal(looksLikeApiKey(undefined), false);
});

test('保存：模型名那一格放着 API Key 一律拒收（这是最后一道防线）', async () => {
  const tempRoot = await makeTempRoot('wwriting-model-guard-');
  const configPath = path.join(tempRoot, 'WWriting', 'config.json');

  await assert.rejects(
    () => saveDeepSeekConfig({ configPath, model: 'keysk-0123456789abcdef0123456789abcdef' }),
    (error) => {
      assert.equal(error.code, 'MODEL_CONFIG_INVALID_MODEL');
      assert.match(error.message, /[\u4e00-\u9fff]/);
      return true;
    },
  );
  assert.equal(existsSync(configPath), false, '拒收就是拒收，一个字节都不写');

  // 同样的值当 Key 存就完全正常。
  await saveDeepSeekConfig({ configPath, apiKey: 'sk-0123456789abcdef0123456789abcdef' });
  const config = await loadModelConfig({ configPath, env: {} });
  assert.equal(config.configured, true);
});

test('保存与读取都会归一化：不可见字符进不了文件，也回不到内存里', async () => {
  const tempRoot = await makeTempRoot('wwriting-model-sanitize-');
  const configPath = path.join(tempRoot, 'WWriting', 'config.json');

  await saveDeepSeekConfig({ configPath, apiKey: `${FILE_KEY}\u200b`, model: 'deepseek-chat ' });

  const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(raw.api_key, FILE_KEY, '写入前就把零宽字符清掉');
  assert.equal(raw.model, 'deepseek-chat');
  const config = await loadModelConfig({ configPath, env: {} });
  assert.equal(config.apiKey, FILE_KEY);
  assert.equal(config.model, 'deepseek-chat');
});

test('apiKeySource 如实说明这个 Key 是从哪来的（环境变量会盖住配置文件）', async () => {
  const tempRoot = await makeTempRoot('wwriting-model-source-');
  const configPath = path.join(tempRoot, 'WWriting', 'config.json');
  await saveDeepSeekConfig({ configPath, apiKey: FILE_KEY, model: 'deepseek-chat' });

  const fromFile = await loadModelConfig({ configPath, env: {} });
  assert.equal(fromFile.apiKey, FILE_KEY);
  assert.equal(fromFile.apiKeySource, 'file');

  const fromEnv = await loadModelConfig({ configPath, env: { DEEPSEEK_API_KEY: ENV_KEY } });
  assert.equal(fromEnv.apiKey, ENV_KEY, '环境变量优先（临时覆盖）');
  assert.equal(fromEnv.apiKeySource, 'env', '必须能说出它压过了配置文件，否则用户永远查不出来');

  const none = await loadModelConfig({ configPath: path.join(tempRoot, 'x', 'config.json'), env: {} });
  assert.equal(none.apiKeySource, null);
});

// —— model_capabilities：网关用户为某个模型显式声明思考档位（D9 的第 (ii) 层）——

async function configWith(object) {
  const root = await makeTempRoot('wwriting-model-caps-');
  const configPath = path.join(root, 'WWriting', 'config.json');
  await writeConfig(configPath, JSON.stringify(object));
  return configPath;
}

// 注意 declaredLevels 是**声明原序**：排序要认 EFFORT_LEVELS，而 effort.mjs 已经 import 了
// config.mjs，反向再 import 就是循环依赖。归一化与排序只有 effort.mjs 一处定义。
test('loadModelConfig 返回当前模型声明的档位（原序，不排序）', async () => {
  const configPath = await configWith({
    provider: 'deepseek', base_url: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.3', api_key: FILE_KEY,
    model_capabilities: { 'glm-5.3': { reasoning_effort_levels: ['max', 'high', 'low'] } },
  });
  const config = await loadModelConfig({ configPath, env: {} });
  assert.deepEqual(config.declaredLevels, ['max', 'high', 'low']);
});

test('声明里混进非字符串项时只把字符串取出来（归一化留给 effort.mjs）', async () => {
  const configPath = await configWith({
    model: 'm', api_key: FILE_KEY, model_capabilities: { m: { reasoning_effort_levels: ['max', 3, null] } },
  });
  assert.deepEqual((await loadModelConfig({ configPath, env: {} })).declaredLevels, ['max']);
});

test('当前模型没有声明时 declaredLevels 是 null', async () => {
  const configPath = await configWith({
    model: 'deepseek-chat', api_key: FILE_KEY,
    model_capabilities: { 'glm-5.3': { reasoning_effort_levels: ['max'] } },
  });
  assert.equal((await loadModelConfig({ configPath, env: {} })).declaredLevels, null);
});

test('声明形状不对（不是数组 / 不是对象）时当成没声明，不抛', async () => {
  const configPath = await configWith({
    model: 'm', api_key: FILE_KEY,
    model_capabilities: { m: { reasoning_effort_levels: 'max' } },
  });
  assert.equal((await loadModelConfig({ configPath, env: {} })).declaredLevels, null);
});

test('model_capabilities 根本没有时 declaredLevels 是 null', async () => {
  const configPath = await configWith({ model: 'deepseek-chat', api_key: FILE_KEY });
  assert.equal((await loadModelConfig({ configPath, env: {} })).declaredLevels, null);
});

test('DEEPSEEK_MODEL 覆盖当前模型时，声明也跟着换（判定的键是「实际在用的那个模型」）', async () => {
  const configPath = await configWith({
    model: 'glm-5.3', api_key: FILE_KEY,
    model_capabilities: {
      'glm-5.3': { reasoning_effort_levels: ['max', 'high', 'low'] },
      'deepseek-chat': { reasoning_effort_levels: ['none'] },
    },
  });
  const config = await loadModelConfig({ configPath, env: { DEEPSEEK_MODEL: 'deepseek-chat' } });
  assert.equal(config.model, 'deepseek-chat');
  assert.deepEqual(config.declaredLevels, ['none']);
});

test('保存配置时 model_capabilities 原样保留，不被白名单洗掉', async () => {
  const configPath = await configWith({
    model: 'glm-5.3', api_key: FILE_KEY,
    model_capabilities: { 'glm-5.3': { reasoning_effort_levels: ['max'] } },
  });
  await saveDeepSeekConfig({ configPath, model: 'glm-5.3' });
  const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.deepEqual(raw.model_capabilities, { 'glm-5.3': { reasoning_effort_levels: ['max'] } },
    'saveDeepSeekConfig 只写 CONFIG_FIELDS 里的字段——漏了这个字段就会把用户的声明静默删掉');
});
