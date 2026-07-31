// src/core/agent-loop.mjs
// 通用 Agent turn 循环：模型响应 → 工具执行 → 下一轮。
// 领域无关：何时停、下一轮用什么工具集，全部由回调决定。

export async function runAgentLoop({
  callModel,
  executeTool,
  prepareNextTurn = null,
  shouldStopAfterTurn = null,
  emitEvent = async () => {},
  signal = undefined,
  maxTurns = 24,
  context = {},
} = {}) {
  const ctx = { turn: 0, allowedTools: [], feedback: null, steering: [], ...context };
  let lastResult = null;

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    if (signal?.aborted) {
      return { outcome: "aborted", turns: turn - 1, lastResult };
    }
    ctx.turn = turn;
    if (prepareNextTurn) {
      await prepareNextTurn(ctx);
    }

    await emitEvent("turn_start", { turn });
    const output = await callModel(ctx);

    await emitEvent("tool_execution_start", { turn, tool: output?.tool ?? null });
    lastResult = await executeTool(output, ctx);
    await emitEvent("tool_execution_end", {
      turn,
      tool: output?.tool ?? null,
      ok: lastResult?.ok !== false,
    });

    const stop = shouldStopAfterTurn
      ? await shouldStopAfterTurn(ctx, lastResult)
      : { stop: Boolean(lastResult?.committed) };
    await emitEvent("turn_end", { turn, stop: stop?.stop ? stop.reason ?? "stopped" : null });

    if (stop?.stop) {
      return {
        outcome: stop.outcome ?? "completed",
        reason: stop.reason,
        turns: turn,
        lastResult: stop.result !== undefined ? stop.result : lastResult?.result,
      };
    }
  }

  return { outcome: "exhausted", turns: maxTurns, lastResult };
}
