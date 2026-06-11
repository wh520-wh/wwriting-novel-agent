import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { renderCostPanel } from '../../src/app-shell/components/cost-panel.js';

// ---------------------------------------------------------------------------
// Minimal DOM mock (no JSDOM) — same shape as activity-strip-render.test.mjs
// ---------------------------------------------------------------------------

class MockElement {
  constructor(tag) {
    this.tagName = tag;
    this.className = '';
    this.textContent = '';
    this.hidden = false;
    /** @type {MockElement[]} */
    this.children = [];
    this.style = {};
    /** @type {Map<string, Function[]>} */
    this._listeners = new Map();
    this.dataset = {};
    this.classList = {
      _classes: new Set(),
      toggle(cls, force) {
        if (force === undefined) {
          if (this._classes.has(cls)) { this._classes.delete(cls); return false; }
          this._classes.add(cls); return true;
        }
        if (force) this._classes.add(cls); else this._classes.delete(cls);
        return force;
      },
      has(cls) { return this._classes.has(cls); },
      toString() { return [...this._classes].join(' '); }
    };
    this._syncClassName();
  }

  _syncClassName() {
    const self = this;
    Object.defineProperty(this, 'className', {
      get() { return [...self.classList._classes].join(' '); },
      set(v) {
        self.classList._classes.clear();
        for (const c of String(v).split(/\s+/)) { if (c) self.classList._classes.add(c); }
      },
      enumerable: true,
      configurable: true
    });
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  replaceChildren(...nodes) {
    this.children.length = 0;
    for (const n of nodes) this.children.push(n);
  }

  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }

  setAttribute(name, value) {
    if (!this._attrs) this._attrs = {};
    this._attrs[name] = value;
  }

  getAttribute(name) {
    return this._attrs?.[name] ?? null;
  }
}

const _realDoc = globalThis.document;

before(() => {
  globalThis.document = { createElement(tag) { return new MockElement(tag); } };
});

after(() => {
  globalThis.document = _realDoc;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function html(root) {
  function walk(node) {
    if (!node) return '';
    if (typeof node !== 'object') return String(node);
    if (Array.isArray(node)) return node.map(walk).join('');
    if (node.tagName === undefined) return '';
    const style = node.style && Object.keys(node.style).length
      ? ` style="${Object.entries(node.style).map(([k,v]) => `${k}:${v}`).join(';')}"`
      : '';
    const data = node.dataset && Object.keys(node.dataset).length
      ? ` data-${Object.entries(node.dataset).map(([k,v]) => `${k}="${v}"`).join(' ')}`
      : '';
    const cls = node.className ? ` class="${node.className}"` : '';
    return `<${node.tagName.toLowerCase()}${cls}${data}${style}>${walk(node.children)}${walk(node.textContent || '')}</${node.tagName.toLowerCase()}>`;
  }
  return walk(root);
}

function flat(root) {
  return html(root);
}

function findAll(root, predicate) {
  const out = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (predicate(node)) out.push(node);
    (node.children ?? []).forEach(walk);
  }
  walk(root);
  return out;
}

function findByClass(root, className) {
  return findAll(root, (n) => (n.className ?? '').split(/\s+/).includes(className));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCost(overrides = {}) {
  return {
    calls: 9,
    inputTokens: 7701,
    outputTokens: 2925,
    totalTokens: 10626,
    cachedTokens: 0,
    estimatedCost: 0,
    pricedCalls: 0,
    unpricedCalls: 9,
    costAvailable: false,
    retries: 0,
    byProvider: {
      mock: {
        calls: 9,
        inputTokens: 7701,
        outputTokens: 2925,
        totalTokens: 10626,
        cachedTokens: 0,
        estimatedCost: 0
      }
    },
    byModel: {},
    byStage: {},
    byChapter: {
      1: { calls: 3, estimatedCost: 0 },
      2: { calls: 3, estimatedCost: 0 },
      3: { calls: 3, estimatedCost: 0 }
    },
    recentHitRates: [],
    refillCalls: 0,
    cacheSavedCost: 0,
    ...overrides
  };
}

function makeSummary(overrides = {}) {
  return {
    modelCalls: 9,
    maxModelCalls: null,
    totalTokens: 10626,
    estimatedCost: 0,
    costAvailable: false,
    completedChapters: 3,
    targetChapters: 5,
    totalWords: 1234,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('renderCostPanel — 3-section layout', () => {

  it('1. renders 总览/缓存健康/章节成本 three sections', () => {
    const root = renderCostPanel({ cost: makeCost(), summary: makeSummary(), events: [] });
    const text = flat(root);
    assert.match(text, /总览/);
    assert.match(text, /缓存健康/);
    assert.match(text, /章节成本/);
  });

  it('2. shows "未配置价格" when costAvailable is false (honest display)', () => {
    const root = renderCostPanel({ cost: makeCost({ costAvailable: false }), summary: makeSummary({ costAvailable: false }), events: [] });
    const text = flat(root);
    assert.match(text, /未配置价格/);
  });

  it('3. shows formatted cost when costAvailable is true', () => {
    const root = renderCostPanel({
      cost: makeCost({ costAvailable: true, estimatedCost: 0.18 }),
      summary: makeSummary({ costAvailable: true, estimatedCost: 0.18 }),
      events: []
    });
    const text = flat(root);
    assert.ok(/0\.18/.test(text) || /\$0\.18/.test(text), 'should include the cost value');
    assert.equal(/未配置价格/.test(text), false, 'should NOT show 未配置价格 when cost is available');
  });

  it('4. lists chapters ascending by chapter number', () => {
    const root = renderCostPanel({
      cost: makeCost({
        byChapter: {
          3: { calls: 1, estimatedCost: 0.05 },
          1: { calls: 1, estimatedCost: 0.02 },
          2: { calls: 1, estimatedCost: 0.03 }
        },
        costAvailable: true,
        estimatedCost: 0.10
      }),
      summary: makeSummary({ costAvailable: true, estimatedCost: 0.10 }),
      events: []
    });
    const text = flat(root);
    const idx1 = text.indexOf('第 1 章');
    const idx2 = text.indexOf('第 2 章');
    const idx3 = text.indexOf('第 3 章');
    assert.ok(idx1 > 0 && idx2 > idx1 && idx3 > idx2, `expected chapters in order 1,2,3; got idx1=${idx1} idx2=${idx2} idx3=${idx3}`);
  });

  it('5. shows 0.0% hit rate (not empty string) when recentHitRates is all zeros', () => {
    const root = renderCostPanel({
      cost: makeCost({ recentHitRates: [0, 0, 0], cacheSavedCost: 0 }),
      summary: makeSummary(),
      events: []
    });
    const text = flat(root);
    assert.match(text, /0\.0%/);
  });

  it('6. shows mean of recentHitRates as percent', () => {
    const root = renderCostPanel({
      cost: makeCost({
        recentHitRates: [0.1, 0.2, 0.3, 0.4],
        cacheSavedCost: 0
      }),
      summary: makeSummary(),
      events: []
    });
    const text = flat(root);
    // mean = 0.25 = 25.0%
    assert.match(text, /25\.0%/);
  });

  it('7. hides cache savings row when costAvailable is false', () => {
    const root = renderCostPanel({
      cost: makeCost({ cacheSavedCost: 0, costAvailable: false }),
      summary: makeSummary(),
      events: []
    });
    const text = flat(root);
    assert.equal(/缓存节省/.test(text), false, 'should NOT show 缓存节省 when costAvailable is false');
  });

  it('7b. hides cache savings row when costAvailable is true but saved is 0', () => {
    const root = renderCostPanel({
      cost: makeCost({ cacheSavedCost: 0, costAvailable: true }),
      summary: makeSummary({ costAvailable: true }),
      events: []
    });
    const text = flat(root);
    assert.equal(/缓存节省/.test(text), false, 'should NOT show 缓存节省 when saved is 0');
  });

  it('7c. shows cache savings when costAvailable is true and saved > 0', () => {
    const root = renderCostPanel({
      cost: makeCost({ cacheSavedCost: 0.6, costAvailable: true }),
      summary: makeSummary({ costAvailable: true }),
      events: []
    });
    const text = flat(root);
    assert.match(text, /缓存节省/);
    assert.match(text, /0\.60\s*元/);
  });

  it('8. shows formatted cacheSavedCost when non-zero', () => {
    const root = renderCostPanel({
      cost: makeCost({ cacheSavedCost: 0.18, costAvailable: true }),
      summary: makeSummary({ costAvailable: true }),
      events: []
    });
    const text = flat(root);
    assert.match(text, /0\.18\s*元/);
  });

  it('9. shows "补写轮次" with refillCalls', () => {
    const root = renderCostPanel({
      cost: makeCost({ refillCalls: 4 }),
      summary: makeSummary(),
      events: []
    });
    const text = flat(root);
    assert.match(text, /补写轮次/);
    assert.match(text, /4/);
  });

  it('10. renders 20 sparkline blocks', () => {
    const root = renderCostPanel({
      cost: makeCost({ recentHitRates: [0.5, 0.6, 0.7] }),
      summary: makeSummary(),
      events: []
    });
    const sparks = findByClass(root, 'cost-spark');
    assert.equal(sparks.length, 20, `expected 20 spark blocks, got ${sparks.length}`);
    const sparklineEl = findByClass(root, 'cost-sparkline')[0];
    assert.equal(sparklineEl.getAttribute("role"), "img");
    assert.ok(sparklineEl.getAttribute("aria-label").includes("命中率"));
  });

  it('11. fills missing sparkline slots with zero height', () => {
    const root = renderCostPanel({
      cost: makeCost({ recentHitRates: [0.5] }),
      summary: makeSummary(),
      events: []
    });
    const sparks = findByClass(root, 'cost-spark');
    assert.equal(sparks.length, 20);
    const heights = sparks.map((s) => s.style.height);
    // First spark = 0.5*100 = 50%, rest = 0%
    assert.equal(heights[0], '50%');
    assert.equal(heights[1], '0%');
    assert.equal(heights[19], '0%');
  });

  it('12. each sparkline block has height set as percent', () => {
    const root = renderCostPanel({
      cost: makeCost({ recentHitRates: [0.2, 0.4] }),
      summary: makeSummary(),
      events: []
    });
    const sparks = findByClass(root, 'cost-spark');
    for (const s of sparks) {
      assert.ok(s.style.height, 'spark should have a height set');
      assert.match(s.style.height, /%$/, 'spark height should end with %');
    }
  });

  it('13. shows total token count with thousands separator', () => {
    const root = renderCostPanel({
      cost: makeCost({ totalTokens: 1234567 }),
      summary: makeSummary({ totalTokens: 1234567 }),
      events: []
    });
    const text = flat(root);
    assert.match(text, /1[,，  ]234[,，  ]567|1,234,567/);
  });

  it('14. shows total calls count', () => {
    const root = renderCostPanel({
      cost: makeCost({ calls: 42 }),
      summary: makeSummary({ modelCalls: 42 }),
      events: []
    });
    const text = flat(root);
    assert.match(text, /总调用/);
    assert.match(text, /42/);
  });
});

describe('renderCostPanel — warning badge', () => {

  it('15. renders warning badge when lastEvent.type === "chapter_cost_warning"', () => {
    const lastEvent = {
      type: 'chapter_cost_warning',
      chapter_no: 3,
      message: '第 3 章 token 消耗已超过前几章平均值的 2 倍',
      data: { chapter_total_tokens: 9000, average_other_chapters: 3500 }
    };
    const root = renderCostPanel({
      cost: makeCost({
        byChapter: {
          1: { calls: 3, estimatedCost: 0.02 },
          2: { calls: 3, estimatedCost: 0.03 },
          3: { calls: 3, estimatedCost: 0.10 }
        },
        costAvailable: true,
        estimatedCost: 0.15
      }),
      summary: makeSummary({ costAvailable: true, estimatedCost: 0.15 }),
      events: [lastEvent],
      lastEvent
    });
    const text = flat(root);
    assert.match(text, /cost-warning|cost-warn|⚠|预警/);
    const bannerEl = findByClass(root, 'cost-warning-banner')[0];
    assert.equal(bannerEl.getAttribute("role"), "status");
  });

  it('16. no warning badge when no chapter_cost_warning event', () => {
    const root = renderCostPanel({
      cost: makeCost(),
      summary: makeSummary(),
      events: [{ type: 'project_run_started' }]
    });
    const warnings = findByClass(root, 'cost-warning');
    assert.equal(warnings.length, 0);
  });

  it('17. derives lastEvent from events array if not provided', () => {
    const events = [
      { type: 'project_run_started' },
      { type: 'chapter_cost_warning', chapter_no: 5, message: 'over 2x', data: {} }
    ];
    const root = renderCostPanel({
      cost: makeCost(),
      summary: makeSummary(),
      events
    });
    const text = flat(root);
    assert.match(text, /预警|⚠|cost-warning/);
  });

  it('18. warning badge targets the affected chapter row', () => {
    const lastEvent = { type: 'chapter_cost_warning', chapter_no: 2, message: 'over 2x', data: {} };
    const root = renderCostPanel({
      cost: makeCost({
        byChapter: {
          1: { calls: 1, estimatedCost: 0.01 },
          2: { calls: 1, estimatedCost: 0.05 },
          3: { calls: 1, estimatedCost: 0.02 }
        },
        costAvailable: true
      }),
      summary: makeSummary({ costAvailable: true }),
      events: [lastEvent],
      lastEvent
    });
    const warnings = findByClass(root, 'cost-warning');
    assert.ok(warnings.length >= 1);
    // Find chapter row for 第 2 章
    const chapterRows = findByClass(root, 'cost-chapter-row');
    const targetRow = chapterRows.find((r) => /第 2 章/.test(flat(r)));
    assert.ok(targetRow, 'chapter 2 row should exist');
  });
});

describe('renderCostPanel — defensive defaults', () => {

  it('19. handles null cost gracefully', () => {
    const root = renderCostPanel({ cost: null, summary: null, events: [] });
    const text = flat(root);
    assert.match(text, /总览/);
    assert.match(text, /缓存健康/);
    assert.match(text, /章节成本/);
  });

  it('20. handles missing byChapter gracefully', () => {
    const root = renderCostPanel({
      cost: { calls: 0, totalTokens: 0, recentHitRates: [], cacheSavedCost: 0, refillCalls: 0, costAvailable: false },
      summary: null,
      events: []
    });
    const text = flat(root);
    assert.match(text, /总览/);
    assert.match(text, /暂无章节/);
  });

  it('21. shows "未配置价格" per-chapter when costAvailable is false but chapter has calls', () => {
    const root = renderCostPanel({
      cost: makeCost({
        costAvailable: false,
        byChapter: { 1: { calls: 3, estimatedCost: 0 } }
      }),
      summary: makeSummary({ costAvailable: false }),
      events: []
    });
    const text = flat(root);
    assert.match(text, /未配置价格/);
  });
});
