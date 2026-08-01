// 对话 agent 主循环：解析模型回复 -> 读工具自动执行 -> 写/控制类工具先预览后挂 pending
// 续轮由 resumeChatTurn 接管；maxToolRounds 防止失控空转。
import crypto from "node:crypto";
import { buildChatContext } from "./chat-context.mjs";
import { parseAgentReply } from "./agent-protocol.mjs";
import { executeTool, checkToolPermission, summarizeArgs, toOpenAITools } from "./tool-registry.mjs";
import { previewEditChapter } from "./tools-write.mjs";
import { isJobRunning } from "./tools-control.mjs";
import { appendChatMessage, loadPendingAction, savePendingAction, clearPendingAction, updatePendingStatus } from "./chat-store.mjs";
import { appendTranscript } from "./transcript-store.mjs";
import { loadConfigLayers } from "../config-runtime.mjs";
import path from "node:path";

export const MAX_TOOL_ROUNDS = 32;
const RESULT_SUMMARY_CHARS = 4000;

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
  // §5.2: pending 存在时不再硬挡——接受新消息，旧 pending 标记 superseded 并落取消记录
  const existing = await loadPendingAction(projectRoot);
  if (existing) {
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

  try {
    return await agentLoop({ ...options, turnId }, []);
  } catch (error) {
    // §3.4: 失败时写错误消息
    const errorSummary = String(error.message ?? "未知错误").slice(0, 200);
    await appendChatMessage(projectRoot, {
      role: "assistant", content: `（本轮失败：${errorSummary}，可重发）`, status: "failed", turn_id: turnId
    });
    throw error;
  }
}

export async function resumeChatTurn(options) {
  const { projectRoot, project, registry, approve, server, getTaskQueue } = options;
  const pending = await loadPendingAction(projectRoot);
  if (!pending) {
    return { reply: "没有待确认的操作。", toolEvents: [], pendingAction: null, usage: { calls: 0, cost: 0 } };
  }
  // §3.4: Write generating placeholder before agentLoop — crash during resumed turn
  // produces visible interrupted state (same pattern as runChatTurn).
  const resumeTurnId = crypto.randomUUID();
  await appendChatMessage(projectRoot, {
    role: "assistant", content: "", status: "generating", turn_id: resumeTurnId
  });
  let outcome;
  if (approve === true) {
    // §3.3 Idempotency: if already executed, skip executeTool, use cached result
    if (pending.status === "executed") {
      outcome = pending.cachedOutcome;
    } else {
      const tool = registry.get(pending.tool);
      const busy = checkRunBusy(tool, server, projectRoot);
      if (busy) {
        outcome = busy;
        await clearPendingAction(projectRoot);
      } else {
        // §3.3: Atomically mark as executing before execution
        const key = pending.idempotency_key ?? crypto.randomUUID();
        await updatePendingStatus(projectRoot, key, "executing");
        outcome = await executeTool(registry, pending.tool, pending.args, { projectRoot, project, server, getTaskQueue });
        // §3.3: Atomically mark as executed with cached result (crash recovery: next resume skips re-execution)
        await updatePendingStatus(projectRoot, key, "executed", outcome);
      }
    }
    // Clear pending before agentLoop so a new pending can be created
    await clearPendingAction(projectRoot);
  } else {
    outcome = { ok: false, error: "user_rejected", message: "用户拒绝了此操作。" };
    await clearPendingAction(projectRoot);
  }
  const toolEvent = { tool: pending.tool, ok: outcome.ok, error: outcome.ok ? null : outcome.error };
  await appendChatMessage(projectRoot, {
    role: "tool", tool: pending.tool, ok: outcome.ok,
    args: summarizeArgs(pending.args),
    result_summary: summarize(outcome.ok ? outcome.result : { error: outcome.error, message: outcome.message })
  });
  options.onEvent?.({ type: "tool_result", ...toolEvent });
  return await agentLoop({ ...options, userMessage: null, turnId: resumeTurnId }, [toolEvent]);
}

async function agentLoop(options, toolEvents) {
  const { projectRoot, project, registry, modelClient, server, getTaskQueue, onEvent, signal } = options;
  // 加载运行时配置读取 chat_max_tool_rounds
  const configLayers = await loadConfigLayers(projectRoot, project ?? {}, {});
  const effectiveConfig = configLayers.effective;
  const maxToolRounds = effectiveConfig?.chat_max_tool_rounds ?? MAX_TOOL_ROUNDS;
  let totalCost = 0;
  let calls = 0;
  for (let round = 0; round < maxToolRounds + 1; round += 1) {
    if (signal?.aborted) return await finishCancelled(projectRoot, toolEvents, calls, totalCost);
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
      if (signal?.aborted) return await finishCancelled(projectRoot, toolEvents, calls, totalCost);
      throw error;
    }
    calls += 1;
    totalCost += Number(result.costSummary?.estimatedCost ?? 0) || 0;
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
      await appendChatMessage(projectRoot, { role: "assistant", content: parsed.text, cost: totalCost || undefined });
      return { reply: parsed.text, toolEvents, pendingAction: null, usage: { calls, cost: totalCost } };
    }
    // §2.3：只算成功执行的调用（ok===true），被拒/失败不占额度
    const successfulRounds = toolEvents.filter((e) => e.ok).length;
    if (successfulRounds >= maxToolRounds) break;
    if (signal?.aborted) return await finishCancelled(projectRoot, toolEvents, calls, totalCost);

    // §2.4：处理本轮全部 tool_calls —— 顺序执行 read 类，遇到第一个 write/control 即挂 pending
    let foundWriteTool = false;
    let savedPending = null;
    for (const tc of parsed.tool_calls) {
      if (foundWriteTool) {
        // 排在 write/control 之后的工具：丢弃并注明 skipped_after_pending
        toolEvents.push({ tool: tc.tool, ok: false, error: "skipped_after_pending" });
        await appendChatMessage(projectRoot, {
          role: "tool", tool: tc.tool, ok: false,
          args: summarizeArgs(tc.args),
          result_summary: "SKIPPED: 前序操作已落待确认，此工具不执行。"
        });
        onEvent?.({ type: "tool_result", tool: tc.tool, ok: false });
        continue;
      }

      const tool = registry.get(tc.tool);
      if (!tool) {
        toolEvents.push({ tool: tc.tool, ok: false, error: "unknown_tool" });
        await appendChatMessage(projectRoot, {
          role: "tool", tool: tc.tool, ok: false,
          args: summarizeArgs(tc.args),
          result_summary: `unknown tool: ${tc.tool}`
        });
        onEvent?.({ type: "tool_result", tool: tc.tool, ok: false });
        continue;
      }

      const isRead = tool.kind === "read";
      if (!isRead) {
        foundWriteTool = true;
        // 权限预检
        const permission = checkToolPermission(tool, project?.tool_permissions ?? {}, { archived: Boolean(project?.archived_at) });
        if (!permission.allowed) {
          const outcome = { ok: false, error: "permission_denied", message: permission.message };
          toolEvents.push({ tool: tc.tool, ok: false, error: outcome.error });
          await appendChatMessage(projectRoot, { role: "tool", tool: tc.tool, ok: false, args: summarizeArgs(tc.args), result_summary: outcome.message });
          onEvent?.({ type: "tool_result", tool: tc.tool, ok: false });
          continue;
        }
        // 写作运行时写保护
        const busy = checkRunBusy(tool, server, projectRoot);
        if (busy) {
          toolEvents.push({ tool: tc.tool, ok: false, error: busy.error });
          await appendChatMessage(projectRoot, { role: "tool", tool: tc.tool, ok: false, args: summarizeArgs(tc.args), result_summary: busy.message });
          onEvent?.({ type: "tool_result", tool: tc.tool, ok: false });
          continue;
        }
        // 免确认分支
        const perms = project?.tool_permissions ?? {};
        const autoApproved = perms.yolo === true || (perms.auto_edit === true && tool.kind === "write");
        if (autoApproved) {
          const outcome = await executeTool(registry, tc.tool, tc.args, { projectRoot, project, server, getTaskQueue });
          const event = { tool: tc.tool, ok: outcome.ok, error: outcome.ok ? null : outcome.error };
          toolEvents.push(event);
          await appendChatMessage(projectRoot, {
            role: "tool", tool: tc.tool, ok: outcome.ok, auto_approved: true,
            args: summarizeArgs(tc.args),
            result_summary: summarize(outcome.ok ? outcome.result : { error: outcome.error, message: outcome.message })
          });
          onEvent?.({ type: "tool_result", ...event });
          continue; // 后续 tool_calls 被 foundWriteTool 跳过
        }
        // edit_chapter 预览
        let preview = null;
        if (tc.tool === "edit_chapter") {
          try { preview = await previewEditChapter(projectRoot, tc.args); }
          catch (error) {
            const outcome = { ok: false, error: error.code ?? "preview_failed", message: error.message };
            toolEvents.push({ tool: tc.tool, ok: false, error: outcome.error });
            await appendChatMessage(projectRoot, { role: "tool", tool: tc.tool, ok: false, args: summarizeArgs(tc.args), result_summary: outcome.message });
            onEvent?.({ type: "tool_result", tool: tc.tool, ok: false });
            continue;
          }
        }
        // 记 toolEvent（ok=true 表示预览通过，pending 状态由 pendingAction 字段指示）
        toolEvents.push({ tool: tc.tool, ok: true, error: null });
        // 挂 pending，不立即返回——等后续 tools 标记跳过后再返回
        savedPending = await savePendingAction(projectRoot, {
          tool: tc.tool, args: tc.args, preview, lead_text: parsed.leadText ?? ""
        });
        continue;
      }

      // Read 工具：立即执行并落盘
      const outcome = await executeTool(registry, tc.tool, tc.args, { projectRoot, project, server, getTaskQueue });
      const event = { tool: tc.tool, ok: outcome.ok, error: outcome.ok ? null : outcome.error };
      toolEvents.push(event);
      await appendChatMessage(projectRoot, {
        role: "tool", tool: tc.tool, ok: outcome.ok,
        args: summarizeArgs(tc.args),
        result_summary: summarize(outcome.ok ? outcome.result : { error: outcome.error, message: outcome.message })
      });
      onEvent?.({ type: "tool_result", ...event });
    }
    // 本轮全部 tool_calls 处理完毕：若写入 pending，返回等待确认；否则续下一轮
    if (savedPending) {
      const note = [parsed.leadText, `（待确认操作：${savedPending.tool}，请在确认卡上批准或取消）`].filter(Boolean).join("\n");
      await appendChatMessage(projectRoot, { role: "assistant", content: note, cost: totalCost || undefined });
      onEvent?.({ type: "pending_action", action: savedPending });
      return { reply: note, toolEvents, pendingAction: savedPending, usage: { calls, cost: totalCost } };
    }
  }
  const capped = "操作轮数达到上限，我先停在这里。请把任务拆小一点，或直接告诉我下一步。";
  await appendChatMessage(projectRoot, { role: "assistant", content: capped });
  return { reply: capped, toolEvents, pendingAction: null, usage: { calls, cost: totalCost } };
}

async function finishCancelled(projectRoot, toolEvents, calls, totalCost) {
  await appendChatMessage(projectRoot, { role: "assistant", content: "（已停止。）", cost: totalCost || undefined });
  return { reply: "（已停止。）", toolEvents, pendingAction: null, cancelled: true, usage: { calls, cost: totalCost } };
}

function latestPrompt(options, round) {
  if (round === 0 && options.userMessage) return options.userMessage;
  return "（继续：基于上面的工具结果决定下一步——继续调用工具或给出最终回答。）";
}

function summarize(value) {
  const json = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return json.length > RESULT_SUMMARY_CHARS ? `${json.slice(0, RESULT_SUMMARY_CHARS)}…` : json;
}
