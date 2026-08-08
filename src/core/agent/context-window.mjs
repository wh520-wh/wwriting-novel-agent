// src/core/agent/context-window.mjs —— 统一 token 估算、usage 校准与上下文门禁
//（统一 Journal/上下文窗口/自动压缩计划 Task 6）。
//
// 单输入估算规则（计划 §4）：估算器的唯一输入是最终“预计要发给 provider 的完整
// request messages/tools”。currentInput 必须先由 assemblePrompt() 放入最后一条
// user message、再整体估算一次；调用方（runtime 预检）同样只对装配完成的请求
// 估算，绝不把 currentInput 单独传进来造成双算。本模块的函数签名因此没有
// currentInput 参数——双算在类型上就不可能发生。
//
// 职责边界：
//   - estimateRequestUsage：本地确定性估算（CJK 感知，复用 prompt.mjs 的
//     estimateTokens）。可选 calibration 倍率（当前 session 的 EMA 比例，见
//     observeProviderUsage）在 1.08 安全系数上缩放。
//   - shouldCompact / exceedsHardWindow：发送前预检门禁。256k 档产品压缩点
//     204_800（窗口 80%），1M 档 967_000（Claude Code Sonnet 5 当前默认）；
//     任一命中（达阈值 或 估算 + 32_000 输出安全余量撞硬窗口）即需要压缩。
//     阈值是产品默认值，不暴露设置；圆环分母仍是完整 effective_context_window。
//   - observeProviderUsage：provider 返回 input usage 后校准当前 session 的 EMA
//     比例（夹在 0.5..2.0）。只保留当前 session（状态由 runtime 持有），不写
//     模型能力表、不暴露设置；provider 无 input usage 时维持 approximate。
//
// 本模块不读文件、不调用模型、不接触 journal；payload 组合（只含数字与模型基础
// ID）由 runtime 负责。

import { estimateTokens } from "./prompt.mjs";

// 输出与工具参数安全余量：计划 §4 固定 32_000 tokens（预检命中任一条件即压缩）
export const OUTPUT_SAFETY_RESERVE = 32_000;

// EMA 平滑系数：校准比例只做轻量平滑，避免单次 provider 噪音大起大落。
export const CALIBRATION_EMA_ALPHA = 0.3;

// 压缩阈值只按窗口档位推导（与 model-identity 的 204_800/967_000 同值），
// 不读取设置；1M 档阈值是调研可核验的 Claude Code Sonnet 5 默认值。
function compactionThresholdOf(window) {
  return window === 1_000_000 ? 967_000 : 204_800;
}

function calibrationFactor(calibration) {
  return Number.isFinite(calibration) && calibration > 0 ? calibration : 1;
}

// 估算唯一输入：已装配完成的最终 request messages/tools + 有效窗口 + 可选
// 校准倍率。返回 ContextUsage（计划 §4 固定 typedef 字段，另含 raw_tokens）。
export function estimateRequestUsage({ messages = [], tools = [], effectiveContextWindow, calibration = 1 } = {}) {
  const raw =
    estimateTokens(JSON.stringify(messages)) +
    estimateTokens(JSON.stringify(tools)) +
    Math.ceil(messages.length * 4 + tools.length * 8);
  const used = Math.ceil(raw * 1.08 * calibrationFactor(calibration)) + 256;
  const threshold = compactionThresholdOf(effectiveContextWindow);
  return {
    status: "ready",
    used_tokens: used,
    raw_tokens: raw,
    effective_context_window: effectiveContextWindow,
    compaction_threshold: threshold,
    ratio: used / effectiveContextWindow,
    window_source: effectiveContextWindow === 1_000_000 ? "model_id_1m" : "default_256k",
    estimator: "local",
    approximate: true,
    updated_at: new Date().toISOString()
  };
}

// 发送前压缩门禁：达到产品压缩点，或估算 + 输出安全余量撞硬窗口，即需要压缩。
// threshold 缺省按窗口档位推导（256k→204_800，1M→967_000）。
export function shouldCompact({ estimatedInput, outputReserve = OUTPUT_SAFETY_RESERVE, window, threshold } = {}) {
  const effectiveThreshold = threshold ?? compactionThresholdOf(window);
  return estimatedInput >= effectiveThreshold || estimatedInput + outputReserve >= window;
}

// 硬窗口检查：估算 + 输出安全余量是否已经无法装入窗口（压缩后仍超限时不重复
// 压缩，走现有提交失败与输入恢复流程）。
export function exceedsHardWindow({ estimatedInput, outputReserve = OUTPUT_SAFETY_RESERVE, window } = {}) {
  return estimatedInput + outputReserve >= window;
}

// provider usage 校准：inputTokens / estimated.used_tokens 的比例夹在 0.5..2.0，
// 再对上一校准值做 EMA（α=0.3）。返回 { calibration, approximate }：
//   - provider 无 input usage（缺失/0/非数字）→ 维持 approximate: true，不改变
//     校准值（无观测不改状态）；
//   - 有 input usage → approximate: false，calibration 为最新 EMA 比例。
// calibration 状态只属于当前 session（由 runtime 持有并传入 previousCalibration）。
export function observeProviderUsage({ estimated, usageReport, previousCalibration = null } = {}) {
  const inputTokens = Number(usageReport?.inputTokens);
  if (!Number.isFinite(inputTokens) || inputTokens <= 0) {
    return { calibration: previousCalibration, approximate: true };
  }
  const used = Number(estimated?.used_tokens);
  if (!Number.isFinite(used) || used <= 0) {
    return { calibration: previousCalibration, approximate: true };
  }
  const ratio = inputTokens / used;
  const clamped = Math.min(2.0, Math.max(0.5, ratio));
  const calibration =
    Number.isFinite(previousCalibration) && previousCalibration > 0
      ? previousCalibration + CALIBRATION_EMA_ALPHA * (clamped - previousCalibration)
      : clamped;
  return { calibration, approximate: false };
}
