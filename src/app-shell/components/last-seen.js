import { hashKey } from "../utils.js";

export function getLastSeen(projectRoot, tab) {
  if (!projectRoot) return null;
  try {
    return globalThis.localStorage?.getItem(`wwriting:lastSeen:${hashKey(projectRoot)}:${tab}`) ?? null;
  } catch {
    return null;
  }
}

export function setLastSeen(projectRoot, tab, ts = new Date().toISOString()) {
  if (!projectRoot) return;
  try {
    globalThis.localStorage?.setItem(`wwriting:lastSeen:${hashKey(projectRoot)}:${tab}`, ts);
  } catch {
    // storage 不可用时只跳过跨会话标记，不影响主流程
  }
}

export function watchLastSeen(callback) {
  window.addEventListener('storage', (e) => {
    if (e.key?.startsWith('wwriting:lastSeen:')) callback();
  });
}
