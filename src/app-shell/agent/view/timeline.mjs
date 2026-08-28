// src/app-shell/agent/view/timeline.mjs —— 消息时间线分区（Task 15，第十五轮）。
//
// 从 view.js 拆出的时间线职责：气泡/流式正文/前置分页与滚动锚定/上下文 gap/
// 压缩状态行。分区增量 reconcile（修订号早退）机制原样保留。
//
// ctx 契约（引用共享 + 活绑定 getter，与壳内同名变量语义一致）：
//   - 共享引用（const 对象，双方便携读写）：doc/messages/conv/scheduleFrame/
//     showToast/timelineSeqs/messageNodes/pendingSubmissions/failedSubmissions/
//     compactionRowNodes/rendered；
//   - 活绑定（壳内 let，经 getter 读最新值）：currentState/actions/viewGeneration/
//     followLatest。
// 分区私有状态不落 ctx：streamBubble/streamRenderPending/renderedStreamText/
// loadingEarlier/earlierAnchor/historyGapErrorNode/historyGapErrorSeq。
//
// F17 修复（第十五轮唯一行为例外）：节点从时间线移除统一走 removeNode——
// 先 timelineSeqs.delete(node) 再 node.remove()，杜绝 seq 索引陈旧条目泄漏
//（syncNotices 重渲染通知行等移除路径原来只 remove 不 delete）。
import { renderMarkdown } from "../../markdown-lite.mjs";
import { getCompactionRows } from "../state.js";

// Task 11 Step 4：压缩状态行固定文案映射（同一位置单行顶替；完成/失败/取消后
// 状态行仍留在时间线）。完成文案绝不携带 token/模型/耗时等详细数据。
const COMPACTION_ROW_LABELS = {
  started: "开始压缩",
  running: "压缩进行中",
  cancelling: "正在取消",
  completed: "已压缩完成",
  failed: "压缩失败",
  cancelled: "已取消",
  noop: "无需压缩"
};

// 各状态的动作按钮：failed → 重试+取消；running → 取消；cancelled → 重试
//（第十二轮 F4：压缩取消后可重试——后端 retryCompaction 已支持 cancelled；
// Run 已终态时的点击由后端 compaction_no_run 守卫兜底报错，前端不做禁用）。
const COMPACTION_ROW_BUTTONS = {
  started: [],
  running: ["cancel"],
  cancelling: [],
  completed: [],
  failed: ["retry", "cancel"],
  cancelled: ["retry"],
  noop: []
};

// 前置分页（Task 10 Step 4）：距顶部 ≤240px 且有更早历史时加载前置页。
const EARLIER_SCROLL_THRESHOLD = 240;

export function createTimelineView(ctx) {
  // 共享引用解构（const 对象，引用共享）：壳与分区读写同一份状态。
  const { doc, messages, conv, scheduleFrame, timelineSeqs, messageNodes,
          pendingSubmissions, failedSubmissions, compactionRowNodes, rendered, showToast } = ctx;
  // 活绑定不在此解构——经 ctx.currentState/ctx.actions/ctx.viewGeneration/
  // ctx.followLatest getter 每次读取最新值（壳内 let 由壳赋值）。

  // ---- 分区私有状态（原 view.js 闭包 let 迁入）-----------------------------
  let streamBubble = null;         // 流式 assistant 气泡（delta 期间的临时节点）
  let streamRenderPending = false; // 已有未决帧渲染
  let renderedStreamText = null;   // 最近已渲染的累积文本
  let loadingEarlier = false;      // 与 index.js 双保险的防重复标记
  let earlierAnchor = null;        // { oldHeight, oldTop }：前置插入前记录
  let historyGapErrorNode = null;  // 加载失败的一次性可重试提示
  let historyGapErrorSeq = null;

  // F17 修复：时间线节点移除的统一出口——先清 seq 索引再摘节点。调用的所有
  // 移除路径（含原漏 delete 的路径）都必须走这里，否则 timelineSeqs 留下
  // 陈旧条目（size 随重渲染无限增长，且影响 insertTimeline 排序扫描）。
  // 评审收口（Important#1）：同时清 event_key -> 节点键映射——insertTimeline 对
  // 带 eventKey 的节点同步打了 dataset.eventKey（1:1），故调用点不再需要手工
  // 成对写 messageNodes.delete。幂等：对未入索引/未打 key 的节点（流式气泡、
  // 失败气泡、无 eventKey 节点）都是空操作。reset/destroy 保持裸 remove + map
  // clear 边界（整体清空语境，不走本函数）。
  function removeNode(node) {
    if (node == null) return;
    timelineSeqs.delete(node);
    if (node.dataset?.eventKey != null) messageNodes.delete(node.dataset.eventKey);
    node.remove();
  }

  // ---- 自动滚动：显式 follow 状态（仅用户接近底部时跟随） ----------------------
  // 用户滚动事件是 follow 状态的唯一来源；渲染后不再重新测量 isNearBottom()，
  // 否则内容高度变化会误判并把滚动抢回底部，打断正在阅读更早内容的用户。
  function distanceFromBottom(el) {
    const height = Number(el.scrollHeight ?? 0);
    const client = Number(el.clientHeight ?? 0);
    const top = Number(el.scrollTop ?? 0);
    if (height <= client) return 0;
    return height - top - client;
  }

  function scrollToBottom() {
    const height = Number(conv.scrollHeight ?? 0);
    const client = Number(conv.clientHeight ?? 0);
    conv.scrollTop = Math.max(0, height - client);
  }

  function afterRender() {
    if (ctx.followLatest) scrollToBottom();
  }

  function maybeLoadEarlier() {
    if (loadingEarlier) return;
    const state = ctx.currentState;
    if (!state?.hasEarlier) return;
    const minSeq = state.minSeq;
    if (minSeq == null) return;
    if (Number(conv.scrollTop ?? 0) > EARLIER_SCROLL_THRESHOLD) return;
    loadingEarlier = true; // 防重复：请求结束后由 index.js 调 setLoadingEarlier(false) 恢复
    ctx.actions.loadEarlier?.(minSeq);
  }

  // 前置插入前记录 oldHeight/oldTop；插入完成后按 newHeight-oldHeight+oldTop
  // 恢复 scrollTop，保证原消息锚点不跳动。
  function prepareEarlierInsert() {
    earlierAnchor = { oldHeight: Number(conv.scrollHeight ?? 0), oldTop: Number(conv.scrollTop ?? 0) };
  }
  function restoreScrollAnchor() {
    if (!earlierAnchor) return;
    const newHeight = Number(conv.scrollHeight ?? 0);
    const added = newHeight - earlierAnchor.oldHeight;
    if (added >= 0) conv.scrollTop = added + earlierAnchor.oldTop;
    earlierAnchor = null;
  }

  // 前置页加载失败：只显示一次可重试的历史缺口提示，不清空当前消息。
  function showHistoryLoadError(beforeSeq) {
    if (historyGapErrorNode) return;
    historyGapErrorSeq = beforeSeq;
    historyGapErrorNode = doc.createElement("div");
    historyGapErrorNode.className = "agent-history-gap agent-history-gap--error";
    historyGapErrorNode.dataset.testid = "agent-history-gap-error";
    const text = doc.createElement("span");
    text.textContent = "此处有一段历史不可读";
    const retry = doc.createElement("button");
    retry.type = "button";
    retry.dataset.testid = "agent-history-gap-retry";
    retry.textContent = "重试";
    retry.addEventListener("click", () => {
      ctx.actions.loadEarlier?.(historyGapErrorSeq);
    });
    historyGapErrorNode.append(text, retry);
    insertTimeline(historyGapErrorNode, beforeSeq, null);
  }
  function clearHistoryLoadError() {
    if (!historyGapErrorNode) return;
    removeNode(historyGapErrorNode);
    historyGapErrorNode = null;
    historyGapErrorSeq = null;
  }

  // ---- 对话 ----------------------------------------------------------------
  function createMessageBubble(role, textValue, { markdown = false, truncated = false, interrupted = false, narration = false } = {}) {
    const bubble = doc.createElement("div");
    bubble.className = `agent-message agent-message--${role}`;
    bubble.dataset.testid = `agent-${role}-message`;
    const text = doc.createElement("div");
    text.className = "agent-message-text" + (markdown ? " agent-markdown" : "");
    if (markdown) {
      // 助手正文按累积文本重渲染 Markdown（renderMarkdown 纯函数，先转义后结构转换）。
      text.innerHTML = renderMarkdown(String(textValue ?? ""));
    } else {
      text.textContent = String(textValue ?? "");
    }
    bubble.append(text);
    if (narration) bubble.classList.add("agent-message--narration");
    if (truncated) {
      // Task 4：max_tokens 截断提示。独立元素追加在文本区域之后，不修改正文本身。
      const mark = doc.createElement("div");
      mark.className = "agent-message-truncation";
      mark.dataset.testid = "truncation-mark";
      mark.textContent = "ⓘ 输出被截断";
      bubble.append(mark);
    }
    if (interrupted) {
      // 第十二轮 F1：Run 终态定稿的半截正文带中断标记（区别于正常定稿气泡）。
      const mark = doc.createElement("div");
      mark.className = "agent-message-truncation";
      mark.dataset.testid = "interrupted-mark";
      mark.textContent = "ⓘ 已中断";
      bubble.append(mark);
    }
    return bubble;
  }

  function reconcilePendingSubmission(entry) {
    let index = pendingSubmissions.findIndex((item) =>
      item.inputId != null && item.inputId === entry.input_id
    );
    // 第十二轮 F10：弃用同文本回退（同文本双发会误删在途气泡）；POST 尚未
    // resolve 时按 FIFO 归属最旧的未回填气泡——事件到达序与提交序一致。
    // ponytail: FIFO 依赖服务器按提交序处理+传输有序；快速连发且 POST 未
    // resolve 时 input_queued 确认可能错配到更旧的在途气泡（自愈：input_started
    // 到达后按事件重放重新插回用户气泡；极端窗口内旧 POST 失败则失败气泡挂在
    // detached 节点不可见）——同文本双发误删比此 corner 更常见，FIFO 是更稳默认。
    if (index < 0) {
      index = pendingSubmissions.findIndex((item) => item.inputId == null);
    }
    // Task 6：该 user 消息已由快照/SSE 回放确认送达，同文本失败气泡一并移除。
    // 失败登记时其 pending 记录已移出，故移除不能依赖 pending 匹配——送达即撤，
    // 覆盖「客户端 promise 恰好 reject 但后端实际已受理」的回放确认场景。
    removeFailedBubble(entry.text);
    if (index < 0) return;
    removeNode(pendingSubmissions[index].node);
    pendingSubmissions.splice(index, 1);
  }

  // Task 6：移除文本对应的失败气泡（含错误文案）。幂等——节点已脱离时 remove
  // 为空操作（F17：统一走 removeNode，对未入 seq 索引的节点 delete 亦为空操作）。
  function removeFailedBubble(text) {
    const needle = String(text ?? "").trim();
    if (!needle) return;
    for (let i = failedSubmissions.length - 1; i >= 0; i--) {
      if (failedSubmissions[i].text === needle) {
        removeNode(failedSubmissions[i].node);
        failedSubmissions.splice(i, 1);
      }
    }
  }

  // 时间线插入：气泡、活动行与工作组共享 messages 容器，按 (seq, event_key)
  // 稳定排序落位（Task 10：同时支持前置与后置；相同 seq 按 event key 字典序）。
  // eventKey 不为 null 时做稳定 key 去重，并给节点打上 data-event-key/data-seq。
  function insertTimeline(node, seq, eventKey = null) {
    if (eventKey != null) {
      if (messageNodes.has(eventKey)) return; // 重建/重复页：不重复插入
      messageNodes.set(eventKey, node);
      node.dataset.eventKey = eventKey;
    }
    if (seq != null) node.dataset.seq = String(seq);
    if (seq == null) {
      messages.append(node);
      timelineSeqs.set(node, seq);
      return;
    }
    const children = messages.children;
    // 无 seq 节点（pending 用户气泡、流式气泡等）固定靠后：先定位最后一个有 seq
    // 节点的位置。有 seq 节点之间仍按 (seq, eventKey) 稳定排序（Task 10）。
    let lastSeqIndex = -1;
    for (let i = children.length - 1; i >= 0; i -= 1) {
      if (timelineSeqs.get(children[i]) != null) { lastSeqIndex = i; break; }
    }
    let index = lastSeqIndex + 1; // 默认：最后一个有 seq 节点之后
    for (let i = lastSeqIndex; i >= 0; i -= 1) {
      const childSeq = timelineSeqs.get(children[i]);
      if (childSeq == null) continue; // 理论不可达（lastSeqIndex 之后全无 seq）
      if (childSeq < seq) {
        index = i + 1;
        break;
      }
      if (childSeq === seq) {
        const childKey = children[i].dataset?.eventKey ?? "";
        if (childKey <= (eventKey ?? "")) {
          index = i + 1;
          break;
        }
      }
      index = i;
    }
    // B1 修复：若新 seq 节点排到有 seq 区的末尾（index === lastSeqIndex+1），其
    // 后还有无 seq 节点（pending 用户气泡 = 用户刚发的消息），则追加到末尾——
    // 工作组不得压到 pending 用户气泡上方（工作组必须跟在 pending 气泡之后）。
    if (index === lastSeqIndex + 1 && lastSeqIndex < children.length - 1) {
      index = children.length; // append：落在无 seq 尾区之后
    }
    if (index >= children.length) {
      messages.append(node);
    } else if (typeof messages.insertBefore === "function") {
      messages.insertBefore(node, children[index]);
    } else {
      // 测试 DOM mock 无 insertBefore：用 replaceChildren 重排（真实 DOM 走上面分支）
      const all = children.slice();
      all.splice(index, 0, node);
      messages.replaceChildren(...all);
    }
    timelineSeqs.set(node, seq);
  }

  function syncMessages(state) {
    if (rendered.messages === state.revisions.messages) return;
    for (const entry of state.conversation) {
      const eventKey = entry.event_key ?? null;
      if (eventKey != null && messageNodes.has(eventKey)) {
        // 第十二轮 N2：已渲染气泡重同步 narration 淡化类（终态标记/重建后补齐）。
        messageNodes.get(eventKey).classList.toggle("agent-message--narration", entry.narration === true);
        continue; // 已渲染（重建去重）
      }
      if (entry.role === "user") {
        reconcilePendingSubmission(entry);
        insertTimeline(createMessageBubble("user", entry.text), entry.seq, eventKey);
      } else if (typeof entry.text === "string" && entry.text.length > 0) {
        // 助手正文走 Markdown 渲染（与流式气泡同一口径，增量/终态一致）。
        insertTimeline(
          createMessageBubble("assistant", entry.text, { markdown: true, truncated: entry.truncated === true, interrupted: entry.interrupted === true, narration: entry.narration === true }),
          entry.seq,
          eventKey
        );
      }
    }
    rendered.messages = state.revisions.messages;
    afterRender();
  }

  // ---- 增量正文流：累积文本 → Markdown，rAF 合帧节流 -------------------------
  function scheduleStreamRender() {
    if (streamRenderPending) return;
    streamRenderPending = true;
    scheduleFrame(() => {
      streamRenderPending = false;
      renderStreamNow();
    });
  }

  function renderStreamNow() {
    const text = ctx.currentState?.assistantStream?.text ?? "";
    if (!text) {
      if (streamBubble) removeNode(streamBubble);
      streamBubble = null;
      renderedStreamText = null;
      return;
    }
    if (!streamBubble) {
      streamBubble = createMessageBubble("assistant", text, { markdown: true });
      streamBubble.dataset.streaming = "true";
      messages.append(streamBubble);
    }
    const textEl = streamBubble.querySelector(".agent-message-text");
    if (textEl) {
      textEl.innerHTML = renderMarkdown(text);
      // AICSS streaming-text：流式实心光标（8px×1.05em，见 agent.css）。定稿
      // （assistant_message_completed）后流式气泡被 syncStream 移除，光标随之
      // 消失——无闪烁态：WWriting 没有"播完未折叠"的中间态（有意为之）。
      const caret = doc.createElement("span");
      caret.className = "agent-stream-caret";
      caret.setAttribute("aria-hidden", "true");
      textEl.append(caret);
    }
    renderedStreamText = text;
    afterRender();
  }

  function syncStream(state) {
    const text = state.assistantStream?.text ?? "";
    if (!text) {
      // 终态/切换：立即移除流式气泡并取消未决帧（帧回调即使执行也只是空转）。
      if (streamBubble) removeNode(streamBubble);
      streamBubble = null;
      streamRenderPending = false;
      renderedStreamText = null;
      return;
    }
    if (text === renderedStreamText) return;
    scheduleStreamRender();
  }

  // ---- 上下文 gap（Task 10 Step 2）：page.gaps 投影为时间线节点，不伪造消息 ----
  function syncGaps(state) {
    for (const gap of state.historyGaps) {
      if (messageNodes.has(gap.event_key)) continue;
      const node = doc.createElement("div");
      node.className = "agent-history-gap";
      node.dataset.testid = "agent-history-gap";
      const text = doc.createElement("span");
      text.className = "agent-history-gap-text";
      text.textContent = "此处有一段历史不可读";
      node.append(text);
      insertTimeline(node, gap.start_seq, gap.event_key);
    }
  }

  // ---- 压缩状态行（Task 11 Step 4）：每个 compaction_id 一行，单行顶替 -------
  // 行结构：外层 .agent-compaction（时间线节点，带 compaction_id）包含
  // .agent-compaction-row（固定文案所在行，textContent 只等于 LABELS 文案）与
  // .agent-compaction-actions（动作按钮）。同一行只更新 label textContent 与
  // 动作按钮，不重建 DOM；完成/取消/noop 移除按钮。
  function buildCompactionRow(entry) {
    const wrap = doc.createElement("div");
    wrap.className = "agent-compaction";
    wrap.dataset.compactionId = entry.compaction_id;
    const row = doc.createElement("div");
    row.className = "agent-compaction-row";
    row.dataset.testid = "agent-compaction-row";
    const label = doc.createElement("span");
    label.className = "agent-compaction-label";
    row.append(label);
    const detail = doc.createElement("div");
    detail.className = "agent-compaction-detail";
    detail.dataset.testid = "agent-compaction-detail";
    detail.hidden = true;
    const actions = doc.createElement("div");
    actions.className = "agent-compaction-actions";
    wrap.append(row, detail, actions);
    return { wrap, row, label, detail, actions, seq: null, eventKey: null, buttonsSignature: "" };
  }

  function updateCompactionRow(record, entry) {
    // Task 12：未知压缩状态回退中文文案，不回退为英文 state code。
    const labelText = COMPACTION_ROW_LABELS[entry.state] ?? "处理中";
    if (record.label.textContent !== labelText) record.label.textContent = labelText;
    record.wrap.dataset.state = entry.state;
    const sourceTooLarge = entry.state === "failed" && entry.error_code === "compaction_source_exceeds_window";
    record.detail.hidden = !sourceTooLarge;
    record.detail.textContent = sourceTooLarge
      ? "compaction_source_exceeds_window：源材料超过上下文窗口，请清空对话历史后重试。"
      : "";
    // 按钮只按状态签名重建：失败 → 重试+取消；running → 取消；其余无按钮。
    const buttons = sourceTooLarge ? [] : (COMPACTION_ROW_BUTTONS[entry.state] ?? []);
    const signature = buttons.join(",");
    if (signature === record.buttonsSignature) return;
    record.buttonsSignature = signature;
    record.actions.replaceChildren();
    if (buttons.includes("retry")) {
      const retry = doc.createElement("button");
      retry.type = "button";
      retry.className = "btn btn--sm";
      retry.dataset.testid = "agent-compaction-retry";
      retry.textContent = "重试";
      retry.addEventListener("click", () => runCompactionAction(
        retry,
        "重试压缩",
        () => ctx.actions.retryCompaction?.(entry.compaction_id)
      ));
      record.actions.append(retry);
    }
    if (buttons.includes("cancel")) {
      const cancel = doc.createElement("button");
      cancel.type = "button";
      cancel.className = "btn btn--sm";
      cancel.dataset.testid = "agent-compaction-cancel";
      cancel.textContent = "取消";
      cancel.addEventListener("click", () => runCompactionAction(
        cancel,
        "取消压缩",
        () => ctx.actions.cancelCompaction?.(entry.compaction_id)
      ));
      record.actions.append(cancel);
    }
  }

  function runCompactionAction(button, label, action) {
    if (button.disabled) return;
    button.disabled = true;
    const generation = ctx.viewGeneration;
    const fail = (error) => {
      if (generation !== ctx.viewGeneration) return;
      button.disabled = false;
      showToast(`${label}失败：${String(error?.message ?? "请求失败")}`);
    };
    let request;
    try {
      request = action();
    } catch (error) {
      fail(error);
      return;
    }
    Promise.resolve(request).catch(fail);
  }

  function syncCompactionRows(state) {
    for (const entry of getCompactionRows(state).values()) {
      let record = compactionRowNodes.get(entry.compaction_id);
      if (!record) {
        record = buildCompactionRow(entry);
        compactionRowNodes.set(entry.compaction_id, record);
        record.seq = entry.seq;
        record.eventKey = entry.event_key;
        insertTimeline(record.wrap, entry.seq, entry.event_key);
        updateCompactionRow(record, entry);
        afterRender();
        continue;
      }
      // 重建后锚点前移（前置页补到了 started）：移除并按新锚点重插。
      //（键映射与 seq 索引由 removeNode 统一清除——旧 eventKey 即 dataset.eventKey。）
      if (record.seq !== entry.seq || record.eventKey !== entry.event_key) {
        removeNode(record.wrap);
        record.seq = entry.seq;
        record.eventKey = entry.event_key;
        insertTimeline(record.wrap, entry.seq, entry.event_key);
      }
      updateCompactionRow(record, entry);
    }
    // state 层已移除的 id（重建后不存在）：同步移除对应 DOM 行。
    for (const [id, record] of compactionRowNodes) {
      if (!getCompactionRows(state).has(id)) {
        //（键映射与 seq 索引由 removeNode 统一清除。）
        removeNode(record.wrap);
        compactionRowNodes.delete(id);
      }
    }
  }

  // ---- 对外（壳经此接口接回时间线；index.js 的公开入口仍由壳转发）------------
  function setLoadingEarlier(enabled) {
    loadingEarlier = enabled === true;
  }

  // reset：时间线分区自己的清理（整体清空语境，seq 索引随 map clear 归零，无泄漏）。
  function reset() {
    // 工作组已插入 messages 统一时间线：整体清空 messages 与 seq/key 映射。
    messages.replaceChildren();
    timelineSeqs.clear();
    messageNodes.clear();
    if (streamBubble) { streamBubble.remove(); streamBubble = null; }
    streamRenderPending = false;
    renderedStreamText = null;
    for (const record of compactionRowNodes.values()) {
      record.wrap.remove();
      if (record.eventKey != null) messageNodes.delete(record.eventKey);
      timelineSeqs.delete(record.wrap);
    }
    compactionRowNodes.clear();
    pendingSubmissions.length = 0;
    failedSubmissions.length = 0;
    loadingEarlier = false;
    earlierAnchor = null;
    if (historyGapErrorNode) { historyGapErrorNode.remove(); historyGapErrorNode = null; historyGapErrorSeq = null; }
  }

  function destroy() {
    timelineSeqs.clear();
    messageNodes.clear();
  }

  return {
    syncMessages,
    syncStream,
    syncGaps,
    syncCompactionRows,
    scrollToBottom,
    afterRender,
    maybeLoadEarlier,
    distanceFromBottom,
    prepareEarlierInsert,
    restoreScrollAnchor,
    showHistoryLoadError,
    clearHistoryLoadError,
    reconcilePendingSubmission,
    removeFailedBubble,
    removeNode,
    insertTimeline,
    createMessageBubble,
    setLoadingEarlier,
    reset,
    destroy
  };
}
