// tests/core/app-model-gateway.test.mjs -- 第十一轮（审计 F）：成本累计器
// entry key 的平台归一。Windows 大小写不敏感文件系统上，同一项目的不同大小写
// 路径必须命中同一 entry（CostTracker 不分裂）；POSIX 大小写敏感不得归一。
import assert from "node:assert/strict";
import test from "node:test";

import { createAppModelGateway } from "../../src/core/app-server.mjs";

test("第十一轮 F：同一项目不同大小写路径共享 entry（win32）/保持区分（posix）", () => {
  const gateway = createAppModelGateway({
    resolveEffectiveConfig: async () => ({ active_model: null })
  });
  const a = process.platform === "win32" ? "C:\\Novel" : "/novel/alpha";
  const b = process.platform === "win32" ? "c:\\novel" : "/novel/beta";
  const entryA = gateway.gatewayFor(a);
  const entryB = gateway.gatewayFor(b);
  if (process.platform === "win32") {
    assert.equal(gateway.entriesMap.size, 1, "大小写变体必须命中同一 entry");
    assert.equal(entryA, entryB, "必须返回同一 gateway entry");
  } else {
    assert.equal(gateway.entriesMap.size, 2, "POSIX 上不同路径保持独立 entry");
  }
});
