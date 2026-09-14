// src/core/model/model-identity.mjs -- 窗口/输出唯一解析点（第十三轮 ADR 0004）。
//
// 唯一权威：模型记录的 context_window / max_output_tokens 字段（缺省 256k / 64k）。
// model_name 只是标识符：用户填什么就原样发给提供方，不承载任何配置语义。
// 历史上的 [1m] 尾标机制已在 store 规范化中一次性迁移淘汰（model-provider-store.mjs
// normalizeModel），本模块不再有尾标解析。

export const DEFAULT_CONTEXT_WINDOW = 256_000;
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
