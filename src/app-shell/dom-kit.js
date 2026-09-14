// src/app-shell/dom-kit.js —— 前端共享 DOM/form 构建层（第十五轮 F6）。
// 唯一 hyperscript 入口（el）+ 自动保存表单绑定（bindAutosave）+ 行内错误提示
//（showFieldError/clearFieldError/fieldError）+ 焦点陷阱（focusTrap）+ 确认弹层
//（showConfirmLayer，Task 12 收编 settings-modal/app.js）+ toast 单源
//（createToaster，Task 13 收编 agent/view.js 与 app.js）。
//
// 依赖注入约定：el 的 doc 为文档引用（默认全局 document，真实 Electron 环境）——
// node:test 下调用方必须注入测试 document/mock，与 model-settings-page 的
// documentRef ctx 注入同语义（该页在 createModelSettingsPage 内一行桥接）。

// 行内错误写入：refs.errorRefs 为 fieldKey → 错误行 span 的 Map。
export function showFieldError(refs, fieldKey, message) {
  const span = refs?.errorRefs?.get(fieldKey);
  if (span) span.textContent = message;
}

export function clearFieldError(refs, fieldKey) {
  showFieldError(refs, fieldKey, "");
}

// 失焦（change）自动保存（Task 20 draft-first）：空值/非法值不再静默丢弃——
// 保留编辑态（输入值不动）并行内显示中文错误；合法值才提交保存。
// commit 返回 { ok, error }（commitProviderPatch/commitModelPatch 形状），
// 失败时行内回显错误（toast 由 commit 内部弹）。
// Task 22（#11）：onEnter 开启时绑定 Enter——与失焦保存同一提交路径，使
//「名称框回车保存」提示文案与真实行为一致（校验/行内错误行为完全相同）。
// Task 22 审查（Important 1）：run() 内记 lastCommitted（提交前乐观置位，失败
// 复位）——真实 DOM 在输入框被移除时派发挂起的 change（Enter 保存成功后
// refresh 重建详情，被替换的输入框仍是焦点元素且带挂起 change），同值二次
// 触发 run() 会重复 PATCH；同值跳过（含在途竞态与 Enter 连按）不丢新改动
//（值变化后仍正常提交，失败后同值可重试）。
export function bindAutosave(input, { refs, fieldKey, validate = null, commit, onEnter = false }) {
  let lastCommitted = null;
  const run = async () => {
    const value = input.value.trim();
    if (value === lastCommitted) return;
    const error = validate ? validate(value) : null;
    if (error) {
      showFieldError(refs, fieldKey, error);
      return;
    }
    lastCommitted = value;
    clearFieldError(refs, fieldKey);
    const result = await commit(value);
    if (result?.ok === false) {
      lastCommitted = null; // 失败复位：同一值可重试
      showFieldError(refs, fieldKey, result.error ?? "保存失败，请重试");
    }
  };
  input.addEventListener("change", run);
  if (onEnter) {
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      void run();
    });
  }
}

// 校验失败出口：行内回显中文错误并保留编辑态，返回 { ok: false } 中止后续动作。
export function fieldError(refs, fieldKey, message) {
  showFieldError(refs, fieldKey, message);
  return { ok: false, error: message };
}

// hyperscript：最简 element 构建（text/class/value/disabled 走 property，
// 其余属性直映射 setAttribute）。doc 为文档引用——调用方注入（见头注释）。
export function el(tag, props = {}, children = [], doc = globalThis.document) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else if (key === "value") node.value = value; // value 走 property 而非 setAttribute：保住用户已键入的值
    else if (key === "disabled") node.disabled = Boolean(value); // 同 value 走 property：真 DOM 与测试 mock 均正确反映禁用态
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (typeof child === "string") node.append(doc.createTextNode(child));
    else if (child) node.append(child);
  }
  return node;
}

// 可聚焦元素选择器（Task 22 审查 Minor 4 口径）：focusTrap 与 settings-modal 的
// focusFirstInModal 共用同一选择器与过滤规则（隐藏=offsetParent null/禁用不得
// 接收焦点），避免两处口径分叉。
export const FOCUSABLE_SELECTOR = "button, [href], input, select, textarea, [tabindex]:not([tabindex=\"-1\"])";

// 焦点陷阱（Task 12 合一：app.js trapTab + settings-modal bindModalTabTrap）：
// 两原实现选择器与过滤规则相同（可见且未禁用），Tab 在容器内首末回绕；无
// focusable 时 preventDefault；容器无 querySelectorAll（node:test 轻量 mock）时
// 直接放行。stopPropagation 对两调用点均安全：scrim 级监听（settings-modal）需要
// 它阻断 document 级路由的重复处理；document 级调用点（app.js）事件已抵达目标，
// stopPropagation 不影响同目标其他监听器。show 守卫（弹窗开着才拦截）由
// settings-modal 调用点保留，本函数不管容器显隐态。
export function focusTrap(root, event) {
  if (event?.key !== "Tab" || !root || typeof root.querySelectorAll !== "function") return;
  const focusables = [...root.querySelectorAll(FOCUSABLE_SELECTOR)]
    .filter((el) => !el.disabled && el.offsetParent !== null);
  if (focusables.length === 0) { event.preventDefault?.(); return; }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault?.();
    event.stopPropagation?.();
    last.focus?.();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault?.();
    event.stopPropagation?.();
    first.focus?.();
  }
}

// 确认弹层（Task 12 收编 settings-modal 的清空历史/放弃关闭两层）：层结构/样式/
// 背景点击关闭/Esc（document capture，阻断弹窗级与 Run 停止路由，stopImmediate-
// Propagation 见 bindNestedLayerDismissal 同款）/确认按钮禁用管理统一在此，差异
// 全走 options——danger 建 ack 复选框（勾选才启用确认按钮）与错误回显行，zIndex
// 可调（放弃确认层盖在清空层之上）。resolve(true)=确认成功且层已关闭；
// resolve(false)=取消/背景/Esc。onConfirm 为可选异步确认动作：成功才关闭，失败
// 在错误行回显并保持层打开（可重试）；期间层被取消/外部关闭则丢弃迟到错误。
// 宿主如需主动关闭（弹窗关闭路径），用返回 promise 上的 .close（幂等）；任何
// 路径关闭层（取消/背景/Esc/确认成功/外部.close）都会触发 options.onClose——
// 宿主借此同步「层已开」的外部状态（settings-modal 用它在 guard 里判重开）。
export function showConfirmLayer(options) {
  const {
    doc = globalThis.document,
    host,
    id = "confirm",
    title = "",
    message = "",
    confirmLabel = "确认",
    cancelLabel = "取消",
    danger = false,
    ackLabel = "",
    zIndex = "20",
    onConfirm = null,
    onClose = null
  } = options;
  if (!host || typeof doc?.createElement !== "function") return Promise.resolve(false);

  let closed = false;
  let settled = false;
  let resolveResult = null;
  const resultPromise = new Promise((resolve) => { resolveResult = resolve; });
  const settle = (value) => {
    if (settled) return;
    settled = true;
    resolveResult(value);
  };

  const layer = doc.createElement("div");
  layer.className = "spd-confirm-layer";
  layer.id = `${id}-confirm`;
  layer.hidden = false;
  Object.assign(layer.style, {
    position: "absolute",
    inset: "0",
    zIndex,
    background: "rgba(20, 18, 14, 0.45)",
    display: "grid",
    placeItems: "center",
    padding: "28px"
  });

  const card = doc.createElement("div");
  card.className = "spd-confirm-card";
  Object.assign(card.style, {
    width: "min(430px, 100%)",
    background: "var(--surface)",
    border: "1px solid var(--line)",
    borderRadius: "var(--r-lg)",
    boxShadow: "var(--shadow-pop)",
    padding: "22px 24px",
    display: "grid",
    gap: "14px"
  });

  const titleEl = doc.createElement("h4");
  titleEl.className = "spd-section";
  titleEl.style.margin = "0";
  titleEl.textContent = title;

  const copy = doc.createElement("p");
  copy.className = "spd-confirm-copy spd-hint";
  copy.style.margin = "0";
  copy.textContent = message;

  // danger：危险操作二次确认（ack 复选框勾选才启用确认按钮）+ 错误回显行。
  let ackLabelEl = null;
  let ack = null;
  let errEl = null;
  if (danger) {
    ackLabelEl = doc.createElement("label");
    Object.assign(ackLabelEl.style, { display: "flex", alignItems: "center", gap: "8px", fontSize: "13px" });
    ack = doc.createElement("input");
    ack.type = "checkbox";
    ack.id = `${id}-ack`;
    Object.assign(ack.style, { width: "16px", height: "16px" });
    const ackSpan = doc.createElement("span");
    ackSpan.textContent = ackLabel;
    ackLabelEl.append(ack, ackSpan);
    errEl = doc.createElement("div");
    errEl.className = "spd-field-error";
    errEl.id = `${id}-error`;
    errEl.hidden = true;
  }

  const actions = doc.createElement("div");
  Object.assign(actions.style, { display: "flex", justifyContent: "flex-end", gap: "10px" });
  const cancelBtn = el("button", { type: "button", class: "btn", text: cancelLabel }, [], doc);
  cancelBtn.id = `${id}-cancel`; // id 走实例属性：node:test mock 按 el.id 查找
  const confirmBtn = el("button", { type: "button", class: "btn", disabled: danger, text: confirmLabel }, [], doc);
  confirmBtn.id = `${id}-confirm-btn`;
  actions.append(cancelBtn, confirmBtn);

  if (ack) {
    ack.addEventListener("change", () => { confirmBtn.disabled = !ack.checked; });
  }
  cancelBtn.addEventListener("click", () => closeLayer(false));
  confirmBtn.addEventListener("click", () => { void runConfirm(); });

  card.append(titleEl, copy, ...[ackLabelEl, errEl].filter(Boolean), actions);
  layer.append(card);
  host.append(layer);

  // Esc：document capture 先于弹窗级 bubble 与 AgentSurface 的 Run 停止路由。
  const onDocKeydown = (event) => {
    if (event?.key !== "Escape") return;
    closeLayer(false);
    event.stopImmediatePropagation?.();
    event.preventDefault?.();
  };
  doc.addEventListener("keydown", onDocKeydown, true);
  // 点击层背景（卡片外部）关闭本层，不触碰弹窗级处理器。
  const onLayerClick = (event) => {
    if (event?.target === layer) closeLayer(false);
  };
  layer.addEventListener("click", onLayerClick);

  // 层打开即聚焦取消按钮（Task 22 键盘焦点顺序）：与 settings-modal 原两层同款，
  // 焦点不落在弹窗外（否则 Esc/Tab 逃逸到弹窗路由）。
  cancelBtn.focus?.();

  // 确认：先禁用按钮（防双击），onConfirm 成功才关闭；失败回显并恢复按钮状态。
  const runConfirm = async () => {
    if (confirmBtn.disabled) return;
    confirmBtn.disabled = true;
    try {
      if (onConfirm) await onConfirm();
      closeLayer(true);
    } catch (caught) {
      if (closed) return; // 等待期间被取消/外部关闭：丢弃迟到失败反馈
      confirmBtn.disabled = danger ? !ack?.checked : false;
      if (errEl) {
        errEl.textContent = caught?.message ?? String(caught);
        errEl.hidden = false;
      }
    }
  };

  function closeLayer(value = false) {
    if (closed) return; // 幂等：弹窗关闭路径可能二次调用
    closed = true;
    doc.removeEventListener("keydown", onDocKeydown, true);
    layer.removeEventListener?.("click", onLayerClick);
    layer.replaceChildren();
    layer.hidden = true;
    settle(value);
    onClose?.();
  }

  resultPromise.close = closeLayer;
  return resultPromise;
}

// toast 单源（Task 13，F6）：agent surface 自持单例 toast（撤回失败等）与 app
// shell 全局堆叠 toast 共用同一份建节点/计时/移除逻辑。getRoot() 每次调用取
// 容器（app.js 版传 () => refs.toastStack——null 时 showToast 静默返回，与
// 原守卫一致；agent 版传 () => surface）。两调用点差异全走 options：
//   single     true=单例复用容器内唯一节点（新消息刷新同节点与文本，角色固定
//              status）；false=堆叠（每次追加新节点，type 决定角色/图标/时长）
//   selector   single 模式查找既有节点的选择器（agent 版 data-testid）
//   testId     single 模式创建节点的 data-testid（null 不设）
//   className  节点 class；堆叠版按 `${className} ${type}` 拼接（type 配色）
//   iconFor    (type) => 图标节点 | null（堆叠版注入；single 版无图标）
//   timeoutFor (type) => 停留毫秒（single 版传 () => 3000）
//   leaveMs    >0 时超时先加 leaving class、延迟 leaveMs 后移除（堆叠版消失
//              动画；single 版直接移除）
// scheduler 可注入计时（node:test 下可 mock）；doc 同 el 的注入约定。
// clearToast()：single=清定时并移除唯一节点；堆叠=清空容器全部子节点（app.js
// clearTransientState 的项目切换清空经此，无需再直接摸容器 children）。
export function createToaster(getRoot, options = {}) {
  const {
    doc = globalThis.document,
    scheduler = globalThis,
    single = false,
    selector = null,
    testId = null,
    className = "toast",
    iconFor = null,
    timeoutFor = null,
    leaveMs = 0
  } = options;

  // ponytail: 堆叠模式 timer 仅跟踪最后一条的移除调度——其余条目的到期回调
  // 在已移除（或已离开容器）的节点上执行是幂等空操作；勿在此「顺手」加堆叠
  // 计时清理，那会重犯 P1（上一条调度被取消 → 永久滞留）。
  let timer = null;
  const clearTimer = () => {
    if (timer != null) {
      scheduler.clearTimeout?.(timer);
      timer = null;
    }
  };

  function showToast(message, type = "info") {
    const root = getRoot();
    if (!root) return;
    if (!single && !message) return; // 堆叠版原守卫：空消息静默
    // 只有单例模式需要清旧 timer（新消息刷新同一节点的移除调度）；堆叠模式每条
    // toast 独立 setTimeout 互不干扰——清旧会取消上一条的移除，使其永久滞留。
    if (single) clearTimer();
    let node;
    if (single) {
      node = selector ? root.querySelector?.(selector) : null;
      if (!node) {
        node = doc.createElement("div");
        node.className = className;
        if (testId) node.dataset.testid = testId;
        node.setAttribute("role", "status");
        root.append(node);
      }
      node.textContent = message;
    } else {
      node = doc.createElement("div");
      node.className = `${className} ${type}`.trim();
      // Round10：error 是 alert（打断性），其余 status（stack 本身 aria-live=polite）。
      node.setAttribute("role", type === "error" ? "alert" : "status");
      const iconNode = iconFor?.(type);
      if (iconNode) node.append(iconNode);
      node.append(doc.createTextNode(message));
      root.append(node);
    }
    const timeout = timeoutFor ? timeoutFor(type) : 3200;
    timer = scheduler.setTimeout(() => {
      timer = null;
      if (leaveMs > 0) {
        node.classList?.add("leaving");
        scheduler.setTimeout(() => node.remove?.(), leaveMs);
      } else {
        node.remove?.();
      }
    }, timeout);
  }

  function clearToast() {
    clearTimer();
    const root = getRoot();
    if (!root) return;
    if (single) {
      const node = selector ? root.querySelector?.(selector) : null;
      node?.remove?.();
    } else {
      for (const child of [...root.children]) child.remove?.();
    }
  }

  return { showToast, clearToast };
}
