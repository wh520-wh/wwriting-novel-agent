// 每模型的上下文窗口与输出上限。
//
// 为什么需要它：① 用户要求 max_tokens「给足空间」——取模型的最大输出上限，而不是让服务端
// 用一个随时会漂移的默认值；② 上下文窗口是将来做历史预算/自动压缩时要读的事实，
// 现在先集中记一处，避免各处各写一个魔数。
//
// **不实测**（2026-09-29 用户决定，取代原计划的一次性探针）：取值来自 DeepSeek 官方 API 文档
// 与用户拍板，写死在表里。判据仍是「（端点, 模型名）二元组」——网关下的同名模型一律走保守回落，
// 因为转发/改名的端点上这些数字未必成立。
//
// 参考 grokbuild 的采样配置：它的 SamplingConfig 同时带 context_window 与
// max_completion_tokens，请求时把后者发给 max_output_tokens。这里沿用同一分工。
import { DEFAULT_BASE_URL, normalizeBaseUrl } from './config.mjs';

// 官方端点 DeepSeek 模型：1,000,000 上下文（用户：DeepSeek 模型都是 1M 上下文）。
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;
// 官方端点非最新模型的输出上限：64K（不确定时的保守值）。
export const DEFAULT_MAX_OUTPUT_TOKENS = 65_536;
// 非官方端点 / 未知模型：256K 上下文 + 64K 输出（用户：「其余暂时没把握就 256k + 64k」）。
export const FALLBACK_CONTEXT_WINDOW = 262_144;
export const FALLBACK_MAX_OUTPUT_TOKENS = 65_536;

// 官方端点内置表。default 给官方端点里没被单独列出的模型。
export const OFFICIAL_MODEL_LIMITS = Object.freeze({
  'deepseek-v4-pro': Object.freeze({ contextWindow: 1_000_000, maxOutputTokens: 393_216 }),
  'deepseek-flash': Object.freeze({ contextWindow: 1_000_000, maxOutputTokens: 393_216 }),
  default: Object.freeze({ contextWindow: DEFAULT_CONTEXT_WINDOW, maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS }),
});

// 解析一个（端点, 模型）的实际上限。官方端点查内置表，其余一律保守回落。
export function resolveModelLimits({ baseUrl, model } = {}) {
  const endpoint = normalizeBaseUrl(baseUrl);
  const name = typeof model === 'string' && model.trim() !== '' ? model.trim() : null;
  if (endpoint === DEFAULT_BASE_URL) {
    const row = (name !== null && OFFICIAL_MODEL_LIMITS[name]) || OFFICIAL_MODEL_LIMITS.default;
    return { contextWindow: row.contextWindow, maxOutputTokens: row.maxOutputTokens, source: 'official' };
  }
  return {
    contextWindow: FALLBACK_CONTEXT_WINDOW,
    maxOutputTokens: FALLBACK_MAX_OUTPUT_TOKENS,
    source: 'fallback',
  };
}
