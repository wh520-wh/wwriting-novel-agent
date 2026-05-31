const STAGE_LABEL = {
  queued: '排队', planning: '规划', planned: '已规划', drafting: '起草',
  reviewing: '审稿', needs_revision: '需修订', revising: '修订',
  finalizing: '定稿', summarizing: '摘要', blocked: '阻塞'
};

export function renderActivityStrip(root, activity, { privacy = false, onClickCost, onClickChapter } = {}) {
  if (!activity) {
    root.hidden = true;
    return;
  }
  root.hidden = false;
  root.classList.toggle('idle', activity.mode === 'idle' || activity.mode === 'completed');
  root.classList.toggle('blocked', activity.mode === 'blocked' || activity.mode === 'interrupted');

  root.innerHTML = '';
  appendSlot(root, 'stage', `● ${STAGE_LABEL[activity.stage] ?? activity.stage ?? '—'}`);
  if (activity.chapterNo != null) {
    const loc = activity.segCurrent != null
      ? `第 ${activity.chapterNo} 章 · seg ${activity.segCurrent}/${activity.segTotal ?? '?'}`
      : `第 ${activity.chapterNo} 章`;
    const locEl = appendSlot(root, 'loc', privacy ? '█████' : loc);
    if (onClickChapter) { locEl.style.cursor = 'pointer'; locEl.addEventListener('click', onClickChapter); }
  }
  if (activity.lastTool) {
    const sym = activity.lastTool.status === 'pending' ? '→' : activity.lastTool.status === 'failed' ? '✗' : '✓';
    appendSlot(root, 'tool', `${sym} ${privacy ? '████' : activity.lastTool.name}`);
  }
  if (activity.elapsedMs != null) {
    appendSlot(root, 'time', `${formatDuration(activity.elapsedMs)} / ${activity.etaMs != null ? '~' + formatDuration(activity.etaMs) : '—'}`);
  }
  if (activity.spentCost != null) {
    const costEl = appendSlot(root, 'cost', `￥${activity.spentCost.toFixed(2)}`);
    if (onClickCost) { costEl.style.cursor = 'pointer'; costEl.addEventListener('click', onClickCost); }
  }
}

function appendSlot(root, name, text) {
  const s = document.createElement('span');
  s.className = `as-slot as-${name}`;
  s.textContent = text;
  root.appendChild(s);
  return s;
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
}
