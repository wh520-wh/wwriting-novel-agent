import { icon } from "./icons.js";
import { formatTime, formatNumber, cssEscape, translateStage, statusClass } from "./utils.js";
import { motion } from "./motion-runtime.js";
import { renderFailureCard } from "./components/failure-card.js";
import { renderDiff, renderParagraphDiff } from "./diff-view.js";
import { deriveFailures } from "./agent-truth.mjs";
import { deriveRunPresentation, deriveStepState } from "./run-presentation.mjs";
import { postJson, getJson } from "./api-client.js";
import { sendChatMessage, confirmChatAction } from "./api-client.js";
import { renderMarkdown, cleanAssistantContent } from "./markdown-lite.mjs";
import { toolLabel } from "./tool-labels.mjs";
import { deriveSources, deriveSuggestions } from "./chat-derive.mjs";
import { presentChapterArtifact } from "./chapter-presentation.mjs";
import { deriveProjectIdentity } from "./project-identity.mjs";

// ----- 错误卡片（规格书 5.9）：纯函数渲染，DOM 绑定在 live turn 侧复用 -----
// 结构：头部（⛔ + 标题 + 时间戳）/ 人话 + 等宽错误码徽章 / （可选）提示行 / 操作按钮。
// 提示行只放用户需要知道的后果（如"已保留当前进度"），空则不渲染；
// 禁止"不会自动重试"这类策略性说教文案。手动「↻ 重试」按钮带 data-retry。
// 动作形态：字符串 = 静态按钮；{label, retry:true} = 重试按钮（点击重新发起，data-retry）；
// {label, copy:true} = 复制按钮（复制错误详情到剪贴板，data-copy-code）。
export function renderErrorCard(cfg) {
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const note = cfg.note ? `<div class="e-note">${cfg.note}</div>` : "";
  const btn = (a) => {
    if (typeof a === "string") return `<button class="e-btn">${a}</button>`;
    if (a.copy) return `<button class="e-btn" data-copy-code="1">${a.label}</button>`;
    return `<button class="e-btn" data-retry="1">${a.label}</button>`;
  };
  return (
    `<div class="msg-error">` +
      `<div class="e-head"><span>⛔</span><span>${cfg.title}</span><span class="e-time">${time}</span></div>` +
      `<div class="e-body">${cfg.body} <span class="e-code">${cfg.code}</span></div>` +
      note +
      `<div class="e-actions">${cfg.actions.map(btn).join("")}</div>` +
    `</div>`
  );
}

// 重试状态行（规格书 5.7 · 琥珀无框）：脉动圆点 + n/5 计数实时可见。
export function renderRetryLine(attempt) {
  return `<div class="retry-line"><span class="pulse"></span>⚡ 网络波动，正在自动重试 <b>${attempt}</b>/5 …</div>`;
}

// 恢复提示（规格书 5.8 · 绿色小字）：第 n 次重试成功，从断点继续写作。
export function renderRecoverLine(attempt) {
  return `<div class="recover-line">✓ 连接已恢复（第 ${attempt} 次重试成功），从断点继续写作</div>`;
}

// 去掉空白后的字符数（规格书 5.6：字数必须由 JS 从正文实时统计，禁止写死）。
function countChars(text) {
  return String(text ?? "").replace(/\s/g, "").length;
}

// ----- Fold state management for collapsible cards -----
const FOLD_PREFIX = "wwriting.card.fold.";

function getFoldKey(prefix, id) {
  return `${FOLD_PREFIX}${prefix}:${id}`;
}

function getFoldState(key, defaultFolded) {
  const val = localStorage.getItem(key);
  return val === null ? defaultFolded : val === "true";
}

function setFoldState(key, folded) {
  localStorage.setItem(key, String(folded));
}

function applyFold(headerEl, bodyEl, foldKey, defaultFolded) {
  const folded = getFoldState(foldKey, defaultFolded);
  bodyEl.hidden = folded;
  headerEl.classList.toggle("folded", folded);
  headerEl.addEventListener("click", (e) => {
    e.stopPropagation();
    const nowFolded = !bodyEl.hidden;
    bodyEl.hidden = nowFolded;
    headerEl.classList.toggle("folded", nowFolded);
    setFoldState(foldKey, nowFolded);
  });
}

const STAGE_ORDER = ["queued", "planning", "planned", "drafting", "reviewing", "needs_revision", "revising", "finalizing", "summarizing"];

const STEP_GROUPS = [
  { id: "planning", name: "规划", detail: "想好走向 · 埋下钩子", stages: ["queued", "planning", "planned"] },
  { id: "drafting", name: "写入章节", detail: "把故事写出来", stages: ["drafting"] },
  { id: "reviewing", name: "审稿", detail: "按写作清单检查", stages: ["reviewing", "needs_revision", "revising"] },
  { id: "finalizing", name: "定稿", detail: "归档进书稿", stages: ["finalizing", "summarizing"] }
];

// 任务卡标题：把 task.contract.kind 翻译成用户可读的任务类型；未知类型显示为“后台任务”。
const TASK_KIND_LABELS = {
  write_chapter: "写作",
  resume_chapter: "续写",
};

// 子步骤文案：只在对应大步骤 running 时展示，让用户看清"现在具体卡在哪一小步"
// （对照 Claude Code TodoWrite 三态模型的可见性思路，本地化为写作循环的实际粒度）。
function deriveSubstep(groupId, state) {
  if (groupId === "drafting") {
    const segmentNo = (state.current_segment_no ?? 0) + 1;
    return `第 ${segmentNo} 段`;
  }
  if (groupId === "reviewing") {
    const chapterKey = String(state.current_chapter_no ?? "");
    const rounds = state.active_budget?.fact_check_rounds_by_chapter?.[chapterKey];
    if (rounds) {
      return "正在核对设定";
    }
    return null;
  }
  return null;
}

function writingStepLabel(data, group, isActive) {
  if (group.id !== "drafting" || !isActive) {
    return group.name;
  }
  const chapterNo = Number(data.summary?.currentChapterNo ?? 0);
  if (!Number.isInteger(chapterNo) || chapterNo < 1) {
    return "写入章节中";
  }
  return `写入第 ${chapterNo} 章中`;
}

// 步骤时间线数据源：把 9 阶段折叠成 4 个对话级步骤，running 步骤附带子步骤文案。
export function computeSteps(data) {
  const run = deriveRunPresentation(data);
  const state = data.state ?? {};
  return STEP_GROUPS.map((group, i) => {
    const status = deriveStepState(run, group.stages, STAGE_ORDER);
    const writing = status === "running" && group.id === "drafting";
    return {
      name: writingStepLabel(data, group, writing),
      detail: group.detail,
      status,
      meta: {
        done: "状态：完成",
        running: writing ? "状态：书写中" : "状态：进行中",
        blocked: "状态：受阻",
        interrupted: "状态：已中断",
        cancelled: "状态：已停止",
        todo: "状态：排队"
      }[status],
      metaKind: writing ? "writing" : null,
      index: i + 1,
      ...(status === "running" ? { substep: deriveSubstep(group.id, state) } : {})
    };
  });
}

export function createThreadRenderer(ctx) {
  // ctx provides: refs, renderedKeys, askEntries, getLiveBlock, setLiveBlock,
  //   getDashboard, getCurrentProjectRoot, loadDashboard, handleRetry, handleStop,
  //   handleQuick, openReader, showToast, showActionError, announce, promoteAskEntry

  const MAX_VISIBLE_CHAPTER_CARDS = 3;

  let sessionHeadEl = null;
  let threadGreeted = false;
  // 当前一轮（live turn）状态：SSE 事件驱动的思考→工具→正文→完成态状态机。
  let liveTurn = null;

  function renderEmptyThread() {
    ctx.renderedKeys.clear();
    ctx.askEntries.clear();
    threadGreeted = false;
    liveTurn = null;
    ctx.setLiveBlock(null);
    const fragment = document.createDocumentFragment();
    fragment.append(buildSessionHead(null), buildGreeting());
    ctx.refs.thread.replaceChildren(fragment);
  }

  function buildSuggestionCards(data) {
    const suggestions = deriveSuggestions(data ?? ctx.getDashboard?.() ?? {});
    const wrap = document.createElement("div");
    wrap.className = "suggestion-cards";
    for (const item of suggestions) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "suggestion-card";
      card.textContent = item.label;
      card.addEventListener("click", () => {
        if (ctx.isChatBusy?.()) return;
        wrap.querySelectorAll(".suggestion-card").forEach((c) => { c.disabled = true; });
        ctx.submitText?.(item.message);
      });
      wrap.append(card);
    }
    return wrap;
  }

  function appendSuggestionCards(data) {
    const cards = buildSuggestionCards(data);
    ctx.refs.thread.append(cards);
    scrollThreadToBottom();
  }

  // 把后端事件流增量聚合成对话气泡。已渲染的事件用指纹去重，轮询时只追加新增气泡。
  function syncThread(data, firstLoad) {
    if (firstLoad) {
      threadGreeted = false;
    }
    const wrap = ctx.refs.threadWrap;
    const stick = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80;
    if (firstLoad) {
      ctx.refs.thread.append(buildSessionHead(data));
    } else {
      refreshSessionHead(data);
    }
    if (!threadGreeted && (data.events ?? []).length === 0) {
      ctx.refs.thread.append(buildGreeting());
      threadGreeted = true;
    }

    const events = [...(data.events ?? [])].sort((a, b) => timeValue(a.timestamp) - timeValue(b.timestamp));
    for (const event of events) {
      const key = eventKey(event);
      if (event.type === "user_instruction_received") {
        if (!ctx.renderedKeys.has(key)) {
          ctx.renderedKeys.add(key);
          ctx.refs.thread.append(buildUserBubble(event));
          ctx.announce("已发送指令");
        }
        continue;
      }
      if (event.type === "project_run_started") {
        if (!ctx.renderedKeys.has(key)) {
          ctx.renderedKeys.add(key);
          if (liveTurn && !liveTurn.done) {
            // live turn（SSE）已认领本轮：轮询只登记指纹，不重建旧式运行块，
            // 防止同一轮出现两套 agent 渲染。
            liveTurn.runStartedKey = key;
            liveTurn.chapterNo = event.chapter_no ?? liveTurn.chapterNo;
            continue;
          }
          const block = buildAgentBlock(event, data);
          ctx.setLiveBlock(block);
          ctx.refs.thread.append(block.root);
          ctx.announce("智能体开始写作");
        }
        continue;
      }
      // 运行内的阶段/章节/收尾事件，折叠进当前（持久于轮询之间的）运行气泡。
      appendRunDetail(ctx.getLiveBlock(), event, data, key);
    }
    // 运行中：把最新阶段/章节进度同步进当前运行气泡。
    updateLiveAgentBlock(data);
    // live turn 对账：段落标记字数回填 + SSE 断流时收尾兜底。
    reconcileLiveTurn(data);
    renderQueueCards(data.queue?.tasks ?? [], data);
    if (stick) scrollThreadToBottom();
  }

  function timeValue(value) {
    const ms = Date.parse(value ?? "");
    return Number.isNaN(ms) ? 0 : ms;
  }

  function eventKey(event) {
    return `${event.type}|${event.timestamp ?? ""}|${event.stage ?? ""}|${event.chapter_no ?? ""}|${event.message ?? ""}`;
  }

  function scrollThreadToBottom() {
    requestAnimationFrame(() => { ctx.refs.threadWrap.scrollTop = ctx.refs.threadWrap.scrollHeight; });
  }

  function buildSessionHead(data) {
    const wrap = document.createElement("div");
    wrap.className = "session-head";
    sessionHeadEl = wrap;
    if (!data) {
      const meta = document.createElement("div");
      meta.className = "session-meta";
      const h2 = document.createElement("h2");
      h2.textContent = "开始创作";
      const seed = document.createElement("p");
      seed.className = "session-seed";
      seed.textContent = "新建或打开一部小说，开始与智能体对话。";
      meta.append(h2, seed);
      wrap.append(meta);
      return wrap;
    }
    wrap.append(buildSessionHeadInner(data));
    return wrap;
  }

  function buildSessionHeadInner(data) {
    const frag = document.createDocumentFragment();
    const summary = data.summary ?? {};
    const project = data.project ?? {};
    const run = deriveRunPresentation(data);
    const identity = deriveProjectIdentity({ project, projectRoot: data.projectRoot });
    const titleRow = document.createElement("div");
    titleRow.className = "session-title session-title--trail";
    const cover = document.createElement("div");
    cover.className = "session-cover session-cover--trail";
    cover.dataset.projectTheme = identity.theme;
    cover.setAttribute("aria-hidden", "true");
    cover.textContent = identity.monogram;
    const meta = document.createElement("div");
    meta.className = "session-meta";
    const h2 = document.createElement("h2");
    h2.textContent = "创作记录";
    const seed = document.createElement("p");
    seed.className = "session-seed";
    seed.textContent = `${project.title ?? "未命名小说"} · 第 ${summary.currentChapterNo ?? 1} 章`;
    meta.append(h2, seed);
    titleRow.append(cover, meta);
    frag.append(titleRow);
    if (["interrupted", "cancelled", "running"].includes(run.status)) {
      const recovery = document.createElement("div");
      recovery.className = `recovery-card ${statusClass(run.status)}`;
      const text = document.createElement("span");
      const stage = translateStage(run.resumeStage);
      text.textContent = run.status === "running"
        ? `上次进展：第 ${run.chapterNo ?? "-"} 章 · ${stage}`
        : `第 ${run.chapterNo ?? "-"} 章在${stage}阶段${run.label}`;
      recovery.append(text);
      if (run.recoveryLabel) {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "task-action recovery-action";
        retry.textContent = run.recoveryLabel;
        retry.addEventListener("click", () => ctx.handleRetry());
        recovery.append(retry);
      }
      frag.append(recovery);
    }
    return frag;
  }

  function refreshSessionHead(data) {
    if (sessionHeadEl && sessionHeadEl.isConnected) sessionHeadEl.replaceChildren(buildSessionHeadInner(data));
  }

  function buildGreeting() {
    const currentProjectRoot = ctx.getCurrentProjectRoot();
    const wrap = document.createElement("div");
    // 规格书 P6：Agent 消息不带头像、不带署名行，直接以内容开始（2026-08-03 决定）。
    // msg-agent--plain：无头像列的单列网格（历史轮 buildAgentBlock 保留旧式带头像布局，defer 4）。
    wrap.className = "msg-agent msg-agent--plain rise";
    const body = document.createElement("div");
    body.className = "agent-body";
    const say = document.createElement("p");
    say.className = "agent-say";
    say.textContent = currentProjectRoot
      ? "我已就绪。直接告诉我你想做什么：写下一章、改一段正文、问设定或进度都行；输入 / 可以唤起命令。"
      : "你好，我是 WWriting 智能体。新建或从左侧打开一部小说后，告诉我故事的设定，我会规划、起草、审稿、定稿，并把每一章保存为本地文件。";
    const quick = buildQuickRow(currentProjectRoot ? ["续写下一章", "这本书的设定是什么？", "目前花了多少钱？"] : ["新建小说"]);
    body.append(say);
    if (quick) body.append(quick);
    wrap.append(body);
    return wrap;
  }

  function buildUserBubble(event) {
    const wrap = document.createElement("div");
    wrap.className = "msg-user rise";
    const bubble = document.createElement("div");
    bubble.className = "bubble-user";
    const mode = event.data?.mode;
    if (mode === "review") {
      const tag = document.createElement("span");
      tag.className = "cmd-tag";
      tag.textContent = "/review";
      bubble.append(tag);
    }
    bubble.append(document.createTextNode(event.message ?? ""));
    wrap.append(bubble);
    return wrap;
  }

  function renderQueueCards(tasks, data) {
    for (const task of tasks) {
      const key = `task:${task.id}`;
      let existing = ctx.refs.thread.querySelector(`[data-task-card-id="${cssEscape(task.id)}"]`);
      if (task.status === "running") {
        existing?.remove();
        continue;
      }
      const card = buildTaskCard(task, data);
      if (existing) {
        existing.replaceWith(card);
      } else if (!ctx.renderedKeys.has(key)) {
        ctx.renderedKeys.add(key);
        ctx.refs.thread.append(card);
      }
    }
  }

  function buildTaskCard(task, data) {
    const card = document.createElement("div");
    card.className = `task-card task-${statusClass(task.status)}`;
    card.dataset.taskCardId = task.id;

    const foldKey = getFoldKey("task", task.id);
    const isEnded = task.status === "completed" || task.status === "interrupted" || task.status === "cancelled";
    const defaultFolded = isEnded;

    const header = document.createElement("div");
    header.className = "task-header";
    const num = document.createElement("span");
    num.className = "task-num";
    // 标题用人类语言描述任务（类型 · 章节），不暴露单调递增的内部编号。
    const contract = task.contract ?? {};
    const kindLabel = TASK_KIND_LABELS[contract.kind] ?? "后台任务";
    const chapterNo = Number(contract.chapter_start) || null;
    num.textContent = chapterNo != null ? `${kindLabel} · 第 ${chapterNo} 章` : kindLabel;
    const badge = document.createElement("span");
    badge.className = `task-badge ${statusClass(task.status)}`;
    badge.textContent = translateTaskStatus(task.status);
    const chevron = document.createElement("span");
    chevron.className = "card-fold-chevron";
    chevron.textContent = "▸";
    header.append(num, badge, chevron);
    card.append(header);

    const body = document.createElement("div");
    body.className = "task-body";
    const instruction = document.createElement("div");
    instruction.className = "task-instruction";
    instruction.textContent = task.instruction ?? "";
    body.append(instruction);

    if (task.status === "queued") {
      const meta = document.createElement("div");
      meta.className = "task-meta";
      const queued = (data.queue?.tasks ?? []).filter((item) => item.status === "queued");
      const ahead = Math.max(0, queued.findIndex((item) => item.id === task.id));
      meta.textContent = ahead > 0 ? `前面还有 ${ahead} 个任务` : "下一个执行";
      const cancelBtn = document.createElement("button");
      cancelBtn.className = "task-action";
      cancelBtn.type = "button";
      cancelBtn.textContent = "取消";
      cancelBtn.addEventListener("click", () => cancelQueuedTask(task.id));
      body.append(meta, cancelBtn);
    } else if (task.status === "completed") {
      body.append(taskSummary(task, data));
    } else if (task.status === "blocked") {
      const reason = document.createElement("div");
      reason.className = "task-error";
      reason.textContent = task.error ?? "blocked";
      body.append(reason);
    } else if (task.status === "interrupted" || task.status === "cancelled") {
      const reason = document.createElement("div");
      reason.className = "task-error";
      reason.textContent = task.error ?? (task.status === "cancelled" ? "用户停止" : "任务中断");
      body.append(reason);
    }
    card.append(body);

    applyFold(header, body, foldKey, defaultFolded);
    return card;
  }

  function buildInlineProgress(task, data) {
    const wrap = document.createElement("div");
    wrap.className = "task-progress-wrap";
    const line = document.createElement("div");
    line.className = "task-progress-inline";
    const fill = document.createElement("div");
    fill.className = "task-progress-fill";
    const stageNames = STAGE_ORDER;
    const current = task.currentStage ?? data.summary?.currentStage ?? "queued";
    const idx = Math.max(0, stageNames.indexOf(current));
    fill.style.width = `${Math.round(((idx + 1) / stageNames.length) * 100)}%`;
    line.append(fill);
    const label = document.createElement("span");
    label.className = "task-progress-label";
    label.textContent = translateStage(current);
    wrap.append(line, label);
    return wrap;
  }

  function taskSummary(task, data) {
    const meta = document.createElement("div");
    meta.className = "task-meta";
    const words = data.summary?.totalWords ? `${formatNumber(data.summary.totalWords)} 字` : "已完成";
    const cost = (data.summary?.costAvailable && data.summary?.estimatedCost) ? ` · 约 ${data.summary.estimatedCost}` : "";
    meta.textContent = `${words}${cost}${task.completedAt ? ` · ${formatTime(task.completedAt)}` : ""}`;
    return meta;
  }

  async function cancelQueuedTask(taskId) {
    try {
      await postJson("/api/queue/cancel", { taskId });
      await ctx.loadDashboard();
    } catch (error) {
      ctx.showToast(error.message, "error");
    }
  }

  function translateTaskStatus(status) {
    if (status === "blocked") return "阻塞";
    return {
      queued: "排队中",
      running: "运行中",
      completed: "已完成",
      interrupted: "已中断",
      cancelled: "已停止"
    }[status] ?? status;
  }

  function buildQuickRow(items) {
    if (!items || items.length === 0) return null;
    const row = document.createElement("div");
    row.className = "quick-row";
    for (const label of items) {
      const chip = document.createElement("button");
      chip.className = "quick-chip";
      chip.type = "button";
      chip.append(icon("bolt", 13));
      chip.append(document.createTextNode(label));
      chip.addEventListener("click", () => {
        if (ctx.isChatBusy?.()) return;
        ctx.handleQuick(label);
      });
      row.append(chip);
    }
    return row;
  }

  // Task card: stage chips + subtitle line
  const STAGE_CHIPS = [
    { id: "planning", label: "规划", stages: ["queued", "planning", "planned"] },
    { id: "drafting", label: "起草", stages: ["drafting"] },
    { id: "reviewing", label: "审稿", stages: ["reviewing", "needs_revision", "revising"] },
    { id: "finalizing", label: "定稿", stages: ["finalizing", "summarizing"] }
  ];

  function updateStageChips(block, data) {
    if (!block || !block.stageRow) return;
    const summary = data.summary ?? {};
    const run = deriveRunPresentation(data);

    block.stageRow.replaceChildren(...STAGE_CHIPS.map((chip) => {
      const el = document.createElement("span");
      el.className = "run-stage-chip";
      const chipStatus = deriveStepState(run, chip.stages, STAGE_ORDER);
      if (chipStatus === "done") {
        el.classList.add("done");
      } else if (chipStatus === "running") {
        el.classList.add("active");
      } else if (chipStatus === "interrupted" || chipStatus === "cancelled") {
        el.classList.add(chipStatus);
      }
      el.textContent = chip.label;
      return el;
    }));

    // Subtitle: "第 N 章 · X 字 · ¥Y"
    const parts = [];
    const chNo = summary.currentChapterNo;
    if (chNo) parts.push(`第 ${chNo} 章`);
    const words = summary.totalWords;
    if (words != null && words > 0) parts.push(`${formatNumber(words)} 字`);
    if (summary.costAvailable && summary.estimatedCost) {
      parts.push(`¥${summary.estimatedCost}`);
    }
    block.subtitle.textContent = parts.join(" · ") || "准备中";

    // Stop button visibility: only when running. Cancelling is an
    // in-progress state — the user already pressed stop, so the button
    // must stay hidden until the run settles to a terminal state.
    if (block.stopBtn) {
      block.stopBtn.hidden = !run.isLive || run.status === "cancelling";
    }
  }

  // 一次运行 = 一个智能体气泡：含步骤时间线 + 完成后的章节卡 + 汇报文字。
  function buildAgentBlock(startEvent, data) {
    const wrap = document.createElement("div");
    wrap.className = "msg-agent rise";
    const avatar = document.createElement("div");
    avatar.className = "agent-avatar";
    avatar.textContent = "W";
    const body = document.createElement("div");
    body.className = "agent-body";
    const name = document.createElement("div");
    name.className = "agent-name";
    const strong = document.createElement("strong");
    strong.textContent = "WWriting 智能体";
    const time = document.createElement("span");
    time.className = "t";
    time.textContent = "工作中";
    name.append(strong, time);

    // --- Task card header: stage chips + subtitle + stop button ---
    const cardHeader = document.createElement("div");
    cardHeader.className = "run-card-header";
    const stageRow = document.createElement("div");
    stageRow.className = "run-stage-row";
    const subtitle = document.createElement("div");
    subtitle.className = "run-subtitle";
    const stopBtn = document.createElement("button");
    stopBtn.type = "button";
    stopBtn.className = "run-stop-btn";
    stopBtn.textContent = "停止";
    stopBtn.addEventListener("click", async () => {
      stopBtn.disabled = true;
      try {
        await ctx.handleStop();
      } catch (e) {
        stopBtn.disabled = false;
      }
    });
    cardHeader.append(stageRow, subtitle, stopBtn);

    const steps = document.createElement("div");
    steps.className = "steps";
    const say = document.createElement("p");
    say.className = "agent-say";
    say.hidden = true;
    body.append(name, cardHeader, steps, say);
    wrap.append(avatar, body);
    const block = { root: wrap, body, time, steps, say, chapter: null, quick: null, done: false, stageRow, subtitle, stopBtn };
    renderSteps(block, data);
    updateStageChips(block, data);
    return block;
  }

  function appendRunDetail(block, event, data, key) {
    if (!block || block.done) return;
    if (event.type === "chapter_completed" || event.type === "chapter_finalized") {
      if (!ctx.renderedKeys.has(key)) {
        ctx.renderedKeys.add(key);
        attachChapterCard(block, event.chapter_no, data);
      }
    }
    if (event.type === "project_run_finished" || event.type === "project_run_failed" || event.type === "project_blocked"
      || event.type === "project_interrupted" || event.type === "project_cancelled") {
      if (!ctx.renderedKeys.has(key)) {
        ctx.renderedKeys.add(key);
        finishAgentBlock(block, event, data);
      }
    }
  }

  // 步骤时间线：基于当前 summary 阶段把 9 阶段折叠成 4 个对话级步骤。
  function renderSteps(block, data) {
    const steps = computeSteps(data);
    block.steps.replaceChildren(...steps.map((step) => {
      const row = document.createElement("div");
      row.className = `step ${step.status}`;
      const ic = document.createElement("span");
      ic.className = "step-ic";
      if (step.status === "done") ic.append(icon("check", 13));
      else if (step.status === "running") { const s = document.createElement("span"); s.className = "spin"; ic.append(s); }
      else if (step.status === "blocked") ic.append(icon("help", 12));
      else { const n = document.createElement("span"); n.className = "mono"; n.style.fontSize = "10px"; n.textContent = String(step.index); ic.append(n); }
      const txt = document.createElement("span");
      txt.className = "step-txt";
      const strong = document.createElement("strong");
      strong.textContent = step.name;
      const small = document.createElement("small");
      small.textContent = step.detail;
      txt.append(strong, small);
      const meta = document.createElement("span");
      meta.className = `step-meta${step.metaKind ? ` ${step.metaKind}` : ""}`;
      meta.textContent = step.meta;
      if (step.metaKind === "writing") {
        meta.setAttribute("aria-label", "Writing...");
      }
      row.append(ic, txt, meta);
      if (step.substep) {
        const substepEl = document.createElement("span");
        substepEl.className = "step-substep";
        substepEl.textContent = step.substep;
        row.append(substepEl);
      }
      return row;
    }));
  }

  function attachChapterCard(block, chapterNo, data) {
    if (!chapterNo) return;
    if (block.body.querySelector(`[data-chapter-card="${chapterNo}"]`)) return;
    const chapter = (data.chapters ?? []).find((item) => item.chapter_no === chapterNo);
    const view = presentChapterArtifact({
      chapter: chapterNo,
      artifact: chapter?.artifact,
      projectStatus: data.summary?.projectStatus ?? null,
    });
    const card = document.createElement(view.canOpen ? "button" : "div");
    card.className = `filecard filecard-${view.tone}`;
    card.dataset.chapterCard = String(chapterNo);
    if (view.canOpen) {
      card.type = "button";
      card.addEventListener("click", () => ctx.openReader(chapterNo));
    }

    const top = document.createElement("span");
    top.className = "filecard-top";
    const fic = document.createElement("span");
    fic.className = "file-ic";
    fic.append(icon("doc", 16));
    const fid = document.createElement("span");
    fid.className = "file-id";
    const nm = document.createElement("span");
    nm.className = "name";
    nm.textContent = view.title;
    fid.append(nm);
    const badge = document.createElement("span");
    badge.className = "file-badge";
    badge.textContent = view.canOpen
      ? translateStage(chapter?.status ?? "completed")
      : view.detail;
    top.append(fic, fid, badge);

    const foot = document.createElement("span");
    foot.className = "filecard-foot";
    const words = document.createElement("span");
    words.className = "mono";
    words.textContent = `${formatNumber(chapter?.actual_words ?? 0)} 字`;
    if (view.canOpen) {
      const hint = document.createElement("span");
      hint.className = "open-hint";
      hint.append(document.createTextNode("打开阅读 "));
      hint.append(icon("chevR", 13));
      foot.append(words, document.createTextNode(" · 本地已保存 "), hint);
    } else if (view.detail) {
      foot.append(words, document.createTextNode(` · ${view.detail}`));
    } else {
      foot.append(words);
    }

    card.append(top, foot);
    // 插在汇报文字之前。
    block.body.insertBefore(card, block.say);
    if (view.canOpen) {
      block.chapter = chapterNo;
    }
    collapseOldChapterCards(block);
  }

  function collapseOldChapterCards(block) {
    const cards = [...block.body.querySelectorAll(".filecard")];
    if (cards.length <= MAX_VISIBLE_CHAPTER_CARDS) return;
    let rollup = block.body.querySelector(".filecard-rollup");
    if (!rollup) {
      rollup = document.createElement("button");
      rollup.type = "button";
      rollup.className = "filecard-rollup";
      rollup.dataset.count = "0";
      rollup.addEventListener("click", () => ctx.openDrawer?.("chapters"));
      block.body.insertBefore(rollup, cards[0]);
    }
    let count = Number(rollup.dataset.count ?? 0);
    for (const old of cards.slice(0, cards.length - MAX_VISIBLE_CHAPTER_CARDS)) {
      old.remove();
      count += 1;
    }
    rollup.dataset.count = String(count);
    rollup.textContent = `已收起 ${count} 张章节卡 · 点击在「章节」面板查看全部`;
  }

  function terminalMessage(run) {
    const chapter = run.chapterNo ?? "当前";
    const stage = translateStage(run.resumeStage);
    if (run.status === "interrupted") return `第 ${chapter} 章在${stage}阶段中断。草稿已保留。`;
    if (run.status === "cancelled") return `第 ${chapter} 章已停止。草稿已保留。`;
    if (run.status === "blocked") return `第 ${chapter} 章在${stage}阶段需要处理。`;
    return "本轮任务已完成。";
  }

  function finishAgentBlock(block, event, data) {
    const run = deriveRunPresentation(data);
    block.done = true;
    block.time.textContent = run.isTerminal && run.status !== "completed" ? run.label : "刚刚";
    renderSteps(block, data);
    updateStageChips(block, data);
    if (block.stopBtn) block.stopBtn.hidden = true;
    if (run.status === "interrupted" || run.status === "cancelled" || run.status === "blocked") {
      block.say.hidden = false;
      block.say.textContent = terminalMessage(run);
      ctx.announce(block.say.textContent);
      return;
    }
    if (event.type === "project_run_failed" || event.type === "project_blocked") {
      block.say.hidden = false;
      block.say.textContent = event.message ?? "运行已停止，请在右侧「运行」面板查看错误。";
      block.body.append(buildQuickRow(["打开运行面板"]));
      return;
    }
    block.say.hidden = false;
    // 保存结果由文件卡（"第 N 章已写入本地文件" + "打开阅读"）承载，这里只播报本轮任务结果。
    block.say.textContent = event.message ?? "本轮任务已完成。";
    ctx.announce(block.say.textContent);
    block.body.append(buildQuickRow(["续写下一章"]));
  }

  function insertByTs(container, node, ts) {
    const target = ts ? new Date(ts).getTime() : Date.now();
    const children = Array.from(container.children);
    for (const child of children) {
      const childTs = child.dataset.ts ? new Date(child.dataset.ts).getTime() : 0;
      if (childTs > target) {
        container.insertBefore(node, child);
        return;
      }
    }
    container.appendChild(node);
  }

  async function submitFailureAction(card, action) {
    // 兼容历史 failures.jsonl 里的旧嵌套形状 { command: { command, args } }
    const command = typeof action.command === "string" ? action.command : action.command?.command;
    const args = typeof action.command === "string" ? (action.args ?? {}) : (action.command?.args ?? {});
    if (command === "switch-model" && !args.modelId) {
      ctx.openSettingsModal?.();
      return;
    }
    if (command === "retry-with-prompt" && !String(args.prompt ?? "").trim()) {
      ctx.prefillComposer?.(`/write 重试第 ${card.chapterNo ?? ""} 章当前段，注意：`);
      return;
    }
    try {
      const result = await postJson("/api/failures/resolve", { command, args, failureId: card.id });
      ctx.showToast(result.message ?? "已提交处理。", result.resumed ? "success" : "info");
      void ctx.loadDashboard();
    } catch (error) {
      ctx.showActionError(error);
    }
  }

  function syncFailureCards(data) {
    const failures = deriveFailures(data);
    for (const card of failures) {
      const existing = ctx.refs.thread.querySelector(`[data-failure-id="${cssEscape(card.id)}"]`);
      if (existing) {
        const next = renderFailureCard(card, { onAction: submitFailureAction });
        if (card.resolution && !existing.querySelector(".failure-resolved")) {
          if (existing.dataset.motionResolving === "true") continue;
          existing.dataset.motionResolving = "true";
          motion.resolveFailureCard(existing, next, {
            commit: () => {
              delete existing.dataset.motionResolving;
              existing.replaceWith(next);
            }
          });
        } else {
          existing.replaceWith(next);
        }
        continue;
      }
      const node = renderFailureCard(card, { onAction: submitFailureAction });
      insertByTs(ctx.refs.thread, node, card.ts);
      motion.insertFailureCard(node);
    }
  }

  // 轮询期间把最新阶段同步进运行气泡；运行结束则松开引用，等收尾事件定稿。
  function updateLiveAgentBlock(data) {
    const liveBlock = ctx.getLiveBlock();
    if (!liveBlock || liveBlock.done || !liveBlock.root.isConnected) {
      ctx.setLiveBlock(null);
      return;
    }
    const run = deriveRunPresentation(data);
    if (run.isTerminal) {
      finishAgentBlock(liveBlock, { type: `project_${run.status}` }, data);
      ctx.setLiveBlock(null);
      return;
    }
    if (run.isLive) {
      renderSteps(liveBlock, data);
      updateStageChips(liveBlock, data);
      const ch = run.chapterNo;
      if (run.status === "cancelling") {
        liveBlock.time.textContent = ch ? `第 ${ch} 章 · 正在取消` : "正在取消";
        ctx.announce("正在停止");
      } else {
        liveBlock.time.textContent = ch ? `第 ${ch} 章 · 工作中` : "工作中";
        ctx.announce(ch ? `正在写第 ${ch} 章` : "工作中");
      }
    }
  }

  function buildSideBubble(entry) {
    const wrap = document.createElement("div");
    // 规格书 P6：Agent 消息不带头像，直接以内容开始（msg-agent--plain = 无头像列单列网格）。
    wrap.className = "msg-agent msg-agent--plain rise";
    const body = document.createElement("div");
    body.className = "agent-body";
    const card = document.createElement("div");
    card.className = `sidecard${entry.mainTaskAffecting ? " impact" : ""}`;
    const tag = document.createElement("span");
    tag.className = "side-tag";
    tag.append(icon("help", 13));
    tag.append(document.createTextNode(entry.mainTaskAffecting ? " 旁路问答 · 待确认变更" : " 旁路问答 · 临时提问"));
    const q = document.createElement("div");
    q.className = "side-q peek";
    q.textContent = entry.question;
    const a = document.createElement("div");
    a.className = "side-a peek";
    a.textContent = entry.answer || "（无回答）";
    const note = document.createElement("div");
    note.className = "side-note";
    note.textContent = "这个提问不会改动正文，仅供参考。";
    card.append(tag, q, a, note);
    if (entry.mainTaskAffecting && !entry.promoted) {
      card.append(buildAskConfirm(entry));
    }
    body.append(card);
    wrap.append(body);
    return wrap;
  }

  function buildAskConfirm(entry) {
    const confirm = document.createElement("div");
    confirm.className = "ask-confirm";
    const text = document.createElement("span");
    text.className = "ask-confirm-text";
    text.textContent = entry.suggestion ?? "这是会影响主线设定的修改建议。是否要将它加入正式写作任务？";
    const actions = document.createElement("div");
    actions.className = "ask-confirm-actions";
    const promote = document.createElement("button");
    promote.className = "small-button promote";
    promote.type = "button";
    promote.textContent = "加入正式写作任务";
    promote.addEventListener("click", async () => {
      promote.disabled = true;
      try {
        await ctx.promoteAskEntry(entry);
      } catch (error) {
        promote.disabled = false;
        ctx.showActionError(error);
      }
    });
    const dismiss = document.createElement("button");
    dismiss.className = "small-button";
    dismiss.type = "button";
    dismiss.textContent = "仅作参考";
    dismiss.addEventListener("click", () => {
      entry.promoted = true;
      confirm.remove();
    });
    actions.append(promote, dismiss);
    confirm.append(text, actions);
    return confirm;
  }

  // ===== S3 chat thread rendering =====

  // §3.4: 进程崩溃/中断时最后一条消息是 status:"generating" 占位，渲染为中断条。
  // spec §2.3-U1：中断是中性态，不是错误——neutral class + 中性灰样式（styles.css），
  // 不归 --err-* 红色系；文案改「上次对话未完成，可继续」。
  function buildInterruptedCard(allMessages) {
    const lastUserMsg = [...allMessages].reverse().find((m) => m.role === "user");
    if (!lastUserMsg) return null;
    const wrap = document.createElement("div");
    wrap.className = "msg-agent rise chat-bubble-wrap chat-bubble-wrap--interrupted";
    const card = document.createElement("div");
    card.className = "chat-interrupted-card neutral";
    const label = document.createElement("span");
    label.className = "chat-interrupted-label";
    label.textContent = "上次对话未完成，可继续";
    const text = document.createElement("span");
    text.className = "chat-interrupted-text";
    text.textContent = "对话进程在上次回复完成前退出，可重发消息。";
    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "small-button";
    retryBtn.textContent = "重发";
    retryBtn.addEventListener("click", () => {
      ctx.submitText?.(lastUserMsg.content ?? "");
    });
    card.append(label, text, retryBtn);
    wrap.append(card);
    return wrap;
  }

  // 气泡操作排：复制 / 重新发送（user）/ 重试本轮（assistant，仅最后一条显示，见 syncChatThread 收尾）。
  function buildMsgActions(message, allMessages) {
    const bar = document.createElement("div");
    bar.className = "msg-actions";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "msg-action";
    copy.dataset.testid = "msg-copy";
    copy.textContent = "复制";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(message.content ?? "");
        ctx.showToast("已复制。", "info");
      } catch {
        ctx.showToast("复制失败：剪贴板不可用。", "error");
      }
    });
    bar.append(copy);
    if (message.role === "user") {
      const resend = document.createElement("button");
      resend.type = "button";
      resend.className = "msg-action";
      resend.dataset.testid = "msg-resend";
      resend.textContent = "重新发送";
      resend.addEventListener("click", () => {
        ctx.submitText?.(message.content ?? "");
      });
      bar.append(resend);
    }
    if (message.role === "assistant") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "msg-action";
      retry.dataset.testid = "msg-retry";
      retry.hidden = true; // syncChatThread 收尾只放开最后一条 assistant 的
      retry.textContent = "重试本轮";
      retry.addEventListener("click", () => {
        const msgs = allMessages ?? [];
        const idx = msgs.findIndex((m) => m?.id === message.id);
        for (let i = (idx < 0 ? msgs.length : idx) - 1; i >= 0; i -= 1) {
          if (msgs[i]?.role === "user") {
            ctx.submitText?.(msgs[i].content ?? "");
            return;
          }
        }
        ctx.showToast("没有可重试的消息。", "info");
      });
      bar.append(retry);
    }
    return bar;
  }

  function renderUserBubble(message) {
    const wrap = document.createElement("div");
    wrap.className = "msg-user rise chat-bubble-wrap chat-bubble-wrap--user";
    wrap.dataset.ts = message.ts ?? "";
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble chat-bubble--user";
    const content = document.createElement("div");
    content.className = "chat-bubble-content";
    content.textContent = message.content ?? "";
    bubble.append(content);
    bubble.append(buildMsgActions(message));
    wrap.append(bubble);
    return wrap;
  }

  function renderAssistantBubble(message, allMessages) {
    const assistantContent = cleanAssistantContent(message.content ?? "");
    if (!assistantContent) return null;
    const wrap = document.createElement("div");
    wrap.className = "msg-agent rise chat-bubble-wrap chat-bubble-wrap--assistant";
    wrap.dataset.ts = message.ts ?? "";
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble chat-bubble--assistant";
    const proactiveBadge = { fact_check: "fact-check", timeline_check: "时间线" };
    if (message.proactive && proactiveBadge[message.proactive]) {
      const badge = document.createElement("span");
      badge.className = "chat-proactive-badge";
      badge.textContent = proactiveBadge[message.proactive];
      bubble.append(badge);
    }
    const body = document.createElement("div");
    body.className = "chat-bubble-content";
    body.innerHTML = renderMarkdown(assistantContent);
    bubble.append(body);
    const sources = deriveSources(allMessages ?? [], message);
    if (sources.length > 0) {
      const row = document.createElement("div");
      row.className = "chat-sources";
      const tag = document.createElement("span");
      tag.className = "chat-sources-tag";
      tag.textContent = "依据";
      row.append(tag);
      for (const chip of sources) {
        if (chip.chapterNo) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "chat-source-chip chat-source-chip--link";
          btn.dataset.testid = "chat-source-chapter";
          btn.textContent = chip.label;
          btn.title = chip.resultSummary;
          btn.addEventListener("click", () => ctx.openReader(chip.chapterNo));
          row.append(btn);
        } else {
          const span = document.createElement("span");
          span.className = "chat-source-chip";
          span.textContent = chip.label;
          span.title = chip.resultSummary;
          row.append(span);
        }
      }
      bubble.append(row);
    }
    if (Number.isFinite(message.cost) && message.cost > 0) {
      const cost = document.createElement("span");
      cost.className = "chat-cost";
      cost.textContent = message.cost < 0.01 ? "本轮 ＜¥0.01" : `本轮 ¥${message.cost.toFixed(2)}`;
      bubble.append(cost);
    }
    bubble.append(buildMsgActions(message, allMessages));
    wrap.append(bubble);
    return wrap;
  }

  function renderToolCard(message) {
    const msgId = message.id ?? `tool:${message.ts}:${message.tool ?? ""}`;

    // Codex 桌面端风格：工具调用统一渲染为内联折叠行（非卡片框）。
    // 成功/失败/SKIPPED/superseded 都展示；成功与 SKIPPED/superseded 默认折叠，失败默认展开。
    const tool = message.tool ?? "";
    const ok = message.ok !== false;
    const superseded = Boolean(message.superseded);
    // SKIPPED 类消息（聚合 batch_skipped 或旧式逐条 SKIPPED）：中性灰渲染，不归红色系
    // （spec §2.3-U1/U6）。检测依据：tool 名 + result_summary 前缀匹配已知两代协议格式
    // （聚合 "N 个后续操作已跳过…" / 旧式 "SKIPPED: …"）——不放宽到任意位置含「跳过」。
    const resultSummary = String(message.result_summary ?? "");
    const skipped = tool === "batch_skipped" || /^\d+ 个后续操作已跳过|^SKIPPED/u.test(resultSummary);
    const rowState = skipped ? "skipped" : (ok ? "ok" : "fail");
    const foldKey = getFoldKey("tool", msgId);

    const wrap = document.createElement("div");
    wrap.className = "msg-agent tool-inline";
    wrap.dataset.ts = message.ts ?? "";

    const row = document.createElement("div");
    row.className = `tool-inline-row ${rowState}${superseded ? " superseded" : ""}`;
    if (skipped) row.classList.add("tool-skipped-neutral"); // 中性灰降级标记（不归 --err-*）
    row.dataset.testid = "tool-inline-row";
    const chevron = document.createElement("span");
    chevron.className = "tool-inline-chevron";
    chevron.textContent = "▸";
    const label = document.createElement("span");
    label.className = "tool-inline-label";
    let labelText;
    if (skipped && tool === "batch_skipped") {
      // 聚合消息的行标签：从 summary 取数量，「· N 个操作已跳过」（不展示英文 batch_skipped）
      const count = /^(\d+) 个/u.exec(resultSummary)?.[1];
      labelText = count ? `${count} 个操作已跳过` : "后续操作已跳过";
    } else {
      labelText = toolLabel(tool, message.args);
    }
    label.textContent = superseded ? `已取消 · ${labelText}` : labelText;
    const mark = document.createElement("span");
    mark.className = `tool-inline-mark ${rowState}`;
    mark.textContent = superseded ? "" : (skipped ? "·" : (ok ? "✓" : "✗"));
    row.append(chevron, label, mark);
    wrap.append(row);

    const body = document.createElement("div");
    body.className = "tool-inline-body";
    if (message.result_summary) {
      const pre = document.createElement("pre");
      pre.textContent = message.result_summary;
      body.append(pre);
    }
    if (message.error) {
      const err = document.createElement("div");
      err.className = "tool-inline-error";
      err.textContent = message.error;
      body.append(err);
    }
    if (body.children.length > 0) {
      wrap.append(body);
      applyFold(row, body, foldKey, ok || superseded || skipped);
    } else {
      // 无结果摘要也无错误：没有可展开内容，隐藏折叠箭头，避免点开空白。
      chevron.style.visibility = "hidden";
    }
    return wrap;
  }

  function renderConfirmCard(pendingAction) {
    const wrap = document.createElement("div");
    wrap.className = "msg-agent rise chat-bubble-wrap chat-bubble-wrap--confirm";
    wrap.dataset.ts = pendingAction?.created_at ?? "";
    const card = document.createElement("div");
    card.className = "chat-confirm-card";
    const h4 = document.createElement("h4");
    h4.textContent = `待确认：${toolLabel(pendingAction?.tool, pendingAction?.args)}`;
    card.append(h4);
    if (pendingAction?.description) {
      const desc = document.createElement("p");
      desc.className = "chat-confirm-desc";
      desc.textContent = pendingAction.description;
      card.append(desc);
    }
    const preview = pendingAction?.preview;
    if (preview?.before != null || preview?.after != null) {
      if (pendingAction?.tool === "edit_chapter") {
        const diffWrap = document.createElement("div");
        diffWrap.className = "chat-confirm-diffwrap";
        const paraView = renderParagraphDiff(preview.before ?? "", preview.after ?? "");
        const lineView = renderDiff(preview.before ?? "", preview.after ?? "");
        lineView.hidden = true;
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "chat-diff-toggle";
        toggle.dataset.testid = "chat-diff-toggle";
        toggle.textContent = "行级详细";
        toggle.setAttribute("aria-pressed", "false");
        toggle.addEventListener("click", () => {
          const showLine = lineView.hidden;
          lineView.hidden = !showLine;
          paraView.hidden = showLine;
          toggle.textContent = showLine ? "段落对照" : "行级详细";
          toggle.setAttribute("aria-pressed", showLine ? "true" : "false");
        });
        diffWrap.append(paraView, lineView, toggle);
        card.append(diffWrap);
      } else {
        const diff = document.createElement("div");
        diff.className = "chat-confirm-diff";
        const before = document.createElement("div");
        before.className = "chat-confirm-before manuscript-text peek";
        before.textContent = preview?.before ?? "";
        const after = document.createElement("div");
        after.className = "chat-confirm-after manuscript-text peek";
        after.textContent = preview?.after ?? "";
        diff.append(before, after);
        card.append(diff);
      }
    }
    const buttons = document.createElement("div");
    buttons.className = "chat-confirm-buttons";
    const approve = document.createElement("button");
    approve.type = "button";
    approve.className = "chat-confirm-approve";
    approve.dataset.testid = "chat-confirm-approve";
    approve.textContent = "执行";
    const reject = document.createElement("button");
    reject.type = "button";
    reject.className = "chat-confirm-reject";
    reject.dataset.testid = "chat-confirm-reject";
    reject.textContent = "取消";
    approve.addEventListener("click", async () => {
      approve.disabled = true;
      reject.disabled = true;
      try {
        await confirmChatAction(true);
        card.classList.add("chat-confirm-card--resolved");
        if (typeof ctx.loadDashboard === "function") {
          void ctx.loadDashboard();
        }
      } catch (error) {
        approve.disabled = false;
        reject.disabled = false;
        ctx.showActionError?.(error);
      }
    });
    reject.addEventListener("click", async () => {
      approve.disabled = true;
      reject.disabled = true;
      try {
        await confirmChatAction(false);
        card.classList.add("chat-confirm-card--rejected");
        if (typeof ctx.loadDashboard === "function") {
          void ctx.loadDashboard();
        }
      } catch (error) {
        approve.disabled = false;
        reject.disabled = false;
        ctx.showActionError?.(error);
      }
    });
    buttons.append(approve, reject);
    card.append(buttons);
    wrap.append(card);
    return wrap;
  }

  // 渲染一条 chat 历史消息：根据 type 路由到对应渲染器。
  function renderChatMessage(message, allMessages) {
    if (!message) return null;
    if (message.role === "user") return renderUserBubble(message);
    if (message.role === "assistant") return renderAssistantBubble(message, allMessages);
    if (message.role === "tool") return renderToolCard(message);
    return null;
  }

  // 把 chat 历史刷进 thread，按 ts 升序插入。已渲染的项用指纹去重。
  function syncChatThread(history) {
    const messages = [...(history?.messages ?? [])].sort(
      (a, b) => timeValue(a.ts) - timeValue(b.ts)
    );

    // pendingAction 渲染（独立指纹防重，按 created_at 排序插入）
    if (history?.pendingAction) {
      const confirmKey = `chat:confirm:${history.pendingAction.id}`;
      if (!ctx.renderedKeys?.has(confirmKey)) {
        const confirmNode = renderConfirmCard(history.pendingAction);
        if (confirmNode) {
          insertByTs(ctx.refs.thread, confirmNode, history.pendingAction.created_at || new Date().toISOString());
          ctx.renderedKeys?.add(confirmKey);
        }
      }
    }

    if (messages.length === 0) {
      // 无聊天历史时不主动清理既有 thread；维持原 agent 事件流渲染。
      return;
    }
    const wrap = ctx.refs.threadWrap;
    const stick = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80;
    let appended = false;
    for (const message of messages) {
      const key = message.id ? `chat:${message.id}` : `chat:${message.role}:${message.ts}:${message.tool ?? ""}`;
      if (ctx.renderedKeys.has(key)) continue;
      const node = renderChatMessage(message, messages);
      if (!node) {
        ctx.renderedKeys.add(key);
        continue;
      }
      ctx.renderedKeys.add(key);
      insertByTs(ctx.refs.thread, node, message.ts);
      appended = true;
      if (message.role === "user") {
        // 持久化的 user 消息上屏后，移除 composer 的乐观气泡，防止重影。
        ctx.refs.thread.querySelector('[data-optimistic="user"]')?.remove();
      }
      if (message.role === "assistant") {
        ctx.announce("智能体已回复");
      }
    }
    const retryButtons = ctx.refs.thread.querySelectorAll('[data-testid="msg-retry"]');
    retryButtons.forEach((btn, i) => { btn.hidden = i !== retryButtons.length - 1; });

    // §3.4: 检查 last message 是否为 dangling generating 占位（进程崩溃/中断残留），渲染中断条
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.status === "generating") {
      const interruptKey = "chat:interrupted:generating";
      if (!ctx.renderedKeys?.has(interruptKey)) {
        const node = buildInterruptedCard(messages);
        if (node) {
          ctx.refs.thread.append(node);
          ctx.renderedKeys?.add(interruptKey);
          appended = true;
        }
      }
    }

    if (appended && stick) scrollThreadToBottom();
  }

  // 发送聊天消息的便捷方法（composer 暂未接入时也可单独调用）。
  async function submitChatMessage(message) {
    if (!message || !message.trim()) return null;
    try {
      const result = await sendChatMessage(message);
      if (typeof ctx.loadDashboard === "function") {
        void ctx.loadDashboard();
      }
      return result;
    } catch (error) {
      ctx.showActionError?.(error);
      throw error;
    }
  }

  // ===== 一轮（turn）状态机：SSE 事件驱动的过程→完成态渲染 =====
  // 规格书 P1/P3/P6（2026-08-03 定稿）：过程可见但不占位；折叠态即终态；
  // 无头像、无署名行，Agent 消息直接以内容开始。结构对齐定稿原型：
  // 思考块（流式展开→合拢）→ 工具行 → 流式正文（衬线+光标）→ 段落文字标记 → 完成态。

  function buildThinkBlock() {
    const el = document.createElement("div");
    el.className = "think-block hidden";
    const head = document.createElement("div");
    head.className = "think-head";
    const caret = document.createElement("span");
    caret.className = "caret";
    caret.textContent = "▶";
    const label = document.createElement("span");
    label.className = "label dotting";
    label.textContent = "思考中";
    head.append(caret, label);
    const body = document.createElement("div");
    body.className = "think-body";
    el.append(head, body);
    el.addEventListener("click", () => el.classList.toggle("open"));
    return { el, label, body };
  }

  function buildToolCard() {
    const el = document.createElement("div");
    el.className = "tool-card hidden";
    const ic = document.createElement("span");
    ic.className = "ic";
    ic.textContent = "✎";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = "正在撰写";
    const status = document.createElement("span");
    status.className = "status";
    el.append(ic, label, status);
    return { el, label, status };
  }

  function buildDoneCard() {
    const el = document.createElement("div");
    el.className = "done-card hidden";
    const head = document.createElement("div");
    head.className = "done-head";
    const ok = document.createElement("span");
    ok.className = "ok";
    ok.textContent = "✓";
    const title = document.createElement("span");
    title.className = "t";
    const toggle = document.createElement("span");
    toggle.className = "toggle";
    toggle.textContent = "展开 ⌄";
    head.append(ok, title, toggle);
    const meta = document.createElement("div");
    meta.className = "done-meta";
    const thinkChip = document.createElement("span");
    thinkChip.className = "meta-chip";
    thinkChip.textContent = "🧠 已思考";
    const paraChip = document.createElement("span");
    paraChip.className = "meta-chip";
    const wc = document.createElement("span");
    wc.className = "meta-chip";
    meta.append(thinkChip, paraChip, wc);
    const preview = document.createElement("div");
    preview.className = "done-preview";
    const detail = document.createElement("div");
    detail.className = "done-detail";
    const inner = document.createElement("div");
    inner.className = "detail-inner";
    const thinkBox = document.createElement("div");
    thinkBox.className = "detail-think";
    const lbl = document.createElement("span");
    lbl.className = "lbl";
    lbl.textContent = "思考过程";
    const thinkText = document.createElement("span");
    thinkBox.append(lbl, thinkText);
    const full = document.createElement("div");
    full.className = "full-text";
    inner.append(thinkBox, full);
    detail.append(inner);
    el.append(head, meta, preview, detail);
    head.addEventListener("click", () => el.classList.toggle("open"));
    return { el, title, paraChip, wc, preview, thinkBox, thinkText, full };
  }

  // 归属守卫：live turn 只属于启动它时的那个项目。
  // 解决两个遗留问题——切到无项目时旧 SSE 不 close、切项目后 ≤1.8s 窗口内旧事件可能送达：
  // 事件到达时若当前项目已不是 turn 归属项目，一律丢弃并释放 live turn。
  function turnIsCurrent(turn) {
    return Boolean(turn) && turn.projectRoot === ctx.getCurrentProjectRoot();
  }

  function startLiveTurn(userEvent) {
    const projectRoot = ctx.getCurrentProjectRoot();
    if (!projectRoot) return null; // 无项目不渲染 live turn
    const key = eventKey(userEvent);
    if (ctx.renderedKeys.has(key)) return null; // 轮询已渲染过这条用户气泡

    ctx.renderedKeys.add(key);
    ctx.refs.thread.append(buildUserBubble(userEvent));

    const root = document.createElement("div");
    root.className = "turn-agent rise";
    const think = buildThinkBlock();
    const tool = buildToolCard();
    const statusSlot = document.createElement("div");
    statusSlot.className = "status-slot hidden";
    const streamEl = document.createElement("div");
    streamEl.className = "stream-area";
    const chipsEl = document.createElement("div");
    chipsEl.className = "para-chips hidden";
    const peekSlot = document.createElement("div");
    peekSlot.className = "peek-slot";
    const errorSlot = document.createElement("div");
    errorSlot.className = "error-slot hidden";
    const done = buildDoneCard();
    root.append(think.el, tool.el, statusSlot, streamEl, chipsEl, peekSlot, errorSlot, done.el);
    ctx.refs.thread.append(root);

    // 段落圆片：点开偷看该段原文（规格书 5.5），再点收起。
    chipsEl.addEventListener("click", (e) => {
      const chip = e.target.closest(".p-chip");
      if (!chip || chip._peek === undefined) return;
      if (peekSlot.dataset.open === chip._key) {
        peekSlot.replaceChildren();
        peekSlot.dataset.open = "";
        return;
      }
      peekSlot.replaceChildren();
      const peek = document.createElement("div");
      peek.className = "para-peek";
      peek.textContent = chip._peek;
      peekSlot.append(peek);
      peekSlot.dataset.open = chip._key;
    });

    const turn = {
      projectRoot,
      root,
      thinkEl: think.el, thinkLabel: think.label, thinkBody: think.body,
      toolEl: tool.el, toolLabel: tool.label, toolStatus: tool.status,
      statusSlot, streamEl, chipsEl, peekSlot, errorSlot,
      doneEl: done.el, doneTitle: done.title, doneParaChip: done.paraChip,
      doneWc: done.wc, donePreview: done.preview,
      doneThinkBox: done.thinkBox, doneThink: done.thinkText, doneFull: done.full,
      phase: "idle", // idle | planning | drafting | done
      chapterNo: null,
      chapters: [],          // [{ chapterNo, text, unfinished }]
      chapterContents: {},   // chapterNo -> 正文（完成态从磁盘回填）
      thinkText: "",
      para: null,            // 当前流式 para 元素
      paraText: "",          // 当前 para 累积文本
      done: false,
      runStartedKey: null,
    };
    liveTurn = turn;
    ctx.announce("已发送指令");
    scrollThreadToBottom();
    return turn;
  }

  function showThink(turn) {
    turn.phase = "planning";
    turn.thinkEl.classList.remove("hidden");
    turn.thinkEl.classList.add("open");
    turn.thinkLabel.textContent = "思考中";
    turn.thinkLabel.classList.add("dotting");
  }

  function startDrafting(turn, event) {
    turn.chapterNo = event.chapter_no ?? turn.chapterNo;
    turn.phase = "drafting";
    turn.thinkEl.classList.remove("open");
    turn.thinkLabel.textContent = "已思考";
    turn.thinkLabel.classList.remove("dotting");
    const ch = turn.chapterNo;
    turn.toolEl.classList.remove("hidden");
    turn.toolLabel.textContent = ch ? `正在撰写 第 ${ch} 章` : "正在撰写";
    turn.toolStatus.textContent = "进行中";
    turn.toolStatus.classList.remove("bad");
  }

  function ensurePara(turn) {
    if (turn.para) return turn.para;
    const para = document.createElement("div");
    para.className = "para";
    turn.streamEl.append(para);
    turn.para = para;
    turn.paraText = "";
    return para;
  }

  function appendParaText(turn, text) {
    const para = ensurePara(turn);
    turn.paraText += text;
    para.textContent = turn.paraText;
    const cursor = document.createElement("span");
    cursor.className = "cursor";
    para.append(cursor);
  }

  // 章节完成的当下 dashboard 未必已落盘 actual_words，先用流式文本统计；
  // 后续轮询对账（reconcileLiveTurn）会用真实字数回填。
  function dashboardChapterWords(chapterNo) {
    const chapters = ctx.getDashboard?.()?.chapters ?? [];
    const found = chapters.find((c) => Number(c.chapter_no) === Number(chapterNo));
    return found ? Number(found.actual_words ?? 0) : 0;
  }

  function foldChapter(turn, chapterNo) {
    if (!chapterNo || turn.done) return;
    if (turn.chapters.some((c) => c.chapterNo === chapterNo)) return; // 去重
    const text = turn.paraText ?? "";
    turn.chapters.push({ chapterNo, text, unfinished: false });
    if (turn.para) {
      turn.para.classList.add("folding");
      const el = turn.para;
      setTimeout(() => el.remove(), 380); // 0.38s 高度折叠动画后移除
      turn.para = null;
      turn.paraText = "";
    }
    const chip = document.createElement("span");
    chip.className = "p-chip";
    chip.dataset.chapterNo = String(chapterNo);
    const words = countChars(text) || dashboardChapterWords(chapterNo);
    chip.textContent = `📖 第 ${chapterNo} 章` + (words > 0 ? ` · ${words} 字` : "");
    if (text) {
      chip._peek = text;
      chip._key = `para-${chapterNo}-${turn.chapters.length}`;
      chip.title = "点击偷看本段";
    }
    turn.chipsEl.classList.remove("hidden");
    turn.chipsEl.append(chip);
    turn.toolStatus.textContent = `完成 ✓ ${turn.chapters.length}`;
    scrollThreadToBottom();
  }

  // 轮询对账：段落标记字数回填；SSE 断流（如重连窗口）时轮询看到终态则收尾本轮。
  function reconcileLiveTurn(data) {
    const turn = liveTurn;
    if (!turn || turn.done) return;
    if (!turnIsCurrent(turn)) { liveTurn = null; return; }
    const chapters = data?.chapters ?? [];
    for (const chip of turn.chipsEl.querySelectorAll(".p-chip[data-chapter-no]")) {
      const n = Number(chip.dataset.chapterNo);
      const chapter = chapters.find((c) => Number(c.chapter_no) === n);
      const words = chapter ? Number(chapter.actual_words ?? 0) : 0;
      if (words > 0) chip.textContent = `📖 第 ${n} 章 · ${words} 字`;
    }
    const run = deriveRunPresentation(data ?? {});
    if (run.isTerminal) {
      const kind = run.status === "interrupted" ? "interrupted"
        : run.status === "cancelled" ? "cancelled"
        : run.status === "blocked" ? "blocked"
        : "finished";
      closeTurnToDone(turn, { type: `project_${run.status}`, message: run.label ?? "" }, kind);
    }
  }

  // 残段（若有）收成「（未完成）」文字标记（规格书 5.5 / 6.2）。
  // 成功/中断/取消/受阻/失败共用：失败路径（failTurn）同样要求残段折叠、过程不占位。
  function foldResidueParagraph(turn) {
    if (!turn.para || !turn.paraText) return;
    const text = turn.paraText;
    const chip = document.createElement("span");
    chip.className = "p-chip unfinished";
    chip.dataset.chapterNo = String(turn.chapterNo ?? "");
    chip.textContent = `📖 第 ${turn.chapterNo} 章（未完成）· ${countChars(text)} 字`;
    chip._peek = text;
    chip._key = `para-${turn.chapterNo}-residue`;
    chip.title = "点击偷看本段";
    turn.chipsEl.classList.remove("hidden");
    turn.chipsEl.append(chip);
    turn.para.classList.add("folding");
    const el = turn.para;
    setTimeout(() => el.remove(), 380);
    turn.para = null;
    turn.paraText = "";
  }

  function closeTurnToDone(turn, event, kind = "finished") {
    if (turn.done) return;
    turn.done = true;

    // 残段（若有）收成「（未完成）」文字标记（规格书 5.5 / 6.2）。
    foldResidueParagraph(turn);

    // 过程区清空：思考/工具/状态行/段落标记/偷看区/正文区整体消失（P1/P3）。
    turn.thinkEl.classList.add("hidden");
    turn.toolEl.classList.add("hidden");
    turn.statusSlot.classList.add("hidden");
    turn.chipsEl.classList.add("hidden");
    turn.peekSlot.replaceChildren();
    turn.streamEl.replaceChildren();

    // 完成卡（折叠终态，无卡片无边框）：标题 / 摘要标记 / 衬线预览 / 展开全文。
    const nums = turn.chapters.map((c) => c.chapterNo).filter(Boolean);
    const paused = kind === "finished" && event?.data?.paused === true;
    if (nums.length > 1) {
      turn.doneTitle.textContent = paused
        ? `第 ${nums[0]}–${nums[nums.length - 1]} 章 · 已暂停`
        : `第 ${nums[0]}–${nums[nums.length - 1]} 章 · 全部完成`;
    } else if (nums.length === 1) {
      turn.doneTitle.textContent = paused ? `第 ${nums[0]} 章 · 已暂停`
        : kind === "interrupted" ? `第 ${nums[0]} 章 · 已中断`
        : kind === "cancelled" ? `第 ${nums[0]} 章 · 已停止`
        : kind === "blocked" ? `第 ${nums[0]} 章 · 需要处理`
        : `第 ${nums[0]} 章 · 已完成`;
    } else {
      turn.doneTitle.textContent = kind === "interrupted" ? "本轮写作已中断"
        : kind === "cancelled" ? "本轮写作已停止"
        : paused ? "本轮写作已暂停"
        : "本轮写作已完成";
    }
    turn.doneParaChip.textContent = turn.chapters.length > 0 ? `✎ 撰写 ${turn.chapters.length} 章` : "";
    const streamed = turn.chapters.map((c) => c.text).filter(Boolean).join("\n\n");
    turn.doneWc.textContent = `${countChars(streamed)} 字`;
    turn.donePreview.textContent = streamed ? `“${streamed.trim().slice(0, 24)}……”` : "";
    if (turn.thinkText) {
      turn.doneThink.textContent = turn.thinkText;
      turn.doneThinkBox.hidden = false;
    } else {
      turn.doneThinkBox.hidden = true;
    }
    turn.doneFull.textContent = streamed;
    turn.doneEl.classList.remove("hidden");
    turn.doneEl.classList.add("enter");

    // 正文回填：写作主调用的 delta 流在默认配置下为空（非流式 + 工具调用），
    // 完成态展开全文从磁盘章节文件读取真实正文（含实时字数统计）。
    if (kind === "finished" && nums.length > 0) {
      void refreshDoneFromChapterFiles(turn);
    }

    if (event?.message) ctx.announce(event.message);
  }

  async function refreshDoneFromChapterFiles(turn) {
    const nums = turn.chapters.map((c) => c.chapterNo).filter(Boolean);
    await Promise.all(nums.map(async (n) => {
      try {
        const data = await getJson(`/api/chapters/read?chapter=${encodeURIComponent(n)}`);
        if (!data?.ok || typeof data.content !== "string" || !data.content.trim()) return;
        if (liveTurn !== turn || !turnIsCurrent(turn)) return; // 已切项目/已换轮则丢弃
        turn.chapterContents[n] = data.content;
        applyDoneContent(turn);
      } catch { /* 文件尚未落盘或读取失败：保持已流式文本 */ }
    }));
  }

  function applyDoneContent(turn) {
    const full = turn.chapters
      .map((c) => turn.chapterContents[c.chapterNo] ?? c.text)
      .filter(Boolean)
      .join("\n\n");
    if (!full) return;
    turn.doneFull.textContent = full;
    turn.doneWc.textContent = `${countChars(full)} 字`;
    turn.donePreview.textContent = `“${full.trim().slice(0, 24)}……”`;
  }

  // project_run_failed 红卡（规格书 5.9）：人话 + 错误码徽章 + 操作按钮。
  // 手动重试走 ctx.handleRetry（app.js 复用 POST /api/run/retry，并带 toast/刷新兜底），
  // 比裸 fetch 更完整；data-retry 按钮的绑定语义与规格书 6.3「手动重试」一致。
  // 动作集按失败类型区分（规格书 6.2/6.3 + 定稿原型 S4/S5）：
  //  - 网络耗尽（data.status 为空，如 reason:"timeout"）→「↻ 重试」+「↻ 继续写作」+「复制错误详情」；
  //    POST /api/run/retry 实为从保存状态创建 recovery task（断点续写语义），「继续写作」才是耗尽卡准确文案。
  //  - 鉴权/配置类（data.status 非空，如 401）→「↻ 重试」。
  // 两个按钮点击行为都走既有 ctx.handleRetry（内部 POST /api/run/retry）。
  function failTurn(turn, event) {
    const data = event.data ?? {};
    const status = data.status ?? null;
    const reason = data.reason ?? null;
    const name = data.name ?? null;
    const title = status ? `模型调用失败 · ${status}` : (name ? `写作任务失败 · ${name}` : "写作任务失败");
    const code = [status, reason].filter(Boolean).join(" · ") || name || "unknown_error";
    // 规格书 6.2/5.3：失败同样把已流出的残段折叠为「（未完成）」文字标记，
    // 工具行状态变红「已中断」——错误显性化，不留未折叠的过程元素占位。
    foldResidueParagraph(turn);
    if (!turn.toolEl.classList.contains("hidden")) {
      turn.toolStatus.textContent = "已中断";
      turn.toolStatus.classList.add("bad");
    }
    const actions = status
      ? [{ label: "↻ 重试", retry: true }]
      : [{ label: "↻ 重试", retry: true }, { label: "↻ 继续写作", retry: true }, { label: "复制错误详情", copy: true }];
    const card = document.createElement("div");
    card.innerHTML = renderErrorCard({
      title,
      body: event.message ?? "写作任务未能完成，可手动重试。",
      code,
      note: "已保留当前进度。",
      actions
    });
    card.querySelectorAll("[data-retry]").forEach((btn) => {
      btn.addEventListener("click", () => ctx.handleRetry?.());
    });
    // 「复制错误详情」：把错误码徽章 + 人话文案复制到剪贴板（Electron 渲染进程 clipboard API）。
    card.querySelector("[data-copy-code]")?.addEventListener("click", () => {
      const text = `${code}${event.message ? `\n${event.message}` : ""}`;
      globalThis.navigator?.clipboard?.writeText?.(text)?.catch?.(() => {});
    });
    turn.errorSlot.replaceChildren(card);
    turn.errorSlot.classList.remove("hidden");
    turn.done = true;
    if (event.message) ctx.announce(event.message);
  }

  return {
    syncThread,
    renderEmptyThread,
    syncFailureCards,
    updateLiveAgentBlock,
    buildSideBubble,
    scrollThreadToBottom,
    renderChatMessage,
    syncChatThread,
    submitChatMessage,
    appendSuggestionCards,
    // SSE 增量事件入口（Task 11 落地 live turn 状态机）：
    // user_instruction_received 开新轮；stage_started/model_call_started 显示思考/工具行；
    // chapter_completed 折叠段落；project_run_finished 清过程区、完成态淡入。
    onRunEvent(event) {
      if (!event || typeof event !== "object") return;
      if (event.type === "user_instruction_received") {
        startLiveTurn(event);
        return;
      }
      const turn = liveTurn;
      if (!turn || turn.done) return;
      // 归属守卫：事件到达时若 liveTurn 不属于当前项目（切项目/切无项目），丢弃。
      if (!turnIsCurrent(turn)) { liveTurn = null; return; }
      switch (event.type) {
        case "project_run_started":
          // live turn 认领本轮运行：轮询兜底不再重建旧式运行块。
          turn.runStartedKey = eventKey(event);
          ctx.renderedKeys.add(turn.runStartedKey);
          turn.chapterNo = event.chapter_no ?? turn.chapterNo;
          break;
        case "stage_started":
          if (event.stage === "planning") showThink(turn);
          break;
        case "model_call_started":
          if (event.stage === "planning") showThink(turn);
          else if (event.stage === "drafting") startDrafting(turn, event);
          break;
        case "chapter_completed":
        case "chapter_finalized":
          foldChapter(turn, event.chapter_no);
          break;
        case "project_run_finished":
          closeTurnToDone(turn, event, "finished");
          break;
        case "project_run_failed":
          failTurn(turn, event);
          break;
        case "project_cancelled":
          closeTurnToDone(turn, event, "cancelled");
          break;
        case "project_interrupted":
          closeTurnToDone(turn, event, "interrupted");
          break;
        case "project_blocked":
          // 与轮询分支（reconcileLiveTurn kind=blocked）统一：终态标题「需要处理」。
          closeTurnToDone(turn, event, "blocked");
          break;
        case "model_retry":
          // 琥珀重试行（规格书 5.7/6.2）：n/5 计数实时可见——每次事件用最新 attempt 重渲染。
          turn.statusSlot.innerHTML = renderRetryLine(event.data?.attempt ?? 1);
          turn.statusSlot.classList.remove("hidden");
          break;
        case "status_message":
          // 恢复提示（规格书 5.8/6.2）：绿字「已连接恢复…从断点继续写作」。
          if (/恢复/.test(event.message ?? "")) {
            turn.statusSlot.innerHTML = renderRecoverLine(event.data?.attempt ?? 1);
            turn.statusSlot.classList.remove("hidden");
          }
          break;
        default:
          break;
      }
    },
    // live 正文/思考逐字追加：planning 阶段进思考块，drafting 阶段进正文区（衬线 + 光标）。
    onModelDelta(text) {
      const turn = liveTurn;
      if (!turn || turn.done) return;
      if (!turnIsCurrent(turn)) { liveTurn = null; return; }
      const chunk = String(text ?? "");
      if (!chunk) return; // 心跳（无正文）不上屏
      if (turn.phase === "planning") {
        turn.thinkText += chunk;
        turn.thinkBody.textContent = turn.thinkText;
      } else if (turn.phase === "drafting") {
        appendParaText(turn, chunk);
      }
    }
  };
}
