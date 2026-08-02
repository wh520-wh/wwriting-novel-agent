const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

function clean(str, max) {
  if (typeof str !== 'string') return null;
  return str.replace(CONTROL_CHARS, ' ').slice(0, max);
}

const KNOWN_KINDS = new Set([
  'words-short',
  'tool-rejected',
  'loop-exhausted',
  'budget-exhausted',
  'provider-error',
  'review-failed',
  'unknown'
]);

function normalizeKind(value) {
  if (value === 'model-error' || value === 'provider-error' || value === 'project_interrupted') {
    return 'provider-error';
  }
  return KNOWN_KINDS.has(value) ? value : null;
}

function classifyKind(event = {}) {
  const { type, kind, message = '', data = {} } = event;
  const explicit = normalizeKind(kind);
  if (explicit) return explicit;
  if (type === 'model-error' || type === 'provider-error' || type === 'project_interrupted') {
    return 'provider-error';
  }
  if (type === 'quality_gate_failed' && message === 'word-count gate failed') return 'words-short';
  if (type === 'quality_gate_failed' && message === 'skill quality gate failed') return 'review-failed';
  if (type === 'tool_call_rejected') return 'tool-rejected';
  if (type === 'project_blocked') {
    // 优先用 data.code（failWritingAgentLoop 传 reason 作 code）；blockProject 自身的卡片无 code 时回退到 message。
    const code = data.code ?? message;
    if (code === 'model_output_invalid' || code === 'agent_loop_exhausted') return 'loop-exhausted';
    if (code === 'unsupported_tool') return 'tool-rejected';
    if (code === 'model_call_budget_exhausted' || code === 'revision_budget_exhausted'
      || code === 'cost_budget_exhausted' || code === 'token_budget_exhausted') return 'budget-exhausted';
    return 'provider-error';
  }
  return 'unknown';
}

function actionsForKind(kind, event) {
  const data = event.data ?? {};
  switch (kind) {
    case 'words-short': {
      const expected = data.min_words ?? data.expected_words ?? null;
      const actual = data.actual_words ?? 0;
      const gap = expected != null ? Math.max(1, expected - actual) : null;
      return [
        gap
          ? { label: `补写 ${gap} 字`, command: 'fill-words', args: { targetWords: gap } }
          : { label: '继续补写', command: 'fill-words', args: { targetWords: 500 } },
        { label: '接受当前字数继续', command: 'accept-current-words', args: {} },
        { label: '跳过本段', command: 'skip-segment', args: {}, destructive: true }
      ];
    }
    case 'tool-rejected':
      return [
        { label: '让它重试', command: 'retry-segment', args: {} },
        { label: '改提示词后重试', command: 'retry-with-prompt', args: { prompt: '' } },
        { label: '停在这里我手动处理', command: 'pause-here', args: {} }
      ];
    case 'loop-exhausted': {
      // 已自动重试 N 次仍失败 -> 把"换提示词重试"置前，简单重试大概率仍会失败。
      const actions = [
        { label: '改提示词后重试', command: 'retry-with-prompt', args: { prompt: '' } },
        { label: '让它再试一次', command: 'retry-segment', args: {} }
      ];
      // 若耗尽原因是字数门禁反复不达标，给一个"降低目标"的具体选项，
      // 而不是让用户只能反复改提示词硬试（对照 AskUserQuestion：高风险分支给结构化选项）。
      if (data.last_gate === 'word-count-gate' && data.target_words) {
        const lowered = Math.max(300, Math.round(data.target_words * 0.7));
        actions.push({ label: `降低本段字数目标到 ${lowered} 字`, command: 'lower-target-words', args: { newTargetWords: lowered } });
      }
      actions.push({ label: '跳过本段', command: 'skip-segment', args: {}, destructive: true });
      actions.push({ label: '停在这里我手动处理', command: 'pause-here', args: {} });
      return actions;
    }
    case 'budget-exhausted': {
      if (event.message === 'cost_budget_exhausted') {
        const currentMax = data.max_cost ?? 1;
        return [
          { label: `提高成本上限到 ¥${currentMax * 2}`, command: 'raise-cost-budget', args: { newMaxCost: currentMax * 2 } },
          { label: '停在这里', command: 'pause-here', args: {} }
        ];
      }
      if (event.message === 'token_budget_exhausted') {
        const currentMax = data.max_total_tokens ?? 100000;
        return [
          { label: `提高 token 上限到 ${currentMax * 2}`, command: 'raise-token-budget', args: { newMaxTotalTokens: currentMax * 2 } },
          { label: '停在这里', command: 'pause-here', args: {} }
        ];
      }
      const current = data.max_model_calls ?? data.max ?? 200;
      return [
        { label: `提高预算到 ${current * 2}`, command: 'raise-budget', args: { newMaxModelCalls: current * 2 } },
        { label: '停在这里', command: 'pause-here', args: {} }
      ];
    }
    case 'provider-error':
      return [
        { label: '重试当前段', command: 'retry-segment', args: {} },
        { label: '去设置切换模型', command: 'switch-model', args: { modelId: '' } },
        { label: '停在这里', command: 'pause-here', args: {} }
      ];
    case 'review-failed':
      return [
        { label: '让它按建议改写', command: 'apply-review-suggestions', args: {} },
        { label: '接受当前稿', command: 'accept-review-current', args: {} },
        { label: '我来人工改', command: 'manual-review-handoff', args: {} }
      ];
    default:
      return [
        { label: '重试', command: 'retry-segment', args: {} },
        { label: '停在这里', command: 'pause-here', args: {} }
      ];
  }
}

function titleForKind(kind) {
  return {
    'words-short': '字数不足',
    'tool-rejected': '工具调用被拒',
    'loop-exhausted': '多次尝试未成功',
    'budget-exhausted': '预算已用尽',
    'provider-error': '模型服务出错',
    'review-failed': '审稿未通过',
    'unknown': '出现异常'
  }[kind];
}

function bodyForKind(kind, event, state) {
  const ch = event.chapter_no ?? state.current_chapter_no ?? '?';
  const data = event.data ?? {};
  switch (kind) {
    case 'words-short':
      return `第 ${ch} 章本段写了 ${data.actual_words ?? '?'} 字，低于 ${data.min_words ?? data.expected_words ?? '?'} 字门槛。智能体没有继续，等你决定怎么处理。`;
    case 'tool-rejected':
      return `第 ${ch} 章的工具调用 ${data.tool ?? ''} 被拒。智能体停在 ${state.current_stage ?? '未知'} 阶段。`;
    case 'loop-exhausted': {
      const code = data.code ?? event.message;
      if (code === 'agent_loop_exhausted') {
        return `第 ${ch} 章智能体在多轮内未提交正文，可能陷在查资料循环。已自动重试仍未成功，建议换思路或调整提示词。`;
      }
      return `第 ${ch} 章智能体连续多次输出无效（太短/工具不被允许/校验失败）。已自动重试仍未成功，建议换思路或调整提示词。`;
    }
    case 'budget-exhausted': {
      if (event.message === 'cost_budget_exhausted') {
        return `第 ${ch} 章已花约 ¥${data.estimated_cost ?? '?'}，达到你设置的 ¥${data.max_cost ?? '?'} 上限。智能体停下，等你决定。`;
      }
      if (event.message === 'token_budget_exhausted') {
        return `第 ${ch} 章已用约 ${data.total_tokens ?? '?'} token，达到你设置的 ${data.max_total_tokens ?? '?'} token 上限。智能体停下，等你决定。`;
      }
      return `第 ${ch} 章已经用完模型调用预算 (${data.model_calls ?? data.used ?? '?'} / ${data.max_model_calls ?? data.max ?? '?'})，等你决定。`;
    }
    case 'provider-error':
      return `第 ${ch} 章遇到模型服务异常: ${event.message ?? '未知'}。`;
    case 'review-failed':
      return `第 ${ch} 章审稿没通过。`;
    default:
      return `第 ${ch} 章遇到异常: ${event.message ?? '未知'}。`;
  }
}

// §4.5: 连续失败 ≥3 后调整推荐动作顺序，把「换提示词重试 / 换模型 / 跳过」置前
function reorderActionsForRetryExhausted(actions) {
  const preferredLabels = ['改提示词后重试', '换提示词后重试', '去设置切换模型', '跳过本段', '跳过'];
  const preferred = [];
  const rest = [];
  for (const action of actions) {
    if (preferredLabels.some(label => action.label.includes(label))) {
      preferred.push(action);
    } else {
      rest.push(action);
    }
  }
  return [...preferred, ...rest];
}

export function deriveFailureCard(event, state = {}, options = {}) {
  const kind = classifyKind(event);
  const consecutiveFailures = options.consecutiveFailures ?? 0;
  let actions = actionsForKind(kind, event);
  // §4.5: 连续 3 次及以上 failure 后收敛推荐动作
  if (consecutiveFailures >= 3 && ['tool-rejected', 'provider-error', 'unknown'].includes(kind)) {
    actions = reorderActionsForRetryExhausted(actions);
  }
  return {
    id: event.id,
    seq: event.seq ?? 0,
    chapterNo: event.chapter_no ?? state.current_chapter_no ?? null,
    kind,
    title: clean(titleForKind(kind), 80),
    body: clean(bodyForKind(kind, event, state), 500),
    ts: event.ts,
    actions,
    diagnostics: {
      eventId: event.id,
      tool: event.data?.tool ?? null,
      promptHash: event.data?.prompt_hash ?? null,
      logPath: 'run_log.jsonl',
      rawError: clean(event.message ?? null, 500),
      // 模型供应商具体错误:status/reason/body(DeepSeek 400 的 JSON 正文)。
      // 仅 provider-error 卡读取——data.status/reason 在 words-short 等卡是其他语义,避免误展示;
      // failure-card.js 已 JSON.stringify(diagnostics) 展示,加字段后自动出现在"技术细节"区。
      providerStatus: kind === "provider-error" ? (event.data?.status ?? null) : null,
      providerReason: kind === "provider-error" ? (event.data?.reason ?? null) : null,
      providerBody: kind === "provider-error" ? clean(event.data?.body ?? null, 1000) : null
    },
    resolution: null
  };
}

function stableLegacyId(card) {
  const material = [
    card?.ts ?? "",
    card?.chapterNo ?? card?.chapter_no ?? "",
    card?.type ?? card?.kind ?? "unknown",
    card?.message ?? card?.body ?? ""
  ].join("|");
  let hash = 5381;
  for (const char of material) hash = ((hash << 5) + hash) ^ char.charCodeAt(0);
  return `legacy_${(hash >>> 0).toString(36)}`;
}

export function normalizeFailureCard(card, state = {}) {
  const raw = card && typeof card === "object" ? card : {};
  const event = {
    id: typeof raw.id === "string" && raw.id ? raw.id : stableLegacyId(raw),
    type: raw.type ?? raw.kind ?? "unknown",
    kind: raw.kind,
    chapter_no: raw.chapter_no ?? raw.chapterNo,
    message: raw.message ?? raw.body ?? "未知错误",
    ts: raw.ts ?? "",
    data: raw.data && typeof raw.data === "object" ? raw.data : {}
  };
  const derived = deriveFailureCard(event, state);
  return {
    ...derived,
    seq: raw.seq ?? derived.seq,
    title: typeof raw.title === "string" && raw.title ? raw.title : derived.title,
    body: typeof raw.body === "string" && raw.body ? raw.body : derived.body,
    actions: Array.isArray(raw.actions) ? raw.actions : derived.actions,
    diagnostics: raw.diagnostics && typeof raw.diagnostics === "object"
      ? { ...derived.diagnostics, ...raw.diagnostics }
      : derived.diagnostics,
    resolution: raw.resolution ?? null
  };
}
