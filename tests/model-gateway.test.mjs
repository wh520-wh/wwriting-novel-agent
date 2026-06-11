import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CacheKeyManager, writeCacheReport } from "../src/core/cache-key-manager.mjs";
import { ModelClient } from "../src/core/model-client.mjs";
import { MockProviderAdapter } from "../src/core/provider-adapters.mjs";
import { PromptCompiler } from "../src/core/prompt-compiler.mjs";
import { normalizeUsageReport } from "../src/core/usage-report.mjs";

test("PromptCompiler keeps stable blocks before dynamic blocks", () => {
  const compiler = new PromptCompiler({ templateVersion: "drafting.v1" });
  const compiled = compiler.compile({
    stableBlocks: {
      style: "tight prose",
      system_rules: "write through tools",
      goal: "finish chapter"
    },
    dynamicBlocks: {
      recent_trace_summary: "segment 1 written",
      current_task: "write segment 2"
    }
  });
  assert.deepEqual(compiled.blocks.map((block) => block.name), [
    "system_rules",
    "goal",
    "style",
    "current_task",
    "recent_trace_summary"
  ]);
  assert.ok(compiled.prompt.indexOf("[Stable Block] style") < compiled.prompt.indexOf("[Dynamic Block] current_task"));
});

test("CacheKeyManager version only changes when stable prompt hash changes", () => {
  const compiler = new PromptCompiler({ templateVersion: "drafting.v1" });
  const first = compiler.compile({
    stableBlocks: { system_rules: "A", goal: "B" },
    dynamicBlocks: { current_task: "write scene 1" }
  });
  const second = compiler.compile({
    stableBlocks: { system_rules: "A", goal: "B" },
    dynamicBlocks: { current_task: "write scene 2" }
  });
  const third = compiler.compile({
    stableBlocks: { system_rules: "A changed", goal: "B" },
    dynamicBlocks: { current_task: "write scene 2" }
  });
  const manager = new CacheKeyManager();
  const firstKey = manager.update({ projectId: "p1", templateVersion: "drafting.v1", stableHash: first.stableHash });
  const secondKey = manager.update({ projectId: "p1", templateVersion: "drafting.v1", stableHash: second.stableHash });
  const thirdKey = manager.update({ projectId: "p1", templateVersion: "drafting.v1", stableHash: third.stableHash });
  assert.equal(first.stableHash, second.stableHash);
  assert.equal(firstKey.cacheVersion, 1);
  assert.equal(secondKey.cacheVersion, 1);
  assert.equal(thirdKey.cacheVersion, 2);
});

test("ModelClient defaults every stage to active model unless override is explicitly enabled", async () => {
  const client = new ModelClient({
    adapters: {
      mock: new MockProviderAdapter({
        response: "ok",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15
        }
      }),
      other: new MockProviderAdapter({ response: "override" })
    }
  });
  const project = {
    active_model: {
      provider: "mock",
      model_name: "active-writer"
    },
    stage_overrides: {
      reviewing: {
        enabled: false,
        provider: "other",
        model_name: "reviewer"
      },
      outline: {
        enabled: true,
        provider: "other",
        model_name: "outline-model"
      }
    }
  };
  assert.equal(client.resolveModelConfig(project, "reviewing").model_name, "active-writer");
  assert.equal(client.resolveModelConfig(project, "outline").model_name, "outline-model");
  const result = await client.generate({ project, stage: "drafting", prompt: "hello" });
  assert.equal(result.text, "ok");
  assert.equal(result.modelConfig.model_name, "active-writer");
  assert.equal(result.usageReport.cacheMetricsAvailable, false);
  assert.equal(result.usageReport.cacheHitRate, null);
});

test("ModelClient forwards AbortSignal to provider adapters", async () => {
  const controller = new AbortController();
  let captured = null;
  const client = new ModelClient({
    adapters: {
      mock: {
        async generate(request) {
          captured = request;
          return {
            text: "ok",
            raw: {},
            usage: {}
          };
        }
      }
    }
  });

  await client.generate({
    project: {
      active_model: {
        provider: "mock",
        model_name: "signal-aware"
      }
    },
    prompt: "hello",
    signal: controller.signal
  });

  // After retry implementation, ModelClient wraps signal via AbortSignal.any()
  // so the adapter receives a combined signal, not the original reference.
  assert.ok(captured.signal instanceof AbortSignal, "adapter should receive an AbortSignal");
  assert.ok(!captured.signal.aborted, "signal should not be aborted");
});

test("ModelClient resolves effective config before selecting a model", () => {
  const client = new ModelClient({
    activeModel: {
      provider: "mock",
      model_name: "constructor-writer"
    }
  });
  const modelConfig = client.resolveModelConfig(
    {
      active_model: {
        provider: "mock",
        model_name: "project-writer"
      },
      local_config: {
        active_model: {
          provider: "mock",
          model_name: "local-writer"
        }
      }
    },
    "drafting"
  );
  assert.equal(modelConfig.model_name, "local-writer");
  assert.equal(modelConfig.stage_override_enabled, false);
});

test("normalizeUsageReport never invents cache metrics when provider omits them", () => {
  const report = normalizeUsageReport({
    provider: "mock",
    model: "plain",
    usage: {
      input_tokens: 100,
      output_tokens: 25,
      total_tokens: 125
    }
  });
  assert.equal(report.cacheMetricsAvailable, false);
  assert.equal(report.cacheHitRate, null);
});

test("normalizeUsageReport 只有 cached_tokens（MiMo/OpenAI 风格）时 cacheHitTokens 回退到 cachedTokens", () => {
  const report = normalizeUsageReport({
    provider: "openai-compatible",
    model: "mimo-v2.5-pro",
    usage: {
      prompt_tokens: 5750,
      completion_tokens: 2100,
      total_tokens: 7850,
      cached_tokens: 4096
    }
  });
  assert.equal(report.cachedTokens, 4096);
  assert.equal(report.cacheHitTokens, 4096);
  assert.equal(report.cacheMetricsAvailable, true);
  assert.ok(Math.abs(report.cacheHitRate - 4096 / 5750) < 1e-9);
});

test("normalizeUsageReport 同时有显式命中字段时优先于 cached_tokens", () => {
  const report = normalizeUsageReport({
    provider: "openai-compatible",
    model: "deepseek-v4-pro",
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 100,
      total_tokens: 1100,
      cached_tokens: 512,
      prompt_cache_hit_tokens: 640
    }
  });
  assert.equal(report.cacheHitTokens, 640);
  assert.equal(report.cachedTokens, 512);
});

test("writeCacheReport preserves promptBlockHashes and adds structured promptBlocks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-cache-report-"));
  const compiler = new PromptCompiler({ templateVersion: "drafting.v1" });
  const compiled = compiler.compile({
    stableBlocks: { system_rules: "A", goal: "B" },
    dynamicBlocks: { current_task: "write scene" }
  });
  const manager = new CacheKeyManager();
  const entry = manager.update({ projectId: "p1", templateVersion: "drafting.v1", stableHash: compiled.stableHash });
  const report = await writeCacheReport(root, {
    manager,
    cacheEntry: entry,
    compiledPrompt: compiled,
    usageReport: { cacheMetricsAvailable: false, cacheHitRate: null, cachedTokens: 0, cacheHitTokens: 0 },
    modelConfig: { provider: "mock", model_name: "mock-writer" }
  });

  assert.equal(typeof report.last_call.promptBlockHashes.system_rules, "string");
  assert.ok(report.last_call.promptBlocks.some((block) => block.name === "system_rules" && block.kind === "stable"));
  assert.ok(report.last_call.promptBlocks.some((block) => block.name === "current_task" && block.kind === "dynamic"));
});

test("CacheKeyManager reports stable change reasons", () => {
  const manager = new CacheKeyManager();
  const first = manager.update({ projectId: "p1", templateVersion: "drafting.v1", stableHash: "sha256:first" });
  const second = manager.update({ projectId: "p1", templateVersion: "drafting.v1", stableHash: "sha256:first" });
  const third = manager.update({ projectId: "p1", templateVersion: "drafting.v1", stableHash: "sha256:second" });

  assert.equal(first.stableChanged, false);
  assert.equal(first.stableChangedReason, "first_call");
  assert.equal(second.stableChanged, false);
  assert.equal(second.stableChangedReason, null);
  assert.equal(third.stableChanged, true);
  assert.equal(third.stableChangedReason, "stable_hash_changed");
  assert.equal(third.previousStableHash, "sha256:first");
});
