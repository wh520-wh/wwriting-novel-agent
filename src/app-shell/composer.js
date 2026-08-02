import { icon } from "./icons.js";
import { postJson, sendChatMessage, stopChat } from "./api-client.js";
import { toolLabel } from "./tool-labels.mjs";
import { getCommand, listCommands } from "./command-registry.mjs";
import "./commands/index.mjs";  // side-effect: register 5 built-in commands
import { PERMISSION_TIERS, detectPermissionTier, getTierById } from "./permission-tiers.mjs";
import { saveDraft, loadDraft, clearDraft } from "./composer-draft.mjs";
import { saveDefaultTier } from "./permission-defaults.mjs";

// 旁路询问命令前缀（与后端 side-question.mjs 保持一致；禁止使用 /btw）。
const SIDE_QUESTION_PREFIXES = ["/ask", "/side", "/q"];
const REVIEW_PREFIXES = ["/review", "/审稿"];
const WRITE_PREFIXES = ["/write", "/写作"];
const MODEL_PREFIXES = ["/model", "/模型"];
// 命中则说明旁路询问其实包含修改主线设定/正文的诉求，需要确认后才转正式任务。
const MAIN_TASK_IMPACT_PATTERN = /(改成|改为|改掉|改写|写成|换成|替换|删除|删掉|去掉|移除|重写|改编|不要写|不再写|别写|不写|推翻|重新设定|改设定|改人设|改世界观|改大纲|改结局|改剧情|黑化|洗白|复活|写死|赐死|领便当|降智|崩坏|让.{0,6}死|让.{0,6}活|让.{0,8}(在一起|分手|退场|出局|登场|加入|离开|背叛|反水))/u;

// 明确的「开始/继续写作」祈使意图：命中则走硬启动（submitWritingCommand），
// 不再把成败押在弱模型是否自觉调用 start_run 上。保守匹配——宁可漏判走对话，
// 也不能把含疑问/条件/转折/否定的句子误判成启动指令。
const START_WRITING_CORE = /^(请|帮我|帮忙|麻烦|那|那就|就|你)?\s*(现在|马上|立刻|赶紧|这就)?\s*(开始|继续|接着|往下|开)?\s*(写作|写|创作|续写|开写)\s*(第?\s*[一二三四五六七八九十百千零\d]+\s*章|下一?章|正文|下去|起来)?\s*(吧|呀|啊|了|呗|哈)?\s*[。.!！]*$/u;
const START_WRITING_BLOCK = /[?？吗]|怎么|怎样|如何|可不可以|可以吗|能不能|能否|是不是|是否|要不要|好不好|行不行|的话|之前|先|稍后|等会|回头|如果|假如|要是|别|不要|不用|暂停|停一下|停下|先别/u;
const DETAILED_CHAPTER_START = /^(请|帮我|帮忙|麻烦|那|那就|就|你)?\s*(现在|马上|立刻|赶紧|这就)?\s*(开始写|开始创作|开写|继续写|续写)\s*第?\s*[一二三四五六七八九十百千零\d]+\s*章(?:[，,。；;：:\s]|$)/u;

export function isStartWritingIntent(text) {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (START_WRITING_BLOCK.test(t)) return false; // 疑问/条件/转折/否定 → 不启动
  if (DETAILED_CHAPTER_START.test(t)) return true;
  if (t.length > 18) return false;
  return START_WRITING_CORE.test(t);
}

// 动态从注册表取 slash 菜单项,避免硬编码
function commandsForSlashMenu(query) {
  const all = listCommands({ userInvocable: true });
  const q = (query || "").toLowerCase();
  return all
    .filter((cmd) => cmd.slashKey && cmd.slashKey.toLowerCase().startsWith(q))
    .map((cmd) => ({
      name: cmd.name,
      key: cmd.slashKey,
      title: cmd.userFacingName(),
      desc: cmd.description,
      icon: cmd.icon ?? "default",
    }));
}

export function createComposer(ctx) {
  // ctx provides: refs, getCurrentProjectRoot, getDashboard, loadDashboard,
  //   openDrawer, openSettingsModal, openCreateModal, showToast, showActionError,
  //   threadRenderer, getAskEntries, ensureRefreshLoop

  let slashActiveIndex = 0;

  // --- 输入框草稿：按项目持久化，切走/重启可恢复 ---
  let draftTimer = null;
  const DRAFT_DEBOUNCE_MS = 200;

  function currentRoot() {
    return ctx.getCurrentProjectRoot();
  }

  function persistDraft() {
    if (!currentRoot()) return;
    if (draftTimer) window.clearTimeout(draftTimer);
    draftTimer = window.setTimeout(() => {
      draftTimer = null;
      saveDraft(currentRoot(), ctx.refs.composerInput.value);
    }, DRAFT_DEBOUNCE_MS);
  }

  function flushDraft() {
    if (draftTimer) { window.clearTimeout(draftTimer); draftTimer = null; }
    const root = currentRoot();
    if (root) saveDraft(root, ctx.refs.composerInput.value);
  }

  function clearDraftForCurrent() {
    if (draftTimer) { window.clearTimeout(draftTimer); draftTimer = null; }
    const root = currentRoot();
    if (root) clearDraft(root);
  }

  function persistCurrentDraftNow(projectRoot = currentRoot()) {
    if (projectRoot) saveDraft(projectRoot, ctx.refs.composerInput.value);
  }

  function restoreDraftIfAny(projectRoot, { focus = false } = {}) {
    const text = projectRoot ? loadDraft(projectRoot) : "";
    if (!text) return false;
    ctx.refs.composerInput.value = text;
    autoGrowComposer();
    updateSubmitState();
    updateSlashMenu();
    if (focus) {
      try { ctx.refs.composerInput.focus(); } catch { /* 失焦不可用则忽略 */ }
    }
    return true;
  }

  // --- S4.5 活动占位：chat busy 期间的过程反馈 + 停止 ---
  let activePlaceholder = null;   // { wrap, say, stop, dispose, setActivity }
  let localSendInFlight = false;  // 本地 send 未返回时不让轮询提前撤占位
  let latestActivity = "";

  function isChatBusy() {
    return localSendInFlight || Boolean(activePlaceholder);
  }

  function showActivityPlaceholder() {
    if (activePlaceholder) return activePlaceholder;
    const wrap = document.createElement("div");
    wrap.className = "msg-agent rise chat-bubble-wrap chat-thinking";
    wrap.dataset.testid = "chat-activity-placeholder";
    const avatar = document.createElement("div");
    avatar.className = "agent-avatar";
    avatar.textContent = "W";
    const body = document.createElement("div");
    body.className = "agent-body";
    const row = document.createElement("div");
    row.className = "chat-activity-row";
    const say = document.createElement("p");
    say.className = "agent-say chat-activity-text";
    say.textContent = "思考中…";
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "chat-stop-btn";
    stop.dataset.testid = "chat-stop";
    stop.setAttribute("aria-label", "停止本轮对话");
    stop.textContent = "停止";
    stop.addEventListener("click", async () => {
      stop.disabled = true;
      try {
        await stopChat();
      } catch (error) {
        stop.disabled = false;
        ctx.showToast(error.message ?? "停止失败。", "error");
      }
    });
    row.append(say, stop);
    body.append(row);
    wrap.append(avatar, body);
    ctx.refs.thread.append(wrap);
    ctx.threadRenderer.scrollThreadToBottom();
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const secs = Math.round((Date.now() - startedAt) / 1000);
      say.textContent = `${latestActivity || "思考中"} · 已 ${secs} 秒`;
    }, 1000);
    activePlaceholder = {
      wrap, say, stop,
      setActivity: (text) => { latestActivity = text; },
      dispose: () => { window.clearInterval(timer); wrap.remove(); }
    };
    return activePlaceholder;
  }

  function removeActivityPlaceholder() {
    activePlaceholder?.dispose();
    activePlaceholder = null;
    latestActivity = "";
  }

  // renderDashboard 每拍调用：busy 驱动占位生命周期 + 回显最新工具活动。
  function syncChatBusy(data) {
    const busy = data?.chatHistory?.busy === true;
    if (busy && !activePlaceholder) showActivityPlaceholder(); // 确认卡续轮 / 他窗口在跑
    if (!busy && activePlaceholder && !localSendInFlight) removeActivityPlaceholder();
    if (activePlaceholder) {
      const msgs = data?.chatHistory?.messages ?? [];
      const lastTool = [...msgs].reverse().find((m) => m.role === "tool");
      if (lastTool) activePlaceholder.setActivity(`动作：${toolLabel(lastTool.tool, lastTool.args)} · 继续思考`);
    }
  }

  // --- four-tier approval / mode pill (S4 Task 8) ---
  // PERMISSION_TIERS 引用共享模块 PERMISSION_TIERS；detectPermissionTier 统一优先级。
  const TIER_DESC = Object.fromEntries(PERMISSION_TIERS.map((t) => [t.id, t.desc]));
  function tierFromPermissions(perms) {
    return getTierById(detectPermissionTier(perms));
  }

  let modePopoverOpen = false;
  let modePopoverActiveIndex = 1; // default tier index
  let modelPopoverOpen = false;

  function getModePill() {
    return document.getElementById("mode-pill");
  }
  function getModePopover() {
    return document.getElementById("mode-popover");
  }
  function getModelPopover() {
    return document.getElementById("model-popover");
  }

  function renderModePill() {
    const pill = getModePill();
    if (!pill) return;
    const project = ctx.getDashboard()?.project ?? null;
    if (!project) {
      // No project loaded: leave the pill in its HTML default state and let dashboard refresh re-render.
      pill.setAttribute("aria-expanded", modePopoverOpen ? "true" : "false");
      return;
    }
    pill.disabled = Boolean(project.archived_at);
    const tier = tierFromPermissions(project.tool_permissions);
    pill.textContent = pill.disabled ? "已归档" : tier.label;
    pill.className = "cbar-pill"
      + (pill.disabled ? " cbar-pill--archived" : "")
      + (!pill.disabled && tier.id === "yolo" ? " cbar-pill--yolo" : "");
    pill.setAttribute("data-tier", tier.id);
    pill.setAttribute("aria-expanded", modePopoverOpen ? "true" : "false");
  }

  function syncModePopoverChecked() {
    const project = ctx.getDashboard()?.project ?? null;
    const tier = project ? tierFromPermissions(project.tool_permissions) : PERMISSION_TIERS[1];
    const popover = getModePopover();
    if (!popover) return;
    const items = [...popover.querySelectorAll("[data-tier-id]")];
    items.forEach((el) => {
      const on = el.dataset.tierId === tier.id && !project?.archived_at;
      el.setAttribute("aria-checked", on ? "true" : "false");
    });
    modePopoverActiveIndex = Math.max(0, PERMISSION_TIERS.findIndex((t) => t.id === tier.id));
    const warn = document.getElementById("mode-popover-warn");
    if (warn) warn.hidden = tier.id !== "yolo";
  }

  function openModePopover() {
    const popover = getModePopover();
    const pill = getModePill();
    if (!popover || !pill) return;
    if (pill.disabled) return;
    popover.hidden = false;
    modePopoverOpen = true;
    pill.setAttribute("aria-expanded", "true");
    syncModePopoverChecked();
    setModePopoverActive(modePopoverActiveIndex);
    document.addEventListener("keydown", onModePopoverKeydown, true);
    document.addEventListener("pointerdown", onModePopoverPointerdown, true);
  }

  function closeModePopover() {
    const popover = getModePopover();
    const pill = getModePill();
    if (!popover) return;
    if (popover.hidden && !modePopoverOpen) return;
    popover.hidden = true;
    modePopoverOpen = false;
    pill?.setAttribute("aria-expanded", "false");
    document.removeEventListener("keydown", onModePopoverKeydown, true);
    document.removeEventListener("pointerdown", onModePopoverPointerdown, true);
  }

  function openModelPopover() {
    const models = ctx.getDashboard()?.available_models ?? [];
    if (!models.length) {
      ctx.showToast("还没有可切换的本地模型。请先在设置里保存模型与 API Key。", "info");
      ctx.openSettingsModal?.();
      return false;
    }
    closeModePopover();
    buildModelPopover(models);
    const popover = getModelPopover();
    const pill = document.getElementById("status-pill-model");
    if (!popover || !pill) return false;
    popover.hidden = false;
    modelPopoverOpen = true;
    pill.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", onModelPopoverPointerdown, true);
    document.addEventListener("keydown", onModelPopoverKeydown, true);
    return true;
  }

  function closeModelPopover() {
    const popover = getModelPopover();
    const pill = document.getElementById("status-pill-model");
    if (!popover) return;
    popover.hidden = true;
    modelPopoverOpen = false;
    pill?.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onModelPopoverPointerdown, true);
    document.removeEventListener("keydown", onModelPopoverKeydown, true);
  }

  function onModelPopoverPointerdown(event) {
    if (!modelPopoverOpen) return;
    const popover = getModelPopover();
    const pill = document.getElementById("status-pill-model");
    const target = event.target;
    if (popover && popover.contains(target)) return;
    if (pill && pill.contains(target)) return;
    closeModelPopover();
  }

  function onModelPopoverKeydown(event) {
    if (!modelPopoverOpen) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeModelPopover();
      document.getElementById("status-pill-model")?.focus();
    }
  }

  function setModePopoverActive(i) {
    const popover = getModePopover();
    if (!popover) return;
    const items = [...popover.querySelectorAll("[data-tier-id]")];
    if (!items.length) return;
    modePopoverActiveIndex = ((i % items.length) + items.length) % items.length;
    items.forEach((el, idx) => {
      const on = idx === modePopoverActiveIndex;
      el.classList.toggle("active", on);
    });
  }

  function onModePopoverKeydown(event) {
    if (!modePopoverOpen) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeModePopover();
      getModePill()?.focus();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setModePopoverActive(modePopoverActiveIndex + 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setModePopoverActive(modePopoverActiveIndex - 1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      const tier = PERMISSION_TIERS[modePopoverActiveIndex];
      if (tier) {
        event.preventDefault();
        void applyTier(tier);
      }
    }
  }

  function onModePopoverPointerdown(event) {
    if (!modePopoverOpen) return;
    const popover = getModePopover();
    const pill = getModePill();
    const target = event.target;
    if (popover && popover.contains(target)) return;
    if (pill && pill.contains(target)) return;
    closeModePopover();
  }

  async function applyTier(tier) {
    closeModePopover();
    const currentProjectRoot = ctx.getCurrentProjectRoot();
    if (!currentProjectRoot) {
      ctx.showToast("请先新建或打开一部小说。", "info");
      return;
    }
    try {
      await postJson("/api/settings/update", {
        tool_permissions: tier.combo
      });
      await ctx.loadDashboard();
      // 记住用户选择，新建项目时默认套用同一档（含 YOLO）。
      saveDefaultTier(tier.id);
      getModePill()?.classList.add("cbar-pill--pulse");
      window.setTimeout(() => getModePill()?.classList.remove("cbar-pill--pulse"), 400);
    } catch (error) {
      ctx.showToast(error.message ?? "切换权限档失败。", "error");
    }
  }

  function onModePillClick() {
    if (getModePill()?.disabled) return;
    if (modePopoverOpen) closeModePopover();
    else openModePopover();
  }
  function onModePillKeydown(event) {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      if (!modePopoverOpen) {
        event.preventDefault();
        openModePopover();
      }
    }
    if (event.key === "Escape" && modePopoverOpen) {
      closeModePopover();
    }
  }
  function onModePopoverItemClick(event) {
    const target = event.currentTarget;
    const tierId = target?.dataset?.tierId;
    const tier = PERMISSION_TIERS.find((t) => t.id === tierId);
    if (tier) void applyTier(tier);
  }

  // expose update so app.js can re-render when dashboard refreshes
  function updateModePill() {
    renderModePill();
    if (modePopoverOpen) syncModePopoverChecked();
  }

  // --- S4 Task 11: status pills (model + session cost) ---

  function updateStatusPills(data) {
    updateModelPill(data);
    updateWordsPill(data);
    updateCostPill(data);
  }

  // 会话新增字数：按项目在内存 Map 里记基线，整个会话期间复用（切回旧项目基线仍在）；
  // 刷新/重启应用即清空——会话语义，不持久化。
  const sessionWordBaselines = new Map();

  function updateWordsPill(data) {
    const container = ensureStatusPillContainer();
    if (!container) return;
    let pill = document.getElementById("status-pill-words");
    if (!pill) {
      pill = document.createElement("span");
      pill.id = "status-pill-words";
      pill.className = "cbar-pill cbar-pill--readonly cbar-pill--words";
      pill.title = "本次应用启动以来新增的字数，刷新后重新计数";
      container.append(pill);
    }
    const root = data?.projectRoot;
    const total = Number(data?.summary?.totalWords ?? 0);
    if (!root) { pill.hidden = true; return; }
    if (!sessionWordBaselines.has(root)) sessionWordBaselines.set(root, total);
    const delta = total - sessionWordBaselines.get(root);
    pill.hidden = delta <= 0;
    if (delta > 0) pill.textContent = `本次会话 +${delta.toLocaleString("zh-CN")} 字`;
  }

  function ensureStatusPillContainer() {
    // 确保 status-pills 容器挂在 mode-pill 之后
    let container = document.getElementById("status-pills");
    if (container) return container;
    const modePill = getModePill();
    if (!modePill) return null;
    container = document.createElement("span");
    container.id = "status-pills";
    container.className = "status-pills";
    modePill.after(container);
    return container;
  }

  function updateModelPill(data) {
    const container = ensureStatusPillContainer();
    if (!container) return;
    let pill = document.getElementById("status-pill-model");
    if (!pill) {
      pill = document.createElement("button");
      pill.type = "button";
      pill.id = "status-pill-model";
      pill.className = "cbar-pill cbar-pill--readonly";
      pill.setAttribute("aria-haspopup", "listbox");
      pill.addEventListener("click", () => openModelPopover());
      container.append(pill);
    }
    const isMock = data?.model_profile?.is_mock;
    const display = data?.model_profile?.display;
    let tx = pill.querySelector(".pill-tx");
    if (!tx) { tx = document.createElement("span"); tx.className = "pill-tx"; pill.append(tx); }
    tx.textContent = isMock || !display ? "未配置模型" : display;
    const count = Array.isArray(data?.available_models) ? data.available_models.length : 0;
    pill.title = count > 0 ? "点击切换已配置模型" : "点击打开设置配置模型";
  }

  function buildModelPopover(models) {
    let popover = getModelPopover();
    if (!popover) {
      popover = document.createElement("div");
      popover.className = "mode-popover model-popover";
      popover.id = "model-popover";
      popover.setAttribute("role", "listbox");
      popover.setAttribute("aria-label", "选择模型");
      const wrap = document.getElementById("composer") ?? ctx.refs.composer;
      if (wrap) wrap.append(popover);
    }
    const label = document.createElement("div");
    label.className = "mode-popover-label";
    label.textContent = "已配置模型";
    const items = models.map((model) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mode-popover-item";
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-checked", model.active ? "true" : "false");
      btn.dataset.modelId = model.id ?? model.model_name;
      const glyph = document.createElement("span");
      glyph.className = "mpi-glyph";
      glyph.textContent = model.active ? "✓" : "M";
      const tx = document.createElement("span");
      tx.className = "mpi-tx";
      const strong = document.createElement("strong");
      strong.textContent = model.display ?? model.model_name ?? model.id ?? "model";
      const small = document.createElement("small");
      small.textContent = model.api_key_saved ? `${model.provider_label ?? model.provider} · key 已保存` : `${model.provider_label ?? model.provider} · key 未保存`;
      tx.append(strong, small);
      btn.append(glyph, tx);
      btn.addEventListener("click", () => switchModel(btn.dataset.modelId));
      return btn;
    });
    popover.replaceChildren(label, ...items);
    popover.hidden = true;
  }

  function updateCostPill(data) {
    const container = ensureStatusPillContainer();
    if (!container) return;
    let pill = document.getElementById("status-pill-cost");
    if (!pill) {
      pill = document.createElement("span");
      pill.id = "status-pill-cost";
      pill.className = "cbar-pill cbar-pill--readonly";
      container.append(pill);
    }
    const costAvailable = data?.summary?.costAvailable !== false;
    if (!costAvailable) {
      pill.hidden = true;
      return;
    }
    pill.hidden = false;
    let totalCost = 0;
    const messages = data?.chatHistory?.messages ?? [];
    for (const msg of messages) {
      if (msg.role === "assistant" && Number.isFinite(msg.cost) && msg.cost > 0) {
        totalCost += msg.cost;
      }
    }
    // 也计入 summary.estimatedCost（agent 运行成本）
    const agentCost = Number(data?.summary?.estimatedCost) || 0;
    totalCost += agentCost;
    pill.hidden = totalCost <= 0;
    pill.textContent = `¥${totalCost.toFixed(2)}`;
    pill.title = "本会话累计成本";
  }

  function parseUserCommand(input, mode) {
    const raw = String(input ?? "");
    const trimmed = raw.trim();
    if (!trimmed) {
      return { type: "empty", content: "", raw, shouldAffectMainTask: false };
    }
    const ask = matchCommandPrefix(trimmed, SIDE_QUESTION_PREFIXES);
    if (ask !== null) {
      return { type: "side_question", content: ask, raw, shouldAffectMainTask: detectMainTaskImpact(ask) };
    }
    const review = matchCommandPrefix(trimmed, REVIEW_PREFIXES);
    if (review !== null) {
      return { type: "review", content: review, raw, shouldAffectMainTask: true };
    }
    const write = matchCommandPrefix(trimmed, WRITE_PREFIXES);
    if (write !== null) {
      return { type: "write", content: write, raw, shouldAffectMainTask: true };
    }
    const model = matchCommandPrefix(trimmed, MODEL_PREFIXES);
    if (model !== null) {
      return { type: "model", content: model, raw, shouldAffectMainTask: false };
    }
    if (mode === "side_question") {
      return { type: "side_question", content: trimmed, raw, shouldAffectMainTask: detectMainTaskImpact(trimmed) };
    }
    if (mode === "review") {
      return { type: "review", content: trimmed, raw, shouldAffectMainTask: true };
    }
    // 自然语言的「开始/继续写作」走硬启动（write），不靠 chat agent 自觉调用 start_run。
    if (isStartWritingIntent(trimmed)) {
      return { type: "write", content: trimmed, raw, shouldAffectMainTask: true };
    }
    return { type: "main", content: trimmed, raw, shouldAffectMainTask: true };
  }

  function matchCommandPrefix(trimmed, prefixes) {
    const lower = trimmed.toLowerCase();
    for (const prefix of prefixes) {
      const lowerPrefix = prefix.toLowerCase();
      if (lower === lowerPrefix) {
        return "";
      }
      if (lower.startsWith(`${lowerPrefix} `) || trimmed.startsWith(`${prefix}\n`)) {
        return trimmed.slice(prefix.length).trim();
      }
    }
    return null;
  }

  function detectMainTaskImpact(text) {
    return MAIN_TASK_IMPACT_PATTERN.test(String(text ?? ""));
  }


  function onComposerKeydown(event) {
    if (!ctx.refs.slashMenu.hidden) {
      const items = [...ctx.refs.slashMenu.querySelectorAll(".slash-item")];
      if (event.key === "ArrowDown") { event.preventDefault(); setSlashActive(slashActiveIndex + 1); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setSlashActive(slashActiveIndex - 1); return; }
      if ((event.key === "Enter" || event.key === "Tab") && items[slashActiveIndex]) { event.preventDefault(); items[slashActiveIndex].click(); return; }
      if (event.key === "Escape") {
        hideSlashMenu();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitComposer();
    }
  }

  function autoGrowComposer() {
    const input = ctx.refs.composerInput;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  }

  function updateSubmitState() {
    ctx.refs.composerSubmit.disabled = ctx.refs.composerInput.value.trim().length === 0;
  }

  // 统一清空输入框：清当前项目草稿 + value + 自适应高度 + 提交态 + 取消防抖。
  function clearComposerInput() {
    clearDraftForCurrent();
    ctx.refs.composerInput.value = "";
    autoGrowComposer();
    updateSubmitState();
  }

  // 切换项目时只重置当前 DOM，不触碰任何项目的持久化草稿。
  function resetComposerInputUi() {
    ctx.refs.composerInput.value = "";
    autoGrowComposer();
    updateSubmitState();
    updateSlashMenu();
  }

  function updateSlashMenu() {
    const value = ctx.refs.composerInput.value;
    if (!value.startsWith("/") || value.includes(" ") || value.includes("\n")) {
      hideSlashMenu();
      return;
    }
    const matches = commandsForSlashMenu(value);
    if (matches.length === 0) {
      hideSlashMenu();
      return;
    }
    ctx.refs.slashMenu.replaceChildren(buildSlashLabel(), ...matches.map(buildSlashItem));
    ctx.refs.slashMenu.hidden = false;
    ctx.refs.composerInput.setAttribute("aria-expanded", "true");
    setSlashActive(0);
  }

  function buildSlashLabel() {
    const label = document.createElement("div");
    label.className = "slash-label";
    label.textContent = "斜杠命令";
    return label;
  }

  function setSlashActive(i) {
    const items = [...ctx.refs.slashMenu.querySelectorAll(".slash-item")];
    if (!items.length) return;
    slashActiveIndex = (i + items.length) % items.length;
    items.forEach((el, idx) => {
      const on = idx === slashActiveIndex;
      el.classList.toggle("active", on);
      el.setAttribute("aria-selected", on ? "true" : "false");
      if (on) ctx.refs.composerInput.setAttribute("aria-activedescendant", el.id);
    });
  }

  function buildSlashItem(cmd) {
    const button = document.createElement("button");
    button.className = "slash-item";
    button.type = "button";
    const ic = document.createElement("span");
    ic.className = "slash-ic";
    ic.append(icon(cmd.icon, 15));
    const tx = document.createElement("span");
    tx.className = "slash-tx";
    const strong = document.createElement("strong");
    strong.textContent = cmd.title;
    const small = document.createElement("small");
    small.textContent = cmd.desc;
    tx.append(strong, small);
    const key = document.createElement("span");
    key.className = "slash-key";
    key.textContent = cmd.key;
    button.id = "slash-opt-" + cmd.key.slice(1);
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", "false");
    button.append(ic, tx, key);
    button.dataset.name = cmd.name;  // for pickSlash registry lookup
    button.addEventListener("click", () => pickSlash(cmd));
    return button;
  }

  function pickSlash(cmd) {
    hideSlashMenu();
    const registryCmd = getCommand(cmd.name);
    if (!registryCmd) {
      ctx.showToast(`未知命令: ${cmd.key}`, "error");
      return;
    }
    // UI-only 命令:直接 run,input 留空
    if (registryCmd.uiOnly) {
      registryCmd.run({}, ctx).catch((err) => ctx.showActionError(err));
      clearComposerInput();
      return;
    }
    ctx.refs.composerInput.value = `${cmd.key} `;
    ctx.refs.composerInput.focus();
    autoGrowComposer();
    updateSubmitState();
  }

  function hideSlashMenu() {
    ctx.refs.slashMenu.hidden = true;
    ctx.refs.slashMenu.replaceChildren();
    ctx.refs.composerInput.setAttribute("aria-expanded", "false");
    ctx.refs.composerInput.removeAttribute("aria-activedescendant");
    slashActiveIndex = 0;
  }

  async function submitComposer() {
    await submitText(ctx.refs.composerInput.value);
  }

  // 统一提交入口：命令栏提交、气泡「重新发送 / 重试本轮」都走这里，
  // 确保都经过 parseUserCommand 意图识别（如「开始写」→ 硬启动），不会绕过。
  async function submitText(text) {
    const parsed = parseUserCommand(text, "main");
    if (parsed.type === "empty") {
      ctx.showToast("请输入要提交的内容。", "info");
      return;
    }
    const currentProjectRoot = ctx.getCurrentProjectRoot();
    if (!currentProjectRoot) {
      ctx.showToast("请先新建或打开一部小说。", "info");
      ctx.openCreateModal();
      return;
    }
    hideSlashMenu();
    if (parsed.type === "side_question") {
      if (!parsed.content) { ctx.showToast("请补充要提问的内容。", "info"); return; }
      await submitSideQuestion(parsed.content);
      return;
    }
    if (parsed.type === "write" || parsed.type === "review") {
      await submitWritingCommand(parsed.content, parsed.type === "review" ? "review" : "write");
      return;
    }
    if (parsed.type === "model") {
      await submitModelCommand(parsed.content);
      return;
    }
    // 默认走 chat agent
    await sendChatMessageWithUX(parsed.content);
  }

  async function submitWritingCommand(message, mode, { fromSideQuestion = false, projectRoot: requestedProjectRoot = null } = {}) {
    const projectRoot = requestedProjectRoot ?? ctx.getCurrentProjectRoot();
    const token = ctx.projectScope?.capture(projectRoot);
    ctx.refs.composerSubmit.disabled = true;
    ctx.refs.composerSubmit.setAttribute("aria-busy", "true");
    try {
      const result = await postJson("/api/commands/submit", { message, mode, fromSideQuestion, projectRoot });
      if (token && !ctx.projectScope.isCurrent(token)) return;
      clearComposerInput();
      ctx.showToast(resultMessageForCommand(result), result.blocked ? "error" : "success");
      ctx.ensureRefreshLoop(true);
      await ctx.loadDashboard();
    } catch (error) {
      if (token && !ctx.projectScope.isCurrent(token)) return;
      persistCurrentDraftNow(projectRoot);
      ctx.showActionError(error);
    } finally {
      ctx.refs.composerSubmit.removeAttribute("aria-busy");
      updateSubmitState();
    }
  }

  async function startCurrentChapter() {
    const dashboard = ctx.getDashboard?.() || {};
    const chapterNo = Number(
      dashboard.summary?.currentChapterNo ||
      dashboard.state?.current_chapter_no ||
      1
    );
    await submitWritingCommand("开始写第 " + chapterNo + " 章", "write");
  }

  async function submitSideQuestion(question) {
    const projectRoot = ctx.getCurrentProjectRoot();
    const token = ctx.projectScope?.capture(projectRoot);
    ctx.refs.composerSubmit.disabled = true;
    ctx.refs.composerSubmit.setAttribute("aria-busy", "true");
    try {
      const result = await postJson("/api/commands/ask", { question, projectRoot });
      if (token && !ctx.projectScope.isCurrent(token)) return;
      clearComposerInput();
      const askEntries = ctx.getAskEntries();
      const entry = {
        id: `ask-${result.askedAt ?? Date.now()}-${askEntries.size}`,
        question: result.question ?? question,
        answer: result.answer ?? "",
        mainTaskAffecting: result.mainTaskAffecting === true,
        suggestion: result.suggestion ?? null,
        promoted: false,
        projectRoot,
        projectToken: token
      };
      askEntries.set(entry.id, entry);
      ctx.refs.thread.append(ctx.threadRenderer.buildSideBubble(entry));
      ctx.threadRenderer.scrollThreadToBottom();
      ctx.showToast(
        result.mainTaskAffecting
          ? "旁路询问已回复：检测到会影响主线的修改建议，请在对话内确认是否转正式任务。"
          : "旁路询问已回复（未修改正文，也未打断写作）。",
        result.mainTaskAffecting ? "info" : "success"
      );
    } catch (error) {
      if (token && !ctx.projectScope.isCurrent(token)) return;
      persistCurrentDraftNow(projectRoot);
      ctx.showActionError(error);
    } finally {
      ctx.refs.composerSubmit.removeAttribute("aria-busy");
      updateSubmitState();
    }
  }

  async function submitModelCommand(modelId) {
    if (!ctx.getCurrentProjectRoot()) {
      ctx.showToast("请先新建或打开一部小说。", "info");
      return;
    }
    const target = String(modelId ?? "").trim();
    if (!target) {
      openModelPopover();
      return;
    }
    await switchModel(target);
    clearComposerInput();
  }

  async function switchModel(modelId) {
    const currentProjectRoot = ctx.getCurrentProjectRoot();
    if (!currentProjectRoot) {
      ctx.showToast("请先新建或打开一部小说。", "info");
      return;
    }
    try {
      const result = await postJson("/api/settings/model-switch", {
        projectRoot: currentProjectRoot,
        model_id: modelId
      });
      closeModelPopover();
      await ctx.loadDashboard();
      ctx.showToast(`已切换模型：${result.model_profile?.display ?? modelId}`, "success");
    } catch (error) {
      ctx.showActionError?.(error);
      ctx.showToast(error.message ?? "切换模型失败。", "error");
    }
  }

  async function sendChatMessageWithUX(message) {
    // 入口忙态守卫：双击建议卡/快捷 chip/重试按钮不应打出 409 噪音（服务端守卫仍是兜底）。
    if (isChatBusy()) {
      ctx.showToast("智能体正在处理上一条消息，请稍候或点停止。", "info");
      return;
    }
    const savedContent = message;
    const projectRoot = ctx.getCurrentProjectRoot();
    const token = ctx.projectScope?.capture(projectRoot);
    ctx.refs.composerSubmit.disabled = true;
    ctx.refs.composerSubmit.setAttribute("aria-busy", "true");

    // 1. 立即清空输入框
    clearComposerInput();

    // 2. 乐观用户气泡（复用 thread-renderer 的渲染器；轮询渲出持久化消息后会被自动清理）
    const userBubble = ctx.threadRenderer.renderChatMessage({
      role: "user", content: message, ts: new Date().toISOString()
    });
    userBubble.dataset.optimistic = "user";
    ctx.refs.thread.append(userBubble);

    // 3. 活动占位 + 立刻开启忙时轮询（过程流靠它）
    localSendInFlight = true;
    showActivityPlaceholder();
    ctx.ensureRefreshLoop(true);

    try {
      const result = await sendChatMessage(message, { projectRoot });
      if (token && !ctx.projectScope.isCurrent(token)) {
        localSendInFlight = false;
        removeActivityPlaceholder();
        if (userBubble.isConnected) userBubble.remove();
        return;
      }
      localSendInFlight = false;
      removeActivityPlaceholder();
      if (userBubble.isConnected) userBubble.remove();
      if (result?.cancelled) ctx.showToast("本轮已停止。", "info");
      if (typeof ctx.loadDashboard === "function") {
        await ctx.loadDashboard();
      }
    } catch (error) {
      if (token && !ctx.projectScope.isCurrent(token)) {
        localSendInFlight = false;
        removeActivityPlaceholder();
        if (userBubble.isConnected) userBubble.remove();
        return;
      }
      localSendInFlight = false;
      removeActivityPlaceholder();
      if (userBubble.isConnected) userBubble.remove();

      const errorBubble = document.createElement("div");
      errorBubble.className = "msg-agent rise chat-bubble-wrap";
      const errorAvatar = document.createElement("div");
      errorAvatar.className = "agent-avatar";
      errorAvatar.textContent = "W";
      const errorBody = document.createElement("div");
      errorBody.className = "agent-body";
      const errorSay = document.createElement("p");
      errorSay.className = "agent-say";
      errorSay.textContent = `发送失败：${error.message}`;
      errorBody.append(errorSay);
      errorBubble.append(errorAvatar, errorBody);
      ctx.refs.thread.append(errorBubble);
      ctx.threadRenderer.scrollThreadToBottom();

      ctx.refs.composerInput.value = savedContent;
      autoGrowComposer();
      persistCurrentDraftNow(projectRoot);
      ctx.showActionError?.(error);
    } finally {
      ctx.refs.composerSubmit.removeAttribute("aria-busy");
      updateSubmitState();
    }
  }

  async function promoteAskEntry(entry) {
    const currentProjectRoot = ctx.getCurrentProjectRoot();
    if (!currentProjectRoot) { ctx.showToast("请先打开一部小说。", "info"); return; }
    if (entry.projectToken && ctx.projectScope && !ctx.projectScope.isCurrent(entry.projectToken)) {
      ctx.showToast("该询问来自已切换的项目，已忽略。", "info");
      return;
    }
    await submitWritingCommand(entry.question, "write", { fromSideQuestion: true, projectRoot: entry.projectRoot });
    entry.promoted = true;
    ctx.showToast("已将该修改建议转为正式写作任务。", "success");
  }

  function resultMessageForCommand(result) {
    if (result.alreadyRunning) return "指令已记录；写作任务正在运行中。";
    if (result.completed) return "项目已完成；在「设置 → 写作目标」里提高目标章节数即可继续。";
    if (result.blocked) return "项目已阻塞；请在右侧「运行」面板处理错误。";
    if (result.started) return "写作任务已开始。";
    return result.message ?? "指令已记录。";
  }

  function buildModePopover() {
    if (document.getElementById("mode-popover")) return;
    const popover = document.createElement("div");
    popover.className = "mode-popover";
    popover.id = "mode-popover";
    popover.setAttribute("role", "listbox");
    popover.setAttribute("aria-label", "智能体权限模式");
    popover.hidden = true;

    const label = document.createElement("div");
    label.className = "mode-popover-label";
    label.textContent = "权限模式";
    popover.append(label);

    for (const tier of PERMISSION_TIERS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mode-popover-item" + (tier.id === "yolo" ? " mode-popover-item--yolo" : "");
      btn.setAttribute("role", "option");
      btn.setAttribute("data-tier-id", tier.id);
      btn.setAttribute("aria-checked", "false");
      btn.dataset.tierId = tier.id;
      const tx = document.createElement("span");
      tx.className = "mpi-tx";
      const strong = document.createElement("strong");
      strong.textContent = tier.label;
      const small = document.createElement("small");
      small.textContent = TIER_DESC[tier.id];
      tx.append(strong, small);
      btn.append(tx);
      btn.addEventListener("click", onModePopoverItemClick);
      popover.append(btn);
    }

    const warn = document.createElement("div");
    warn.className = "mode-popover-warn";
    warn.id = "mode-popover-warn";
    warn.textContent = "警告：全程自动模式会自动执行所有写与控制操作，包括章节编辑、设定更新和任务控制。";
    warn.hidden = true;
    popover.append(warn);

    // 浮层挂在 composer-wrap 上，跟随 composer 一起定位
    const wrap = document.getElementById("composer") ?? ctx.refs.composer;
    if (wrap) wrap.append(popover);

    // pill 绑定
    const pill = getModePill();
    if (pill) {
      pill.addEventListener("click", onModePillClick);
      pill.addEventListener("keydown", onModePillKeydown);
    }
  }

  function initModePill() {
    buildModePopover();
    renderModePill();
  }

  return {
    parseUserCommand, onComposerKeydown, autoGrowComposer, updateSubmitState,
    updateSlashMenu, hideSlashMenu, submitComposer, submitText, submitWritingCommand,
    startCurrentChapter,
    submitSideQuestion, promoteAskEntry, resultMessageForCommand,
    initModePill, updateModePill, openModePopover, closeModePopover,
    openModelPopover, closeModelPopover, updateStatusPills, sendChatMessageWithUX,
    syncChatBusy, isChatBusy,
    persistDraft, flushDraft, restoreDraftIfAny, clearDraftForCurrent,
    resetComposerInputUi
  };
}
