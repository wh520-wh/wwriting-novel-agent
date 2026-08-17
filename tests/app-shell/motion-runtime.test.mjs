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
  const mod = await import(`../../src/app-shell/motion-runtime.js?api=${Date.now()}`);
  assert.equal(typeof mod.motion.openDrawer, "function");
  assert.equal(typeof mod.motion.closeDrawer, "function");
});

test("reduced-motion close helpers still run completion callbacks", async () => {
  installBrowserGlobals({ reduced: true });
  const { setupMotion, closeDrawer, closeModal } = await import(`../../src/app-shell/motion-runtime.js?reduced=${Date.now()}`);
  setupMotion();
  let drawerDone = false;
  let modalDone = false;

  closeDrawer(null, null, { onComplete: () => { drawerDone = true; } });
  closeModal(null, null, { onComplete: () => { modalDone = true; } });

  assert.equal(drawerDone, true);
  assert.equal(modalDone, true);
});
