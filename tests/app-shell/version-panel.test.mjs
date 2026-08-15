// 第九轮：版本时间线面板（渲染/预览/行内二次确认/禁用态）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createVersionPanel } from "../../src/app-shell/components/version-panel.js";

function makeFakeDoc() {
  const elements = [];
  function el(tag) {
    const node = {
      tagName: tag.toUpperCase(),
      className: "",
      classList: {
        add(cls) { this._classes.add(cls); },
        remove(cls) { this._classes.delete(cls); },
        toggle(cls, force) { if (force === undefined) { this._classes.has(cls) ? this._classes.delete(cls) : this._classes.add(cls); } else { force ? this._classes.add(cls) : this._classes.delete(cls); } },
        contains(cls) { return this._classes.has(cls); },
        _classes: new Set()
      },
      children: [],
      style: {},
      dataset: {},
      textContent: "",
      hidden: false,
      disabled: false,
      listeners: {},
      append(...kids) { for (const k of kids) this.children.push(k); },
      addEventListener(type, fn, options = {}) { (this.listeners[type] ??= []).push({ fn, once: options.once }); },
      async fire(type, extra = {}) {
        const list = this.listeners[type] ?? [];
        // iterate backwards so removal during iteration is safe
        const promises = [];
        for (let i = list.length - 1; i >= 0; i--) {
          const entry = list[i];
          const result = entry.fn({ target: node, stopPropagation() {}, ...extra });
          if (result && typeof result.then === "function") promises.push(result);
          if (entry.once) list.splice(i, 1);
        }
        await Promise.all(promises);
      },
      setAttribute(name, value) { this.dataset[name] = String(value); },
      getAttribute(name) { return this.dataset[name] ?? null; },
      removeAttribute(name) { delete this.dataset[name]; },
      remove() {},
      replaceChildren(...kids) { this.children = kids; },
      querySelector(sel) {
        // Very simple selector: [data-xxx] or .class
        if (sel.startsWith("[data-") && sel.endsWith("]")) {
          const key = sel.slice(6, -1); // e.g. "version-preview"
          // search self and descendants
          function search(node) {
            if (node.dataset && node.dataset[key] !== undefined) return node;
            for (const child of node.children ?? []) {
              const found = search(child);
              if (found) return found;
            }
            return null;
          }
          return search(this);
        }
        if (sel.startsWith(".")) {
          const cls = sel.slice(1);
          function search(node) {
            if (node.className && node.className.includes(cls)) return node;
            for (const child of node.children ?? []) {
              const found = search(child);
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

const VERSIONS = [
  { version: 3, timestamp: "2026-08-15T10:00:00Z", source: "revision", checksum: "a".repeat(64) },
  { version: 2, timestamp: "2026-08-15T09:00:00Z", source: "commit", checksum: "b".repeat(64) },
  { version: 1, timestamp: "2026-08-15T08:00:00Z", source: "baseline", checksum: "c".repeat(64) }
];

test("渲染版本行：版本号/来源/时间，不渲染校验和", async () => {
  const { doc, elements } = makeFakeDoc();
  const panel = createVersionPanel({ doc });
  const requests = [];
  await panel.open({ title: "第 1 章", kind: "chapter", chapterNo: 1, getVersions: async () => ({ versions: VERSIONS }), getContent: async () => ({ content: "旧正文" }), onRestore: async (v) => requests.push(v) });
  const rows = elements.filter((e) => e.dataset.versionRow !== undefined);
  assert.equal(rows.length, 3);
  const text = elements.map((e) => e.textContent).join("|");
  assert.ok(text.includes("v3"));
  assert.ok(text.includes("v1"));
  assert.ok(!text.includes("a".repeat(8)), "校验和不得渲染");
});

test("恢复控件是真实 button，版本行用 role=button 避免嵌套按钮", async () => {
  const { doc, elements } = makeFakeDoc();
  const panel = createVersionPanel({ doc });
  await panel.open({ title: "第 1 章", getVersions: async () => ({ versions: VERSIONS }), getContent: async () => ({ content: "x" }), onRestore: async () => {} });
  const row = elements.find((el) => el.dataset.versionRow === "3");
  const restore = elements.find((el) => el.dataset.restoreButton === "3");
  assert.equal(row.tagName, "DIV");
  assert.equal(row.getAttribute("role"), "button");
  assert.equal(restore.tagName, "BUTTON");
});

test("行内二次确认：restore → confirm 才调用 onRestore", async () => {
  const { doc, elements } = makeFakeDoc();
  const panel = createVersionPanel({ doc });
  const requests = [];
  await panel.open({ title: "第 1 章", kind: "chapter", chapterNo: 1, getVersions: async () => ({ versions: VERSIONS }), getContent: async () => ({ content: "x" }), onRestore: async (v) => requests.push(v) });
  const restoreBtn = elements.find((e) => e.dataset.restoreButton === "3");
  restoreBtn.fire("click");
  assert.equal(requests.length, 0, "第一次点击只进入确认态");
  const confirmBtn = elements.find((e) => e.dataset.restoreConfirm === "3");
  assert.ok(confirmBtn, "按钮应变为确认态");
  confirmBtn.fire("click");
  assert.deepEqual(requests, [3]);
});

test("预览：点行请求内容并渲染（正文神圣类名）", async () => {
  const { doc, elements } = makeFakeDoc();
  const panel = createVersionPanel({ doc });
  const calls = [];
  await panel.open({ title: "第 1 章", kind: "chapter", chapterNo: 1, getVersions: async () => ({ versions: VERSIONS }), getContent: async (v) => { calls.push(v); return { content: `旧正文 v${v}` }; }, onRestore: async () => {} });
  const row = elements.find((e) => e.dataset.versionRow === "2");
  await row.fire("click");
  assert.deepEqual(calls, [2]);
  assert.ok(elements.some((e) => e.dataset.versionPreview === "2" && e.className?.includes?.("prose")));
});

test("版本行 Enter/Space 触发预览（与点击同一路径）", async () => {
  const { doc, elements } = makeFakeDoc();
  const panel = createVersionPanel({ doc });
  const calls = [];
  await panel.open({ title: "第 1 章", kind: "chapter", chapterNo: 1, getVersions: async () => ({ versions: VERSIONS }), getContent: async (v) => { calls.push(v); return { content: "x" }; }, onRestore: async () => {} });
  const row = elements.find((e) => e.dataset.versionRow === "1");
  await row.fire("keydown", { key: "Enter", preventDefault() {} });
  await row.fire("keydown", { key: " ", preventDefault() {} });
  assert.deepEqual(calls, [1, 1]);
});

test("预览失败 → 面板 notice；previewBusy 复位后重试可成功", async () => {
  const { doc, elements } = makeFakeDoc();
  const panel = createVersionPanel({ doc });
  let calls = 0;
  await panel.open({
    title: "第 1 章", getVersions: async () => ({ versions: VERSIONS }),
    getContent: async () => {
      calls += 1;
      if (calls === 1) throw new Error("网络超时");
      return { content: "成功内容" };
    },
    onRestore: async () => {}
  });
  const row = elements.find((e) => e.dataset.versionRow === "2");
  await row.fire("click");
  assert.ok(elements.some((e) => e.textContent?.includes("网络超时")), "预览失败应显示 notice");
  await row.fire("click");
  assert.ok(
    elements.some((e) => e.dataset.versionPreview === "2" && e.textContent.includes("成功内容")),
    "previewBusy 复位后重试可成功"
  );
});

test("恢复失败 → 按钮复位 + notice，无未处理 rejection", async () => {
  const { doc, elements } = makeFakeDoc();
  const panel = createVersionPanel({ doc });
  const restored = [];
  await panel.open({
    title: "第 1 章", getVersions: async () => ({ versions: VERSIONS }), getContent: async () => ({ content: "x" }),
    onRestore: async (v) => {
      restored.push(v);
      throw new Error("回滚失败");
    }
  });
  const restoreBtn = elements.find((e) => e.dataset.restoreButton === "3");
  restoreBtn.fire("click"); // 第一次：进入确认态
  restoreBtn.fire("click"); // 第二次：触发 onRestore（reject）
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(restored, [3], "onRestore 被调用一次");
  assert.equal(restoreBtn.disabled, false, "失败后按钮复位可用");
  assert.equal(restoreBtn.textContent, "恢复此版", "失败后文案复位");
  assert.ok(elements.some((e) => e.textContent?.includes("回滚失败")), "失败显示 notice");
});

test("agentRunning=true：恢复按钮禁用并提示", async () => {
  const { doc, elements } = makeFakeDoc();
  const panel = createVersionPanel({ doc });
  await panel.open({ title: "第 1 章", kind: "chapter", chapterNo: 1, getVersions: async () => ({ versions: VERSIONS }), getContent: async () => ({ content: "x" }), onRestore: async () => {}, agentRunning: true });
  assert.ok(elements.some((e) => e.dataset.restoreButton && e.disabled === true));
  assert.ok(elements.map((e) => e.textContent).join("|").includes("写作进行中"));
});

test("open() 空版本列表 → 显示「暂无历史版本。」", async () => {
  const { doc, elements } = makeFakeDoc();
  const panel = createVersionPanel({ doc });
  await panel.open({ title: "第 5 章", kind: "chapter", chapterNo: 5, getVersions: async () => ({ versions: [] }), getContent: async () => ({}), onRestore: async () => {} });
  assert.ok(panel.hidden === false, "面板应可见");
  assert.ok(elements.some((e) => e.textContent?.includes("暂无历史版本。")), "应显示暂无历史版本提示");
});

test("open() getVersions 失败 → 显示错误信息", async () => {
  const { doc, elements } = makeFakeDoc();
  const panel = createVersionPanel({ doc });
  await panel.open({
    title: "第 3 章", kind: "chapter", chapterNo: 3,
    getVersions: async () => { throw new Error("网络超时"); },
    getContent: async () => ({}), onRestore: async () => {}
  });
  assert.ok(panel.hidden === false, "面板应可见");
  assert.ok(elements.some((e) => e.textContent?.includes("网络超时")), "应显示错误消息");
});

test("close() → host.hidden 为 true", async () => {
  const { doc } = makeFakeDoc();
  const panel = createVersionPanel({ doc });
  await panel.open({ title: "第 1 章", kind: "chapter", chapterNo: 1, getVersions: async () => ({ versions: VERSIONS }), getContent: async () => ({ content: "x" }), onRestore: async () => {} });
  assert.equal(panel.hidden, false, "open 后面板应可见");
  panel.close();
  assert.equal(panel.hidden, true, "close 后面板应隐藏");
});