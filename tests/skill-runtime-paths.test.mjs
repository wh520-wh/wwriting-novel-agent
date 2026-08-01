import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSkillPaths } from "../src/core/skill-runtime.mjs";

test("parseSkillPaths returns undefined when paths missing", () => {
  assert.equal(parseSkillPaths({}), undefined);
});

test("parseSkillPaths accepts single string", () => {
  assert.deepEqual(parseSkillPaths({ paths: "chapters/poetry/**" }), ["chapters/poetry"]);
});

test("parseSkillPaths accepts array", () => {
  assert.deepEqual(
    parseSkillPaths({ paths: ["chapters/poetry/**", "drafts/**"] }),
    ["chapters/poetry", "drafts"]
  );
});

test("parseSkillPaths strips /** suffix", () => {
  assert.deepEqual(parseSkillPaths({ paths: "**/*.md" }), ["**/*.md".replace("/**", "")]);
});

test("parseSkillPaths returns undefined when all patterns are **", () => {
  assert.equal(parseSkillPaths({ paths: ["**"] }), undefined);
});

test("parseSkillPaths filters out empty patterns", () => {
  assert.deepEqual(parseSkillPaths({ paths: ["", "  ", "chapters/**"] }), ["chapters"]);
});
