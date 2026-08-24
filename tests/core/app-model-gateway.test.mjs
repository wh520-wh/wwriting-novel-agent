// tests/core/app-model-gateway.test.mjs -- 第十一轮（审计 F）：成本累计器
// entry key 的平台归一。Windows 大小写不敏感文件系统上，同一项目的不同大小写
// 路径必须命中同一 entry（CostTracker 不分裂）；POSIX 大小写敏感不得归一。
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

test("flushDirty：脏成本在 dashboard 读取前落盘（whfind-bugs #4）", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-gateway-flush-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const gateway = createAppModelGateway({
    resolveEffectiveConfig: async () => ({ active_model: null })
  });
  assert.equal(typeof gateway.flushDirty, "function");
  const entry = gateway.gatewayFor(projectRoot);
  // 无新增调用（lastWrittenCalls 门槛）时不写盘：cost.json 不得出现
  await gateway.flushDirty(projectRoot);
  await assert.rejects(fs.readFile(path.join(projectRoot, "cost.json")), "无脏不写");
  // 造脏 tracker（calls 1 > lastWrittenCalls 0）后冲刷，cost.json 应立即落盘
  entry.costTracker.record({
    stage: "test",
    usageReport: { provider: "test", model: "test-model", inputTokens: 10, outputTokens: 10 }
  });
  await gateway.flushDirty(projectRoot);
  const report = JSON.parse(await fs.readFile(path.join(projectRoot, "cost.json"), "utf8"));
  assert.ok(report.calls >= 1, "cost.json 已写回");
});
