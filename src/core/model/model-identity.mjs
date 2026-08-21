// src/core/model/model-identity.mjs —— 模型 ID 尾标解析器（统一 Journal/上下文
// 窗口/自动压缩计划 Task 2）。
// 第十三轮（ADR 0004）起窗口唯一权威是 context_window 字段，尾标机制淘汰中（Task 6 删 parseModelIdentity）。
//
// 唯一权威：设置/选择器保存作者的原始显示字符串（可带尾部 [tag] 标记，如
// vendor/model[1m][foo]）；provider 请求与能力决策只用剥离后的基础 ID，有效
// 上下文窗口由尾标决定（[1m]/[1M] → 1M，缺省 256k）。基础 ID 中间允许出现
// 中括号（如 mo[del]name），只有「尾部连续 [..]」才被剥离。

export const DEFAULT_CONTEXT_WINDOW = 256_000;
export const MILLION_CONTEXT_WINDOW = 1_000_000;
export const DEFAULT_COMPACTION_THRESHOLD = 204_800;
export const MILLION_COMPACTION_THRESHOLD = 967_000;

export function parseModelIdentity(value) {
  const configured = String(value ?? "");
  const tags = [];
  let provider = configured;
  for (;;) {
    const match = provider.match(/\[([^\[\]]*)\]$/u);
    if (!match) break;
    tags.unshift(match[1]);
    provider = provider.slice(0, -match[0].length);
  }
  const million = tags.some((tag) => tag === "1m" || tag === "1M");
  return {
    configured_model_id: configured,
    provider_model_id: provider,
    trailing_tags: tags,
    window_source: million ? "model_id_1m" : "default_256k",
    effective_context_window: million ? MILLION_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW,
    compaction_threshold: million ? MILLION_COMPACTION_THRESHOLD : DEFAULT_COMPACTION_THRESHOLD
  };
}

// -- 第十三轮（ADR 0004）：窗口/输出唯一解析点。标识符只是标识符，配置归字段。 --
export const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;
export const COMPACTION_THRESHOLD_RATIO = 0.8;

function positiveIntValue(v) { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; }

// 压缩阈值 = 窗口八成。256k 档 204,800 与旧两档硬编码同值；1M 档由 967,000
// 提前到 800,000（超长上下文后半段性能明显下降，宁可早触发--用户拍板，D2）。
export function compactionThresholdOf(window) {
  return Math.floor(window * COMPACTION_THRESHOLD_RATIO);
}

// 字段缺省/非法一律回缺省（256k / 64k）。window_source：configured = 显式配置，
// default_256k = 未配置时的产品缺省。
export function resolveModelLimits({ context_window: contextWindow, max_output_tokens: maxOutputTokens } = {}) {
  const window = positiveIntValue(contextWindow);
  const output = positiveIntValue(maxOutputTokens);
  const effectiveWindow = window ?? DEFAULT_CONTEXT_WINDOW;
  return {
    effective_context_window: effectiveWindow,
    effective_max_output_tokens: output ?? DEFAULT_MAX_OUTPUT_TOKENS,
    compaction_threshold: compactionThresholdOf(effectiveWindow),
    window_source: window != null ? "configured" : "default_256k"
  };
}
