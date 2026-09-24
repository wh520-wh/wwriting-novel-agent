// src/core/agent/journal-recovery.mjs
//
// journal 恢复纯函数（第二十轮 Task 19 从 journal.mjs 迁出）：从投影 state/session
// 派生恢复事件批次或判定 dangling。全部为纯函数——不触盘、不持锁、无闭包态；物理
// I/O 与恢复编排（load/appendBatchLocked）仍归 journal.mjs。
//
// 迁移纪律：事件语义、校验顺序与错误文案与 journal.mjs 原实现逐字一致；唯一的整合
// 是把两个恢复批次里逐字相同的「孤儿闭合 + 清扫」段提成 appendOrphanClosures
//（见该 helper 的参数化说明），不合并语义不同的部分。
//
// import 纪律：TERMINAL_RUN_STATUSES / COMPACTION_NON_TERMINAL_STATES 必须与
// journal.mjs 同源，取自 ./journal-handlers.mjs（Set 语义，用 .has）。compaction.mjs
// 的同名导出是冻结数组（.includes 语义）且引入它会卷入 compaction 依赖链——不用。
import {
  TERMINAL_RUN_STATUSES,
  COMPACTION_NON_TERMINAL_STATES
} from "./journal-handlers.mjs";

// 压缩恢复尚未完成（Run 处于压缩收敛安全点，无 dangling assistant 活动）：
//   - 非终态压缩（started/running/cancelling）：压缩调用在途；
//   - 终态 failed/cancelled 但仍有 pending_input_id：崩溃窗口——failed/cancelled
//     事件已落盘而 Run/input 收敛（waiting_user / input_cancelled + run_cancelled）
//     尚未追加。这两种情况下 Run 都只可能在发送前预检安全点，不存在未闭合
//     model turn/tool call，保守中断不适用；收敛交给 runtime 的 open()。
export function hasPendingCompactionRecovery(session) {
  const compaction = session?.compaction;
  if (compaction == null) return false;
  if (COMPACTION_NON_TERMINAL_STATES.has(compaction.state)) return true;
  if ((compaction.state === "failed" || compaction.state === "cancelled") && compaction.pending_input_id != null) {
    // 第十二轮 F3（审核修订 P1-2）：崩溃窗口 = failed/cancelled 已落盘而 Run/input
    // 收敛未落盘，窗口未收敛的判据是 run 仍 running。open() 把 run 收敛为
    // waiting_user / interrupted 后，恢复链必须重新可用——否则每个 load 重放都跳过
    // 锚定保守中断与 priority 恢复（永真锚定：前端项永久 running，detectDangling 永真）。
    if (session.active_run?.status === "running") return true;
  }
  return false;
}

// 两个恢复批次共享的「孤儿活动闭合 + 不可恢复状态清扫」段（第二十轮 Task 19 整合）：
// dangling 与 priority 批次里逐字相同（或仅取参数不同）的四段——
//   1. tool_call_failed    —— error.code 参数化（orphanCode：recovered_dangling_orphan
//                             / recovered_priority_orphan），其余字段逐字相同；
//   2. model_turn_completed—— input_id 参数化（turnInputId：dangling 侧
//                             run.active_input_id，priority 侧 run.active_input_id
//                             ?? priorityId），其余字段逐字相同；
//   3. permission_grant_cleared —— 逐字相同；
//   4. decision_resolved        —— 逐字相同。
// 调用方传入自己的 batch 后自行追加各自的收敛尾巴（dangling：run_interrupted；
// priority：input_interrupted + input_started）。绝不合并语义不同的部分。
function appendOrphanClosures(batch, run, state, { orphanCode, turnInputId }) {
  // 第十二轮 F2：恢复批次必须闭合孤儿活动，否则前端项永久 running、
  // detectDangling 永真（每次 load 重复追补）。state.openToolCalls 值是
  // { seq, activity_id, name }。
  for (const [toolCallId, meta] of state.openToolCalls) {
    batch.push({
      type: "tool_call_failed",
      run_id: run.id,
      payload: {
        tool_call_id: toolCallId,
        activity_id: meta.activity_id ?? null,           // 规格 F2：前端按此匹配工具行
        name: meta.name ?? "unknown",                    // 规格 F2：前端 label 依据
        message: "进程崩溃恢复：该工具调用未完成（已按失败闭合）", // 规格 F2：可见文案
        error: { code: orphanCode }
      }
    });
  }
  for (const [turnId] of state.openModelTurns) {
    // 地雷防御（第十二轮顺手修补，review 遗留）：reducer 对 model_turn_completed
    // 的 input_id 是 requireString，turnInputId 为 null（理论退化——现代 producer 下
    // 开放 turn 必有归属输入，仅 input_interrupted 后崩溃的遗留日志可构造）时不能
    // 填 null/undefined（dry-run 拒绝、整个 load 抛错）；跳过闭合让 run_interrupted
    // 收敛即可。残余 open turn 的归宿分路径：锚定路径被清扫（下次 load 以锚点投影
    // + 空 side 开始，残余不复存在）；全量重放路径残余会被完整重建，但 run 已遭
    // 终结（interrupted），detectDangling 对终态 Run 短路，恢复链不再触发——无害。
    // 两侧策略互通（review Minor-3，改一侧必须知会另一侧）：dangling 侧传
    // turnInputId = run.active_input_id（null 时跳过闭合）；priority 侧传
    // turnInputId = run.active_input_id ?? priorityId（恒非空，故补闭合而非跳过）——
    // 两侧都只为防 requireString 抛错，一侧留残余、一侧给回退。
    if (turnInputId == null) continue;
    batch.push({
      type: "model_turn_completed",
      run_id: run.id,
      payload: { turn_id: turnId, input_id: turnInputId, outcome: "failed" }
    });
  }
  for (const grant of run.active_grants ?? []) {
    batch.push({
      type: "permission_grant_cleared",
      run_id: run.id,
      payload: { input_id: grant.input_id, grant_key: grant.grant_key, grant_id: grant.id }
    });
  }
  for (const decisionId of state.openDecisions.keys()) {
    batch.push({
      type: "decision_resolved",
      run_id: run.id,
      payload: { decision_id: decisionId, choice: "cancelled", reason: "recovery_dangling_decision" }
    });
  }
}

// dangling assistant 恢复批次：清空不可恢复 grant、闭合遗留 decision、标记
// run_interrupted（全量重放检测到 dangling 与锚定重放保守中断共用）。
export function buildDanglingRecoveryBatch(state) {
  const run = state.session.active_run;
  if (!run) return [];
  const batch = [];
  appendOrphanClosures(batch, run, state, {
    orphanCode: "recovered_dangling_orphan",
    turnInputId: run.active_input_id
  });
  batch.push({
    type: "run_interrupted",
    run_id: run.id,
    payload: { reason: "recovery_dangling_assistant_activity" }
  });
  return batch;
}

// Task 6：优先输入恢复批次（SPEC 3.3 rule 10）。priority_input_id pending 且
// 全量重放（side 状态完整、无真实飞行操作）时用一个 appendBatch 收敛：
//   1. 先闭合孤儿 model turn / tool call 为恢复错误（tool_call_failed /
//      model_turn_completed(failed)），不重放已完成副作用；
//   2. 清除不可恢复 grant、闭合遗留 decision（与 dangling 恢复一致）；
//   3. 若旧输入仍活动，追加 input_interrupted(reason:"recovered_priority")；
//   4. 追加 input_started(priorityId)（匹配 priority 时 reducer 自动清空
//      priority_input_id）。
// 队列相对顺序不变：只移除被 started 的优先输入，其余排队项原位保留。
// 返回空数组表示无需恢复（无 Run/已终结/priority 已落地/优先输入已活动等）。
export function buildPriorityRecoveryBatch(state) {
  const run = state.session.active_run;
  if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return [];
  const priorityId = state.session.priority_input_id;
  if (priorityId == null) return [];
  if (run.active_input_id === priorityId) return []; // 已是活动输入，无需收敛
  if (!state.session.queued_inputs.some((item) => item.id === priorityId)) return [];
  const batch = [];
  appendOrphanClosures(batch, run, state, {
    orphanCode: "recovered_priority_orphan",
    turnInputId: run.active_input_id ?? priorityId
  });
  if (run.active_input_id != null) {
    batch.push({
      type: "input_interrupted",
      run_id: run.id,
      payload: { input_id: run.active_input_id, reason: "recovered_priority" }
    });
  }
  batch.push({ type: "input_started", run_id: run.id, payload: { input_id: priorityId } });
  return batch;
}

// dangling assistant 活动：非终结 Run 上存在未闭合 model turn（v2 按 turn_id、
// v1 按 legacy 栈）或 tool call。
export function detectDangling(current) {
  const run = current.session.active_run;
  if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return null;
  if (current.openModelTurns.size > 0 || current.legacyOpenTurns.length > 0 || current.openToolCalls.size > 0) {
    return run;
  }
  return null;
}
