// src/app-shell/components/quick-rail.js —— 纯导航快捷面板（统一 Agent 内核计划
// Task 9：只保留章节、技能、资料、成本四个导航槽位；删除审查槽位与命令注册副作用，
// 任何槽位都不得启动 Agent 工作流。Task 13：技能管理迁入设置弹窗「Agent 技能」分区，
// 技能槽位打开设置而非抽屉）。
import { icon as renderIcon } from '../icons.js';

// 四槽位导航：章节/资料/成本打开对应抽屉分区；技能打开设置弹窗的技能分区。
const SLOTS = [
  { key: 'chapters', icon: 'book',   label: '章节', tab: 'chapters', hint: '打开章节目录' },
  { key: 'skills',   icon: 'skill',  label: '技能', settingsSection: 'skills', hint: '打开技能管理' },
  { key: 'research', icon: 'doc',    label: '资料', tab: 'research', hint: '打开资料来源' },
  { key: 'cost',     icon: 'coin',   label: '成本', tab: 'cost',     hint: '打开成本视图' }
];

let activePopover = null;
let activeOwner = null;
// 最后已知指针位置（视口坐标）：1.8s 轮询重渲后，Chromium 对静止鼠标下的新按钮
// 刷新 :hover 是异步的（晚于微任务），用该坐标做同步命中判定可即时恢复悬停弹层。
let lastPointer = null;
// 窗口失焦标志：alt-tab 失焦时 blur 已清弹层而 lastPointer 仍在，重渲不得恢复
// 悬停弹层（后台窗口不得出现 tooltip）；窗口回到前台（focus）后恢复该能力。
let windowBlurred = false;

export function clearQuickRailPopover() {
  if (activePopover) {
    activePopover.remove();
    activePopover = null;
  }
  activeOwner = null;
}

export function renderQuickRail(root, { onOpenTab, onOpenSettings } = {}) {
  clearQuickRailPopover();
  root.innerHTML = '';
  for (const slot of SLOTS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'qr-slot';
    btn.dataset.key = slot.key;
    btn.setAttribute('aria-label', slot.label);
    btn.title = slot.hint;

    const iconEl = document.createElement('span');
    iconEl.className = 'qr-icon';
    iconEl.append(renderIcon(slot.icon, 18));
    btn.appendChild(iconEl);

    btn.addEventListener('click', () => {
      // 技能槽位打开设置弹窗的技能分区；其余打开对应抽屉分区。
      if (slot.settingsSection) onOpenSettings?.(slot.settingsSection);
      else onOpenTab?.(slot.tab);
    });
    attachHoverPreview(btn, slot);
    root.appendChild(btn);
  }
}

function attachHoverPreview(btn, slot) {
  const show = () => {
    clearQuickRailPopover();
    if (!btn.isConnected) return; // 按钮已被轮询重渲替换：放弃本次悬停
    activeOwner = btn;
    activePopover = document.createElement('div');
    activePopover.className = 'qr-popover';
    activePopover.textContent = slot.hint;
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
  // 轮询会重建按钮并清掉 popover：重建后若鼠标仍悬停，立即恢复显示。
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

export function bindQuickRailKeys(root, onOpenTab, onOpenSettings) {
  document.addEventListener('keydown', (e) => {
    if (!e.altKey) return;
    const idx = Number(e.key) - 1;
    if (idx >= 0 && idx < SLOTS.length) {
      e.preventDefault();
      const slot = SLOTS[idx];
      if (slot.settingsSection) onOpenSettings?.(slot.settingsSection);
      else onOpenTab?.(slot.tab);
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
  // 指针移出窗口后不再有 pointermove：清空坐标，避免跨窗口残留导致轮询重渲后
  // 坐标分支误命中按钮而恢复悬停弹层（:hover 已随移出变 false）。
  document.addEventListener('pointerleave', () => {
    lastPointer = null;
  }, { capture: true, passive: true });
  document.addEventListener('pointerdown', (event) => {
    if (activeOwner?.contains(event.target)) return;
    clearQuickRailPopover();
  }, true);
}
