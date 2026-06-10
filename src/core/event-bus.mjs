// 全局事件总线
// 4 个 CORE_EVENTS 是"跨模块副作用"的统一入口
// 平行于 skill-runtime 内部的 stage/action hook(那些不替换)

const listeners = new Map();

export const CORE_EVENTS = Object.freeze({
  ModelCallComplete: "model-call:complete",
  ChapterWritten: "chapter:written",
  TaskFailed: "task:failed",
});

export function on(event, fn) {
  if (typeof event !== "string") throw new Error("event must be a string");
  if (typeof fn !== "function") throw new Error("fn must be a function");
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => off(event, fn);
}

export function off(event, fn) {
  const set = listeners.get(event);
  if (set) set.delete(fn);
}

export async function emit(event, payload) {
  const set = listeners.get(event);
  if (!set || set.size === 0) {
    return { ok: true, errors: [] };
  }
  const fns = [...set];
  const results = await Promise.allSettled(fns.map((fn) => Promise.resolve().then(() => fn(payload))));
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      errors.push({ event, error: r.reason, listener: fns[i] });
    }
  });
  return { ok: errors.length === 0, errors };
}

export function _resetEventBus() {
  listeners.clear();
}
