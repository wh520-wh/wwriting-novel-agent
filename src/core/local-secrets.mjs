import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureDir, readJson, writeJsonAtomic } from "./fs-utils.mjs";

const SECRET_FILE_NAME = "secrets.json";
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function defaultSecretsRoot() {
  return path.join(os.homedir(), ".wwriting");
}

export function loadLocalSecretsSync(secretsRoot = defaultSecretsRoot()) {
  const filePath = path.join(path.resolve(secretsRoot), SECRET_FILE_NAME);
  try {
    const data = JSON.parse(fsSync.readFileSync(filePath, "utf8"));
    return normalizeSecrets(data);
  } catch {
    return {};
  }
}

export async function loadLocalSecrets(secretsRoot = defaultSecretsRoot()) {
  const root = path.resolve(secretsRoot);
  const filePath = path.join(root, SECRET_FILE_NAME);
  const data = (await readJson(filePath, {})) ?? {};
  return normalizeSecrets(data);
}

export function applyLocalSecretsToEnv(secrets = {}) {
  for (const [name, value] of Object.entries(secrets)) {
    if (ENV_NAME.test(name) && typeof value === "string" && value.length > 0) {
      process.env[name] = value;
    }
  }
}

export async function saveLocalSecrets(secretsRoot, candidate) {
  const root = path.resolve(secretsRoot ?? defaultSecretsRoot());
  const secrets = normalizeSecrets(candidate);
  await ensureDir(root);
  const filePath = path.join(root, SECRET_FILE_NAME);
  await writeJsonAtomic(filePath, secrets);
  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    // Windows ACLs may not map cleanly to chmod; keep the secret out of project files either way.
  }
  return secrets;
}

function normalizeSecrets(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(([name, secret]) => ENV_NAME.test(name) && typeof secret === "string" && secret.length > 0)
  );
}
