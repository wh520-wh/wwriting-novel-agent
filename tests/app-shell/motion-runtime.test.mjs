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

test("快速关闭再打开浮层：子元素过渡不提前关闭，旧回调不夺走焦点，关闭标记清除", async (t) => {
  installBrowserGlobals();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { setupMotion, openModal, closeModal, openDrawer, closeDrawer } = await import(`../../src/app-shell/motion-runtime.js?interrupt=${Date.now()}`);
  setupMotion();
  const element = () => ({
    style: {}, dataset: {}, listeners: new Set(),
    addEventListener(_type, fn) { this.listeners.add(fn); },
    removeEventListener(_type, fn) { this.listeners.delete(fn); },
    end(event) { for (const fn of [...this.listeners]) fn(event); }
  });
  for (const kind of ["modal", "drawer"]) {
    const panel = element();
    const scrim = element();
    let closed = 0;
    const open = () => kind === "modal" ? openModal(scrim, panel) : openDrawer(panel, scrim);
    const close = () => kind === "modal"
      ? closeModal(scrim, panel, { onComplete: () => closed++ })
      : closeDrawer(panel, scrim, { onComplete: () => closed++ });
    open();
    close();
    scrim.end({ target: scrim, propertyName: "opacity" });
    panel.end({ target: {}, propertyName: "transform" });
    assert.equal(closed, 0, "子元素的 transitionend 不应关闭父层");
    panel.dataset.closing = scrim.dataset.closing = "true";
    open();
    assert.equal(scrim.dataset.closing, undefined, "重开后可接收指针");
    if (kind === "drawer") assert.equal(panel.dataset.closing, undefined);
    t.mock.timers.tick(1000);
    assert.equal(closed, 0, "重开不能执行旧关闭回调");
    assert.equal(panel.listeners.size + scrim.listeners.size, 0, "过渡监听应释放");
    close();
    t.mock.timers.tick(1000);
    assert.equal(closed, 1, "最后一次关闭仅完成一次");
  }
});
