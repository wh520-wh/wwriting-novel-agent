import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProjectAt, loadState, saveState } from "../src/core/project-store.mjs";
import { assertBlueprintReady } from "../src/core/blueprint-guard.mjs";

function makeProjectRoot() {
  return mkdtempSync(join(tmpdir(), "bp-test-"));
}

test("新建项目默认 blueprint_status none，拒绝写作", async () => {
  const projectRoot = makeProjectRoot();
  await createProjectAt(projectRoot, { title: "T" });
  const state = await loadState(projectRoot);
  assert.equal(state.blueprint_status, "none");
  await assert.rejects(() => assertBlueprintReady(projectRoot), /完成.*init/u);
});

test("complete 状态允许写作", async () => {
  const projectRoot = makeProjectRoot();
  await createProjectAt(projectRoot, { title: "T" });
  const state = await loadState(projectRoot);
  state.blueprint_status = "complete";
  await saveState(projectRoot, state);
  await assert.doesNotReject(() => assertBlueprintReady(projectRoot));
});

test("legacy 状态允许写作", async () => {
  const projectRoot = makeProjectRoot();
  await createProjectAt(projectRoot, { title: "T" });
  const state = await loadState(projectRoot);
  state.blueprint_status = "legacy";
  await saveState(projectRoot, state);
  await assert.doesNotReject(() => assertBlueprintReady(projectRoot));
});
