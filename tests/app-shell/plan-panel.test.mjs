// 第九轮：任务计划面板（chip 进度/展开收起/外点关闭/Escape）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlanPanel } from "../../src/app-shell/components/plan-panel.js";

function makeFakeDoc() {
  const elements = [];
  function el(tag) {
    const node = {
      tagName: tag.toUpperCase(),
      className: "",
      classList: {
        _classes: new Set(),
        add(cls) { this._classes.add(cls); },
        remove(cls) { this._classes.delete(cls); },
        toggle(cls, force) {
          if (force === undefined) {
            this._classes.has(cls) ? this._classes.delete(cls) : this._classes.add(cls);
          } else {
            force ? this._classes.add(cls) : this._classes.delete(cls);
          }
        },
        contains(cls) { return this._classes.has(cls); }
      },
      children: [],
      style: {},
      dataset: {},
      textContent: "",
      hidden: false,
      disabled: false,
      listeners: {},
      append(...kids) { for (const k of kids) this.children.push(k); },
      addEventListener(type, fn, options = {}) {
        (this.listeners[type] ??= []).push({ fn, once: options.once });
      },
      fire(type, extra = {}) {
        const list = this.listeners[type] ?? [];
        const evt = { target: node, stopPropagation() {}, ...extra };
        for (let i = list.length - 1; i >= 0; i--) {
          const entry = list[i];
          entry.fn(evt);
          if (entry.once) list.splice(i, 1);
        }
      },
      setAttribute(name, value) { this.dataset[name] = value; },
      getAttribute(name) { return this.dataset[name] ?? null; },
      removeAttribute() {},
      remove() {},
      replaceChildren(...kids) { this.children = kids; },
      contains(child) { return this.children.includes(child); },
      querySelector(sel) {
        if (sel.startsWith("[data-") && sel.endsWith("]")) {
          const key = sel.slice(6, -1);
          function search(n) {
            if (n.dataset && key in n.dataset) return n;
            for (const c of n.children ?? []) {
              const found = search(c);
              if (found) return found;
            }
            return null;
          }
          return search(this);
        }
        if (sel.startsWith(".")) {
          const cls = sel.slice(1);
          function search(n) {
            if (n.className && n.className.includes(cls)) return n;
            for (const c of n.children ?? []) {
              const found = search(c);
              if (found) return found;
            }
            return null;
          }
          return search(this);
        }
        return null;
      }
    };
    elements.push(node);
    return node;
  }
  return { doc: { createElement: el }, elements };
}

const ITEMS = [
  { id: "p1", step: "写第 1 章", status: "completed" },
  { id: "p2", step: "写第 2 章", status: "in_progress" },
  { id: "p3", step: "写第 3 章", status: "pending" }
];

test("chip：显示 任务计划 1/3；无计划时隐藏", () => {
  const { doc } = makeFakeDoc();
  const panel = createPlanPanel({ doc });
  panel.sync(ITEMS);
  assert.match(panel.chip.textContent, /任务计划\s*1\/3/u);
  assert.equal(panel.chip.hidden, false);
  panel.sync([]);
  assert.equal(panel.chip.hidden, true);
});

test("点击 chip 展开；再点收起；外点与 Escape 收起", () => {
  const { doc } = makeFakeDoc();
  const panel = createPlanPanel({ doc });
  panel.sync(ITEMS);
  assert.equal(panel.dropdown.hidden, true);
  panel.chip.fire("click");
  assert.equal(panel.dropdown.hidden, false);
  panel.chip.fire("click");
  assert.equal(panel.dropdown.hidden, true);
  panel.chip.fire("click");
  panel.handleOutsideClick({ target: { closest: () => null } });
  assert.equal(panel.dropdown.hidden, true);
  panel.chip.fire("click");
  panel.handleKeydown({ key: "Escape" });
  assert.equal(panel.dropdown.hidden, true);
});

test("条目状态类：completed 删除线、in_progress 高亮、pending 默认", () => {
  const { doc, elements } = makeFakeDoc();
  const panel = createPlanPanel({ doc });
  panel.sync(ITEMS);
  panel.chip.fire("click");
  const done = elements.find((e) => e.dataset.planItem === "p1");
  const active = elements.find((e) => e.dataset.planItem === "p2");
  assert.ok(done.className.includes("done"));
  assert.ok(active.className.includes("active"));
});

test("aria-expanded 同步", () => {
  const { doc } = makeFakeDoc();
  const panel = createPlanPanel({ doc });
  panel.sync(ITEMS);
  assert.equal(panel.chip.getAttribute("aria-expanded"), "false");
  panel.chip.fire("click");
  assert.equal(panel.chip.getAttribute("aria-expanded"), "true");
});

test("sync(UPDATED) while open：保持展开 + 内容更新", () => {
  const { doc } = makeFakeDoc();
  const panel = createPlanPanel({ doc });
  panel.sync(ITEMS);
  // 展开
  panel.chip.fire("click");
  assert.equal(panel.dropdown.hidden, false);
  // 更新计划（第 2 步也完成，进度 2/3）
  const UPDATED_ITEMS = [
    { id: "p1", step: "写第 1 章", status: "completed" },
    { id: "p2", step: "写第 2 章（修订）", status: "completed" },
    { id: "p3", step: "写第 3 章", status: "in_progress" }
  ];
  panel.sync(UPDATED_ITEMS);
  // 仍然展开
  assert.equal(panel.dropdown.hidden, false, "sync 后面板应保持展开");
  // chip 文字已更新为 2/3
  assert.match(panel.chip.textContent, /任务计划\s*2\/3/u, "chip 应反映新进度 2/3");
});
