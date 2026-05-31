export const FAILURE_COMMANDS = Object.freeze({
  'retry-segment':           { args: {} },
  'retry-with-prompt':       { args: { prompt: { type: 'string', maxLength: 2000, required: true } } },
  'pause-here':              { args: {} },
  'accept-current-words':    { args: {} },
  'skip-segment':            { args: {} },
  'fill-words':              { args: { targetWords: { type: 'integer', min: 1, max: 50000, required: true } } },
  'raise-budget':            { args: { newMaxModelCalls: { type: 'integer', min: 1, max: 10000, required: true } } },
  'switch-model':            { args: { modelId: { type: 'string', source: 'allowed-models-only', required: true } } },
  'apply-review-suggestions':{ args: {} },
  'accept-review-current':   { args: {} },
  'manual-review-handoff':   { args: {} }
});

export function validateFailureCommand(command, args = {}) {
  const def = FAILURE_COMMANDS[command];
  if (!def) return { ok: false, error: `未知命令: ${command}` };
  for (const [key, schema] of Object.entries(def.args)) {
    const v = args[key];
    if (v === undefined || v === null) {
      if (schema.required) return { ok: false, error: `缺少必填参数: ${key}` };
      continue;
    }
    if (schema.type === 'string') {
      if (typeof v !== 'string') return { ok: false, error: `${key} 必须是字符串` };
      if (schema.maxLength && v.length > schema.maxLength) {
        return { ok: false, error: `${key} 超长 (>${schema.maxLength})` };
      }
    }
    if (schema.type === 'integer') {
      if (!Number.isInteger(v)) return { ok: false, error: `${key} 必须是整数` };
      if (schema.min !== undefined && v < schema.min) return { ok: false, error: `${key} 不能小于 ${schema.min}` };
      if (schema.max !== undefined && v > schema.max) return { ok: false, error: `${key} 不能大于 ${schema.max}` };
    }
  }
  return { ok: true };
}
