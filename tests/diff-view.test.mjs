import assert from "node:assert/strict";
import test from "node:test";
import { diffLines } from "../src/app-shell/diff-view.js";

test("diffLines：改一行 → del+add，上下文 keep", () => {
  const out = diffLines("a\nb\nc", "a\nB\nc");
  assert.deepEqual(out, [
    { type: "keep", text: "a" },
    { type: "del", text: "b" },
    { type: "add", text: "B" },
    { type: "keep", text: "c" }
  ]);
});

test("diffLines：纯增/纯删/无变化/全替换", () => {
  assert.deepEqual(diffLines("a", "a\nb"), [{ type: "keep", text: "a" }, { type: "add", text: "b" }]);
  assert.deepEqual(diffLines("a\nb", "a"), [{ type: "keep", text: "a" }, { type: "del", text: "b" }]);
  assert.deepEqual(diffLines("a", "a"), [{ type: "keep", text: "a" }]);
  assert.deepEqual(diffLines("x", "y"), [{ type: "del", text: "x" }, { type: "add", text: "y" }]);
});
