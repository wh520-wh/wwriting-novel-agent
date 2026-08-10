// src/core/async-utils.mjs —— 通用异步原语（进程内），供各核心模块共享。
//
// createMutex：进程内异步互斥锁，串行化「读-改-写」临界区。原为 runtime.mjs /
// journal.mjs / session-registry.mjs 各自内联一份（逐字相同），统一抽到这里后
// 三处 import；新增模块直接复用，不再复制。
export function createMutex() {
  let tail = Promise.resolve();
  return {
    run(task) {
      const result = tail.then(() => task());
      tail = result.then(() => undefined, () => undefined);
      return result;
    }
  };
}
