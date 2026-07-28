import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT_THEME_KEYS,
  deriveProjectIdentity,
} from "../../src/app-shell/project-identity.mjs";

const clockShop = {
  projectRoot: "D:\\novels\\clock-shop",
  project: {
    title: "星尘的低语",
    story_seed: "一个钟表匠在午夜发现时间可以倒流。",
  },
};

test("deriveProjectIdentity 对同一项目稳定返回同一主题与字标", () => {
  const first = deriveProjectIdentity(clockShop);
  const second = deriveProjectIdentity({ ...clockShop, project: { ...clockShop.project } });

  assert.deepEqual(first, second);
  assert.equal(first.monogram, "星");
  assert.equal(first.title, "星尘的低语");
  assert.ok(PROJECT_THEME_KEYS.includes(first.theme));
  assert.match(first.ariaLabel, /星尘的低语/u);
});

test("deriveProjectIdentity 将标题、种子和路径共同作为稳定输入", () => {
  const first = deriveProjectIdentity(clockShop);
  const byRoot = deriveProjectIdentity({ ...clockShop, projectRoot: "D:\\novels\\another-clock-shop" });
  const bySeed = deriveProjectIdentity({
    ...clockShop,
    project: { ...clockShop.project, story_seed: "另一部完全不同的故事。" },
  });

  assert.notEqual(first.seed, byRoot.seed);
  assert.notEqual(first.seed, bySeed.seed);
});

test("deriveProjectIdentity 在缺失标题或项目资料时给出安全回退", () => {
  assert.deepEqual(deriveProjectIdentity({}), {
    theme: PROJECT_THEME_KEYS[0],
    monogram: "W",
    title: "未命名小说",
    ariaLabel: "未命名小说的作品封面",
    seed: 0,
  });

  const whitespace = deriveProjectIdentity({ project: { title: "   " }, projectRoot: "D:\\novels\\draft" });
  assert.equal(whitespace.monogram, "W");
  assert.equal(whitespace.title, "未命名小说");
  assert.ok(PROJECT_THEME_KEYS.includes(whitespace.theme));
});
