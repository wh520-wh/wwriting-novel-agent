// src/app-shell/components/plan-panel.js —— 第九轮：任务计划面板。
// 顶栏常驻 chip（任务计划 N/M ▾）+ 绝对定位折叠下拉；不遮挡（覆盖层只在展开时
// 存在）、a11y（role=button + aria-expanded + Escape）。
const STATUS_ICON = { completed: "✓", in_progress: "●", pending: "○" };
const STATUS_LABEL = { completed: "已完成", in_progress: "进行中", pending: "待办" };

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

  function render(items) {
    chip.replaceChildren();
    const done = items.filter((i) => i.status === "completed").length;
    chip.textContent = `任务计划 ${done}/${items.length}`;
    chip.append(dropdown);

    dropdown.replaceChildren();
    for (const item of items) {
      const row = doc.createElement("div");
      row.className = `plan-item${item.status === "completed" ? " done" : ""}${item.status === "in_progress" ? " active" : ""}`;
      row.dataset.planItem = item.id;

      const iconEl = doc.createElement("span");
      iconEl.className = "plan-item-icon";
      iconEl.textContent = STATUS_ICON[item.status] ?? "○";

      const step = doc.createElement("span");
      step.className = "plan-item-step";
      step.textContent = item.step;

      const label = doc.createElement("span");
      label.className = "plan-item-status";
      label.textContent = STATUS_LABEL[item.status] ?? "";

      row.append(iconEl, step, label);
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
      if (event.key === "Escape" && open) setOpen(false);
    }
  };
  return panel;
}
