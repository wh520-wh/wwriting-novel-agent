import assert from "node:assert/strict";
import test from "node:test";
import { hashKey } from "../../src/app-shell/utils.js";

test("hashKey 对同一 projectRoot 稳定返回同一短 key", () => {
  assert.equal(
    hashKey("D:\\novels\\clock-shop"),
    hashKey("D:\\novels\\clock-shop"),
  );
});

test("hashKey 对不同 projectRoot 返回不同 key", () => {
  assert.notEqual(hashKey("D:\\novels\\a"), hashKey("D:\\novels\\b"));
});

test("hashKey 输出 12 位十六进制串", () => {
  assert.match(hashKey("D:\\novels\\clock-shop"), /^[0-9a-f]{12}$/u);
});
