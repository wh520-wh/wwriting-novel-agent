import path from "node:path";

export function createProjectLockRegistry() {
  const tails = new Map();

  async function runExclusive(projectRoot, fn) {
    const key = normalizeProjectKey(projectRoot);
    const previous = tails.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    tails.set(key, previous.then(() => current, () => current));

    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (tails.get(key) === current) {
        tails.delete(key);
      }
    }
  }

  return { runExclusive };
}

function normalizeProjectKey(projectRoot) {
  const resolved = path.resolve(String(projectRoot ?? ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
