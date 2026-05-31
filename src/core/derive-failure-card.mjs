const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

function clean(str, max) {
  if (typeof str !== 'string') return null;
  return str.replace(CONTROL_CHARS, ' ').slice(0, max);
}

function classifyKind(event) {
  const { type, message = '', data = {} } = event;
  if (type === 'quality_gate_failed' && message === 'word-count gate failed') return 'words-short';
  if (type === 'quality_gate_failed' && message === 'skill quality gate failed') return 'review-failed';
  if (type === 'tool_call_rejected') return 'tool-rejected';
  if (type === 'project_blocked') {
    if (message === 'model_output_invalid' || message === 'unsupported_tool') return 'tool-rejected';
    if (message === 'model_call_budget_exhausted' || message === 'revision_budget_exhausted') return 'budget-exhausted';
    return 'provider-error';
  }
  return 'unknown';
}

function actionsForKind(kind, event) {
  const data = event.data ?? {};
  switch (kind) {
    case 'words-short': {
      const expected = data.expected_words ?? null;
      const actual = data.actual_words ?? 0;
      const gap = expected != null ? Math.max(1, expected - actual) : null;
      return [
        gap
          ? { label: `补写 ${gap} 字`, command: { command: 'fill-words', args: { targetWords: gap } } }
          : { label: '继续补写', command: { command: 'fill-words', args: { targetWords: 500 } } },
        { label: '接受当前字数继续', command: { command: 'accept-current-words', args: {} } },
        { label: '跳过本段', command: { command: 'skip-segment', args: {} }, destructive: true }
      ];
    }
    case 'tool-rejected':
      return [
        { label: '让它重试', command: { command: 'retry-segment', args: {} } },
        { label: '改提示词后重试', command: { command: 'retry-with-prompt', args: { prompt: '' } } },
        { label: '停在这里我手动处理', command: { command: 'pause-here', args: {} } }
      ];
    case 'budget-exhausted': {
      const current = data.max ?? 200;
      return [
        { label: `提高预算到 ${current * 2}`, command: { command: 'raise-budget', args: { newMaxModelCalls: current * 2 } } },
        { label: '停在这里', command: { command: 'pause-here', args: {} } }
      ];
    }
    case 'provider-error':
      return [
        { label: '重试当前段', command: { command: 'retry-segment', args: {} } },
        { label: '切换备用模型', command: { command: 'switch-model', args: { modelId: '' } } },
        { label: '停在这里', command: { command: 'pause-here', args: {} } }
      ];
    case 'review-failed':
      return [
        { label: '让它按建议改写', command: { command: 'apply-review-suggestions', args: {} } },
        { label: '接受当前稿', command: { command: 'accept-review-current', args: {} } },
        { label: '我来人工改', command: { command: 'manual-review-handoff', args: {} } }
      ];
    default:
      return [
        { label: '重试', command: { command: 'retry-segment', args: {} } },
        { label: '停在这里', command: { command: 'pause-here', args: {} } }
      ];
  }
}

function titleForKind(kind) {
  return {
    'words-short': '字数不足',
    'tool-rejected': '工具调用被拒',
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
      return `第 ${ch} 章本段写了 ${data.actual_words ?? '?'} 字，低于 ${data.expected_words ?? '?'} 字门槛。智能体没有继续，等你决定怎么处理。`;
    case 'tool-rejected':
      return `第 ${ch} 章的工具调用 ${data.tool ?? ''} 被拒。智能体停在 ${state.current_stage ?? '未知'} 阶段。`;
    case 'budget-exhausted':
      return `第 ${ch} 章已经用完模型调用预算 (${data.used ?? '?'} / ${data.max ?? '?'})，等你决定。`;
    case 'provider-error':
      return `第 ${ch} 章遇到模型服务异常: ${event.message ?? '未知'}。`;
    case 'review-failed':
      return `第 ${ch} 章审稿没通过。`;
    default:
      return `第 ${ch} 章遇到异常: ${event.message ?? '未知'}。`;
  }
}

export function deriveFailureCard(event, state = {}) {
  const kind = classifyKind(event);
  return {
    id: event.id,
    seq: event.seq ?? 0,
    chapterNo: event.chapter_no ?? state.current_chapter_no ?? null,
    kind,
    title: clean(titleForKind(kind), 80),
    body: clean(bodyForKind(kind, event, state), 500),
    ts: event.ts,
    actions: actionsForKind(kind, event),
    diagnostics: {
      eventId: event.id,
      tool: event.data?.tool ?? null,
      promptHash: event.data?.prompt_hash ?? null,
      logPath: 'run_log.jsonl',
      rawError: clean(event.message ?? null, 500)
    },
    resolution: null
  };
}
