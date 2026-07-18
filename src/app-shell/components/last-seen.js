import { hashKey } from "../utils.js";

export function getLastSeen(projectRoot, tab) {
  if (!projectRoot) return null;
  return localStorage.getItem(`wwriting:lastSeen:${hashKey(projectRoot)}:${tab}`);
}

export function setLastSeen(projectRoot, tab, ts = new Date().toISOString()) {
  if (!projectRoot) return;
  localStorage.setItem(`wwriting:lastSeen:${hashKey(projectRoot)}:${tab}`, ts);
}

export function watchLastSeen(callback) {
  window.addEventListener('storage', (e) => {
    if (e.key?.startsWith('wwriting:lastSeen:')) callback();
  });
}
