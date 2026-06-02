import { icon } from "./icons.js";
import { postJson } from "./api-client.js";
import { getCommand, listCommands } from "./command-registry.mjs";
import { activateConditionalSkillsForPaths } from "../core/skill-runtime.mjs";
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
      return { type: "main", content: write, raw, shouldAffectMainTask: true };
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

  function extractFilePathsFromMessage(text) {
    // 简易提取:markdown 链接 [text](path)
    if (!text) return [];
    const paths = [];
    const mdLink = /\[[^\]]+\]\(([^)]+)\)/g;
    let m;
    while ((m = mdLink.exec(text)) !== null) paths.push(m[1]);
    return paths;
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
    const involvedPaths = extractFilePathsFromMessage(parsed.content);
    if (involvedPaths.length > 0) {
      const projectRoot = ctx.getCurrentProjectRoot();
      if (projectRoot) {
        activateConditionalSkillsForPaths(involvedPaths, projectRoot);
      }
    }
    await submitWritingCommand(parsed.content, parsed.type === "review" ? "review" : "write");
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

  async function promoteAskEntry(entry) {
    const currentProjectRoot = ctx.getCurrentProjectRoot();
    if (!currentProjectRoot) { ctx.showToast("请先打开一部小说。", "info"); return; }
    await submitWritingCommand(entry.question, "write", { fromSideQuestion: true });
    entry.promoted = true;
    ctx.showToast("已将该修改建议转为正式写作任务。", "success");
  }

  function resultMessageForCommand(result) {
    if (result.alreadyRunning) return "指令已记录；写作任务正在运行中。";
    if (result.completed) return "项目已完成；如需继续写，请先增加目标章节数。";
    if (result.blocked) return "项目已阻塞；请在右侧「运行」面板处理错误。";
    if (result.started) return "写作任务已开始。";
    return result.message ?? "指令已记录。";
  }

  return {
    parseUserCommand, onComposerKeydown, autoGrowComposer, updateSubmitState,
    updateSlashMenu, hideSlashMenu, submitComposer, submitWritingCommand,
    submitSideQuestion, promoteAskEntry, resultMessageForCommand
  };
}
