import path from "node:path";

// B10：registry 存储「派生 tail Promise」本身（previous.then(() => current)），
// settle 后按 tail 身份删除——若比较 current（裸 promise）永远不相等，尾条目
// 会随任务数量无限泄漏。onTailRemoved 是构造函数注入的测试 seam（不向返回的
// registry 暴露任何生产诊断 API），生产路径默认不传。
export function createProjectLockRegistry(options = {}) {
  const tails = new Map();
  const onTailRemoved = typeof options?.onTailRemoved === "function" ? options.onTailRemoved : null;

  async function runExclusive(projectRoot, fn) {
    const key = normalizeProjectKey(projectRoot);
    const previous = tails.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current, () => current);
    tails.set(key, tail);

    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (tails.get(key) === tail) {
        tails.delete(key);
        if (onTailRemoved) onTailRemoved(key);
      }
    }
  }

  return { runExclusive };
}

function normalizeProjectKey(projectRoot) {
  const resolved = path.resolve(String(projectRoot ?? ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
