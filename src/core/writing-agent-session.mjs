// src/core/writing-agent-session.mjs
// 写作 Agent 会话控制平面（借鉴 Pi agent-loop/agent 设计）：
// - start/steer/followUp/abort/waitForIdle
// - agent_start / agent_end / agent_settled 三级生命周期事件
// - 读循环自动升级：连续 N 次只读工具后切换 commit-only
import { runAgentLoop } from "./agent-loop.mjs";

export class WritingAgentSession {
  constructor({
    callModel,
    executeTool,
    emitEvent = async () => {},
    allowedTools,
    commitTool = "append_chapter_segment",
    maxConsecutiveReads = 3,
    maxTurns = 24,
    context = {},
  } = {}) {
    if (typeof callModel !== "function" || typeof executeTool !== "function") {
      throw new TypeError("WritingAgentSession 需要 callModel 与 executeTool");
    }
    this.callModel = callModel;
    this.executeTool = executeTool;
    this.emitEvent = emitEvent;
    this.baseAllowedTools = [...(allowedTools ?? [commitTool])];
    this.commitTool = commitTool;
    this.maxConsecutiveReads = maxConsecutiveReads;
    this.maxTurns = maxTurns;
    this.context = context;

    this.status = "idle";
    this.abortController = null;
    this.followUpQueue = [];
    this.pendingSteer = [];
    this.sharedSteering = null;
    this.idlePromise = null;
    this.idleResolve = null;
    this.runs = 0;
  }

  async start(request = {}) {
    if (this.status !== "idle") {
      throw new Error("WritingAgentSession: 上一个 run 尚未结束");
    }
    this.status = "running";
    this.runs += 1;
    this.abortController = new AbortController();
    const onExternalAbort = () => this.abort("external");
    request.signal?.addEventListener("abort", onExternalAbort, { once: true });

    let consecutiveReads = 0;
    let escalated = false;
    const steering = [...this.pendingSteer.splice(0)];
    this.sharedSteering = steering;

    await this.emitEvent("agent_start", { run: this.runs, allowed_tools: [...this.baseAllowedTools] });

    let result;
    try {
      result = await runAgentLoop({
        context: { ...this.context, allowedTools: [...this.baseAllowedTools], feedback: null, steering },
        maxTurns: this.maxTurns,
        signal: this.abortController.signal,
        emitEvent: this.emitEvent,
        prepareNextTurn: (ctx) => {
          if (ctx.steering.length > 0) {
            ctx.feedback = ((ctx.feedback ?? "") + ctx.steering.join("\n")).trim();
            ctx.steering.length = 0;
          }
          if (!escalated && consecutiveReads >= this.maxConsecutiveReads && ctx.allowedTools.length > 1) {
            escalated = true;
            ctx.allowedTools = [this.commitTool];
            void this.emitEvent("agent_loop_commit_only", {
              turn: ctx.turn,
              consecutive_reads: consecutiveReads,
            });
          }
        },
        callModel: (ctx) => this.callModel(ctx),
        executeTool: async (output, ctx) => {
          const toolResult = await this.executeTool(output, ctx);
          if (toolResult?.ok) {
            if (toolResult.readOnly) {
              consecutiveReads += 1;
            } else {
              consecutiveReads = 0;
              if (escalated) {
                escalated = false;
                ctx.allowedTools = [...this.baseAllowedTools];
              }
            }
          }
          return toolResult;
        },
        shouldStopAfterTurn: (ctx, toolResult) => {
          if (toolResult?.stopRun) {
            return { stop: true, outcome: toolResult.stopRun.outcome ?? "failed", reason: toolResult.stopRun.reason };
          }
          if (toolResult?.committed) {
            return { stop: true, outcome: "completed", reason: "committed", result: toolResult.result };
          }
          return { stop: false };
        },
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        result = { outcome: "aborted", turns: 0, lastResult: null };
      } else {
        this.status = "idle";
        request.signal?.removeEventListener?.("abort", onExternalAbort);
        throw error;
      }
    } finally {
      this.sharedSteering = null;
      request.signal?.removeEventListener?.("abort", onExternalAbort);
    }

    await this.emitEvent("agent_end", {
      run: this.runs,
      outcome: result.outcome,
      reason: result.reason,
      turns: result.turns,
    });

    this.status = "settling";
    const queue = this.followUpQueue.splice(0);
    for (const job of queue) {
      await job();
    }
    this.status = "idle";
    await this.emitEvent("agent_settled", { runs: this.runs });
    this.idleResolve?.();
    this.idleResolve = null;
    this.idlePromise = null;

    return { outcome: result.outcome, reason: result.reason, result: result.lastResult, turns: result.turns };
  }

  steer(text) {
    (this.sharedSteering ?? this.pendingSteer).push(text);
  }

  followUp(job) {
    if (typeof job !== "function") {
      throw new TypeError("followUp 需要异步函数");
    }
    this.followUpQueue.push(job);
  }

  abort(reason = "user") {
    this.abortReason = reason;
    this.abortController?.abort();
  }

  async waitForIdle() {
    if (this.status === "idle") return;
    if (!this.idlePromise) {
      this.idlePromise = new Promise((resolve) => {
        this.idleResolve = resolve;
      });
    }
    return this.idlePromise;
  }
}
