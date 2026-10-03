import path from "node:path";
import { physicalPathKey } from "./fs-utils.mjs";

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

// 锁键用物理路径（2026-10-03，ADR 0009）：此前只 resolve+win32 小写，junction
// 别名与真实路径产生两把锁（同一物理项目并发持锁已复现）。HTTP 恢复/回滚路由
// 与 Agent 工具写锁共用本归一，键统一后互斥自动贯通。
function normalizeProjectKey(projectRoot) {
  return physicalPathKey(projectRoot);
}
