// 聊天上下文脱敏：只替换形如 key=value / Authorization Bearer / 常见密钥前缀的
// 片段，统一输出 [REDACTED]；不匹配的文本原样保留，避免破坏普通对话内容。
const NAMED_SECRET = /((?:api[_-]?key|token|password|secret)\s*[:=]\s*)([^\s'";]+)/giu;
const BEARER = /(authorization\s*:\s*bearer\s+)([^\s'";]+)/giu;
const TOKEN_SHAPE = /\b(?:sk-[A-Za-z0-9_-]{12,}|tvly-[A-Za-z0-9_-]{12,})\b/gu;

export function redactChatData(value) {
  return String(value ?? "")
    .replace(NAMED_SECRET, "$1[REDACTED]")
    .replace(BEARER, "$1[REDACTED]")
    .replace(TOKEN_SHAPE, "[REDACTED]");
}
