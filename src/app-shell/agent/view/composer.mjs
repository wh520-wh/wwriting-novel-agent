// src/app-shell/agent/view/composer.mjs —— composer 分区（Task 18，第十五轮）。
//
// 从 view.js 拆出的 composer 职责：三控件菜单（模型/权限模式/思考强度，共享同一
// 桌面菜单内核）、斜杠命令菜单、发送门禁（canSubmit 单源：项目未打开/busy/压缩
// 阻塞/对话损坏）、提交与失败气泡、暂停/恢复与草稿回填。行为与拆分前完全一致。
//
// ctx 契约（引用共享 + 活绑定 getter，与壳内同名变量语义一致）：
//   - 共享引用（const 对象，双方便携读写）：doc/composer/slashMenu/input/
//     composerShell/historyClearHint/composerToolbar/send/controls/contextRing/
//     surface/emptyState/viewIcon/timeline/messages/pendingSubmissions/
//     failedSubmissions/showToast；
//   - 活绑定（壳内 let，经 getter 读最新值）：actions/currentState/viewGeneration。
// 分区私有状态不落 ctx：composerOptions/controlsSignature/composerEnabled/
// composerBusy/slashMatches/slashActiveIndex（壳 reset 的清理由分区 reset 承担）。
//
// 跨分区调用：提交气泡插入/移除/落底与失败气泡收敛经 ctx.timeline
//（createMessageBubble/removeFailedBubble/afterRender），pending 与失败气泡
// 数组与时间线分区共享同一引用。
import { matchSlashCommands } from "../slash-commands.mjs";
import { PERMISSION_TIERS } from "../../permission-tiers.mjs";
import { compactionBlocksSend, getCompaction, getNeedsHistoryClear } from "../state.js";

const EFFORT_LABELS = { low: "低", medium: "中", high: "高" };

export function createComposerView(ctx) {
  const { doc, composer, slashMenu, input, composerShell, historyClearHint,
          composerToolbar, send, controls, contextRing, surface, emptyState,
          viewIcon, timeline, messages, pendingSubmissions, failedSubmissions,
          showToast } = ctx;

  // ---- 分区私有状态（原 view.js 闭包 let 迁入）-----------------------------
  let composerOptions = null;  // setComposerOptions 注入的控件选项（null = 未加载，控件禁用）
  let controlsSignature = "";  // 选项签名：未变化时不重建菜单（避免打断正在选择的用户）
  let composerEnabled = false; // 最近一次 syncComposer 的项目可用态
  let composerBusy = false;    // Task 8：项目其他会话运行中（setBusy 设置），禁发送保输入
  let slashMatches = [];
  let slashActiveIndex = 0;

  // ---- 三控件（模型 / 权限模式 / 思考强度）共享同一桌面菜单内核 ---------------
  // 菜单是 composer 内的向上浮层，不交给系统原生 select 决定方向和样式。
  const composerMenus = [];

  function createComposerMenu({ kind, triggerTestId, menuTestId, label }) {
    const wrap = doc.createElement("div");
    wrap.className = `agent-composer-menu agent-composer-menu--${kind}`;
    const trigger = doc.createElement("button");
    trigger.type = "button";
    trigger.className = "agent-composer-menu-trigger";
    trigger.dataset.testid = triggerTestId;
    trigger.setAttribute("aria-label", label);
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    const value = doc.createElement("span");
    value.className = "agent-composer-menu-value";
    const chevron = viewIcon("chevR", 13, "agent-composer-menu-chevron");
    trigger.append(value, chevron);
    const menu = doc.createElement("div");
    menu.className = "agent-composer-popover";
    menu.dataset.testid = menuTestId;
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", label);
    menu.hidden = true;
    wrap.append(trigger, menu);
    const control = { kind, wrap, trigger, value, menu, items: [] };
    composerMenus.push(control);

    trigger.addEventListener("click", (event) => {
      event?.stopPropagation?.();
      if (trigger.disabled) return;
      const shouldOpen = menu.hidden;
      closeComposerMenus();
      if (shouldOpen) openComposerMenu(control);
    });
    trigger.addEventListener("keydown", (event) => {
      if (trigger.disabled) return;
      if (["Enter", " ", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        closeComposerMenus();
        openComposerMenu(control, event.key === "ArrowUp" ? -1 : 1);
      }
    });
    menu.addEventListener("keydown", (event) => handleComposerMenuKeydown(control, event));
    return control;
  }

  const modelControl = createComposerMenu({
    kind: "model",
    triggerTestId: "agent-model-select",
    menuTestId: "agent-model-menu",
    label: "选择模型"
  });
  const permissionControl = createComposerMenu({
    kind: "permission",
    triggerTestId: "agent-permission-select",
    menuTestId: "agent-permission-menu",
    label: "权限模式"
  });
  const effortControl = createComposerMenu({
    kind: "effort",
    triggerTestId: "agent-effort-select",
    menuTestId: "agent-effort-menu",
    label: "思考强度"
  });
  controls.append(modelControl.wrap, permissionControl.wrap, effortControl.wrap);

  // ---- 斜杠命令菜单 ----------------------------------------------------------
  function closeSlashMenu() {
    slashMatches = [];
    slashActiveIndex = 0;
    slashMenu.hidden = true;
    slashMenu.replaceChildren();
    input.removeAttribute?.("aria-activedescendant");
  }

  function selectSlashCommand(index = slashActiveIndex) {
    const item = slashMatches[index];
    if (!item) return false;
    input.value = item.command;
    closeSlashMenu();
    input.focus?.();
    return true;
  }

  function renderSlashMenu() {
    slashMatches = matchSlashCommands(input.value);
    slashActiveIndex = 0;
    slashMenu.replaceChildren();
    if (slashMatches.length === 0 || input.disabled) {
      closeSlashMenu();
      return;
    }
    slashMenu.hidden = false;
    slashMatches.forEach((item, index) => {
      const option = doc.createElement("button");
      option.id = `agent-slash-option-${index}`;
      option.type = "button";
      option.className = "agent-slash-option";
      option.dataset.testid = "agent-slash-option";
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", index === slashActiveIndex ? "true" : "false");
      const command = doc.createElement("span");
      command.className = "agent-slash-command";
      command.textContent = item.command;
      const label = doc.createElement("span");
      label.className = "agent-slash-label";
      label.textContent = item.label;
      option.append(command, label);
      option.addEventListener("click", () => selectSlashCommand(index));
      slashMenu.append(option);
    });
    input.setAttribute("aria-activedescendant", "agent-slash-option-0");
  }

  function moveSlashSelection(delta) {
    if (slashMenu.hidden || slashMatches.length === 0) return false;
    slashActiveIndex = (slashActiveIndex + delta + slashMatches.length) % slashMatches.length;
    const options = slashMenu.querySelectorAll('[data-testid="agent-slash-option"]');
    options.forEach?.((option, index) => {
      option.setAttribute("aria-selected", index === slashActiveIndex ? "true" : "false");
    });
    input.setAttribute("aria-activedescendant", `agent-slash-option-${slashActiveIndex}`);
    return true;
  }

  // ---- composer 三菜单：模型 / 权限模式 / 思考强度（选项由 setComposerOptions 注入） ----
  function closeComposerMenus() {
    for (const control of composerMenus) {
      control.menu.hidden = true;
      control.trigger.setAttribute("aria-expanded", "false");
    }
  }

  // Task 12 Step 2：可关闭顶层按固定优先级只执行第一项 —— slash menu →
  // composer 菜单 → context popover。返回是否消费了 ESC（true=已关闭某一层）。
  function dismissTopLayer() {
    if (!slashMenu.hidden) {
      closeSlashMenu();
      return true;
    }
    if (composerMenus.some((control) => !control.menu.hidden)) {
      closeComposerMenus();
      return true;
    }
    if (contextRing.popover?.dataset?.open === "true") {
      contextRing.dismiss();
      return true;
    }
    return false;
  }

  function openComposerMenu(control, direction = 1) {
    control.menu.hidden = false;
    control.trigger.setAttribute("aria-expanded", "true");
    const selectedIndex = Math.max(0, control.items.findIndex((item) => item.dataset.selected === "true"));
    const index = direction < 0 ? control.items.length - 1 : selectedIndex;
    control.items[index]?.focus?.();
  }

  function handleComposerMenuKeydown(control, event) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeComposerMenus();
      control.trigger.focus?.();
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const active = control.items.indexOf(doc.activeElement);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next = (Math.max(0, active) + delta + control.items.length) % control.items.length;
    control.items[next]?.focus?.();
  }

  function handleComposerOutsidePointer(event) {
    if (!controls.contains?.(event.target)) closeComposerMenus();
  }

  function handleComposerOutsideFocus(event) {
    if (!controls.contains?.(event.target)) closeComposerMenus();
  }

  doc.addEventListener?.("pointerdown", handleComposerOutsidePointer, true);
  doc.addEventListener?.("focusin", handleComposerOutsideFocus, true);

  function setMenuValue(control, currentValue, fallbackLabel = "") {
    const selected = control.items.find((item) => item.dataset.value === currentValue);
    control.trigger.dataset.value = currentValue;
    control.value.textContent = selected?.dataset.label ?? fallbackLabel;
    // Round10：模型未配置（空值）→ 触发按钮 amber warning 态（不修改选择逻辑）。
    control.trigger.classList.toggle("is-warning", control.kind === "model" && currentValue === "");
    for (const item of control.items) {
      const active = item.dataset.value === currentValue;
      item.dataset.selected = active ? "true" : "false";
      item.setAttribute("aria-selected", active ? "true" : "false");
    }
  }

  function fillMenu(control, options, currentValue, enabled, onSelect, fireAlwaysWhen = null) {
    control.menu.replaceChildren();
    control.items = options.map((item) => {
      const option = doc.createElement("button");
      option.type = "button";
      option.className = "agent-composer-option";
      option.dataset.testid = `agent-${control.kind}-option`;
      option.dataset.value = item.value;
      option.dataset.label = item.label;
      option.setAttribute("role", "option");
      if (item.title) option.title = item.title;
      const copy = doc.createElement("span");
      copy.className = "agent-composer-option-copy";
      const label = doc.createElement("strong");
      label.textContent = item.label;
      copy.append(label);
      if (item.description) {
        const description = doc.createElement("span");
        description.textContent = item.description;
        copy.append(description);
      }
      const check = viewIcon("check", 15, "agent-composer-option-check");
      option.append(copy, check);
      option.addEventListener("click", (event) => {
        event?.stopPropagation?.();
        closeComposerMenus();
        // 占位项（值匹配当前但必须响应点击，如「未配置」开设置页）经
        // fireAlwaysWhen 判定后照常触发 onSelect。
        if (item.value !== control.trigger.dataset.value || (fireAlwaysWhen && fireAlwaysWhen(item))) {
          onSelect(item.value);
        }
      });
      control.menu.append(option);
      return option;
    });
    control.trigger.disabled = !enabled;
    setMenuValue(control, currentValue, options[0]?.label ?? "");
    if (!enabled) control.menu.hidden = true;
  }

  function syncComposerControls() {
    const options = composerOptions;
    const levels = Array.isArray(options?.reasoningEffortLevels) && options.reasoningEffortLevels.length > 0
      ? options.reasoningEffortLevels
      : null;
    // 签名未变不重建：避免打断用户正在打开的菜单。
    const signature = JSON.stringify({
      enabled: composerEnabled,
      models: options?.models ?? null,
      modelSelectionEnabled: options?.modelSelectionEnabled ?? null,
      activeModelId: options?.activeModelId ?? null,
      permissionTier: options?.permissionTier ?? null,
      effort: options?.reasoningEffort ?? null,
      levels
    });
    if (signature === controlsSignature) {
      // 选项未变也校准当前值：选择只在落盘成功后生效，失败时回退显示旧值。
      syncControlValues(options, levels);
      return;
    }
    controlsSignature = signature;

    // 模型：选项为 Task 16 派生的选择器选项（value = `${provider_id}/${model_id}`）。
    // 未加载（composerOptions null）→ 空占位并禁用；已加载但无任何可用模型 → 「未
    // 配置」占位可点（点击开新设置页）。清单外字面模型（legacy: 前缀）只读展示。
    const models = Array.isArray(options?.models) ? options.models : [];
    const modelOptions = models.length > 0
      ? models.map((model) => ({
          value: String(model.value ?? ""),
          label: String(model.label ?? model.value ?? ""),
          title: String(model.label ?? model.value ?? "")
        }))
      : [{ value: "", label: "未配置" }];
    fillMenu(
      modelControl,
      modelOptions,
      String(options?.activeModelId ?? ""),
      composerEnabled && options != null && options?.modelSelectionEnabled !== false,
      (modelId) => {
        if (modelId === "") {
          // 「未配置」占位：直接打开新设置页（模型分区）。
          ctx.actions.openModelSettings?.();
          return;
        }
        if (String(modelId).startsWith("legacy:")) return; // 清单外只读条目不可切换
        ctx.actions.switchModel?.(modelId);
      },
      (item) => item.value === ""
    );

    // 权限模式：固定四档。
    fillMenu(
      permissionControl,
      PERMISSION_TIERS.map((tier) => ({ value: tier.id, label: tier.label, description: tier.desc })),
      String(options?.permissionTier ?? "confirm"),
      composerEnabled && Boolean(options),
      (tierId) => ctx.actions.setPermissionTier?.(tierId)
    );

    // 思考强度：当前模型声明了档位才提供低/中/高；否则只有「自动」且禁用（不伪装可用）。
    const effortOptions = levels
      ? [{ value: "auto", label: "自动" }, ...levels.map((level) => ({ value: level, label: EFFORT_LABELS[level] ?? level }))]
      : [{ value: "auto", label: "自动" }];
    fillMenu(
      effortControl,
      effortOptions,
      levels ? String(options?.reasoningEffort ?? "auto") : "auto",
      composerEnabled && Boolean(levels),
      (effort) => ctx.actions.setReasoningEffort?.(effort)
    );
  }

  function syncControlValues(options, levels) {
    const modelValue = String(options?.activeModelId ?? "");
    setMenuValue(modelControl, modelValue, "未配置");
    const permissionValue = String(options?.permissionTier ?? "confirm");
    setMenuValue(permissionControl, permissionValue, "确认后修改");
    const effortValue = levels ? String(options?.reasoningEffort ?? "auto") : "auto";
    setMenuValue(effortControl, effortValue, "自动");
  }

  // Task 16（R5-7/R5-9）：composer 发送门禁的集中判定——发送按钮与 Enter 共用同一
  // canSubmit。项目未打开 / busy（其他会话运行中）/ 压缩阻塞（在途或失败）/
  // 对话历史损坏（needs_history_clear）任一即禁发；composerEnabled/composerBusy/
  // currentState 由最近一次 render 写入。
  function canSubmit() {
    if (!composerEnabled) return false;
    if (composerBusy) return false;
    if (!ctx.currentState) return false;
    if (compactionBlocksSend(getCompaction(ctx.currentState))) return false;
    if (getNeedsHistoryClear(ctx.currentState)) return false;
    return true;
  }

  function syncComposer(state) {
    const enabled = Boolean(state.projectRoot);
    // Task 16：先置 composerEnabled 再计算发送门禁（canSubmit 依赖它），
    // 按钮与 Enter 的判定收敛到同一函数。
    composerEnabled = enabled;
    const historyClearBlocked = getNeedsHistoryClear(state);
    input.disabled = !enabled;
    send.disabled = !canSubmit();
    input.placeholder = composerBusy ? "另一个对话正在运行" : "输入消息";
    composer.hidden = !enabled;
    historyClearHint.hidden = !historyClearBlocked;
    surface.classList.toggle("agent-surface--empty", !enabled);
    syncComposerControls();
    // 有项目时隐藏产品起点；项目内的空会话保持干净，不显示欢迎词。
    emptyState.hidden = enabled;
    if (!enabled) {
      closeSlashMenu();
      closeComposerMenus();
    }
  }

  // Task 8：项目其他会话运行中（app.js / Task 9 或 submit 的 project_busy 调用）。
  // 只禁发送、改提示，不锁输入；state 变化时 syncComposer 沿用该标志。
  function setBusy(isBusy) {
    composerBusy = isBusy === true;
    if (ctx.currentState) syncComposer(ctx.currentState);
  }

  // Task 8：提交因会话竞态被丢弃时回填草稿。view 的失败路径受 viewGeneration
  // 守卫保护（切走后的旧回调不改新视图），此方法由 surface 主动调用；仅当输入
  // 框为空时回填，避免覆盖用户已输入的新内容。
  function restoreComposerText(text) {
    if (String(input.value ?? "").length > 0) return;
    input.value = String(text ?? "");
  }

  function submitFromComposer() {
    const text = String(input.value ?? "").trim();
    if (!text) return;
    const submissionGeneration = ctx.viewGeneration;
    // AICSS composer：在途 busy 态（外壳扫描边框 + 按钮图标慢旋；落定/失败后移除）
    send.dataset.busy = "true";
    composerShell.dataset.busy = "true";
    let request;
    try {
      request = ctx.actions.submit?.(text);
    } catch (error) {
      request = Promise.reject(error);
    }
    if (request?.localOnly === true) {
      // AICSS composer：localOnly 即时落定（/settings、/model 等导航命令）也要清 busy
      delete send.dataset.busy;
      delete composerShell.dataset.busy;
      input.value = "";
      closeSlashMenu();
      return;
    }

    // Task 6：重试即重发同一文本，旧失败气泡先移除，避免成功后残留。
    timeline.removeFailedBubble(text);

    const bubble = timeline.createMessageBubble("user", text);
    bubble.dataset.state = "pending";
    messages.append(bubble);
    const pending = { text, node: bubble, inputId: null };
    pendingSubmissions.push(pending);
    input.value = "";
    closeSlashMenu();
    timeline.afterRender();
    Promise.resolve(request).then((result) => {
      if (submissionGeneration !== ctx.viewGeneration) return;
      delete send.dataset.busy;
      delete composerShell.dataset.busy;
      pending.inputId = result?.input_id ?? null;
      // Task 6：click 提交后焦点从发送按钮回到输入框，便于连续输入。
      input.focus();
    }).catch((error) => {
      if (submissionGeneration !== ctx.viewGeneration) return;
      delete send.dataset.busy;
      delete composerShell.dataset.busy;
      const pendingIndex = pendingSubmissions.indexOf(pending);
      if (pendingIndex >= 0) pendingSubmissions.splice(pendingIndex, 1);
      bubble.dataset.state = "failed";
      const failure = doc.createElement("span");
      failure.className = "agent-submit-error";
      failure.dataset.testid = "agent-submit-error";
      failure.textContent = `发送失败：${String(error?.message ?? "请求失败")}`;
      bubble.append(failure);
      failedSubmissions.push({ text, node: bubble });
      if (String(input.value ?? "").length === 0) input.value = text;
      timeline.afterRender();
    });
  }

  input.addEventListener("input", () => renderSlashMenu());
  input.addEventListener("focus", () => closeComposerMenus());
  input.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (!slashMenu.hidden) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        moveSlashSelection(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        selectSlashCommand();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeSlashMenu();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      // Task 16（R5-9）：与发送按钮共用同一 canSubmit 判定——busy/压缩阻塞/
      // 对话损坏任一即禁发，输入保留。
      if (!canSubmit()) return;
      submitFromComposer();
    }
  });
  send.addEventListener("click", () => submitFromComposer());

  // ---- 对外 ----------------------------------------------------------------
  // 三控件选项不属于 snapshot/SSE state，由 index.js 加载/变更后单独注入。
  function setComposerOptions(options) {
    composerOptions = options ?? null;
    syncComposerControls();
  }

  // reset：composer 分区自己的清理（在途 busy/草稿/菜单选项签名/斜杠菜单）。
  function reset() {
    // AICSS composer：切换项目时清掉在途 busy（陈旧 promise 的守卫会跳过清理）
    delete send.dataset.busy;
    delete composerShell.dataset.busy;
    input.value = ""; // Task 6：未发送草稿（含占位会话里打的字）不得跨会话/项目泄漏
    composerOptions = null;
    controlsSignature = "";
    closeSlashMenu();
  }

  // destroy：移除文档级外部点击/焦点监听（对象废弃后不再响应）。
  function destroy() {
    doc.removeEventListener?.("pointerdown", handleComposerOutsidePointer, true);
    doc.removeEventListener?.("focusin", handleComposerOutsideFocus, true);
  }

  return {
    syncComposer,
    setBusy,
    restoreComposerText,
    setComposerOptions,
    dismissTopLayer,
    reset,
    destroy
  };
}
