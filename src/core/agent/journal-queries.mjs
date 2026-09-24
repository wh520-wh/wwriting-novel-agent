// src/core/agent/journal-queries.mjs
//
// journal 投影查询（第二十轮 Task 19 从 journal.mjs 迁出；原为内核分区重构 Task 3，
// F2）。四条全量扫描查询只在停止/重试/压缩边界触发（非每 token 热路径），不做投影
// 索引。
//
// 尾窗口纪律（whfind-bugs #1）：四条必须走注入的 readTail 尾部窗口，绝不用
// read({ afterSeq: 0 }) 头部窗口——segments 从 0 号段顺序取，事件超 10 万后
// findInputMeta 找不到新输入 → run-lifecycle 把每个活动输入立即 input_interrupted，
// 会话永久卡死。本模块不持有 store/锁：readTail 由 journal.mjs 注入（已含 mutex 与
// 初始化），故本模块只依赖注入的只读能力。
//
// 迁移纪律：四条主体与 journal.mjs 原实现逐字一致。
export function createJournalQueries({ readTail }) {
  // 该输入当前是否尚无终态事件（需要追加 input_completed）。逆序扫描最近
  // 100k 条事件（原 runtime.mjs needsCompletionTerminal 主体逐字迁入；readTail
  // 尾部窗口——whfind-bugs #1：read({afterSeq:0}) 是最旧窗口）：
  // 命中 input_consumed/cancelled/completed/interrupted/withdrawn 返回 false
  //（该输入已有终态事件）；命中 input_promoted/run_started/input_started 返回
  // true；超出上限视为需要收敛（保守方向）。
  async function hasTerminalEvent(runId, inputId) {
    const { events } = await readTail({ limit: 100000 });
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event.run_id !== runId || event.payload?.input_id !== inputId) continue;
      if (
        event.type === "input_consumed" ||
        event.type === "input_cancelled" ||
        event.type === "input_completed" ||
        event.type === "input_interrupted" ||
        event.type === "input_withdrawn"
      ) {
        return false; // 该输入已有终态事件（legacy consumed 或任意新终态）
      }
      if (event.type === "input_promoted" || event.type === "run_started" || event.type === "input_started") return true;
    }
    return true;
  }

  // 从 journal 事件找回输入元数据（text + kind）。逆序扫描最近 100k 条事件
  //（原 runtime.mjs findInputMeta 主体逐字迁入）：命中 input_queued 且
  // input_id 匹配即返回；超出上限视为找不到（返回 text: null）。
  async function findInputMeta(inputId) {
    const { events } = await readTail({ limit: 100000 });
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event.type === "input_queued" && event.payload?.input_id === inputId) {
        return {
          text: typeof event.payload.text === "string" ? event.payload.text : null,
          kind: event.payload.kind === "compact" ? "compact" : null
        };
      }
    }
    return { text: null, kind: null };
  }

  // 该 Run 是否为 /compact 输入而创建（空闲发起）还是运行中排队（in-run）。
  // 决定手动压缩失败/取消后的收敛：in-run 恢复 resume_run_status("running")，
  // 空闲发起则 run_cancelled → idle。
  // Task 9：新生命周期下 run_started 不再携带 input_id，改为以该 Run 的第一条
  // input_started 判定（空闲发起 = Run 首个被激活输入就是 compact item）；legacy
  // 日志（retry 的 run_started 仍带 input_id）保留原判定分支。
  async function isIdleInitiatedRun(runId, compactInputId) {
    const { events } = await readTail({ limit: 100000 });
    for (const event of events) {
      if (event.type === "input_started" && event.run_id === runId) {
        return event.payload?.input_id === compactInputId;
      }
    }
    for (const event of events) {
      if (event.type !== "run_started" || event.run_id !== runId) continue;
      return event.payload?.input_id === compactInputId;
    }
    return true;
  }

  // 从 journal 事件找回可恢复 Run 的未终结输入（run_failed 记录了 input_id；
  // 崩溃恢复的 run_interrupted 没有，则退回 run_started/input_promoted 的信息）。
  async function findTerminalInputId(runId) {
    const { events } = await readTail({ limit: 100000 });
    const runEvents = events.filter((event) => event.run_id === runId);
    for (let i = runEvents.length - 1; i >= 0; i -= 1) {
      const event = runEvents[i];
      if (event.type === "run_failed" || event.type === "run_interrupted") {
        if (typeof event.payload?.input_id === "string" && event.payload.input_id.length > 0) {
          return event.payload.input_id;
        }
        break;
      }
      if (event.type === "input_promoted" && typeof event.payload?.input_id === "string") {
        return event.payload.input_id;
      }
      if (event.type === "input_started" && typeof event.payload?.input_id === "string") {
        return event.payload.input_id;
      }
      if (event.type === "run_started" && typeof event.payload?.input_id === "string") {
        return event.payload.input_id;
      }
    }
    // 兜底：崩溃现场尚未终结的 input（事件里存在 input_queued 且无终态事件）。
    // Task 9：终态集合同时接纳新生命周期事件（input_completed/input_interrupted/
    // input_withdrawn）与 legacy（input_consumed/input_cancelled）。
    const terminal = new Set(
      runEvents
        .filter((event) =>
          [
            "input_consumed",
            "input_cancelled",
            "input_completed",
            "input_interrupted",
            "input_withdrawn"
          ].includes(event.type)
        )
        .map((event) => event.payload?.input_id)
    );
    const openInputs = runEvents
      .filter((event) => event.type === "input_queued" && !terminal.has(event.payload?.input_id))
      .map((event) => event.payload?.input_id);
    return openInputs.length > 0 ? openInputs[openInputs.length - 1] : null;
  }

  return { hasTerminalEvent, findInputMeta, isIdleInitiatedRun, findTerminalInputId };
}
