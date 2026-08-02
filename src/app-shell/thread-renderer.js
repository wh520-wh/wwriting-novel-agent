import { icon } from "./icons.js";
import { formatTime, formatNumber, cssEscape, translateStage, statusClass } from "./utils.js";
import { motion } from "./motion-runtime.js";
import { renderFailureCard } from "./components/failure-card.js";
import { renderDiff, renderParagraphDiff } from "./diff-view.js";
import { deriveFailures } from "./agent-truth.mjs";
import { deriveRunPresentation, deriveStepState } from "./run-presentation.mjs";
import { postJson } from "./api-client.js";
import { sendChatMessage, confirmChatAction } from "./api-client.js";
import { renderMarkdown, cleanAssistantContent } from "./markdown-lite.mjs";
import { toolLabel } from "./tool-labels.mjs";
import { deriveSources, deriveSuggestions } from "./chat-derive.mjs";
import { presentChapterArtifact } from "./chapter-presentation.mjs";
import { deriveProjectIdentity } from "./project-identity.mjs";

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
    const maxRounds = state.active_budget?.max_fact_check_rounds_per_chapter ?? 3;
    if (rounds) {
      return `事实核对 第 ${rounds}/${maxRounds} 轮`;
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

  function renderEmptyThread() {
    ctx.renderedKeys.clear();
    ctx.askEntries.clear();
    threadGreeted = false;
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
    name.append(strong);
    const say = document.createElement("p");
    say.className = "agent-say";
    say.textContent = currentProjectRoot
      ? "我已就绪。直接告诉我你想做什么：写下一章、改一段正文、问设定或进度都行；输入 / 可以唤起命令。"
      : "你好，我是 WWriting 智能体。新建或从左侧打开一部小说后，告诉我故事的设定，我会规划、起草、审稿、定稿，并把每一章保存为本地文件。";
    const quick = buildQuickRow(currentProjectRoot ? ["续写下一章", "这本书的设定是什么？", "目前花了多少钱？"] : ["新建小说"]);
    body.append(name, say);
    if (quick) body.append(quick);
    wrap.append(avatar, body);
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
    const path = document.createElement("span");
    path.className = "path";
    path.textContent = `chapters/${String(chapterNo).padStart(3, "0")}.md`;
    const nm = document.createElement("span");
    nm.className = "name";
    nm.textContent = view.title;
    fid.append(path, nm);
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
    wrap.className = "msg-agent rise";
    const avatar = document.createElement("div");
    avatar.className = "agent-avatar side";
    avatar.textContent = "?";
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
    note.textContent = "side_questions.md · 不影响正文 / task_plan.md / progress.md";
    card.append(tag, q, a, note);
    if (entry.mainTaskAffecting && !entry.promoted) {
      card.append(buildAskConfirm(entry));
    }
    body.append(card);
    wrap.append(avatar, body);
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
  function buildInterruptedCard(allMessages) {
    const lastUserMsg = [...allMessages].reverse().find((m) => m.role === "user");
    if (!lastUserMsg) return null;
    const wrap = document.createElement("div");
    wrap.className = "msg-agent rise chat-bubble-wrap chat-bubble-wrap--interrupted";
    const card = document.createElement("div");
    card.className = "chat-interrupted-card";
    const label = document.createElement("span");
    label.className = "chat-interrupted-label";
    label.textContent = "上一轮被中断";
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
      cost.textContent = `本轮 ¥${message.cost.toFixed(4)}`;
      bubble.append(cost);
    }
    bubble.append(buildMsgActions(message, allMessages));
    wrap.append(bubble);
    return wrap;
  }

  function renderToolCard(message) {
    const msgId = message.id ?? `tool:${message.ts}:${message.tool ?? ""}`;

    // Codex 桌面端风格：工具调用统一渲染为内联折叠行（非卡片框）。
    // 成功/失败/superseded 都展示；成功与 superseded 默认折叠，失败默认展开。
    const tool = message.tool ?? "";
    const ok = message.ok !== false;
    const superseded = Boolean(message.superseded);
    const foldKey = getFoldKey("tool", msgId);

    const wrap = document.createElement("div");
    wrap.className = "msg-agent tool-inline";
    wrap.dataset.ts = message.ts ?? "";

    const row = document.createElement("div");
    row.className = `tool-inline-row ${ok ? "ok" : "fail"}${superseded ? " superseded" : ""}`;
    row.dataset.testid = "tool-inline-row";
    const chevron = document.createElement("span");
    chevron.className = "tool-inline-chevron";
    chevron.textContent = "▸";
    const label = document.createElement("span");
    label.className = "tool-inline-label";
    label.textContent = superseded ? `已取消 · ${toolLabel(tool, message.args)}` : toolLabel(tool, message.args);
    const mark = document.createElement("span");
    mark.className = `tool-inline-mark ${ok ? "ok" : "fail"}`;
    mark.textContent = superseded ? "⊘" : (ok ? "✓" : "✗");
    row.append(chevron, label, mark);
    wrap.append(row);

    const body = document.createElement("div");
    body.className = "tool-inline-body";
    const tech = document.createElement("div");
    tech.className = "tool-inline-tech mono";
    tech.textContent = `${tool} ${message.args ?? ""}`.trim();
    body.append(tech);
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
    wrap.append(body);

    applyFold(row, body, foldKey, ok || superseded);
    return wrap;
  }

  function renderConfirmCard(pendingAction) {
    const wrap = document.createElement("div");
    wrap.className = "msg-agent rise chat-bubble-wrap chat-bubble-wrap--confirm";
    wrap.dataset.ts = pendingAction?.created_at ?? "";
    const card = document.createElement("div");
    card.className = "chat-confirm-card";
    const h4 = document.createElement("h4");
    h4.textContent = `待确认操作：${pendingAction?.tool ?? ""}`;
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
    appendSuggestionCards
  };
}
