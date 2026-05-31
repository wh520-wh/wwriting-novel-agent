import test from "node:test";
import assert from "node:assert/strict";

function installBrowserGlobals({ reduced = false } = {}) {
  globalThis.window = globalThis.window ?? {};
  globalThis.self = globalThis;
  globalThis.window.matchMedia = () => ({
    matches: reduced,
    addEventListener() {},
    removeEventListener() {}
  });
}

test("motion runtime exposes stable semantic API", async () => {
  installBrowserGlobals();
  const mod = await import(`../src/app-shell/motion-runtime.js?api=${Date.now()}`);
  assert.equal(typeof mod.motion.openDrawer, "function");
  assert.equal(typeof mod.motion.closeDrawer, "function");
  assert.equal(typeof mod.motion.insertFailureCard, "function");
  assert.equal(typeof mod.motion.resolveFailureCard, "function");
  assert.equal(typeof mod.diffActivitySlots, "function");
  assert.equal(typeof mod.diffBadgeKeys, "function");
});

test("diffActivitySlots reports only changed slots", async () => {
  installBrowserGlobals();
  const { diffActivitySlots } = await import(`../src/app-shell/motion-runtime.js?activity=${Date.now()}`);
  const before = { stage: "planning", chapterNo: 1, lastTool: { name: "plan", status: "ok" }, spentCost: 0.1, mode: "running" };
  const after = { stage: "drafting", chapterNo: 1, lastTool: { name: "write", status: "pending" }, spentCost: 0.1, mode: "running" };

  assert.deepEqual(diffActivitySlots(before, after).sort(), ["stage", "tool"]);
});

test("diffBadgeKeys handles rebuilt quick rail summaries", async () => {
  installBrowserGlobals();
  const { diffBadgeKeys } = await import(`../src/app-shell/motion-runtime.js?badges=${Date.now()}`);
  const before = { chapters: "1/10", cost: "normal", reviewer: "read" };
  const after = { chapters: "2/10", cost: "warning", reviewer: "unread" };

  assert.deepEqual(diffBadgeKeys(before, after).sort(), ["chapters", "cost", "reviewer"]);
});

test("summarizeBadgesForMotion creates stable quick rail keys", async () => {
  installBrowserGlobals();
  const { summarizeBadgesForMotion } = await import(`../src/app-shell/motion-runtime.js?summary=${Date.now()}`);
  const summary = summarizeBadgesForMotion({
    chapters: { done: 2, total: 10 },
    skills: { enabledCount: 3 },
    research: { newSinceLastVisit: true },
    cost: { level: "warning", pct: 0.82 },
    reviewer: { hasUnread: false }
  });

  assert.deepEqual(summary, {
    chapters: "2/10",
    skills: "3",
    research: "unread",
    cost: "warning",
    reviewer: "read"
  });
});

test("reduced-motion close helpers still run completion callbacks", async () => {
  installBrowserGlobals({ reduced: true });
  const { setupMotion, closeDrawer, closeModal } = await import(`../src/app-shell/motion-runtime.js?reduced=${Date.now()}`);
  setupMotion();
  let drawerDone = false;
  let modalDone = false;

  closeDrawer(null, null, { onComplete: () => { drawerDone = true; } });
  closeModal(null, null, { onComplete: () => { modalDone = true; } });

  assert.equal(drawerDone, true);
  assert.equal(modalDone, true);
});
