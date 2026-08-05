// src/core/shell/redaction.mjs
//
// 统一 Agent 内核计划 Task 4：从前置计划 `src/core/chat/chat-redaction.mjs` 端口迁入
// 的命令/参数/输出脱敏，并扩展为有界状态流式脱敏器（修复前置计划已知的
// secret-split-across-chunks 窗口）。
//
// redactChatData —— 一次性脱敏（行为与前置计划完全一致）：
//   只替换形如 key=value / (Authorization) Bearer / 常见密钥前缀（sk-/tvly-）的片段，
//   统一输出 [REDACTED]。值可被单双引号包裹，引号内允许空白（secret="a b"），替换后
//   引号保留；异侧引号（如 it's 中的撇号）允许出现在双引号值内，但单引号开头的值
//   不允许再含单引号（[^']*），避免贪心跨段误伤后续片段。不匹配的文本原样保留。
//
// createStreamingRedactor —— 有界状态流式脱敏器（本任务新增，取代逐块独立脱敏）：
//   - 每块文本先拼上上一块保留的 carry 再处理；只输出「确定不可能继续延长密钥」的
//     安全前缀，把可疑尾部留在 carry 里等下一块（或 flush 终态）补齐；
//   - carry 有界（carryLimit，默认 8192 字符）：超过窗口的部分按普通文本脱敏后输出，
//     并累计记录 overflow_chars（调用方/测试可观测），不无限缓冲；
//   - 流结束时必须调用 flush()：对剩余 carry 做终态脱敏（未闭合引号保持原样，
//     与 redactChatData 的一次性语义一致），并把 carry 清空。
const NAMED_SECRET = /((?:api[_-]?key|token|password|secret)\s*[:=]\s*)(?:"([^"]*)"|'([^']*)'|([^\s'";]+))/giu;
const BEARER = /((?:authorization\s*:\s*)?bearer\s+)(?:"([^"]*)"|'([^']*)'|([^\s'";]+))/giu;
const TOKEN_SHAPE = /\b(?:sk-[A-Za-z0-9_-]{12,}|tvly-[A-Za-z0-9_-]{12,})\b/gu;

// 未闭合值可能跨 chunk 继续：命中即整段保留进 carry。
// 1) 引号包裹的值没有闭合引号（双引号内允许任意非引号字符，单引号内不允许单引号）
const UNCLOSED_QUOTED = [
  /(?:api[_-]?key|token|password|secret)\s*[:=]\s*(?:"([^"]*)$|'([^']*)$)/giu,
  /(?:authorization\s*:\s*)?bearer\s+(?:"([^"]*)$|'([^']*)$)/giu
];
// 2) 非引号值跑到文本末尾（[^\s'";]+ 可能跨 chunk 继续）
const UNCLOSED_PLAIN = [
  /(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s'";]+$/giu,
  /(?:authorization\s*:\s*)?bearer\s+[^\s'";]+$/giu
];
// 3) sk-/tvly- token 前缀尾部（可能跨 chunk 补足 12 位或继续变长）
const TOKEN_TAIL = /(?:sk-|tvly-)[A-Za-z0-9_-]*$/gu;

export const STREAMING_CARRY_LIMIT = 8192;

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

// 一次性脱敏器：模式脱敏 + 调用方显式提供的 secrets 字面量（每个出现都替换）。
// secrets 通常来自项目配置/运行时注入（如 harness 的 dependencies.secrets）。
export function createRedactor({ secrets = [] } = {}) {
  const list = (Array.isArray(secrets) ? secrets : []).filter(
    (secret) => typeof secret === "string" && secret.length > 0
  );
  return {
    redact(value) {
      let out = redactChatData(value);
      for (const secret of list) {
        if (out.includes(secret)) out = out.split(secret).join("[REDACTED]");
      }
      return out;
    }
  };
}

// 返回 work 中可安全输出的前缀长度：从该位置起的文本要么是完整的、要么可能被
// 后续 chunk 继续（未闭合值 / token 前缀尾部 / 显式 secret 的尾部窗口），必须保留
// 进 carry 等下一块或 flush。
// secrets 参与判定时：
//   - carry 尾部窗口至少覆盖「最长 secret 长度 - 1」个字符（完整出现在窗口内的
//     secret 由一次性脱敏直接替换，不会切成两段）；该窗口是有限的，窗口之外
//     拆分的 secret 前缀按普通文本处理（与有界 carry 的约定一致，见文件头）。
//   - 任何与窗口重叠的完整 secret 会把窗口边界延伸到其末尾之后，避免把完整
//     secret 拦腰截断造成前缀明文泄漏。
function computeSafeEmitLength(work, { secrets = [], maxSecretLen = 0 } = {}) {
  let safe = work.length;
  if (maxSecretLen > 1) {
    let boundary = Math.max(0, work.length - (maxSecretLen - 1));
    for (const secret of secrets) {
      let index = work.indexOf(secret);
      while (index !== -1) {
        if (index < boundary && index + secret.length > boundary) {
          boundary = index + secret.length;
        }
        index = work.indexOf(secret, index + 1);
      }
    }
    if (boundary < safe) safe = boundary;
  }
  for (const pattern of [...UNCLOSED_QUOTED, ...UNCLOSED_PLAIN, TOKEN_TAIL]) {
    const match = lastMatch(pattern, work);
    if (match && match.index < safe) safe = match.index;
  }
  return safe;
}

// 找到正则（带 g）在 text 中的最后一次匹配。
function lastMatch(pattern, text) {
  const re = new RegExp(pattern.source, pattern.flags.replace("g", "") + "g");
  let found = null;
  let cursor = 0;
  while (cursor <= text.length) {
    re.lastIndex = cursor;
    const match = re.exec(text);
    if (!match) break;
    found = match;
    cursor = match.index + 1;
  }
  return found;
}

// 有界状态流式脱敏器。state 暴露可观测字段：
//   state.pending_chars   —— 当前 carry 长度（≤ carryLimit）
//   state.overflow_chars  —— 累计超出 carry 窗口、按普通文本处理的字符数
export function createStreamingRedactor({ secrets = [], carryLimit = STREAMING_CARRY_LIMIT } = {}) {
  const oneShot = createRedactor({ secrets });
  const list = (Array.isArray(secrets) ? secrets : []).filter(
    (secret) => typeof secret === "string" && secret.length > 0
  );
  const maxSecretLen = list.reduce((max, secret) => Math.max(max, secret.length), 0);
  let carry = "";
  let overflowChars = 0;
  const state = {
    get pending_chars() {
      return carry.length;
    },
    get overflow_chars() {
      return overflowChars;
    }
  };
  return {
    state,
    // 处理一块输出文本，返回可以立即输出（已脱敏）的部分；可疑尾部保留进 carry。
    push(text) {
      const incoming = String(text ?? "");
      if (incoming.length === 0) return "";
      const work = carry + incoming;
      if (work.length > carryLimit) {
        // 有界 carry：超出窗口的部分按普通文本脱敏输出并记录，只保留窗口内尾部。
        // 跨 chunk 的密钥保证只覆盖 carry 窗口；更长的值在窗口边界处按普通文本处理。
        const dropLen = work.length - carryLimit;
        overflowChars += dropLen;
        carry = work.slice(dropLen);
        return oneShot.redact(work.slice(0, dropLen));
      }
      carry = "";
      const safeLen = computeSafeEmitLength(work, { secrets: list, maxSecretLen });
      carry = work.slice(safeLen);
      return oneShot.redact(work.slice(0, safeLen));
    },
    // 终态：把剩余 carry 做一次性脱敏并清空（未闭合引号保持原样，同 redactChatData）。
    flush() {
      const out = oneShot.redact(carry);
      carry = "";
      return out;
    }
  };
}
