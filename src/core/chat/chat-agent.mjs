// 对话 agent 主循环：解析模型回复 -> 读工具自动执行 -> 写/控制类工具先预览后挂 pending
// 续轮由 resumeChatTurn 接管；maxToolRounds 防止失控空转。
import { buildChatContext } from "./chat-context.mjs";
import { parseAgentReply } from "./agent-protocol.mjs";
import { executeTool, checkToolPermission, summarizeArgs } from "./tool-registry.mjs";
import { previewEditChapter } from "./tools-write.mjs";
import { appendChatMessage, loadPendingAction, savePendingAction, clearPendingAction } from "./chat-store.mjs";

export const MAX_TOOL_ROUNDS = 8;
const RESULT_SUMMARY_CHARS = 500;

export async function runChatTurn(options) {
  const { projectRoot, userMessage } = options;
  const existing = await loadPendingAction(projectRoot);
  if (existing) {
    return {
      reply: "还有一个待确认操作没处理（见确认卡）。请先确认或取消，再发新消息。",
      toolEvents: [], pendingAction: existing, usage: { calls: 0, cost: 0 }
    };
  }
  await appendChatMessage(projectRoot, { role: "user", content: String(userMessage ?? "") });
  return await agentLoop(options, []);
}

export async function resumeChatTurn(options) {
  const { projectRoot, project, registry, approve, server, getTaskQueue } = options;
  const pending = await loadPendingAction(projectRoot);
  if (!pending) {
    return { reply: "没有待确认的操作。", toolEvents: [], pendingAction: null, usage: { calls: 0, cost: 0 } };
  }
  let outcome;
  if (approve === true) {
    outcome = await executeTool(registry, pending.tool, pending.args, { projectRoot, project, server, getTaskQueue });
  } else {
    outcome = { ok: false, error: "user_rejected", message: "用户拒绝了此操作。" };
  }
  await clearPendingAction(projectRoot);
  const toolEvent = { tool: pending.tool, ok: outcome.ok, error: outcome.ok ? null : outcome.error };
  await appendChatMessage(projectRoot, {
    role: "tool", tool: pending.tool, ok: outcome.ok,
    args: summarizeArgs(pending.args),
    result_summary: summarize(outcome.ok ? outcome.result : { error: outcome.error, message: outcome.message })
  });
  options.onEvent?.({ type: "tool_result", ...toolEvent });
  return await agentLoop({ ...options, userMessage: null }, [toolEvent]);
}

async function agentLoop(options, toolEvents) {
  const { projectRoot, project, registry, modelClient, server, getTaskQueue, onEvent } = options;
  let totalCost = 0;
  let calls = 0;
  for (let round = 0; round < MAX_TOOL_ROUNDS + 1; round += 1) {
    const { messages } = await buildChatContext({ projectRoot, project, registry, userMessage: latestPrompt(options, round) });
    const result = await modelClient.generate({
      project, stage: "chat", messages, metadata: { chat: true, round }
    });
    calls += 1;
    totalCost += Number(result.costSummary?.estimatedCost ?? 0) || 0;
    const parsed = parseAgentReply(result.text);
    if (parsed.type === "text") {
      await appendChatMessage(projectRoot, { role: "assistant", content: parsed.text, cost: totalCost || undefined });
      return { reply: parsed.text, toolEvents, pendingAction: null, usage: { calls, cost: totalCost } };
    }
    if (toolEvents.length >= MAX_TOOL_ROUNDS) break;
    const tool = registry.get(parsed.call.tool);
    const isRead = tool?.kind === "read";
    if (tool && !isRead) {
      // 权限预检：落 pending 之前先检查，避免 read_only 项目白白占确认位
      const permission = checkToolPermission(tool, project?.tool_permissions ?? {}, { archived: Boolean(project?.archived_at) });
      if (!permission.allowed) {
        const outcome = { ok: false, error: "permission_denied", message: permission.message };
        toolEvents.push({ tool: parsed.call.tool, ok: false, error: outcome.error });
        await appendChatMessage(projectRoot, { role: "tool", tool: parsed.call.tool, ok: false, args: summarizeArgs(parsed.call.args), result_summary: outcome.message });
        onEvent?.({ type: "tool_result", tool: parsed.call.tool, ok: false });
        continue;
      }
      // 免确认分支：yolo 放开 write+control；auto_edit 仅放开 write。免「确认」不免「校验」——直接走 executeTool 原链。
      const perms = project?.tool_permissions ?? {};
      const autoApproved = perms.yolo === true || (perms.auto_edit === true && tool.kind === "write");
      if (autoApproved) {
        const outcome = await executeTool(registry, parsed.call.tool, parsed.call.args, { projectRoot, project, server, getTaskQueue });
        const event = { tool: parsed.call.tool, ok: outcome.ok, error: outcome.ok ? null : outcome.error };
        toolEvents.push(event);
        await appendChatMessage(projectRoot, {
          role: "tool", tool: parsed.call.tool, ok: outcome.ok, auto_approved: true,
          args: summarizeArgs(parsed.call.args),
          result_summary: summarize(outcome.ok ? outcome.result : { error: outcome.error, message: outcome.message })
        });
        onEvent?.({ type: "tool_result", ...event });
        continue; // 回 loop 让模型看到结果继续
      }
      let preview = null;
      if (parsed.call.tool === "edit_chapter") {
        try { preview = await previewEditChapter(projectRoot, parsed.call.args); }
        catch (error) {
          const outcome = { ok: false, error: error.code ?? "preview_failed", message: error.message };
          toolEvents.push({ tool: parsed.call.tool, ok: false, error: outcome.error });
          await appendChatMessage(projectRoot, { role: "tool", tool: parsed.call.tool, ok: false, args: summarizeArgs(parsed.call.args), result_summary: outcome.message });
          onEvent?.({ type: "tool_result", tool: parsed.call.tool, ok: false });
          continue;
        }
      }
      const pending = await savePendingAction(projectRoot, {
        tool: parsed.call.tool, args: parsed.call.args, preview, lead_text: parsed.leadText ?? ""
      });
      const note = [parsed.leadText, `（待确认操作：${parsed.call.tool}，请在确认卡上批准或取消）`].filter(Boolean).join("\n");
      await appendChatMessage(projectRoot, { role: "assistant", content: note, cost: totalCost || undefined });
      onEvent?.({ type: "pending_action", action: pending });
      return { reply: note, toolEvents, pendingAction: pending, usage: { calls, cost: totalCost } };
    }
    const outcome = await executeTool(registry, parsed.call.tool, parsed.call.args, { projectRoot, project, server, getTaskQueue });
    const event = { tool: parsed.call.tool, ok: outcome.ok, error: outcome.ok ? null : outcome.error };
    toolEvents.push(event);
    await appendChatMessage(projectRoot, {
      role: "tool", tool: parsed.call.tool, ok: outcome.ok,
      args: summarizeArgs(parsed.call.args),
      result_summary: summarize(outcome.ok ? outcome.result : { error: outcome.error, message: outcome.message })
    });
    onEvent?.({ type: "tool_result", ...event });
  }
  const capped = "操作轮数达到上限，我先停在这里。请把任务拆小一点，或直接告诉我下一步。";
  await appendChatMessage(projectRoot, { role: "assistant", content: capped });
  return { reply: capped, toolEvents, pendingAction: null, usage: { calls, cost: totalCost } };
}

function latestPrompt(options, round) {
  if (round === 0 && options.userMessage) return options.userMessage;
  return "（继续：基于上面的工具结果决定下一步——继续调用工具或给出最终回答。）";
}

function summarize(value) {
  const json = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return json.length > RESULT_SUMMARY_CHARS ? `${json.slice(0, RESULT_SUMMARY_CHARS)}…` : json;
}
