// src/core/http/agent-routes.mjs —— Agent HTTP 路由（统一 Agent 内核计划 Task 7 Step 2）。
//
// 只通过注入的 ProjectAgent（src/core/agent/index.mjs 公共接口）访问 Agent 能力，
// 不 import agent 内部文件（依赖规则 D）。本模块不创建 ModelClient、锁或 store。
//
// 路由清单（响应只含 ids 与结构化状态，不含解释性成功文案；全部既有 Agent 端点
// 可选透传 sessionId，缺省 = 最近活跃会话，Task 4 runtime 语义）：
//   POST /api/agent/input                 { projectRoot, text, sessionId? } -> { ok, input_id, run_id, session_id, status }
//   POST /api/agent/input/:inputId/priority { projectRoot, sessionId? }      -> { ok, session_id, run_id, input_id, priority_pending }
//   POST /api/agent/input/:inputId/withdraw { projectRoot, sessionId? }      -> { ok, session_id, run_id, input_id, withdrawn, draft_text }
//   POST /api/agent/run/:runId/stop       { projectRoot, sessionId? }        -> { ok, session_id, run_id, cancelled }
//   POST /api/agent/run/:runId/retry      { projectRoot, sessionId? }        -> { ok, run_id, input_id, retried }
//   POST /api/agent/compaction/:compactionId/cancel { projectRoot, sessionId? } -> { ok, compaction_id, cancelling }
//   POST /api/agent/compaction/:compactionId/retry  { projectRoot, sessionId? } -> { ok, compaction_id, retried }
//   旧 POST /api/agent/input/:inputId/promote 已删除（Task 26：「立即」唯一权威路径
//   是 /priority，旧路由返回 404）。
//   POST /api/agent/decision/:decisionId  { projectRoot, choice, sessionId? } -> { ok, decision_id, granted }
//   GET  /api/agent/snapshot?projectRoot&sessionId&afterSeq&beforeSeq&tail&limit -> { ok, session, events, gaps, has_more }
//   POST /api/agent/history/export       { projectRoot, sessionId? } -> NDJSON 下载（application/x-ndjson + attachment）
//   POST /api/agent/history/clear        { projectRoot, sessionId?, confirm_irreversible } -> { ok, session_id, status, generation_id }
//   GET  /api/project/events?projectRoot&sessionId&afterSeq （SSE：按会话轮询 journal，逐条推送事件）
// Task 5 会话 CRUD：
//   GET    /api/agent/sessions?projectRoot                -> { ok, sessions, active_session_id }
//   POST   /api/agent/sessions          { projectRoot, title? } -> { ok, session }
//   PATCH  /api/agent/sessions/:sessionId { projectRoot, title? | archived?: true|false } -> { ok, session }
//   DELETE /api/agent/sessions/:sessionId?projectRoot     -> { ok, session_id }（永久删除）
//
// 运行中 submit 返回 HTTP 200 + status:"queued"（FIFO 队列，同一 run_id）；
// 空闲 submit 创建新 Run，返回 status:"running"。错误统一由 router 适配。
//
// 作用域语义（Task 9 评审闭环）：本模块自身不做项目注册校验——projectRoot 由
// 注入的 resolveProjectRoot(root) 解析；组合根（app-server.mjs）注入与 project-routes
// 一致的注册校验（resolveReadProjectRoot：当前选中 / 工作区内 / 最近列表 + 磁盘目录
// 可访问，不要求 project.yaml），未注册路径返回 400 INVALID_WORKSPACE_SCOPE，
// journal 不会对任意路径惰性创建目录。单元测试直接组装本模块时不注入该校验（本地
// 项目目录即合法作用域），保持传输层与作用域策略解耦。
import { HttpError, publicErrorMessage, safePublicErrorCode } from "../http-error.mjs";

const SNAPSHOT_LIMIT_MAX = 1000;
const EVENTS_POLL_INTERVAL_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createAgentRoutes({ agent, resolveProjectRoot = null, eventsPollIntervalMs = EVENTS_POLL_INTERVAL_MS } = {}) {
  if (!agent || typeof agent.submit !== "function") {
    throw new TypeError("createAgentRoutes 需要注入 ProjectAgent（src/core/agent/index.mjs）");
  }

  function requireProjectRoot(body, query = {}) {
    const value = body?.projectRoot ?? query.projectRoot;
    if (typeof value !== "string" || value.length === 0) {
      throw new HttpError(400, "invalid_project_root", "projectRoot 必须是非空路径。");
    }
    return value;
  }

  // 作用域解析：先要求非空 projectRoot，再交给注入的注册校验（组合根职责）。
  async function resolveScope(body, query = {}) {
    const projectRoot = requireProjectRoot(body, query);
    if (typeof resolveProjectRoot === "function") {
      return resolveProjectRoot(projectRoot);
    }
    return projectRoot;
  }

  // 会话定向（Task 5）：body/query 里的可选 sessionId。缺省（undefined）= 最近活跃
  // 会话（Task 4 runtime 语义，旧调用方行为不变）；显式提供但为空/非字符串 → 400。
  function optionalSessionId(body, query = {}) {
    const value = body?.sessionId ?? query.sessionId;
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" || value.length === 0) {
      throw new HttpError(400, "invalid_session_id", "sessionId 必须是非空字符串。");
    }
    return value;
  }

  // 新建/改名/归档/恢复的 title 校验（HTTP 边界先于 registry；registry 对空标题
  // 抛带 code 的 invalid_session_title，路由层拦截后不会再触达）。
  function requireTitle(body) {
    const title = body?.title;
    if (typeof title !== "string" || title.trim().length === 0) {
      throw new HttpError(400, "invalid_session_title", "title 必须是非空字符串。");
    }
    return title;
  }

  // 压缩领域错误 → HttpError（Task 9）：runtime.mjs 的 fail(code) 抛出的域 code
  // 在这里映射为固定状态码与中文文案，交给 router 统一输出（sendError 会按
  // publicErrorMessage 白名单决定是否透传 message；未在白名单内的 code 一律
  // 收敛为通用文案，绝不泄漏底层错误文本）。
  const COMPACTION_ERROR_STATUS = {
    invalid_compaction_id: 400,
    compaction_not_found: 404,
    compaction_not_retryable: 409,
    compaction_in_flight: 409,
    compaction_no_run: 409
  };
  const COMPACTION_ERROR_MESSAGE = {
    invalid_compaction_id: "压缩任务标识无效。",
    compaction_not_found: "压缩任务不存在或已结束。",
    compaction_not_retryable: "压缩已结束，无法重试。",
    compaction_in_flight: "压缩正在进行中，无法重试。",
    compaction_no_run: "当前没有可继续压缩的 Run。"
  };
  async function runCompactionAction(action) {
    try {
      return await action();
    } catch (error) {
      const status = COMPACTION_ERROR_STATUS[error?.code];
      if (status) {
        throw new HttpError(status, error.code, COMPACTION_ERROR_MESSAGE[error.code]);
      }
      throw error;
    }
  }

  return {
    // 空闲 → 创建新 Run（status:"running"）；运行中 → FIFO 队列（status:"queued"，同 run_id）。
    // sessionId 可选：缺省 = 最近活跃；无会话时惰性创建（响应带 session_id）。
    "POST /api/agent/input": async ({ body }) => {
      const projectRoot = await resolveScope(body);
      const sessionId = optionalSessionId(body);
      const text = body?.text;
      if (typeof text !== "string" || text.trim().length === 0) {
        throw new HttpError(400, "empty_input", "text 必须是非空字符串。");
      }
      const result = await agent.submit({ projectRoot, text, source: "chat", sessionId });
      return {
        ok: true,
        input_id: result.input_id,
        run_id: result.run_id,
        session_id: result.session_id,
        status: result.queued === true ? "queued" : "running"
      };
    },

    // 请求优先（Task 9/10）：排队输入标记 priority_input_requested；安全点在模型
    // 响应后、每个工具前后、下一次模型请求前切换（旧输入收敛 + 优先输入开始），
    // 本路由只写优先标记 + 返回 priority_pending。校验全部委托 runtime（同一
    // session 项目互斥锁内读-判-写）：非排队输入 → 409 input_not_queued；已有
    // 优先在途 → 409 priority_pending（本模块显式映射，router 的 STATUS_409 表
    // 未收录该新 code）。Task 26：旧 promote 路由已删除，「立即」唯一权威路径。
    "POST /api/agent/input/:inputId/priority": async ({ params, body }) => {
      const projectRoot = await resolveScope(body);
      const sessionId = optionalSessionId(body);
      const result = await (async () => {
        try {
          return await agent.requestPriority({ projectRoot, inputId: params.inputId, sessionId });
        } catch (error) {
          if (error?.code === "priority_pending") {
            throw new HttpError(409, "priority_pending", "已有优先输入在途，请等待当前优先输入开始或撤回。");
          }
          throw error;
        }
      })();
      return {
        ok: true,
        session_id: result.session_id,
        run_id: result.run_id,
        input_id: result.input_id,
        priority_pending: result.priority_pending === true
      };
    },

    // 撤回排队输入（Task 9）：只接受 queued（活动输入/已开始输入 → 409
    // input_not_queued），写 input_withdrawn 后返回原始文本 draft_text 供 UI
    // 恢复输入框。校验委托 runtime 的 session mutex，HTTP 层不做快照预校验。
    "POST /api/agent/input/:inputId/withdraw": async ({ params, body }) => {
      const projectRoot = await resolveScope(body);
      const sessionId = optionalSessionId(body);
      const result = await agent.withdrawInput({ projectRoot, inputId: params.inputId, sessionId });
      return {
        ok: true,
        session_id: result.session_id,
        run_id: result.run_id,
        input_id: result.input_id,
        withdrawn: result.withdrawn === true,
        draft_text: result.draft_text
      };
    },

    // 停止（Task 9）：runId 校验全部委托 runtime——在 session 项目互斥锁内重读并
    // 精确匹配活动 Run（不匹配/无活动 Run → 404 run_not_found）。HTTP 层删除快照
    // 预校验（消除 B15 TOCTOU：预校验读到的快照与 stop 落盘之间的窗口不再存在）。
    "POST /api/agent/run/:runId/stop": async ({ params, body }) => {
      const projectRoot = await resolveScope(body);
      const sessionId = optionalSessionId(body);
      const result = await agent.stop({ projectRoot, runId: params.runId, reason: "user_stop", sessionId });
      return {
        ok: true,
        session_id: result.session_id ?? null,
        run_id: result.run_id,
        cancelled: result.cancelled === true
      };
    },

    // 重试：继续同一可恢复 Run（failed/interrupted）。
    "POST /api/agent/run/:runId/retry": async ({ params, body }) => {
      const projectRoot = await resolveScope(body);
      const sessionId = optionalSessionId(body);
      const result = await agent.retry({ projectRoot, runId: params.runId, sessionId });
      return {
        ok: true,
        run_id: result.run_id,
        input_id: result.input_id,
        retried: result.retried === true
      };
    },

    // 压缩取消/重试（Task 9）：ESC、按钮与 HTTP 都调用同一后端方法（Task 8
    // Step 7，复用当前项目 state 的 AbortController，不创建第二套终止协议）。
    // 成功响应里的 cancelling/retried 表示「请求已被接受」；压缩本身随后续
    // context_compaction_* 事件收敛到终态，前端以事件为准（Task 11/12）。
    // 错误码 → HTTP 状态在本模块内显式映射（与下方 clearHistory 同一模式）：
    // 不存在的 compaction id → 404，状态冲突/无 Run → 409，非法 id → 400；
    // 其余错误交给 router 统一脱敏（不泄漏底层错误文本）。
    "POST /api/agent/compaction/:compactionId/cancel": async ({ params, body }) => {
      const projectRoot = await resolveScope(body);
      const sessionId = optionalSessionId(body);
      const result = await runCompactionAction(() =>
        agent.cancelCompaction({ projectRoot, sessionId, compactionId: params.compactionId })
      );
      return { ok: true, compaction_id: result.compaction_id, cancelling: true };
    },

    "POST /api/agent/compaction/:compactionId/retry": async ({ params, body }) => {
      const projectRoot = await resolveScope(body);
      const sessionId = optionalSessionId(body);
      const result = await runCompactionAction(() =>
        agent.retryCompaction({ projectRoot, sessionId, compactionId: params.compactionId })
      );
      return { ok: true, compaction_id: result.compaction_id, retried: true };
    },

    // 决策：choice ∈ allow/allow_input/deny；extreme 决策要求 choice 为精确确认文字。
    "POST /api/agent/decision/:decisionId": async ({ params, body }) => {
      const projectRoot = await resolveScope(body);
      const sessionId = optionalSessionId(body);
      const choice = body?.choice;
      if (typeof choice !== "string" || choice.length === 0) {
        throw new HttpError(400, "invalid_choice", "choice 必须是非空字符串。");
      }
      const result = await agent.decide({ projectRoot, sessionId, decisionId: params.decisionId, choice });
      return { ok: true, decision_id: result.decision_id, granted: result.granted };
    },

    // 快照：{ session, events, gaps, has_more } 是 AgentSurface 的唯一实时数据源。
    // Task 5 双向分页：tail=true → 最新尾部页；beforeSeq → 该 seq 之前的旧页；
    // 缺省 → afterSeq 增量拉取（afterSeq=0 只表示从头读取，旧客户端兼容）。
    "GET /api/agent/snapshot": async ({ query }) => {
      const projectRoot = await resolveScope({}, query);
      const sessionId = optionalSessionId({}, query);
      const afterSeq = Number.isFinite(Number(query.afterSeq)) ? Math.max(0, Number(query.afterSeq)) : 0;
      const beforeSeqParam = Number(query.beforeSeq);
      const beforeSeq = Number.isFinite(beforeSeqParam) && beforeSeqParam > 0 ? beforeSeqParam : null;
      const tail = query.tail === "true" || query.tail === "1";
      const limit = Number.isFinite(Number(query.limit))
        ? Math.min(SNAPSHOT_LIMIT_MAX, Math.max(1, Number(query.limit)))
        : 100;
      const { session, events, gaps, has_more } = await agent.snapshot({
        projectRoot,
        sessionId,
        afterSeq,
        beforeSeq,
        tail,
        limit
      });
      return { ok: true, session, events, gaps, has_more };
    },

    // 历史导出（NDJSON 下载）：只读动作，不追加 Journal 事件。每行
    // { stream: "event"|"transcript"|"gap", record }；gap 行只保留损坏范围。
    // 响应不包含 API Key/模型密钥/未脱敏 provider header（runtime redactor 逐条
    // 脱敏）；流中途失败（如段文件被外部破坏）以脱敏错误行收尾，不泄漏原始路径。
    "POST /api/agent/history/export": async ({ body, response }) => {
      const projectRoot = await resolveScope(body);
      const sessionId = optionalSessionId(body);
      response.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "content-disposition": 'attachment; filename="wwriting-agent-history.jsonl"',
        "cache-control": "no-store"
      });
      try {
        for await (const line of agent.exportHistory({ projectRoot, sessionId })) {
          if (response.destroyed || response.writableEnded) return;
          response.write(`${JSON.stringify(line)}\n`);
        }
        if (!response.writableEnded) response.end();
      } catch (error) {
        if (!response.writableEnded && !response.destroyed) {
          response.write(
            `${JSON.stringify({
              stream: "error",
              record: { code: safePublicErrorCode(error), message: publicErrorMessage(error) }
            })}\n`
          );
          response.end();
        }
      }
    },

    // 不可逆清空：仅当 session idle 且确认 confirm_irreversible:true。活动 Run →
    // 409 history_busy；缺少确认 → 400 confirmation_required（busy 校验先于确认）。
    "POST /api/agent/history/clear": async ({ body }) => {
      const projectRoot = await resolveScope(body);
      const sessionId = optionalSessionId(body);
      const confirmIrreversible = body?.confirm_irreversible === true;
      try {
        const result = await agent.clearHistory({ projectRoot, sessionId, confirmIrreversible });
        return {
          ok: true,
          session_id: result.session_id,
          status: result.status,
          generation_id: result.generation_id
        };
      } catch (error) {
        if (error?.code === "history_busy") {
          throw new HttpError(409, "history_busy", "Agent 正在运行，无法清空历史。");
        }
        if (error?.code === "confirmation_required") {
          throw new HttpError(400, "confirmation_required", "清空历史不可逆，必须显式确认。");
        }
        throw error;
      }
    },

    // -----------------------------------------------------------------------
    // Task 5：会话 CRUD（注册表元数据；journal 由 runtime 首次使用才物化）
    // -----------------------------------------------------------------------

    // 会话列表 + 最近活跃（dashboard 会话栏数据源）。缺省 = 最近活跃指针；
    // 品牌新项目（无会话）→ sessions:[] 且 active_session_id:null（惰性）。
    "GET /api/agent/sessions": async ({ query }) => {
      const projectRoot = await resolveScope({}, query);
      const { sessions, active_session_id } = await agent.sessions({ projectRoot });
      return { ok: true, sessions, active_session_id };
    },

    // 新建会话（前端"+"按钮）：title 可选（缺省 = "新对话"），只写注册表条目。
    "POST /api/agent/sessions": async ({ body }) => {
      const projectRoot = await resolveScope(body);
      const title = body?.title;
      if (title !== undefined && (typeof title !== "string" || title.trim().length === 0)) {
        throw new HttpError(400, "invalid_session_title", "title 必须是非空字符串。");
      }
      const session = await agent.newSession({ projectRoot, title });
      return { ok: true, session };
    },

    // 改名 / 归档 / 恢复：archived:true → 归档、false → 恢复；否则 title → 改名。
    // 三者互斥（title 与 archived 同传时 archived 优先）。archived 必须为真实
    // boolean（true/false），调用方是自家前端；字符串 "true" 会落入改名分支。
    // 不存在的会话 → 404 session_not_found（registry 自带 code，HTTP 层按码映射）。
    "PATCH /api/agent/sessions/:sessionId": async ({ params, body }) => {
      const projectRoot = await resolveScope(body);
      const sessionId = params.sessionId;
      if (body?.archived === true) {
        const session = await agent.archiveSession({ projectRoot, sessionId });
        return { ok: true, session };
      }
      if (body?.archived === false) {
        const session = await agent.restoreSession({ projectRoot, sessionId });
        return { ok: true, session };
      }
      const title = requireTitle(body);
      const session = await agent.renameSession({ projectRoot, sessionId, title });
      return { ok: true, session };
    },

    // 永久删除（注册表元数据 + 数据目录）；会话运行中 → 409 session_busy（runtime
    // deleteSession 在项目互斥锁内检查并拒绝）。不存在的会话幂等删除（200）。
    "DELETE /api/agent/sessions/:sessionId": async ({ params, query }) => {
      const projectRoot = await resolveScope({}, query);
      const result = await agent.deleteSession({ projectRoot, sessionId: params.sessionId });
      return { ok: true, session_id: result.session_id };
    },

    // SSE 端点（Task 9 接线后成为唯一 Agent 实时流）：轮询 journal 快照，
    // 按 afterSeq 增量推送事件；连接关闭即停止轮询。
    //
    // 关闭检测：不能检查 request.destroyed —— router 的 readJsonBody 用
    // `for await` 消费请求流，正常完成也会把 request 置为 destroyed（Node 24 实测）；
    // 客户端（undici fetch / EventSource）断开时可靠信号是 response 的 "close"
    // 事件（伴随 response.destroyed=true）。write 到已销毁响应不抛错（静默丢弃），
    // 不能依赖 write 失败兜底。
    "GET /api/project/events": async ({ query, request, response }) => {
      const projectRoot = await resolveScope({}, query);
      const sessionId = optionalSessionId({}, query);
      const afterSeqParam = Number(query.afterSeq);
      let afterSeq = Number.isFinite(afterSeqParam) ? Math.max(0, afterSeqParam) : 0;
      let closed = false;
      const onClose = () => {
        closed = true;
      };
      request.on("close", onClose);
      response.on("close", onClose);
      const isGone = () => closed || response.destroyed || response.writableEnded;
      try {
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive"
        });
        response.write(": connected\n\n");
        while (!isGone()) {
          try {
            // Task 5：按会话轮询——sessionId 缺省 = 最近活跃（旧调用方行为不变），
            // afterSeq 按该会话 seq 推进（各会话事件流 seq 各自单调递增）。
            // 注意：缺省时每次 poll 都重新解析最近活跃；若活跃会话中途切换，
            // afterSeq 沿用旧会话的 seq 空间，对新会话会重放/漏推。显式 sessionId
            // 是安全的；前端切换会话应显式带 sessionId 重连。
            const { events } = await agent.snapshot({ projectRoot, sessionId, afterSeq, limit: 100 });
            for (const event of events) {
              if (isGone()) break;
              response.write(`data: ${JSON.stringify(event)}\n\n`);
              afterSeq = Math.max(afterSeq, Number(event?.seq) || 0);
            }
          } catch (error) {
            // 快照失败（如项目未注册 / 工作区不可读）推送一条错误事件后关闭流。
            // 统一错误脱敏（计划 Task 4 Step 6）：data 行的 message/code 只使用
            // publicErrorMessage / safePublicErrorCode —— 原始 Node fs 错误文本与
            // 内部绝对路径不得随 SSE data 行离开服务器（SPEC §11）。
            if (!isGone()) {
              response.write(
                `event: error\ndata: ${JSON.stringify({ ok: false, code: safePublicErrorCode(error), message: publicErrorMessage(error) })}\n\n`
              );
            }
            break;
          }
          if (isGone()) break;
          await sleep(eventsPollIntervalMs);
        }
      } catch {
        // 客户端已断开，直接退出轮询
      } finally {
        request.removeListener("close", onClose);
        response.removeListener("close", onClose);
        try {
          response.end();
        } catch {
          // 连接已不可写，忽略
        }
      }
    }
  };
}
