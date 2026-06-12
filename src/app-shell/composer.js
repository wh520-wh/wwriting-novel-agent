import { icon } from "./icons.js";
import { postJson, sendChatMessage } from "./api-client.js";
import { getCommand, listCommands } from "./command-registry.mjs";
import "./commands/index.mjs";  // side-effect: register 5 built-in commands

// 旁路询问命令前缀（与后端 side-question.mjs 保持一致；禁止使用 /btw）。
const SIDE_QUESTION_PREFIXES = ["/ask", "/side", "/q"];
const REVIEW_PREFIXES = ["/review", "/审稿"];
const WRITE_PREFIXES = ["/write", "/写作"];
// 命中则说明旁路询问其实包含修改主线设定/正文的诉求，需要确认后才转正式任务。
const MAIN_TASK_IMPACT_PATTERN = /(改成|改为|改掉|改写|写成|换成|替换|删除|删掉|去掉|移除|重写|改编|不要写|不再写|别写|不写|推翻|重新设定|改设定|改人设|改世界观|改大纲|改结局|改剧情|黑化|洗白|复活|写死|赐死|领便当|降智|崩坏|让.{0,6}死|让.{0,6}活|让.{0,8}(在一起|分手|退场|出局|登场|加入|离开|背叛|反水))/u;

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

  // --- four-tier approval / mode pill (S4 Task 8) ---
  // Tier priority: yolo > auto > read_only > confirm.
  // (safe_edit 是另一条正交轴，保留原值不参与档位判定。)
  const TIER_DEFS = [
    { id: "read_only", label: "🔒 只读",     short: "🔒 只读",     combo: { read_only: true,  safe_edit: true, auto_edit: false, yolo: false } },
    { id: "confirm",   label: "✓ 确认后修改", short: "✓ 确认后修改", combo: { read_only: false, safe_edit: true, auto_edit: false, yolo: false } },
    { id: "auto",      label: "⚡ 自动修改",  short: "⚡ 自动修改",  combo: { read_only: false, safe_edit: true, auto_edit: true,  yolo: false } },
    { id: "yolo",      label: "⚡ YOLO",     short: "⚡ YOLO",     combo: { read_only: false, safe_edit: true, auto_edit: true,  yolo: true  } }
  ];
  const TIER_DESC = {
    read_only: "完全只读；智能体不修改任何文件。",
    confirm:   "默认档；写文件前会先让你确认。",
    auto:      "可静默改稿；归档/导出仍需确认。",
    yolo:      "⚠ 跳过所有确认；归档/章节编辑全自动。"
  };
  function tierFromPermissions(perms) {
    const p = perms ?? {};
    if (p.yolo === true) return TIER_DEFS[3];
    if (p.auto_edit === true) return TIER_DEFS[2];
    if (p.read_only === true) return TIER_DEFS[0];
    return TIER_DEFS[1];
  }

  let modePopoverOpen = false;
  let modePopoverActiveIndex = 1; // default tier index

  function getModePill() {
    return document.getElementById("mode-pill");
  }
  function getModePopover() {
    return document.getElementById("mode-popover");
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
    pill.textContent = pill.disabled ? "📦 已归档" : tier.label;
    pill.className = "cbar-pill"
      + (pill.disabled ? " cbar-pill--archived" : "")
      + (!pill.disabled && tier.id === "yolo" ? " cbar-pill--yolo" : "");
    pill.setAttribute("data-tier", tier.id);
    pill.setAttribute("aria-expanded", modePopoverOpen ? "true" : "false");
  }

  function syncModePopoverChecked() {
    const project = ctx.getDashboard()?.project ?? null;
    const tier = project ? tierFromPermissions(project.tool_permissions) : TIER_DEFS[1];
    const popover = getModePopover();
    if (!popover) return;
    const items = [...popover.querySelectorAll("[data-tier-id]")];
    items.forEach((el) => {
      const on = el.dataset.tierId === tier.id && !project?.archived_at;
      el.setAttribute("aria-checked", on ? "true" : "false");
    });
    modePopoverActiveIndex = Math.max(0, TIER_DEFS.findIndex((t) => t.id === tier.id));
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
      const tier = TIER_DEFS[modePopoverActiveIndex];
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
      ctx.showToast(`已切换到「${tier.label.replace(/^[^\s]+\s/, "")}」档。`, "success");
      await ctx.loadDashboard();
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
    const tier = TIER_DEFS.find((t) => t.id === tierId);
    if (tier) void applyTier(tier);
  }

  // expose update so app.js can re-render when dashboard refreshes
  function updateModePill() {
    renderModePill();
    if (modePopoverOpen) syncModePopoverChecked();
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
    if (mode === "side_question") {
      return { type: "side_question", content: trimmed, raw, shouldAffectMainTask: detectMainTaskImpact(trimmed) };
    }
    if (mode === "review") {
      return { type: "review", content: trimmed, raw, shouldAffectMainTask: true };
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
      ctx.refs.composerInput.value = "";
      updateSubmitState();
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
    const parsed = parseUserCommand(ctx.refs.composerInput.value, "main");
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
    // 默认走 chat agent
    await sendChatMessageWithUX(parsed.content);
  }

  async function submitWritingCommand(message, mode, { fromSideQuestion = false } = {}) {
    ctx.refs.composerSubmit.disabled = true;
    ctx.refs.composerSubmit.setAttribute("aria-busy", "true");
    try {
      const result = await postJson("/api/commands/submit", { message, mode, fromSideQuestion });
      ctx.refs.composerInput.value = "";
      autoGrowComposer();
      updateSubmitState();
      ctx.showToast(resultMessageForCommand(result), result.blocked ? "error" : "success");
      ctx.ensureRefreshLoop(true);
      await ctx.loadDashboard();
    } catch (error) {
      ctx.showActionError(error);
    } finally {
      ctx.refs.composerSubmit.removeAttribute("aria-busy");
      updateSubmitState();
    }
  }

  async function submitSideQuestion(question) {
    ctx.refs.composerSubmit.disabled = true;
    ctx.refs.composerSubmit.setAttribute("aria-busy", "true");
    try {
      const result = await postJson("/api/commands/ask", { question });
      ctx.refs.composerInput.value = "";
      autoGrowComposer();
      updateSubmitState();
      const askEntries = ctx.getAskEntries();
      const entry = {
        id: `ask-${result.askedAt ?? Date.now()}-${askEntries.size}`,
        question: result.question ?? question,
        answer: result.answer ?? "",
        mainTaskAffecting: result.mainTaskAffecting === true,
        suggestion: result.suggestion ?? null,
        promoted: false
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
      ctx.showActionError(error);
    } finally {
      ctx.refs.composerSubmit.removeAttribute("aria-busy");
      updateSubmitState();
    }
  }

  async function sendChatMessageWithUX(message) {
    const savedContent = message;
    ctx.refs.composerSubmit.disabled = true;
    ctx.refs.composerSubmit.setAttribute("aria-busy", "true");

    // 1. 立即清空输入框
    ctx.refs.composerInput.value = "";
    autoGrowComposer();
    updateSubmitState();

    // 2. 插入用户气泡
    const userBubble = document.createElement("div");
    userBubble.className = "msg-user rise chat-bubble-wrap chat-bubble-wrap--user";
    const userBubbleInner = document.createElement("div");
    userBubbleInner.className = "chat-bubble chat-bubble--user";
    const userContent = document.createElement("div");
    userContent.className = "chat-bubble-content";
    userContent.textContent = message;
    userBubbleInner.append(userContent);
    userBubble.append(userBubbleInner);
    ctx.refs.thread.append(userBubble);
    ctx.threadRenderer.scrollThreadToBottom();

    // 3. 插入"思考中"占位
    const thinkingBubble = document.createElement("div");
    thinkingBubble.className = "msg-agent rise chat-bubble-wrap chat-bubble-wrap--assistant chat-thinking";
    const thinkingAvatar = document.createElement("div");
    thinkingAvatar.className = "agent-avatar";
    thinkingAvatar.textContent = "W";
    const thinkingBody = document.createElement("div");
    thinkingBody.className = "agent-body";
    const thinkingSay = document.createElement("p");
    thinkingSay.className = "agent-say";
    thinkingSay.textContent = "思考中...";
    thinkingBody.append(thinkingSay);
    thinkingBubble.append(thinkingAvatar, thinkingBody);
    ctx.refs.thread.append(thinkingBubble);
    ctx.threadRenderer.scrollThreadToBottom();

    try {
      // 4. 调用 chat API
      await sendChatMessage(message);

      // 5. 移除手动插入的元素；loadDashboard → syncChatThread 会从历史渲染正确的气泡
      userBubble.remove();
      thinkingBubble.remove();
      if (typeof ctx.loadDashboard === "function") {
        await ctx.loadDashboard();
      }
    } catch (error) {
      // 6. 错误恢复：移除手动插入的元素，显示错误行，恢复输入框
      userBubble.remove();
      thinkingBubble.remove();

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
      ctx.showActionError?.(error);
    } finally {
      ctx.refs.composerSubmit.removeAttribute("aria-busy");
      updateSubmitState();
    }
  }

  async function promoteAskEntry(entry) {
    const currentProjectRoot = ctx.getCurrentProjectRoot();
    if (!currentProjectRoot) { ctx.showToast("请先打开一部小说。", "info"); return; }
    await submitWritingCommand(entry.question, "write", { fromSideQuestion: true });
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

    for (const tier of TIER_DEFS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mode-popover-item" + (tier.id === "yolo" ? " mode-popover-item--yolo" : "");
      btn.setAttribute("role", "option");
      btn.setAttribute("data-tier-id", tier.id);
      btn.setAttribute("aria-checked", "false");
      btn.dataset.tierId = tier.id;
      const glyph = document.createElement("span");
      glyph.className = "mpi-glyph";
      glyph.textContent = tier.short.slice(0, 2);
      const tx = document.createElement("span");
      tx.className = "mpi-tx";
      const strong = document.createElement("strong");
      strong.textContent = tier.label;
      const small = document.createElement("small");
      small.textContent = TIER_DESC[tier.id];
      tx.append(strong, small);
      btn.append(glyph, tx);
      btn.addEventListener("click", onModePopoverItemClick);
      popover.append(btn);
    }

    const warn = document.createElement("div");
    warn.className = "mode-popover-warn";
    warn.id = "mode-popover-warn";
    warn.textContent = "⚠ 警告：YOLO 模式自动执行所有写与控制操作，包括章节编辑、设定更新和任务控制。";
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
    updateSlashMenu, hideSlashMenu, submitComposer, submitWritingCommand,
    submitSideQuestion, promoteAskEntry, resultMessageForCommand,
    initModePill, updateModePill, openModePopover, closeModePopover
  };
}
