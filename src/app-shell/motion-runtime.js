/**
 * Motion Runtime — GSAP-backed animation helpers for app-shell.
 *
 * Provides semantic animation APIs (openDrawer, closeDrawer, openModal, closeModal, etc.)
 * with automatic prefers-reduced-motion fallback.
 */

import { gsap } from "./vendor/gsap.js";

/* ─── MOTION token constants ─── */
const MOTION = Object.freeze({
  instant: 0,
  fast: 0.14,
  base: 0.22,
  slow: 0.32,
  easeOut: "power2.out",
  easeIn: "power2.in",
  easeInOut: "power2.inOut",
  emphasis: "back.out(1.35)",
});

let _reducedMotion = false;
let _gsapLoaded = false;
let _reduceQuery = null;

/* ─── Setup & detection ─── */

/**
 * Detects prefers-reduced-motion via matchMedia and caches the result.
 * Returns { gsapLoaded, reducedMotion }.
 */
export function setupMotion() {
  _gsapLoaded = Boolean(gsap);
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
  return { gsapLoaded: _gsapLoaded, reducedMotion: _reducedMotion };
}

/**
 * Re-checks the reduced-motion preference, reusing the cached MediaQueryList.
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

/* ─── Safe GSAP wrappers ─── */

/**
 * Executes an animation function inside a try/catch.
 * Logs warnings on failure rather than crashing.
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
 * gsap.set with clearProps to remove inline animation properties.
 */
export function clearTemporaryProps(targets, props) {
  if (!_gsapLoaded || !gsap || !targets) return;
  safeAnimate(() => {
    gsap.set(targets, { clearProps: props || "transform,opacity" });
  });
}

/* ─── Semantic animation APIs ─── */

/**
 * Opens a right-side drawer with scrim fade, drawer slide, and content stagger.
 */
export function openDrawer(drawer, scrim, { body, tabs } = {}) {
  if (!_gsapLoaded || !gsap) return;
  if (isReducedMotion()) {
    safeAnimate(() => {
      if (scrim) gsap.set(scrim, { opacity: 1, pointerEvents: "auto" });
      if (drawer) gsap.set(drawer, { x: 0 });
    });
    return;
  }

  safeAnimate(() => {
    const tl = gsap.timeline();
    if (scrim) {
      tl.to(scrim, { opacity: 1, duration: MOTION.base, ease: MOTION.easeOut }, 0);
      tl.set(scrim, { pointerEvents: "auto" }, 0);
    }
    if (drawer) {
      tl.fromTo(
        drawer,
        { x: "101%" },
        { x: 0, duration: MOTION.slow, ease: MOTION.easeOut },
        0
      );
    }
    const content = [body, tabs].filter(Boolean);
    if (content.length) {
      tl.fromTo(
        content,
        { opacity: 0, y: 10 },
        { opacity: 1, y: 0, duration: MOTION.base, ease: MOTION.easeOut, stagger: 0.04 },
        MOTION.fast
      );
    }
  });
}

/**
 * Closes a right-side drawer. Calls onComplete after animation finishes.
 * In reduced-motion mode, clears props and calls onComplete immediately.
 */
export function closeDrawer(drawer, scrim, { onComplete } = {}) {
  if (!_gsapLoaded || !gsap || isReducedMotion()) {
    if (drawer) clearTemporaryProps(drawer, "x,opacity");
    if (scrim) clearTemporaryProps(scrim, "opacity,pointerEvents");
    if (onComplete) onComplete();
    return;
  }

  safeAnimate(() => {
    const tl = gsap.timeline({
      onComplete: () => {
        if (drawer) clearTemporaryProps(drawer, "x,opacity");
        if (scrim) clearTemporaryProps(scrim, "opacity,pointerEvents");
        if (onComplete) onComplete();
      },
    });
    if (drawer) {
      tl.to(drawer, { x: "101%", duration: MOTION.base, ease: MOTION.easeIn }, 0);
    }
    if (scrim) {
      tl.to(scrim, { opacity: 0, duration: MOTION.base, ease: MOTION.easeIn }, 0);
      tl.set(scrim, { pointerEvents: "none" }, 0);
    }
  });
}

/**
 * Opens a modal overlay with scale+fade.
 */
export function openModal(scrim, panel) {
  if (!_gsapLoaded || !gsap) return;
  if (isReducedMotion()) {
    safeAnimate(() => {
      if (scrim) gsap.set(scrim, { opacity: 1, pointerEvents: "auto" });
      if (panel) gsap.set(panel, { scale: 1, y: 0, opacity: 1 });
    });
    return;
  }

  safeAnimate(() => {
    if (scrim) {
      gsap.to(scrim, { opacity: 1, duration: MOTION.base, ease: MOTION.easeOut });
      gsap.set(scrim, { pointerEvents: "auto" });
    }
    if (panel) {
      gsap.fromTo(
        panel,
        { scale: 0.97, y: 8, opacity: 0 },
        { scale: 1, y: 0, opacity: 1, duration: MOTION.base, ease: MOTION.easeOut }
      );
    }
  });
}

/**
 * Closes a modal overlay. Calls onComplete after animation finishes.
 */
export function closeModal(scrim, panel, { onComplete } = {}) {
  if (!_gsapLoaded || !gsap || isReducedMotion()) {
    if (panel) clearTemporaryProps(panel, "scale,y,opacity");
    if (scrim) clearTemporaryProps(scrim, "opacity,pointerEvents");
    if (onComplete) onComplete();
    return;
  }

  safeAnimate(() => {
    const tl = gsap.timeline({
      onComplete: () => {
        if (panel) clearTemporaryProps(panel, "scale,y,opacity");
        if (scrim) clearTemporaryProps(scrim, "opacity,pointerEvents");
        if (onComplete) onComplete();
      },
    });
    if (panel) {
      tl.to(panel, { scale: 0.97, y: 8, opacity: 0, duration: MOTION.fast, ease: MOTION.easeIn }, 0);
    }
    if (scrim) {
      tl.to(scrim, { opacity: 0, duration: MOTION.base, ease: MOTION.easeIn }, 0);
      tl.set(scrim, { pointerEvents: "none" }, 0);
    }
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
