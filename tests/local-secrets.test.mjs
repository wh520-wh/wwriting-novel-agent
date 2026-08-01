import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyLocalSecretsToEnv, loadLocalSecretsSync } from "../src/core/local-secrets.mjs";

test("local secrets load API keys outside project settings and apply env", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-secrets-"));
  await fs.writeFile(path.join(root, "secrets.json"), JSON.stringify({ XIAOMI_MIMO_API_KEY: "sk-local-secret" }));
  const loaded = loadLocalSecretsSync(root);
  assert.equal(loaded.XIAOMI_MIMO_API_KEY, "sk-local-secret");
  delete process.env.XIAOMI_MIMO_API_KEY;
  applyLocalSecretsToEnv(loaded);
  assert.equal(process.env.XIAOMI_MIMO_API_KEY, "sk-local-secret");
});
