// src/core/model/model-identity.mjs —— 模型 ID 尾标解析器（统一 Journal/上下文
// 窗口/自动压缩计划 Task 2）。
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
