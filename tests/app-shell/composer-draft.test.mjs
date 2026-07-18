import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { saveDraft, loadDraft, clearDraft, _setStorageForTest } from "../../src/app-shell/composer-draft.mjs";
import { hashKey } from "../../src/app-shell/utils.js";

const ROOT_A = "D:\\novels\\clock-shop";
const ROOT_B = "D:\\novels\\star-dust";

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => { map.clear(); },
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
}

beforeEach(() => {
  _setStorageForTest(createMemoryStorage());
});

test("saveDraft -> loadDraft 往返一致", () => {
  saveDraft(ROOT_A, "继续写第三章");
  assert.equal(loadDraft(ROOT_A), "继续写第三章");
});

test("saveDraft 空串等同清除", () => {
  saveDraft(ROOT_A, "半段话");
  saveDraft(ROOT_A, "");
  assert.equal(loadDraft(ROOT_A), "");
});

test("不同 projectRoot 互不干扰", () => {
  saveDraft(ROOT_A, "A 的话");
  saveDraft(ROOT_B, "B 的话");
  assert.equal(loadDraft(ROOT_A), "A 的话");
  assert.equal(loadDraft(ROOT_B), "B 的话");
});

test("clearDraft 后 loadDraft 返回空串", () => {
  saveDraft(ROOT_A, "待清");
  clearDraft(ROOT_A);
  assert.equal(loadDraft(ROOT_A), "");
});

test("projectRoot 为空时 no-op", () => {
  saveDraft("", "不应写入");
  assert.equal(loadDraft(""), "");
  clearDraft(""); // 不抛
});

test("草稿 key 命名为 wwriting:composer:draft:<hashKey>", () => {
  const captured = createMemoryStorage();
  _setStorageForTest(captured);
  saveDraft(ROOT_A, "校验 key");
  const expectedKey = "wwriting:composer:draft:" + hashKey(ROOT_A);
  assert.equal(captured.getItem(expectedKey), "校验 key");
});

test("storage 抛错时不崩（降级返回空串）", () => {
  const throwing = {
    getItem() { throw new Error("denied"); },
    setItem() { throw new Error("denied"); },
    removeItem() { throw new Error("denied"); },
    clear() {},
    key() { return null; },
    get length() { return 0; },
  };
  _setStorageForTest(throwing);
  saveDraft(ROOT_A, "不会崩");
  assert.equal(loadDraft(ROOT_A), "");
  clearDraft(ROOT_A); // 不抛
});

test("storage 为 null 时 no-op", () => {
  _setStorageForTest(() => null);
  saveDraft(ROOT_A, "无存储");
  assert.equal(loadDraft(ROOT_A), "");
});
