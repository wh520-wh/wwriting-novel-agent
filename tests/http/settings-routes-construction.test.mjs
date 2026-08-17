import assert from "node:assert/strict";
import test from "node:test";
import { createSettingsRoutes } from "../../src/core/http/settings-routes.mjs";

test("createSettingsRoutes 缺少 workspaceStore 时在构造期失败", () => {
  assert.throws(
    () => createSettingsRoutes({ secretsRoot: "C:\\wwriting-test-secrets" }),
    /workspaceStore/u
  );
});
