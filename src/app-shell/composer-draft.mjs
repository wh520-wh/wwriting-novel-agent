import { hashKey } from "./utils.js";

const DRAFT_PREFIX = "wwriting:composer:draft:";

// 默认走浏览器全局 localStorage；测试可通过 _setStorageForTest 注入。
let getStorage = () => {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
};

function draftKey(projectRoot) {
  return DRAFT_PREFIX + hashKey(projectRoot);
}

export function saveDraft(projectRoot, text) {
  if (!projectRoot) return;
  const s = getStorage();
  if (!s) return;
  const t = String(text ?? "");
  try {
    if (t === "") s.removeItem(draftKey(projectRoot));
    else s.setItem(draftKey(projectRoot), t);
  } catch {
    // 不可用则降级，不抛给调用方
  }
}

export function loadDraft(projectRoot) {
  if (!projectRoot) return "";
  const s = getStorage();
  if (!s) return "";
  try {
    return s.getItem(draftKey(projectRoot)) ?? "";
  } catch {
    return "";
  }
}

export function clearDraft(projectRoot) {
  if (!projectRoot) return;
  const s = getStorage();
  if (!s) return;
  try {
    s.removeItem(draftKey(projectRoot));
  } catch {
    // 不可用则降级
  }
}

// 仅供单元测试注入 storage；生产代码不调用。
export function _setStorageForTest(storageOrFn) {
  getStorage = typeof storageOrFn === "function" ? storageOrFn : () => storageOrFn;
}
