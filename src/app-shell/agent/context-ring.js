// src/app-shell/agent/context-ring.js —— 上下文用量圆环（Task 11 Step 2）。
//
// 窄职责纯 DOM/可访问性模块：不读取 session/usage 状态、不订阅业务事件；surface
// （view 经 render 循环）把最新 ContextUsage 推进 setUsage()、把运行态推进
// setActive()，并读取 element 挂载。popover 的开关/固定/外部关闭（pointerdown）
// 在模块内自管，ESC 关闭经 surface 的 dismissTopLayer() 调用 dismiss()（Task 12：
// ESC 统一路由，模块不再挂 document-level keydown），只通过 onToggle/onDismiss
// 回调告知 surface。
//
// 可访问性：按钮 role=button + tabindex=0 + aria-expanded + aria-describedby；
// 圆环用 SVG <circle> 的 stroke-dasharray 映射 ratio（不用 canvas）。
// reduced-motion：判定方式与 motion-runtime.js 相同（matchMedia 缓存）；本模块
// 不 import motion-runtime —— 其 gsap UMD 依赖全局 self，测试/SSR 环境没有该
// 全局会直接抛错。命中 reduce 时圆环不加活性 class；popover 过渡由 CSS 媒体
// 查询降级为淡入或静态。
const NS = "http://www.w3.org/2000/svg";
const RING_RADIUS = 9;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
let popoverIdCounter = 0;

function prefersReducedMotion() {
  try {
    const mq =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)");
    return mq ? mq.matches === true : false;
  } catch {
    return false;
  }
}

function formatTokens(n) {
  try {
    return new Intl.NumberFormat("en-US").format(Number(n));
  } catch {
    return String(Number(n));
  }
}

// 装配完成判定：ContextUsage 就绪（status=ready 且数字可读）。其余情况一律
// 视为「计算中/待校准」，绝不显示假 0。
function isUsageReady(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return false;
  if (usage.status !== "ready") return false;
  return (
    Number.isFinite(Number(usage.used_tokens)) &&
    Number.isFinite(Number(usage.effective_context_window)) &&
    Number(usage.effective_context_window) > 0
  );
}

// 窗口来源：1M 档来自模型 id 标注（model_id_1m），其余默认 256k。
function windowSourceLabel(usage) {
  const windowTokens = Number(usage.effective_context_window);
  const source = String(usage.window_source ?? "");
  if (windowTokens === 1_000_000 || source === "model_id_1m") return "1M 模型窗口";
  if (source === "default_256k") return "256k 默认窗口";
  return windowTokens > 0 ? `${formatTokens(windowTokens)} 窗口` : "窗口未知";
}

export function createContextRing({
  document: doc = globalThis.document,
  onToggle = null,
  onDismiss = null
} = {}) {
  const wrap = doc.createElement("div");
  wrap.className = "agent-context-ring-wrap";

  const button = doc.createElement("button");
  button.type = "button";
  button.className = "agent-context-ring";
  button.dataset.testid = "agent-context-ring";
  button.setAttribute("role", "button");
  button.setAttribute("tabindex", "0");
  button.setAttribute("aria-expanded", "false");

  const svg = doc.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "24");
  svg.setAttribute("height", "24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  const track = doc.createElementNS(NS, "circle");
  track.className = "agent-context-ring-track";
  track.setAttribute("cx", "12");
  track.setAttribute("cy", "12");
  track.setAttribute("r", String(RING_RADIUS));
  track.setAttribute("fill", "none");
  track.setAttribute("stroke-width", "2");

  const value = doc.createElementNS(NS, "circle");
  value.className = "agent-context-ring-value";
  value.setAttribute("cx", "12");
  value.setAttribute("cy", "12");
  value.setAttribute("r", String(RING_RADIUS));
  value.setAttribute("fill", "none");
  value.setAttribute("stroke-width", "2");
  value.setAttribute("stroke-linecap", "round");
  value.setAttribute("transform", `rotate(-90 12 12)`); // 12 点方向起笔

  const pct = doc.createElement("span");
  pct.className = "agent-context-ring-pct";
  pct.setAttribute("aria-hidden", "true");
  pct.hidden = true; // 未装配时不显示百分比数字（绝不出现假 0）

  svg.append(track, value);
  button.append(svg, pct);

  const popover = doc.createElement("div");
  popover.className = "agent-context-popover";
  popover.dataset.testid = "agent-context-popover";
  popover.setAttribute("id", `agent-context-popover-${(popoverIdCounter += 1)}`);
  popover.dataset.open = "false";
  popover.setAttribute("role", "region");
  popover.setAttribute("aria-label", "上下文用量");
  button.setAttribute("aria-describedby", popover.getAttribute("id"));

  const content = doc.createElement("div");
  content.className = "agent-context-popover-content";
  popover.append(content);

  wrap.append(button, popover);

  let usage = null;
  let active = false;
  let open = false;
  let pinned = false;

  // ---- 渲染（只由 setUsage 触发；popover 未打开时也更新内容，打开即见） ----
  function renderRing() {
    if (isUsageReady(usage)) {
      const used = Number(usage.used_tokens);
      const windowTokens = Number(usage.effective_context_window);
      const ratio = Math.min(1, Math.max(0, used / windowTokens));
      value.setAttribute(
        "stroke-dasharray",
        `${(ratio * RING_CIRCUMFERENCE).toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}`
      );
      const percent = Math.round(ratio * 100);
      pct.textContent = `${percent}%`;
      pct.hidden = false;
      const label = `上下文用量：${percent}%（约 ${formatTokens(used)} / ${formatTokens(windowTokens)} tokens）`;
      button.setAttribute("aria-label", label);
      button.title = label;
    } else {
      value.setAttribute("stroke-dasharray", `0 ${RING_CIRCUMFERENCE.toFixed(2)}`);
      pct.hidden = true;
      button.setAttribute("aria-label", "上下文用量：计算中");
      button.title = "上下文用量：计算中";
    }
  }

  function renderPopover() {
    content.replaceChildren();
    const title = doc.createElement("div");
    title.className = "agent-context-popover-title";
    title.textContent = "上下文用量";
    content.append(title);
    if (isUsageReady(usage)) {
      const used = Number(usage.used_tokens);
      const windowTokens = Number(usage.effective_context_window);
      const ratio = Math.min(1, Math.max(0, used / windowTokens));
      const line = doc.createElement("div");
      line.className = "agent-context-popover-line";
      // 估算值带「约」前缀；provider 校准后不再加前缀。
      line.textContent =
        `${usage.approximate === true ? "约 " : ""}${formatTokens(used)} / ` +
        `${formatTokens(windowTokens)} tokens`;
      const meta = doc.createElement("div");
      meta.className = "agent-context-popover-meta";
      meta.textContent = `${Math.round(ratio * 100)}% · ${windowSourceLabel(usage)}`;
      content.append(line, meta);
    } else {
      const line = doc.createElement("div");
      line.className = "agent-context-popover-line";
      line.textContent = "计算中";
      const meta = doc.createElement("div");
      meta.className = "agent-context-popover-meta";
      meta.textContent = "上下文用量尚未装配完成";
      content.append(line, meta);
    }
  }

  function render() {
    renderRing();
    renderPopover();
  }

  // ---- 开关 / 固定 ----------------------------------------------------------
  // 打开：hover/focus（不固定）、点击/键盘（固定 data-pinned="true"）。
  // 关闭：再次点击、外部 pointerdown（capture）、ESC、未固定时 blur/mouseleave。
  function setOpen(next, { pin = false } = {}) {
    const wasOpen = open;
    open = next === true;
    if (open) {
      if (pin) pinned = true;
      // 点击/键盘固定：data-pinned 只由显式 pin 打开置位（hover/focus 不置位）。
      button.dataset.pinned = pinned ? "true" : undefined;
    } else {
      pinned = false;
      button.dataset.pinned = undefined;
    }
    if (open === wasOpen) return;
    popover.dataset.open = open ? "true" : "false";
    button.setAttribute("aria-expanded", open ? "true" : "false");
    button.classList.toggle("agent-context-ring--open", open);
    if (open) {
      onToggle?.(true);
    } else {
      onToggle?.(false);
      onDismiss?.();
    }
  }

  button.addEventListener("click", () => {
    if (open && pinned) setOpen(false);
    else setOpen(true, { pin: true });
  });
  button.addEventListener("mouseenter", () => {
    if (!open) setOpen(true);
  });
  button.addEventListener("mouseleave", () => {
    if (open && !pinned) setOpen(false);
  });
  button.addEventListener("focus", () => {
    if (!open) setOpen(true);
  });
  button.addEventListener("blur", () => {
    if (open && !pinned) setOpen(false);
  });
  button.addEventListener("keydown", (event) => {
    const key = event?.key;
    if (key === "Enter" || key === " ") {
      event?.preventDefault?.();
      if (open && pinned) setOpen(false);
      else setOpen(true, { pin: true });
    }
  });

  function handleDocPointerdown(event) {
    if (!open) return;
    const target = event?.target ?? null;
    // 外部点击（含 popover 自身之外的任何位置）关闭并取消固定。
    if (target == null || wrap.contains?.(target) !== true) setOpen(false);
  }
  // Task 12：ESC 不再由圆环自消费 document-level keydown —— 会与全局路由
  // （app.js → surface.handleEscape → dismissTopLayer）重复执行。关闭由
  // dismissTopLayer 调用本模块的 dismiss() 完成（唯一路径）。
  doc.addEventListener?.("pointerdown", handleDocPointerdown, true);

  // ---- 对外 ----------------------------------------------------------------
  function setUsage(next) {
    usage = next ?? null;
    render();
  }

  // 只有真实运行/压缩进行中才有轻微活性反馈；reduced-motion 下圆环保持静态。
  function setActive(next) {
    active = next === true;
    if (active && prefersReducedMotion()) {
      button.classList.remove("agent-context-ring--active");
      return;
    }
    button.classList.toggle("agent-context-ring--active", active);
  }

  function dismiss() {
    if (open) setOpen(false);
  }

  function destroy() {
    doc.removeEventListener?.("pointerdown", handleDocPointerdown, true);
    wrap.remove();
  }

  render();
  return { element: wrap, button, popover, setUsage, setActive, dismiss, destroy };
}
