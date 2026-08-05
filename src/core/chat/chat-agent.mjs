// 对话 agent 主循环：解析模型回复 -> 读工具自动执行 -> 写/控制类工具先预览后挂 pending
// 续轮由 resumeChatTurn 接管；maxToolRounds 防止失控空转。
import crypto from "node:crypto";
import { buildChatContext } from "./chat-context.mjs";
import { parseAgentReply } from "./agent-protocol.mjs";
import { executeTool, checkToolPermission, summarizeArgs, toOpenAITools, describeToolAction } from "./tool-registry.mjs";
import { decideToolAuthorization } from "./task-grants.mjs";
import { previewEditChapter } from "./tools-write.mjs";
import { isJobRunning } from "./tools-control.mjs";
import { appendChatMessage, loadPendingAction, savePendingAction, clearPendingAction, updatePendingStatus } from "./chat-store.mjs";
import { createChatActivityEmitter } from "./chat-activity.mjs";
import { redactChatData } from "./chat-redaction.mjs";
import { appendTranscript } from "./transcript-store.mjs";
import { appendEvent } from "../event-log.mjs";
import { loadConfigLayers } from "../config-runtime.mjs";
import path from "node:path";

export const MAX_TOOL_ROUNDS = 32;
const RESULT_SUMMARY_CHARS = 4000;
// 截断标注：聊天带原生 tools 后走 usesChapterTool 路径，无显式 max_tokens 时默认 4096，
// finish_reason=length 说明输出被截断，追加此标注让用户感知（与 structured-output 约定一致：
// 截断检测由上游负责，chat 就是上游）。
const TRUNCATED_NOTE = "…（回复超出长度限制被截断，请缩小范围重试）";

// 写作运行时写保护：runProject 后台不持 projectLock，chat 持锁，两者并发写
// continuity/state 会 lost update（extracted_chapters 水位推进后不可恢复，静默丢记忆）。
// 运行中拒绝与流水线竞态的 write 工具；由各工具注册时声明 safeDuringRun:true 标记自身
// 与流水线无竞态（入队类 rewrite/queue、只读导出 export）--新工具默认被拦（安全默认）。
function checkRunBusy(tool, server, projectRoot) {
  if (tool?.kind === "write" && !tool?.safeDuringRun && isJobRunning(server?.runJobs?.get(path.resolve(projectRoot)))) {
    return { ok: false, error: "run_busy", message: "写作任务进行中，请先停止或等它完成，再通过对话修改设定/章节/设置。" };
  }
  return null;
}

export async function runChatTurn(options) {
  const { projectRoot, userMessage } = options;
  // §5.2: pending 存在时不再硬挡——接受新消息，旧 pending 标记 superseded 并落取消记录。
  // Task 7: 新用户消息 = 新任务，旧任务的授权即刻失效（grant 只在任务存续期内有效）。
  const taskId = options.taskId ?? crypto.randomUUID();
  const existing = await loadPendingAction(projectRoot);
  if (existing) {
    options.grants?.clear(projectRoot, existing.task_id);
    // I-1: supersede 也要关闭旧确认卡的活动流——用挂 pending 时持久化的 activity_id
    // （及原 turn_id）发 cancelled 终态，否则 Task 9 按 activity_id 渲染的确认卡永远停在
    // waiting_confirmation。error 带 superseded 语义让 UI 区分「被新指令取代」与「用户拒绝」。
    if (existing.activity_id) {
      const supersedeActivity = createChatActivityEmitter({ turnId: existing.turn_id ?? taskId, onEvent: options.onEvent });
      const phase = existing.tool === "shell" ? "command"
        : options.registry?.get(existing.tool)?.kind === "write" ? "editing" : "tool";
      supersedeActivity({
        activity_id: existing.activity_id, phase, state: "cancelled", tool: existing.tool,
        label: existing.action?.title ?? existing.tool, output_delta: "", error: "superseded"
      });
    }
    await updatePendingStatus(projectRoot, existing.idempotency_key, "superseded");
    await appendChatMessage(projectRoot, {
      role: "tool", tool: existing.tool, ok: false,
      result_summary: "因新指令自动取消", superseded: true
    });
    await clearPendingAction(projectRoot);
  }
  await appendChatMessage(projectRoot, { role: "user", content: String(userMessage ?? "") });

  // §3.4: 写 generating 占位消息。正常完成时 agentLoop 会追加正式回复，占位因 content 为空被前端跳过；
  // 如果进程崩溃/中断，最后一条消息就是 status:"generating"，前端据此渲染中断条。
  const turnId = crypto.randomUUID();
  await appendChatMessage(projectRoot, {
    role: "assistant", content: "", status: "generating", turn_id: turnId
  });
  // 统一活动事件：思考/工具/Shell/停止都经 activity 发出（同一 turn_id，SSE 直通前端）
  const activity = createChatActivityEmitter({ turnId, onEvent: options.onEvent });

  try {
    return await agentLoop({ ...options, turnId, taskId, activity }, []);
  } catch (error) {
    // I-2: 错误路径也要关闭活动流——thinking 发 failed 终态（在写失败消息之前），
    // 否则 UI 的 thinking spinner 会因 thinking:running 永无终态而常驻。
    const errorSummary = String(error.message ?? "未知错误").slice(0, 200);
    activity?.({ phase: "thinking", state: "failed", error: errorSummary, label: "思考失败" });
    // §3.4: 失败时写错误消息；任务失败同样释放本任务的授权。
    options.grants?.clear(projectRoot, taskId);
    await appendChatMessage(projectRoot, {
      role: "assistant", content: `（本轮失败：${errorSummary}，可重发）`, status: "failed", turn_id: turnId
    });
    throw error;
  }
}

export async function resumeChatTurn(options) {
  const { projectRoot, project, registry, server, getTaskQueue, grants } = options;
  // Task 7 确认契约：once=仅此一次 / task=本任务内同类放行 / reject=拒绝 / force=极端确认文字放行。
  // 兼容旧 approve 参数（approve:true -> once，approve:false/缺省 -> reject），调用方已迁移到 decision。
  let decision = options.decision ?? (options.approve === true ? "once" : "reject");
  const confirmationText = String(options.confirmationText ?? "");
  const pending = await loadPendingAction(projectRoot);
  if (!pending) {
    return { reply: "没有待确认的操作。", toolEvents: [], pendingAction: null, usage: { calls: 0, cost: 0 } };
  }
  // 前置校验：extreme pending 只接受 force + 匹配确认文字放行；reject / once / task 一律按
  // 用户拒绝处理——task 不得放行 extreme（极端操作不受任务授权覆盖，见 decideToolAuthorization
  // 的 extreme 优先分支），也不为它授予任务级授权。force 且文字不匹配则抛错，pending 原样保留可重试。
  const taskId = pending.task_id;
  if (pending.confirmation_kind === "extreme") {
    if (decision === "force" && confirmationText !== pending.confirmation_text) {
      throw Object.assign(new Error("确认文字不匹配，极端危险操作未执行。"), { code: "danger_confirmation_mismatch" });
    }
    if (decision !== "force") decision = "reject";
  } else if (decision === "task") {
    // 任务级授权按 grant_key（category:scope:target-class）放行：同一类别（如项目内 write）的
    // edit_chapter 与 shell 写命令共享同一 key。本次确认执行该工具，并授予同一任务
    // （同一 taskId）内同 grant_key 的后续调用免确认资格。
    if (pending.action?.grant_key) grants?.allow(projectRoot, taskId, pending.action.grant_key);
  }
  // §3.4: Write generating placeholder before agentLoop — crash during resumed turn
  // produces visible interrupted state (same pattern as runChatTurn).
  // I-1: resume 是同一轮对话的延续——placeholder 与活动 emitter 都沿用 pending 里持久化的
  // turn_id（旧版 pending 无 turn_id 时兜底新开），确认卡及其终态归属同一 turn，活动连续。
  const resumeTurnId = pending.turn_id ?? crypto.randomUUID();
  await appendChatMessage(projectRoot, {
    role: "assistant", content: "", status: "generating", turn_id: resumeTurnId
  });
  // 续轮活动事件：本次 pending 工具执行 + 后续 agentLoop 轮次共用同一 emitter（resume 的 turn_id）
  const activity = createChatActivityEmitter({ turnId: resumeTurnId, onEvent: options.onEvent });
  const tool = registry.get(pending.tool);
  const action = pending.action ?? { title: tool?.description ?? pending.tool };
  // 活动阶段：命令类走 command，写工具走 editing，其余走 tool
  const phase = pending.tool === "shell" ? "command" : tool?.kind === "write" ? "editing" : "tool";
  try {
    let outcome;
    if (decision === "once" || decision === "force" || decision === "task") {
      // I-1: 复用挂 pending 时持久化的 activity_id 发终态（requested/waiting_confirmation
      // 已在原轮发出，这里直接从 running 续起）；旧版 pending 无 activity_id 时兜底补发
      // requested 并取新 id，保证活动序列仍然完整。
      const activityId = pending.activity_id ?? activity?.({
        phase, state: "requested", tool: pending.tool,
        label: action.title, args: redactChatData(JSON.stringify(pending.args)),
        command: action.command ?? null, cwd: action.cwd ?? null
      });
      activity?.({
        activity_id: activityId, phase, state: "running", tool: pending.tool,
        label: action.title, args: redactChatData(JSON.stringify(pending.args)),
        command: action.command ?? null, cwd: action.cwd ?? null
      });
      // §3.3 Idempotency: if already executed, skip executeTool, use cached result
      if (pending.status === "executed") {
        // m8: 幂等重放路径——实际不执行工具，但活动事件按执行路径重放（running -> 终态），
        // 让 UI 看到同一 activity_id 的完整生命周期；cachedOutcome 是上次执行的落盘结果。
        outcome = pending.cachedOutcome;
      } else {
        const busy = checkRunBusy(tool, server, projectRoot);
        if (busy) {
          outcome = busy;
          await clearPendingAction(projectRoot);
        } else {
          // §3.3: Atomically mark as executing before execution
          const key = pending.idempotency_key ?? crypto.randomUUID();
          await updatePendingStatus(projectRoot, key, "executing");
          outcome = await executeTool(registry, pending.tool, pending.args, {
            projectRoot, project, server, getTaskQueue, signal: options.signal,
            onToolOutput: ({ text }) => activity?.({
              activity_id: activityId, phase: "command", state: "running", tool: pending.tool,
              label: "运行命令", output_delta: text, command: action.command ?? null, cwd: action.cwd ?? null
            })
          });
          // §3.3: Atomically mark as executed with cached result (crash recovery: next resume skips re-execution)
          await updatePendingStatus(projectRoot, key, "executed", outcome);
        }
      }
      // Clear pending before agentLoop so a new pending can be created
      await clearPendingAction(projectRoot);
      // m5: 复用 recordToolOutcome 统一「活动终态 + 历史消息 + tool_result 事件」的发射
      // （与 agentLoop 已授权路径同一形状），避免 resume 里复制一遍
      const outcomeEvents = [];
      await recordToolOutcome({
        projectRoot, tc: { tool: pending.tool, args: pending.args }, outcome,
        toolEvents: outcomeEvents, onEvent: options.onEvent, activity, activityId, action, phase, signal: options.signal
      });
      const toolEvent = outcomeEvents[0];
      return await agentLoop({ ...options, userMessage: null, turnId: resumeTurnId, taskId, activity }, [toolEvent]);
    } else {
      outcome = { ok: false, error: "user_rejected", message: "用户拒绝了此操作。" };
      await clearPendingAction(projectRoot);
      // I-1: reject 也用同一 activity_id 发终态。state 选 "cancelled"：Shared Contract 状态集合
      // （requested/waiting_confirmation/running/succeeded/failed/cancelled）里 cancelled 的语义是
      // 「活动未完成即终止」，与 user_rejected 一致；error 字段带 user_rejected 供 UI 区分
      // 「被用户拒绝」与「被新指令取代（superseded）/用户停止（停止消息）」。
      if (pending.activity_id) {
        activity?.({
          activity_id: pending.activity_id, phase, state: "cancelled", tool: pending.tool,
          label: action.title, output_delta: "", error: "user_rejected"
        });
      }
      // 拒绝路径：result_summary 保留 {error, message} 序列化（resume 与 agentLoop 拒绝分支同形状）
      await appendChatMessage(projectRoot, {
        role: "tool", tool: pending.tool, ok: false,
        args: summarizeArgs(pending.args),
        result_summary: summarize({ error: outcome.error, message: outcome.message })
      });
      const toolEvent = { tool: pending.tool, ok: false, error: "user_rejected" };
      options.onEvent?.({ type: "tool_result", ...toolEvent });
      return await agentLoop({ ...options, userMessage: null, turnId: resumeTurnId, taskId, activity }, [toolEvent]);
    }
  } catch (error) {
    // I-2: 续轮错误路径同样关闭 thinking 活动流（thinking:running 需有终态，UI spinner 不悬空；
    // 失败消息落盘由 runChatTurn 路径语义兜底，这里只负责活动终态与授权释放）。
    const errorSummary = String(error.message ?? "未知错误").slice(0, 200);
    activity?.({ phase: "thinking", state: "failed", error: errorSummary, label: "思考失败" });
    // 失败路径兜底：任务级授权随任务结束释放（runChatTurn 同款语义；grants.clear 幂等，
    // 正常路径已由 agentLoop 最终文本 / 轮数上限 / finishCancelled 清理，这里只补异常路径）。
    grants?.clear(projectRoot, taskId);
    throw error;
  }
}

async function agentLoop(options, toolEvents) {
  const { projectRoot, project, registry, modelClient, server, getTaskQueue, onEvent, signal, grants, taskId, turnId, activity } = options;
  // 加载运行时配置读取 chat_max_tool_rounds
  const configLayers = await loadConfigLayers(projectRoot, project ?? {}, {});
  const effectiveConfig = configLayers.effective;
  const maxToolRounds = effectiveConfig?.chat_max_tool_rounds ?? MAX_TOOL_ROUNDS;
  let totalCost = 0;
  let calls = 0;
  for (let round = 0; round < maxToolRounds + 1; round += 1) {
    if (signal?.aborted) return await finishCancelled(projectRoot, toolEvents, calls, totalCost, { grants, taskId, activity });
    // 每个模型轮次（含 resume 后的续轮）先发 thinking/running，标记模型思考开始
    activity?.({ phase: "thinking", state: "running", label: "思考中" });
    const { messages } = await buildChatContext({ projectRoot, project, registry, userMessage: latestPrompt(options, round) });
    let result;
    try {
      result = await modelClient.generate({
        project, stage: "chat", messages,
        metadata: {
          chat: true, round,
          // 聊天场景：注入原生 tools（模型自主选择是否调用），无 chapter_no；
          // 围栏 JSON 解析降为兜底，仅当模型未走原生 tool_calls 时生效。
          toolRequest: { tools: toOpenAITools(registry), project_id: project?.project_id }
        },
        signal
      });
    } catch (error) {
      // 外部停止（signal.aborted）与模型超时（仅 AbortError）要区分：超时照旧抛出走原错误链。
      if (signal?.aborted) return await finishCancelled(projectRoot, toolEvents, calls, totalCost, { grants, taskId, activity });
      throw error;
    }
    calls += 1;
    totalCost += Number(result.costSummary?.estimatedCost ?? 0) || 0;
    // 截断检测：finish_reason=length 时无论文本回复还是 tool_calls 都发 warn 事件；
    // 文本回复额外追加截断标注（tool_calls 的 arguments 截断会以工具执行错误浮出，不特殊处理）。
    const truncated = result?.raw?.choices?.[0]?.finish_reason === "length";
    if (truncated) {
      onEvent?.({ type: "chat_reply_truncated", round });
      // await 落盘（executeTool 同模式）：保证事件在回复返回前持久化，测试可确定性断言
      await appendEvent(projectRoot, {
        type: "chat_reply_truncated",
        severity: "warn",
        project_id: project?.project_id ?? null,
        stage: "chat",
        message: "chat 回复被截断（finish_reason=length）",
        data: { round }
      }).catch(() => {}); // 事件落盘失败不阻断对话流程
    }
    const parsed = parseAgentReply({ text: result.text, raw: result.raw });
    // §5.1: 转录本轮模型 I/O（fire-and-forget，失败只 warn 不阻断）
    appendTranscript(projectRoot, {
      turn_id: options.turnId,
      request_messages: messages,
      raw_response: result.text,
      parsed_tool_calls: parsed.tool_calls ?? [],
      usage: { calls, cost: totalCost, ...result.costSummary }
    }).catch(() => {}); // fire-and-forget: 转录失败不阻断对话流程
    if (parsed.type === "text") {
      // 截断时在回复末尾追加标注（进入历史与最终返回的 reply，前端据此展示）
      const content = truncated ? `${parsed.text}${TRUNCATED_NOTE}` : parsed.text;
      await appendChatMessage(projectRoot, { role: "assistant", content, cost: totalCost || undefined });
      // 任务完成（最终文本）：释放本任务的任务级授权。
      grants?.clear(projectRoot, taskId);
      // 最终文本 = 本回合活动结束
      activity?.({ phase: "complete", state: "succeeded", label: "完成" });
      return { reply: content, toolEvents, pendingAction: null, usage: { calls, cost: totalCost } };
    }
    // §2.3：只算成功执行的调用（ok===true），被拒/失败不占额度
    const successfulRounds = toolEvents.filter((e) => e.ok).length;
    if (successfulRounds >= maxToolRounds) break;
    if (signal?.aborted) return await finishCancelled(projectRoot, toolEvents, calls, totalCost, { grants, taskId, activity });

    // §2.4 + Task 7：处理本轮全部 tool_calls —— 先归一化动作、按授权矩阵决策：
    // 只读自动 / 已授权（yolo、auto_edit、任务授权）立即顺序执行，不跳过同批后续调用；
    // 普通确认与极端确认在首个待确认副作用处挂 pending，同批后续调用跳过。
    let waitingConfirmation = false;
    let savedPending = null;
    const skippedBatch = [];
    for (const tc of parsed.tool_calls) {
      if (waitingConfirmation) {
        // 排在待确认操作之后的工具：跳过决策不变（仍逐条 skipped_after_pending 事件），
        // 只改落盘方式——本轮连续 SKIPPED 循环结束后聚合成一条 batch_skipped
        // （spec §2.3-U1 P2-9：后端聚合是数据协议，历史回放/UI 重载看到同一条）。
        toolEvents.push({ tool: tc.tool, ok: false, error: "skipped_after_pending" });
        skippedBatch.push(tc.tool);
        onEvent?.({ type: "tool_result", tool: tc.tool, ok: false });
        continue;
      }

      const tool = registry.get(tc.tool);
      if (!tool) {
        await recordDeniedTool({ projectRoot, tc, toolEvents, onEvent, message: `unknown tool: ${tc.tool}`, error: "unknown_tool" });
        continue;
      }

      // 动作归一化：shell 走自身 describeAction（命令静态风险分类），静态工具走兜底动作。
      const action = describeToolAction(tool, tc.args, { projectRoot, project });
      // 活动阶段：命令类走 command，写工具走 editing，其余走 tool
      const phase = tc.tool === "shell" ? "command" : tool.kind === "write" ? "editing" : "tool";
      // 权限预检（read_only / safe_edit / 归档 / dangerous 封印），不通过则拒绝并继续处理后续 tool_calls。
      // 与下方 decideToolAuthorization 是两层检查：checkToolPermission 按工具 kind 级封印（全局开关，
      // 如 read_only），decideToolAuthorization 按动作 category/scope/risk 决策授权矩阵——两层语义一致
      // 但层级不同，先 kind 级后 category 级，都通过才执行。
      const permission = checkToolPermission(tool, project?.tool_permissions ?? {}, { archived: Boolean(project?.archived_at) });
      if (!permission.allowed) {
        await recordDeniedTool({ projectRoot, tc, toolEvents, onEvent, message: permission.message });
        continue;
      }
      // 写作运行时写保护：与后台流水线竞态的 write 工具直接拒绝（防 lost update）
      const busy = checkRunBusy(tool, server, projectRoot);
      if (busy) {
        await recordDeniedTool({ projectRoot, tc, toolEvents, onEvent, message: busy.message, error: busy.error });
        continue;
      }
      // 授权矩阵决策（extreme > read_only > yolo > 项目内 read > auto_edit > 任务授权 > 确认）
      const authorization = decideToolAuthorization({
        projectRoot,
        action,
        permissions: project?.tool_permissions ?? {},
        taskId,
        grants
      });
      if (authorization.decision === "deny") {
        await recordDeniedTool({ projectRoot, tc, toolEvents, onEvent, message: authorization.reason });
        continue;
      }
      if (["confirm", "extreme_confirm"].includes(authorization.decision)) {
        waitingConfirmation = true;
        // I-1: requested 与 waiting_confirmation 复用同一 activity_id（确认卡按 activity_id 渲染），
        // 并把该 id 持久化进 pending——resume 执行 / 用户拒绝 / 新消息 supersede 时都复用它发终态，
        // 确认卡生命周期闭环（不执行工具，终态在后续路径补上）。
        const activityId = activity?.({ phase, state: "requested", tool: tc.tool, label: action.title, args: redactChatData(JSON.stringify(tc.args)), command: action.command ?? null, cwd: action.cwd ?? null });
        activity?.({ activity_id: activityId, phase, state: "waiting_confirmation", tool: tc.tool, label: action.title, args: redactChatData(JSON.stringify(tc.args)), command: action.command ?? null, cwd: action.cwd ?? null });
        // edit_chapter 预览
        let preview = null;
        if (tc.tool === "edit_chapter") {
          try {
            preview = await previewEditChapter(projectRoot, tc.args);
          } catch (error) {
            const previewError = { ok: false, error: error.code ?? "preview_failed", message: error.message };
            await recordDeniedTool({ projectRoot, tc, toolEvents, onEvent, message: previewError.message, error: previewError.error });
            // I-4/R-1: 预览失败必须补发 cancelled 终态——requested/waiting_confirmation 已在
            // 上方发出，不补终态该 activity_id 会悬空（确认卡永停 waiting_confirmation，
            // 且不落 pending、后续路径无人再关它）。error 统一 preview_failed 语义
            // （与 recordDeniedTool 的原始错误码 find_not_found/bad_args 并存供 UI 区分）。
            activity?.({
              activity_id: activityId, phase, state: "cancelled", tool: tc.tool,
              label: action.title, output_delta: "", error: "preview_failed"
            });
            continue;
          }
        } else {
          preview = action.preview;
        }
        // 记 toolEvent（ok=true 表示预览通过，pending 状态由 pendingAction 字段指示）
        toolEvents.push({ tool: tc.tool, ok: true, error: null });
        // 极端危险操作额外生成随机确认文字，resume 必须原样带回
        const extreme = authorization.decision === "extreme_confirm";
        // 挂 pending，不立即返回——等后续 tools 标记跳过后再返回。
        // action.grant_key（category:scope:target-class 类别级）随确认卡数据透出：同一类别
        // （如项目内 write）的 edit_chapter 与 shell 写命令共享同一 key，decision=task 时授予
        // 该 key 即同类别后续调用免确认（见 resumeChatTurn）。
        savedPending = await savePendingAction(projectRoot, {
          task_id: taskId,
          turn_id: turnId,
          activity_id: activityId ?? null, // I-1: 确认卡 activity_id 持久化，resume/reject/supersede 复用它发终态
          tool: tc.tool,
          args: tc.args,
          action: { ...action, preview },
          description: action.description, // 兼容现有确认卡渲染（thread-renderer 读顶层 description）
          confirmation_kind: extreme ? "extreme" : "normal",
          confirmation_text: extreme ? `强制继续 ${crypto.randomBytes(3).toString("hex").toUpperCase()}` : null,
          preview,
          lead_text: parsed.leadText ?? ""
        });
        continue;
      }
      // 已授权：立即执行并落盘，不跳过同一批后续调用
      // 活动序列：requested -> running -> 终态（同一 activity_id；shell 增量输出复用 id 流式追加）
      const activityId = activity?.({
        phase, state: "requested", tool: tc.tool,
        label: action.title, args: redactChatData(JSON.stringify(tc.args)),
        command: action.command ?? null, cwd: action.cwd ?? null
      });
      activity?.({
        activity_id: activityId, phase, state: "running", tool: tc.tool,
        label: action.title, args: redactChatData(JSON.stringify(tc.args)),
        command: action.command ?? null, cwd: action.cwd ?? null
      });
      const outcome = await executeTool(registry, tc.tool, tc.args, {
        projectRoot, project, server, getTaskQueue, signal,
        // shell 流式输出转发为同一活动的 output_delta（tools-shell 已逐块脱敏，此处不再脱敏）
        onToolOutput: ({ text }) => activity?.({
          activity_id: activityId, phase: "command", state: "running", tool: tc.tool,
          label: "运行命令", output_delta: text, command: action.command ?? null, cwd: action.cwd ?? null
        })
      });
      await recordToolOutcome({ projectRoot, tc, outcome, toolEvents, onEvent, activity, activityId, action, phase, signal });
    }
    // 本轮全部 tool_calls 处理完毕：连续 SKIPPED 聚合落盘成一条（不改跳过决策，只改落盘方式）
    if (skippedBatch.length > 0) {
      await appendChatMessage(projectRoot, {
        role: "tool", tool: "batch_skipped", ok: false,
        result_summary: `${skippedBatch.length} 个后续操作已跳过（待前序确认）：${skippedBatch.join(", ")}`
      });
    }
    // 若写入 pending，返回等待确认；否则续下一轮
    if (savedPending) {
      const note = [parsed.leadText, `（待确认操作：${savedPending.tool}，请在确认卡上批准或取消）`].filter(Boolean).join("\n");
      await appendChatMessage(projectRoot, { role: "assistant", content: note, cost: totalCost || undefined });
      onEvent?.({ type: "pending_action", action: savedPending });
      return { reply: note, toolEvents, pendingAction: savedPending, usage: { calls, cost: totalCost } };
    }
  }
  const capped = "操作轮数达到上限，我先停在这里。请把任务拆小一点，或直接告诉我下一步。";
  await appendChatMessage(projectRoot, { role: "assistant", content: capped });
  // 轮数上限（任务结束）：释放本任务的任务级授权。
  grants?.clear(projectRoot, taskId);
  activity?.({ phase: "complete", state: "succeeded", label: "完成" });
  return { reply: capped, toolEvents, pendingAction: null, usage: { calls, cost: totalCost } };
}

// 结构化工具历史字段：args/output/command 脱敏后落盘，status 区分 cancelled/succeeded/failed。
// 非 shell 工具没有 command/cwd/output/exit_code/duration_ms，落 null/空保持结构一致，
// 供 Task 9 的 thread-renderer 按统一形状读取。
// I-3 成本取舍（不改行为）：output 落盘 stdout/stderr 全文（单条上限 ~1MiB，由 shell-runtime 的
// MAX_CAPTURE_CHARS 控制，见 shell-runtime.mjs）；readChatHistory 整文件读入内存，长会话下
// 读取成本随历史线性增长。这是计划 Step 4 的既定行为（输出全文落盘供回放排查），后续如需
// 优化可改为只保留尾部（如 64KB）或侧车存储（独立 output 文件 + 消息内引用）。
function toolMessageFields({ args, outcome, action, signal, tool }) {
  let status = signal?.aborted ? "cancelled" : outcome.ok ? "succeeded" : "failed";
  // m1: shell 非零退出码视为失败——ok 字段仍表示工具调用本身成功（toolEvents 语义不变），
  // status 反映命令真实结果，活动终态同步发 failed（activity terminal 用同一 fields.status）。
  if (status === "succeeded" && tool === "shell" && Number.isInteger(outcome.result?.exitCode) && outcome.result.exitCode !== 0) {
    status = "failed";
  }
  return {
    status,
    args: redactChatData(JSON.stringify(args ?? {})),
    command: action?.command ? redactChatData(action.command) : null,
    cwd: action?.cwd ?? null,
    output: outcome.ok ? redactChatData(outcome.result?.stdout ?? "") : redactChatData(outcome.stderr ?? outcome.message ?? ""),
    exit_code: outcome.ok ? outcome.result?.exitCode ?? null : null,
    // m2: 失败工具的耗时透传——executeTool 错误归一化把 error.durationMs（shell-runtime 超时/
    // 中止/崩溃路径都带）带进 outcome.durationMs，这里非 null 时写入
    duration_ms: outcome.ok ? outcome.result?.durationMs ?? null : outcome.durationMs ?? null
  };
}

// 拒绝分支统一落盘：权限拒绝 / 运行中写保护 / 授权 deny / 未知工具都走同一形状，避免分支复制。
async function recordDeniedTool({ projectRoot, tc, toolEvents, onEvent, message, error = "permission_denied" }) {
  const event = { tool: tc.tool, ok: false, error };
  toolEvents.push(event);
  await appendChatMessage(projectRoot, {
    role: "tool", tool: tc.tool, ok: false,
    args: summarizeArgs(tc.args),
    result_summary: message
  });
  onEvent?.({ type: "tool_result", ...event });
}

// 执行结果统一落盘：成功/失败同一形状（result_summary 用 summarize 序列化）；
// 活动终态经同一 activity_id 关闭（succeeded/failed/cancelled，带退出码与耗时）。
async function recordToolOutcome({ projectRoot, tc, outcome, toolEvents, onEvent, activity, activityId, action, phase, signal }) {
  const event = { tool: tc.tool, ok: outcome.ok, error: outcome.ok ? null : outcome.error };
  toolEvents.push(event);
  const fields = toolMessageFields({ args: tc.args, outcome, action, signal, tool: tc.tool });
  activity?.({
    activity_id: activityId, phase, state: fields.status, tool: tc.tool,
    label: action?.title ?? "", output_delta: "",
    exit_code: fields.exit_code, duration_ms: fields.duration_ms,
    error: outcome.ok ? null : outcome.error
  });
  await appendChatMessage(projectRoot, {
    role: "tool", tool: tc.tool, ok: outcome.ok, ...fields,
    result_summary: summarize(outcome.ok ? outcome.result : { error: outcome.error, message: outcome.message })
  });
  onEvent?.({ type: "tool_result", ...event });
}

async function finishCancelled(projectRoot, toolEvents, calls, totalCost, { grants, taskId, activity } = {}) {
  // 取消同样视为任务结束：释放本任务的任务级授权。
  grants?.clear(projectRoot, taskId);
  // 停止路径：活动流以 cancelled 收尾，不再停留在 running
  activity?.({ phase: "tool", state: "cancelled", label: "已停止" });
  await appendChatMessage(projectRoot, { role: "assistant", content: "（已停止。）", cost: totalCost || undefined });
  return { reply: "（已停止。）", toolEvents, pendingAction: null, cancelled: true, usage: { calls, cost: totalCost } };
}

function latestPrompt(options, round) {
  if (round === 0 && options.userMessage) return options.modelInstruction ?? options.userMessage;
  return "（继续：基于上面的工具结果决定下一步——继续调用工具或给出最终回答。）";
}

function summarize(value) {
  const json = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return json.length > RESULT_SUMMARY_CHARS ? `${json.slice(0, RESULT_SUMMARY_CHARS)}…` : json;
}
