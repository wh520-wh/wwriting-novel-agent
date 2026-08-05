import { setLastSeen } from './last-seen.js';
import { icon as renderIcon } from '../icons.js';
// Register 5 built-in slash commands on module load (composer's table mirrors
// quick-rail's SLOTS array; they are intentionally separate UI surfaces).
import '../commands/index.mjs';

// 用线条 SVG 图标（icons.js）而非 emoji，避免「AI 生成」观感。
const SLOTS = [
  { key: 'chapters', icon: 'book',   label: '章节', tab: 'chapters' },
  { key: 'skills',   icon: 'skill',  label: '技能', tab: 'skills' },
  { key: 'research', icon: 'doc',    label: '资料', tab: 'research' },
  { key: 'cost',     icon: 'coin',   label: '成本', tab: 'cost' },
  { key: 'reviewer', icon: 'search', label: '审查', tab: 'reviewer' }
];

let activePopover = null;
let activeOwner = null;
// 最后已知指针位置（视口坐标）：1.8s 轮询重渲后，Chromium 对静止鼠标下的新按钮
// 刷新 :hover 是异步的（晚于微任务），用该坐标做同步命中判定可即时恢复悬停弹层。
let lastPointer = null;
// 窗口失焦标志：alt-tab 失焦时 blur 已清弹层而 lastPointer 仍在，重渲不得恢复
// 悬停弹层（后台窗口不得出现 tooltip）；窗口回到前台（focus）后恢复该能力。
// 用 blur/focus 事件而非 document.hasFocus()：后者对从未聚焦的窗口恒 false，
// 会把「从未聚焦」误当「失焦」而永久禁用恢复（自动化窗口 show:false 即此类）。
let windowBlurred = false;

export function clearQuickRailPopover() {
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

    const iconEl = document.createElement('span');
    iconEl.className = 'qr-icon';
    iconEl.append(renderIcon(slot.icon, 18));
    btn.appendChild(iconEl);

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
    if (!btn.isConnected) return; // 按钮已被 1.8s 轮询重渲替换：放弃本次悬停
    const text = previewText(key, badges);
    if (!text) return;
    activeOwner = btn;
    activePopover = document.createElement('div');
    activePopover.className = 'qr-popover';
    activePopover.textContent = text;
    document.body.appendChild(activePopover);
    const r = btn.getBoundingClientRect();
    activePopover.style.right = `${window.innerWidth - r.left + 8}px`;
    activePopover.style.top = `${r.top}px`;
  };
  btn.addEventListener('mouseenter', show);
  btn.addEventListener('focus', show);
  btn.addEventListener('mouseleave', clearQuickRailPopover);
  btn.addEventListener('blur', clearQuickRailPopover);
  btn.addEventListener('click', clearQuickRailPopover);
  btn.addEventListener('pointerdown', clearQuickRailPopover);
  // 1.8s 轮询会重建按钮并清掉 popover：重建后若鼠标仍悬停，立即恢复显示。
  // 渲染循环结束后按钮才挂载完成，故在微任务内判定；而静止鼠标下 Chromium 刷新
  // 新按钮的 :hover 是异步的（晚于微任务），故用最后指针坐标命中判定兜底。
  // windowBlurred 守卫：失焦（alt-tab）后 blur 已清弹层而 lastPointer 仍在，
  // 失焦期间的重渲不得恢复 popover（后台窗口不得出现 tooltip）。
  queueMicrotask(() => {
    if (!btn.isConnected || windowBlurred) return;
    const hovering = btn.matches(':hover') || Boolean(
      lastPointer && btn.contains(document.elementFromPoint(lastPointer.x, lastPointer.y))
    );
    if (hovering) show();
  });
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
  window.addEventListener('blur', () => {
    windowBlurred = true;
    clearQuickRailPopover();
  });
  window.addEventListener('focus', () => {
    windowBlurred = false;
  });
  window.addEventListener('resize', clearQuickRailPopover);
  window.addEventListener('scroll', clearQuickRailPopover, true);
}

if (typeof document !== 'undefined') {
  document.addEventListener('pointermove', (event) => {
    lastPointer = { x: event.clientX, y: event.clientY };
  }, { capture: true, passive: true });
  // 指针移出窗口后不再有 pointermove：清空坐标，避免跨窗口残留导致 1.8s 重渲后
  // 坐标分支误命中按钮而恢复悬停弹层（:hover 已随移出变 false）。
  document.addEventListener('pointerleave', () => {
    lastPointer = null;
  }, { capture: true, passive: true });
  document.addEventListener('pointerdown', (event) => {
    if (activeOwner?.contains(event.target)) return;
    clearQuickRailPopover();
  }, true);
}
