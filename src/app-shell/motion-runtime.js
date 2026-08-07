/**
 * Motion Runtime — GSAP-backed animation helpers for app-shell.
 *
 * Provides semantic animation APIs (openDrawer, closeDrawer, insertFailureCard, etc.)
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

/* ─── Diff helpers ─── */

/**
 * Compares two activity snapshots and returns an array of changed slot keys.
 * Slots: "stage" (stage + mode), "loc" (chapterNo), "tool" (lastTool name+status), "cost" (spentCost).
 */
export function diffActivitySlots(previous, next) {
  const changed = [];
  if (!previous || !next) return changed;

  if (previous.stage !== next.stage || previous.mode !== next.mode) {
    changed.push("stage");
  }
  if (previous.chapterNo !== next.chapterNo) {
    changed.push("loc");
  }

  const prevTool = previous.lastTool || {};
  const nextTool = next.lastTool || {};
  if (prevTool.name !== nextTool.name || prevTool.status !== nextTool.status) {
    changed.push("tool");
  }

  if (previous.spentCost !== next.spentCost) {
    changed.push("cost");
  }

  return changed;
}

/**
 * Normalizes badge data into a flat summary object with standard keys.
 * Supports structured badge objects:
 *   chapters: { done, total } -> "done/total"
 *   skills:   { enabledCount } -> "count"
 *   research: { newSinceLastVisit } -> "unread" | ""
 *   cost:     { level } -> level string
 *   reviewer: { hasUnread } -> "unread" | "read"
 */
export function summarizeBadgesForMotion(badges) {
  if (!badges || typeof badges !== "object") return {};

  const chapters = badges.chapters;
  const skills = badges.skills;
  const research = badges.research;
  const cost = badges.cost;
  const reviewer = badges.reviewer;

  return {
    chapters:
      chapters && typeof chapters === "object"
        ? `${chapters.done ?? 0}/${chapters.total ?? 0}`
        : String(chapters ?? ""),
    skills:
      skills && typeof skills === "object"
        ? String(skills.enabledCount ?? 0)
        : String(skills ?? ""),
    research:
      research && typeof research === "object"
        ? research.newSinceLastVisit
          ? "unread"
          : ""
        : String(research ?? ""),
    cost:
      cost && typeof cost === "object"
        ? String(cost.level ?? "")
        : String(cost ?? ""),
    reviewer:
      reviewer && typeof reviewer === "object"
        ? reviewer.hasUnread
          ? "unread"
          : "read"
        : String(reviewer ?? ""),
  };
}

/**
 * Returns an array of badge keys whose values differ between two summaries.
 */
export function diffBadgeKeys(previous, next) {
  if (!previous || !next) return [];
  const changed = [];
  const allKeys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const key of allKeys) {
    if (String(previous[key] ?? "") !== String(next[key] ?? "")) {
      changed.push(key);
    }
  }
  return changed;
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

/**
 * Animates a failure card into view (y + opacity stagger for card and action buttons).
 */
export function insertFailureCard(node) {
  if (!node || !_gsapLoaded || !gsap) return;
  if (isReducedMotion()) {
    safeAnimate(() => {
      gsap.set(node, { opacity: 1, y: 0 });
      node.classList.add("motion-active");
    });
    return;
  }

  safeAnimate(() => {
    node.classList.add("motion-active");
    gsap.fromTo(
      node,
      { opacity: 0, y: 14 },
      {
        opacity: 1,
        y: 0,
        duration: MOTION.slow,
        ease: MOTION.easeOut,
        clearProps: "transform,opacity",
        onComplete: () => node.classList.remove("motion-active"),
      }
    );
    const actions = node.querySelectorAll(".failure-actions button");
    if (actions.length) {
      gsap.fromTo(
        actions,
        { opacity: 0, y: 8 },
        { opacity: 1, y: 0, duration: MOTION.base, ease: MOTION.easeOut, stagger: 0.06, delay: 0.1, clearProps: "transform,opacity" }
      );
    }
  });
}

/**
 * Fades out failure-card actions, calls commit to swap content, then fades in the resolved state.
 */
export function resolveFailureCard(oldNode, nextNode, { commit } = {}) {
  if (!_gsapLoaded || !gsap || isReducedMotion()) {
    if (commit) commit();
    if (oldNode) {
      oldNode.classList.remove("motion-active");
      clearTemporaryProps(oldNode, "opacity,y");
    }
    if (nextNode) {
      gsap && safeAnimate(() => gsap.set(nextNode, { opacity: 1, y: 0 }));
    }
    return;
  }

  safeAnimate(() => {
    const actions = oldNode ? oldNode.querySelectorAll(".failure-actions button") : [];
    const tl = gsap.timeline();

    if (actions.length) {
      tl.to(actions, { opacity: 0, y: -4, duration: MOTION.fast, ease: MOTION.easeIn, stagger: 0.03 }, 0);
    }

    tl.call(() => {
      if (commit) commit();
      if (oldNode) oldNode.classList.remove("motion-active");
    });

    if (nextNode) {
      const resolved = nextNode.querySelector(".failure-resolved") || nextNode;
      tl.fromTo(
        resolved,
        { opacity: 0, y: 6 },
        { opacity: 1, y: 0, duration: MOTION.base, ease: MOTION.easeOut },
        "+=0.05"
      );
    }
  });
}

/**
 * Animates changed activity-strip slots inside the given root.
 */
export function updateActivityStrip(root, previous, next) {
  if (!root || !_gsapLoaded || !gsap) return;
  const changedSlots = diffActivitySlots(previous, next);
  if (!changedSlots.length) return;

  safeAnimate(() => {
    for (const slotKey of changedSlots) {
      const el = root.querySelector(`.as-${slotKey}`);
      if (!el) continue;
      if (isReducedMotion()) {
        gsap.set(el, { opacity: 1 });
      } else {
        gsap.fromTo(
          el,
          { opacity: 0.4 },
          { opacity: 1, duration: MOTION.fast, ease: MOTION.easeOut }
        );
      }
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
  insertFailureCard,
  resolveFailureCard,
  updateActivityStrip,
};
