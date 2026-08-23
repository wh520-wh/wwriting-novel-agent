/**
 * Motion Runtime — CSS transition–backed animation helpers for app-shell.
 *
 * 第十五轮（Task 19，F9）：旧动画库退役。对外 API 逐字保持（setupMotion/
 * isReducedMotion/safeAnimate/clearTemporaryProps/openDrawer/closeDrawer/
 * openModal/closeModal/motion），实现从旧动画时间线改为 CSS transition +
 * 内联样式切换：从态 → 强制 reflow → 目标态 + transition → transitionend
 *（setTimeout 兜底）→ 完成回调。MOTION 秒值 ×1000 取整为 ms；power2/back
 * 缓动用 cubic-bezier 近似。
 *
 * 保持的契约（阻断级）：
 *   - 「未 setup 同步早退」：setupMotion() 未调用（initialized=false）时，
 *     所有 open/close 走同步 instant 分支——直接设终态样式 + 同步回调
 *     onComplete，不启动 transition（settings-modal.test.mjs 钉住此行为）。
 *   - isReducedMotion() 命中时同样走同步分支（原语义：跳过错动）。
 *   - open 完成后保留内联终态样式（与旧实现 set 后不清 props 一致），
 *     close 完成后清掉内联临时样式（与旧实现 clearProps 一致）。
 */

/* ─── MOTION token constants（ms + CSS 缓动近似） ─── */
const MOTION = Object.freeze({
  instant: 0,
  fast: 140,
  base: 220,
  slow: 320,
  // power2.out / power2.in / power2.inOut / back.out(1.35) 的 cubic-bezier 近似。
  easeOut: "cubic-bezier(0.33, 1, 0.68, 1)",
  easeIn: "cubic-bezier(0.32, 0, 0.67, 0)",
  easeInOut: "cubic-bezier(0.65, 0, 0.35, 1)",
  emphasis: "cubic-bezier(0.34, 1.56, 0.64, 1)",
});

let initialized = false; // setupMotion() 置 true；未 setup 走同步早退分支
let _reducedMotion = false;
let _reduceQuery = null;

/* ─── 内联样式辅助（兼容真实 DOM 与测试 mock 的 plain style 对象） ─── */
const CSS_NAME = { opacity: "opacity", transform: "transform", pointerEvents: "pointer-events" };
const JS_KEY = { opacity: "opacity", transform: "transform", "pointer-events": "pointerEvents" };

function setInline(target, props) {
  if (!target) return;
  for (const [jsKey, value] of Object.entries(props)) {
    target.style[jsKey] = value;
  }
}

function clearInline(target, cssProp) {
  if (!target?.style) return;
  if (typeof target.style.removeProperty === "function") {
    target.style.removeProperty(cssProp);
  } else {
    // 测试 mock 的 style 是 plain object：removeProperty 缺失时按 js key 删除。
    delete target.style[JS_KEY[cssProp] ?? cssProp];
  }
}

/* ─── Setup & detection ─── */

/**
 * 初始化：置 initialized 并检测 prefers-reduced-motion（matchMedia 缓存）。
 * 返回 { initialized, reducedMotion }。
 */
export function setupMotion() {
  initialized = true;
  try {
    const mq =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mq) {
      _reduceQuery = mq;
      _reducedMotion = mq.matches;
      mq.addEventListener("change", (e) => {
        _reducedMotion = e.matches;
      });
    }
  } catch {
    /* non-browser test environment */
  }
  return { initialized, reducedMotion: _reducedMotion };
}

/**
 * 重查 reduced-motion 偏好，复用缓存的 MediaQueryList。
 */
export function isReducedMotion() {
  try {
    if (_reduceQuery) {
      _reducedMotion = _reduceQuery.matches;
    }
  } catch {
    /* ignore */
  }
  return _reducedMotion;
}

/* ─── Safe 动画包装 ─── */

/**
 * 在 try/catch 里执行动画逻辑；失败仅告警不崩溃（原语义）。
 */
export function safeAnimate(fn) {
  try {
    return fn();
  } catch (err) {
    console.warn("[motion-runtime] animation error:", err);
    return undefined;
  }
}

/**
 * 清掉内联临时样式（旧实现 clearProps 的等价物）。props 兼容旧属性名：
 * x/y/scale → transform；其余原样（opacity/pointerEvents）。
 */
export function clearTemporaryProps(targets, props) {
  if (!targets) return;
  const list = Array.isArray(targets) ? targets : [targets];
  const names = String(props || "transform,opacity").split(",").map((n) => n.trim());
  for (const target of list) {
    if (!target) continue;
    for (const name of names) {
      if (name === "x" || name === "y" || name === "scale") clearInline(target, "transform");
      else clearInline(target, CSS_NAME[name] ?? name);
    }
  }
}

/**
 * 单元素 CSS transition：from → 强制 reflow → to + transition →
 * transitionend（属性匹配）或 setTimeout 兜底后调用 onComplete（幂等）。
 * 完成时清掉内联 transition（避免后续样式变更被意外动画化）。
 */
function animate(target, from, to, { duration, ease, delay = 0, onComplete } = {}) {
  if (!target) return;
  if (duration <= 0) {
    setInline(target, to);
    onComplete?.();
    return;
  }
  setInline(target, from);
  void (target.offsetWidth ?? undefined); // 强制 reflow：真实 DOM 启动 transition；mock 空转
  const cssProps = Object.keys(to).map((k) => CSS_NAME[k] ?? k);
  const transitionValue = cssProps
    .map((p) => `${p} ${duration}ms ${ease}${delay > 0 ? ` ${delay}ms` : ""}`)
    .join(", ");
  target.style.transition = transitionValue;
  setInline(target, to);
  let settled = false;
  let fallback = null;
  const finish = () => {
    if (settled) return;
    settled = true;
    target.removeEventListener?.("transitionend", onEnd);
    if (fallback !== null) clearTimeout(fallback);
    // 动画结束后清掉内联 transition：终态样式保留（open 语义），过渡声明不残留。
    delete target.style.transition;
    onComplete?.();
  };
  const onEnd = (event) => {
    if (event?.propertyName != null && !cssProps.includes(event.propertyName)) return;
    finish();
  };
  target.addEventListener?.("transitionend", onEnd);
  fallback = setTimeout(finish, duration + delay + 60);
}

/** 收集多个动画的完成，全部结束（或全部未启动）后执行 done（幂等）。 */
function collectDone(invocations, done) {
  let pending = 0;
  let fired = false;
  const settle = () => {
    pending -= 1;
    if (fired || pending > 0) return;
    fired = true;
    done();
  };
  for (const invoke of invocations) {
    if (invoke === null) continue;
    pending += 1;
    invoke(settle);
  }
  if (pending === 0) done();
}

/* ─── Semantic animation APIs ─── */

/**
 * 打开右侧抽屉：scrim 淡入 + 抽屉滑入 + 内容错峰进场（原动画时间线等价）。
 */
export function openDrawer(drawer, scrim, { body, tabs } = {}) {
  if (!initialized || isReducedMotion()) {
    safeAnimate(() => {
      if (scrim) setInline(scrim, { opacity: "1", pointerEvents: "auto" });
      if (drawer) setInline(drawer, { transform: "translateX(0)" });
    });
    return;
  }

  safeAnimate(() => {
    if (scrim) {
      animate(scrim, { opacity: "0" }, { opacity: "1" }, { duration: MOTION.base, ease: MOTION.easeOut });
      setInline(scrim, { pointerEvents: "auto" });
    }
    if (drawer) {
      animate(
        drawer,
        { transform: "translateX(101%)" },
        { transform: "translateX(0)" },
        { duration: MOTION.slow, ease: MOTION.easeOut }
      );
    }
    const content = [body, tabs].filter(Boolean);
    content.forEach((el, index) => {
      animate(
        el,
        { opacity: "0", transform: "translateY(10px)" },
        { opacity: "1", transform: "translateY(0)" },
        { duration: MOTION.base, ease: MOTION.easeOut, delay: MOTION.fast + index * 40 }
      );
    });
  });
}

/**
 * 关闭抽屉：动画结束后清内联临时样式并回调 onComplete。
 * 未 setup / reduced-motion：清 props 并同步回调（原语义）。
 */
export function closeDrawer(drawer, scrim, { onComplete } = {}) {
  if (!initialized || isReducedMotion()) {
    if (drawer) clearTemporaryProps(drawer, "x,opacity");
    if (scrim) clearTemporaryProps(scrim, "opacity,pointerEvents");
    if (onComplete) onComplete();
    return;
  }

  safeAnimate(() => {
    collectDone([
      drawer
        ? (settle) => {
            animate(
              drawer,
              { transform: "translateX(0)" },
              { transform: "translateX(101%)" },
              { duration: MOTION.base, ease: MOTION.easeIn, onComplete: settle }
            );
          }
        : null,
      scrim
        ? (settle) => {
            setInline(scrim, { pointerEvents: "none" });
            animate(
              scrim,
              { opacity: "1" },
              { opacity: "0" },
              { duration: MOTION.base, ease: MOTION.easeIn, onComplete: settle }
            );
          }
        : null
    ], () => {
      if (drawer) clearTemporaryProps(drawer, "x,opacity");
      if (scrim) clearTemporaryProps(scrim, "opacity,pointerEvents");
      if (onComplete) onComplete();
    });
  });
}

/**
 * 打开模态浮层：scrim 淡入 + panel scale+fade 进场。
 */
export function openModal(scrim, panel) {
  if (!initialized || isReducedMotion()) {
    safeAnimate(() => {
      if (scrim) setInline(scrim, { opacity: "1", pointerEvents: "auto" });
      if (panel) setInline(panel, { transform: "translateY(0) scale(1)", opacity: "1" });
    });
    return;
  }

  safeAnimate(() => {
    if (scrim) {
      animate(scrim, { opacity: "0" }, { opacity: "1" }, { duration: MOTION.base, ease: MOTION.easeOut });
      setInline(scrim, { pointerEvents: "auto" });
    }
    if (panel) {
      animate(
        panel,
        { transform: "translateY(8px) scale(0.97)", opacity: "0" },
        { transform: "translateY(0) scale(1)", opacity: "1" },
        { duration: MOTION.base, ease: MOTION.easeOut }
      );
    }
  });
}

/**
 * 关闭模态浮层：动画结束后清内联临时样式并回调 onComplete。
 * 未 setup / reduced-motion：清 props 并同步回调（原语义）。
 */
export function closeModal(scrim, panel, { onComplete } = {}) {
  if (!initialized || isReducedMotion()) {
    if (panel) clearTemporaryProps(panel, "scale,y,opacity");
    if (scrim) clearTemporaryProps(scrim, "opacity,pointerEvents");
    if (onComplete) onComplete();
    return;
  }

  safeAnimate(() => {
    collectDone([
      panel
        ? (settle) => {
            animate(
              panel,
              { transform: "translateY(0) scale(1)", opacity: "1" },
              { transform: "translateY(8px) scale(0.97)", opacity: "0" },
              { duration: MOTION.fast, ease: MOTION.easeIn, onComplete: settle }
            );
          }
        : null,
      scrim
        ? (settle) => {
            setInline(scrim, { pointerEvents: "none" });
            animate(
              scrim,
              { opacity: "1" },
              { opacity: "0" },
              { duration: MOTION.base, ease: MOTION.easeIn, onComplete: settle }
            );
          }
        : null
    ], () => {
      if (panel) clearTemporaryProps(panel, "scale,y,opacity");
      if (scrim) clearTemporaryProps(scrim, "opacity,pointerEvents");
      if (onComplete) onComplete();
    });
  });
}

/* ─── Public semantic API object ─── */

export const motion = {
  setupMotion,
  isReducedMotion,
  openDrawer,
  closeDrawer,
  openModal,
  closeModal,
};
