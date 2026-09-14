// src/app-shell/agent/view/cards.mjs —— 决策/错误/排队输入卡片分区（Task 17，第十五轮）。
//
// 从 view.js 拆出的三类卡片职责：决策卡（普通确认 + extreme 精确文字确认）、
// 错误卡（用户主层 + 可展开/复制技术详情）、排队输入（原文 + 排队/下一条 +
// 立即 + 取消/撤回与草稿回填）。行为与拆分前完全一致。
//
// ctx 契约（引用共享 + 活绑定 getter，与壳内同名变量语义一致）：
//   - 共享引用（const 对象，双方便携读写）：doc/decisionsSlot/errorsSlot/
//     queueSlot/decisionCards/rendered/timeline/showToast/input；
//   - 活绑定（壳内 let，经 getter 读最新值）：actions/viewGeneration。
//
// 跨分区调用：卡片插入消息时间线后需要滚动锚定，一律经 ctx.timeline
//（reconcilePendingSubmission/afterRender），不直接碰时间线内部索引；
// 撤回成功回填 composer 草稿经 ctx.input（composer 分区持有的同一文本域）。
import {
  getActiveRun,
  getPendingDecisions,
  getQueuedInputs,
  isRunActive,
  CONNECTION_ERROR_CODES
} from "../state.js";

export function createCardsView(ctx) {
  const { doc, decisionsSlot, errorsSlot, queueSlot, decisionCards,
          rendered, timeline, showToast, input } = ctx;

  // ---- 决策卡：普通确认 + 红色 extreme 精确文字确认 ---------------------------
  function buildDecisionCard(decision) {
    const card = doc.createElement("div");
    card.className = "agent-decision" + (decision.kind === "extreme" ? " agent-decision--extreme" : "");
    card.dataset.testid = "agent-decision-card";
    card.dataset.decisionId = decision.decision_id;
    const title = doc.createElement("strong");
    title.className = "agent-decision-title";
    title.textContent = decision.title ?? "确认操作";
    card.append(title);
    if (typeof decision.description === "string" && decision.description.length > 0) {
      const description = doc.createElement("p");
      description.className = "agent-decision-description";
      description.textContent = decision.description;
      card.append(description);
    }
    const actionRow = doc.createElement("div");
    actionRow.className = "agent-decision-actions";
    if (decision.kind === "extreme") {
      const hint = doc.createElement("p");
      hint.className = "agent-decision-confirm";
      hint.textContent = `输入确认文字以执行：${decision.confirmation_text ?? ""}`;
      card.append(hint);
      const input = doc.createElement("input");
      input.type = "text";
      input.className = "agent-decision-input";
      input.dataset.testid = "agent-decision-input";
      input.setAttribute("aria-label", "输入确认文字");
      const execute = doc.createElement("button");
      execute.type = "button";
      execute.className = "btn btn--sm agent-decision-execute";
      execute.dataset.testid = "agent-decision-execute";
      execute.textContent = "执行";
      execute.disabled = true; // 精确文字输入前不可执行
      input.addEventListener("input", () => {
        execute.disabled = String(input.value ?? "") !== decision.confirmation_text;
      });
      execute.addEventListener("click", () => {
        if (execute.disabled) return;
        ctx.actions.decide?.(decision.decision_id, decision.confirmation_text);
      });
      const deny = doc.createElement("button");
      deny.type = "button";
      deny.className = "btn btn--sm agent-decision-deny";
      deny.dataset.testid = "agent-decision-deny";
      deny.textContent = "拒绝";
      deny.addEventListener("click", () => ctx.actions.decide?.(decision.decision_id, "deny"));
      actionRow.append(execute, deny);
      card.append(input, actionRow);
    } else {
      const choices = [
        ["allow", "一次允许"],
        ["allow_input", "本条输入允许同类操作"],
        ["deny", "拒绝"]
      ];
      for (const [choice, label] of choices) {
        const button = doc.createElement("button");
        button.type = "button";
        button.className = `btn btn--sm ${choice === "allow"
          ? "agent-decision-primary"
          : choice === "allow_input"
            ? "agent-decision-secondary"
            : "agent-decision-deny"}`;
        button.dataset.choice = choice;
        button.dataset.testid = "agent-decision-choice";
        button.textContent = label;
        button.addEventListener("click", () => ctx.actions.decide?.(decision.decision_id, choice));
        actionRow.append(button);
      }
      card.append(actionRow);
    }
    return card;
  }

  function syncDecisions(state) {
    if (rendered.decisions === state.revisions.decisions) return;
    rendered.decisions = state.revisions.decisions;
    const run = getActiveRun(state);
    if (!run || !isRunActive(run)) {
      // 待决决策只属于活动 Run；终态一律锁定，全部下架。
      for (const card of decisionCards.values()) card.remove();
      decisionCards.clear();
      return;
    }
    const pending = getPendingDecisions(state).filter((d) => d.run_id === run.id);
    const pendingIds = new Set(pending.map((d) => d.decision_id));
    // 只移除已终结/不再展示的卡；不重建仍在展示的卡（保留 extreme 确认输入文字）。
    for (const [id, card] of decisionCards) {
      if (!pendingIds.has(id)) {
        card.remove();
        decisionCards.delete(id);
      }
    }
    let appended = false;
    for (const decision of pending) {
      if (!decisionCards.has(decision.decision_id)) {
        const card = buildDecisionCard(decision);
        decisionCards.set(decision.decision_id, card);
        decisionsSlot.append(card);
        appended = true;
      }
    }
    if (appended) timeline.afterRender();
  }

  // ---- 错误卡（Round10：用户主层 + 可展开/复制技术详情） -------------------------
  function syncErrors(state) {
    if (rendered.errors === state.revisions.errors) return;
    rendered.errors = state.revisions.errors;
    errorsSlot.replaceChildren();
    for (const error of state.errors) {
      const card = doc.createElement("div");
      card.className = "agent-error";
      card.dataset.testid = "agent-error";
      card.setAttribute("role", "alert");
      const title = doc.createElement("strong");
      title.className = "agent-error-title";
      // 第十二轮 F5：连接类错误标「连接中断」，与 Run 失败（操作失败）区分。
      // Task 14：连接类 code 单源 = state.js 的 CONNECTION_ERROR_CODES。
      const isConnectionError = CONNECTION_ERROR_CODES.has(error.code);
      title.textContent = isConnectionError ? "连接中断" : "操作失败";
      const message = doc.createElement("p");
      message.className = "agent-error-message";
      // 主文案 = 用户事实；provider_configuration_error 有固定恢复文案。
      message.textContent = error.code === "provider_configuration_error"
        ? "模型尚未配置，当前任务无法继续。"
        : String(error.message ?? "操作失败。");
      card.append(title, message);
      const actionsRow = doc.createElement("div");
      actionsRow.className = "agent-error-actions";
      if (error.code === "provider_configuration_error") {
        // 主恢复动作 = 打开模型设置；重试仍只保留在 failed run header，不建第二条路径。
        const openSettings = doc.createElement("button");
        openSettings.type = "button";
        openSettings.className = "btn btn--sm btn--primary";
        openSettings.dataset.testid = "agent-error-settings";
        openSettings.textContent = "打开模型设置";
        openSettings.addEventListener("click", () => ctx.actions.openModelSettings?.());
        actionsRow.append(openSettings);
      }
      const copy = doc.createElement("button");
      copy.type = "button";
      copy.className = "btn btn--sm btn--ghost";
      copy.dataset.testid = "agent-error-copy";
      copy.textContent = "复制";
      // 复制技术详情；clipboard 缺失/同步异常/rejection 都显示「复制失败」，
      // 不产生未处理 rejection。writeText 必须带 clipboard receiver 调用
      //（拆出方法引用会抛 Illegal invocation）。
      copy.addEventListener("click", () => {
        const clipboard = globalThis.navigator?.clipboard;
        if (typeof clipboard?.writeText !== "function") {
          showToast("复制失败");
          return;
        }
        Promise.resolve()
          .then(() => clipboard.writeText(technical.textContent))
          .catch(() => {
            showToast("复制失败");
          });
      });
      actionsRow.append(copy);
      card.append(actionsRow);
      const details = doc.createElement("details");
      details.className = "agent-error-details";
      const summary = doc.createElement("summary");
      summary.textContent = "技术详情";
      const technical = doc.createElement("pre");
      technical.textContent = `${error.code ?? "model_error"}\n${error.message ?? "操作失败。"}`;
      details.append(summary, technical);
      card.append(details);
      errorsSlot.append(card);
    }
    if (state.errors.length > 0) timeline.afterRender();
  }

  // ---- 排队输入（Task 11）：原文 + 排队/下一条 + 立即 + 取消（撤回） ------------
  // 「立即」语义（SPEC 3.3 rule 8）：第一次请求被接受（priority_input_requested
  // 事件或快照 priority_input_id）后全部「立即」禁用，目标项标为下一条；优先输入
  // 真正开始（input_started）后恢复。以 snapshot/event 为准，不做乐观第二请求。
  function syncQueue(state) {
    if (rendered.queue === state.revisions.queue) return;
    rendered.queue = state.revisions.queue;
    queueSlot.replaceChildren();
    const priorityId = state.session?.priority_input_id ?? null;
    const promoteDisabled = priorityId != null;
    for (const item of getQueuedInputs(state)) {
      // 排队行确认送达：即时（pending/失败）气泡收敛为「接下来」排队行
      timeline.reconcilePendingSubmission({ input_id: item.id, text: item.text });
      const row = doc.createElement("div");
      row.className = "agent-queue-item";
      row.dataset.testid = "agent-queue-item";
      row.dataset.inputId = item.id;
      const text = doc.createElement("span");
      text.className = "agent-queue-text";
      text.textContent = String(item.text ?? "");
      const badge = doc.createElement("span");
      badge.className = "agent-queue-state";
      const isNext = priorityId != null && String(item.id) === String(priorityId);
      if (isNext) {
        row.classList.add("agent-queue-item--next");
        badge.textContent = "下一条";
      } else {
        badge.textContent = "排队";
      }
      const promote = doc.createElement("button");
      promote.type = "button";
      promote.className = "agent-promote btn btn--sm btn--ghost";
      promote.dataset.testid = "agent-promote";
      promote.textContent = "立即";
      promote.disabled = promoteDisabled;
      promote.addEventListener("click", () => {
        // 优先在途（快照/事件为准）时按钮 disabled；真实 DOM 不派发 click，
        // 这里再加一道防御，保证不做乐观第二请求。
        if (promote.disabled) return;
        const generation = ctx.viewGeneration;
        // 后端在已有优先在途时返回 409 priority_pending（双击/双窗口竞态）：
        // 失败必须给出可见反馈并吞掉 rejection，不得产生 unhandled rejection；
        // 迟到的失败（已切走项目/会话）不在新视图弹 toast。
        Promise.resolve(ctx.actions.requestPriority?.(item.id)).catch((error) => {
          if (generation !== ctx.viewGeneration) return;
          showToast(
            error?.code === "priority_pending"
              ? "已在优先处理中"
              : `请求失败：${String(error?.message ?? "请求失败")}`
          );
        });
      });
      const withdraw = doc.createElement("button");
      withdraw.type = "button";
      withdraw.className = "agent-withdraw btn btn--sm btn--ghost";
      withdraw.dataset.testid = "agent-withdraw";
      withdraw.textContent = "取消";
      withdraw.addEventListener("click", () => withdrawQueuedInput(item.id));
      row.append(text, badge, promote, withdraw);
      queueSlot.append(row);
    }
    timeline.afterRender();
  }

  // 撤回排队输入：成功后以接口返回的权威 draft_text 回填 composer——composer 为
  // 空时直接填入，已有草稿则以换行追加，绝不覆盖（SPEC 3.2 rule 5）；失败保持
  // 原 UI/草稿并 toast（队列行是否移除以 input_withdrawn 事件为准）。
  // 请求在途时切换项目/会话：reset() 递增 viewGeneration，迟到的 resolve/reject
  // 一律丢弃——旧项目的撤回文本不得写进新项目 composer，旧项目的失败也不得在
  // 新视图弹 toast（与 submitFromComposer 的 submissionGeneration 守卫一致）。
  function withdrawQueuedInput(inputId) {
    const generation = ctx.viewGeneration;
    Promise.resolve(ctx.actions.withdrawInput?.(inputId)).then((result) => {
      if (generation !== ctx.viewGeneration) return;
      const draftText = result?.draft_text;
      if (typeof draftText === "string" && draftText.length > 0) {
        appendWithdrawnDraft(draftText);
      }
    }).catch((error) => {
      if (generation !== ctx.viewGeneration) return;
      showToast(`撤回失败：${String(error?.message ?? "请求失败")}`);
    });
  }

  function appendWithdrawnDraft(text) {
    const current = String(input.value ?? "");
    input.value = current.length > 0 ? `${current}\n${text}` : text;
    input.focus?.();
  }

  return {
    syncDecisions,
    syncErrors,
    syncQueue
  };
}
