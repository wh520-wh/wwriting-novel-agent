// src/core/http/agent-routes.mjs —— Agent HTTP 路由（统一 Agent 内核计划 Task 7 Step 2）。
//
// 只通过注入的 ProjectAgent（src/core/agent/index.mjs 公共接口）访问 Agent 能力，
// 不 import agent 内部文件（依赖规则 D）。本模块不创建 ModelClient、锁或 store。
//
// 路由清单（响应只含 ids 与结构化状态，不含解释性成功文案）：
//   POST /api/agent/input                 { projectRoot, text } -> { ok, input_id, run_id, status }
//   POST /api/agent/input/:inputId/promote { projectRoot }      -> { ok, run_id, input_id, promoted }
//   POST /api/agent/run/:runId/stop       { projectRoot }       -> { ok, run_id, cancelled }
//   POST /api/agent/run/:runId/retry      { projectRoot }       -> { ok, run_id, input_id, retried }
//   POST /api/agent/decision/:decisionId  { projectRoot, choice } -> { ok, decision_id, granted }
//   GET  /api/agent/snapshot?projectRoot&afterSeq&limit          -> { ok, session, events }
//   GET  /api/project/events?projectRoot  （SSE：轮询 journal，逐条推送事件）
//
// 运行中 submit 返回 HTTP 200 + status:"queued"（FIFO 队列，同一 run_id）；
// 空闲 submit 创建新 Run，返回 status:"running"。错误统一由 router 适配。
//
// 作用域语义（Task 9 接线时评估是否补强）：本模块不做项目注册校验，projectRoot
// 直接透传给 ProjectAgent——journal 会惰性创建 .wwriting/agent/（对任意路径）。
// 本地单机应用的暴露面有限（只有本机 UI 会调这些端点），且与 ProjectAgent 的
// open/submit 语义一致（open 同样不校验注册）；旧 app-server 的 resolveRead/
// WriteProjectRoot 注册校验由 project-routes 保留。若未来暴露到网络，应在
// composition root 对 /api/agent/* 统一加作用域检查。
import { HttpError } from "../http-error.mjs";

const SNAPSHOT_LIMIT_MAX = 1000;
const EVENTS_POLL_INTERVAL_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createAgentRoutes({ agent, eventsPollIntervalMs = EVENTS_POLL_INTERVAL_MS } = {}) {
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

  return {
    // 空闲 → 创建新 Run（status:"running"）；运行中 → FIFO 队列（status:"queued"，同 run_id）。
    "POST /api/agent/input": async ({ body }) => {
      const projectRoot = requireProjectRoot(body);
      const text = body?.text;
      if (typeof text !== "string" || text.trim().length === 0) {
        throw new HttpError(400, "empty_input", "text 必须是非空字符串。");
      }
      const result = await agent.submit({ projectRoot, text, source: "chat" });
      return {
        ok: true,
        input_id: result.input_id,
        run_id: result.run_id,
        status: result.queued === true ? "queued" : "running"
      };
    },

    // 立即：同一 Run 内打断并提升排队输入，返回同一 run_id。
    "POST /api/agent/input/:inputId/promote": async ({ params, body }) => {
      const projectRoot = requireProjectRoot(body);
      const result = await agent.promote({ projectRoot, inputId: params.inputId });
      return {
        ok: true,
        run_id: result.run_id,
        input_id: result.input_id,
        promoted: result.promoted === true
      };
    },

    // 停止：只作用于当前活动 Run；路径 runId 必须与活动 Run 一致，否则 404。
    "POST /api/agent/run/:runId/stop": async ({ params, body }) => {
      const projectRoot = requireProjectRoot(body);
      const { session } = await agent.snapshot({ projectRoot, afterSeq: 0, limit: 1 });
      const run = session?.active_run;
      if (!run || run.id !== params.runId) {
        throw new HttpError(404, "run_not_found", `Run ${params.runId} 不是当前会话的活动 Run。`);
      }
      const result = await agent.stop({ projectRoot, reason: "user_stop" });
      return { ok: true, run_id: result.run_id, cancelled: result.cancelled === true };
    },

    // 重试：继续同一可恢复 Run（failed/interrupted）。
    "POST /api/agent/run/:runId/retry": async ({ params, body }) => {
      const projectRoot = requireProjectRoot(body);
      const result = await agent.retry({ projectRoot, runId: params.runId });
      return {
        ok: true,
        run_id: result.run_id,
        input_id: result.input_id,
        retried: result.retried === true
      };
    },

    // 决策：choice ∈ allow/allow_input/deny；extreme 决策要求 choice 为精确确认文字。
    "POST /api/agent/decision/:decisionId": async ({ params, body }) => {
      const projectRoot = requireProjectRoot(body);
      const choice = body?.choice;
      if (typeof choice !== "string" || choice.length === 0) {
        throw new HttpError(400, "invalid_choice", "choice 必须是非空字符串。");
      }
      const result = await agent.decide({ projectRoot, decisionId: params.decisionId, choice });
      return { ok: true, decision_id: result.decision_id, granted: result.granted };
    },

    // 快照：{ session, events } 是 AgentSurface 的唯一实时数据源。
    "GET /api/agent/snapshot": async ({ query }) => {
      const projectRoot = requireProjectRoot({}, query);
      const afterSeq = Number.isFinite(Number(query.afterSeq)) ? Math.max(0, Number(query.afterSeq)) : 0;
      const limit = Number.isFinite(Number(query.limit))
        ? Math.min(SNAPSHOT_LIMIT_MAX, Math.max(1, Number(query.limit)))
        : 100;
      const { session, events } = await agent.snapshot({ projectRoot, afterSeq, limit });
      return { ok: true, session, events };
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
      const projectRoot = requireProjectRoot({}, query);
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
            const { events } = await agent.snapshot({ projectRoot, afterSeq, limit: 100 });
            for (const event of events) {
              if (isGone()) break;
              response.write(`data: ${JSON.stringify(event)}\n\n`);
              afterSeq = Math.max(afterSeq, Number(event?.seq) || 0);
            }
          } catch (error) {
            // 快照失败（如项目未注册）推送一条错误事件后关闭流
            if (!isGone()) {
              response.write(
                `event: error\ndata: ${JSON.stringify({ ok: false, code: error?.code ?? "internal_error", message: error?.message ?? "事件流错误" })}\n\n`
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
