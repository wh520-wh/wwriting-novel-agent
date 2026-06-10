import test from "node:test";
import assert from "node:assert/strict";
import { collectSkillPromptHooks, runSkillChecks } from "../src/core/skill-runtime.mjs";

const fakeSkills = [{
  name: "cached-skill",
  version: "1.0.0",
  type: "flow-control",
  enabled: true,
  priority: 10,
  hooks: [
    { stage: "planning", action: "append_prompt", content: "FROM-CACHE" },
    { stage: "reviewing", action: "check", check: "suspense-ending" }
  ]
}];

test("collectSkillPromptHooks 优先使用 context.skills，不碰磁盘", async () => {
  const result = await collectSkillPromptHooks("Z:/definitely-not-a-real-root", {}, "planning", { skills: fakeSkills });
  assert.ok(result.content.includes("FROM-CACHE"));
  assert.equal(result.hooks.length, 1);
});

test("runSkillChecks 同样接受 context.skills", async () => {
  const results = await runSkillChecks("Z:/definitely-not-a-real-root", {}, "reviewing", {
    skills: fakeSkills,
    content: "正文……结尾有一个巨大的悬念钩子！？"
  });
  assert.equal(results.length, 1);
});
