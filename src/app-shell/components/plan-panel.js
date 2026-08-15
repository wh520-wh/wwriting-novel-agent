// src/app-shell/components/plan-panel.js —— 第九轮：任务计划面板。
// 顶栏常驻 chip（任务计划 N/M ▾）+ 绝对定位折叠下拉；不遮挡（覆盖层只在展开时
// 存在）、a11y（role=button + aria-expanded + Escape）。
// AICSS task-list：chip 头部三态图标（列表/pie/实心勾）+ 滚动计数；条目图标
// 由 components/task-icons.mjs 单源提供（与工作组计划项同源）。
import { taskIcon } from "./task-icons.mjs";

const STATUS_LABEL = { completed: "已完成", in_progress: "进行中", pending: "待办" };

// AICSS task-list：chip 头部图标三态。pie 弧长 = 2πr ≈ 66，按完成比例绘制；
// 进度弧配色走 CSS（.plan-chip-pie-arc，见 styles.css）——SVG 属性不解析 var()。
const CHIP_ICON_SVG = {
  list: '<svg class="plan-chip-list" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0ZM3.75 12h.007v.008H3.75V12Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm-.375 5.25h.007v.008H3.75v-.008Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z"/></svg>',
  check: '<svg class="plan-chip-check" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12Zm13.36-1.814a.75.75 0 1 0-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 0 0-1.06 1.06l2.25 2.25a.75.75 0 0 0 1.14-.094l3.75-5.25Z" fill="currentColor"/></svg>',
  pie: (pct) => `<svg class="plan-chip-pie" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><circle cx="12" cy="12" r="10.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-dasharray="2.2 4.4" stroke-linecap="round"/><circle class="plan-chip-pie-arc" cx="12" cy="12" r="10.5" fill="none" stroke-width="2.2" stroke-dasharray="${(pct / 100) * 66} 66" stroke-linecap="round" transform="rotate(-90 12 12)"/></svg>`
};

export function createPlanPanel({ doc = document }) {
  const chip = doc.createElement("button");
  chip.type = "button";
  chip.className = "plan-chip";
  chip.dataset.planChip = "";
  chip.setAttribute("role", "button");
  chip.setAttribute("aria-expanded", "false");
  chip.setAttribute("aria-label", "任务计划");
  chip.hidden = true;

  const dropdown = doc.createElement("div");
  dropdown.className = "plan-dropdown";
  dropdown.dataset.planDropdown = "";
  dropdown.hidden = true;

  let open = false;
  let lastCountText = ""; // AICSS：计数变化才触发滚动动画类

  function chipIconHtml(items) {
    const done = items.filter((i) => i.status === "completed").length;
    const total = items.length;
    if (total > 0 && done === total) return CHIP_ICON_SVG.check;
    if (done > 0) return CHIP_ICON_SVG.pie(Math.round((done / total) * 100));
    return CHIP_ICON_SVG.list;
  }

  function render(items) {
    chip.replaceChildren();
    const done = items.filter((i) => i.status === "completed").length;
    // 文本放进独立 span 承担 ellipsis 截断；chip 自身 overflow: visible，
    // 避免裁剪挂在 chip 内部的绝对定位下拉（dropdown 展开后被 overflow:hidden 整个裁没）。
    const iconEl = doc.createElement("span");
    iconEl.className = "plan-chip-icon";
    iconEl.setAttribute("aria-hidden", "true");
    iconEl.innerHTML = chipIconHtml(items);
    const label = doc.createElement("span");
    label.className = "plan-chip-label";
    label.textContent = "任务计划 ";
    // AICSS task-list：滚动计数（按字符拆 span，CSS 380ms 滚动动画；
    // 文本拼装 = 前缀 + 逐字符，测试按 children 拼接断言）。
    const count = doc.createElement("span");
    count.className = "plan-chip-count";
    for (const char of `${done}/${items.length}`) {
      const slot = doc.createElement("span");
      slot.className = "plan-chip-digit";
      slot.textContent = char;
      count.append(slot);
    }
    if (lastCountText !== "" && lastCountText !== `${done}/${items.length}`) {
      count.classList.add("plan-chip-count--roll");
    }
    lastCountText = `${done}/${items.length}`;
    label.append(count);
    chip.append(iconEl, label, dropdown);

    dropdown.replaceChildren();
    for (const item of items) {
      const row = doc.createElement("div");
      row.className = `plan-item${item.status === "completed" ? " done" : ""}${item.status === "in_progress" ? " active" : ""}`;
      row.dataset.planItem = item.id;

      const iconElRow = doc.createElement("span");
      iconElRow.className = "plan-item-icon";
      iconElRow.innerHTML = taskIcon(item.status, 14);

      const step = doc.createElement("span");
      step.className = "plan-item-step";
      step.textContent = item.step;

      const label = doc.createElement("span");
      label.className = "plan-item-status";
      label.textContent = STATUS_LABEL[item.status] ?? "";

      row.append(iconElRow, step, label);
      dropdown.append(row);
    }
  }

  function setOpen(next) {
    open = next;
    dropdown.hidden = !next;
    chip.classList.toggle("plan-open", next);
    chip.setAttribute("aria-expanded", String(next));
  }

  chip.addEventListener("click", (event) => {
    event.stopPropagation();
    setOpen(!open);
  });

  const panel = {
    chip,
    dropdown,
    sync(items) {
      if (!Array.isArray(items) || items.length === 0) {
        chip.hidden = true;
        setOpen(false);
        return;
      }
      chip.hidden = false;
      render(items);
      if (!open) setOpen(false);
    },
    handleOutsideClick(event) {
      if (open && !(event.target && (event.target === chip || chip.contains?.(event.target)))) setOpen(false);
    },
    handleKeydown(event) {
      // Round10：Escape 关闭并把焦点还给 chip；preventDefault 让全局路由
      //（检查 event.defaultPrevented）跳过本键，不再关闭其它层。
      if (event.key === "Escape" && open) {
        setOpen(false);
        chip.focus();
        event.preventDefault();
      }
    }
  };
  return panel;
}
