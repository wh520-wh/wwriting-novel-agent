import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOutputStyles } from "../src/core/output-style-loader.mjs";

test("loadOutputStyles returns at least 2 bundled styles", async () => {
  const styles = await loadOutputStyles({});
  assert.ok(styles.length >= 2);
  const names = styles.map((s) => s.name);
  assert.ok(names.includes("creative"));
  assert.ok(names.includes("review"));
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
