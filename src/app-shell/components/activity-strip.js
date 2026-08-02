import { translateStage } from '../utils.js';
import { toolLabel } from '../tool-labels.mjs';

export function renderActivityStrip(root, activity, { privacy = false, onClickCost, onClickChapter } = {}) {
  if (!activity) {
    root.hidden = true;
    return;
  }
  root.hidden = false;
  root.classList.toggle('idle', activity.mode === 'idle' || activity.mode === 'completed');
  root.classList.toggle('blocked', activity.mode === 'blocked' || activity.mode === 'interrupted');

  root.replaceChildren();
  const stageText = activity.mode === 'idle' ? '空闲' : (translateStage(activity.stage) ?? '—');
  appendSlot(root, 'stage', `阶段：${stageText}`);
  if (activity.chapterNo != null) {
    const loc = activity.segCurrent != null
      ? `第 ${activity.chapterNo} 章 · seg ${activity.segCurrent}/${activity.segTotal ?? '?'}`
      : `第 ${activity.chapterNo} 章`;
    const locEl = appendSlot(root, 'loc', `位置：${privacy ? '█████' : loc}`);
    if (onClickChapter) { locEl.style.cursor = 'pointer'; locEl.addEventListener('click', onClickChapter); }
  }
  if (activity.lastTool) {
    const sym = activity.lastTool.status === 'pending' ? '进行' : activity.lastTool.status === 'failed' ? '失败' : '完成';
    appendSlot(root, 'tool', `动作：${privacy ? '████' : toolLabel(activity.lastTool.name)} · ${sym}`);
  }
  if (activity.elapsedMs != null) {
    appendSlot(root, 'time', `耗时：${formatDuration(activity.elapsedMs)} / ${activity.etaMs != null ? '~' + formatDuration(activity.etaMs) : '—'}`);
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
