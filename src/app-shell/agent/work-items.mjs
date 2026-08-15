// src/app-shell/agent/work-items.mjs —— 把 journal 事件纯投影为有序工作组/子工作。
//
// Task 5 只做状态纯投影；DOM 渲染（Task 6）只读本模块导出的 group/items 与辅助
// 函数。reduceWorkEvent() 只接受 event，不读取 DOM：runId 取自 event.run_id，
// 相对路径计算只用 event.project_root（journal 盖章字段），不依赖外部状态。
//
// 冻结契约（计划 §2.4，逐字段）：
//   { id: "reasoning:<turn_id>" | "tool:<activity_id>" | "plan:<run_id>",
//     runId, kind: "reasoning"|"tool"|"plan", firstSeq, sortSeq,
//     state: "running"|"waiting"|"completed"|"failed"|"cancelled", label, detail }
//
// 排序语义：reasoning/tool 的 firstSeq == sortSeq == 开始事件 seq，完成事件不
// 移动位置；plan 的 firstSeq 保持首次出现位置，sortSeq 每次 plan_updated 更新
// （旧位置消失、同一项移动到最新位置）。
//
// 工作组（本模块自有形状，不在冻结契约内）：{ id(=runId), status, expanded,
// firstSeq, sortSeq, items: Map, legacyOpenTurns }。expanded 是投影给出的展开
// 默认值（用户可在 DOM 侧覆盖），见 groupExpandedDefault。
//
// 本模块是浏览器模块（app-shell 页面直接 import）：不得依赖 node: 内建。
// 相对路径投影需要的最小路径判定（isAbsolutePath / relativePath）内联在本文件。

// 浏览器安全路径判定：Windows 盘符（C:\）与 POSIX 根（/、\）视为绝对路径。
function isAbsolutePath(target) {
  return /^[A-Za-z]:[\\/]/u.test(target) || target.startsWith("/") || target.startsWith("\\");
}

// projectRoot → target 的相对路径（两者统一为正斜杠后按段比较；越出根的部分
// 用 ../ 表示，跨盘/绝对结果由调用方丢弃）。语义对齐 node:path.relative 在
// work-items 场景下需要的行为。
function relativePath(from, to) {
  const fromParts = String(from).replace(/\\/g, "/").replace(/\/+$/u, "").split("/");
  const toParts = String(to).replace(/\\/g, "/").split("/");
  let i = 0;
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i += 1;
  if (i === fromParts.length && i === toParts.length) return "";
  const segments = [];
  for (let up = fromParts.length - i; up > 0; up -= 1) segments.push("..");
  return segments.concat(toParts.slice(i)).join("/");
}

export function createWorkState() {
  return { groups: new Map(), turnToRun: new Map(), activityToRun: new Map() };
}

export function orderedWorkItems(group) {
  return [...group.items.values()].sort((a, b) => a.sortSeq - b.sortSeq || a.firstSeq - b.firstSeq);
}

export function openWorkItemIds(group) {
  // 停止始终静态（计划 Task 6 Step 7 rule 5）：waiting_user 与终态之外的 stopping
  // 也压制 live item——停止窗口内 running 标签不得继续闪烁。
  if (["waiting_user", "completed", "failed", "cancelled", "interrupted", "stopping"].includes(group.status)) return [];
  return orderedWorkItems(group).filter((item) => item.state === "running").map((item) => item.id);
}

export function visibleLiveTargets(group, { expanded }) {
  const open = openWorkItemIds(group);
  if (open.length === 0) return [];
  return expanded ? open : [`group:${group.id}`];
}

// ---------------------------------------------------------------------------
// 文案投影（Task 5 Step 3/Step 4）
// ---------------------------------------------------------------------------

// 取消类工具错误码（本文件私有常量，与 tools.mjs 的 emitToolCancelled 路径
// tool_cancelled / shell_cancelled 保持一致）：这些错误表示活动被停止/作废
//（用户停止、决策取消、信号中止），不是执行失败，终态标记为 cancelled（"已停止"）。
const CANCELLED_ERROR_CODES = new Set(["tool_cancelled", "shell_cancelled"]);

// 工具输出保留尾部窗口（与旧 state.js MAX_ACTIVITY_OUTPUT_CHARS 一致：64 KiB）。
// Task 2：工具项输出累计超出上限时保留尾部并置 truncated=true，供视图提示截断。
const MAX_TOOL_OUTPUT_CHARS = 64 * 1024;

// 工具基名（沿用旧 view ACTIVITY_LABELS 的短文案；无映射时以"调用 <name>"兜底）。
const TOOL_BASE_LABELS = {
  read_file: "读取文件",
  write_file: "写入文件",
  edit_file: "修改文件",
  shell: "运行命令",
  list_files: "查看文件列表",
  search_files: "搜索文件",
  update_plan: "更新任务计划",
  append_chapter_segment: "写入章节内容",
  commit_chapter: "提交章节"
};

// 工具标签按状态生成（Task 5 Step 3 冻结文案）：
//   正在读取文件 / 已读取文件 / 读取文件失败 / 已停止读取文件
export function toolLabel(tool, state) {
  const base = TOOL_BASE_LABELS[tool] ?? `调用 ${tool ?? ""}`;
  switch (state) {
    case "running": return `正在${base}`;
    case "completed": return `已${base}`;
    case "failed": return `${base}失败`;
    case "cancelled": return `已停止${base}`;
    case "waiting": return "等待确认";
    default: return base;
  }
}

// reasoning 标签默认值（运行中/终态；Task 6 负责 ticker 与 detail 文案，
// 这里只把 item 形状和默认 label 备好）。
// AICSS thinking-reasoning：完成标签「思考 N 秒」——N 取该 turn 真实耗时
//（model_turn_started → reasoning_completed 事件时间戳差，秒四舍五入、最小 1）；
// 无时间戳可算（或时钟倒挂）时回退「已完成思考」。
export function reasoningLabel(item) {
  if (!item || item.state !== "completed") return "思考中";
  // thinking_ms 为 null（未算出/无时间戳）视为无效 → 回退；显式 0 是合法真实耗时 → 显示最小 1 秒
  if (item?.thinking_ms == null) return "已完成思考";
  const ms = Number(item?.thinking_ms);
  if (!Number.isFinite(ms) || ms < 0) return "已完成思考";
  return `思考 ${Math.max(1, Math.round(ms / 1000))} 秒`;
}

export const PLAN_LABEL = "任务计划";

// 工作组状态文案（Task 5 Step 4）：运行中显示"工作中"；waiting_user 显示"待命"
//（与 session-sidebar.mjs 的 RUN_STATUS_LABELS 口径统一，等待用户决策≠工作中）；
// 终态按组状态给耗时文案。每组的耗时来自组自身投影的冻结时钟（Task 15 修复）：
// 不再读当前 active run 的 active_elapsed_ms —— 第二个 Run 开始后旧组的终态文案
// 不再被新 Run 的时钟覆盖。
export function formatDuration(ms) {
  // Task 24 统一工作计时格式：负数/NaN 归零，毫秒向下取整，尾零不省略。
  // 运行态（view.js 每秒 setInterval）与终态（groupStatusText）都走本函数。
  if (!Number.isFinite(ms) || ms < 0) return "0 秒";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} 分 ${totalSeconds % 60} 秒`;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours} 小时 ${totalMinutes % 60} 分 ${totalSeconds % 60} 秒`;
}

export function groupStatusText(group) {
  // 终态使用冻结的 elapsedMs；未冻结时回落累计 activeMs（不应发生）
  const elapsed = Number.isFinite(group?.elapsedMs) ? group.elapsedMs : (group?.activeMs ?? 0);
  const seconds = formatDuration(elapsed);
  switch (group.status) {
    case "completed": return `工作了 ${seconds}`;
    case "failed": return `工作了 ${seconds} · 失败`;
    case "cancelled": return `工作了 ${seconds} · 已停止`;
    // Task 11：实际被截断的执行组显示英文固定文案（与工具跳过错误同文案，
    // SPEC 3.3 rule 8）；不伪装耗时叙事。
    case "interrupted": return "Interrupted by the user";
    case "waiting_user": return "待命";
    default: return "工作中";
  }
}

// 展开默认值：运行中 expanded=true；completed 自动折叠；
// failed/cancelled/interrupted/waiting_user 保持展开。
function groupExpandedDefault(status) {
  return status !== "completed";
}

// ---------------------------------------------------------------------------
// 相对路径投影（Task 5 Step 3）
// ---------------------------------------------------------------------------

// 折叠摘要只用项目相对路径；详细区保留绝对路径/参数（item.target/args）。
// 事件里的 args/action 已经 journal 侧脱敏（redactJsonValue），target 本身安全，
// 无法确定相对路径时不伪造，回退到安全脱敏后的 target。
function toolTarget(args, action) {
  const a = args && typeof args === "object" ? args : {};
  if (typeof a.path === "string" && a.path.length > 0) return a.path;
  if (typeof a.target === "string" && a.target.length > 0) return a.target;
  const targets = Array.isArray(a.targets) ? a.targets : (action?.targets ?? null);
  if (Array.isArray(targets) && typeof targets[0] === "string" && targets[0].length > 0) return targets[0];
  return null;
}

export function relativeProjectPath(target, projectRoot) {
  if (typeof target !== "string" || target.length === 0) return null;
  if (typeof projectRoot !== "string" || projectRoot.length === 0) return null;
  try {
    if (!isAbsolutePath(target)) {
      // 目标本身已是相对路径（args.path 常见用法）：只排除 ../ 穿越项目根的写法
      const normalized = target.replace(/\\/g, "/");
      return normalized.startsWith("..") ? null : normalized;
    }
    const rel = relativePath(projectRoot, target);
    if (rel === "") return null;
    if (!rel.startsWith("..") && !isAbsolutePath(rel)) return rel.replace(/\\/g, "/");
  } catch {
    // 非法路径不伪造
  }
  return null;
}

function itemDetail(target, projectRoot) {
  const rel = relativeProjectPath(target, projectRoot);
  if (rel !== null) return rel;
  return typeof target === "string" && target.length > 0 ? target : null;
}

// ---------------------------------------------------------------------------
// reduceWorkEvent：按事件类型投影工作组/子工作
// ---------------------------------------------------------------------------

// 工作组自身的有效工作时钟（Task 15 修复）：镜像 journal transitionWorkClock
//（src/core/agent/journal.mjs）——只累计 running/interrupting/stopping 状态下的
// 耗时，waiting_user 与终态不计入；终态时把累计值冻结到 elapsedMs。投影因此
// 能给出每组自己的终态耗时，不依赖（且不被）当前 active run 的快照字段覆盖。
const GROUP_ACTIVE_STATUSES = new Set(["running", "interrupting", "stopping"]);
const GROUP_TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

function transitionGroupClock(group, nextStatus, at) {
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) return; // 事件无有效时间戳：不影响时钟
  if (group.activeSince !== null && !GROUP_ACTIVE_STATUSES.has(nextStatus)) {
    group.activeMs += Math.max(0, atMs - Date.parse(group.activeSince));
    group.activeSince = null;
  }
  if (group.activeSince === null && GROUP_ACTIVE_STATUSES.has(nextStatus)) {
    group.activeSince = at;
  }
  if (GROUP_TERMINAL_STATUSES.has(nextStatus)) {
    group.elapsedMs = group.activeMs;
  }
}

function ensureGroup(work, runId, seq) {
  let group = work.groups.get(runId);
  if (!group) {
    group = {
      id: runId,
      status: "running",
      expanded: true,
      firstSeq: seq,
      sortSeq: seq,
      items: new Map(),
      // 工作时钟（镜像 journal）：startedAt 首个 run_started；activeMs 累计有效耗时；
      // activeSince 当前活动区间起点（null=等待/终态）；elapsedMs 终态冻结值。
      startedAt: null,
      activeMs: 0,
      activeSince: null,
      elapsedMs: null,
      // v1 旧日志/旧测试事件的未闭合 model turn 计数（镜像 journal legacyOpenTurns，
      // 保持 journal 兼容的投影形状）：v1 事件无 turn_id、没有 reasoning 内容，
      // 不产生工作项，该计数仅供状态层与 journal 对齐，当前无 UI 消费方。
      legacyOpenTurns: 0,
      // 第九轮：首个 run_started 的 seq（组 firstSeq 锚点迁移的依据；无 run_started
      // 的组为 null，不迁移）。
      runStartedSeq: null
    };
    work.groups.set(runId, group);
  }
  return group;
}

function setGroupStatus(group, status, seq, at) {
  transitionGroupClock(group, status, at);
  group.status = status;
  group.expanded = groupExpandedDefault(status);
  group.sortSeq = seq;
}

function reasoningItem(work, turnId) {
  if (typeof turnId !== "string" || turnId.length === 0) return null;
  const runId = work.turnToRun.get(turnId);
  const group = runId != null ? work.groups.get(runId) : null;
  return group?.items.get(`reasoning:${turnId}`) ?? null;
}

function toolItem(work, activityId, runId) {
  if (typeof activityId !== "string" || activityId.length === 0) return null;
  const owner = work.activityToRun.get(activityId) ?? runId;
  const group = owner != null ? work.groups.get(owner) : null;
  return group?.items.get(`tool:${activityId}`) ?? null;
}

// Task 2：把一段文本追加到工具项输出（镜像旧 state.js appendActivityText）：
// 超出 MAX_TOOL_OUTPUT_CHARS 时保留尾部窗口并置 truncated=true。调用方负责
// 过滤非字符串/空串，这里兜底一次非法输入。
function appendToolOutput(item, text) {
  if (typeof text !== "string" || text.length === 0) return;
  item.output += text;
  if (item.output.length > MAX_TOOL_OUTPUT_CHARS) {
    item.output = item.output.slice(item.output.length - MAX_TOOL_OUTPUT_CHARS);
    item.truncated = true;
  }
}

// 计划任务按 id 合并（计划 §0.2"绝不重复添加" + Task 5 Step 1"内容仍包含全部任务"）：
// 同一 task id 更新内容并移动到列表最新位置；不在本次更新中的历史任务保留。
function mergePlanTasks(stored, incoming, seq) {
  const byId = new Map(stored.map((task) => [task.id, task]));
  for (const incomingTask of incoming) {
    if (incomingTask == null || typeof incomingTask.id !== "string") continue;
    const existing = byId.get(incomingTask.id);
    if (existing) {
      existing.step = incomingTask.step;
      existing.status = incomingTask.status;
      if (incomingTask.description !== undefined) existing.description = incomingTask.description;
      existing.sortSeq = seq;
      stored.splice(stored.indexOf(existing), 1);
      stored.push(existing);
    } else {
      const task = { id: incomingTask.id, step: incomingTask.step, status: incomingTask.status, firstSeq: seq, sortSeq: seq };
      if (incomingTask.description !== undefined) task.description = incomingTask.description;
      stored.push(task);
      byId.set(task.id, task);
    }
  }
}

export function reduceWorkEvent(work, event) {
  if (!event || typeof event !== "object" || event.run_id == null) return;
  const runId = event.run_id;
  const payload = event.payload ?? {};
  const rawSeq = Number(event.seq);
  const seq = Number.isFinite(rawSeq) ? rawSeq : null;

  switch (event.type) {
    case "model_turn_started": {
      const turnId = payload.turn_id;
      if (typeof turnId === "string" && turnId.length > 0) {
        const group = ensureGroup(work, runId, seq);
        work.turnToRun.set(turnId, runId);
        const id = `reasoning:${turnId}`;
        if (!group.items.has(id)) {
          group.items.set(id, {
            id,
            runId,
            kind: "reasoning",
            firstSeq: seq,
            sortSeq: seq,
            start_seq: seq, // Task 10：start 位置（与 firstSeq 一致，重建后仍稳定）
            terminal_seq: null,
            state: "running",
            label: reasoningLabel({ state: "running" }),
            detail: null,
            turn_id: turnId,
            text: "",
            availability: null,
            // AICSS：思考耗时口径（started_at 为事件时间戳；thinking_ms 完成时计算）
            started_at: event.at ?? null,
            thinking_ms: null
          });
        }
        group.sortSeq = seq;
      } else {
        // v1 兼容：无 turn_id 的 model_turn_started（journal 的 v1 重放路径）
        const group = ensureGroup(work, runId, seq);
        group.legacyOpenTurns += 1;
      }
      break;
    }
    case "reasoning_delta": {
      const item = reasoningItem(work, payload.turn_id);
      if (item && typeof payload.text === "string") item.text += payload.text;
      break;
    }
    case "reasoning_completed": {
      const item = reasoningItem(work, payload.turn_id);
      if (item) {
        // reasoning_completed 到达 → 立即 running → completed（不移动位置）
        item.state = "completed";
        // AICSS：思考耗时 = 完成事件与开始事件的时间戳差（负值/NaN 丢弃 → 回退文案）
        if (typeof item.started_at === "string" && typeof event.at === "string") {
          const ms = Date.parse(event.at) - Date.parse(item.started_at);
          if (Number.isFinite(ms) && ms >= 0) item.thinking_ms = ms;
        }
        item.label = reasoningLabel(item);
        item.terminal_seq = seq; // Task 10：终态事件 seq 落位（start 位置不变）
        if (typeof payload.text === "string") item.text = payload.text;
        if (typeof payload.availability === "string") item.availability = payload.availability;
      }
      break;
    }
    case "model_turn_completed": {
      // v2：reasoning_completed 已先把 item 置为 completed，这里不再变化。
      // v1：无 turn_id 时关闭一个 legacy open turn（镜像 journal legacyOpenTurns）。
      if (typeof payload.turn_id !== "string") {
        const group = work.groups.get(runId);
        if (group && group.legacyOpenTurns > 0) group.legacyOpenTurns -= 1;
      }
      break;
    }
    case "tool_call_started": {
      const activityId = payload.activity_id;
      if (typeof activityId !== "string" || activityId.length === 0) break;
      const group = ensureGroup(work, runId, seq);
      work.activityToRun.set(activityId, runId);
      const args = payload.args && typeof payload.args === "object" && !Array.isArray(payload.args) ? payload.args : {};
      const target = toolTarget(args, payload.action ?? null);
      const id = `tool:${activityId}`;
      let item = group.items.get(id);
      if (!item) {
        group.items.set(id, {
          id,
          runId,
          kind: "tool",
          firstSeq: seq,
          sortSeq: seq,
          start_seq: seq, // Task 10：start 位置（与 firstSeq 一致，重建后仍稳定）
          terminal_seq: null,
          state: "running",
          label: toolLabel(payload.name, "running"),
          detail: itemDetail(target, event.project_root),
          tool: typeof payload.name === "string" ? payload.name : null,
          target,
          args: structuredClone(args),
          command: typeof args.command === "string" ? args.command : (payload.action?.command ?? null),
          cwd: typeof args.cwd === "string" ? args.cwd : (payload.action?.cwd ?? null),
          error: null,
          // Task 2：工具输出投影（stdout/stderr 文本、截断标记、退出码、耗时）
          output: "",
          truncated: false,
          exit_code: null,
          duration_ms: null
        });
      } else {
        // 防御性 upsert（journal 不会重复同一 activity_id；纯投影测试可复用 id）
        item.state = "running";
        item.label = toolLabel(payload.name ?? item.tool, "running");
        item.error = null;
      }
      group.sortSeq = seq;
      break;
    }
    case "tool_output_delta": {
      // Task 2：增量输出追加到工具项（镜像旧 state.js tool_output_delta 的
      // 累计/截断语义）。未知 activity_id 忽略——不凭空创建工具项。
      const item = toolItem(work, payload.activity_id, runId);
      if (item && typeof payload.text === "string") appendToolOutput(item, payload.text);
      break;
    }
    case "tool_call_completed": {
      const item = toolItem(work, payload.activity_id, runId);
      if (item) {
        // tool_call_completed 到达 → 立即终结
        item.state = "completed";
        item.label = toolLabel(item.tool, "completed");
        item.terminal_seq = seq; // Task 10：终态事件 seq 落位（start 位置不变）
        // Task 2：退出码与耗时仅当事件携带时写入（镜像旧 state.js；0 是合法值）
        if (payload.exit_code != null) item.exit_code = payload.exit_code;
        if (payload.duration_ms != null) item.duration_ms = payload.duration_ms;
      }
      break;
    }
    case "tool_call_failed": {
      const item = toolItem(work, payload.activity_id, runId);
      if (item) {
        const cancelled = CANCELLED_ERROR_CODES.has(payload.error);
        item.state = cancelled ? "cancelled" : "failed";
        item.label = toolLabel(item.tool, item.state);
        item.terminal_seq = seq; // Task 10：终态事件 seq 落位（start 位置不变）
        item.error = typeof payload.message === "string" && payload.message.length > 0
          ? payload.message
          : typeof payload.error === "string" && payload.error.length > 0 ? payload.error : null;
        // Task 2：失败时的 stdout/stderr 快照追加进输出（镜像旧 state.js
        // tool_call_failed：仅非空字符串，走同一累计/截断逻辑）
        if (typeof payload.stdout === "string" && payload.stdout.length > 0) appendToolOutput(item, payload.stdout);
        if (typeof payload.stderr === "string" && payload.stderr.length > 0) appendToolOutput(item, payload.stderr);
        // 耗时同样从失败事件写入（镜像旧 state.js：shell 超时等失败也携带耗时）
        if (payload.duration_ms != null) item.duration_ms = payload.duration_ms;
      }
      break;
    }
    case "input_started": {
      // 第九轮：组锚点迁移（根本性修复）。用户消息气泡（state.js）锚定
      // input_started 的 seq，而组最初锚定 run_started 的 seq；真实 journal
      // 中前者恒大于后者，按 (seq, eventKey) 排序时组会排到用户消息前面。
      // 组 firstSeq 迁移到「所属 Run 的首个 input_started」的 seq 后，与用户
      // 消息同 seq，insertTimeline 同 seq 按 eventKey 字典序（session:… <
      // work:…）保证消息在前、组紧跟其后。仅迁移一次：firstSeq 已不等于
      // runStartedSeq 时不再动（priority 的第二个 input_started、retry 后的
      // 新 input_started 都不再移动组）。
      const group = ensureGroup(work, runId, seq);
      if (seq != null && group.runStartedSeq != null && group.firstSeq === group.runStartedSeq) {
        group.firstSeq = seq;
      }
      break;
    }
    case "plan_updated": {
      if (!Array.isArray(payload.items)) break;
      const group = ensureGroup(work, runId, seq);
      const id = `plan:${runId}`;
      let item = group.items.get(id);
      if (!item) {
        item = {
          id,
          runId,
          kind: "plan",
          firstSeq: seq,
          sortSeq: seq,
          state: "completed", // 计划是静态子项：从不作为 live 目标
          label: PLAN_LABEL,
          detail: null,
          plan: { explanation: null, items: [] }
        };
        group.items.set(id, item);
      } else {
        item.sortSeq = seq; // 计划移动到最新位置
      }
      if (typeof payload.explanation === "string") item.plan.explanation = payload.explanation;
      mergePlanTasks(item.plan.items, payload.items, seq);
      group.sortSeq = seq;
      break;
    }
    case "run_started": {
      const group = ensureGroup(work, runId, seq);
      // 第九轮：记录 run_started 锚点。真实 journal 同批顺序 run_started →
      // input_queued → input_started（runtime.mjs submit 空闲路径），故
      // input_started.seq 恒大于 run_started.seq；组 firstSeq 需在首个
      // input_started 到达时迁移（见 input_started 分支），否则按 seq 排序
      // 时组会排在其用户消息之前。
      group.runStartedSeq = seq;
      // 新 Run：记录 startedAt 并清零累计；retry（同 runId 已终态）：保留累计
      // 耗时，由 transitionGroupClock 在进入 running 时重新置 activeSince。
      if (group.startedAt === null) {
        group.startedAt = event.at ?? null;
        group.activeMs = 0;
      }
      setGroupStatus(group, "running", seq, event.at);
      group.legacyOpenTurns = 0; // 新尝试（含 retry）不继承旧开放的 legacy turn
      break;
    }
    case "run_status_changed": {
      const group = ensureGroup(work, runId, seq);
      if (typeof payload.status === "string" && payload.status.length > 0) {
        setGroupStatus(group, payload.status, seq, event.at);
      }
      break;
    }
    case "interrupt_requested": {
      setGroupStatus(ensureGroup(work, runId, seq), "interrupting", seq, event.at);
      break;
    }
    case "interrupt_safe_point_reached": {
      setGroupStatus(ensureGroup(work, runId, seq), "running", seq, event.at);
      break;
    }
    case "run_completed":
    case "run_failed":
    case "run_cancelled":
    case "run_interrupted": {
      const group = ensureGroup(work, runId, seq);
      const terminal = { run_completed: "completed", run_failed: "failed", run_cancelled: "cancelled", run_interrupted: "interrupted" };
      setGroupStatus(group, terminal[event.type], seq, event.at);
      group.legacyOpenTurns = 0;
      break;
    }
    default:
      break;
  }
}
