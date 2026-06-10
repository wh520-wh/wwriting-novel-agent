import assert from "node:assert/strict";
import test from "node:test";
import { parseSimpleYaml, serializeSimpleYaml } from "../src/core/simple-yaml.mjs";

// --- parseSimpleYaml ---

test("parseSimpleYaml parses simple key-value pairs", () => {
  const result = parseSimpleYaml("name: Alice\nage: 30\n");
  assert.equal(result.name, "Alice");
  assert.equal(result.age, 30);
});

test("parseSimpleYaml parses boolean values", () => {
  const result = parseSimpleYaml("enabled: true\ndisabled: false\n");
  assert.equal(result.enabled, true);
  assert.equal(result.disabled, false);
});

test("parseSimpleYaml parses null values", () => {
  const result = parseSimpleYaml("value: null\n");
  assert.equal(result.value, null);
});

test("parseSimpleYaml parses integer and float numbers", () => {
  const result = parseSimpleYaml("int: 42\nfloat: 3.14\nnegative: -7\n");
  assert.equal(result.int, 42);
  assert.equal(result.float, 3.14);
  assert.equal(result.negative, -7);
});

test("parseSimpleYaml parses JSON-encoded strings", () => {
  const result = parseSimpleYaml('greeting: "hello world"\n');
  assert.equal(result.greeting, "hello world");
});

test("parseSimpleYaml parses JSON arrays", () => {
  const result = parseSimpleYaml('tags: ["a","b","c"]\n');
  assert.deepEqual(result.tags, ["a", "b", "c"]);
});

test("parseSimpleYaml parses JSON objects", () => {
  const result = parseSimpleYaml('nested: {"x":1,"y":2}\n');
  assert.deepEqual(result.nested, { x: 1, y: 2 });
});

test("parseSimpleYaml ignores comments", () => {
  const result = parseSimpleYaml("# this is a comment\nname: value\n# another comment\n");
  assert.deepEqual(Object.keys(result), ["name"]);
  assert.equal(result.name, "value");
});

test("parseSimpleYaml ignores blank lines", () => {
  const result = parseSimpleYaml("\n\nname: value\n\n\nother: val2\n\n");
  assert.equal(result.name, "value");
  assert.equal(result.other, "val2");
});

test("parseSimpleYaml returns empty object for empty input", () => {
  assert.deepEqual(parseSimpleYaml(""), {});
  assert.deepEqual(parseSimpleYaml(null), {});
  assert.deepEqual(parseSimpleYaml(undefined), {});
});

test("parseSimpleYaml handles values containing colons", () => {
  const result = parseSimpleYaml("url: http://example.com\n");
  assert.equal(result.url, "http://example.com");
});

test("parseSimpleYaml trims whitespace from keys and values", () => {
  const result = parseSimpleYaml("  key  :  value  \n");
  assert.equal(result.key, "value");
});

test("parseSimpleYaml ignores lines without colons", () => {
  const result = parseSimpleYaml("valid: yes\nno colon here\nalso valid: true\n");
  assert.equal(result.valid, "yes");
  assert.equal(result["also valid"], true);
  assert.equal(result["no colon here"], undefined);
});

test("parseSimpleYaml handles plain string values (unquoted)", () => {
  const result = parseSimpleYaml("status: active\n");
  assert.equal(result.status, "active");
});

// --- serializeSimpleYaml ---

test("serializeSimpleYaml serializes simple key-value pairs", () => {
  const output = serializeSimpleYaml({ name: "Alice", age: 30 });
  assert.ok(output.includes("name: \"Alice\""));
  assert.ok(output.includes("age: 30"));
  assert.ok(output.endsWith("\n"));
});

test("serializeSimpleYaml serializes booleans", () => {
  const output = serializeSimpleYaml({ enabled: true, disabled: false });
  assert.ok(output.includes("enabled: true"));
  assert.ok(output.includes("disabled: false"));
});

test("serializeSimpleYaml serializes arrays as JSON", () => {
  const output = serializeSimpleYaml({ tags: ["a", "b"] });
  assert.ok(output.includes('tags: ["a","b"]'));
});

test("serializeSimpleYaml serializes objects as JSON", () => {
  const output = serializeSimpleYaml({ nested: { x: 1 } });
  assert.ok(output.includes('nested: {"x":1}'));
});

test("serializeSimpleYaml serializes strings with JSON quoting", () => {
  const output = serializeSimpleYaml({ msg: "hello world" });
  assert.ok(output.includes('msg: "hello world"'));
});

// --- round-trip ---

test("simple-yaml round-trip for basic types", () => {
  const original = { count: 42, active: true, name: "test" };
  const serialized = serializeSimpleYaml(original);
  const parsed = parseSimpleYaml(serialized);
  assert.deepEqual(parsed, original);
});

test("simple-yaml round-trip preserves arrays", () => {
  const original = { items: [1, 2, 3] };
  const serialized = serializeSimpleYaml(original);
  const parsed = parseSimpleYaml(serialized);
  assert.deepEqual(parsed, original);
});
