import assert from "node:assert/strict";
import test from "node:test";

import { createProjectScope } from "../../src/app-shell/project-scope.mjs";

test("responses from an older project generation are stale", () => {
  const scope = createProjectScope();
  const requestA = scope.capture("D:\\projects\\a");

  scope.activate("D:\\projects\\b");

  assert.equal(scope.isCurrent(requestA), false);
});

test("only the active project generation is current", () => {
  const scope = createProjectScope();
  scope.activate("D:\\projects\\a");
  const request = scope.capture("D:\\projects\\a");

  assert.equal(scope.isCurrent(request), true);
  assert.equal(scope.current().projectRoot, "D:\\projects\\a");
});