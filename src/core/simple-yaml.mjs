export function serializeSimpleYaml(value) {
  return `${Object.entries(value)
    .map(([key, item]) => `${key}: ${formatValue(item)}`)
    .join("\n")}\n`;
}

export function parseSimpleYaml(source) {
  const result = {};
  for (const rawLine of String(source ?? "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const index = line.indexOf(":");
    if (index === -1) {
      continue;
    }
    const key = line.slice(0, index).trim();
    const rawValue = line.slice(index + 1).trim();
    result[key] = parseValue(rawValue);
  }
  return result;
}

function formatValue(value) {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value) || typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function parseValue(rawValue) {
  if (rawValue === "true") return true;
  if (rawValue === "false") return false;
  if (rawValue === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/u.test(rawValue)) return Number(rawValue);
  if (
    (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
    rawValue.startsWith("[") ||
    rawValue.startsWith("{")
  ) {
    try {
      return JSON.parse(rawValue);
    } catch {
      // 手写/遗留值不是严格 JSON（无引号键、尾随注释等）：回退为原始字符串，
      // 与解析器其余部分的宽松行为一致——绝不因单个值让整个 project.yaml 解析失败。
      return rawValue;
    }
  }
  return rawValue;
}

