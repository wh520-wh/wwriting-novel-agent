// 主路径验收：真实组合根（main）+ 真实事件日志 + 真实会话锁 + 真实文件工具 + 真实权限层，
// 模型侧只用「真实 HTTP + 真实 SSE」的假 DeepSeek 服务，绝不接触网络。
//
// 驱动方式：直接调用 main()，注入伪 TTY stdin/stdout 与临时 APPDATA / 临时创作目录。
// 「进程重启」是真重启：用 node:child_process 起**两个真实 node 进程**各跑一次 main()
// （helpers/run-cli-once.mjs），进程 A 真写入 → 真退出 → 进程 B 用 `-c` 读回历史。
// 同进程内第二次调用 main() 覆盖不到模块级缓存、残留文件句柄与跨进程会话锁。
//
// 冒烟脚本（scripts/smoke-windows.ps1）会设置 WWRITING_SMOKE_ROOT，
// 让主路径的产物落在脚本可检查的固定位置；单独跑测试时各自用临时目录并在结束时清理。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { main } from '../../src/cli.mjs';
import { maskApiKey } from '../../src/model/config.mjs';
import { createSessionManager } from '../../src/session/session-manager.mjs';
import { createWorkspaceStore, workspaceIdForPath } from '../../src/storage/workspace-store.mjs';
import { versionLine } from '../../src/version.mjs';
import { screenText } from '../helpers/screen.mjs';

const SMOKE_ROOT = typeof process.env.WWRITING_SMOKE_ROOT === 'string' && process.env.WWRITING_SMOKE_ROOT !== ''
  ? process.env.WWRITING_SMOKE_ROOT
  : null;

const API_KEY = 'sk-acceptance-000000000000';
const tempRoots = [];

// 真实进程驱动脚本：它会在自己的进程里跑一次真实 main() 或真实会话读写，打印一行 JSON 结果。
const DRIVER_PATH = fileURLToPath(new URL('./helpers/run-cli-once.mjs', import.meta.url));

after(async () => {
  // Windows 上偶尔会因为句柄还没放开而 EPERM（与 tests/session 的既有抖动同类），重试几次即可。
  await Promise.all(tempRoots.map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

async function makeTempRoot(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

// 主路径场景的根目录：冒烟脚本指定 WWRITING_SMOKE_ROOT 时复用脚本建好的目录（脚本随后检查产物）。
async function mainPathPaths() {
  const root = SMOKE_ROOT ?? (await makeTempRoot('wwriting-accept-main-'));
  const appDataRoot = path.join(root, 'appdata');
  const workspace = path.join(root, 'novel');
  await fs.mkdir(appDataRoot, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  return { appDataRoot, workspace };
}

// 其余场景各自用独立临时目录，避免互相污染（也让「主路径」那一条能被冒烟脚本复用它自己的目录）。
async function ownPaths(prefix) {
  const root = await makeTempRoot(prefix);
  const appDataRoot = path.join(root, 'appdata');
  const workspace = path.join(root, 'novel');
  await fs.mkdir(appDataRoot, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  return { appDataRoot, workspace };
}

// 伪 TTY：readline 需要 isTTY / setRawMode，才会给出与真实终端一致的回显与 Ctrl+C 行为。
function makeFakeTTY() {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.columns = 80;
  stream.rows = 24;
  stream.isRaw = false;
  stream.setRawMode = () => {};
  return stream;
}

// 内存输出：readline 在 terminal 模式下会监听 output 的事件，所以用真流当外壳、只替换 write。
function makeSink({ tty = false } = {}) {
  const stream = new PassThrough();
  const chunks = [];
  stream.isTTY = tty;
  stream.columns = 80;
  stream.rows = 24;
  stream.write = (text) => {
    chunks.push(String(text));
    return true;
  };
  stream.text = () => chunks.join('');
  return stream;
}

// 组装 main() 需要的 io：应用私有数据只落在这个临时 APPDATA 里。
function makeIo({ appDataRoot, cwd, stdin = makeFakeTTY(), env = {}, tty = true }) {
  const stdout = makeSink({ tty });
  const stderr = makeSink();
  return {
    io: { stdin, stdout, stderr, cwd, env: { APPDATA: appDataRoot, NO_COLOR: '1', ...env } },
    stdin,
    stdout,
    stderr,
  };
}

// 真实 IO 是异步的：等条件成立，绝不用 sleep 猜时序。
async function waitFor(predicate, label = '条件', timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待${label}超时。`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function sse(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function textTurn(text) {
  return [
    sse({ choices: [{ delta: { content: text } }] }),
    sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]\n\n',
  ];
}

function toolTurn({ name, args, text = '', id = 'call_1' }) {
  return [
    ...(text === '' ? [] : [sse({ choices: [{ delta: { content: text } }] })]),
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] }),
    sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    'data: [DONE]\n\n',
  ];
}

// 带思考的轮：思考正文经 reasoning_content 的独立通道流下来（与可见正文两条通道绝不混），
// 每条思考各占一个完整的自然行——实时预览只在**攒满一行**时才重绘，半行不画。
function reasoningTurn(reasoningLines, text) {
  return [
    ...reasoningLines.map((line) => sse({ choices: [{ delta: { reasoning_content: `${line}\n` } }] })),
    ...(text === '' ? [] : [sse({ choices: [{ delta: { content: text } }] })]),
    sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]\n\n',
  ];
}

// 假 DeepSeek 服务：respond({ body, messages, index }) 返回这一轮要写的 SSE 分片。
// 返回一个未 resolve 的 Promise 就表示「这一轮挂着」——正好用来观察排队与停止。
// models 是 GET /models 要回的模型列表（首次引导用），默认给两个名字。
async function startFakeModel(respond, { models = ['deepseek-chat', 'deepseek-reasoner'], apiKey = null } = {}) {
  const requests = [];
  // apiKey 给了就当真：别的 Key 一律 401。用来验「Key 先验证、不通过就不保存」这条路径。
  const rejected = (req) => apiKey !== null && req.headers.authorization !== `Bearer ${apiKey}`;
  const server = http.createServer(async (req, res) => {
    // GET /models：引导页拿真实模型列表用。它没有请求体，也不能计入 requests
    // （各用例都在数「发了几轮对话」）。
    if (req.method === 'GET' && typeof req.url === 'string' && req.url.startsWith('/models')) {
      if (!res.destroyed) {
        if (rejected(req)) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Authentication Fails, Your api key is invalid' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: models.map((id) => ({ id, object: 'model', owned_by: 'deepseek' })) }));
      }
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (rejected(req)) {
      if (!res.destroyed) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Authentication Fails, Your api key is invalid' } }));
      }
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    const index = requests.length - 1;
    let payloads;
    try {
      payloads = await respond({ body, messages: body.messages ?? [], index, requests });
    } catch (error) {
      if (!res.destroyed) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: String(error?.message ?? error) } }));
      }
      return;
    }
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const payload of payloads) {
      if (res.destroyed) return;
      res.write(payload);
    }
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => {
      // 被挂起的请求（假模型一直不回）会一直占着连接，收尾时一并断开，别让 close 卡住。
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

// 写配置文件：API Key 只落在临时 APPDATA 的 config.json 里，绝不进创作目录。
async function writeConfig(appDataRoot, baseUrl, extra = {}) {
  const configPath = path.join(appDataRoot, 'WWriting', 'config.json');
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify({
    provider: 'deepseek',
    base_url: baseUrl,
    model: 'deepseek-chat',
    api_key: API_KEY,
    ...extra,
  }, null, 2)}\n`, 'utf8');
  return configPath;
}

// 只读地读出临时 APPDATA 里的会话事件（创作目录里绝不该有这些）。
async function readSessions(appDataRoot, workspace) {
  const sessionsDir = path.join(appDataRoot, 'WWriting', 'workspaces', workspaceIdForPath(workspace), 'sessions');
  let ids;
  try {
    ids = await fs.readdir(sessionsDir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const sessions = [];
  for (const id of ids) {
    const text = await fs.readFile(path.join(sessionsDir, id, 'events.jsonl'), 'utf8');
    sessions.push({
      id,
      events: text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line)),
    });
  }
  return sessions;
}

function runMessages(events) {
  return events.filter((event) => event.type === 'run_started').map((event) => event.data.text);
}

// 在一个真实 node 进程里跑一次驱动脚本（helpers/run-cli-once.mjs），取回它打印的 JSON 结果。
// stdout/stderr 各走独立管道；子进程超时则杀掉并报错，绝不让测试挂住。
function runCliProcess(spec, { timeoutMs = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DRIVER_PATH, JSON.stringify(spec)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`子进程在 ${timeoutMs}ms 内没有结束；stdout=${out} stderr=${err}`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      const last = out.trim().split('\n').filter((line) => line.trim() !== '').at(-1) ?? '';
      let result = null;
      try {
        result = JSON.parse(last);
      } catch {
        result = null;
      }
      resolve({ exitCode: code, result, stdout: out, stderr: err });
    });
  });
}

// 私有目录里当前还留着的锁标记（正常退出后应该一个都没有）。
async function lockEntries(appDataRoot, workspace) {
  const locksDir = path.join(appDataRoot, 'WWriting', 'workspaces', workspaceIdForPath(workspace), 'locks');
  try {
    return await fs.readdir(locksDir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

// 屏幕上这一行文案出现过几次（一轮 Run 结束就写一条「已完成」）。
function occurrences(text, needle) {
  return text.split(needle).length - 1;
}

// 停止是异步收尾的：等到会话投影上不再有活跃轮，再发下一条。
// 否则新输入会撞进控制器 drain 的收尾窗口，被当成排队输入（停止后不会自动开跑）。
// 这是真实行为（不是测试技巧），见任务报告里的发现。
async function waitIdle(appDataRoot, workspace) {
  const workspaceStore = createWorkspaceStore({ appDataRoot });
  const manager = createSessionManager({ workspaceStore });
  const [session] = await readSessions(appDataRoot, workspace);
  await waitFor(async () => {
    const snapshot = await manager.snapshot(workspace, session.id);
    return snapshot.active_run_id === null && snapshot.active_input_id === null;
  }, '停止收尾');
  await new Promise((resolve) => setTimeout(resolve, 30));
}

// 让交互式会话干净收尾：退出后 main() 才返回。
// 注意：调用前用户的行缓冲必须是空的（每个用例最后一步都是一次回车提交）。
async function quit(io, stdin, completion, stdout) {
  stdin.write('/quit\r');
  const code = await completion;
  assert.equal(code, 0, `退出码应为 0，实际 ${code}；屏幕：${stdout.text()}`);
  return code;
}

// 一个完整场景：临时工作区 + 假模型 + 把端点写进临时 APPDATA 的 config.json。
// （API Key 与端点只落在 APPDATA 里，绝不进创作目录。）
async function scenario(respond, paths = null) {
  const { appDataRoot, workspace } = paths ?? (await ownPaths('wwriting-accept-'));
  const model = await startFakeModel(respond);
  await writeConfig(appDataRoot, model.baseUrl);
  return { appDataRoot, workspace, model };
}

test('斜杠菜单用方向键选择，只补全草稿；Esc 返回输入框且不触发模型请求', { timeout: 15000 }, async () => {
  const { appDataRoot, workspace, model } = await scenario(() => textTurn('不应调用'));
  const run = makeIo({ appDataRoot, cwd: workspace });
  const completion = main(['--cwd', workspace], run.io);
  try {
    await waitFor(() => run.stdout.text().includes('开始新会话'));
    run.stdin.write('/\r');
    await waitFor(() => run.stdout.text().includes('建立或更新项目记忆'));
    run.stdin.write('\x1b[B'.repeat(8));
    run.stdin.write('\r');
    await waitFor(() => screenText(run.stdout.text(), { cols: 80, rows: 60 }).includes('❯ /help'));
    assert.equal(model.requests.length, 0, '选择命令不等于执行命令');
    run.stdin.write('\r');
    await waitFor(() => run.stdout.text().includes('可用命令'));
    run.stdin.write('/\r');
    await waitFor(() => screenText(run.stdout.text(), { cols: 80, rows: 60 }).includes('↑/↓ 选择'));
    run.stdin.write('\x1b');
    await waitFor(() => !screenText(run.stdout.text(), { cols: 80, rows: 60 }).includes('↑/↓ 选择'));
    assert.equal(model.requests.length, 0);
    await quit(run.io, run.stdin, completion, run.stdout);
  } finally {
    run.stdin.end();
    await completion;
    await model.close();
  }
});

test('主路径：打开目录 → 消息 → 模型调用 write_file → 确认 → 落盘 → session 完成', { timeout: 30000 }, async () => {
  // 冒烟脚本会指定路径并检查这里的产物，所以主路径这一条走 mainPathPaths。
  const { appDataRoot, workspace, model } = await scenario(
    ({ messages }) => (messages.some((message) => message.role === 'tool')
      ? textTurn('第一章已经写好。')
      : toolTurn({ name: 'write_file', args: { path: '第一章.md', content: '长街的灯次第亮起。' } })),
    await mainPathPaths(),
  );
  const run = makeIo({ appDataRoot, cwd: workspace });

  try {
    const completion = main(['--cwd', workspace, '写第一章'], run.io);

    // 头部面板：第一屏就有「名称 + 版本」，且排在启动状态行之前——
    // 启动器脚本与用户都靠这一行确认「现在跑的是哪个版本」。
    await waitFor(() => run.stdout.text().includes(versionLine()), '头部面板');
    {
      const screen = run.stdout.text();
      assert.ok(
        screen.indexOf(versionLine()) < screen.indexOf('开始新会话'),
        `版本应显示在启动状态行之前：${JSON.stringify(screen)}`,
      );
    }

    // 事件桥接上了：动态行真的出现过（漏接事件桥时这里什么都没有，而且不报错）。
    await waitFor(() => run.stdout.text().includes('思考中'), '动态状态行');
    // 写入门控生效：模型要写文件，用户先看到确认。
    await waitFor(() => run.stdout.text().includes('需要确认'), '确认提示');
    assert.ok(run.stdout.text().includes('写入文件 第一章.md'), '确认提示要说清写哪个文件');
    assert.equal(run.stdout.text().includes('第一章.md'), true);
    // 铁律 11：普通确认由方向键选择器接管，选项与按键提示必须真的出现在屏幕上——
    // 卡片自己不再印「回复 1/2/3」（伪 TTY 满足选择器的 canAsk，所以这条路真的被走到了）。
    await waitFor(() => run.stdout.text().includes('↑/↓ 选择'), '确认选择器');
    assert.ok(run.stdout.text().includes('本条输入允许同类操作'), '三个普通选项由选择器显示');
    assert.equal(/回复 \d/.test(run.stdout.text()), false, '屏幕上不得再出现数字答法');

    run.stdin.write('1\r'); // 选择器里的数字快捷方式：一次允许（方向键之外的老习惯）

    await waitFor(() => run.stdout.text().includes('已完成'), 'Run 终态');
    // 答了什么必须留在屏上。旧行为是用户敲的 `1` 作为用户行留下记录；选择器把它收成一行
    // `❯ 一次允许`——这条权限决定事后要能看出选的是哪一项，整块抹掉就等于没有凭据。
    //
    // 必须断在**最终画面**（helpers/screen.mjs）而不是原始字节流：选择器自己也会画一行
    // `❯ 一次允许`（光标行），字节流里它必然出现过，只断它等于只证明了「选择器跑过」
    // ——那正是上面 `↑/↓ 选择` 已经钉过的事。画面才是用户真正看到的东西。
    const finalScreen = screenText(run.stdout.text(), { cols: 80, rows: 60 });
    assert.ok(finalScreen.includes('❯ 一次允许'), '所选项在最终画面上留作记录（选择器那块已经收起）');
    // 收起是真的：临时那块（条目行 + 按键提示行）必须从画面上消失，只留收成的那一行；
    // summary 传 null 时这一行也会一起消失，上面那条立刻变红——这两条是彼此的判据。
    assert.equal(finalScreen.includes('本条输入允许同类操作'), false, '选择器收起后不留条目行');
    assert.equal(finalScreen.includes('↑/↓ 选择'), false, '选择器收起后不留按键提示行');
    await quit(run.io, run.stdin, completion, run.stdout);

    // 落盘：创作目录里只有被确认写入的那一个文件，私有数据一个字节都没进来。
    assert.equal(await fs.readFile(path.join(workspace, '第一章.md'), 'utf8'), '长街的灯次第亮起。');
    assert.deepEqual(await fs.readdir(workspace), ['第一章.md']);

    const sessions = await readSessions(appDataRoot, workspace);
    assert.equal(sessions.length, 1, '事件只落在临时 APPDATA 的私有会话目录里');
    const types = sessions[0].events.map((event) => event.type);
    for (const wanted of ['session_created', 'run_started', 'activity_started', 'decision_pending', 'decision_resolved', 'run_completed']) {
      assert.ok(types.includes(wanted), `事件日志里应有 ${wanted}`);
    }
    assert.equal(runMessages(sessions[0].events)[0], '写第一章');
  } finally {
    await model.close();
  }
});

test('思考可见：正在想的几句贴在实时区，跑完只留「思考 N 秒」，内容不进滚动区', { timeout: 30000 }, async () => {
  const { appDataRoot, workspace, model } = await scenario(() => reasoningTurn(
    ['主角为什么不肯离开，这里需要一个理由', '不然转折站不住'],
    '第一章写好了。',
  ));
  const run = makeIo({ appDataRoot, cwd: workspace });

  try {
    const completion = main(['--cwd', workspace, '写第一章'], run.io);

    // 正在想的那几句贴在输入框上方——这是「思考可见」的全部意义：
    // 用户看得见模型此刻在想什么，而不是只盯着一个「思考中」。
    await waitFor(
      () => run.stdout.text().includes('思考中 · 主角为什么不肯离开，这里需要一个理由'),
      '思考预览落屏',
    );
    assert.ok(
      run.stdout.text().includes('不然转折站不住'),
      `第二行也挂在实时区里（两行封顶）：${JSON.stringify(run.stdout.text().slice(-400))}`,
    );
    // 预览是**实时区**那一块，不是滚进对话里的散文：它由输入层原地重画，不占 scrollback。
    assert.equal(
      run.stdout.text().includes('\n▌ 主角为什么不肯离开'),
      false,
      '思考正文绝不用模型正文的标记混进对话',
    );

    // completion 是**整个会话**的退出承诺（等的是 /quit），不是单轮终态，所以这里等终态行。
    await waitFor(() => run.stdout.text().includes('已完成'), 'Run 终态');
    await quit(run.io, run.stdin, completion, run.stdout);

    // 跑完之后：结论行留在屏幕上，思考正文一句都不剩（它只活在实时区那一瞬）。
    const finalScreen = screenText(run.stdout.text(), { cols: 80, rows: 60 });
    assert.match(finalScreen, /思考 \d+ 秒/, '结论行留下来');
    assert.equal(
      finalScreen.includes('主角为什么不肯离开'),
      false,
      `思考内容不进最终画面（实时区的内容随下一次重绘消失）：${finalScreen}`,
    );
    assert.ok(finalScreen.includes('▌ 第一章写好了。'), '模型正文带自己的标记留在滚动区');

    // 事件日志里仍然只有轮末那一条（P18 不动）：预览走回调，一片都不落盘。
    const sessions = await readSessions(appDataRoot, workspace);
    const types = sessions[0].events.map((event) => event.type);
    assert.equal(types.includes('reasoning_delta'), false, '日志里没有增量事件');
    const done = sessions[0].events.find((event) => event.type === 'reasoning_completed');
    // 全文落盘、不截断（P19）：模型发下来的每一片都在，末尾那个换行也是它自己发的。
    assert.equal(done.data.text, '主角为什么不肯离开，这里需要一个理由\n不然转折站不住\n', '全文一条落盘');
    assert.equal(done.data.chars, done.data.text.length, 'chars 是全文长度');
  } finally {
    await model.close();
  }
});

test('重启后 -c：跨真实进程读回同一个会话与历史', { timeout: 90000 }, async () => {
  const { appDataRoot, workspace } = await ownPaths('wwriting-accept-');
  // 第二轮必须等一个**只属于它**的字符串：`-c` 启动时屏幕重演会把上一轮的「已完成」
  // 原样画回来，若等「已完成」驱动会在第二轮开跑前就把 /quit 发出去（技能目录发现
  // 让 run_started 晚了几毫秒，这个竞态从偶发变成了必现）。假模型按输入区分回复。
  const model = await startFakeModel(({ messages }) => {
    const last = [...messages].reverse().find((message) => message?.role === 'user');
    const reply = typeof last?.content === 'string' && last.content.includes('写第二章') ? '第二章好了。' : '好的。';
    return textTurn(reply);
  });
  await writeConfig(appDataRoot, model.baseUrl);

  try {
    // —— 进程 A：真实 node 进程，跑真实组合根，用一条消息开始新会话并完成一轮 ——
    const first = await runCliProcess({
      mode: 'main',
      appDataRoot,
      cwd: workspace,
      argv: ['--cwd', workspace, '写第一章'],
      lines: [{ await: '已完成', text: '/quit\r' }],
    });
    assert.equal(first.exitCode, 0, `进程 A 应正常退出；stdout=${first.stdout} stderr=${first.stderr}`);
    assert.ok(first.result, `进程 A 应打印一行 JSON 结果；stdout=${first.stdout}`);
    assert.equal(first.result.code, 0, `进程 A 的 main() 退出码应为 0；屏幕：${first.result.screen}`);
    assert.ok(first.result.screen.includes('已完成'), `进程 A 屏幕：${first.result.screen}`);

    const before = await readSessions(appDataRoot, workspace);
    assert.equal(before.length, 1, '进程 A 只应建一个会话');
    const sessionId = before[0].id;
    const firstSeq = before[0].events.at(-1).seq;
    assert.deepEqual(runMessages(before[0].events), ['写第一章']);

    // 进程 A 正常退出 ⇒ 写锁必须真的释放；否则进程 B 只会拿到 SESSION_BUSY（这也顺带验证退出清理路径）。
    assert.deepEqual(await lockEntries(appDataRoot, workspace), [], '进程 A 退出后不该留下会话锁');

    // —— 进程 B：另一个真实进程，`-c` 接着最近会话（裸启动现在开的是全新会话，P23）——
    const second = await runCliProcess({
      mode: 'main',
      appDataRoot,
      cwd: workspace,
      argv: ['--cwd', workspace, '-c'],
      lines: [
        { await: '继续最近会话', text: '写第二章\r' },
        { await: '第二章好了。', text: '/quit\r' },
      ],
    });
    assert.equal(second.exitCode, 0, `进程 B 应正常退出；stdout=${second.stdout} stderr=${second.stderr}`);
    assert.ok(second.result, `进程 B 应打印一行 JSON 结果；stdout=${second.stdout}`);
    assert.equal(second.result.code, 0, `进程 B 的 main() 退出码应为 0；屏幕：${second.result.screen}`);
    assert.ok(second.result.screen.includes('继续最近会话'), `进程 B 屏幕：${second.result.screen}`);
    assert.notEqual(second.result.pid, first.result.pid, '两次启动必须是两个真实进程');

    const after = await readSessions(appDataRoot, workspace);
    assert.equal(after.length, 1, '-c 不得新建会话');
    assert.equal(after[0].id, sessionId, '仍然是同一个 session_id');
    assert.ok(after[0].events.at(-1).seq > firstSeq, '历史在同一份事件日志上追加');
    assert.deepEqual(runMessages(after[0].events), ['写第一章', '写第二章']);
    // 重启后能读到「历史」：进程 A 那一轮的事件仍在同一份日志里。
    assert.ok(after[0].events.some((event) => event.type === 'run_completed'));
  } finally {
    await model.close();
  }
});

test('--resume 指定会话：历史接着长，队列与状态都跟着那个会话', { timeout: 30000 }, async () => {
  const { appDataRoot, workspace } = await ownPaths('wwriting-accept-');
  const model = await startFakeModel(() => textTurn('好的。'));
  await writeConfig(appDataRoot, model.baseUrl);

  try {
    const first = makeIo({ appDataRoot, cwd: workspace });
    const firstDone = main(['--cwd', workspace, '写第一章'], first.io);
    await waitFor(() => first.stdout.text().includes('已完成'), '第一轮完成');
    await quit(first.io, first.stdin, firstDone, first.stdout);

    // 另起一个会话，确保 --resume 真的按 ID 选，而不是「选最近的」。
    const other = makeIo({ appDataRoot, cwd: workspace });
    const otherDone = main(['--cwd', workspace, '写另一个'], other.io);
    await waitFor(() => other.stdout.text().includes('已完成'), '另一个会话完成');
    await quit(other.io, other.stdin, otherDone, other.stdout);

    const sessions = await readSessions(appDataRoot, workspace);
    assert.equal(sessions.length, 2);
    const target = sessions.find((session) => runMessages(session.events)[0] === '写第一章');
    const untouched = sessions.find((session) => session.id !== target.id);
    const untouchedSeq = untouched.events.at(-1).seq;

    const resumed = makeIo({ appDataRoot, cwd: workspace });
    const resumedDone = main(['--cwd', workspace, '--resume', target.id], resumed.io);
    await waitFor(() => resumed.stdout.text().includes('恢复会话'), '恢复状态行');
    // 先等重演**真的落屏**再取基线：`恢复会话` 是启动面板写的，而面板跑在重演之前
    // （cli.mjs：面板 → replay → input.start()），中间还夹着一次 await controller.readEvents()。
    // 若在这一刻就把基线取成 0，重演自己那条历史 `已完成` 就会让下面的屏障提前成立，
    // 紧接着的 /quit 会把新那一轮取消掉——这正是这条用例之前红过的形态。
    // 重演的用户行只有重演会写（此时还没有输入框、也还没人敲过字），所以它是可靠的信标；
    // 而且它与终态文案无关，不会被旧屏障的那个信号顶掉。
    await waitFor(() => resumed.stdout.text().includes('❯ 写第一章'), '启动重演已落屏');
    resumed.stdin.write('接着写\r');
    // 屏障必须是「**多了一条**收尾行」而不是「屏幕上有收尾行」：启动时重演上一轮，
    // 历史那一轮的 `已完成` 此刻已经在屏幕上了，裸 includes 会在新那一轮跑完之前就成立，
    // 紧接着的 /quit 会把它取消掉（这正是它之前红过的原因）。
    const completedBefore = occurrences(resumed.stdout.text(), '已完成');
    await waitFor(
      () => occurrences(resumed.stdout.text(), '已完成') > completedBefore,
      '恢复后的这一轮完成',
    );
    await quit(resumed.io, resumed.stdin, resumedDone, resumed.stdout);

    const afterResume = await readSessions(appDataRoot, workspace);
    const resumedSession = afterResume.find((session) => session.id === target.id);
    assert.deepEqual(runMessages(resumedSession.events), ['写第一章', '接着写']);
    assert.equal(afterResume.find((session) => session.id === untouched.id).events.at(-1).seq, untouchedSeq, '另一个会话不受影响');
  } finally {
    await model.close();
  }
});

test('运行中输入排队：同一时刻只有一个请求，排队输入在队首那轮结束后按序执行', { timeout: 30000 }, async () => {
  const { appDataRoot, workspace } = await ownPaths('wwriting-accept-');
  const gate = deferred();
  const model = await startFakeModel(({ index }) => (index === 0 ? gate.promise : textTurn('好的。')));
  await writeConfig(appDataRoot, model.baseUrl);
  const run = makeIo({ appDataRoot, cwd: workspace });

  try {
    const completion = main(['--cwd', workspace, '第一条'], run.io);
    await waitFor(() => model.requests.length === 1, '第一轮请求到达模型');

    run.stdin.write('第二条\r');
    await waitFor(() => run.stdout.text().includes('排队'), '排队行');
    assert.ok(run.stdout.text().includes('第二条   排队'), '排队行要带上原文');
    // 单 Agent 不变量：第二轮不会在第一条还挂着的时候发出去。
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(model.requests.length, 1, '同一时刻只能有一个模型请求');

    gate.resolve(textTurn('第一条写好了。'));
    await waitFor(() => model.requests.length === 2, '队列里的第二条接着跑');
    await waitFor(() => occurrences(run.stdout.text(), '已完成') >= 2, '两轮都完成');
    await quit(run.io, run.stdin, completion, run.stdout);

    const sessions = await readSessions(appDataRoot, workspace);
    assert.deepEqual(runMessages(sessions[0].events), ['第一条', '第二条'], '队列按 FIFO 消费');
    assert.ok(sessions[0].events.some((event) => event.type === 'input_queued' && event.data.text === '第二条'));
  } finally {
    await model.close();
  }
});

test('行缓冲协作：Run 进行中的动态行不会擦掉用户正在键入的内容', { timeout: 30000 }, async () => {
  const { appDataRoot, workspace } = await ownPaths('wwriting-accept-');
  const gate = deferred();
  // 按「这一轮的输入原文」决定挂起还是回应，绝不按服务端收到的第几个请求：
  // 第一轮的请求可能在 Ctrl+C 取消时还没到达服务端，用到达序数会把第二轮误判成第一轮而永久挂起。
  const lastUserText = (messages) => {
    const lastUser = [...messages].reverse().find((message) => message.role === 'user');
    return lastUser ? lastUser.content : '';
  };
  const model = await startFakeModel(({ messages }) => (lastUserText(messages) === '第一条' ? gate.promise : textTurn('好的。')));
  await writeConfig(appDataRoot, model.baseUrl);
  const run = makeIo({ appDataRoot, cwd: workspace });

  try {
    const completion = main(['--cwd', workspace, '第一条'], run.io);
    await waitFor(() => run.stdout.text().includes('思考中'), '动态状态行');

    // 用户开始键入下一条，还没回车（渲染期间回显是增量的，所以只断言内容出现）。
    run.stdin.write('第二条');
    await waitFor(() => run.stdout.text().includes('第二条'), 'readline 回显');

    // 期间来一次渲染（Ctrl+C 停止当前轮 → run_interrupted → 终态行）。
    run.stdin.write('\x03');
    await waitFor(() => run.stdout.text().includes('已停止'), '停止事实');

    const shown = run.stdout.text();
    assert.ok(shown.lastIndexOf('❯ 第二条') > shown.lastIndexOf('已停止'), '渲染后用户键入的内容仍在屏幕上');

    // 行缓冲没被吃掉：等停止收尾后回车，把补完的整行提交出去。
    await waitIdle(appDataRoot, workspace);
    run.stdin.write('，继续\r');
    // 第一轮的请求可能根本没到达假服务端（取消早于连接），所以等「这一轮跑完」而不是等请求计数。
    await waitFor(() => run.stdout.text().includes('已完成'), '补完的这一轮完成');
    await quit(run.io, run.stdin, completion, run.stdout);

    const sessions = await readSessions(appDataRoot, workspace);
    assert.deepEqual(runMessages(sessions[0].events), ['第一条', '第二条，继续']);
  } finally {
    await model.close();
  }
});

test('停止：当前轮收敛为已停止，队列留待下一次输入继续消费', { timeout: 30000 }, async () => {
  const { appDataRoot, workspace } = await ownPaths('wwriting-accept-');
  const gate = deferred();
  const model = await startFakeModel(({ index }) => (index === 0 ? gate.promise : textTurn('好的。')));
  await writeConfig(appDataRoot, model.baseUrl);
  const run = makeIo({ appDataRoot, cwd: workspace });

  try {
    const completion = main(['--cwd', workspace, '第一条'], run.io);
    await waitFor(() => model.requests.length === 1, '第一轮请求到达模型');
    run.stdin.write('第二条\r');
    await waitFor(() => run.stdout.text().includes('排队'), '排队行');

    run.stdin.write('\x03'); // 第一次 Ctrl+C：有活动轮 → 停止当前轮（不退出）
    await waitFor(() => run.stdout.text().includes('已停止'), '停止事实');

    // 会话仍然可用：等停止收尾后再发一条，停在队列里的第二条按 FIFO 一起跑完。
    await waitIdle(appDataRoot, workspace);
    run.stdin.write('第三条\r');
    await waitFor(() => occurrences(run.stdout.text(), '已完成') >= 2, '恢复后的两轮都完成');
    await quit(run.io, run.stdin, completion, run.stdout);

    const sessions = await readSessions(appDataRoot, workspace);
    assert.deepEqual(runMessages(sessions[0].events), ['第一条', '第二条', '第三条']);
    const interrupts = sessions[0].events.filter((event) => event.type === 'run_interrupted');
    assert.equal(
      interrupts.length,
      1,
      `只该停止一次；实际事件：${sessions[0].events.map((event) => event.type).join(',')}`,
    );
    assert.equal(interrupts[0].data.reason, 'user_stop');
  } finally {
    await model.close();
  }
});

test('/resume：在会话里切换到另一个会话，后续事件写进新会话', { timeout: 30000 }, async () => {
  const { appDataRoot, workspace } = await ownPaths('wwriting-accept-');
  const model = await startFakeModel(() => textTurn('好的。'));
  await writeConfig(appDataRoot, model.baseUrl);

  try {
    const first = makeIo({ appDataRoot, cwd: workspace });
    const firstDone = main(['--cwd', workspace, '甲'], first.io);
    await waitFor(() => first.stdout.text().includes('已完成'), '甲会话完成');
    await quit(first.io, first.stdin, firstDone, first.stdout);

    const other = makeIo({ appDataRoot, cwd: workspace });
    const otherDone = main(['--cwd', workspace, '乙'], other.io);
    await waitFor(() => other.stdout.text().includes('已完成'), '乙会话完成');
    await quit(other.io, other.stdin, otherDone, other.stdout);

    const sessions = await readSessions(appDataRoot, workspace);
    const target = sessions.find((session) => runMessages(session.events)[0] === '甲');
    const current = sessions.find((session) => session.id !== target.id);
    const currentSeq = current.events.at(-1).seq;

    const run = makeIo({ appDataRoot, cwd: workspace });
    const completion = main(['--cwd', workspace, '--resume', current.id], run.io);
    await waitFor(() => run.stdout.text().includes('恢复会话'), '恢复状态行');
    run.stdin.write(`/resume ${target.id}\r`);
    await waitFor(() => run.stdout.text().includes('已切换会话'), '切换回复');
    run.stdin.write('丙\r');
    // 同上一处：启动重演会先写一条历史轮的 `已完成`，屏障要看「多了一条」。
    const completedBefore = occurrences(run.stdout.text(), '已完成');
    await waitFor(
      () => occurrences(run.stdout.text(), '已完成') > completedBefore,
      '切换后的这一轮完成',
    );
    await quit(run.io, run.stdin, completion, run.stdout);

    const afterSwitch = await readSessions(appDataRoot, workspace);
    assert.deepEqual(runMessages(afterSwitch.find((session) => session.id === target.id).events), ['甲', '丙']);
    assert.equal(
      afterSwitch.find((session) => session.id === current.id).events.at(-1).seq,
      currentSeq,
      '旧会话在切换后再没有新的写入',
    );
  } finally {
    await model.close();
  }
});

test('模型 HTTP 错误：Run 以一条中文事实收场，进程照常可用', { timeout: 30000 }, async () => {
  const { appDataRoot, workspace } = await ownPaths('wwriting-accept-');
  const server = http.createServer((req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'upstream down' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  await writeConfig(appDataRoot, baseUrl);
  const run = makeIo({ appDataRoot, cwd: workspace });

  try {
    const completion = main(['--cwd', workspace, '写第一章'], run.io);
    await waitFor(() => run.stdout.text().includes('操作失败'), '失败事实');
    const shown = run.stdout.text();
    assert.match(shown, /服务暂时不可用/);
    assert.ok(!shown.includes('MODEL_HTTP_ERROR'), '错误码不进主文案');
    await quit(run.io, run.stdin, completion, run.stdout);

    const sessions = await readSessions(appDataRoot, workspace);
    const failed = sessions[0].events.find((event) => event.type === 'run_failed');
    assert.equal(failed.data.code, 'MODEL_HTTP_ERROR');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('用户拒绝写入：文件不落盘，拒绝作为一条中文事实呈现', { timeout: 30000 }, async () => {
  const { appDataRoot, workspace } = await ownPaths('wwriting-accept-');
  const model = await startFakeModel(({ messages }) => (
    messages.some((message) => message.role === 'tool')
      ? textTurn('那我先不写了。')
      : toolTurn({ name: 'write_file', args: { path: '第一章.md', content: '不该落盘' } })
  ));
  await writeConfig(appDataRoot, model.baseUrl);
  const run = makeIo({ appDataRoot, cwd: workspace });

  try {
    const completion = main(['--cwd', workspace, '写第一章'], run.io);
    await waitFor(() => run.stdout.text().includes('需要确认'), '确认提示');
    run.stdin.write('3\r'); // 拒绝
    await waitFor(() => run.stdout.text().includes('已完成'), 'Run 终态');
    await quit(run.io, run.stdin, completion, run.stdout);

    assert.ok(!(await fs.readdir(workspace)).includes('第一章.md'), '拒绝后绝不落盘');
    const shown = run.stdout.text();
    assert.ok(shown.includes('✗ 写入文件 第一章.md'), '被拒绝的写入要留下一条终态活动行');
    const sessions = await readSessions(appDataRoot, workspace);
    const activity = sessions[0].events.find((event) => event.type === 'activity_finished');
    assert.equal(activity.data.ok, false);
    const decision = sessions[0].events.find((event) => event.type === 'decision_resolved');
    assert.equal(decision.data.allowed, false);
  } finally {
    await model.close();
  }
});

// Esc 在选择器里 = 取消 = **拒绝这一次操作**（src/cli.mjs 把 null 读成 deny，落在安全的一侧）。
// 这条路径此前没有任何覆盖：它既要证明「拒绝」真的拒绝（文件不落盘），
// 也要证明取消那次决定留下了记录（`❯ 拒绝` 收成一行留在屏上，而不是和「什么都没发生」长得一样）。
test('用户按 Esc 取消确认：按拒绝读，文件不落盘，并在屏上留下「❯ 拒绝」记录', { timeout: 30000 }, async () => {
  const { appDataRoot, workspace } = await ownPaths('wwriting-accept-');
  const model = await startFakeModel(({ messages }) => (
    messages.some((message) => message.role === 'tool')
      ? textTurn('那我先不写了。')
      : toolTurn({ name: 'write_file', args: { path: '第一章.md', content: '不该落盘' } })
  ));
  await writeConfig(appDataRoot, model.baseUrl);
  const run = makeIo({ appDataRoot, cwd: workspace });

  try {
    const completion = main(['--cwd', workspace, '写第一章'], run.io);
    // 伪 TTY 满足选择器的 canAsk，所以这里真的走选择器（与「用户拒绝写入」那条同形）。
    await waitFor(() => run.stdout.text().includes('↑/↓ 选择'), '确认选择器');

    run.stdin.write('\x1b'); // Esc：选择器取消 → 按拒绝读（与 /model 向导那条用同一个字节）

    // (a) Run 照常收敛（拒绝只否掉这一次操作，不打断整轮）。
    await waitFor(() => run.stdout.text().includes('已完成'), 'Run 终态', 15000);
    // (b) 取消那次决定留在最终画面上：一行 `❯ 拒绝`（cancelSummary），而不是被整块抹掉。
    //     （初始光标在第一项 `一次允许`，所以 `❯ 拒绝` 只可能来自这条 cancelSummary。）
    const finalScreen = screenText(run.stdout.text(), { cols: 80, rows: 60 });
    assert.ok(finalScreen.includes('❯ 拒绝'), `取消要留下记录；画面：${finalScreen}`);
    await quit(run.io, run.stdin, completion, run.stdout);

    // (c) 拒绝必须真的拒绝：模型请求写的那个文件一个字节都不该出现。
    assert.ok(!(await fs.readdir(workspace)).includes('第一章.md'), '拒绝后绝不落盘');

    const sessions = await readSessions(appDataRoot, workspace);
    const decision = sessions[0].events.find((event) => event.type === 'decision_resolved');
    assert.equal(decision.data.allowed, false, '事件里也记成一次拒绝');
  } finally {
    await model.close();
  }
});

test('启动错误：会话被另一个进程占用 → 一条中文事实 + 非零退出码', { timeout: 30000 }, async () => {
  const { appDataRoot, workspace } = await ownPaths('wwriting-accept-');
  const model = await startFakeModel(() => textTurn('好的。'));
  await writeConfig(appDataRoot, model.baseUrl);

  try {
    const seed = makeIo({ appDataRoot, cwd: workspace });
    const seedDone = main(['--cwd', workspace, '先建一个会话'], seed.io);
    await waitFor(() => seed.stdout.text().includes('已完成'), '建会话完成');
    await quit(seed.io, seed.stdin, seedDone, seed.stdout);

    // 另一个写入者（同一会话的第二个进程）拿着写锁。
    const workspaceStore = createWorkspaceStore({ appDataRoot });
    const other = createSessionManager({ workspaceStore });
    const sessions = await readSessions(appDataRoot, workspace);
    const held = await other.openById(workspace, sessions[0].id);

    try {
      const run = makeIo({ appDataRoot, cwd: workspace });
      // `-c` 才会去开那个已被占用的最近会话；裸启动现在开的是全新会话，锁根本不冲突（P23）。
      const code = await main(['--cwd', workspace, '-c'], run.io);
      assert.notEqual(code, 0);
      assert.equal(run.stdout.text(), '', '启动失败不该往 stdout 写东西');
      const message = run.stderr.text();
      assert.match(message, /[\u4e00-\u9fff]/);
      assert.ok(!/\n\s+at /.test(message), '不得把堆栈抖给用户');
      assert.match(message, /会话/);
    } finally {
      await held.close();
    }
  } finally {
    await model.close();
  }
});

test('启动错误：应用私有目录不可用 → 一条中文事实 + 非零退出码', { timeout: 30000 }, async () => {
  const { appDataRoot, workspace } = await ownPaths('wwriting-accept-');
  // 私有目录里本该是 sessions 目录的位置被一个文件占住，工作区准备直接失败。
  const workspaceDir = path.join(appDataRoot, 'WWriting', 'workspaces', workspaceIdForPath(workspace));
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(path.join(workspaceDir, 'sessions'), 'not a directory', 'utf8');

  const run = makeIo({ appDataRoot, cwd: workspace });
  const code = await main(['--cwd', workspace], run.io);
  assert.notEqual(code, 0);
  assert.equal(run.stdout.text(), '');
  const message = run.stderr.text();
  assert.match(message, /[\u4e00-\u9fff]/);
  assert.ok(!/\n\s+at /.test(message));
});

test('启动错误：事件日志损坏 → 一条中文事实 + 非零退出码', { timeout: 30000 }, async () => {
  const { appDataRoot, workspace } = await ownPaths('wwriting-accept-');
  const model = await startFakeModel(() => textTurn('好的。'));
  await writeConfig(appDataRoot, model.baseUrl);

  try {
    const seed = makeIo({ appDataRoot, cwd: workspace });
    const seedDone = main(['--cwd', workspace, '先建一个会话'], seed.io);
    await waitFor(() => seed.stdout.text().includes('已完成'), '建会话完成');
    await quit(seed.io, seed.stdin, seedDone, seed.stdout);

    const sessions = await readSessions(appDataRoot, workspace);
    const logPath = path.join(
      appDataRoot, 'WWriting', 'workspaces', workspaceIdForPath(workspace), 'sessions', sessions[0].id, 'events.jsonl',
    );
    // 完整的一行（以换行结尾）但不是合法事件：这是损坏，不是可截断的崩溃残留尾行。
    await fs.appendFile(logPath, '这不是一条事件记录\n', 'utf8');

    const run = makeIo({ appDataRoot, cwd: workspace });
    const code = await main(['--cwd', workspace, '--resume', sessions[0].id], run.io);
    assert.notEqual(code, 0);
    const message = run.stderr.text();
    assert.match(message, /[\u4e00-\u9fff]/);
    assert.ok(!/\n\s+at /.test(message));
    assert.match(message, /损坏/);
  } finally {
    await model.close();
  }
});

test('首次使用：引导两步（Key → 模型），跳过也能进；配置损坏也能被引导修好', { timeout: 30000 }, async () => {
  const { appDataRoot, workspace } = await ownPaths('wwriting-accept-');
  const configPath = path.join(appDataRoot, 'WWriting', 'config.json');

  // —— 第一次启动：没有 config.json，先出现引导（选择器 + 单行输入，不是「输入序号」）——
  const first = makeIo({ appDataRoot, cwd: workspace });
  const firstDone = main(['--cwd', workspace], first.io);
  await waitFor(() => first.stdout.text().includes('① 填入 API Key'), '首次引导');
  assert.ok(first.stdout.text().includes('两步就好'), '开场就说清有几步、都能跳过');
  assert.ok(first.stdout.text().includes('platform.deepseek.com'), '要告诉新用户去哪里拿 Key');
  assert.ok(!first.stdout.text().includes('选择模型厂商'), '厂商只有一个，不再多问一步');

  first.stdin.write('\r'); // Key：回车跳过
  await waitFor(() => first.stdout.text().includes('已跳过设置'), '跳过事实');
  assert.ok(!first.stdout.text().includes('MODEL_'), '错误码不进主文案');

  // 跳过了也不挡路：`/model` 打开交互式设置向导（还没有 Key 时先说清现状再问 Key）。
  // 这一步同时验向导的出口干净——回车跳过 Key 之后要能回到对话面，`/quit` 照常有效。
  first.stdin.write('/model\r');
  await waitFor(() => first.stdout.text().includes('尚未配置模型。'), '/model 向导');
  first.stdin.write('\r'); // Key：回车 = 先跳过
  await waitFor(() => first.stdout.text().includes('已跳过 API Key'), '向导跳过事实');
  await quit(first.io, first.stdin, firstDone, first.stdout);

  // 跳过会写一份「只有厂商与端点」的配置：既标记引导已过，又保持未配置状态。
  const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(saved.provider, 'deepseek');
  assert.equal(saved.api_key, undefined, '跳过时不写 key');
  assert.equal(saved.model, undefined, '跳过时不写模型');

  // —— 第二次启动：配置已存在，不再引导 ——
  // 这里用 `-c` 只是为了落在「继续最近会话」这个已存在的启动形式上；
  // 本用例要证明的与启动形式无关（配过一次就不再引导）。
  const second = makeIo({ appDataRoot, cwd: workspace });
  const secondDone = main(['--cwd', workspace, '-c'], second.io);
  await waitFor(() => second.stdout.text().includes('继续最近会话'), '第二次启动');
  assert.ok(!second.stdout.text().includes('① 填入 API Key'), '配过一次就不再重复引导');
  await quit(second.io, second.stdin, secondDone, second.stdout);

  // —— 配置损坏：不当成故障，走引导顺手修好（保存时按空配置覆盖）——
  await fs.writeFile(configPath, '{ this is not json', 'utf8');
  const broken = makeIo({ appDataRoot, cwd: workspace });
  const brokenDone = main(['--cwd', workspace], broken.io);
  await waitFor(() => broken.stdout.text().includes('① 填入 API Key'), '损坏也走引导');
  assert.ok(!broken.stdout.text().includes('MODEL_CONFIG_INVALID'), '错误码不进主文案');
  broken.stdin.write('\r'); // 跳过 Key
  await waitFor(() => broken.stdout.text().includes('已跳过设置'), '跳过事实');
  await quit(broken.io, broken.stdin, brokenDone, broken.stdout);

  const repaired = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(repaired.provider, 'deepseek', '引导顺手把损坏的配置写成合法 JSON');
});

test('首次使用：粘贴 Key（当场验证）→ 方向键选模型 → 立刻开始写作', { timeout: 30000 }, async () => {
  const { appDataRoot, workspace } = await ownPaths('wwriting-accept-');
  const model = await startFakeModel(() => textTurn('第一章已经写好。'), {
    models: ['deepseek-chat', 'deepseek-reasoner'],
  });

  try {
    // base_url 用环境变量指向假服务：引导验证 Key、取模型列表与之后的写作都不碰真实网络。
    const run = makeIo({ appDataRoot, cwd: workspace, env: { DEEPSEEK_BASE_URL: model.baseUrl } });
    const completion = main(['--cwd', workspace], run.io);

    await waitFor(() => run.stdout.text().includes('① 填入 API Key'), '首次引导');
    run.stdin.write(`${API_KEY}\r`); // 粘贴 Key
    // 当场验证：有效 → 直接进模型选择（列表来自端点的真实返回）。
    await waitFor(() => run.stdout.text().includes('API Key 有效 · 2 个可用模型'), 'Key 验证通过');
    await waitFor(() => run.stdout.text().includes('❯ deepseek-chat'), '候选来自端点真实列表');

    // ↓ 把光标移到第二个模型，再回车确认——这就是「滑动选择」。
    run.stdin.write('\x1b[B');
    await waitFor(() => run.stdout.text().includes('❯ deepseek-reasoner'), '方向键移动光标');
    run.stdin.write('\r');
    await waitFor(() => run.stdout.text().includes('设置完成'), '引导收尾');

    // 引导写下的 Key 与模型落在临时 APPDATA 的配置里。
    const configPath = path.join(appDataRoot, 'WWriting', 'config.json');
    const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(saved.provider, 'deepseek');
    assert.equal(saved.model, 'deepseek-reasoner');
    assert.equal(saved.api_key, API_KEY);

    // 引导完就能直接用：这条消息真的发给了模型，而且用的是引导里选的模型。
    run.stdin.write('写第一章\r');
    await waitFor(() => run.stdout.text().includes('已完成'), 'Run 终态');
    assert.equal(model.requests.length, 1, '确实发了一轮对话');
    assert.equal(model.requests[0].model, 'deepseek-reasoner', '用的是引导里选的模型');

    await quit(run.io, run.stdin, completion, run.stdout);
  } finally {
    await model.close();
  }
});

test('首次使用：Key 被端点拒绝时原地重问，绝不存下无效的 Key', { timeout: 30000 }, async () => {
  const { appDataRoot, workspace } = await ownPaths('wwriting-accept-');
  // 假服务只接受这一个 Key：第一次粘错的会被 401 打回。
  const model = await startFakeModel(() => textTurn('好的。'), {
    models: ['deepseek-chat', 'deepseek-reasoner'],
    apiKey: API_KEY,
  });

  try {
    const run = makeIo({ appDataRoot, cwd: workspace, env: { DEEPSEEK_BASE_URL: model.baseUrl } });
    const completion = main(['--cwd', workspace], run.io);

    await waitFor(() => run.stdout.text().includes('① 填入 API Key'), '首次引导');
    run.stdin.write('sk-wrong-key-000000\r');
    await waitFor(() => run.stdout.text().includes('这个 Key 被拒绝了'), '第一次被拒');
    await waitFor(() => run.stdout.text().includes('重新粘贴一次'), '原地重问，而不是把人赶出去');

    const configPath = path.join(appDataRoot, 'WWriting', 'config.json');
    const midway = JSON.parse(await fs.readFile(configPath, 'utf8').catch(() => '{}'));
    assert.equal(midway.api_key, undefined, '被拒的 Key 一个字都不该落盘');

    run.stdin.write(`${API_KEY}\r`); // 改对
    await waitFor(() => run.stdout.text().includes('API Key 有效'), '第二次通过');
    await waitFor(() => run.stdout.text().includes('❯ deepseek-chat'), '模型菜单');
    run.stdin.write('\r'); // 回车确认第一个模型
    await waitFor(() => run.stdout.text().includes('设置完成'), '引导收尾');
    const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(saved.api_key, API_KEY);

    await quit(run.io, run.stdin, completion, run.stdout);
  } finally {
    await model.close();
  }
});

test('未配置也能进来：跳过引导后发消息只提示「未配置」，不是失败的红色故障', { timeout: 30000 }, async () => {
  const { appDataRoot, workspace } = await ownPaths('wwriting-accept-');

  const run = makeIo({ appDataRoot, cwd: workspace });
  const completion = main(['--cwd', workspace], run.io);

  await waitFor(() => run.stdout.text().includes('① 填入 API Key'), '首次引导');
  run.stdin.write('\r'); // 跳过 Key
  await waitFor(() => run.stdout.text().includes('已跳过设置'), '跳过事实');

  // 没配 Key 也照样能进对话面：发一条消息，得到的是「未配置」而不是把人挡在门外。
  run.stdin.write('写第一章\r');
  await waitFor(() => run.stdout.text().includes('尚未配置 DeepSeek API Key'), '未配置提示');
  const screen = run.stdout.text();
  assert.ok(screen.includes('未配置：尚未配置 DeepSeek API Key'), '短状态是「未配置」，详情说清下一步');
  assert.ok(!screen.includes('MODEL_NOT_CONFIGURED'), '错误码不进主文案');

  await quit(run.io, run.stdin, completion, run.stdout);
});

test('非交互分支：没有可交互终端时给出中文事实并返回非零退出码，且不跑对话', { timeout: 30000 }, async () => {
  const { appDataRoot, workspace } = await ownPaths('wwriting-accept-');
  await writeConfig(appDataRoot, 'http://127.0.0.1:1');

  // 管道 stdin（有输入通道但不是 TTY）：即使内容已经就绪，也绝不执行、绝不进对话循环。
  const stdin = new PassThrough();
  stdin.write('写第一章\n');
  const run = makeIo({ appDataRoot, cwd: workspace, stdin, tty: false });

  const code = await main(['--cwd', workspace], run.io);
  assert.notEqual(code, 0);
  assert.notEqual(code, 2, '非交互不是参数错误');
  assert.equal(run.stdout.text(), '', '非交互错误不该往 stdout 写东西');
  const message = run.stderr.text();
  assert.match(message, /[\u4e00-\u9fff]/);
  assert.ok(!/\n\s+at /.test(message));
  assert.match(message, /终端|Windows Terminal|PowerShell/);

  // 退出前释放了写锁：同一个会话现在能被另一个写入者打开。
  const sessions = await readSessions(appDataRoot, workspace);
  const workspaceStore = createWorkspaceStore({ appDataRoot });
  const manager = createSessionManager({ workspaceStore });
  const handle = await manager.openById(workspace, sessions[0].id);
  await handle.close();

  // 非交互分支不执行任何输入：日志里没有 run_started。
  assert.deepEqual(
    sessions[0].events.filter((event) => event.type === 'run_started'),
    [],
  );
});

test('模型设置向导：/model 无参 → 方向键换模型 → 下一轮请求就用新模型', { timeout: 30000 }, async () => {
  // 用户不必记得 /model <模型名>：打一个 /model 就进入可上下键选择的设置流程。
  const { appDataRoot, workspace, model } = await scenario(() => textTurn('第一章已经写好。'));

  try {
    const run = makeIo({ appDataRoot, cwd: workspace });
    const completion = main(['--cwd', workspace], run.io);

    await waitFor(() => run.stdout.text().includes('直接输入开始写作'), '对话面');

    run.stdin.write('/model\r');
    await waitFor(() => run.stdout.text().includes('当前：deepseek-chat'), '向导先摆现状');
    await waitFor(() => run.stdout.text().includes('❯ deepseek-chat'), '模型候选来自端点真实列表');

    run.stdin.write('\x1b[B'); // ↓
    await waitFor(() => run.stdout.text().includes('❯ deepseek-reasoner'), '方向键移动光标');
    run.stdin.write('\r');
    await waitFor(() => run.stdout.text().includes('设置完成：模型 deepseek-reasoner'), '向导收尾');

    // 选中即落盘。
    const saved = JSON.parse(await fs.readFile(path.join(appDataRoot, 'WWriting', 'config.json'), 'utf8'));
    assert.equal(saved.model, 'deepseek-reasoner');
    assert.equal(saved.api_key, API_KEY, '没动 Key');

    // 向导退出后对话面照常可用，而且下一轮请求用的就是刚选的模型。
    run.stdin.write('写第一章\r');
    await waitFor(() => run.stdout.text().includes('已完成'), 'Run 终态');
    assert.equal(model.requests.length, 1, '确实发了一轮对话');
    assert.equal(model.requests[0].model, 'deepseek-reasoner', '下一轮请求用的是向导里选的模型');

    await quit(run.io, run.stdin, completion, run.stdout);
  } finally {
    await model.close();
  }
});

test('模型设置向导：Esc 退出向导，不改动任何配置', { timeout: 30000 }, async () => {
  const { appDataRoot, workspace, model } = await scenario(() => textTurn('不会走到这里。'));

  try {
    const run = makeIo({ appDataRoot, cwd: workspace });
    const completion = main(['--cwd', workspace], run.io);

    await waitFor(() => run.stdout.text().includes('直接输入开始写作'), '对话面');
    run.stdin.write('/model\r');
    await waitFor(() => run.stdout.text().includes('❯ deepseek-chat'), '模型候选');

    run.stdin.write('\x1b'); // Esc
    await waitFor(() => run.stdout.text().includes('未做改动。'), '向导收尾');

    const saved = JSON.parse(await fs.readFile(path.join(appDataRoot, 'WWriting', 'config.json'), 'utf8'));
    assert.equal(saved.model, 'deepseek-chat', '配置原样');

    await quit(run.io, run.stdin, completion, run.stdout);
  } finally {
    await model.close();
  }
});

// —— 会话连续性：跨进程恢复后模型确实拿到了前面的对话 ——
//
// 这条是「历史回放」这个功能存在的理由，所以它必须是端到端的、真跨进程的：
// 进程 A 说一句话就退出，进程 B 用 `-c` 接着写。假服务能观测到两次请求的
// messages，于是「模型记得多少」这件事可以被直接断言，而不是靠界面文案猜。
test('跨进程恢复：第二条请求确实带上了第一条的内容', { timeout: 45000 }, async () => {
  const { appDataRoot, workspace, model } = await scenario(
    ({ messages }) => {
      const lastUser = [...messages].reverse().find((message) => message.role === 'user');
      return textTurn(lastUser?.content === '主角叫沈砚' ? '记住了。' : '好，接着写。');
    },
  );

  try {
    // —— 进程 A：留下一条对话就干净退出 ——
    {
      const run = makeIo({ appDataRoot, cwd: workspace });
      const completion = main(['--cwd', workspace, '主角叫沈砚'], run.io);
      await waitFor(() => run.stdout.text().includes('记住了'), '进程 A 收到回复');
      await quit(run.io, run.stdin, completion, run.stdout);
    }

    // 第一轮请求里不该有历史：它是会话的开头（system + 项目记忆 + 这一条输入）。
    assert.equal(model.requests.length, 1, '进程 A 只请求一次');
    assert.equal(model.requests[0].messages.length, 3, '首轮 messages = system + 项目记忆 + 用户输入');
    assert.equal(
      model.requests[0].messages.some((message) => message.content === '记住了。'),
      false,
      '首轮不可能有自己的回复',
    );

    // —— 进程 B：另一个真实进程，接着上次的会话写 ——
    //
    // 两条路必须分清（这是真实用法，也是本用例发现的坑）：
    //   · 裸启动（带不带位置消息都一样）→ **开一个全新会话**（P23），历史为空；
    //   · `-c` / `--continue` → **继续最近会话**，历史在里面。
    //     它与位置消息互斥（同时给会被参数解析拒掉）。
    // 所以「接着上次写」的真实形态是：用 `-c` 启动，进去之后再输入。
    {
      const run = makeIo({ appDataRoot, cwd: workspace });
      const completion = main(['--cwd', workspace, '-c'], run.io);
      await waitFor(() => run.stdout.text().includes('继续最近会话'), '进程 B 进入对话面');
      run.stdin.write('继续第一章\r');
      await waitFor(() => run.stdout.text().includes('接着写'), '进程 B 收到回复');
      await quit(run.io, run.stdin, completion, run.stdout);
    }

    assert.equal(model.requests.length, 2, '进程 B 又请求一次');
    const second = model.requests[1].messages;
    const joined = second.map((message) => String(message.content ?? '')).join('\n');

    // 核心断言：模型在新进程里仍然看得到前面说过的话与它自己写过的回复。
    assert.ok(joined.includes('主角叫沈砚'), `第二条请求应带上第一条的输入；实际：${joined}`);
    assert.ok(joined.includes('记住了。'), `第二条请求应带上第一轮的回复；实际：${joined}`);
    assert.ok(joined.includes('继续第一章'), '当轮输入当然也要在');

    // 顺序必须是对的：历史在前，当轮输入垫底（否则模型会把历史当成「刚发生的事」）。
    const last = second.at(-1);
    assert.equal(last.role, 'user');
    assert.equal(last.content, '继续第一章');

    // 历史只回放可见内容，绝不包含模型的私有思考过程。
    assert.equal(joined.includes('reasoning'), false, '不得回放 reasoning');
  } finally {
    await model.close();
  }
});

// 历史真的被截断时，用户必须看得见（而不是以为模型全都记得）。
test('历史超预算时屏幕上说明省略了多少轮', { timeout: 90000 }, async () => {
  const { appDataRoot, workspace, model } = await scenario(
    ({ index }) => textTurn(`第${index}轮开始：${'长'.repeat(8000)}`),
  );

  try {
    const run = makeIo({ appDataRoot, cwd: workspace });
    const completion = main(['--cwd', workspace, '第一轮'], run.io);
    await waitFor(() => occurrences(run.stdout.text(), '已完成') >= 1, '第一轮完成');

    // 每轮 8000 字符，预算 24000：读到第 3 轮前，日志里只有 2 轮 = 16006 字符，还没超。
    // 第 4 轮读历史时前面已有 3 轮 = 24009 字符 > 预算，截断这才真的发生。
    // （这就是「历史在开工前读、不含当轮」的直接推论，等轮数对了才谈得上断言。）
    const needed = 4;
    for (let round = 2; round <= needed; round += 1) {
      run.stdin.write(`第${round}轮\r`);
      await waitFor(
        () => occurrences(run.stdout.text(), '已完成') >= round,
        `第 ${round} 轮完成`,
        30000,
      );
    }

    await waitFor(
      () => /省略更早 \d+ 轮/.test(run.stdout.text()),
      '历史截断事实行',
      30000,
    );

    const screen = run.stdout.text();
    assert.ok(screen.includes('已载入前情'), `超预算时应说明记得多少；屏幕尾部：${screen.slice(-2000)}`);
    assert.ok(/省略更早 \d+ 轮/.test(screen), '要说清省略了多少轮');

    await quit(run.io, run.stdin, completion, run.stdout);
  } finally {
    await model.close();
  }
});

// —— 屏幕重演的端到端证据（P26：不允许「模型记得、屏幕上看不到」） ——
//
// 必须真跨进程：进程 A 写下一轮对话并退出，进程 B 用 `-c` 打开，
// 断言 B 的屏幕上**看得见** A 那一轮的用户输入、正文与收尾状态行。
// 同进程内第二次调用 main() 覆盖不到模块级状态；「重启后还看得见」这件事只有真重启才算数。
//
// 关于等待：B 的重演发生在启动面板之后、常驻 readline 建立之前，所以 readline 只可能在
// 重演写完之后才读到 `/quit`——`await done` 返回时重演早已落进那份屏幕文本里，
// 不需要为了「等重演」再加同步手段。
test('重启后 -c：上一轮对话被重演到屏幕上', { timeout: 90000 }, async () => {
  const { appDataRoot, workspace } = await ownPaths('wwriting-accept-replay-');
  // 第一轮走一次真实工具调用（write_file），好让 P24 那条守门断言有意义：
  // 工具行真的在 A 的屏幕上出现过，B 的重演里才谈得上「它没有出现」。
  const model = await startFakeModel(({ messages }) => (messages.some((message) => message.role === 'tool')
    ? textTurn('临渊城的雨下了三天。')
    : toolTurn({ name: 'write_file', args: { path: '第一章.md', content: '他推开窗，雨声灌了进来。' } })));
  // 子进程的 env 是写死的 { APPDATA, NO_COLOR }，端点只能落在临时 config.json 里。
  await writeConfig(appDataRoot, model.baseUrl);

  try {
    // —— 进程 A：跑一轮真实对话（真工具、真确认、真落盘）——
    const first = await runCliProcess({
      mode: 'main',
      appDataRoot,
      cwd: workspace,
      argv: ['--cwd', workspace, '写第一章的开头'],
      lines: [{ await: '需要确认', text: '1\r' }, { await: '已完成', text: '/quit\r' }],
    });
    assert.equal(first.exitCode, 0, `进程 A 应正常退出；stdout=${first.stdout} stderr=${first.stderr}`);
    assert.ok(first.result, `进程 A 应打印一行 JSON 结果；stdout=${first.stdout}`);
    assert.ok(first.result.screen.includes('临渊城的雨下了三天。'), `进程 A 自己看到了正文：${first.result.screen}`);
    assert.ok(first.result.screen.includes('✓ 写入文件 第一章.md'), `进程 A 自己看到了工具行：${first.result.screen}`);

    // —— 进程 B：-c 接着最近会话 ——
    const second = await runCliProcess({
      mode: 'main',
      appDataRoot,
      cwd: workspace,
      argv: ['--cwd', workspace, '-c'],
      lines: [{ await: '继续最近会话', text: '/quit\r' }],
    });
    assert.equal(second.exitCode, 0, `进程 B 应正常退出；stdout=${second.stdout} stderr=${second.stderr}`);
    assert.ok(second.result, `进程 B 应打印一行 JSON 结果；stdout=${second.stdout}`);
    const shown = second.result.screen;
    assert.ok(shown.includes('❯ 写第一章的开头'), `用户行被重演（含色带前缀）：${shown}`);
    assert.ok(shown.includes('临渊城的雨下了三天。'), `模型正文被重演：${shown}`);
    assert.ok(shown.includes('已完成'), `收尾状态行被重演：${shown}`);
    // 工具过程行不重演（P24）。
    assert.equal(shown.includes('✓ 写入文件 第一章.md'), false, `工具行不该重演：${shown}`);
  } finally {
    await model.close();
  }
});

// 裸启动开的是全新会话（P23），判据是**日志里有什么**而不是「用户敲了哪个参数」——
// 新会话的日志里没有 run_started，buildReplay 自然返回空 items，一个字节都不会写。
test('裸启动是全新会话：屏幕上不重演任何历史（P23）', { timeout: 90000 }, async () => {
  const { appDataRoot, workspace } = await ownPaths('wwriting-accept-fresh-');
  const model = await startFakeModel(({ messages }) => (messages.some((message) => message.role === 'tool')
    ? textTurn('临渊城的雨下了三天。')
    : toolTurn({ name: 'write_file', args: { path: '第一章.md', content: '他推开窗，雨声灌了进来。' } })));
  await writeConfig(appDataRoot, model.baseUrl);

  try {
    const first = await runCliProcess({
      mode: 'main',
      appDataRoot,
      cwd: workspace,
      argv: ['--cwd', workspace, '写第一章的开头'],
      lines: [{ await: '需要确认', text: '1\r' }, { await: '已完成', text: '/quit\r' }],
    });
    assert.equal(first.exitCode, 0, `进程 A 应正常退出；stdout=${first.stdout} stderr=${first.stderr}`);

    // 不带 -c：全新会话，屏幕应当是干净的。
    const second = await runCliProcess({
      mode: 'main',
      appDataRoot,
      cwd: workspace,
      argv: ['--cwd', workspace],
      lines: [{ await: '开始新会话', text: '/quit\r' }],
    });
    assert.equal(second.exitCode, 0, `进程 B 应正常退出；stdout=${second.stdout} stderr=${second.stderr}`);
    assert.ok(second.result, `进程 B 应打印一行 JSON 结果；stdout=${second.stdout}`);
    const shown = second.result.screen;
    assert.equal(shown.includes('临渊城的雨下了三天。'), false, `裸启动开的是全新会话，不该重演历史：${shown}`);
    assert.equal(shown.includes('❯ 写第一章的开头'), false, `更不该重演上一轮的用户行：${shown}`);
    assert.ok(shown.includes('开始新会话'), `启动面板如实说明这是新会话：${shown}`);
  } finally {
    await model.close();
  }
});
