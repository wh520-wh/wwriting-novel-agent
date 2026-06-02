import { setLastSeen } from './last-seen.js';
// Register 5 built-in slash commands on module load (composer's table mirrors
// quick-rail's SLOTS array; they are intentionally separate UI surfaces).
import '../commands/index.mjs';

const SLOTS = [
  { key: 'chapters', icon: '📖', label: '章节', tab: 'chapters' },
  { key: 'skills',   icon: '🧩', label: '技能', tab: 'skills' },
  { key: 'research', icon: '📎', label: '资料', tab: 'research' },
  { key: 'cost',     icon: '💰', label: '成本', tab: 'cost' },
  { key: 'reviewer', icon: '🔍', label: '审查', tab: 'reviewer' }
];

let activePopover = null;
let activeTimer = null;
let activeOwner = null;

export function clearQuickRailPopover() {
  if (activeTimer) {
    clearTimeout(activeTimer);
    activeTimer = null;
  }
  if (activePopover) {
    activePopover.remove();
    activePopover = null;
  }
  activeOwner = null;
}

export function renderQuickRail(root, badges, { onOpenTab, projectRoot }) {
  clearQuickRailPopover();
  root.innerHTML = '';
  for (const slot of SLOTS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'qr-slot';
    btn.dataset.key = slot.key;
    btn.setAttribute('aria-label', slot.label);

    const icon = document.createElement('span');
    icon.className = 'qr-icon';
    icon.textContent = slot.icon;
    btn.appendChild(icon);

    const badge = badgeText(slot.key, badges);
    if (badge) {
      const b = document.createElement('span');
      b.className = `qr-badge level-${badges[slot.key]?.level ?? 'normal'}`;
      if (badges[slot.key]?.newSinceLastVisit || badges[slot.key]?.hasUnread) b.classList.add('dot');
      b.textContent = badge;
      btn.appendChild(b);
    }
    btn.addEventListener('click', () => {
      onOpenTab(slot.tab);
      if (slot.key === 'research' || slot.key === 'reviewer') {
        setLastSeen(projectRoot, slot.key);
      }
    });
    attachHoverPreview(btn, slot.key, badges);
    root.appendChild(btn);
  }
}

function badgeText(key, badges) {
  const b = badges[key];
  if (!b) return '';
  if (key === 'chapters' && b.total > 0) return `${b.done}/${b.total}`;
  if (key === 'skills' && b.enabledCount > 0) return String(b.enabledCount);
  if (key === 'cost' && b.budget > 0) return `${Math.round(b.pct * 100)}%`;
  return '';
}

function attachHoverPreview(btn, key, badges) {
  const show = () => {
    clearQuickRailPopover();
    const text = previewText(key, badges);
    if (!text) return;
    activeOwner = btn;
    activeTimer = setTimeout(() => {
      activeTimer = null;
      if (activeOwner !== btn) return;
      activePopover = document.createElement('div');
      activePopover.className = 'qr-popover';
      activePopover.textContent = text;
      document.body.appendChild(activePopover);
      const r = btn.getBoundingClientRect();
      activePopover.style.right = `${window.innerWidth - r.left + 8}px`;
      activePopover.style.top = `${r.top}px`;
    }, 200);
  };
  btn.addEventListener('mouseenter', show);
  btn.addEventListener('focus', show);
  btn.addEventListener('mouseleave', clearQuickRailPopover);
  btn.addEventListener('blur', clearQuickRailPopover);
  btn.addEventListener('click', clearQuickRailPopover);
  btn.addEventListener('pointerdown', clearQuickRailPopover);
}

function previewText(key, badges) {
  const b = badges[key];
  if (!b) return '';
  if (key === 'chapters') return `已完成 ${b.done} / ${b.total}`;
  if (key === 'skills') return `已启用 ${b.enabledCount} 个技能`;
  if (key === 'research') return `资料 ${b.count} 条${b.newSinceLastVisit ? ' · 有新增' : ''}`;
  if (key === 'cost') return `已用 ¥${b.used.toFixed(2)} / 预算 ¥${b.budget.toFixed(2)}\n占比 ${Math.round(b.pct * 100)}%`;
  if (key === 'reviewer') return b.lastReportTs ? `最近报告: ${b.lastReportTs}` : '暂无报告';
  return '';
}

export function bindQuickRailKeys(root, onOpenTab) {
  document.addEventListener('keydown', (e) => {
    if (!e.altKey) return;
    const idx = Number(e.key) - 1;
    if (idx >= 0 && idx < SLOTS.length) {
      e.preventDefault();
      onOpenTab(SLOTS[idx].tab);
    }
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('blur', clearQuickRailPopover);
  window.addEventListener('resize', clearQuickRailPopover);
  window.addEventListener('scroll', clearQuickRailPopover, true);
}

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (event) => {
    if (activeOwner?.contains(event.target)) return;
    clearQuickRailPopover();
  }, true);
}
