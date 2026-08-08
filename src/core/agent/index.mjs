// src/core/agent/index.mjs —— ProjectAgent 唯一公共接口（计划 Rule 3）。
//
// 生产代码（HTTP route、脚本、acceptance test）只能从本文件导入 Agent 能力。
// 本文件只做依赖组装与公共接口导出（薄）；模型/工具循环、队列、中断、停止与
// 重试全部在 runtime.mjs 内部实现，不得被外部调用方 import。
//
// 公共接口（固定）：
//   const agent = createProjectAgent(dependencies);  // { modelGateway, shell?, secrets?,
//                                                     //   skills?, agentStorageRootFor?, workspaceMigrator? }
//   await agent.open({ projectRoot });
//   await agent.submit({ projectRoot, text, source });   // source ∈ {"chat","maintenance"}
//   await agent.promote({ projectRoot, inputId });
//   await agent.decide({ projectRoot, decisionId, choice });
//   await agent.stop({ projectRoot, reason: "user_stop" });
//   await agent.retry({ projectRoot, runId });
//   await agent.snapshot({ projectRoot, afterSeq, limit }); // -> { session, events }
//   // Task 5：尾部分页（tail/beforeSeq）、历史导出与不可逆清空
//   for await (const line of agent.exportHistory({ projectRoot })); // -> { stream, record }
//   await agent.clearHistory({ projectRoot, confirmIrreversible }); // -> { session_id, status, ... }
import { createAgentRuntime } from "./runtime.mjs";

export function createProjectAgent(dependencies = {}) {
  const runtime = createAgentRuntime(dependencies);
  return {
    open: (params) => runtime.open(params),
    submit: (params) => runtime.submit(params),
    promote: (params) => runtime.promote(params),
    decide: (params) => runtime.decide(params),
    stop: (params) => runtime.stop(params),
    retry: (params) => runtime.retry(params),
    snapshot: (params) => runtime.snapshot(params),
    exportHistory: (params) => runtime.exportHistory(params),
    clearHistory: (params) => runtime.clearHistory(params)
  };
}
