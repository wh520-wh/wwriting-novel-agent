import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { readJsonBody } from "../../src/core/http/router.mjs";

function chunked(body, splitAt) {
  const bytes = Buffer.from(body);
  const parts = splitAt === undefined ? [bytes] : [bytes.subarray(0, splitAt), bytes.subarray(splitAt)];
  return Readable.from(parts);
}

test("readJsonBody：分块边界落在中文字符中间时正文逐字无损", async () => {
  const original = { text: "中文写作" };
  const raw = JSON.stringify(original);
  // 「中」字首个字节之后切开：逐块解码会产出替换字符，字节累计解码不得。
  const split = Buffer.from(raw).indexOf(Buffer.from("中")) + 1;
  const parsed = await readJsonBody(chunked(raw, split));
  assert.equal(parsed.text, original.text);
});

test("readJsonBody：请求体上限按字节判定（多字节字符不再按 1 计）", async () => {
  // 400_000 个「汉」= 1,200,000 字节，超 1,000,000 字节上限；
  // 若按解码后字符数判定（400,000 字符 < 1,000,000）则不会触发 413——
  // 该边界只能在字节口径下触发，锁住口径本身。
  const body = JSON.stringify({ text: "汉".repeat(400_000) });
  await assert.rejects(readJsonBody(chunked(body)), (error) => error.httpStatus === 413);
});

test("readJsonBody：上限覆盖 Agent 硬窗口的最坏中文输入（24 万汉字不误拒）", async () => {
  const body = JSON.stringify({ text: "汉".repeat(240_000) });
  const parsed = await readJsonBody(chunked(body));
  assert.equal(parsed.text.length, 240_000, "≈720KB 的合法长素材不得被 413");
});

test("readJsonBody：空体返回空对象", async () => {
  assert.deepEqual(await readJsonBody(chunked("")), {});
});
