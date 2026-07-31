// 模型连接测试全局记忆：测试通过过的模型名记到本地，新建项目用同一模型不再强制重测。
// 仅按 model_name 记（与 write-readiness.mjs 的 findLatestConnectionEvent 一致）。
// 默认走浏览器全局 localStorage；测试可通过 _setStorageForTest 注入。

const TESTED_MODELS_KEY = "wwriting:tested-models-ok";

let getStorage = () => {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
};

function readList() {
  const s = getStorage();
  if (!s) return [];
  try {
    const raw = s.getItem(TESTED_MODELS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((m) => typeof m === "string" && m) : [];
  } catch {
    return [];
  }
}

function writeList(list) {
  const s = getStorage();
  if (!s) return;
  try {
    s.setItem(TESTED_MODELS_KEY, JSON.stringify(list));
  } catch {
    // 不可用则降级
  }
}

// 测试通过 -> 记住；测试失败 -> 移除（key 可能已失效）。
export function rememberTestedModel(modelName, ok) {
  const name = String(modelName ?? "").trim();
  if (!name) return;
  const list = readList().filter((m) => m !== name);
  if (ok) list.push(name);
  writeList(list);
}

export function isModelTestedOk(modelName) {
  const name = String(modelName ?? "").trim();
  if (!name) return false;
  return readList().includes(name);
}

export function listTestedModels() {
  return readList();
}

export function forgetTestedModel(modelName) {
  const name = String(modelName ?? "").trim();
  if (!name) return;
  writeList(readList().filter((m) => m !== name));
}

// 仅供单元测试注入 storage；生产代码不调用。
export function _setStorageForTest(storageOrFn) {
  getStorage = typeof storageOrFn === "function" ? storageOrFn : () => storageOrFn;
}
