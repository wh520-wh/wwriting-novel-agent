// 能力矩阵测试（统一 Agent 内核计划 Task 3）。
//
// 从旧 tests/provider-adapters.test.mjs 迁移能力判定 case：
// resolveModelCapabilities / registerProviderCapabilityResolver /
// writingRequiredCapabilitiesOk。只测 provider/model 能力，不含业务规则。
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CAPABILITIES,
  registerProviderCapabilityResolver,
  resolveModelCapabilities,
  writingRequiredCapabilitiesOk
} from "../../src/core/model/capabilities.mjs";

test("resolveModelCapabilities: deepseek-v4-pro 标记 supportsThinking 且不支持 temperature", () => {
  const caps = resolveModelCapabilities({
    base_url: "https://api.deepseek.com/v1",
    model_name: "deepseek-v4-pro"
  });
  assert.equal(caps.supportsThinking, true);
  assert.equal(caps.requiresAutoToolChoice, true);
  assert.equal(caps.supportsTemperature, false);
  assert.equal(caps.supportsTopP, false);
  assert.equal(caps.supportsJsonOutput, true);
  assert.equal(caps.supportsTools, true);
  assert.equal(caps.supportsStreaming, true);
});

test("resolveModelCapabilities: deepseek-v4-flash 默认非思考，不支持 temperature(官方按 thinking 处理)，需 auto tool_choice", () => {
  const caps = resolveModelCapabilities({
    base_url: "https://api.deepseek.com/v1",
    model_name: "deepseek-v4-flash"
  });
  assert.equal(caps.supportsThinking, false);
  assert.equal(caps.requiresAutoToolChoice, true);
  assert.equal(caps.supportsTemperature, false);
  assert.equal(caps.supportsTopP, false);
});

test("resolveModelCapabilities: deepseek-reasoner 兼容旧名单", () => {
  const caps = resolveModelCapabilities({
    base_url: "https://api.deepseek.com/v1",
    model_name: "deepseek-reasoner"
  });
  assert.equal(caps.supportsThinking, true);
  assert.equal(caps.requiresAutoToolChoice, true);
  assert.equal(caps.supportsTemperature, false);
});

test("resolveModelCapabilities: 非 deepseek 模型默认全支持", () => {
  const caps = resolveModelCapabilities({
    base_url: "https://api.openai.com/v1",
    model_name: "gpt-4o"
  });
  assert.deepEqual(caps, DEFAULT_CAPABILITIES);
  assert.equal(caps.supportsThinking, false);
  assert.equal(caps.requiresAutoToolChoice, false);
  assert.equal(caps.supportsTemperature, true);
  assert.equal(caps.supportsJsonOutput, true);
  assert.equal(caps.supportsTools, true);
  assert.equal(caps.supportsStreaming, true);
});

test("未匹配任何注册 resolver 的供应商回落默认全能力开放", () => {
  const caps = resolveModelCapabilities({ base_url: "https://api.totally-unknown.com/v1", model_name: "x" });
  assert.equal(caps.supportsThinking, false);
  assert.equal(caps.supportsTemperature, true);
  assert.equal(caps.supportsTools, true);
});

test("registerProviderCapabilityResolver 支持后续供应商注册自己的能力判据", () => {
  registerProviderCapabilityResolver(
    (modelConfig) => String(modelConfig.base_url ?? "").includes("api.example-vendor.com"),
    (modelConfig) => ({
      supportsThinking: true,
      requiresAutoToolChoice: true,
      supportsTemperature: false,
      supportsTopP: false,
      supportsJsonOutput: true,
      supportsTools: true,
      supportsStreaming: false
    })
  );
  const caps = resolveModelCapabilities({ base_url: "https://api.example-vendor.com/v1", model_name: "example-thinking-1" });
  assert.equal(caps.supportsThinking, true);
  assert.equal(caps.supportsStreaming, false);
  assert.equal(caps.supportsTemperature, false);
});

test("registerProviderCapabilityResolver 拒绝非函数参数", () => {
  assert.throws(
    () => registerProviderCapabilityResolver("matcher", () => ({})),
    TypeError
  );
  assert.throws(
    () => registerProviderCapabilityResolver(() => false, null),
    TypeError
  );
});

test("writingRequiredCapabilitiesOk: 工具与流式齐备时通过", () => {
  assert.equal(
    writingRequiredCapabilitiesOk({ base_url: "https://api.deepseek.com/v1", model_name: "deepseek-v4-pro" }),
    true
  );
  assert.equal(
    writingRequiredCapabilitiesOk({ base_url: "https://api.openai.com/v1", model_name: "gpt-4o" }),
    true
  );
});

test("writingRequiredCapabilitiesOk: 缺失工具或流式时拒绝", () => {
  // 注册一个无工具、无流式的供应商
  registerProviderCapabilityResolver(
    (modelConfig) => String(modelConfig.base_url ?? "").includes("api.no-tools.com"),
    () => ({
      supportsThinking: false,
      requiresAutoToolChoice: false,
      supportsTemperature: true,
      supportsTopP: true,
      supportsJsonOutput: true,
      supportsTools: false,
      supportsStreaming: true
    })
  );
  assert.equal(
    writingRequiredCapabilitiesOk({ base_url: "https://api.no-tools.com/v1", model_name: "no-tools" }),
    false,
    "supportsTools=false 应拒绝"
  );
  registerProviderCapabilityResolver(
    (modelConfig) => String(modelConfig.base_url ?? "").includes("api.no-stream.com"),
    () => ({
      supportsThinking: false,
      requiresAutoToolChoice: false,
      supportsTemperature: true,
      supportsTopP: true,
      supportsJsonOutput: true,
      supportsTools: true,
      supportsStreaming: false
    })
  );
  assert.equal(
    writingRequiredCapabilitiesOk({ base_url: "https://api.no-stream.com/v1", model_name: "no-stream" }),
    false,
    "supportsStreaming=false 应拒绝"
  );
});

test("resolveModelCapabilities 对缺省 modelConfig 回落默认", () => {
  const caps = resolveModelCapabilities();
  assert.deepEqual(caps, DEFAULT_CAPABILITIES);
});

test("resolveModelCapabilities: DeepSeek thinking 模型声明 reasoningEffortLevels 低/中/高", () => {
  const caps = resolveModelCapabilities({
    base_url: "https://api.deepseek.com/v1",
    model_name: "deepseek-v4-pro"
  });
  assert.deepEqual(caps.reasoningEffortLevels, ["low", "medium", "high"]);
  const reasoner = resolveModelCapabilities({
    base_url: "https://api.deepseek.com/v1",
    model_name: "deepseek-reasoner"
  });
  assert.deepEqual(reasoner.reasoningEffortLevels, ["low", "medium", "high"]);
});

test("resolveModelCapabilities: v4-flash 与非 DeepSeek 模型不声明 reasoningEffortLevels", () => {
  const flash = resolveModelCapabilities({
    base_url: "https://api.deepseek.com/v1",
    model_name: "deepseek-v4-flash"
  });
  assert.equal("reasoningEffortLevels" in flash, false);
  const mimo = resolveModelCapabilities({
    base_url: "https://api.mimo.example.test/v1",
    model_name: "mimo-v2.5"
  });
  assert.equal("reasoningEffortLevels" in mimo, false);
});
