import assert from "node:assert/strict";
import test from "node:test";
import { formatYuan } from "../../src/app-shell/utils.js";

// Task 21/25（spec 4.3 #4）：成本统一人民币元、两位小数——formatYuan 是全库
// 唯一成本出口，任何路径不得再输出 $ / ¥ 或缺两位小数。
test("formatYuan 两位小数 + 元，无 $ / ¥", () => {
  assert.equal(formatYuan(1.2), "1.20 元");
  assert.equal(formatYuan(0), "0.00 元");
  assert.equal(formatYuan("3.456"), "3.46 元");
  assert.equal(formatYuan(undefined), "0.00 元");
  assert.equal(formatYuan(null), "0.00 元");
  assert.equal(formatYuan(NaN), "0.00 元", "NaN 不得泄漏为 NaN 元");
  assert.equal(formatYuan(Infinity), "0.00 元", "Infinity 不得泄漏");
  assert.equal(formatYuan(-1.2), "-1.20 元", "负数保留符号展示，便于发现数据异常");
  assert.equal(formatYuan(1.2).includes("$"), false);
  assert.equal(formatYuan(1.2).includes("¥"), false);
});

