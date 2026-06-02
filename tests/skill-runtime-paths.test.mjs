import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSkillPaths, activateConditionalSkillsForPaths } from "../src/core/skill-runtime.mjs";
import { registerProjectSkill, _resetConditionalSkills } from "../src/core/skill-runtime.mjs";

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

test.beforeEach(() => {
  _resetConditionalSkills();
});

test("activateConditionalSkillsForPaths matches gitignore patterns", () => {
  registerProjectSkill({
    projectRoot: "/fake",
    name: "tone-checker",
    version: "1.0.0",
    type: "style",
    paths: ["chapters/poetry/**"],
    hooks: [],
  });
  const activated = activateConditionalSkillsForPaths(["chapters/poetry/c1.md"], "/fake");
  assert.ok(activated.includes("tone-checker"));
});

test("activateConditionalSkillsForPaths skips absolute paths", () => {
  registerProjectSkill({
    projectRoot: "/fake",
    name: "tone-checker",
    version: "1.0.0",
    type: "style",
    paths: ["chapters/**"],
    hooks: [],
  });
  const activated = activateConditionalSkillsForPaths(["/etc/passwd"], "/fake");
  assert.equal(activated.length, 0);
});

test("activateConditionalSkillsForPaths is idempotent", () => {
  registerProjectSkill({
    projectRoot: "/fake",
    name: "tone-checker",
    version: "1.0.0",
    type: "style",
    paths: ["chapters/**"],
    hooks: [],
  });
  const a1 = activateConditionalSkillsForPaths(["chapters/c1.md"], "/fake");
  const a2 = activateConditionalSkillsForPaths(["chapters/c2.md"], "/fake");
  assert.equal(a1.length, 1);
  assert.equal(a2.length, 0, "already activated, no new entries");
});
