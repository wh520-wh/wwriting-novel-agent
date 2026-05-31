function hashKey(projectRoot) {
  let h = 0x811c9dc5;
  for (let i = 0; i < projectRoot.length; i++) {
    h ^= projectRoot.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0') + projectRoot.length.toString(16).padStart(4, '0');
}

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
