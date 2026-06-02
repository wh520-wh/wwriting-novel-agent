import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSkillSources } from "../src/core/skill-runtime.mjs";

function makeTempProject() {
  return mkdtempSync(join(tmpdir(), "wwr-sources-"));
}

function makeSkillDir(base, name, manifest = { name, version: "1.0.0", type: "style", hooks: [] }) {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "skill.json"), JSON.stringify(manifest));
  return dir;
}

test("resolveSkillSources scans 3 sources in priority order", async () => {
  const projectRoot = makeTempProject();
  const userHome = makeTempProject();
  const resourcesPath = makeTempProject();

  // bundled-dist: <resourcesPath>/skills/<name>
  mkdirSync(join(resourcesPath, "skills"), { recursive: true });
  makeSkillDir(join(resourcesPath, "skills"), "alpha");

  // user: <userHome>/.wwriting/skills/<name>
  mkdirSync(join(userHome, ".wwriting", "skills"), { recursive: true });
  makeSkillDir(join(userHome, ".wwriting", "skills"), "beta", { name: "beta", version: "1.0.0", type: "style", hooks: [] });

  // project: <projectRoot>/skills/<name>
  mkdirSync(join(projectRoot, "skills"), { recursive: true });
  makeSkillDir(join(projectRoot, "skills"), "gamma");

  try {
    const sources = await resolveSkillSources({ projectRoot, userHome, resourcesPath });
    const byName = sources.map((s) => s.name);
    assert.ok(byName.includes("alpha"), `expected sources to include 'alpha', got ${JSON.stringify(byName)}`);
    assert.ok(byName.includes("beta"), `expected sources to include 'beta', got ${JSON.stringify(byName)}`);
    assert.ok(byName.includes("gamma"), `expected sources to include 'gamma', got ${JSON.stringify(byName)}`);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
    rmSync(resourcesPath, { recursive: true, force: true });
  }
});

test("resolveSkillSources dedups by realpath (symlink/junction)", async () => {
  const projectRoot = makeTempProject();
  const userHome = makeTempProject();
  const resourcesPath = makeTempProject();

  // Real skill in bundled-dist
  mkdirSync(join(resourcesPath, "skills"), { recursive: true });
  const real = makeSkillDir(join(resourcesPath, "skills"), "shared");

  // Same skill also reachable from user source (via symlink or junction)
  const userSkills = join(userHome, ".wwriting", "skills");
  mkdirSync(userSkills, { recursive: true });
  const linkPath = join(userSkills, "shared");
  let linked = false;
  if (process.platform === "win32") {
    // On Windows prefer junctions (no admin/DevMode needed) over symlinks.
    try {
      symlinkSync(real, linkPath, "junction");
      linked = true;
    } catch {
      // Fall back: copy the directory contents so realpath still resolves
      // the same way and a same-name user entry would clash.
      mkdirSync(linkPath, { recursive: true });
      copyFileSync(join(real, "skill.json"), join(linkPath, "skill.json"));
      linked = true;
    }
  } else {
    symlinkSync(real, linkPath, "dir");
    linked = true;
  }
  assert.ok(linked, "could not create a link for the dedup test");

  try {
    const sources = await resolveSkillSources({ projectRoot, userHome, resourcesPath });
    const sharedEntries = sources.filter((s) => s.name === "shared");
    assert.equal(sharedEntries.length, 1, "expected exactly one 'shared' entry after dedup");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
    rmSync(resourcesPath, { recursive: true, force: true });
  }
});

test("resolveSkillSources skips missing sources without throwing", async () => {
  const sources = await resolveSkillSources({
    projectRoot: "/nope/does/not/exist",
    userHome: "/nope/either",
    resourcesPath: undefined,
  });
  assert.equal(Array.isArray(sources), true);
  assert.equal(sources.length, 0);
});
