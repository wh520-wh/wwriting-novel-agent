// src/app-shell/agent/view/work-group.mjs —— 当前 Run 过程展示分区（Task 16，第十五轮）。
//
// 从 view.js 拆出的当前 Run 职责：run header（停止/重试按钮，Round10 起停止按钮
// 紧贴工作组状态行）、reasoning/tool/plan 工作组时间线（工具详情字段固定顺序、
// 搜索/计划渲染、ticker 增量摘要、1s 时钟、动效 class）、工作组生命周期
//（workGroups 映射，与消息共享 messages 时间线经 timeline 分区插入/移除，
// run 切换时清空决策/错误）。行为与拆分前完全一致。
//
// ctx 契约（引用共享 + 活绑定 getter，与壳内同名变量语义一致）：
//   - 共享引用（const 对象，双方便携读写）：doc/runSection/runHeader/errorsSlot/
//     workGroups/decisionCards/rendered/timeline/scheduler/viewIcon；
//   - 活绑定（壳内 let，经 getter 读最新值）：currentState/actions。
// 分区私有状态不落 ctx：stopPending（停止请求在途，防连点；壳 reset 的复位
// 由分区 reset 承担）。
//
// 跨分区调用：工作组与消息共享 messages 统一时间线，插入/移除/落底一律经
// ctx.timeline（insertTimeline/removeNode/afterRender），不直接碰时间线内部索引。
import { getActiveRun, isRunActive, TERMINAL_RUN_STATUSES } from "../state.js";
import { formatDuration, groupStatusText, orderedWorkItems, visibleLiveTargets } from "../work-items.mjs";
import { createReasoningTicker } from "../reasoning-ticker.mjs";
import { taskIcon } from "../../components/task-icons.mjs";

// 运行中耗时唯一数据源：工作组投影时钟（与终态 Task 15 同源，journal 同算法）。
// activeSince 是事件 at 的 ISO 字符串；waiting_user/终态时 activeSince 为 null，
// 返回已累计的 activeMs（冻结）。
export function groupLiveElapsedMs(group, now = Date.now()) {
  const activeMs = Number(group?.activeMs ?? 0);
  const since = group?.activeSince != null ? Date.parse(group.activeSince) : null;
  if (Number.isFinite(since) && Number.isFinite(activeMs)) {
    return Math.max(0, activeMs + Math.max(0, now - since));
  }
  return Number.isFinite(activeMs) ? Math.max(0, activeMs) : 0;
}

export function reasoningDetailText(item) {
  if (item.availability === "unsupported") return "当前模型不支持查看";
  if (item.availability === "empty" || !(typeof item.text === "string" && item.text.length > 0)) {
    return "没有可查看的思考内容（本次无输出或该模型不支持）";
  }
  return item.text;
}

// 工作组的稳定时间线 key：runId + 首次事件 seq（跨重建稳定；firstSeq 前移时重插）。
export function workGroupKey(group) {
  return `work:${group.id}:${group.firstSeq}`;
}

// 工具输出截断提示（work-items.mjs 在输出超 64 KiB 时保留尾部并置 truncated）。
const WORK_OUTPUT_TRUNCATED_MARK = "（输出过长已截断）\n";

// 工具详情字段固定顺序（验收契约，沿用旧活动行的顺序）。
const FIELD_ORDER = ["参数", "命令", "目录", "退出码", "耗时", "错误"];
const TOOL_STATE_ICONS = { running: "•", completed: "✓", failed: "✗", cancelled: "已停止", waiting: "•" };
// 计时只在真实文档内运行：脱离文档（测试 mock / 未挂载）的节点不保留 1s/800ms
// 重复计时器，避免泄漏；details 挂载后计时正常工作。
const DURATION_ACTIVE_STATUSES = new Set(["running", "interrupting", "stopping"]);

// AICSS web-search 特化渲染：查询 shimmer 头 + 来源列表（globe 旋转 → 逐项勾选）。
// 来源数据由未来搜索工具在 tool_call_completed.payload.sources 提供；
// 无 sources 时列表隐藏，行仍以「正在搜索/已搜索」标签呈现。
const SEARCH_GLOBE_VALUES = [
  "M6.057 11.565 C2.081 11.565 0.371 8.159 0.371 5.964 C0.371 3.642 2.152 0.329 6.05 0.329",
  "M6.012 11.55 C4.575 10.496 3.333 8.116 3.321 5.964 C3.307 3.399 4.974 0.977 6.012 0.329",
  "M6.012 11.55 C7.211 10.781 8.715 8.287 8.715 5.964 C8.715 3.399 7.24 1.233 6.012 0.329",
  "M6.012 11.55 C9.677 11.55 11.65 8.487 11.65 5.964 C11.65 3.499 9.748 0.329 6.012 0.329",
  "M6.057 11.565 C2.081 11.565 0.371 8.159 0.371 5.964 C0.371 3.642 2.152 0.329 6.05 0.329"
].join(";");
const SEARCH_GLOBE_BEGINS = ["0s", "-1.2s", "-2.4s", "-3.6s", "-4.8s", "-6s"];
const SEARCH_GLOBE_SVG = (() => {
  const first = SEARCH_GLOBE_VALUES.split(";")[0];
  const paths = SEARCH_GLOBE_BEGINS.map((begin) =>
    `<path d="${first}" opacity="0"><animate attributeName="d" dur="7.2s" begin="${begin}" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.25;0.5;0.75;1" keySplines="0.42 0 0.58 1;0.42 0 0.58 1;0.42 0 0.58 1;0.42 0 0.58 1" values="${SEARCH_GLOBE_VALUES}"/><animate attributeName="opacity" dur="7.2s" begin="${begin}" repeatCount="indefinite" calcMode="linear" keyTimes="0;0.05;0.7;0.75;1" values="0;0.9;0.9;0;0"/></path>`
  ).join("");
  return `<svg class="agent-search-globe" viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="0.85" stroke-linecap="round" style="overflow: visible" aria-hidden="true"><circle cx="6" cy="6" r="5.7" opacity="0.9"/><line x1="0.3" y1="6" x2="11.7" y2="6" opacity="0.9"/>${paths}</svg>`;
})();
const SEARCH_BULLET_DOTS = `<svg class="agent-search-dots" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke-width="1.8" stroke-dasharray="1.8 3.6" stroke-linecap="round"/></svg>`;
const SEARCH_BULLET_CHECK = `<svg class="agent-search-check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg>`;

export function createWorkGroupView(ctx) {
  // 共享引用解构（const 对象，引用共享）：壳与分区读写同一份状态/DOM。
  const { doc, runSection, runHeader, errorsSlot, workGroups, decisionCards,
          rendered, timeline, scheduler, viewIcon } = ctx;
  // 活绑定不在此解构——经 ctx.currentState/ctx.actions getter 每次读取最新值。

  // ---- 分区私有状态（原 view.js 闭包 let 迁入）-----------------------------
  let stopPending = false; // 停止请求在途（防连点；reset 复位随分区）

  // ---- 当前 Run：停止/重试按钮 + Plan + 决策/错误 --------------------------------
  // Round10：停止按钮位置——运行中紧贴当前 Run 工作组的状态行（同一 720px 行内，
  // spec §7.3「停止必须紧贴状态行并清楚可见」）；工作组尚未出现（如无事件快照）
  // 时退回 run header 兜底。ponytail: summary 内嵌交互控件是 a11y 权衡（HTML 建议
  // 性约束「summary 不应含交互内容」），以 stopPropagation 防误触 details 折叠；
  // 未来若规范收紧可改回独立行。
  function placeRunControls(state) {
    // 停止按钮可能在 run header 或某工作组 summary 中（移动后 querySelector 需双向查找）。
    let stop = runHeader.querySelector('[data-testid="agent-stop"]');
    if (!stop) {
      for (const record of workGroups.values()) {
        stop = record.summary.querySelector('[data-testid="agent-stop"]');
        if (stop) break;
      }
    }
    if (!stop) return;
    const run = getActiveRun(state);
    const record = run ? workGroups.get(run.id) : null;
    const target = record && isRunActive(run) ? record.summary : runHeader;
    if (stop.parentNode !== target) {
      // 显式 remove 再 append：真实 DOM 中 append 即移动，测试 mock 不搬移旧父节点。
      stop.remove();
      target.append(stop);
    }
  }

  function renderRunHeader(state) {
    runHeader.replaceChildren();
    // Round10：停止按钮可能位于工作组 summary（紧贴状态行）——重渲前先摘除旧按钮。
    for (const record of workGroups.values()) {
      const stale = record.summary.querySelector('[data-testid="agent-stop"]');
      if (stale) stale.remove();
    }
    const run = getActiveRun(state);
    if (!run) return;
    if (isRunActive(run)) {
      const stop = doc.createElement("button");
      stop.type = "button";
      stop.className = "agent-stop-btn";
      stop.dataset.testid = "agent-stop";
      // Round10：停止 = 「图标 + 文字」紧凑次按钮；可访问名明确为「停止当前任务」。
      stop.setAttribute("aria-label", "停止当前任务");
      stop.append(viewIcon("stop", 13), doc.createTextNode("停止"));
      stop.disabled = stopPending;
      stop.addEventListener("click", (event) => {
        // summary 内放置时防止误触 details 折叠（事件对象可缺省：测试桩不透传）。
        event?.stopPropagation?.();
        if (stop.disabled) return;
        stop.disabled = true;
        stopPending = true;
        try {
          Promise.resolve(ctx.actions.stop?.(run.id)).catch(() => {
            stop.disabled = false;
            stopPending = false;
          });
        } catch {
          stop.disabled = false;
          stopPending = false;
        }
      });
      // 第十二轮 F4：waiting_user 状态行提示——等待你的指令：发送消息继续。
      if (run.status === "waiting_user") {
        const hint = doc.createElement("span");
        hint.className = "agent-run-hint";
        hint.dataset.testid = "agent-run-hint";
        hint.textContent = "等待你的指令：发送消息继续";
        runHeader.append(hint);
      }
      runHeader.append(stop);
      placeRunControls(state);
    } else if (run.status === "failed" || run.status === "interrupted") {
      const retry = doc.createElement("button");
      retry.type = "button";
      retry.className = "agent-retry-btn";
      retry.dataset.testid = "agent-retry";
      retry.textContent = "重试";
      // 防连点：点击即禁用；请求失败才恢复（成功路径由 run_started 重建头部，
      // 重试按钮自然消失，无需显式恢复）。
      retry.addEventListener("click", () => {
        if (retry.disabled) return;
        retry.disabled = true;
        try {
          Promise.resolve(ctx.actions.retry?.(run.id)).catch(() => {
            retry.disabled = false;
          });
        } catch {
          retry.disabled = false;
        }
      });
      runHeader.append(retry);
    }
  }

  function syncRun(state) {
    const run = getActiveRun(state);
    runSection.hidden = !run;
    const runId = run?.id ?? null;
    const runChanged = rendered.runId !== runId;
    // retry：同 run id 从终态重新进入 running（run_failed/run_interrupted 后重试恢复）。
    // 停止请求若仍在途（stopPending），此时必须恢复，否则重试后的 Run 永远无法停止。
    const resumedAfterTerminal =
      rendered.runStatus != null &&
      TERMINAL_RUN_STATUSES.has(rendered.runStatus) &&
      run &&
      !TERMINAL_RUN_STATUSES.has(run.status);
    if (resumedAfterTerminal) stopPending = false;
    if (rendered.run !== state.revisions.run) {
      rendered.run = state.revisions.run;
      renderRunHeader(state);
    }
    if (runChanged) {
      rendered.runId = runId;
      stopPending = false;
      // 新 Run：清空决策/错误（工作组的生命周期由 work 投影的 group 管理）
      for (const card of decisionCards.values()) card.remove();
      decisionCards.clear();
      errorsSlot.replaceChildren();
      rendered.decisions = -1;
      rendered.errors = -1;
    }
    rendered.runStatus = run?.status ?? null;
  }

  // ---- 工作组（Task 6）：reasoning/tool/plan 有序时间线，插入对话时间流 ----------
  function createWorkGroup(group) {
    const details = doc.createElement("details");
    details.className = "agent-work-group";
    details.dataset.groupId = group.id;
    details.open = group.expanded; // 投影给出展开默认值；用户可在 DOM 侧覆盖
    const summary = doc.createElement("summary");
    const statusMark = doc.createElement("span");
    statusMark.className = "agent-work-status-mark";
    statusMark.setAttribute("aria-hidden", "true");
    const status = doc.createElement("span");
    status.className = "agent-work-status";
    const duration = doc.createElement("span");
    duration.className = "agent-work-duration";
    summary.append(statusMark, status, duration);
    const itemsEl = doc.createElement("div");
    itemsEl.className = "agent-work-items";
    details.append(summary, itemsEl);
    timeline.insertTimeline(details, group.firstSeq, workGroupKey(group));
    const record = {
      groupId: group.id,
      details,
      summary,
      statusMark,
      status,
      duration,
      itemsEl,
      rows: new Map(),       // itemId -> row
      userToggled: false,    // 用户手动折叠后，投影的 expanded 不再覆盖
      durationTimer: null,
      groupSeq: group.firstSeq,
      groupKey: workGroupKey(group)
    };
    // toggle 事件只负责立即重应用动效（按当前展开态），不再用它判定「用户手动切换」：
    // Chromium 会在 <details open> 插入文档时异步补发一个 toggle 事件（实测 trusted），
    // 若在此置位 userToggled，会把「完成自动折叠」吞掉（详情折叠被用户手势标记阻塞）。
    // userToggled 只由真实的 summary 交互（点击 / Enter / Space）置位。
    details.addEventListener("toggle", () => {
      const g = ctx.currentState?.work?.groups.get(record.groupId);
      if (g) applyLiveTargets(record, g);
    });
    const markUserToggled = () => {
      record.userToggled = true;
    };
    summary.addEventListener("click", markUserToggled);
    summary.addEventListener("keydown", (event) => {
      // 只认 summary 自身的键盘激活：停止按钮（summary 内）的 Enter/Space 冒泡
      // 到这里不得标记 userToggled，否则键盘停止会阻止终态自动折叠。
      if (event.target !== summary) return;
      if (event.key === "Enter" || event.key === " ") markUserToggled();
    });
    workGroups.set(group.id, record);
    return record;
  }

  // 统一 item renderer：reasoning / tool / plan 共用同一行结构（label + 按 kind 扩展）。
  function buildWorkItemRow(record, item) {
    const wrap = doc.createElement("div");
    wrap.className = "agent-work-item";
    wrap.dataset.itemId = item.id;
    wrap.dataset.kind = item.kind;
    wrap.dataset.state = item.state;
    const label = doc.createElement("span");
    label.className = "agent-work-item__label";
    const row = { wrap, label, kind: item.kind, itemId: item.id, prevState: null, lastPushedLen: 0 };
    if (item.kind === "tool") {
      const iconEl = doc.createElement("span");
      iconEl.className = "agent-work-item__icon";
      iconEl.setAttribute("aria-hidden", "true");
      wrap.append(iconEl, label);
      row.icon = iconEl;
      const path = doc.createElement("span");
      path.className = "agent-tool-path";
      wrap.append(path);
      row.path = path;
      const meta = doc.createElement("span");
      meta.className = "agent-work-item__meta";
      wrap.append(meta);
      row.meta = meta;
      const caret = doc.createElement("span");
      caret.className = "agent-tool-caret";
      caret.setAttribute("aria-hidden", "true");
      wrap.append(caret);
      row.caret = caret;
      // 工具详情：整行点击切换（R1）。类名保留 .agent-tool-details（div），
      // 字段/输出在其中；无内容时整体隐藏（与旧 details 语义一致）。
      const details = doc.createElement("div");
      details.className = "agent-tool-details";
      details.setAttribute("role", "group");
      details.setAttribute("aria-label", "工具详情");
      const detail = doc.createElement("div");
      detail.className = "agent-tool-fields";
      const output = doc.createElement("pre");
      output.className = "agent-tool-output";
      details.append(detail, output);
      wrap.append(details);
      row.details = details;
      row.detail = detail;
      row.fieldEls = new Map();   // 字段名 -> field 容器（内容在 pre 内）
      row.outputEl = output;
      row.fieldsSignature = null;
      row.hasContent = false;
      row.toolOpen = false;
      // AICSS web-search：query 非空的 web_search 工具行附带搜索状态渲染
      // （查询 shimmer 头 + 来源列表；无 sources 时列表隐藏，头仍显示）。
      // ponytail: web_search 是唯一的工具行特化（硬编码单例）——第二个特化工具
      // 出现时，抽 TOOL_ROW_SPECIALIZATIONS = { web_search: { build, update } } 注册表。
      if (item.tool === "web_search" && typeof item.args?.query === "string" && item.args.query.length > 0) {
        const query = doc.createElement("span");
        query.className = "agent-search-query";
        wrap.append(query);
        row.searchQuery = query;
        const list = doc.createElement("ul");
        list.className = "agent-search-list";
        list.dataset.state = "pending";
        wrap.append(list);
        row.searchList = list;
        row.searchSignature = null;
      }
      // 整行切换（a11y：role=button + Enter/Space；点击内容区不触发收起）
      wrap.setAttribute("role", "button");
      wrap.setAttribute("tabindex", "0");
      wrap.setAttribute("aria-expanded", "false");
      const setToolOpen = (open) => {
        row.toolOpen = open;
        wrap.setAttribute("aria-expanded", open ? "true" : "false");
        wrap.classList.toggle("agent-tool-details--open", open);
        row.details.hidden = !row.hasContent || !open;
        // 输出块与详情区同步可见（真实 DOM 中 hidden 由父级级联；测试桩
        // 不级联，需显式设置，且对真实 DOM 是幂等冗余）。
        row.outputEl.hidden = !row.hasContent || !open;
      };
      wrap.addEventListener("click", (event) => {
        const target = event?.target ?? wrap;
        if (target.closest?.(".agent-tool-details")) return; // 内容区点击不切换
        setToolOpen(!row.toolOpen);
      });
      wrap.addEventListener("keydown", (event) => {
        // 真实 DOM 聚焦行自身时 target===wrap；MockElement._fire 不透传 target，
        // 缺省视为行自身（否则测试桩下 Enter/Space 永不触发）。
        if ((event?.target ?? wrap) !== wrap) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault(); // 防 Space 滚动
          setToolOpen(!row.toolOpen);
        }
      });
    } else if (item.kind === "reasoning") {
      wrap.append(label);
      const tickerEl = doc.createElement("div");
      tickerEl.className = "agent-reasoning-ticker";
      wrap.append(tickerEl);
      row.tickerEl = tickerEl;
      const detailEl = doc.createElement("div");
      detailEl.className = "agent-reasoning-detail";
      wrap.append(detailEl);
      row.detailEl = detailEl;
      // 第九轮：与工具行（R1）一致的整行折叠交互——终态「已完成思考」默认
      // 折叠为一行（label + caret），整行点击展开全文；运行中（ticker 实时
      // 摘要）不进入折叠态、点击不响应。
      const reasoningCaret = doc.createElement("span");
      reasoningCaret.className = "agent-reasoning-caret";
      reasoningCaret.setAttribute("aria-hidden", "true");
      wrap.append(reasoningCaret);
      row.caret = reasoningCaret;
      wrap.setAttribute("role", "button");
      wrap.setAttribute("tabindex", "0");
      wrap.setAttribute("aria-expanded", "false");
      row.reasoningOpen = false;
      const setReasoningOpen = (open) => {
        row.reasoningOpen = open;
        wrap.setAttribute("aria-expanded", open ? "true" : "false");
        wrap.classList.toggle("agent-reasoning-detail--open", open);
        row.detailEl.hidden = !open;
      };
      wrap.addEventListener("click", (event) => {
        // 仅终态可展开/折叠（dataset.state 由 updateWorkItemRow 同步）
        if (row.wrap.dataset.state === "running") return;
        const target = event?.target ?? wrap;
        if (target.closest?.(".agent-reasoning-detail")) return; // 内容区点击不切换
        setReasoningOpen(!row.reasoningOpen);
      });
      wrap.addEventListener("keydown", (event) => {
        // 真实 DOM 聚焦行自身时 target===wrap；MockElement._fire 不透传 target，
        // 缺省视为行自身（否则测试桩下 Enter/Space 永不触发）。
        if ((event?.target ?? wrap) !== wrap) return;
        if (row.wrap.dataset.state === "running") return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault(); // 防 Space 滚动
          setReasoningOpen(!row.reasoningOpen);
        }
      });
    } else if (item.kind === "plan") {
      wrap.append(label);
      label.classList.add("agent-plan__title");
      const countEl = doc.createElement("span");
      countEl.className = "agent-plan__count";
      wrap.append(countEl);
      row.countEl = countEl;
      const listEl = doc.createElement("ol");
      listEl.className = "agent-plan-list";
      wrap.append(listEl);
      row.listEl = listEl;
      row.planSignature = null;
    }
    record.itemsEl.append(wrap);
    return row;
  }

  function tickerSchedulerFor(record) {
    return {
      setTimeout: (fn, ms) => (record.details.isConnected ? scheduler.setTimeout(fn, ms) : null),
      clearTimeout: (id) => { if (id != null) scheduler.clearTimeout(id); }
    };
  }

  function updateWorkItemRow(record, row, item) {
    row.wrap.dataset.state = item.state;
    const wasRunning = row.prevState === "running";
    const isRunning = item.state === "running";
    row.prevState = item.state;

    // label：工具失败时把尾部「失败」拆成独立短状态词，单独应用 --text-danger。
    const labelText = String(item.label ?? "");
    const splitFailed = item.kind === "tool" && item.state === "failed" && labelText.endsWith("失败");
    if (splitFailed) {
      if (!row.stateWord) {
        row.label.replaceChildren();
        row.nameSpan = doc.createElement("span");
        row.stateWord = doc.createElement("span");
        row.stateWord.className = "agent-work-item__state";
        row.label.append(row.nameSpan, row.stateWord);
      }
      if (row.nameSpan.textContent !== labelText.slice(0, -2)) row.nameSpan.textContent = labelText.slice(0, -2);
      if (row.stateWord.textContent !== "失败") row.stateWord.textContent = "失败";
    } else {
      if (row.stateWord) {
        row.label.replaceChildren();
        row.stateWord = null;
        row.nameSpan = null;
      }
      if (row.label.textContent !== labelText) row.label.textContent = labelText;
    }

    if (row.icon) {
      const iconText = TOOL_STATE_ICONS[item.state] ?? "•";
      if (row.icon.textContent !== iconText) row.icon.textContent = iconText;
      row.icon.dataset.state = item.state;
    }
    if (row.path) {
      const pathText = item.detail ?? "";
      if (row.path.textContent !== pathText) row.path.textContent = pathText;
      row.path.hidden = pathText.length === 0;
    }
    if (row.meta) {
      const errorText = item.error ?? "";
      if (row.meta.textContent !== errorText) row.meta.textContent = errorText;
      row.meta.hidden = errorText.length === 0;
    }

    if (row.kind === "tool") {
      updateToolDetails(row, item);
      if (row.searchQuery) updateSearchContent(row, item);
    } else if (row.kind === "reasoning") {
      if (isRunning) {
        // 运行中摘要走 ticker（≤2 行）；详情永远用持久化完整 reasoning。
        if (!row.ticker) {
          row.ticker = createReasoningTicker({
            onDisplay: (text) => {
              if (row.tickerEl.textContent !== text) {
                row.tickerEl.textContent = text;
                // AICSS thinking-reasoning：片段滚动替换动效——重挂 class 重启
                // CSS 动画（旧片段滚出、新片段滚入；真实 DOM 强制 reflow，
                // 测试 mock 无 offsetWidth 时空转不报错）。
                row.tickerEl.classList.remove("agent-ticker-swap");
                void row.tickerEl.offsetWidth;
                row.tickerEl.classList.add("agent-ticker-swap");
              }
            },
            scheduler: tickerSchedulerFor(record)
          });
        }
        const text = item.text ?? "";
        if (text.length > row.lastPushedLen) {
          row.ticker.push(text.slice(row.lastPushedLen));
          row.lastPushedLen = text.length;
        }
        row.tickerEl.hidden = false;
        // 第九轮：运行中强制折叠态（ticker 摘要为唯一展示；caret 隐藏、不可点）
        row.detailEl.hidden = true;
        row.detailEl.textContent = "";
        if (row.caret) row.caret.hidden = true;
      } else {
        row.tickerEl.hidden = true;
        if (wasRunning) {
          row.ticker?.finish?.(); // 立即停止 ticker 计时，不延迟折叠
          row.ticker = null;
          row.lastPushedLen = (item.text ?? "").length;
        }
        // 第九轮：终态默认折叠——详情内容照填（diff 后立即可展开），可见性
        // 由用户展开态（reasoningOpen）控制，不再直接平铺。
        const detailText = reasoningDetailText(item);
        if (row.detailEl.textContent !== detailText) row.detailEl.textContent = detailText;
        row.detailEl.hidden = !row.reasoningOpen;
        if (row.caret) row.caret.hidden = false;
      }
    } else if (row.kind === "plan") {
      updatePlanContent(row, item.plan);
    }
  }

  // 工具详情字段：参数 → 命令 → 目录 → 退出码 → 耗时 → 错误（固定顺序，折叠在
  // .agent-tool-details div 内，R1 后整行点击切换）。输出块在 truncated 时前置
  // 截断提示。字段只在签名变化时写入 DOM（避免每次 update 重建）；输出文本直接
  // 比对避免重复写。全部字段为空且无输出时隐藏整个折叠区（标签 + path 行照常
  // 显示）——空判定从已构建的字段行派生（隐藏字段不算），输出侧与渲染文本共用
  // outputText。可见性 = hasContent 且用户已展开（toolOpen）。
  function updateToolDetails(row, item) {
    const values = {
      "参数": item.args != null && typeof item.args === "object" && Object.keys(item.args).length > 0
        ? JSON.stringify(item.args) : null,
      "命令": typeof item.command === "string" && item.command.length > 0 ? item.command : null,
      "目录": typeof item.cwd === "string" && item.cwd.length > 0 ? item.cwd : null,
      "退出码": item.exit_code != null ? String(item.exit_code) : null,
      "耗时": item.duration_ms != null ? `${item.duration_ms} ms` : null,
      "错误": item.error ?? null
    };
    const outputText = (item.truncated ? WORK_OUTPUT_TRUNCATED_MARK : "") + String(item.output ?? "");
    if (row.outputEl.textContent !== outputText) row.outputEl.textContent = outputText;
    const signature = JSON.stringify(values);
    if (signature !== row.fieldsSignature) {
      row.fieldsSignature = signature;
      for (const name of FIELD_ORDER) {
        const value = values[name];
        if (value == null || value === "") {
          const field = row.fieldEls.get(name);
          if (field) field.hidden = true;
          continue;
        }
        let field = row.fieldEls.get(name);
        let content;
        if (!field) {
          field = doc.createElement("div");
          field.className = "agent-tool-field";
          const key = doc.createElement("strong");
          key.textContent = name;
          content = doc.createElement("pre");
          field.append(key, content);
          row.detail.append(field);
          row.fieldEls.set(name, field);
          // 新字段出现时按固定顺序重排（真实 DOM 中重复 append 会移动节点）。
          const sorted = FIELD_ORDER.map((n) => row.fieldEls.get(n)).filter(Boolean);
          row.detail.replaceChildren(...sorted);
        } else {
          field.hidden = false;
          content = field.children[1] ?? null;
        }
        if (content && content.textContent !== value) content.textContent = value;
      }
    }
    const hasVisibleField = FIELD_ORDER.some((name) => {
      const field = row.fieldEls.get(name);
      return field != null && !field.hidden;
    });
    row.hasContent = hasVisibleField || outputText.length > 0;
    row.details.hidden = !row.hasContent || !row.toolOpen;
    // 输出块与详情区同步可见（真实 DOM 中父级 hidden 级联即可；测试桩不级联，
    // 需显式设置，对真实 DOM 是幂等冗余）。
    row.outputEl.hidden = !row.hasContent || !row.toolOpen;
  }

  function updateSearchContent(row, item) {
    const query = String(item.args?.query ?? "");
    const queryText = query.length > 0 ? `搜索 “${query}”` : "搜索中";
    if (row.searchQuery.textContent !== queryText) row.searchQuery.textContent = queryText;
    // 查询头 shimmer 复用唯一 shimmer 定义（Task 2 的 .agent-live-text），不新增渐变 CSS
    row.searchQuery.classList.toggle("agent-live-text", item.state === "running");
    const sources = Array.isArray(item.sources) ? item.sources : null;
    row.searchList.hidden = sources == null;
    if (sources == null) return;
    const signature = JSON.stringify(sources.map((s) => `${s?.title ?? ""}|${s?.url ?? ""}`));
    if (signature !== row.searchSignature) {
      row.searchSignature = signature;
      row.searchList.replaceChildren();
      sources.forEach((source, index) => {
        const li = doc.createElement("li");
        li.className = "agent-search-site";
        li.style.setProperty?.("--i", String(index)); // 真实 DOM 写 stagger 变量；mock 空转
        const bullet = doc.createElement("span");
        bullet.className = "agent-search-bullet";
        bullet.innerHTML = SEARCH_BULLET_DOTS + SEARCH_GLOBE_SVG + SEARCH_BULLET_CHECK;
        const title = doc.createElement("span");
        title.className = "agent-search-site-title";
        title.textContent = String(source?.title ?? "");
        const sep = doc.createElement("span");
        sep.className = "agent-search-sep";
        sep.textContent = "·";
        const url = doc.createElement("span");
        url.className = "agent-search-site-url";
        url.textContent = String(source?.url ?? "");
        li.append(bullet, title, sep, url);
        row.searchList.append(li);
      });
    }
    // 运行中 globe 旋转；completed → 逐项转圈变勾（stagger 由 CSS --i 驱动）
    row.searchList.dataset.state = item.state === "completed" ? "done" : "pending";
  }

  function updatePlanContent(row, plan) {
    const items = Array.isArray(plan?.items) ? plan.items : [];
    const signature = JSON.stringify({ explanation: plan?.explanation ?? null, items });
    if (signature === row.planSignature) return;
    row.planSignature = signature;
    const completed = items.filter((item) => item?.status === "completed").length;
    row.countEl.textContent = `${completed}/${items.length}`;
    row.listEl.replaceChildren();
    if (typeof plan?.explanation === "string" && plan.explanation.length > 0) {
      const explanation = doc.createElement("div");
      explanation.className = "agent-plan-explanation";
      explanation.textContent = plan.explanation;
      row.listEl.append(explanation);
    }
    for (const task of items) {
      const li = doc.createElement("li");
      li.className = "agent-plan-item";
      li.dataset.status = task?.status ?? "";
      li.dataset.planId = task?.id ?? task?.step ?? "";
      const iconEl = doc.createElement("span");
      iconEl.className = "agent-plan-item__icon";
      iconEl.setAttribute("aria-hidden", "true");
      iconEl.innerHTML = taskIcon(task?.status, 15);
      const step = doc.createElement("span");
      step.className = "agent-plan-item__step";
      step.textContent = String(task?.step ?? "");
      li.append(iconEl, step);
      if (typeof task?.description === "string" && task.description.length > 0) {
        const description = doc.createElement("div");
        description.className = "agent-plan-description";
        description.textContent = task.description;
        li.append(description);
      }
      row.listEl.append(li);
    }
  }

  // 工作组运行中每秒只更新一次 duration 文本；终态/waiting_user/脱离文档即停表。
  function ensureGroupClock(record, group) {
    const active = DURATION_ACTIVE_STATUSES.has(group.status);
    if (!active || !record.details.isConnected) {
      if (record.durationTimer != null) {
        scheduler.clearInterval(record.durationTimer);
        record.durationTimer = null;
      }
      return;
    }
    if (record.durationTimer != null) return;
    record.durationTimer = scheduler.setInterval(() => {
      if (record.durationTimer == null) return;
      const g = ctx.currentState?.work?.groups.get(record.groupId);
      if (!g || !DURATION_ACTIVE_STATUSES.has(g.status) || !record.details.isConnected) {
        scheduler.clearInterval(record.durationTimer);
        record.durationTimer = null;
        return;
      }
      record.duration.textContent = formatDuration(groupLiveElapsedMs(g));
    }, 1000);
  }

  // 动效 class 只能由 visibleLiveTargets() 决定，显式切换（不只在创建节点时添加）。
  function applyLiveTargets(record, group) {
    const liveTargets = new Set(visibleLiveTargets(group, { expanded: record.details.open }));
    record.status.classList.toggle("agent-live-text", liveTargets.has(`group:${group.id}`));
    for (const [itemId, row] of record.rows) {
      row.label.classList.toggle("agent-live-text", liveTargets.has(itemId));
    }
  }

  function updateWorkGroup(record, group) {
    // N3：状态语义色——组状态行 dataset.status 驱动 per-state 颜色（同色同义，
    // 与状态点 .session-status / 条目图标共用 --agent-state-*）。组对象每次投影
    // 都会重建，故在此随 group.status 同步，不能只在 createWorkGroup 设一次。
    record.status.dataset.status = group.status;
    record.statusMark.dataset.status = group.status;
    // 展开默认值只在用户未手动切换时应用；完成后投影 expanded=false → 自动折叠。
    if (!record.userToggled && record.details.open !== group.expanded) {
      record.details.open = group.expanded;
    }
    if (TERMINAL_RUN_STATUSES.has(group.status)) {
      // 终态耗时取组自身投影的冻结时钟（Task 15 修复）——与运行中分支（L1069 的
      // groupLiveElapsedMs）同源：整个组状态都读工作组投影时钟，不读当前 active run，
      // 第二个 Run 开始后旧组的文案不再被新 Run 覆盖。
      record.status.textContent = groupStatusText(group);
      record.duration.textContent = "";
    } else {
      // 非终态统一走 groupStatusText（单一文案源）：running/interrupting/stopping →
      // "工作中"；waiting_user → "待命"（与 session-sidebar RUN_STATUS_LABELS 口径一致）。
      // §4.3：网关重试期间追加「重试 n/m」瞬态提示（下一次 model_turn_started /
      // 状态变化即被投影清除）；终态分支不拼后缀——Run 已终结不再展示重试。
      const retry = group.retryHint;
      record.status.textContent = retry && retry.attempt != null
        ? `${groupStatusText(group)} · 重试 ${retry.attempt}/${retry.max ?? "?"}`
        : groupStatusText(group);
      record.duration.textContent = formatDuration(groupLiveElapsedMs(group));
    }
    ensureGroupClock(record, group);

    const ordered = orderedWorkItems(group);
    const seen = new Set();
    let changed = false;
    for (const item of ordered) {
      seen.add(item.id);
      let row = record.rows.get(item.id);
      if (!row) {
        row = buildWorkItemRow(record, item);
        record.rows.set(item.id, row);
        changed = true;
      }
      updateWorkItemRow(record, row, item);
    }
    for (const [itemId, row] of record.rows) {
      if (!seen.has(itemId)) {
        row.ticker?.finish?.();
        row.wrap.remove();
        record.rows.delete(itemId);
        changed = true;
      }
    }
    // 第十二轮 F6：行序对齐投影序（orderedWorkItems）。仅在有增删（changed）时
    // 执行，避免每帧搬移 DOM；insertBefore 已在位时不产生搬移。
    // ponytail: 门控只认成员增删——plan_updated 改既有行 sortSeq 不触发重排，
    // 该角落下 DOM 序与投影序短暂不一致，下次增删行自愈（transient 接受）。
    if (changed) {
      let ref = null;
      for (let i = ordered.length - 1; i >= 0; i -= 1) {
        const row = record.rows.get(ordered[i].id);
        if (!row) continue;
        if (ref == null) {
          if (record.itemsEl.lastElementChild !== row.wrap) record.itemsEl.append(row.wrap);
        } else if (row.wrap.nextSibling !== ref) {
          record.itemsEl.insertBefore(row.wrap, ref);
        }
        ref = row.wrap;
      }
    }
    applyLiveTargets(record, group);
    return changed;
  }

  function syncWork(state) {
    const seen = new Set();
    let changed = false;
    for (const group of state.work.groups.values()) {
      if (orderedWorkItems(group).length === 0) continue; // 纯 run 标记的空组不渲染
      seen.add(group.id);
      let record = workGroups.get(group.id);
      if (!record) {
        record = createWorkGroup(group);
        changed = true;
      }
      // 重建后组的 firstSeq 前移（前置页补齐了组的首事件）：重插 details 定位。
      //（键映射与 seq 索引由 removeNode 统一清除——旧 groupKey 即 dataset.eventKey。）
      if (record.groupSeq !== group.firstSeq) {
        timeline.removeNode(record.details);
        record.groupSeq = group.firstSeq;
        record.groupKey = workGroupKey(group);
        timeline.insertTimeline(record.details, group.firstSeq, record.groupKey);
        changed = true;
      }
      if (updateWorkGroup(record, group)) changed = true;
    }
    for (const [id, record] of workGroups) {
      if (!seen.has(id)) {
        // Round10：工作组消失时把其中的停止按钮移回 run header（防丢失逃生入口）。
        const orphan = record.summary.querySelector('[data-testid="agent-stop"]');
        if (orphan && orphan.parentNode === record.summary) {
          orphan.remove();
          runHeader.append(orphan);
        }
        clearWorkGroupTimers(record);
        //（键映射与 seq 索引由 removeNode 统一清除——groupKey 即 details.dataset.eventKey。）
        timeline.removeNode(record.details);
        workGroups.delete(id);
      }
    }
    placeRunControls(state); // 工作组出现/消失后重新放置停止按钮
    if (changed) timeline.afterRender();
  }

  // 计时器清理（scheduler 依赖）：record 级；工作组移除（syncWork）/整体清空
  // （reset/destroy）共用。
  function clearWorkGroupTimers(record) {
    if (record.durationTimer != null) {
      scheduler.clearInterval(record.durationTimer);
      record.durationTimer = null;
    }
    for (const row of record.rows.values()) row.ticker?.finish?.();
  }

  // reset：当前 Run 分区自己的清理（计时器 + workGroups 映射 + stopPending 复位）。
  function reset() {
    for (const record of workGroups.values()) clearWorkGroupTimers(record);
    workGroups.clear();
    stopPending = false;
  }

  // destroy：整体拆除语境（不清 stopPending——对象废弃，无观察者）。
  function destroy() {
    for (const record of workGroups.values()) clearWorkGroupTimers(record);
    workGroups.clear();
  }

  return {
    syncRun,
    syncWork,
    reset,
    destroy
  };
}