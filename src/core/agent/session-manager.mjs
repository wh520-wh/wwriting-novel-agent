// src/core/agent/session-manager.mjs —— 会话 CRUD/registry 同步/标题派生/系统事件
//（第十五轮 F5c 内核分区第三步，Task 9）。
//
// 从 runtime.mjs 机械迁出（不改逻辑）。本模块的依赖形态：
//   - ensureProject/resolveSessionState 是 runtime.mjs 内部闭包函数，经
//     createSessionManager(ctx) 注入函数引用（每个 CRUD 方法按 projectRoot 现取
//     state，无跨 await 持有的可变异步态，不需 getter）；
//   - syncSessionRegistry/autoNameSessionIfDefault 保持 (state, ...) 参数签名
//     （12 个 runtime 内部调用点 + 1 个自动命名点原样委托）；
//   - 模块级常量/工具（TERMINAL_RUN_STATUSES / codedError as fail）与 node 内置
//     （fs/path）本模块直接持有，单源纪律：TERMINAL_RUN_STATUSES 从 journal.mjs
//     import，不复制。
//
// 承重不变量：本模块无磁盘写入——状态要么在 journal 投影（事件流是真相源），
// 要么经 registry/mutex 任务内读-判-写（注册表自身落盘）。本模块只发起调用，
// 不自己写文件系统。
import fs from "node:fs/promises";
import path from "node:path";

import { TERMINAL_RUN_STATUSES } from "./journal.mjs";
import { codedError as fail } from "./agent-utils.mjs";

// 会话是否有非终态活动 Run（串行门 / 删除守卫 / run_status 投影共用同一判定；
// 新增终态状态只需改 TERMINAL_RUN_STATUSES 一处）。runtime.mjs 串行门
//（submit blockers.some）与本模块删除守卫共用本函数，单一来源。
export function hasNonTerminalRun(session) {
  const run = session?.active_run ?? null;
  return run != null && !TERMINAL_RUN_STATUSES.has(run.status);
}

// 会话标题派生（Task 4）：首条消息摘要——trim 后折叠空白并截取前 20 字符，空则
// "新对话"。与 session-registry 的 title 兜底口径一致（空白标题回落 "新对话"）。
export function deriveSessionTitle(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed === "") return "新对话";
  return trimmed.split(/\s+/u).join(" ").slice(0, 20);
}

// 注册表同步（Task 4 Global Constraints 的落地口径）：touch 刷新 updated_at
//（sessions() 排序依据）。同步是派生元数据（journal 事件流才是真相源），失败只
// 告警、绝不回滚已成功的 append。
//
// 与原计划"每会话 journal append 后同步"的微调（按实际代码调整，理由如下）：
//   - 同步点收窄到「调用方可等待的用户动作」：submit/requestPriority/stop/retry/
//     retryCompaction/cancelCompaction/clearHistory 与 open()。
//     运行循环内部逐事件 append 不做同步——循环是 fire-and-forget（无人 await），
//     同步会延长 append 的生命周期到"轮询已观察到 idle 之后"，与外部删除
//     （测试清理 fs.rm、用户删项目目录）竞态：注册表写盘（临时文件 + rename）
//     与目录遍历交错会产生孤儿临时文件 / 目录非空（Windows ENOTEMPTY）。
//   - 由此 updated_at 在一次运行期间滞后到最近一次用户动作为止（排序依据的
//     滞后窗口可接受，会话活跃顺序以用户动作时刻为准）。
function syncSessionRegistry(state, sessionState) {
  return (async () => {
    try {
      await state.registry.touch(sessionState.sessionId);
    } catch (error) {
      console.warn(`[agent] 注册表同步失败（尽力而为）: ${error?.message ?? String(error)}`);
    }
  })();
}

// 自动命名（Task 11 验收缺口修复）："+" 按钮流程是 createSession()（无 title →
// "新对话"）→ submit(text, sessionId)——显式创建的会话不会经惰性创建路径的
// create({ title: deriveSessionTitle(text) }) 命名。这里在输入成功入队后按消息摘要
// 命名，与惰性创建路径对齐（首条消息前 20 字截断，见 deriveSessionTitle）。
//
// 语义约束：
//   - 只改默认标题：用户已改名（title !== "新对话"）的会话绝不动；
//   - best-effort（fire-and-forget + catch）：rename 失败只告警，绝不阻塞消息投递
//     （命名是派生元数据，事件流才是真相；改名可稍后手工进行）；
//   - 只在入队成功后调用（调用方保证 input_queued 已落盘），避免"重命名了却没
//     消息"的不一致。
async function autoNameSessionIfDefault(state, sessionId, text) {
  try {
    const meta = await state.registry.get(sessionId);
    if (meta && meta.title === "新对话") {
      await state.registry.rename(sessionId, deriveSessionTitle(text));
    }
  } catch (error) {
    console.warn(`[agent] 自动命名失败（不影响消息投递）: ${error?.message ?? String(error)}`);
  }
}

function requireSessionId(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw fail("invalid_session_id", "sessionId 必须是非空字符串。");
  }
  // C1（2026-09-23 审计）：sessionId 直达 fs.rm / 注册表路径拼接，含分隔符或 ..
  // 的 id 可穿越到 agentRoot 外；与 settings-routes 的技能目录名守卫同口径。
  if (/[\\/]|\.\./u.test(sessionId) || sessionId === "." || sessionId === ".." || sessionId.includes("\0")) {
    throw fail("invalid_session_id", "sessionId 不能包含路径分隔符或 ..。");
  }
  return sessionId;
}

// 会话管理实例工厂：runtime.mjs 在 createAgentRuntime 内逐项目生命周期持有
//（ensureProject/resolveSessionState 是 runtime 内部闭包，只能引用注入）。
export function createSessionManager(ctx) {
  const { ensureProject, resolveSessionState } = ctx;

  // 会话列表 + 最近活跃（dashboard 数据源）。
  // run_status 投影（左侧栏状态点 + busy 复位数据源）：
  // 只对已物化会话读取其 journal 的 active_run：非终态 → 报真实状态（running/
  // waiting_user 等，第十二轮 E 起不再折叠为 running）；failed → "failed"；其余
  // （无 run / completed/cancelled/interrupted）→ "idle"。未物化会话（注册表条目
  // 尚无 journal）恒为 "idle"。journal 读取失败不阻塞列表（降级 idle）。dashboard
  // 与 GET /api/agent/sessions 经同一方法透出。
  // 轮询成本：每次调用对每个已物化会话做一次 journal.getSession()——initialize 的
  // loaded 缓存避免磁盘重放（只在首次真正读取/重放），之后是内存 structuredClone
  // 当前投影；busy 期间前端每 5s 重拉一轮（session-sidebar.mjs），N 个会话的成本
  // 为 N 次内存克隆 + 注册表读盘，量级可接受。
  async function sessions({ projectRoot }) {
    if (typeof projectRoot !== "string" || projectRoot.length === 0) {
      throw fail("invalid_project_root", "projectRoot 必须是非空路径。");
    }
    const state = ensureProject(projectRoot);
    const list = await state.registry.list();
    const active = await state.registry.getLastActive();
    const withRunStatus = await Promise.all(list.map(async (meta) => {
      let runStatus = "idle";
      const sessionState = state.sessions.get(meta.session_id);
      if (sessionState) {
        try {
          const session = await sessionState.journal.getSession();
          const run = session?.active_run ?? null;
          if (run) {
            // 第十二轮 E：非终态报真实状态（waiting_user 等），不再折叠为 running——
            // 侧边栏 busy 判定已同步改为非终态集，不依赖折叠副作用。
            if (!TERMINAL_RUN_STATUSES.has(run.status)) runStatus = run.status;
            else if (run.status === "failed") runStatus = "failed";
          }
        } catch {
          // journal 读取失败不阻塞列表（保持 idle）
        }
      }
      return { ...meta, run_status: runStatus };
    }));
    return { sessions: withRunStatus, active_session_id: active };
  }

  // 显式建会话（前端"+"按钮 / 对话 B 场景）。只写注册表条目；journal 在首次
  // open/submit 时惰性物化（会话事件流的 session_created 那时才写入）。
  async function newSession({ projectRoot, title }) {
    if (typeof projectRoot !== "string" || projectRoot.length === 0) {
      throw fail("invalid_project_root", "projectRoot 必须是非空路径。");
    }
    const state = ensureProject(projectRoot);
    return state.registry.create({ title });
  }

  async function renameSession({ projectRoot, sessionId, title }) {
    if (typeof projectRoot !== "string" || projectRoot.length === 0) {
      throw fail("invalid_project_root", "projectRoot 必须是非空路径。");
    }
    requireSessionId(sessionId);
    const state = ensureProject(projectRoot);
    return state.registry.rename(sessionId, title);
  }

  async function archiveSession({ projectRoot, sessionId }) {
    if (typeof projectRoot !== "string" || projectRoot.length === 0) {
      throw fail("invalid_project_root", "projectRoot 必须是非空路径。");
    }
    requireSessionId(sessionId);
    const state = ensureProject(projectRoot);
    return state.registry.archive(sessionId);
  }

  async function restoreSession({ projectRoot, sessionId }) {
    if (typeof projectRoot !== "string" || projectRoot.length === 0) {
      throw fail("invalid_project_root", "projectRoot 必须是非空路径。");
    }
    requireSessionId(sessionId);
    const state = ensureProject(projectRoot);
    return state.registry.restore(sessionId);
  }

  // 永久删除（Task 10 设置页）：注册表元数据 + 会话数据目录一并移除。
  // 守卫：会话运行中（非终态 run）拒绝删除，避免删除后残留飞行循环。
  // 检查 + 删除在项目互斥锁内原子完成：与并发 submit 的读-判-写串行化，杜绝
  // 「检查时未落 run → 删除 → submit 写已删会话」的窗口（submit 与会话解析、
  // 串行门同锁）。
  async function deleteSession({ projectRoot, sessionId }) {
    if (typeof projectRoot !== "string" || projectRoot.length === 0) {
      throw fail("invalid_project_root", "projectRoot 必须是非空路径。");
    }
    requireSessionId(sessionId);
    const state = ensureProject(projectRoot);
    return state.mutex.run(async () => {
      const sessionState = state.sessions.get(sessionId);
      if (sessionState) {
        const session = await sessionState.journal.getSession();
        if (hasNonTerminalRun(session)) {
          throw fail("session_busy", "该会话正在运行，无法删除。");
        }
      }
      await state.registry.removePermanently(sessionId);
      state.sessions.delete(sessionId);
      // 数据目录一并移除（永久删除 = 元数据 + 事件流）；目录不存在则忽略。
      await fs.rm(path.join(state.agentRoot, "sessions", sessionId), { recursive: true, force: true }).catch(() => {});
      return { deleted: true, session_id: sessionId };
    });
  }

  // 第九轮：系统事件注入（UI 侧恢复操作在对话流中的可见性；run_id=null）。
  // best-effort：项目无会话或 append 失败不抛错（调用方 catch 已包裹）。
  async function appendSystemEvent({ projectRoot, type, payload }) {
    if (typeof projectRoot !== "string" || projectRoot.length === 0) {
      throw fail("invalid_project_root", "projectRoot 必须是非空路径。");
    }
    const state = ensureProject(projectRoot);
    const sessionState = await resolveSessionState(state, null);
    if (!sessionState) return { seq: null };
    await sessionState.journal.load();
    await sessionState.journal.append({ type, run_id: null, payload: payload ?? {} });
    return { seq: null };
  }

  return { syncSessionRegistry, autoNameSessionIfDefault, sessions, newSession,
           renameSession, archiveSession, restoreSession, deleteSession, appendSystemEvent };
}
