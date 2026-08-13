// src/core/agent/index.mjs —— ProjectAgent 唯一公共接口（计划 Rule 3）。
//
// 生产代码（HTTP route、脚本、acceptance test）只能从本文件导入 Agent 能力。
// 本文件只做依赖组装与公共接口导出（薄）；模型/工具循环、队列、中断、停止与
// 重试全部在 runtime.mjs 内部实现，不得被外部调用方 import。
//
// 公共接口（固定）：
//   const agent = createProjectAgent(dependencies);  // { modelGateway, shell?, secrets?,
//                                                     //   skills?, agentStorageRootFor? }
//   await agent.open({ projectRoot });
//   await agent.submit({ projectRoot, text, source });   // source ∈ {"chat","maintenance"}
//   await agent.promote({ projectRoot, inputId });
//   await agent.requestPriority({ projectRoot, inputId });  // Task 9/10：请求优先（priority_input_requested，安全点切换）
//   await agent.withdrawInput({ projectRoot, inputId });    // Task 9：撤回排队输入（input_withdrawn）
//   await agent.decide({ projectRoot, decisionId, choice });
//   await agent.stop({ projectRoot, runId?, reason: "user_stop" }); // Task 9：runId 可选，显式时精确匹配活动 Run
//   await agent.retry({ projectRoot, runId });
//   // Task 8：压缩重试/取消（ESC、按钮与 HTTP 都调用同一取消方法）
//   await agent.retryCompaction({ projectRoot, compactionId });
//   await agent.cancelCompaction({ projectRoot, compactionId });
//   await agent.snapshot({ projectRoot, afterSeq, limit }); // -> { session, events }
//   // Task 5：尾部分页（tail/beforeSeq）、历史导出与不可逆清空
//   for await (const line of agent.exportHistory({ projectRoot })); // -> { stream, record }
//   await agent.clearHistory({ projectRoot, confirmIrreversible }); // -> { session_id, status, ... }
//   // Task 4：多会话管理（sessionId 缺省 = 最近活跃；品牌新项目 = 空/惰性创建）
//   await agent.sessions({ projectRoot });       // -> { sessions: SessionMeta[], active_session_id }
//   await agent.newSession({ projectRoot, title });           // -> SessionMeta
//   await agent.renameSession({ projectRoot, sessionId, title });
//   await agent.archiveSession({ projectRoot, sessionId });
//   await agent.restoreSession({ projectRoot, sessionId });
//   await agent.deleteSession({ projectRoot, sessionId });    // 永久删除（元数据 + 数据目录）
//   // 其余方法（open/submit/promote/requestPriority/withdrawInput/decide/stop/retry/
//   // retryCompaction/cancelCompaction/snapshot/exportHistory/clearHistory）均可选传
//   // sessionId。
import { createAgentRuntime } from "./runtime.mjs";

export function createProjectAgent(dependencies = {}) {
  const runtime = createAgentRuntime(dependencies);
  return {
    open: (params) => runtime.open(params),
    submit: (params) => runtime.submit(params),
    promote: (params) => runtime.promote(params),
    requestPriority: (params) => runtime.requestPriority(params),
    withdrawInput: (params) => runtime.withdrawInput(params),
    decide: (params) => runtime.decide(params),
    stop: (params) => runtime.stop(params),
    retry: (params) => runtime.retry(params),
    retryCompaction: (params) => runtime.retryCompaction(params),
    cancelCompaction: (params) => runtime.cancelCompaction(params),
    snapshot: (params) => runtime.snapshot(params),
    exportHistory: (params) => runtime.exportHistory(params),
    clearHistory: (params) => runtime.clearHistory(params),
    sessions: (params) => runtime.sessions(params),
    newSession: (params) => runtime.newSession(params),
    renameSession: (params) => runtime.renameSession(params),
    archiveSession: (params) => runtime.archiveSession(params),
    restoreSession: (params) => runtime.restoreSession(params),
    deleteSession: (params) => runtime.deleteSession(params)
  };
}
