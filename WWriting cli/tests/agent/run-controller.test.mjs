// 运行控制器测试：FIFO 排队、运行中第二条输入、立即打断、停止清授权、确认代收、
// 同一 session 只允许一个写入进程（第二个收到 SESSION_BUSY，只读 snapshot 仍可用）。
// 会话管理器 / 事件存储 / 权限层 / 文件工具全部用真实模块 + 真实临时目录；
// 只有 Agent 循环用脚本化的假工厂（可控制何时结束），断言的是真实行为。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRunController, createDefaultToolsFactory } from '../../src/agent/run-controller.mjs';
import { DEFAULT_HISTORY_BUDGET_CHARS, findRetryableTurn } from '../../src/agent/history.mjs';
import { createSkillService } from '../../src/skills/index.mjs';
import { createSessionManager } from '../../src/session/session-manager.mjs';
import { createEventStore } from '../../src/session/event-store.mjs';
import { createWorkspaceStore } from '../../src/storage/workspace-store.mjs';
import { createPermissionState } from '../../src/tools/permissions.mjs';
import { createChapterService } from '../../src/tools/chapters.mjs';

const tempRoots = [];
after(async () => {
  await Promise.all(tempRoots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempRoot(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

const FIXED_MS = 1758900000000;
function makeClock() {
  let now = FIXED_MS;
  return () => (now += 1000);
}
function makeIdFactory(prefix = 'id') {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

function makeManager(appDataRoot) {
  const workspaceStore = createWorkspaceStore({ appDataRoot, clock: makeClock() });
  return createSessionManager({ workspaceStore, clock: makeClock(), idFactory: makeIdFactory() });
}

// 会话管理器的 eventStoreFactory 注入口：只在指定的那一次 append 上挂起，
// 用来确定性地制造「第一条输入的 append 已完成处理中、drain 还没起」的窗口。
function makeGatedStoreFactory() {
  const state = { entered: false, releaseOnce: null };
  let gate = null;
  state.arm = () => {
    gate = new Promise((resolve) => {
      state.releaseOnce = resolve;
    });
  };
  state.factory = (options) => {
    const store = createEventStore(options);
    return {
      ...store,
      async append(partial) {
        if (partial.type === 'input_submitted' && gate !== null) {
          const waiting = gate;
          gate = null;
          state.entered = true;
          await waiting;
        }
        return store.append(partial);
      },
    };
  };
  return state;
}

// 记录型事件存储：统计同时在飞的 append / appendBatch 次数（并发 = 两个写入抢同一个
// state.json.tmp），并可在指定时机卡住一次写入，确定性地制造「轮正在落盘」的窗口。
function makeConcurrencyStoreFactory() {
  const state = { inFlight: 0, maxInFlight: 0, entered: false, releaseOnce: null };
  let gate = null;
  state.arm = () => {
    gate = new Promise((resolve) => {
      state.releaseOnce = resolve;
    });
    state.entered = false;
  };
  const wrap = (fn) => async (arg) => {
    state.inFlight += 1;
    if (state.inFlight > state.maxInFlight) state.maxInFlight = state.inFlight;
    try {
      if (gate !== null) {
        const waiting = gate;
        gate = null;
        state.entered = true;
        await waiting;
      }
      return await fn(arg);
    } finally {
      state.inFlight -= 1;
    }
  };
  state.factory = (options) => {
    const store = createEventStore(options);
    return {
      ...store,
      append: wrap((arg) => store.append(arg)),
      appendBatch: wrap((arg) => store.appendBatch(arg)),
    };
  };
  return state;
}

async function pathExists(target) {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

// 让出若干微任务：用于让「刚发起、只做内存判断」的写入推进到真正调 append 的那一步（无真实 I/O）。
async function flushMicrotasks(times = 100) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

async function waitFor(predicate, { timeoutMs = 3000, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待${label}超时。`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

// 假 Agent 循环工厂：每一轮都追加 run_started / 终态事件，结束时机由脚本决定。
// script[index] === 'hold' 的轮会挂起，直到「被中止」或「被放行」——这样才好观察排队与打断；
// 其余轮立即收敛，避免测试自己卡死。
//
// 同时记录控制器传给 run() 的 history / historyMeta：历史装配在控制器这一层，
// 断言它就等于断言「这一轮到底带了什么上下文」。
function makeLoopFactory({ script = [] } = {}) {
  const runs = [];
  const releases = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  let store = null;

  function factory({ eventStore, inputId, text, sessionId, projectRoot, signal }) {
    store = eventStore;
    return {
      async run({ history = [], historyMeta = null } = {}) {
        const index = runs.length;
        runs.push({
          inputId, text, sessionId, projectRoot, history, historyMeta,
        });
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        const runId = `run-${index + 1}`;
        // 放行钩子在第一个 await 之前就登记好：run_started 的落盘可能排在别的写入之后，
        // 测试不该被迫等它落地才能放行这一轮。
        let held = null;
        if (script[index] === 'hold') {
          held = new Promise((resolve) => {
            releases[index] = () => resolve({ type: 'run_completed' });
            if (signal) signal.addEventListener('abort', () => resolve({ type: 'run_interrupted' }), { once: true });
            if (signal && signal.aborted) resolve({ type: 'run_interrupted' });
          });
        }
        try {
          await eventStore.append({ type: 'run_started', run_id: runId, data: { input_id: inputId, text } });
          let outcome = script[index] ?? { type: 'run_completed' };
          if (held !== null) {
            outcome = await held;
          } else if (signal && signal.aborted) {
            outcome = { type: 'run_interrupted' };
          }
          await eventStore.append({
            type: outcome.type,
            run_id: runId,
            data: outcome.type === 'run_interrupted' ? { reason: 'user_stop' } : {},
          });
          return { runId, status: outcome.type === 'run_interrupted' ? 'cancelled' : 'completed', text: '' };
        } finally {
          concurrent -= 1;
        }
      },
    };
  }

  return {
    factory,
    runs,
    // 放行第 index 轮（0 起）；若该轮已被中止，abort 分支先生效。
    release: (index = 0) => (releases[index] ? releases[index]() : undefined),
    stats: () => ({ count: runs.length, maxConcurrent }),
    // 循环拿到的就是会话自己的事件存储：直接读日志校验事件，不看投影猜。
    events: async () => (await store.readAll()).events,
  };
}

// 读取当前会话的事件日志：控制器不对外暴露事件存储，测试改为在管理器这一层
// 记一份「会话 ID → 句柄的事件存储」——那正是控制器自己读历史的同一个存储。
const sessionStores = new Map();
function rememberSessionStores(manager) {
  for (const name of ['openLatest', 'openById']) {
    const base = manager[name].bind(manager);
    manager[name] = async (...args) => {
      const handle = await base(...args);
      sessionStores.set(handle.sessionId, handle.eventStore);
      return handle;
    };
  }
  return manager;
}

async function controllerEvents(controller) {
  const store = sessionStores.get(controller.snapshot().session_id);
  if (!store) throw new Error('找不到该会话的事件存储。');
  return (await store.readAll()).events;
}

async function makeController({
  root, projectRoot, agentLoopFactory = null, permissions = null, manager: injected = null, extra = {},
}) {  const manager = rememberSessionStores(injected ?? makeManager(root));
  const controller = createRunController({
    sessionManager: manager,
    // 不传 agentLoopFactory 时用真实 Agent 循环（集成路径）。
    ...(agentLoopFactory ? { agentLoopFactory } : {}),
    projectRoot,
    permissions: permissions ?? createPermissionState({ clock: makeClock(), idFactory: makeIdFactory('dec') }),
    clock: makeClock(),
    idFactory: makeIdFactory('run'),
    ...extra,
  });
  await controller.open();
  return { controller, manager };
}

test('submit：空闲输入立即开跑并留下 run_started / run_completed', async () => {
  const root = await makeTempRoot('wwriting-ctrl-submit-');
  const projectRoot = path.join(root, 'novel');
  const loop = makeLoopFactory();
  const { controller } = await makeController({ root, projectRoot, agentLoopFactory: loop.factory });

  try {
    const submitted = await controller.submit({ text: '写第一章' });
    assert.equal(submitted.queued, false);
    assert.equal(submitted.result.status, 'completed');
    assert.deepEqual(loop.runs.map((run) => run.text), ['写第一章']);

    const snap = controller.snapshot();
    assert.equal(snap.status, 'idle');
    assert.equal(snap.active_run_id, null);
    assert.deepEqual(snap.queue, []);
  } finally {
    await controller.close();
  }
});

test('运行中第二条输入生成 input_queued，并在当前轮结束后按 FIFO 执行', async () => {
  const root = await makeTempRoot('wwriting-ctrl-fifo-');
  const projectRoot = path.join(root, 'novel');
  const loop = makeLoopFactory({ script: ['hold'] });
  const { controller } = await makeController({ root, projectRoot, agentLoopFactory: loop.factory });

  try {
    const first = controller.submit({ text: '第一条' });
    await waitFor(() => controller.snapshot().active_run_id !== null, { label: '第一轮开始' });

    const second = await controller.submit({ text: '第二条' });
    const third = await controller.submit({ text: '第三条' });
    assert.equal(second.queued, true);
    assert.equal(third.queued, true);
    assert.deepEqual(controller.snapshot().queue.map((item) => item.text), ['第二条', '第三条']);
    // 运行中的输入在事件日志里就是 input_queued。
    assert.deepEqual(
      (await loop.events()).filter((event) => event.type === 'input_queued').map((event) => event.data.text),
      ['第二条', '第三条'],
    );

    loop.release(0);
    await first;

    // 队列按入队顺序执行，绝不并行。
    assert.deepEqual(loop.runs.map((run) => run.text), ['第一条', '第二条', '第三条']);
    assert.equal(loop.stats().maxConcurrent, 1);
    // 同一会话：所有轮次 session_id 相同。
    assert.equal(new Set(loop.runs.map((run) => run.sessionId)).size, 1);
    assert.equal(controller.snapshot().session_id, loop.runs[0].sessionId);
  } finally {
    await controller.close();
  }
});

test('立即：取消当前模型请求、提升指定输入、其余保持 FIFO，且不启动第二个 Agent', async () => {
  const root = await makeTempRoot('wwriting-ctrl-priority-');
  const projectRoot = path.join(root, 'novel');
  const loop = makeLoopFactory({ script: ['hold'] });
  const { controller } = await makeController({ root, projectRoot, agentLoopFactory: loop.factory });

  try {
    const first = controller.submit({ text: '第一条' });
    await waitFor(() => controller.snapshot().active_run_id !== null, { label: '第一轮开始' });
    const a = await controller.submit({ text: '甲' });
    const b = await controller.submit({ text: '乙' });
    const c = await controller.submit({ text: '丙' });

    const promoted = await controller.requestPriority(c.inputId);
    assert.equal(promoted.promoted, true);
    assert.equal(promoted.interrupted, true);
    assert.equal(promoted.inputId, c.inputId);
    // 提升后：被提升的输入到队首，其余维持 FIFO。
    assert.deepEqual(
      controller.snapshot().queue.map((item) => item.input_id),
      [c.inputId, a.inputId, b.inputId],
    );

    await first;
    assert.deepEqual(loop.runs.map((run) => run.text), ['第一条', '丙', '甲', '乙']);
    assert.equal(loop.stats().maxConcurrent, 1);
    assert.equal(new Set(loop.runs.map((run) => run.sessionId)).size, 1);
    const events = await loop.events();
    assert.deepEqual(
      events.filter((event) => event.type === 'input_promoted').map((event) => event.data.input_id),
      [c.inputId],
    );
    // 被打断的那一轮以 run_interrupted 收敛，队列其余输入照常跑完。
    assert.deepEqual(
      events.filter((event) => event.type === 'run_interrupted').map((event) => event.data.reason),
      ['user_stop'],
    );
  } finally {
    await controller.close();
  }
});

test('停止：当前轮收敛为 run_interrupted，队列留待下一次输入继续消费，临时授权被清空', async () => {
  const root = await makeTempRoot('wwriting-ctrl-stop-');
  const projectRoot = path.join(root, 'novel');
  const loop = makeLoopFactory({ script: ['hold'] });
  const permissions = createPermissionState({ clock: makeClock(), idFactory: makeIdFactory('dec') });
  const { controller } = await makeController({
    root, projectRoot, agentLoopFactory: loop.factory, permissions,
  });

  try {
    // 先制造一个挂起的待确认：停止必须把它一起作废（files 层的等待不受 signal 约束）。
    permissions.beginInput({ inputId: 'in-pending' });
    const waiting = permissions.request({ tool: 'write_file', target: '第一章.md', projectRoot });
    await waitFor(async () => permissions.pending().length === 1, { label: '待确认产生' });

    const first = controller.submit({ text: '第一条' });
    await waitFor(() => controller.snapshot().active_run_id !== null, { label: '第一轮开始' });
    await controller.submit({ text: '第二条' });

    const stopped = await controller.stop();
    assert.equal(stopped.stopped, true);
    await first;

    assert.deepEqual(loop.runs.map((run) => run.text), ['第一条']);
    assert.deepEqual(permissions.pending(), []);
    const decision = await waiting;
    assert.equal(decision.allowed, false);

    const snap = controller.snapshot();
    assert.equal(snap.active_run_id, null);
    assert.deepEqual(snap.queue.map((item) => item.text), ['第二条']);

    // 停止只停当前轮：新输入一到，停在队列里的更早输入一起按 FIFO 继续消费，
    // 绝不能因为一次停止就让这个会话再也跑不动任何输入。
    const resumed = await controller.submit({ text: '第三条' });
    assert.equal(resumed.queued, true);
    assert.equal(resumed.result.status, 'completed');
    assert.deepEqual(loop.runs.map((run) => run.text), ['第一条', '第二条', '第三条']);
    assert.deepEqual(controller.snapshot().queue, []);
  } finally {
    await controller.close();
  }
});

test('停止之后再「立即」：解除停止，队列按提升后的顺序继续消费', async () => {
  const root = await makeTempRoot('wwriting-ctrl-stop-priority-');
  const projectRoot = path.join(root, 'novel');
  const loop = makeLoopFactory({ script: ['hold'] });
  const { controller } = await makeController({ root, projectRoot, agentLoopFactory: loop.factory });

  try {
    const first = controller.submit({ text: '第一条' });
    await waitFor(() => controller.snapshot().active_run_id !== null, { label: '第一轮开始' });
    const a = await controller.submit({ text: '甲' });
    const b = await controller.submit({ text: '乙' });

    await controller.stop();
    await first;
    assert.deepEqual(loop.runs.map((run) => run.text), ['第一条']);

    // 停止之后没有活跃轮，立即只改顺序，同时解除停止。
    const promoted = await controller.requestPriority(b.inputId);
    assert.equal(promoted.interrupted, false);
    assert.deepEqual(
      controller.snapshot().queue.map((item) => item.input_id),
      [b.inputId, a.inputId],
    );

    const resumed = await controller.submit({ text: '丙' });
    assert.equal(resumed.result.status, 'completed');
    assert.deepEqual(loop.runs.map((run) => run.text), ['第一条', '乙', '甲', '丙']);
    assert.deepEqual(controller.snapshot().queue, []);
  } finally {
    await controller.close();
  }
});

test('停止在没有活跃轮时返回 stopped:false；未打开会话的操作报中文错误', async () => {
  const root = await makeTempRoot('wwriting-ctrl-guard-');
  const projectRoot = path.join(root, 'novel');
  const { controller } = await makeController({ root, projectRoot });

  try {
    assert.deepEqual(controller.stop(), { stopped: false, inputId: null });
    await assert.rejects(controller.submit({ text: '' }), /[一-鿿]/);
  } finally {
    await controller.close();
  }

  const manager = makeManager(root);
  const closed = createRunController({
    sessionManager: manager,
    agentLoopFactory: makeLoopFactory().factory,
    projectRoot,
  });
  await assert.rejects(closed.submit({ text: '写' }), /[一-鿿]/);
  await assert.rejects(closed.requestPriority('x'), /[一-鿿]/);
  assert.throws(() => closed.snapshot(), /[一-鿿]/);
});

test('提交写入窗口内的第二条输入：进队列、由同一条 drain 消费，并发度恒为 1', async () => {
  const root = await makeTempRoot('wwriting-ctrl-window-');
  const projectRoot = path.join(root, 'novel');
  // 第一轮挂起，好让「第二条入队」确定性地发生在 drain 仍在跑的时候。
  const loop = makeLoopFactory({ script: ['hold'] });

  // 用 gated 事件存储确定性地卡住「第一条输入的 append 正在写」这一段，
  // 而不是靠 sleep 赌 IO 时序。
  const gated = makeGatedStoreFactory();
  const workspaceStore = createWorkspaceStore({ appDataRoot: root, clock: makeClock() });
  const manager = createSessionManager({
    workspaceStore, clock: makeClock(), idFactory: makeIdFactory(), eventStoreFactory: gated.factory,
  });

  gated.arm();
  const { controller } = await makeController({ root, projectRoot, agentLoopFactory: loop.factory, manager });

  try {
    // 第一条：fire-and-forget（正是 Task 7/8 的输入框模式），此刻正挂在 append 上。
    const first = controller.submit({ text: '第一条' });
    await waitFor(() => gated.entered === true, { label: '第一条进入 append' });

    // 窗口内到达的第二条：它的提交动作排在第一条之后串行执行，因此只会进队列。
    const secondPromise = controller.submit({ text: '第二条' });
    gated.releaseOnce();
    await waitFor(() => loop.runs.length === 1, { label: '第一轮开始' });

    const second = await secondPromise;
    assert.equal(second.queued, true);
    assert.equal(second.result, null);
    assert.deepEqual(controller.snapshot().queue.map((item) => item.text), ['第二条']);
    // 单 Agent 不变量：无论多少条输入挤在窗口里，同时只有一轮在跑。
    assert.equal(loop.stats().maxConcurrent, 1);

    loop.release(0);
    await first;
    assert.deepEqual(loop.runs.map((run) => run.text), ['第一条', '第二条']);
    assert.equal(loop.stats().maxConcurrent, 1);
    assert.deepEqual(controller.snapshot().queue, []);
  } finally {
    await controller.close();
  }
});

test('确认由控制器代收：decision_pending 后 decide 一次允许，写入落盘', async () => {
  const root = await makeTempRoot('wwriting-ctrl-decide-');
  const projectRoot = path.join(root, 'novel');
  await fs.mkdir(projectRoot, { recursive: true });

  // 真实 Agent 循环 + 真实文件工具 + 非 YOLO 权限：走完整集成路径。
  const modelClient = {
    async streamChat({ messages, onDelta, onToolCall }) {
      // 判「最后一条是不是当轮输入」而不是数长度：注入项目记忆之后长度会变
      // （记忆那条 user 消息、以及缺失提示），数长度会让这个分支静默走错——
      // 假模型不再发 write_file，整条「确认 → 落盘」的权限用例就什么都不测了。
      if (messages.at(-1).content === '写第一章') {
        onDelta('我先写下来');
        onToolCall({
          id: 'call-1',
          name: 'write_file',
          arguments: JSON.stringify({ path: '第一章.md', content: '正文' }),
        });
        return { text: '我先写下来', toolCalls: [], usage: null };
      }
      onDelta('写好了。');
      return { text: '写好了。', toolCalls: [], usage: null };
    },
  };
  const permissions = createPermissionState({ clock: makeClock(), idFactory: makeIdFactory('dec') });
  const { controller } = await makeController({ root, projectRoot, permissions, extra: { modelClient } });

  try {
    const running = controller.submit({ text: '写第一章' });
    const pending = await waitFor(
      async () => controller.permissions.pending()[0] ?? null,
      { label: '待确认产生' },
    );
    assert.equal(pending.level, 'write');
    assert.equal(pending.tool, 'write_file');

    const decided = await controller.decide({ decisionId: pending.decision_id, choice: 'once' });
    assert.equal(decided.allowed, true);

    const submitted = await running;
    assert.equal(submitted.result.status, 'completed');
    assert.equal(await fs.readFile(path.join(projectRoot, '第一章.md'), 'utf8'), '正文');
    assert.deepEqual(controller.permissions.pending(), []);
  } finally {
    await controller.close();
  }
});

test('同一 session 只允许一个写入进程：第二个收到 SESSION_BUSY，只读 snapshot 仍可用', async () => {
  const root = await makeTempRoot('wwriting-ctrl-busy-');
  const projectRoot = path.join(root, 'novel');
  const loop = makeLoopFactory();
  const { controller } = await makeController({ root, projectRoot, agentLoopFactory: loop.factory });

  try {
    const sessionId = controller.snapshot().session_id;
    // 第二个进程（这里用同 pid 的第二个管理器模拟另一个写入者）。
    const other = makeManager(root);
    await assert.rejects(
      other.openById(projectRoot, sessionId),
      (error) => {
        assert.equal(error.code, 'SESSION_BUSY');
        assert.match(error.message, /[一-鿿]/);
        return true;
      },
    );

    // 只读视角不受写锁影响。
    const snap = await other.snapshot(projectRoot, sessionId);
    assert.equal(snap.session_id, sessionId);
    assert.equal(snap.status, 'idle');

    // 持锁者自己照常工作。
    const submitted = await controller.submit({ text: '写第一章' });
    assert.equal(submitted.result.status, 'completed');
  } finally {
    await controller.close();
  }

  // 释放锁之后第二个写入者可以打开。
  const sessionId = 'id-1';
  const reopened = makeManager(root);
  const handle = await reopened.openById(projectRoot, sessionId);
  assert.equal(handle.sessionId, sessionId);
  await handle.close();
});

test('snapshot 反映运行中的活跃轮与队列', async () => {
  const root = await makeTempRoot('wwriting-ctrl-snapshot-');
  const projectRoot = path.join(root, 'novel');
  const loop = makeLoopFactory({ script: ['hold'] });
  const { controller } = await makeController({ root, projectRoot, agentLoopFactory: loop.factory });

  try {
    const first = controller.submit({ text: '第一条' });
    await waitFor(() => controller.snapshot().active_run_id !== null, { label: '第一轮开始' });
    await controller.submit({ text: '第二条' });

    const snap = controller.snapshot();
    assert.equal(snap.status, 'active');
    assert.equal(snap.active_input_id, loop.runs[0].inputId);
    assert.match(snap.active_run_id, /^run-/);
    assert.deepEqual(snap.queue.map((item) => item.text), ['第二条']);

    loop.release(0);
    await first;
    assert.equal(controller.snapshot().active_run_id, null);
  } finally {
    await controller.close();
  }
});

test('关闭会话：在跑的轮落盘完成后才释放写锁（run_interrupted 在锁内写完）', async () => {
  const root = await makeTempRoot('wwriting-ctrl-close-lock-');
  const projectRoot = path.join(root, 'novel');

  // 事件存储：把「被取消的轮」最后一次落盘（run_interrupted）卡住，并记录它何时真正落盘完成。
  const storeState = { entered: false, releaseOnce: null };
  let gate = null;
  let runSettled = false;
  const storeFactory = (options) => {
    const store = createEventStore(options);
    return {
      ...store,
      async append(partial) {
        if (partial?.type === 'run_interrupted' && gate !== null) {
          const waiting = gate;
          gate = null;
          storeState.entered = true;
          await waiting;
          const appended = await store.append(partial);
          runSettled = true;
          return appended;
        }
        return store.append(partial);
      },
    };
  };
  storeState.arm = () => {
    gate = new Promise((resolve) => {
      storeState.releaseOnce = resolve;
    });
  };

  // 会话句柄的 close() 就是「释放会话写锁」：记录它是否在轮落地之前就被调用了。
  let closeBeforeSettle = false;
  const wrapClose = (handle) => {
    const release = handle.close.bind(handle);
    handle.close = async () => {
      // 同步判定：调用 close() 的同一 tick 里，被取消的轮是否还没落盘。
      if (runSettled === false) closeBeforeSettle = true;
      return release();
    };
    return handle;
  };
  const workspaceStore = createWorkspaceStore({ appDataRoot: root, clock: makeClock() });
  const base = createSessionManager({
    workspaceStore,
    clock: makeClock(),
    idFactory: makeIdFactory(),
    eventStoreFactory: storeFactory,
  });
  const manager = {
    ...base,
    openLatest: async (root2) => wrapClose(await base.openLatest(root2)),
    openById: async (root2, id) => wrapClose(await base.openById(root2, id)),
  };

  // 第一轮挂起；abort 后它会把 run_interrupted 落盘（被上面的 gate 卡住）。
  const loop = makeLoopFactory({ script: ['hold'] });
  const { controller } = await makeController({ root, projectRoot, agentLoopFactory: loop.factory, manager });

  const sessionId = controller.snapshot().session_id;
  const lockPath = path.join(workspaceStore.directoryFor(projectRoot, 'locks'), sessionId);
  const eventsPath = path.join(workspaceStore.sessionsRoot(projectRoot), sessionId, 'events.jsonl');

  const first = controller.submit({ text: '第一条' });
  await waitFor(() => controller.snapshot().active_run_id !== null, { label: '第一轮开始' });

  storeState.arm();
  controller.stop();
  await waitFor(() => storeState.entered === true, { label: 'run_interrupted 进入 append' });

  // 关闭：此刻被取消的轮还没落盘，锁必须等它落地后才能释放。
  const closing = controller.close();
  storeState.releaseOnce();
  await closing;

  assert.equal(closeBeforeSettle, false, '锁在被取消的轮落盘之前就被释放了');

  // 附加断言：close() resolve 之后，事件日志里已有 run_interrupted，且写锁已删除。
  const lines = (await fs.readFile(eventsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(lines.some((event) => event.type === 'run_interrupted'), 'run_interrupted 必须在释放锁之前落盘');
  assert.equal(await pathExists(lockPath), false, 'close 返回后写锁应已释放');

  await first;
});

test('立即：promote 与循环落盘共用同一条尾链，绝不并发抢 state.json.tmp', async () => {
  const root = await makeTempRoot('wwriting-ctrl-promote-tail-');
  const projectRoot = path.join(root, 'novel');

  // 记录型事件存储：并发即踩同一个 state.json.tmp；并在「轮正在落盘」时卡住，制造交错窗口。
  const gateState = makeConcurrencyStoreFactory();
  const workspaceStore = createWorkspaceStore({ appDataRoot: root, clock: makeClock() });
  const manager = createSessionManager({
    workspaceStore, clock: makeClock(), idFactory: makeIdFactory(), eventStoreFactory: gateState.factory,
  });

  // 定制的假循环：第一轮 run_started 落盘后等测试放行（好让第二条输入先排队），
  // 再发一次会被卡住的写入，最后等 abort；后续轮立即收敛。
  let openQueue = null;
  const queueReady = new Promise((resolve) => {
    openQueue = resolve;
  });
  const runs = [];
  const loopFactory = ({ eventStore, inputId, text, signal }) => ({
    async run() {
      const index = runs.length;
      runs.push({ inputId, text });
      const runId = `run-${index + 1}`;
      await eventStore.append({ type: 'run_started', run_id: runId, data: { input_id: inputId, text } });
      if (index > 0) {
        await eventStore.append({ type: 'run_completed', run_id: runId, data: {} });
        return { runId, status: 'completed' };
      }
      await queueReady; // 等测试把第二条输入排进队列
      await eventStore.append({ type: 'model_delta', run_id: runId, data: { text: '…' } }); // 会被卡住
      await new Promise((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', resolve, { once: true });
      });
      await eventStore.append({ type: 'run_interrupted', run_id: runId, data: { reason: 'user_stop' } });
      return { runId, status: 'cancelled' };
    },
  });

  const { controller } = await makeController({ root, projectRoot, agentLoopFactory: loopFactory, manager });

  const first = controller.submit({ text: '第一条' });
  await waitFor(() => controller.snapshot().active_run_id !== null, { label: '第一轮开始' });
  const queued = await controller.submit({ text: '第二条' });
  assert.equal(queued.queued, true);

  gateState.arm();
  openQueue();
  await waitFor(() => gateState.entered === true, { label: '循环落盘进入 append' });

  const promoting = controller.requestPriority(queued.inputId);
  // 修复前：promote 的 append 立刻并发进入（inFlight 变 2）；修复后：它排在尾链之后，进不来。
  await flushMicrotasks(200);
  assert.equal(gateState.maxInFlight, 1, 'promote 与循环落盘不得并发写同一个 state.json.tmp');

  gateState.releaseOnce();
  await promoting;
  await first;
  assert.equal(gateState.maxInFlight, 1);
  assert.deepEqual(runs.map((run) => run.text), ['第一条', '第二条']);
});

// —— 会话历史回放 ——
//
// 这一组用**真实 Agent 循环 + 真实事件存储**走完整链路：真实的 run_started / run_completed
// 落盘，控制器读日志投影出历史，循环把它插进 messages。断言落在「模型客户端实际收到的
// messages」上——那是这个功能存在的唯一理由。

// 记录型模型客户端：每次请求都留一份 messages 快照，正文由 textFor(index) 决定。
function makeRecordingModel({ textFor = (index) => `第 ${index + 1} 轮正文`, onCall = null } = {}) {
  const calls = [];
  return {
    calls,
    async streamChat({ messages, onDelta, onToolCall }) {
      const index = calls.length;
      calls.push({ messages: structuredClone(messages) });
      const text = textFor(index);
      if (text !== null && text !== '') onDelta(text);
      if (onCall !== null) onCall({ index, text, onToolCall });
      return { text, toolCalls: [], usage: null };
    },
  };
}

async function makeRealLoopController({
  root, projectRoot, modelClient, permissions = null, extra = {},
}) {
  // 真实循环需要真实文件工具（toolsFactory 缺省即为 createFileTools），不需要在此另传。
  await fs.mkdir(projectRoot, { recursive: true });
  return makeController({ root, projectRoot, permissions, extra: { modelClient, ...extra } });
}

test('同会话第二轮：发给模型的 messages 里含第一轮的用户原文与正文', async () => {
  const root = await makeTempRoot('wwriting-ctrl-history-');
  const projectRoot = path.join(root, 'novel');
  const model = makeRecordingModel({ textFor: (index) => (index === 0 ? '第一章写好了。' : '第二章写好了。') });
  const { controller } = await makeRealLoopController({ root, projectRoot, modelClient: model });

  try {
    const first = await controller.submit({ text: '写第一章' });
    assert.equal(first.result.status, 'completed');
    // 第一轮：空会话，没有任何历史。
    assert.deepEqual(model.calls[0].messages.map((message) => message.role), ['system', 'user', 'user']); // 第二条是项目记忆

    const second = await controller.submit({ text: '再写第二章' });
    assert.equal(second.result.status, 'completed');

    const sent = model.calls[1].messages;
    assert.deepEqual(sent.map((message) => message.role), ['system', 'user', 'user', 'assistant', 'user']);
    // 核心断言：第一轮的用户原文与正文都在第二条请求里。
    const flat = sent.map((message) => message.content).join('\n');
    assert.match(flat, /写第一章/);
    assert.match(flat, /第一章写好了。/);
    assert.equal(sent.at(-1).content, '再写第二章');

    // 第一轮不该有历史事件，第二轮必须有。
    const events = await controllerEvents(controller);
    assert.deepEqual(events.map((event) => event.type).filter((type) => type === 'history_applied'), ['history_applied']);
    const applied = events.find((event) => event.type === 'history_applied');
    assert.equal(applied.data.kept_turns, 1);
    assert.equal(applied.data.truncated_turns, 0);
    assert.equal(applied.data.chars > 0, true);
  } finally {
    await controller.close();
  }
});

test('会话为空（首轮）：history 为空数组，不发 history_applied', async () => {
  const root = await makeTempRoot('wwriting-ctrl-history-first-');
  const projectRoot = path.join(root, 'novel');
  const model = makeRecordingModel();
  const { controller } = await makeRealLoopController({ root, projectRoot, modelClient: model });

  try {
    await controller.submit({ text: '开个头' });
    assert.deepEqual(model.calls[0].messages.map((message) => message.role), ['system', 'user', 'user']); // 第二条是项目记忆
    const applied = (await controllerEvents(controller)).filter((event) => event.type === 'history_applied');
    assert.deepEqual(applied, []);
  } finally {
    await controller.close();
  }
});

test('立即：被提升的那条输入开跑时，历史不含它自己', async () => {
  const root = await makeTempRoot('wwriting-ctrl-history-priority-');
  const projectRoot = path.join(root, 'novel');
  // 假循环每轮都如实落 run_started / 终态——历史投影就能拿到真实轮次。
  // 第一轮挂起（好让「甲」「乙」排进队列），立即提升「乙」并打断第一轮。
  // 「乙」在被提升前只是排队项、从未开跑，日志里没有它的 run_started：
  // 这正是要钉住的边界——它开跑时历史必须只含「第一条」那一轮（interrupted），不含它自己。
  const loop = makeLoopFactory({ script: ['hold'] });
  const { controller } = await makeController({ root, projectRoot, agentLoopFactory: loop.factory });

  try {
    const first = controller.submit({ text: '第一条' });
    await waitFor(() => controller.snapshot().active_run_id !== null, { label: '第一轮开始' });
    const a = await controller.submit({ text: '甲' });
    const b = await controller.submit({ text: '乙' });

    const promoted = await controller.requestPriority(b.inputId);
    assert.equal(promoted.promoted, true);
    await first;

    // 提升后顺序：乙（被提升）→ 甲；两轮都跑完。
    assert.deepEqual(loop.runs.map((run) => run.text), ['第一条', '乙', '甲']);

    const byInput = new Map(loop.runs.map((run) => [run.inputId, run]));
    const runB = byInput.get(b.inputId);
    assert.ok(runB, '被提升的输入必须真的跑过');
    const userContents = runB.history
      .filter((message) => message.role === 'user')
      .map((message) => message.content);
    // 历史里只有「第一条」那一轮（被中断过），绝不含「乙」自己。
    assert.deepEqual(userContents, ['第一条']);
    assert.equal(JSON.stringify(runB.history).includes('乙'), false);
    // 「甲」开跑时，历史里应当已经有「第一条」与「乙」两轮——顺序按时间正序。
    const runA = byInput.get(a.inputId);
    assert.deepEqual(
      runA.history.filter((message) => message.role === 'user').map((message) => message.content),
      ['第一条', '乙'],
    );
  } finally {
    await controller.close();
  }
});

test('历史读取抛错：该轮仍正常跑完（不判失败），并有降级事实', async () => {
  const root = await makeTempRoot('wwriting-ctrl-history-broken-');
  const projectRoot = path.join(root, 'novel');
  const model = makeRecordingModel();
  const notices = [];

  // 会话句柄的事件存储：readAll 抛错（模拟日志损坏 / I/O 错误），写入照常。
  const manager = makeManager(root);
  const baseOpenLatest = manager.openLatest.bind(manager);
  manager.openLatest = async (root2) => {
    const handle = await baseOpenLatest(root2);
    const store = handle.eventStore;
    handle.eventStore = {
      ...store,
      readAll: async () => {
        throw new Error('事件日志损坏，无法作为事件解析。');
      },
    };
    return handle;
  };

  await fs.mkdir(projectRoot, { recursive: true });
  const { controller } = await makeController({
    root,
    projectRoot,
    manager,
    extra: { modelClient: model, onNotice: (message) => notices.push(message) },
  });

  try {
    const submitted = await controller.submit({ text: '照样开工' });
    // 失忆好过开不了工：读历史失败绝不能把整轮判成失败。
    assert.equal(submitted.result.status, 'completed');
    assert.deepEqual(model.calls[0].messages.map((message) => message.role), ['system', 'user', 'user']); // 第二条是项目记忆
    assert.deepEqual(notices, ['历史未能载入 · 从本轮上下文开始']);
  } finally {
    await controller.close();
  }
});

test('超长历史：送模型的 messages 在预算内，history_applied.truncated_turns > 0', async () => {
  const root = await makeTempRoot('wwriting-ctrl-history-budget-');
  const projectRoot = path.join(root, 'novel');
  // 每轮 9000 字正文：跑满 4 轮就已超过 24000 字符预算。
  const model = makeRecordingModel({ textFor: (index) => `第${index + 1}轮${'字'.repeat(9000)}` });
  const { controller } = await makeRealLoopController({ root, projectRoot, modelClient: model });

  try {
    for (let i = 0; i < 4; i += 1) {
      const submitted = await controller.submit({ text: `写第${i + 1}章` });
      assert.equal(submitted.result.status, 'completed');
    }
    const sent = model.calls.at(-1).messages;
    const chars = sent.reduce((total, message) => total + message.content.length, 0);
    assert.equal(chars <= DEFAULT_HISTORY_BUDGET_CHARS + 200, true, `实际 ${chars} 字符`);

    const applied = (await controllerEvents(controller))
      .filter((event) => event.type === 'history_applied')
      .at(-1);
    assert.equal(applied.data.truncated_turns > 0, true);
    assert.equal(applied.data.kept_turns < 3, true);
  } finally {
    await controller.close();
  }
});

// —— 项目记忆：每轮重读 + 内容哈希短路（ADR-0006）——
// 判据是**内容**不是事件：不存在「刚 /init 过所以刷新」这种触发，也没有「首轮」概念。

function fakeMemory(initial) {
  let current = initial;
  const calls = [];
  return { calls, set: (next) => { current = next; }, read: async (root) => { calls.push(root); return current; } };
}

// 记录循环收到的 run() 参数。返回的终态形状要与真实 RunResult 一致，
// 否则 drain 的收敛逻辑会走进没测过的分支。
function recordingLoopFactory(sink) {
  return () => ({
    run: async (args) => {
      sink.push(args);
      return {
        runId: 'run_x', sessionId: null, inputId: args.inputId ?? null, status: 'completed',
        text: '', message: null, code: null, details: null, rounds: 0, usage: null,
      };
    },
  });
}

async function memoryRig(root, extra) {
  const projectRoot = path.join(root, 'novel');
  await fs.mkdir(projectRoot, { recursive: true });
  const sink = [];
  const { controller } = await makeController({
    root, projectRoot, agentLoopFactory: recordingLoopFactory(sink), extra,
  });
  return { controller, sink, projectRoot };
}

test('每轮开工前都重读一次 WWRITING.md（缓存的是注入消息，不是文件内容）', async () => {
  const root = await makeTempRoot('wwmemory-reread-');
  const memory = fakeMemory({ state: 'present', content: '# 记忆\n- 主角：沈砚\n', errorCode: null });
  const { controller } = await memoryRig(root, { readMemory: memory.read });
  try {
    await controller.submit({ text: '写第一章' });
    await controller.submit({ text: '写第二章' });
  } finally {
    await controller.close();
  }
  assert.equal(memory.calls.length, 2);
});

test('内容没变时第二轮 cached=true，且注入消息字节级一致', async () => {
  const root = await makeTempRoot('wwmemory-cached-');
  const memory = fakeMemory({ state: 'present', content: '# 记忆\n', errorCode: null });
  const { controller, sink } = await memoryRig(root, { readMemory: memory.read });
  try {
    await controller.submit({ text: '写第一章' });
    await controller.submit({ text: '写第二章' });
  } finally {
    await controller.close();
  }
  assert.equal(sink[0].memoryCached, false, '第一轮没有上一条可比');
  assert.equal(sink[1].memoryCached, true);
  assert.equal(sink[0].memory.message.content, sink[1].memory.message.content);
});

test('内容变了就重新注入并 cached=false（手工编辑后下一轮自动生效，不需要刷新命令）', async () => {
  const root = await makeTempRoot('wwmemory-changed-');
  const memory = fakeMemory({ state: 'present', content: '# 记忆\n- 主角：沈砚\n', errorCode: null });
  const { controller, sink } = await memoryRig(root, { readMemory: memory.read });
  try {
    await controller.submit({ text: '写第一章' });
    memory.set({ state: 'present', content: '# 记忆\n- 主角：沈砚\n- 城：临渊\n', errorCode: null });
    await controller.submit({ text: '写第二章' });
  } finally {
    await controller.close();
  }
  assert.equal(sink[1].memoryCached, false);
  assert.ok(sink[1].memory.message.content.includes('临渊'));
});

test('用户中途删掉文件：下一轮就注入缺失提示，不需要重启会话（D4②）', async () => {
  const root = await makeTempRoot('wwmemory-deleted-');
  const memory = fakeMemory({ state: 'present', content: '# 记忆\n', errorCode: null });
  const { controller, sink } = await memoryRig(root, { readMemory: memory.read });
  try {
    await controller.submit({ text: '写第一章' });
    memory.set({ state: 'missing', content: '', errorCode: null });
    await controller.submit({ text: '写第二章' });
  } finally {
    await controller.close();
  }
  assert.equal(sink[1].memory.state, 'missing');
  assert.equal(sink[1].memoryCached, false, '缺失提示与上一轮的正文不是同一条消息');
  assert.ok(sink[1].memory.message.content.includes('本项目尚无 WWRITING.md'));
});

test('文件一直缺失：提示字节恒定，因此第二轮 cached=true', async () => {
  const root = await makeTempRoot('wwmemory-missing-');
  const memory = fakeMemory({ state: 'missing', content: '', errorCode: null });
  const { controller, sink } = await memoryRig(root, { readMemory: memory.read });
  try {
    await controller.submit({ text: '写第一章' });
    await controller.submit({ text: '写第二章' });
  } finally {
    await controller.close();
  }
  assert.equal(sink[0].memory.message.content, sink[1].memory.message.content);
  assert.equal(sink[1].memoryCached, true);
});

test('读不出来时降级为无记忆，本轮照常跑，且不走 onNotice（R2：承载面只有一个）', async () => {
  const root = await makeTempRoot('wwmemory-unreadable-');
  const notices = [];
  const { controller, sink } = await memoryRig(root, {
    readMemory: async () => ({ state: 'unreadable', content: '', errorCode: 'EISDIR' }),
    onNotice: (message) => notices.push(message),
  });
  try {
    const { result } = await controller.submit({ text: '写第一章' });
    assert.equal(result.status, 'completed', '失忆好过开不了工');
  } finally {
    await controller.close();
  }
  // memory 是一个**对象**（message 为 null），不是 null：循环据此发一条 state:'unreadable' 的事件，
  // 由渲染器落成一条 final 终态行。绕道 onNotice 会变成一条被重绘抹掉的动态行。
  assert.deepEqual(sink[0].memory, { message: null, hash: null, omittedChars: 0, state: 'unreadable' });
  assert.deepEqual(notices, [], '记忆降级不占用历史那条 notice 通道');
});

test('readMemory 抛意外错误也收敛成同一态，不抖原始异常', async () => {
  const root = await makeTempRoot('wwmemory-throws-');
  const { controller, sink } = await memoryRig(root, {
    readMemory: async () => { throw new Error('boom'); },
  });
  try {
    const { result } = await controller.submit({ text: '写第一章' });
    assert.equal(result.status, 'completed');
  } finally {
    await controller.close();
  }
  assert.equal(sink[0].memory.state, 'unreadable');
  // 断言**整个对象形状**，而不是只查字符串里有没有 'boom'：降级返回的是固定字面量对象，
  // 结构上本就不会含 'boom'，那条查询恒为 false、抓不到任何回归。形状断言能抓住
  // 「哪天有人把原始异常的 message 塞进 memory 对象」这条真实的泄漏路径。
  assert.deepEqual(sink[0].memory, { message: null, hash: null, omittedChars: 0, state: 'unreadable' });
});

test('真实的 memory_applied 事件落进日志，unreadable 时也落（R2 的端到端证据）', async () => {
  const root = await makeTempRoot('wwmemory-event-');
  const projectRoot = path.join(root, 'novel');
  await fs.mkdir(projectRoot, { recursive: true });
  const model = makeRecordingModel();
  const { controller } = await makeRealLoopController({
    root, projectRoot, modelClient: model,
    extra: { readMemory: async () => ({ state: 'unreadable', content: '', errorCode: 'EISDIR' }) },
  });
  try {
    await controller.submit({ text: '写第一章' });
    const events = await controllerEvents(controller);
    const applied = events.filter((event) => event.type === 'memory_applied');
    assert.equal(applied.length, 1, '降级时也必须发事件，否则渲染器那条分支是死代码');
    assert.deepEqual(applied[0].data, { state: 'unreadable', chars: 0, omitted_chars: 0, cached: false });
  } finally {
    await controller.close();
  }
});

// —— 回归：一轮抛错（而不是 resolve 出终态）时，队列与会话状态必须照样收敛 ——
//
// 触发条件真实存在：轮的落盘失败（磁盘满 / EPERM）会让 run_started 与终态事件都写不下去。
// 修之前的三联症状：① 投影永远停在 active（busy 判据让之后每条输入都只能排队）；
// ② 排队过的那条输入因为 run_started 没落盘而永远摘不掉，变成「僵尸头」；
// ③ 之后每次提交都被排到它后面 —— 队列只增不减，用户的输入永远轮不到。
function makeThrowingLoopFactory({ throwFor = () => false } = {}) {
  const runs = [];
  let store = null;
  function factory({ eventStore, inputId, text }) {
    store = eventStore;
    return {
      async run() {
        runs.push({ inputId, text });
        // 真实路径会在抛错前先写 run_started（之后收尾写盘失败才抛）。
        await eventStore.append({ type: 'run_started', run_id: `run-${runs.length}`, data: { input_id: inputId, text } });
        if (throwFor(text, runs.length)) {
          const error = new Error('EPERM: operation not permitted');
          error.code = 'EPERM';
          throw error; // 抛错，不是 resolve 出 run_failed
        }
        await eventStore.append({ type: 'run_completed', run_id: `run-${runs.length}`, data: { text: 'ok' } });
        return { status: 'completed', text: 'ok' };
      },
    };
  }
  return { factory, runs, events: async () => (await store.readAll()).events };
}

test('一轮抛错之后：投影收敛为 idle，队列不被僵尸头堵住，后续输入照常执行', async () => {
  const root = await makeTempRoot('wwriting-ctrl-throw-retire-');
  const projectRoot = path.join(root, 'novel');
  await fs.mkdir(projectRoot, { recursive: true });
  const loop = makeThrowingLoopFactory({ throwFor: (text) => text === '会失败的一条' });
  const { controller } = await makeController({ root, projectRoot, agentLoopFactory: loop.factory });

  try {
    // 先排一条「注定抛错」的输入，再排一条正常输入（正常那条排在它后面，正是会被僵尸头堵死的位置）。
    await controller.submit({ text: '会失败的一条' }).catch(() => {});
    const after = controller.snapshot();
    // ① 投影必须收敛：不能再停在 active，否则之后每条输入都被当成「忙碌」只能排队。
    assert.equal(after.status, 'idle');
    assert.equal(after.active_run_id, null);

    // ② 后续输入必须能直接跑起来（queued === false 表示没有排在别人后面）。
    const next = await controller.submit({ text: '后面这条必须能跑' });
    assert.equal(next.queued, false);
    assert.equal(next.result.status, 'completed');
    assert.equal(loop.runs.at(-1).text, '后面这条必须能跑');

    // ③ 队列最终为空：僵尸头已被退役，没有留下摘不掉的滞留项。
    assert.deepEqual(controller.snapshot().queue, []);
  } finally {
    await controller.close();
  }
});

test('队首抛错不中断整条队列：排在它后面的输入仍按 FIFO 跑到', async () => {
  const root = await makeTempRoot('wwriting-ctrl-throw-continue-');
  const projectRoot = path.join(root, 'novel');
  await fs.mkdir(projectRoot, { recursive: true });
  const loop = makeThrowingLoopFactory({ throwFor: (text) => text === '坏的那条' });
  const { controller } = await makeController({ root, projectRoot, agentLoopFactory: loop.factory });

  try {
    // 手工把「坏的那条」排进队列（模拟它是在一轮运行中被提交、然后那一轮崩了）。
    const handle = await controller.open();
    await handle.enqueue({ text: '坏的那条' });
    await handle.enqueue({ text: '好的那条' });

    // 提交一条新输入：它会排在队尾，drain 先跑队首的「坏的那条」（抛错）再跑后面的。
    const submitted = await controller.submit({ text: '我这一条' });
    assert.equal(submitted.result.status, 'completed');

    // 三条都尝试过，且「好的那条」没有被静默吞掉 —— 这正是「抛错中断整队」会造成的无声数据丢失。
    const attempted = loop.runs.map((run) => run.text);
    assert.equal(attempted.includes('好的那条'), true);
    assert.equal(attempted.includes('我这一条'), true);
    // 每条输入最多跑一次：绝不把一次故障放大成无限重试。
    assert.equal(new Set(loop.runs.map((run) => run.inputId)).size, loop.runs.length);
    assert.deepEqual(controller.snapshot().queue, []);
  } finally {
    await controller.close();
  }
});

test('一轮抛错后补发 run_interrupted 收敛未闭合的 run（不留下永久 active）', async () => {
  const root = await makeTempRoot('wwriting-ctrl-throw-converge-');
  const projectRoot = path.join(root, 'novel');
  await fs.mkdir(projectRoot, { recursive: true });
  const loop = makeThrowingLoopFactory({ throwFor: () => true });
  const { controller } = await makeController({ root, projectRoot, agentLoopFactory: loop.factory });

  try {
    await controller.submit({ text: '必崩' }).catch(() => {});
    const types = (await controllerEvents(controller)).map((event) => event.type);
    assert.equal(types.includes('run_started'), true);
    // 没有终态事件可落（循环抛了），兜底必须补上一条，否则投影永远 active。
    assert.equal(types.includes('run_interrupted'), true);
  } finally {
    await controller.close();
  }
});


// —— 忙碌口径：isBusy / activeRunId ——
// 「忙不忙」过去由调用方各自从 snapshot().active_run_id 猜（cli 的菜单让位、命令层的
// Ctrl+C），与控制器内部 drain 占位用的判据不是同一份。收口后：口径只有控制器里有。

test('isBusy / activeRunId：跑轮中忙、收敛后空闲', async () => {
  const root = await makeTempRoot('wwriting-ctrl-busy-');
  const projectRoot = path.join(root, 'novel');
  const loop = makeLoopFactory({ script: ['hold'] });
  const { controller } = await makeController({ root, projectRoot, agentLoopFactory: loop.factory });

  // 开跑前：不忙、无活跃轮。
  assert.equal(controller.isBusy(), false);
  assert.equal(controller.activeRunId(), null);

  const pending = controller.submit({ text: '第一轮' });
  await waitFor(() => controller.activeRunId() !== null, { label: 'run_started 落盘' });
  assert.equal(controller.isBusy(), true);
  assert.equal(controller.activeRunId(), 'run-1');

  loop.release(0);
  await pending;
  await waitFor(() => controller.isBusy() === false, { label: 'drain 收敛' });
  assert.equal(controller.activeRunId(), null);
  await controller.close();
});

test('isBusy：drain 在跑（哪怕轮与轮的间隙）就算忙，队列挂着一动不动不算', async () => {
  const root = await makeTempRoot('wwriting-ctrl-busy-queue-');
  const projectRoot = path.join(root, 'novel');
  const loop = makeLoopFactory({ script: ['hold'] });
  const { controller } = await makeController({ root, projectRoot, agentLoopFactory: loop.factory });

  const first = controller.submit({ text: '第一轮' });
  await waitFor(() => controller.activeRunId() !== null, { label: '第一轮开跑' });
  controller.submit({ text: '第二轮' });
  // drain 占位期间：忙。
  assert.equal(controller.isBusy(), true);

  // 停掉当前轮：drain 收敛，队列还挂着第二条，但「忙」已经结束——
  // 下一次 submit 或 立即 才会重新开跑，此刻没有任何会弹权限卡的东西在飞。
  controller.stop();
  await first;
  await waitFor(() => controller.isBusy() === false, { label: 'drain 收敛' });
  assert.equal(controller.activeRunId(), null);
  assert.ok(controller.snapshot().queue.length > 0, '队列应原样保留');
  assert.equal(controller.isBusy(), false);
  await controller.close();
});

test('isBusy / activeRunId：未打开会话也能安全读（不许抛）', () => {
  // 未打开路径不触盘，管理器用临时目录占位即可。
  const manager = makeManager(os.tmpdir());
  const controller = createRunController({
    sessionManager: manager,
    projectRoot: 'unused',
    clock: makeClock(),
    idFactory: makeIdFactory('run'),
  });
  assert.equal(controller.isBusy(), false);
  assert.equal(controller.activeRunId(), null);
});

// —— 技能接线（ADR-0014：清单每轮发现一次、失败返空不阻塞；readSkill 并入默认工具工厂）——

test('startRun 把生效技能清单传给循环工厂，一轮只发现一次', async () => {
  const root = await makeTempRoot('wwriting-ctrl-skillcat-');
  const projectRoot = path.join(root, 'novel');
  const seen = [];
  const catalogCalls = [];
  const skillService = {
    catalog: async () => {
      catalogCalls.push(true);
      return { active: [{ name: 'demo', description: '测试技能', category: 'genre' }], shadowed: [], errors: [] };
    },
  };
  const { controller } = await makeController({
    root,
    projectRoot,
    agentLoopFactory: (options) => {
      seen.push(options);
      return { run: async () => ({ status: 'completed' }) };
    },
    extra: { skillService },
  });

  try {
    await controller.submit({ text: '写第一章' });
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].skillCatalog.map((skill) => skill.name), ['demo']);
    assert.equal(catalogCalls.length, 1, '每轮只发现一次');
  } finally {
    await controller.close();
  }
});

test('技能服务抛错时清单降级为空数组，本轮照常进行', async () => {
  const root = await makeTempRoot('wwriting-ctrl-skillerr-');
  const projectRoot = path.join(root, 'novel');
  const seen = [];
  const skillService = { catalog: async () => { throw new Error('磁盘坏了'); } };
  const { controller } = await makeController({
    root,
    projectRoot,
    agentLoopFactory: (options) => {
      seen.push(options);
      return { run: async () => ({ status: 'completed' }) };
    },
    extra: { skillService },
  });

  try {
    const submitted = await controller.submit({ text: '写第一章' });
    assert.equal(submitted.result.status, 'completed');
    assert.deepEqual(seen[0].skillCatalog, []);
  } finally {
    await controller.close();
  }
});

test('默认工具工厂把 readSkill 并入文件工具，按注入的服务与当轮 projectRoot 解析', async () => {
  const project = await makeTempRoot('wwriting-ctrl-skilltools-');
  const skillDir = path.join(project, 'skills', 'demo');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: d\n---\n\n技能正文\n', 'utf8');
  const skillService = createSkillService({
    userHome: path.join(project, 'home'),
    builtinRoot: path.join(project, 'builtin'),
  });
  const tools = createDefaultToolsFactory(skillService)({ projectRoot: project, signal: null, permissions: null });

  assert.equal(typeof tools.listFiles, 'function', '文件工具还在');
  assert.equal(typeof tools.writeFile, 'function', '文件工具还在');

  const result = await tools.readSkill({ name: 'demo' });
  assert.match(result.content, /技能正文/);
  await assert.rejects(tools.readSkill({ name: 'absent' }), { code: 'skill_not_found' });
});

// —— 章节工具（commit / rollback）走真实循环 + 真实权限 + 真实私有存储 ——

test('章节提交、修订入账与回滚：版本落在应用私有区，回滚要确认，恢复最近生效版本', async () => {
  const root = await makeTempRoot('wwriting-ctrl-chapters-');
  const projectRoot = path.join(root, 'novel');
  await fs.mkdir(projectRoot, { recursive: true });
  const chapterPath = path.join(projectRoot, '第一章.md');
  await fs.writeFile(chapterPath, '初稿内容。', 'utf8');

  // 脚本化模型：**每次模型请求消费一个脚本项**（工具轮之后必须再给一轮纯正文，
  // 循环见到无工具调用才收敛；否则同一 submit 里第二把工具的确认会等在半路）。
  const script = [
    { tool: { name: 'commit_chapter', args: { path: '第一章.md', summary: '开篇' } } },
    { text: '提交好了。' },
    { tool: { name: 'finalize_revision', args: { path: '第一章.md' } } },
    { text: '入账好了。' },
    { tool: { name: 'rollback_chapter', args: { path: '第一章.md' } } },
    { text: '处理完了。' },
  ];
  let round = 0;
  const modelClient = {
    async streamChat({ onDelta, onToolCall }) {
      const step = script[round];
      round += 1;
      if (step.tool) onToolCall({ id: `c${round}`, name: step.tool.name, arguments: JSON.stringify(step.tool.args) });
      else onDelta(step.text);
      return { text: step.tool ? '' : step.text, toolCalls: step.tool ? [{}] : [], usage: null };
    },
  };
  const permissions = createPermissionState({ clock: makeClock(), idFactory: makeIdFactory('dec') });
  const { controller } = await makeRealLoopController({
    root, projectRoot, modelClient, permissions,
    extra: { chapterService: createChapterService({ appDataRoot: root, clock: makeClock() }) },
  });

  try {
    // 第一轮：提交（自动放行，不需要确认）。
    const first = await controller.submit({ text: '提交这一章' });
    assert.equal(first.result.status, 'completed');
    assert.equal(await fs.readFile(chapterPath, 'utf8'), '初稿内容。', '提交不改创作文件');
    // 版本在应用私有区（workspace 私有目录），不在创作目录里（铁律 8）。
    const versionDirs = await fs.readdir(path.join(root, 'WWriting', 'workspaces'));
    const versionFile = path.join(root, 'WWriting', 'workspaces', versionDirs[0], 'chapters', 'versions', '第一章.md', '0001.txt');
    assert.equal(await fs.readFile(versionFile, 'utf8'), '初稿内容。');
    const committed = (await controllerEvents(controller)).find((event) => event.type === 'activity_finished' && event.data.tool === 'commit_chapter');
    assert.equal(committed.data.ok, true);
    assert.match(committed.data.result, /"charsNoSpace":5/);

    // 改稿后修订入账：与提交同级自动放行，revision 快照落私有区。
    await fs.writeFile(chapterPath, '修订后的内容。', 'utf8');
    const revised = await controller.submit({ text: '入账这一章的修订' });
    assert.equal(revised.result.status, 'completed');
    const revisionFile = path.join(root, 'WWriting', 'workspaces', versionDirs[0], 'chapters', 'versions', '第一章.md', '0002.txt');
    assert.equal(await fs.readFile(revisionFile, 'utf8'), '修订后的内容。');

    // 第三轮回滚：write 级确认——确认卡说的是「回滚章节」。
    const submitting = controller.submit({ text: '回滚这一章' });
    await waitFor(() => permissions.pending().length > 0);
    const pending = permissions.pending()[0];
    assert.equal(pending.tool, 'rollback_chapter');
    await controller.decide({ decisionId: pending.decision_id, choice: 'once' });
    const third = await submitting;
    assert.equal(third.result.status, 'completed');
    assert.equal(await fs.readFile(chapterPath, 'utf8'), '修订后的内容。', '回滚恢复的是最近一次生效版本（修订版）');

    // 三个章节工具的成功结果都附固定提醒行（内容写死，不随状态变化）。
    const events = await controllerEvents(controller);
    for (const toolName of ['commit_chapter', 'finalize_revision', 'rollback_chapter']) {
      const finished = events.find((event) => event.type === 'activity_finished' && event.data.tool === toolName && event.data.ok === true);
      assert.match(finished.data.result, /记忆维护：请依次 update_memory → 更新 WWRITING\.md/, `${toolName} 结果缺提醒行`);
    }
  } finally {
    await controller.close();
  }
});

// —— 会话压缩（/compact）——

test('compact：摘要落事件；之后的轮以「[会话摘要] + 未覆盖轮次」开工', async () => {
  const root = await makeTempRoot('wwriting-ctrl-compact-');
  const projectRoot = path.join(root, 'novel');
  await fs.mkdir(projectRoot, { recursive: true });
  const COMPACTION_SYSTEM_PROMPT = (await import('../../src/agent/compact.mjs')).COMPACTION_SYSTEM_PROMPT;
  // 按「请求的形状」分发：压缩请求（系统提示打头）回摘要正文；普通轮回可见正文并留档。
  const normalRequests = [];
  const modelClient = {
    async streamChat({ messages, onDelta }) {
      if (messages[0]?.content === COMPACTION_SYSTEM_PROMPT) {
        onDelta('暗号是菠萝。');
        return { text: '暗号是菠萝。', toolCalls: [], usage: null };
      }
      normalRequests.push(structuredClone(messages));
      onDelta('记住了。');
      return { text: '记住了。', toolCalls: [], usage: null };
    },
  };
  const { controller } = await makeRealLoopController({ root, projectRoot, modelClient });

  try {
    await controller.submit({ text: '记住暗号是菠萝' });
    const result = await controller.compact();
    assert.deepEqual(result, { status: 'ok', chars: 6, turns: 1 });

    // 摘要事件在日志里，带覆盖范围（through_seq = 当时最后一条事件的 seq）。
    const events = await controllerEvents(controller);
    const digests = events.filter((event) => event.type === 'digest_compacted');
    assert.equal(digests.length, 1);
    assert.equal(digests[0].data.digest, '暗号是菠萝。');
    // through_seq = 压缩时刻的最后一条事件 seq；摘要事件自己排在其后（+1），
    // 之后新轮的 run_started 一定 > through_seq，覆盖判定才成立。
    assert.equal(digests[0].data.through_seq, events.at(-1).seq - 1);
    assert.equal(digests[0].data.covered_turns, 1);

    // 摘要之后的下一轮：模型看到 [会话摘要]，看不到被覆盖轮次的原文。
    await controller.submit({ text: '暗号是什么？' });
    const lastMessages = normalRequests.at(-1);
    assert.ok(lastMessages, '模型收到过普通轮请求');
    const flat = lastMessages.map((message) => message.content).join('\n');
    assert.match(flat, /\[会话摘要\]/);
    assert.match(flat, /暗号是菠萝。/);
    assert.equal(flat.includes('记住暗号是菠萝'), false, '被摘要覆盖的轮次原文不再进上下文');
  } finally {
    await controller.close();
  }
});

test('compact：空闲检查与空会话如实回答', async () => {
  const root = await makeTempRoot('wwriting-ctrl-compact-empty-');
  const projectRoot = path.join(root, 'novel');
  await fs.mkdir(projectRoot, { recursive: true });
  let asked = 0;
  const modelClient = { async streamChat() { asked += 1; return { text: 'x', toolCalls: [], usage: null }; } };
  const { controller } = await makeRealLoopController({ root, projectRoot, modelClient });
  try {
    const empty = await controller.compact();
    assert.deepEqual(empty, { status: 'empty' });
    assert.equal(asked, 0, '没有可压缩的对话就不该惊动模型');
  } finally {
    await controller.close();
  }
  // 未打开会话（close 之后）压缩要给出中文事实，不是裸 TypeError。
  await assert.rejects(() => controller.compact(), /打开会话/);
});

// —— /retry：Run 级重试 ——

test('retry：复用原 input_id 与原文重跑失败轮，失败尝试不进上下文，run_started 记 retry_of', async () => {
  const root = await makeTempRoot('wwriting-ctrl-retry-');
  const projectRoot = path.join(root, 'novel');
  let failFirst = true;
  const requests = [];
  const modelClient = {
    async streamChat({ messages }) {
      requests.push(messages.map((message) => message.content).join('\n'));
      if (failFirst) {
        failFirst = false;
        throw Object.assign(new Error('模拟连接中断'), { code: 'ECONNRESET' });
      }
      return { text: '重试后写好了。', toolCalls: [], usage: null };
    },
  };
  const { controller } = await makeRealLoopController({ root, projectRoot, modelClient });

  try {
    const failed = await controller.submit({ text: '帮我写第三章' });
    assert.equal(failed.result.status, 'failed');

    const events = await controller.readEvents();
    const retryable = findRetryableTurn(events);
    assert.equal(retryable.inputId, failed.inputId);
    assert.equal(retryable.runId, failed.result.runId);

    const retried = await controller.retry(retryable);
    assert.equal(retried.result.status, 'completed');
    assert.equal(retried.inputId, failed.inputId, '复用原输入 ID，不新建会话轮次');

    // 失败尝试不进重试轮的上下文：请求里「帮我写第三章」只出现一次（当轮自己）。
    const retryRequest = requests[requests.length - 1];
    assert.equal(retryRequest.split('帮我写第三章').length - 1, 1);

    // run_started 带 retry_of 指向原 run；run_id 本身是新的（思考重放按 run_id 归堆）。
    const allEvents = await controllerEvents(controller);
    const starts = allEvents.filter((event) => event.type === 'run_started');
    assert.equal(starts.length, 2);
    assert.equal(starts[1].data.retry_of, starts[0].run_id);
    assert.notEqual(starts[1].run_id, starts[0].run_id);
  } finally {
    await controller.close();
  }
});

test('retry：运行中拒绝；停止后队列非空也拒绝（重试不插队）', async () => {
  const root = await makeTempRoot('wwriting-ctrl-retry-busy-');
  const projectRoot = path.join(root, 'novel');
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const modelClient = {
    async streamChat({ signal }) {
      // 挂住的模型请求：只在信号中止时以 AbortError 收场（与真实客户端的取消语义一致）。
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(Object.assign(new Error('已停止本轮。'), { name: 'AbortError', code: 'RUN_ABORTED' }));
        if (signal && signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort);
        gate.then(() => resolve({ text: '慢慢写好了。', toolCalls: [], usage: null }));
      });
    },
  };
  const { controller } = await makeRealLoopController({ root, projectRoot, modelClient });

  try {
    const submitting = controller.submit({ text: '第一轮' });
    await waitFor(() => controller.isBusy());
    const busySnapshot = controller.snapshot();

    // 运行中：拒绝。
    await assert.rejects(
      () => controller.retry({ inputId: busySnapshot.active_input_id ?? 'in-x', text: '第一轮' }),
      /正在运行/,
    );

    // 排队一条输入再停止：A 中断、B 留在队列，drain 收敛。
    await controller.submit({ text: '排队的那条' });
    controller.stop();
    await submitting;

    assert.equal(controller.isBusy(), false);
    assert.equal(controller.snapshot().queue.length, 1, '排队输入按语义保留');
    await assert.rejects(
      () => controller.retry({ inputId: 'in-x', text: '第一轮' }),
      /队列里还有输入/,
    );
  } finally {
    release();
    await controller.close();
  }
});

test('立即提交（Ctrl+S）：忙碌时草稿插队首并打断当前轮，同一 drain 接手', async () => {
  const root = await makeTempRoot('wwriting-ctrl-submitnow-');
  const projectRoot = path.join(root, 'novel');
  const loop = makeLoopFactory({ script: ['hold'] });
  const { controller } = await makeController({ root, projectRoot, agentLoopFactory: loop.factory });

  try {
    const first = controller.submit({ text: '第一条' });
    await waitFor(() => controller.snapshot().active_run_id !== null, { label: '第一轮开始' });

    const outcome = await controller.submitNow({ text: '立即这句' });
    assert.equal(outcome.promoted, true);
    assert.equal(outcome.interrupted, true);
    await first;

    // 同一个 drain 接手：被打断轮之后紧接着就是草稿这一条，绝不并起第二个 Agent。
    assert.deepEqual(loop.runs.map((run) => run.text), ['第一条', '立即这句']);
    assert.equal(loop.stats().maxConcurrent, 1);
    const events = await loop.events();
    // 入队与提升两个事件都必须在（同一写入任务）——单独写 promoted 会无声丢草稿。
    assert.ok(
      events.some((event) => event.type === 'input_queued' && event.data.text === '立即这句'),
      'input_queued 必须落盘',
    );
    assert.deepEqual(
      events.filter((event) => event.type === 'input_promoted').map((event) => event.data.input_id),
      [outcome.inputId],
    );
    assert.deepEqual(
      events.filter((event) => event.type === 'run_interrupted').map((event) => event.data.reason),
      ['user_stop'],
    );
  } finally {
    await controller.close();
  }
});

test('立即提交：停止后队列残留时插到队首并补启动消费，不排到队尾', async () => {
  const root = await makeTempRoot('wwriting-ctrl-submitnow-idle-');
  const projectRoot = path.join(root, 'novel');
  const loop = makeLoopFactory({ script: ['hold'] });
  const { controller } = await makeController({ root, projectRoot, agentLoopFactory: loop.factory });

  try {
    const first = controller.submit({ text: '第一条' });
    await waitFor(() => controller.snapshot().active_run_id !== null, { label: '第一轮开始' });
    await controller.submit({ text: '第二条' });
    await controller.stop();
    await first;
    await waitFor(() => controller.isBusy() === false, { label: '控制器空闲' });
    assert.equal(controller.snapshot().queue.length, 1, '前置：停止后队列里还有残留输入');

    const outcome = await controller.submitNow({ text: '插队这句' });
    assert.equal(outcome.promoted, true);
    assert.equal(outcome.interrupted, false, '空闲态没有可打断的轮');
    // 插队这句先跑，残留队列按 FIFO 跟上——不是排到队尾。
    assert.deepEqual(loop.runs.map((run) => run.text), ['第一条', '插队这句', '第二条']);
    assert.equal(loop.stats().maxConcurrent, 1);
  } finally {
    await controller.close();
  }
});

test('立即提交：空闲空队列与回车完全同路；空白草稿被拒（与回车丢弃闸同源）', async () => {
  const root = await makeTempRoot('wwriting-ctrl-submitnow-empty-');
  const projectRoot = path.join(root, 'novel');
  const loop = makeLoopFactory({});
  const { controller } = await makeController({ root, projectRoot, agentLoopFactory: loop.factory });

  try {
    const outcome = await controller.submitNow({ text: '第一章' });
    assert.equal(outcome.queued, false);
    assert.equal(outcome.result.status, 'completed');
    assert.deepEqual(loop.runs.map((run) => run.text), ['第一章']);
    await assert.rejects(() => controller.submitNow({ text: '   ' }), /输入内容不能为空/);
  } finally {
    await controller.close();
  }
});
