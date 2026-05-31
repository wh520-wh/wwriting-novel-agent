import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyLocalSecretsToEnv, loadLocalSecretsSync, saveLocalSecret } from "../src/core/local-secrets.mjs";

test("local secrets save API keys outside project settings and apply env", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-secrets-"));
  await saveLocalSecret(root, "XIAOMI_MIMO_API_KEY", "sk-local-secret");
  const file = JSON.parse(await fs.readFile(path.join(root, "secrets.json"), "utf8"));
  assert.equal(file.XIAOMI_MIMO_API_KEY, "sk-local-secret");
  const loaded = loadLocalSecretsSync(root);
  assert.equal(loaded.XIAOMI_MIMO_API_KEY, "sk-local-secret");
  delete process.env.XIAOMI_MIMO_API_KEY;
  applyLocalSecretsToEnv(loaded);
  assert.equal(process.env.XIAOMI_MIMO_API_KEY, "sk-local-secret");
});
