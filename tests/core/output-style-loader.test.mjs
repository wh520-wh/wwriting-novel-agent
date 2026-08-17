import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOutputStyles } from "../../src/core/output-style-loader.mjs";

test("loadOutputStyles bundled 不含 review 风格", async () => {
  const styles = await loadOutputStyles({});
  const names = styles.map((s) => s.name);
  assert.ok(names.includes("creative"));
  assert.ok(!names.includes("review"), "Task 10：bundled 不得再包含 review 风格（改名保留同一模式也禁止）");
  const bundledReview = styles.find((s) => s.source === "bundled" && /审稿|review/u.test(`${s.name} ${s.description}`));
  assert.equal(bundledReview, undefined, "bundled 不得以任何名称保留审稿模式");
});

test("loadOutputStyles loads user-level .md files", async () => {
  const userHome = mkdtempSync(join(tmpdir(), "wwr-style-"));
  const stylesDir = join(userHome, ".wwriting", "output-styles");
  mkdirSync(stylesDir, { recursive: true });
  writeFileSync(
    join(stylesDir, "custom.md"),
    `---
name: Custom Style
description: My custom writing style
---
This is the body of the custom style prompt.`
  );

  try {
    const styles = await loadOutputStyles({ userHome });
    const custom = styles.find((s) => s.name === "Custom Style");
    assert.ok(custom);
    assert.equal(custom.source, "user");
    assert.ok(custom.body.includes("custom style prompt"));
  } finally {
    rmSync(userHome, { recursive: true, force: true });
  }
});

test("loadOutputStyles loads project-level .md files", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "wwr-proj-"));
  const stylesDir = join(projectRoot, ".wwriting", "output-styles");
  mkdirSync(stylesDir, { recursive: true });
  writeFileSync(
    join(stylesDir, "project-style.md"),
    `---
name: Project Style
description: Project-specific
---
Project body.`
  );

  try {
    const styles = await loadOutputStyles({ projectRoot });
    const ps = styles.find((s) => s.name === "Project Style");
    assert.ok(ps);
    assert.equal(ps.source, "project");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("loadOutputStyles skips .md files without name frontmatter", async () => {
  const userHome = mkdtempSync(join(tmpdir(), "wwr-style-"));
  const stylesDir = join(userHome, ".wwriting", "output-styles");
  mkdirSync(stylesDir, { recursive: true });
  writeFileSync(
    join(stylesDir, "no-name.md"),
    `---
description: missing name
---
body`
  );

  try {
    const styles = await loadOutputStyles({ userHome });
    const noName = styles.find((s) => s.source === "user");
    assert.equal(noName, undefined);
  } finally {
    rmSync(userHome, { recursive: true, force: true });
  }
});

test("loadOutputStyles returns fresh array per call (no stale cross-project state)", async () => {
  const a = await loadOutputStyles({ projectRoot: "/proj-a" });
  const b = await loadOutputStyles({ projectRoot: "/proj-b" });
  assert.notEqual(a, b);
  // Bundled names present in both
  for (const arr of [a, b]) {
    assert.ok(arr.some((s) => s.name === "creative"));
  }
});
