import assert from "node:assert/strict";
import test from "node:test";
import {
  registerSchema,
  parseStructuredOutput,
  STRUCTURED_OUTPUT_ERRORS
} from "../src/core/structured-output.mjs";

registerSchema("test_thing", "v1", {
  normalize: (d) => ({ name: String(d?.name ?? ""), kind: String(d?.kind ?? "") }),
  validate: (n) => {
    if (!n.name) return { ok: false, code: STRUCTURED_OUTPUT_ERRORS.missing_field, field: "name" };
    if (!["a", "b"].includes(n.kind)) return { ok: false, code: STRUCTURED_OUTPUT_ERRORS.enum_violation, field: "kind" };
    return { ok: true };
  }
});

registerSchema("throw_thing", "v1", {
  normalize: () => { throw new Error("boom"); },
  validate: () => ({ ok: true })
});

test("parseStructuredOutput 合法围栏 JSON 通过", () => {
  const r = parseStructuredOutput("test_thing", "v1", '```json\n{"name":"x","kind":"a"}\n```');
  assert.equal(r.ok, true);
  assert.equal(r.data.name, "x");
});

test("parseStructuredOutput 裸 JSON 也通过", () => {
  const r = parseStructuredOutput("test_thing", "v1", '{"name":"x","kind":"b"}');
  assert.equal(r.ok, true);
});

test("parseStructuredOutput 非法 JSON 返回 invalid_json", () => {
  const r = parseStructuredOutput("test_thing", "v1", "not json at all");
  assert.equal(r.ok, false);
  assert.equal(r.error.code, STRUCTURED_OUTPUT_ERRORS.invalid_json);
});

test("parseStructuredOutput 空内容返回 empty_content", () => {
  const r = parseStructuredOutput("test_thing", "v1", "   ");
  assert.equal(r.error.code, STRUCTURED_OUTPUT_ERRORS.empty_content);
});

test("parseStructuredOutput 缺字段返回 missing_field + field", () => {
  const r = parseStructuredOutput("test_thing", "v1", '{"name":"","kind":"a"}');
  assert.equal(r.error.code, STRUCTURED_OUTPUT_ERRORS.missing_field);
  assert.equal(r.error.field, "name");
});

test("parseStructuredOutput 超枚举返回 enum_violation + field", () => {
  const r = parseStructuredOutput("test_thing", "v1", '{"name":"x","kind":"weird"}');
  assert.equal(r.error.code, STRUCTURED_OUTPUT_ERRORS.enum_violation);
  assert.equal(r.error.field, "kind");
});

test("parseStructuredOutput 未注册 schema 返回 schema_not_found", () => {
  const r = parseStructuredOutput("nope", "v1", "{}");
  assert.equal(r.error.code, STRUCTURED_OUTPUT_ERRORS.schema_not_found);
});

test("parseStructuredOutput normalize 抛异常返回 invalid_json 不穿透", () => {
  const r = parseStructuredOutput("throw_thing", "v1", "{}");
  assert.equal(r.ok, false);
  assert.equal(r.error.code, STRUCTURED_OUTPUT_ERRORS.invalid_json);
});

test("STRUCTURED_OUTPUT_ERRORS 不含 truncated（YAGNI，截断走 invalid_json）", () => {
  assert.equal("truncated" in STRUCTURED_OUTPUT_ERRORS, false);
});
