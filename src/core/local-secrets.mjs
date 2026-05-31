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

export function applyLocalSecretsToEnv(secrets = {}) {
  for (const [name, value] of Object.entries(secrets)) {
    if (ENV_NAME.test(name) && typeof value === "string" && value.length > 0) {
      process.env[name] = value;
    }
  }
}

export async function saveLocalSecret(secretsRoot, name, value) {
  const envName = assertEnvName(name);
  const secret = assertSecretValue(value);
  const root = path.resolve(secretsRoot ?? defaultSecretsRoot());
  await ensureDir(root);
  const filePath = path.join(root, SECRET_FILE_NAME);
  const secrets = normalizeSecrets((await readJson(filePath, {})) ?? {});
  secrets[envName] = secret;
  await writeJsonAtomic(filePath, secrets);
  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    // Windows ACLs may not map cleanly to chmod; keep the secret out of project files either way.
  }
  process.env[envName] = secret;
  return { envName };
}

function normalizeSecrets(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(([name, secret]) => ENV_NAME.test(name) && typeof secret === "string" && secret.length > 0)
  );
}

function assertEnvName(name) {
  if (typeof name !== "string" || !ENV_NAME.test(name)) {
    throw new Error("密钥保存失败：环境变量名无效。");
  }
  return name;
}

function assertSecretValue(value) {
  if (typeof value !== "string" || value.trim().length < 8 || value.length > 20_000) {
    throw new Error("请输入有效的 API Key。");
  }
  return value.trim();
}
