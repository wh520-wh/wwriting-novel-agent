import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { renderFailureCard, FAILURE_COMMANDS } from '../../src/app-shell/components/failure-card.js';

// ---------------------------------------------------------------------------
// Minimal DOM mock (no JSDOM)
// ---------------------------------------------------------------------------

class MockElement {
  constructor(tag) {
    this.tagName = tag;
    this.className = '';
    this.textContent = '';
    this.dataset = {};
    this.type = '';
    this.disabled = false;
    /** @type {MockElement[]} */
    this.children = [];
    /** @type {Map<string, Function[]>} */
    this._listeners = new Map();
    this.classList = {
      _el: this,
      add(cls) { this._el.className += (this._el.className ? ' ' : '') + cls; },
      remove(cls) {
        this._el.className = this._el.className
          .split(/\s+/)
          .filter(c => c !== cls)
          .join(' ');
      }
    };
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }

  /** Fire all handlers registered for `type`, forwarding extra args. */
  _fire(type, ...args) {
    for (const fn of this._listeners.get(type) ?? []) fn(...args);
  }

  /** Simple recursive querySelector by className. */
  querySelector(selector) {
    // Only supports simple class selectors like '.foo'
    const cls = selector.startsWith('.') ? selector.slice(1) : selector;
    for (const child of this.children) {
      if (child.className.split(/\s+/).includes(cls)) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

function makeCard(overrides = {}) {
  return {
    id: 'f-001',
    seq: 1,
    kind: 'words-short',
    title: '字数不足',
    body: '第 3 章只有 1200 字，目标 3000 字',
    ts: '2026-06-01T10:30:00Z',
    actions: [
      { command: 'retry-segment', label: '重试' },
      { command: 'fill-words', label: '补字', args: { targetWords: 3000 } }
    ],
    resolution: null,
    diagnostics: { actual: 1200, target: 3000 },
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Install / restore global document mock
// ---------------------------------------------------------------------------

const _realDoc = globalThis.document;

before(() => {
  globalThis.document = {
    createElement(tag) { return new MockElement(tag); }
  };
});

after(() => {
  globalThis.document = _realDoc;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('renderFailureCard', () => {

  it('returns <article> with failure-card and kind-{kind} classes', () => {
    const el = renderFailureCard(makeCard(), { onAction() {} });
    assert.equal(el.tagName, 'article');
    assert.ok(el.className.includes('failure-card'));
    assert.ok(el.className.includes('kind-words-short'));
    assert.equal(el.dataset.failureId, 'f-001');
    assert.equal(el.dataset.ts, '2026-06-01T10:30:00Z');
  });

  it('header contains seq, title, and formatted time', () => {
    const el = renderFailureCard(makeCard(), { onAction() {} });
    const head = el.children[0];
    assert.equal(head.tagName, 'header');
    assert.ok(head.textContent.includes('故障 #1'));
    assert.ok(head.textContent.includes('字数不足'));
    // formatTime converts UTC to local; 10:30Z = 18:30 UTC+8
    assert.ok(head.textContent.includes('30'), `expected time fragment in "${head.textContent}"`);
  });

  it('body text rendered', () => {
    const el = renderFailureCard(makeCard(), { onAction() {} });
    const body = el.children[1];
    assert.equal(body.tagName, 'p');
    assert.equal(body.className, 'failure-body');
    assert.equal(body.textContent, '第 3 章只有 1200 字，目标 3000 字');
  });

  it('action buttons rendered with correct count and labels', () => {
    const el = renderFailureCard(makeCard(), { onAction() {} });
    const actionsDiv = el.children[2];
    assert.equal(actionsDiv.tagName, 'div');
    assert.equal(actionsDiv.className, 'failure-actions');
    assert.equal(actionsDiv.children.length, 2);
    assert.equal(actionsDiv.children[0].textContent, '重试');
    assert.equal(actionsDiv.children[1].textContent, '补字');
    // All buttons should have type="button"
    for (const btn of actionsDiv.children) {
      assert.equal(btn.type, 'button');
    }
  });

  it('buttons disabled when card has resolution', () => {
    const card = makeCard({
      resolution: { action: 'retry-segment', submittedAt: '2026-06-01T11:00:00Z' }
    });
    const el = renderFailureCard(card, { onAction() {} });
    const actionsDiv = el.children[2];
    for (const btn of actionsDiv.children) {
      assert.equal(btn.disabled, true, 'button should be disabled when resolution exists');
    }
  });

  it('buttons enabled when no resolution', () => {
    const el = renderFailureCard(makeCard(), { onAction() {} });
    const actionsDiv = el.children[2];
    for (const btn of actionsDiv.children) {
      assert.equal(btn.disabled, false, 'button should be enabled when no resolution');
    }
  });

  it('onAction callback fires with (card, action) on click', () => {
    const card = makeCard();
    let receivedCard, receivedAction;
    const el = renderFailureCard(card, {
      onAction(c, a) { receivedCard = c; receivedAction = a; }
    });
    const actionsDiv = el.children[2];
    // Click the second button (fill-words)
    actionsDiv.children[1]._fire('click');
    assert.equal(receivedCard, card);
    assert.equal(receivedAction, card.actions[1]);
    assert.equal(receivedAction.command, 'fill-words');
  });

  it('diagnostics collapsible rendered', () => {
    const el = renderFailureCard(makeCard(), { onAction() {} });
    // diagnostics is the 4th child (index 3) when no resolution
    const details = el.children[3];
    assert.equal(details.tagName, 'details');
    assert.equal(details.className, 'failure-diagnostics');
    const summary = details.children[0];
    assert.equal(summary.tagName, 'summary');
    assert.equal(summary.textContent, '看技术细节');
    const pre = details.children[1];
    assert.equal(pre.tagName, 'pre');
    const parsed = JSON.parse(pre.textContent);
    assert.equal(parsed.actual, 1200);
    assert.equal(parsed.target, 3000);
  });

  it('resolved status shown when resolution exists', () => {
    const card = makeCard({
      resolution: { action: 'retry-segment', submittedAt: '2026-06-01T11:00:00Z' }
    });
    const el = renderFailureCard(card, { onAction() {} });
    // children: header(0), body(1), actions(2), resolved(3), diagnostics(4)
    const resolved = el.children[3];
    assert.equal(resolved.tagName, 'p');
    assert.equal(resolved.className, 'failure-resolved');
    assert.ok(resolved.textContent.includes('已选: retry-segment'));
    assert.ok(resolved.textContent.includes('19:00')); // 11:00Z = 19:00 UTC+8
  });

  it('destructive action gets destructive class', () => {
    const card = makeCard({
      actions: [
        { command: 'skip-segment', label: '跳过', destructive: true },
        { command: 'retry-segment', label: '重试' }
      ]
    });
    const el = renderFailureCard(card, { onAction() {} });
    const actionsDiv = el.children[2];
    assert.ok(actionsDiv.children[0].className.includes('destructive'));
    assert.equal(actionsDiv.children[1].className.includes('destructive'), false);
  });

  it('renders a legacy card without actions without throwing', () => {
    assert.doesNotThrow(() => renderFailureCard({
      id: "legacy-http-400",
      kind: "provider-error",
      title: "模型服务出错",
      body: "模型服务拒绝了请求（HTTP 400）。",
      ts: "2026-08-01T01:00:00Z",
      diagnostics: {}
    }, { onAction() {} }));

    const el = renderFailureCard({
      id: "legacy-http-400",
      kind: "provider-error",
      title: "模型服务出错",
      body: "模型服务拒绝了请求（HTTP 400）。",
      ts: "2026-08-01T01:00:00Z",
      diagnostics: {}
    }, { onAction() {} });
    assert.equal(el.children[2].children.length, 0);
    assert.ok(el.children[1].textContent.includes("模型服务拒绝了请求"));
    assert.equal(el.children[3].children[0].textContent, "看技术细节");
  });

  it('failure-card: provider-error 技术细节含 providerBody(providerStatus=400)', async () => {
    const card = {
      id: "flr_test", seq: 1, chapterNo: 2, kind: "provider-error",
      title: "模型服务出错",
      body: "第 2 章遇到模型服务异常: OpenAI-compatible provider returned HTTP 400.",
      ts: "2026-08-02T01:30:02Z",
      actions: [{ label: "重试当前段", command: "retry-segment", args: {} }],
      diagnostics: {
        eventId: "flr_test", tool: null, promptHash: null, logPath: "run_log.jsonl",
        rawError: "OpenAI-compatible provider returned HTTP 400.",
        providerStatus: 400, providerReason: "client-fatal",
        providerBody: '{"error":{"message":"Invalid tool_calls"}}'
      },
      resolution: null
    };
    const el = renderFailureCard(card, { onAction() {} }); // 按该文件现有 render 调用签名
    // failure-card.js:73 details className="failure-diagnostics";<pre> 无 className、永远在 details.children[1]
    // MockElement.querySelector 只支持 class 选择器(不支持 tag),故用 .failure-diagnostics 取 details、children[1] 取 pre。
    // 对齐 tests/app-shell/failure-card-render.test.mjs:182-192 现有范式。
    const details = el.querySelector(".failure-diagnostics");
    const pre = details.children[1];
    const parsed = JSON.parse(pre.textContent);
    assert.equal(parsed.providerStatus, 400, "技术细节 JSON 应含 providerStatus");
    assert.match(parsed.providerBody ?? "", /Invalid tool_calls/u, "技术细节 JSON 应含 providerBody 原文");
  });
});

describe('FAILURE_COMMANDS', () => {

  it('is a frozen object', () => {
    assert.equal(typeof FAILURE_COMMANDS, 'object');
    assert.equal(Array.isArray(FAILURE_COMMANDS), false);
    assert.equal(Object.isFrozen(FAILURE_COMMANDS), true);
  });

  it('contains the expected 14 commands', () => {
    const keys = Object.keys(FAILURE_COMMANDS);
    assert.equal(keys.length, 14);
    const expected = [
      'retry-segment', 'retry-with-prompt', 'pause-here', 'accept-current-words',
      'skip-segment', 'fill-words', 'raise-budget', 'raise-cost-budget', 'raise-token-budget',
      'switch-model', 'apply-review-suggestions', 'accept-review-current', 'manual-review-handoff',
      'lower-target-words'
    ];
    assert.deepEqual(keys.sort(), expected.sort());
  });

  it('each command entry has an args object', () => {
    for (const [name, def] of Object.entries(FAILURE_COMMANDS)) {
      assert.equal(typeof def, 'object', `${name} should be an object`);
      assert.equal(typeof def.args, 'object', `${name}.args should be an object`);
    }
  });
});
