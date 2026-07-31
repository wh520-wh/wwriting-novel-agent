import test from "node:test";
import assert from "node:assert/strict";
import { saveDefaultTier, loadDefaultTier, _setStorageForTest } from "../../src/app-shell/permission-defaults.mjs";

function makeMockStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

test("saveDefaultTier / loadDefaultTier 往返一致", () => {
  const storage = makeMockStorage();
  _setStorageForTest(storage);
  assert.equal(loadDefaultTier(), null);
  saveDefaultTier("yolo");
  assert.equal(loadDefaultTier(), "yolo");
  saveDefaultTier("confirm");
  assert.equal(loadDefaultTier(), "confirm");
});

test("saveDefaultTier 忽略空值", () => {
  const storage = makeMockStorage();
  _setStorageForTest(storage);
  saveDefaultTier("");
  saveDefaultTier(null);
  assert.equal(loadDefaultTier(), null);
});
