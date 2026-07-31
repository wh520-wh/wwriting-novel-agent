import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { renderActivityStrip } from '../../src/app-shell/components/activity-strip.js';

// ---------------------------------------------------------------------------
// Minimal DOM mock (no JSDOM)
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
    // Keep className in sync with classList via a proxy on the _el
    this._syncClassName();
  }

  _syncClassName() {
    // Override className getter/setter to reflect classList
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

  /** Fire all handlers registered for `type`, forwarding extra args. */
  _fire(type, ...args) {
    for (const fn of this._listeners.get(type) ?? []) fn(...args);
  }
}

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

function makeActivity(overrides = {}) {
  return {
    mode: 'running',
    stage: 'drafting',
    chapterNo: 3,
    segCurrent: 2,
    segTotal: 5,
    lastTool: { name: 'append_chapter_segment', status: 'done' },
    elapsedMs: 125000,
    etaMs: 60000,
    spentCost: 1.23,
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

describe('renderActivityStrip', () => {

  it('1. hides root when activity is null', () => {
    const root = new MockElement('div');
    renderActivityStrip(root, null);
    assert.equal(root.hidden, true);
  });

  it('2. shows root when activity is provided', () => {
    const root = new MockElement('div');
    root.hidden = true;
    renderActivityStrip(root, makeActivity());
    assert.equal(root.hidden, false);
  });

  it('3. sets idle class when mode is idle', () => {
    const root = new MockElement('div');
    renderActivityStrip(root, makeActivity({ mode: 'idle' }));
    assert.ok(root.classList.has('idle'), 'should have idle class');
    assert.equal(root.classList.has('blocked'), false, 'should not have blocked class');
  });

  it('3b. sets idle class when mode is completed', () => {
    const root = new MockElement('div');
    renderActivityStrip(root, makeActivity({ mode: 'completed' }));
    assert.ok(root.classList.has('idle'), 'should have idle class for completed');
  });

  it('4. sets blocked class when mode is blocked', () => {
    const root = new MockElement('div');
    renderActivityStrip(root, makeActivity({ mode: 'blocked' }));
    assert.ok(root.classList.has('blocked'), 'should have blocked class');
    assert.equal(root.classList.has('idle'), false, 'should not have idle class');
  });

  it('4b. sets blocked class when mode is interrupted', () => {
    const root = new MockElement('div');
    renderActivityStrip(root, makeActivity({ mode: 'interrupted' }));
    assert.ok(root.classList.has('blocked'), 'should have blocked class for interrupted');
  });

  it('5. renders stage slot with label for drafting', () => {
    const root = new MockElement('div');
    renderActivityStrip(root, makeActivity({ stage: 'drafting' }));
    const stage = root.children.find(c => c.className.includes('as-stage'));
    assert.ok(stage, 'stage slot should exist');
    assert.equal(stage.textContent, '● 起草');
  });

  it('5b. renders stage slot with fallback for unknown stage', () => {
    const root = new MockElement('div');
    renderActivityStrip(root, makeActivity({ stage: 'unknown_stage' }));
    const stage = root.children.find(c => c.className.includes('as-stage'));
    assert.equal(stage.textContent, '● unknown_stage');
  });

  it('5c. translates idle stage to Chinese (no raw English)', () => {
    const root = new MockElement('div');
    renderActivityStrip(root, makeActivity({ stage: 'idle' }));
    const stage = root.children.find(c => c.className.includes('as-stage'));
    assert.equal(stage.textContent, '● 空闲');
  });

  it('6. renders chapter location with segment info', () => {
    const root = new MockElement('div');
    renderActivityStrip(root, makeActivity({ chapterNo: 5, segCurrent: 3, segTotal: 10 }));
    const loc = root.children.find(c => c.className.includes('as-loc'));
    assert.ok(loc, 'loc slot should exist');
    assert.equal(loc.textContent, '第 5 章 · seg 3/10');
  });

  it('6b. renders chapter location without segment when segCurrent is null', () => {
    const root = new MockElement('div');
    renderActivityStrip(root, makeActivity({ chapterNo: 5, segCurrent: null, segTotal: null }));
    const loc = root.children.find(c => c.className.includes('as-loc'));
    assert.ok(loc, 'loc slot should exist');
    assert.equal(loc.textContent, '第 5 章');
  });

  it('6c. renders chapter location with ? when segTotal is missing', () => {
    const root = new MockElement('div');
    renderActivityStrip(root, makeActivity({ chapterNo: 5, segCurrent: 3, segTotal: null }));
    const loc = root.children.find(c => c.className.includes('as-loc'));
    assert.equal(loc.textContent, '第 5 章 · seg 3/?');
  });

  it('7. renders tool status with friendly label for done', () => {
    const root = new MockElement('div');
    renderActivityStrip(root, makeActivity({ lastTool: { name: 'append_chapter_segment', status: 'done' } }));
    const tool = root.children.find(c => c.className.includes('as-tool'));
    assert.ok(tool, 'tool slot should exist');
    assert.equal(tool.textContent, '✓ 写入章节内容');
  });

  it('7b. renders tool status with friendly label for pending', () => {
    const root = new MockElement('div');
    renderActivityStrip(root, makeActivity({ lastTool: { name: 'edit_chapter', status: 'pending' } }));
    const tool = root.children.find(c => c.className.includes('as-tool'));
    assert.equal(tool.textContent, '→ 修改章节');
  });

  it('7c. renders tool status with friendly label for failed', () => {
    const root = new MockElement('div');
    renderActivityStrip(root, makeActivity({ lastTool: { name: 'update_outline', status: 'failed' } }));
    const tool = root.children.find(c => c.className.includes('as-tool'));
    assert.equal(tool.textContent, '✗ 更新写作计划');
  });

  it('7d. degrades unknown tool name to toolLabel fallback (no raw name)', () => {
    const root = new MockElement('div');
    renderActivityStrip(root, makeActivity({ lastTool: { name: 'some_unknown_tool', status: 'pending' } }));
    const tool = root.children.find(c => c.className.includes('as-tool'));
    assert.equal(tool.textContent, '→ 工具 some_unknown_tool');
  });

  it('8. renders elapsed time in MM:SS format', () => {
    const root = new MockElement('div');
    renderActivityStrip(root, makeActivity({ elapsedMs: 90000, etaMs: null }));
    const time = root.children.find(c => c.className.includes('as-time'));
    assert.ok(time, 'time slot should exist');
    assert.ok(time.textContent.includes('01:30'), `expected 01:30 in "${time.textContent}"`);
  });

  it('8b. renders elapsed time with ETA', () => {
    const root = new MockElement('div');
    renderActivityStrip(root, makeActivity({ elapsedMs: 125000, etaMs: 60000 }));
    const time = root.children.find(c => c.className.includes('as-time'));
    assert.ok(time.textContent.includes('02:05'), `expected 02:05 in "${time.textContent}"`);
    assert.ok(time.textContent.includes('~01:00'), `expected ~01:00 in "${time.textContent}"`);
  });

  it('8c. renders elapsed time with dash when etaMs is null', () => {
    const root = new MockElement('div');
    renderActivityStrip(root, makeActivity({ elapsedMs: 125000, etaMs: null }));
    const time = root.children.find(c => c.className.includes('as-time'));
    assert.ok(time.textContent.includes('/ —'), `expected "/ —" in "${time.textContent}"`);
  });

  it('9. renders cost with yuan symbol', () => {
    const root = new MockElement('div');
    renderActivityStrip(root, makeActivity({ spentCost: 2.50 }));
    const cost = root.children.find(c => c.className.includes('as-cost'));
    assert.ok(cost, 'cost slot should exist');
    assert.equal(cost.textContent, '￥2.50');
  });

  it('10. privacy-masks chapter location when privacy=true', () => {
    const root = new MockElement('div');
    renderActivityStrip(root, makeActivity(), { privacy: true });
    const loc = root.children.find(c => c.className.includes('as-loc'));
    assert.ok(loc, 'loc slot should exist');
    assert.equal(loc.textContent, '█████');
  });

  it('10b. privacy-masks tool name when privacy=true', () => {
    const root = new MockElement('div');
    renderActivityStrip(root, makeActivity(), { privacy: true });
    const tool = root.children.find(c => c.className.includes('as-tool'));
    assert.ok(tool, 'tool slot should exist');
    assert.ok(tool.textContent.includes('████'), 'tool name should be masked');
    assert.ok(tool.textContent.startsWith('✓'), 'tool status symbol should still show');
  });

  it('11. calls onClickCost when cost is clicked', () => {
    const root = new MockElement('div');
    let clicked = false;
    renderActivityStrip(root, makeActivity(), { onClickCost: () => { clicked = true; } });
    const cost = root.children.find(c => c.className.includes('as-cost'));
    assert.equal(cost.style.cursor, 'pointer');
    cost._fire('click');
    assert.equal(clicked, true);
  });

  it('12. calls onClickChapter when chapter location is clicked', () => {
    const root = new MockElement('div');
    let clicked = false;
    renderActivityStrip(root, makeActivity(), { onClickChapter: () => { clicked = true; } });
    const loc = root.children.find(c => c.className.includes('as-loc'));
    assert.equal(loc.style.cursor, 'pointer');
    loc._fire('click');
    assert.equal(clicked, true);
  });

  it('13. uses replaceChildren to clear (not innerHTML)', () => {
    const root = new MockElement('div');
    // Pre-populate with an old child
    const old = new MockElement('span');
    old.textContent = 'old';
    root.appendChild(old);
    assert.equal(root.children.length, 1);

    renderActivityStrip(root, makeActivity());

    // Old child should be gone, new children should be present
    const oldChild = root.children.find(c => c.textContent === 'old');
    assert.equal(oldChild, undefined, 'old child should have been cleared');
    assert.ok(root.children.length > 0, 'should have new children');
    // Verify replaceChildren was used: the source should not have touched innerHTML
    assert.equal(root.innerHTML, undefined, 'innerHTML should not have been set (replaceChildren used)');
  });

  it('renders no cost slot when spentCost is null', () => {
    const root = new MockElement('div');
    renderActivityStrip(root, makeActivity({ spentCost: null }));
    const cost = root.children.find(c => c.className.includes('as-cost'));
    assert.equal(cost, undefined, 'cost slot should not exist');
  });

  it('renders no tool slot when lastTool is null', () => {
    const root = new MockElement('div');
    renderActivityStrip(root, makeActivity({ lastTool: null }));
    const tool = root.children.find(c => c.className.includes('as-tool'));
    assert.equal(tool, undefined, 'tool slot should not exist');
  });

  it('renders no time slot when elapsedMs is null', () => {
    const root = new MockElement('div');
    renderActivityStrip(root, makeActivity({ elapsedMs: null }));
    const time = root.children.find(c => c.className.includes('as-time'));
    assert.equal(time, undefined, 'time slot should not exist');
  });

  it('removes idle/blocked class on mode change', () => {
    const root = new MockElement('div');
    renderActivityStrip(root, makeActivity({ mode: 'idle' }));
    assert.ok(root.classList.has('idle'));
    renderActivityStrip(root, makeActivity({ mode: 'running' }));
    assert.equal(root.classList.has('idle'), false, 'idle should be removed');
    assert.equal(root.classList.has('blocked'), false, 'blocked should be absent');
  });
});
