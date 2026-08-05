// 聊天上下文脱敏：只替换形如 key=value / (Authorization) Bearer / 常见密钥前缀的
// 片段，统一输出 [REDACTED]。值可被单双引号包裹，引号内允许空白（secret="a b"），
// 替换后引号保留；异侧引号（如 it's 中的撇号）允许出现在双引号值内，但单引号开头的
// 值不允许再含单引号（[^']*），避免贪心跨段误伤后续片段。不匹配的文本原样保留，
// 避免破坏普通对话内容。
const NAMED_SECRET = /((?:api[_-]?key|token|password|secret)\s*[:=]\s*)(?:"([^"]*)"|'([^']*)'|([^\s'";]+))/giu;
const BEARER = /((?:authorization\s*:\s*)?bearer\s+)(?:"([^"]*)"|'([^']*)'|([^\s'";]+))/giu;
const TOKEN_SHAPE = /\b(?:sk-[A-Za-z0-9_-]{12,}|tvly-[A-Za-z0-9_-]{12,})\b/gu;

// 函数式替换：按命中的分支构造 [REDACTED]，引号分支保留原引号
function redactSecret(_match, prefix, quotedDouble, quotedSingle) {
  if (quotedDouble !== undefined) return `${prefix}"[REDACTED]"`;
  if (quotedSingle !== undefined) return `${prefix}'[REDACTED]'`;
  return `${prefix}[REDACTED]`;
}

export function redactChatData(value) {
  return String(value ?? "")
    .replace(NAMED_SECRET, redactSecret)
    .replace(BEARER, redactSecret)
    .replace(TOKEN_SHAPE, "[REDACTED]");
}
