// 权限模式全局默认：用户选过某档（含 YOLO）后，新建项目默认套用同一档。
// 仅存档位 id（read_only / confirm / auto / yolo），combo 由 permission-tiers.mjs 解析。
// 默认走浏览器全局 localStorage；测试可通过 _setStorageForTest 注入。

const DEFAULT_TIER_KEY = "wwriting:default-permission-tier";

let getStorage = () => {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
};

export function saveDefaultTier(tierId) {
  const s = getStorage();
  if (!s || !tierId) return;
  try {
    s.setItem(DEFAULT_TIER_KEY, String(tierId));
  } catch {
    // 不可用则降级，不抛给调用方
  }
}

export function loadDefaultTier() {
  const s = getStorage();
  if (!s) return null;
  try {
    return s.getItem(DEFAULT_TIER_KEY) ?? null;
  } catch {
    return null;
  }
}

// 仅供单元测试注入 storage；生产代码不调用。
export function _setStorageForTest(storageOrFn) {
  getStorage = typeof storageOrFn === "function" ? storageOrFn : () => storageOrFn;
}
