// src/app-shell/dom-kit.js —— 前端共享 DOM/form 构建层（第十五轮 F6）。
// 唯一 hyperscript 入口（el）+ 自动保存表单绑定（bindAutosave）+ 行内错误提示
//（showFieldError/clearFieldError/fieldError）；toast/focusTrap/confirmLayer
// 在 Task 12/13 陆续收编。
//
// 依赖注入约定：el 的 doc 为文档引用（默认全局 document，真实 Electron 环境）——
// node:test 下调用方必须注入测试 document/mock，与 model-settings-page 的
// documentRef ctx 注入同语义（该页在 createModelSettingsPage 内一行桥接）。

// 行内错误写入：refs.errorRefs 为 fieldKey → 错误行 span 的 Map。
export function showFieldError(refs, fieldKey, message) {
  const span = refs?.errorRefs?.get(fieldKey);
  if (span) span.textContent = message;
}

export function clearFieldError(refs, fieldKey) {
  showFieldError(refs, fieldKey, "");
}

// 失焦（change）自动保存（Task 20 draft-first）：空值/非法值不再静默丢弃——
// 保留编辑态（输入值不动）并行内显示中文错误；合法值才提交保存。
// commit 返回 { ok, error }（commitProviderPatch/commitModelPatch 形状），
// 失败时行内回显错误（toast 由 commit 内部弹）。
// Task 22（#11）：onEnter 开启时绑定 Enter——与失焦保存同一提交路径，使
//「名称框回车保存」提示文案与真实行为一致（校验/行内错误行为完全相同）。
// Task 22 审查（Important 1）：run() 内记 lastCommitted（提交前乐观置位，失败
// 复位）——真实 DOM 在输入框被移除时派发挂起的 change（Enter 保存成功后
// refresh 重建详情，被替换的输入框仍是焦点元素且带挂起 change），同值二次
// 触发 run() 会重复 PATCH；同值跳过（含在途竞态与 Enter 连按）不丢新改动
//（值变化后仍正常提交，失败后同值可重试）。
export function bindAutosave(input, { refs, fieldKey, validate = null, commit, onEnter = false }) {
  let lastCommitted = null;
  const run = async () => {
    const value = input.value.trim();
    if (value === lastCommitted) return;
    const error = validate ? validate(value) : null;
    if (error) {
      showFieldError(refs, fieldKey, error);
      return;
    }
    lastCommitted = value;
    clearFieldError(refs, fieldKey);
    const result = await commit(value);
    if (result?.ok === false) {
      lastCommitted = null; // 失败复位：同一值可重试
      showFieldError(refs, fieldKey, result.error ?? "保存失败，请重试");
    }
  };
  input.addEventListener("change", run);
  if (onEnter) {
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      void run();
    });
  }
}

// 校验失败出口：行内回显中文错误并保留编辑态，返回 { ok: false } 中止后续动作。
export function fieldError(refs, fieldKey, message) {
  showFieldError(refs, fieldKey, message);
  return { ok: false, error: message };
}

// hyperscript：最简 element 构建（text/class/value/disabled 走 property，
// 其余属性直映射 setAttribute）。doc 为文档引用——调用方注入（见头注释）。
export function el(tag, props = {}, children = [], doc = globalThis.document) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else if (key === "value") node.value = value; // value 走 property 而非 setAttribute：保住用户已键入的值
    else if (key === "disabled") node.disabled = Boolean(value); // 同 value 走 property：真 DOM 与测试 mock 均正确反映禁用态
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (typeof child === "string") node.append(doc.createTextNode(child));
    else if (child) node.append(child);
  }
  return node;
}
