import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runProject } from "../src/core/agent-engine.mjs";
import { readEvents } from "../src/core/event-log.mjs";
import { createProject } from "../src/core/project-store.mjs";
import { MockModel } from "../src/core/mock-model.mjs";
import { MockProviderAdapter } from "../src/core/provider-adapters.mjs";

// DeepSeek 风格 usage：显式给出 prompt_cache_hit_tokens（与 prompt_cache_miss_tokens 之和 = prompt_tokens）
const DEEPSEEK_USAGE = {
  prompt_tokens: 5750,
  completion_tokens: 2100,
  total_tokens: 7850,
  prompt_cache_hit_tokens: 4096,
  prompt_cache_miss_tokens: 1654
};

// 端到端注入点：options.adapters 覆盖默认 mock adapter（agent-engine 的 createModelRuntime
// 会 { ...defaultAdapters, ...options.adapters }），响应内容委托给真实 MockModel，
// 只把 usage 换成 DeepSeek 风格——完整链路（ModelClient 网关 → normalizeUsageReport →
// costTracker → writeCacheReport）都走真实代码。
function deepseekMockAdapter() {
  const model = new MockModel();
  return new MockProviderAdapter({
    response: async (gatewayRequest) => {
      const toolRequest = gatewayRequest.metadata?.toolRequest ?? {};
      const output = await model.generate(toolRequest);
      return {
        text: JSON.stringify(output),
        raw: { output },
        usage: DEEPSEEK_USAGE
      };
    }
  });
}

async function runTinyProject(adapters) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-usage-e2e-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 200,
    target_words_per_chapter: 260
  });
  await runProject(projectRoot, adapters ? { adapters } : {});
  return projectRoot;
}

test("端到端：DeepSeek 风格 usage（prompt_cache_hit_tokens）解析进 usageReport 与 cache_report.json", async () => {
  const projectRoot = await runTinyProject({ mock: deepseekMockAdapter() });

  // 最终 usageReport：runModelGatewayCall 把 gatewayResult.usageReport 原样写入
  // run_log.jsonl 的 model_usage_recorded 事件，取最后一次调用断言
  const events = await readEvents(projectRoot);
  const usageEvent = [...events].reverse().find((e) => e.type === "model_usage_recorded");
  assert.ok(usageEvent, "应存在 model_usage_recorded 事件");
  const finalUsageReport = usageEvent.data.usage_report;
  assert.equal(finalUsageReport.cacheHitTokens, 4096);
  assert.ok(finalUsageReport.cacheHitTokens > 0, "cacheHitTokens 应为非零");

  // writeCacheReport 产物：cache_report.json 的 last_call 记录命中率
  const cacheReport = JSON.parse(
    await fs.readFile(path.join(projectRoot, "cache_report.json"), "utf8")
  );
  assert.equal(cacheReport.last_call.cacheMetricsAvailable, true);
  assert.equal(cacheReport.last_call.cacheHitTokens, 4096);
  assert.ok(cacheReport.last_call.cacheHitRate > 0, "cacheHitRate 应为非零");
  assert.ok(Math.abs(cacheReport.last_call.cacheHitRate - 4096 / 5750) < 1e-9);
});

test("对照：usage 无缓存字段时链路不凭空写出 cacheHitRate", async () => {
  // 默认 mock adapter 走 estimateMockUsage（无 cache 字段），验证正例的数字来自
  // prompt_cache_hit_tokens 本身，而不是链路的臆造
  const projectRoot = await runTinyProject();
  const cacheReport = JSON.parse(
    await fs.readFile(path.join(projectRoot, "cache_report.json"), "utf8")
  );
  assert.equal(cacheReport.last_call.cacheMetricsAvailable, false);
  assert.equal(cacheReport.last_call.cacheHitRate, null);
  assert.equal(cacheReport.last_call.cacheHitTokens, 0);
});
