// src/core/structured-output.mjs
// 统一结构化输出契约：版本化 schema 注册 + 解析 + 校验 + 可分类错误码。
// memory/fact-check/intent/outline 共用，消除"围栏 JSON 静默失败"。
// 各 schema 的 normalize 复用各自模块现有归一化逻辑，不重写。
//
// 错误码无 truncated：JSON.parse 失败统一走 invalid_json。
// 截断（max_tokens 截断导致 JSON 不完整）的检测留给上游按 finish_reason=length 判断，
// 本层只负责"拿到文本后解析+校验"，YAGNI。

const SCHEMA_REGISTRY = new Map();

export const STRUCTURED_OUTPUT_ERRORS = Object.freeze({
  invalid_json: "invalid_json",
  missing_field: "missing_field",
  enum_violation: "enum_violation",
  empty_content: "empty_content",
  schema_not_found: "schema_not_found"
});

export function registerSchema(name, version, definition) {
  const key = `${name}@${version}`;
  if (SCHEMA_REGISTRY.has(key)) {
    return; // 幂等：同 schema 重复注册不抛错（热重载安全）
  }
  SCHEMA_REGISTRY.set(key, definition);
}

export function getSchema(name, version) {
  return SCHEMA_REGISTRY.get(`${name}@${version}`) ?? null;
}

export function parseStructuredOutput(name, version, rawText) {
  const schema = getSchema(name, version);
  if (!schema) {
    return { ok: false, error: { code: STRUCTURED_OUTPUT_ERRORS.schema_not_found, message: `${name}@${version}` } };
  }
  const text = String(rawText ?? "");
  if (!text.trim()) {
    return { ok: false, error: { code: STRUCTURED_OUTPUT_ERRORS.empty_content } };
  }
  const candidate = extractJsonCandidate(text);
  let data;
  try {
    data = JSON.parse(candidate);
  } catch {
    return { ok: false, error: { code: STRUCTURED_OUTPUT_ERRORS.invalid_json } };
  }
  let normalized;
  try {
    normalized = schema.normalize(data);
  } catch {
    return { ok: false, error: { code: STRUCTURED_OUTPUT_ERRORS.invalid_json } };
  }
  let validation;
  try {
    validation = schema.validate(normalized);
  } catch {
    // 与 normalize 对称：validate 抛异常也统一归为 invalid_json，不穿透给调用方
    return { ok: false, error: { code: STRUCTURED_OUTPUT_ERRORS.invalid_json } };
  }
  if (!validation.ok) {
    return {
      ok: false,
      error: {
        // 兜底：validate 返回 { ok: false } 但缺 code 时，保证 error.code 不为 undefined
        code: validation.code ?? STRUCTURED_OUTPUT_ERRORS.invalid_json,
        field: validation.field ?? null,
        message: validation.message ?? null
      }
    };
  }
  return { ok: true, data: normalized };
}

function extractJsonCandidate(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(text);
  return (fenced ? fenced[1] : text).trim();
}
