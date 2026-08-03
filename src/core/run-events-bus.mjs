// 运行事件内存总线：engine 的 appendEvent / 模型 delta 经此广播给 SSE 端点。
// 无订阅者时静默丢弃（run 期间前端必然订阅，未订阅即无人在看）。
const listeners = new Map(); // projectRoot -> Set<listener>

export function subscribe(projectRoot, listener) {
  const key = String(projectRoot);
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(listener);
  return () => listeners.get(key)?.delete(listener);
}

export function emit(projectRoot, event) {
  const key = String(projectRoot);
  const set = listeners.get(key);
  if (!set) return;
  for (const fn of set) {
    try { fn(event); } catch { /* 单个订阅者异常不影响其他 */ }
  }
}

export function unsubscribeAll(projectRoot) {
  listeners.delete(String(projectRoot));
}
