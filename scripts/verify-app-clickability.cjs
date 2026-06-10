const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");

const rootDir = path.resolve(__dirname, "..");
const port = 5300 + Math.floor(Math.random() * 300);
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wwriting-clicks-"));
let server = null;

app.setPath("userData", userDataDir);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-sandbox");
app.commandLine.appendSwitch("disable-http-cache");
app.commandLine.appendSwitch("force-prefers-reduced-motion");

app.whenReady().then(() => main().catch((error) => {
  console.error(error?.stack || error);
  cleanup(1);
}));

async function main() {
  const { createAppShellServer } = await import(pathToFileURL(path.join(rootDir, "src", "core", "app-server.mjs")).href);
  const { createProject } = await import(pathToFileURL(path.join(rootDir, "src", "core", "project-store.mjs")).href);
  const { runProject } = await import(pathToFileURL(path.join(rootDir, "src", "core", "agent-engine.mjs")).href);
  const { appendFailure } = await import(pathToFileURL(path.join(rootDir, "src", "core", "failures-store.mjs")).href);
  const demoRoot = path.join(rootDir, ".demo_runs", `clickability-${Date.now()}`);
  const { projectRoot } = await createProject(demoRoot, {
    slug: "clickability-novel",
    title: "Clickability Novel",
    story_seed: "A short project used to verify every visible app-shell button can execute.",
    target_chapters: 2,
    min_words_per_chapter: 120,
    target_words_per_chapter: 180,
    enabled_skills: ["suspense-chapter-end"]
  });
  await runProject(projectRoot);
  appendFailure(projectRoot, {
    id: "click-failure-1",
    seq: 1,
    chapterNo: 1,
    kind: "unknown",
    title: "Clickability probe failure",
    body: "This card verifies failure actions remain clickable after motion.",
    ts: new Date().toISOString(),
    actions: [{ label: "停在这里", command: "pause-here", args: {} }],
    diagnostics: { eventId: "click-failure-1", tool: null, promptHash: null, logPath: "run_log.jsonl", rawError: null },
    resolution: null
  });

  server = createAppShellServer({
    workspaceRoot: rootDir,
    selectedProjectRoot: projectRoot,
    staticRoot: path.join(rootDir, "src", "app-shell"),
    secretsRoot: userDataDir,
    port
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  await waitForServer(port);

  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    show: false,
    backgroundColor: "#f4f3f0",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  const consoleMessages = [];
  win.webContents.on("console-message", (event) => {
    consoleMessages.push({
      level: event.level,
      message: event.message,
      line: event.lineNumber,
      sourceId: event.sourceId
    });
  });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    consoleMessages.push({ level: "load", message: `${errorCode}: ${errorDescription}`, sourceId: validatedURL });
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    consoleMessages.push({ level: "render-process-gone", message: JSON.stringify(details) });
  });

  await win.loadURL(`http://127.0.0.1:${port}`);
  await delay(800);
  await win.webContents.executeJavaScript(`
    window.__wwClickProbe = { clicks: {}, errors: [] };
    window.addEventListener("error", (event) => {
      window.__wwClickProbe.errors.push(String(event.error?.stack || event.message || event.error));
    });
    window.addEventListener("unhandledrejection", (event) => {
      window.__wwClickProbe.errors.push(String(event.reason?.stack || event.reason));
    });
    true;
  `);
  await win.webContents.executeJavaScript(`
    window.__wwMotionProbe = {
      loaded: Boolean(window.__wwritingMotionReady),
      errors: []
    };
    true;
  `);

  const clicks = [];

  clicks.push(await clickAndRead(win, "#refresh", { label: "refresh" }));
  clicks.push(await clickAndRead(win, "#privacy-toggle", {
    label: "privacy-toggle",
    expect: () => read(win, "document.getElementById('app').dataset.privacy === 'on'")
  }));
  clicks.push(await clickAndRead(win, "#project-filter", {
    label: "project-filter-focus",
    expect: () => read(win, "document.activeElement?.id === 'project-filter'")
  }));
  clicks.push(await clickAndRead(win, ".rail-nav .nav-item:nth-of-type(2)", {
    label: "nav-skill",
    expect: () => read(win, "document.getElementById('drawer').classList.contains('show') === true && document.querySelector('[data-dtab=\"run\"]').getAttribute('aria-selected') === 'true'"),
    settleMs: 500
  }));
  clicks.push(await clickAndReadStable(win, "#drawer-close", {
    label: "nav-skill-drawer-close",
    expect: () => read(win, "document.getElementById('drawer').classList.contains('show') === false"),
    settleMs: 500
  }));
  clicks.push(await clickAndRead(win, ".rail-nav .nav-item:nth-of-type(1)", {
    label: "nav-new",
    expect: () => overlayVisible(win, "create-scrim")
  }));
  clicks.push(await clickAndRead(win, "#create-x", {
    label: "nav-new-create-close",
    expect: () => overlayHidden(win, "create-scrim")
  }));
  clicks.push(await clickAndRead(win, "#open-folder", {
    label: "open-folder-fallback",
    expect: () => read(win, `
      document.getElementById("create-scrim").classList.contains("show") === true &&
      document.getElementById("create-heading").textContent.includes("手动填写本地文件夹")
    `)
  }));
  clicks.push(await clickAndRead(win, "#create-x", {
    label: "open-folder-create-close",
    expect: () => overlayHidden(win, "create-scrim")
  }));
  await assertRailPrimaryEntriesSeparate(win);
  clicks.push(await clickAndRead(win, ".proj.active", { label: "active-project" }));

  const newNovel = await clickAndRead(win, "#new-novel", {
    label: "new-novel",
    expect: () => read(win, `
      document.getElementById("create-scrim").classList.contains("show") === true &&
      document.getElementById("create-heading").textContent.includes("开始一部新小说")
    `)
  });
  clicks.push(newNovel);
  clicks.push(await clickAndRead(win, "#create-browse", { label: "create-browse" }));
  clicks.push(await clickAndRead(win, "#create-submit", {
    label: "create-submit-empty-path",
    expect: () => read(win, "document.getElementById('create-status').textContent.length > 0")
  }));
  clicks.push(await clickAndRead(win, "#create-x", {
    label: "create-x",
    expect: () => overlayHidden(win, "create-scrim")
  }));

  const settings = await clickAndRead(win, "#open-settings", {
    label: "open-settings",
    expect: () => overlayVisible(win, "settings-scrim")
  });
  clicks.push(settings);
  const customModelId = `writer-custom-${Date.now()}`;
  clicks.push(await clickAndRead(win, ".sp-item:not(.on)", { label: "settings-provider-row" }));
  clicks.push(await clickAndRead(win, "#settings-add", {
    label: "settings-add",
    expect: () => read(win, "document.querySelector('#settings-provider-list .sp-item.on')?.textContent.includes('OpenAI') === true")
  }));
  const modelControlState = await read(win, `
    (() => {
      const control = document.querySelector('[aria-label="模型"]');
      if (!control) return { tagName: null };
      control.value = ${JSON.stringify(customModelId)};
      control.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: control.value }));
      return {
        tagName: control.tagName,
        value: control.value,
        listId: control.getAttribute("list"),
        hasSuggestions: Boolean(document.getElementById("settings-model-suggestions"))
      };
    })()
  `);
  assert.equal(modelControlState.tagName, "INPUT", "settings model control must be an editable input");
  assert.equal(modelControlState.value, customModelId, "settings model input must accept a custom model id");
  assert.equal(modelControlState.listId, "settings-model-suggestions", "settings model input must reference preset suggestions");
  assert.equal(modelControlState.hasSuggestions, true, "settings model suggestions datalist must exist");
  clicks.push(await clickAndRead(win, ".spd-affix-eye", {
    label: "settings-api-key-reveal",
    expect: () => read(win, "document.querySelector('.spd-affix-eye')?.getAttribute('aria-pressed') === 'true'")
  }));
  clicks.push(await clickAndRead(win, ".spd-affix-copy", { label: "settings-api-key-copy-empty" }));
  clicks.push(await clickAndRead(win, ".sw", {
    label: "settings-network-toggle",
    expect: () => read(win, "document.querySelector('.sw')?.getAttribute('aria-pressed') === 'true'")
  }));
  clicks.push(await clickAndRead(win, "#settings-save", {
    label: "settings-save",
    expect: () => overlayHidden(win, "settings-scrim"),
    settleMs: 500
  }));
  const savedCustomModel = await read(win, `
    fetch("/api/dashboard")
      .then((response) => response.json())
      .then((data) => data.project?.active_model?.model_name)
  `);
  assert.equal(savedCustomModel, customModelId, "saved settings must preserve a custom model id");
  await waitUntil(win, "document.getElementById('settings-save')?.disabled === false", "settings save flow must finish before quick rail checks");

  const modalClosedState = await read(win, `
    (() => {
      const settings = document.getElementById("settings-scrim");
      const create = document.getElementById("create-scrim");
      return settings.hasAttribute("inert") && create.hasAttribute("inert");
    })()
  `);
  assert.equal(modalClosedState, true, "settings/create overlays must be inert after close");
  await clearStaleClosingStates(win);

  await assertQuickRailPopoverClears(win);

  clicks.push(await clickAndReadStable(win, '.quick-rail .qr-slot[data-key="chapters"]', {
    label: "open-chapters",
    expect: () => read(win, "document.getElementById('drawer').classList.contains('show') && document.querySelector('[data-dtab=\"chapters\"]').getAttribute('aria-selected') === 'true'"),
    settleMs: 500
  }));
  clicks.push(await clickAndReadStable(win, ".chrow.completed", {
    label: "completed-chapter-row",
    expect: () => overlayVisible(win, "reader-scrim"),
    settleMs: 500
  }));
  clicks.push(await clickAndReadStable(win, "#reader-close", {
    label: "reader-close",
    expect: () => overlayHidden(win, "reader-scrim"),
    settleMs: 700
  }));
  await closeTransientOverlays(win);
  clicks.push(await clickAndRead(win, ".drawer-tabs [data-dtab=\"model\"]", {
    label: "drawer-model-tab",
    expect: () => read(win, "document.querySelector('[data-dtab=\"model\"]').getAttribute('aria-selected') === 'true'")
  }));
  clicks.push(await clickAndReadStable(win, ".drawer-body .save-btn", {
    label: "drawer-open-model-settings",
    expect: () => overlayVisible(win, "settings-scrim")
  }));
  clicks.push(await clickAndReadStable(win, "#settings-cancel", {
    label: "settings-cancel",
    expect: () => overlayHidden(win, "settings-scrim"),
    settleMs: 500
  }));
  await waitUntil(win, "document.getElementById('settings-scrim')?.classList.contains('show') === false", "settings overlay must close before switching drawer tabs");
  await clearStaleClosingStates(win);
  clicks.push(await clickAndReadStable(win, ".drawer-tabs [data-dtab=\"run\"]", {
    label: "drawer-run-tab",
    expect: () => read(win, "document.querySelector('[data-dtab=\"run\"]').getAttribute('aria-selected') === 'true'")
  }));
  clicks.push(await clickAndRead(win, ".drawer-body .dpanel:nth-child(3) .small-button", {
    label: "skill-toggle",
    settleMs: 650
  }));
  clicks.push(await clickAndRead(win, ".research-form .small-button", { label: "research-empty-search" }));
  clicks.push(await clickAndRead(win, ".research-form button:last-of-type", { label: "research-empty-fetch" }));
  clicks.push(await clickAndReadStable(win, "#drawer-close", {
    label: "drawer-close",
    expect: () => read(win, "document.getElementById('drawer').classList.contains('show') === false"),
    settleMs: 500
  }));

  const drawerClosedState = await read(win, `
    (() => {
      const drawer = document.getElementById("drawer");
      return drawer.getAttribute("aria-hidden") === "true" && drawer.hasAttribute("inert");
    })()
  `);
  assert.equal(drawerClosedState, true, "drawer must be inert and aria-hidden after close");
  await win.webContents.executeJavaScript(`
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    true;
  `);

  clicks.push(await clickAndRead(win, '.quick-rail .qr-slot[data-key="skills"]', {
    label: "open-panel",
    expect: () => read(win, "document.getElementById('drawer').classList.contains('show') === true && document.querySelector('[data-dtab=\"skills\"]').getAttribute('aria-selected') === 'true'")
  }));
  clicks.push(await clickAndReadStable(win, "#drawer-scrim", {
    label: "drawer-scrim-close",
    expect: () => read(win, "document.getElementById('drawer').classList.contains('show') === false"),
    settleMs: 500
  }));

  await win.webContents.executeJavaScript(`
    document.querySelector('.failure-card[data-failure-id="click-failure-1"]')?.scrollIntoView({ block: "center" });
    window.__wwDebugResolve = { started: false, ok: false, loadDashboardCalled: false, syncCardsFound: false };
    const origFetch = window.fetch;
    window.fetch = async function(...args) {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      if (url && url.includes('/api/failures/resolve')) {
        window.__wwDebugResolve.started = true;
        try {
          const res = await origFetch.apply(this, args);
          window.__wwDebugResolve.ok = res.ok;
          return res;
        } catch(e) { window.__wwDebugResolve.error = String(e); throw e; }
      }
      return origFetch.apply(this, args);
    };
    true;
  `);
  clicks.push(await clickAndRead(win, '.failure-card[data-failure-id="click-failure-1"] .failure-actions button', {
    label: "failure-action",
    settleMs: 3000,
    expect: async () => {
      const debug = await read(win, "window.__wwDebugResolve");
      console.log("[debug] resolve flow:", JSON.stringify(debug));
      const dom = await read(win, `(() => {
        const card = document.querySelector('[data-failure-id="click-failure-1"]');
        return {
          exists: !!card,
          hasResolved: !!card?.querySelector('.failure-resolved'),
          outerSnippet: card?.outerHTML?.slice(0, 300) ?? null
        };
      })()`);
      console.log("[debug] DOM after resolve:", JSON.stringify(dom));
      return dom.hasResolved === true;
    }
  }));
  clicks.push(await clickAndRead(win, '.failure-card[data-failure-id="click-failure-1"] summary', {
    label: "failure-diagnostics-summary",
    expect: () => read(win, "document.querySelector('[data-failure-id=\"click-failure-1\"] details')?.open === true")
  }));
  clicks.push(await clickAndRead(win, "#refresh", {
    label: "failure-refresh-after-resolve",
    settleMs: 450,
    expect: () => read(win, "document.querySelectorAll('[data-failure-id=\"click-failure-1\"]').length === 1")
  }));

  clicks.push(await clickAndRead(win, "#cbar-slash", {
    label: "cbar-slash",
    expect: () => read(win, "document.getElementById('slash-menu').hidden === false")
  }));
  clicks.push(await clickAndRead(win, ".slash-item", {
    label: "slash-first-item",
    expect: () => read(win, "document.getElementById('composer-input').value.length > 0")
  }));
  const submitEnabled = await read(win, `
    (() => {
      const input = document.getElementById("composer-input");
      input.value = "/ask 现在写到哪里了？";
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: input.value }));
      return document.getElementById("composer-submit").disabled === false;
    })()
  `);
  assert.equal(submitEnabled, true, "composer submit should become enabled after text input");
  clicks.push(await clickAndRead(win, "#composer-submit", {
    label: "composer-submit-side-question",
    settleMs: 750
  }));

  const motionReady = await read(win, "Boolean(window.__wwritingMotionReady)");
  assert.equal(motionReady, true, "motion runtime must initialize in Electron");
  for (const message of consoleMessages) {
    assert.ok(!String(message.message).includes("Failed to resolve module specifier"), `module resolution error: ${message.message}`);
    assert.ok(!String(message.message).includes("MIME"), `module MIME error: ${message.message}`);
  }

  const visibleButtons = await read(win, `
    [...document.querySelectorAll('button')]
      .filter((button) => !button.disabled && button.offsetParent !== null)
      .map((button) => ({
        id: button.id || null,
        className: String(button.className || ""),
        text: button.textContent.trim().replace(/\\s+/gu, " ").slice(0, 40)
      }))
  `);
  const result = {
    ok: clicks.every((click) => click.clicked && click.expectationPassed && click.errors.length === 0),
    projectRoot,
    newNovel,
    settings,
    clicks,
    visibleButtons,
    consoleMessages
  };
  console.log(JSON.stringify(result, null, 2));

  for (const click of clicks) {
    assert.equal(click.clicked, true, `${click.label} must receive a trusted pointer click`);
    assert.equal(click.expectationPassed, true, `${click.label} did not produce the expected UI state`);
    assert.deepEqual(click.errors, [], `${click.label} click errors: ${click.errors.join("\n")}`);
  }

  cleanup(0);
}

app.on("window-all-closed", () => cleanup(0));

async function clickAndRead(win, selector, { label = selector, expect = null, settleMs = 180, consoleMessages = [] } = {}) {
  await win.webContents.executeJavaScript(`
    (() => {
      const selector = ${JSON.stringify(selector)};
      const el = document.querySelector(selector);
      if (!el) return false;
      el.addEventListener("click", () => {
        window.__wwClickProbe.clicks[selector] = (window.__wwClickProbe.clicks[selector] || 0) + 1;
      }, { capture: true, once: true });
      return true;
    })();
  `);
  const before = await probe(win, selector);
  assert.ok(before.rect, `${label} must have a layout box: ${JSON.stringify({ ...before, consoleMessages }, null, 2)}`);
  win.webContents.sendInputEvent({ type: "mouseMove", x: before.center.x, y: before.center.y });
  win.webContents.sendInputEvent({ type: "mouseDown", x: before.center.x, y: before.center.y, button: "left", clickCount: 1 });
  win.webContents.sendInputEvent({ type: "mouseUp", x: before.center.x, y: before.center.y, button: "left", clickCount: 1 });
  await delay(settleMs);
  const after = await probe(win, selector);
  const expectationPassed = expect ? await expect() : true;
  return {
    label,
    rect: before.rect,
    center: before.center,
    targetAtCenter: before.targetAtCenter,
    clicked: (after.clickCount ?? 0) > (before.clickCount ?? 0),
    expectationPassed,
    errors: after.errors
  };
}

async function clickAndReadStable(win, selector, options = {}) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    last = await clickAndRead(win, selector, options);
    if (last.clicked && last.expectationPassed && last.errors.length === 0) return last;
    await clearStaleClosingStates(win);
    await delay(120);
  }
  assert.equal(last?.clicked, true, `${options.label ?? selector} must receive a trusted pointer click after retries: ${JSON.stringify(last, null, 2)}`);
  assert.equal(last?.expectationPassed, true, `${options.label ?? selector} did not produce the expected UI state after retries: ${JSON.stringify(last, null, 2)}`);
  assert.deepEqual(last?.errors ?? [], [], `${options.label ?? selector} click errors after retries`);
  return last;
}

async function probe(win, selector) {
  return win.webContents.executeJavaScript(`
    (() => {
      const button = document.querySelector(${JSON.stringify(selector)});
      const rect = button?.getBoundingClientRect?.();
      const center = rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null;
      const target = center ? document.elementFromPoint(center.x, center.y) : null;
      return {
        rect: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null,
        center,
        targetAtCenter: target ? { id: target.id, className: String(target.className || ""), tag: target.tagName } : null,
        clickCount: window.__wwClickProbe?.clicks?.[${JSON.stringify(selector)}] ?? 0,
        errors: window.__wwClickProbe?.errors ?? [],
        railNavHtml: document.getElementById("rail-nav")?.innerHTML ?? null,
        visibleButtons: [...document.querySelectorAll("button")]
          .filter((el) => el.offsetParent !== null)
          .map((el) => ({
            id: el.id || null,
            className: String(el.className || ""),
            text: el.textContent.trim().replace(/\\s+/gu, " ").slice(0, 80)
          })),
        scripts: [...document.scripts].map((script) => ({
          src: script.src,
          type: script.type,
          noModule: script.noModule
        })),
        resources: performance.getEntriesByType("resource").map((entry) => ({
          name: entry.name,
          initiatorType: entry.initiatorType,
          transferSize: entry.transferSize,
          decodedBodySize: entry.decodedBodySize
        }))
      };
    })();
  `);
}

async function assertQuickRailPopoverClears(win) {
  const chaptersSelector = '.quick-rail .qr-slot[data-key="chapters"]';
  const chapters = await triggerQuickRailHover(win, chaptersSelector);
  assert.ok(chapters.rect, `chapters quick rail slot must have a layout box: ${JSON.stringify(chapters, null, 2)}`);
  await waitUntil(win, "document.querySelectorAll('.qr-popover').length === 1", "hovering chapters quick rail slot must show exactly one popover");
  win.webContents.sendInputEvent({ type: "mouseDown", x: chapters.center.x, y: chapters.center.y, button: "left", clickCount: 1 });
  win.webContents.sendInputEvent({ type: "mouseUp", x: chapters.center.x, y: chapters.center.y, button: "left", clickCount: 1 });
  await delay(80);
  assert.equal(
    await read(win, "document.querySelectorAll('.qr-popover').length"),
    0,
    "clicking a quick rail slot must clear its popover"
  );
  await closeDrawerIfOpen(win);

  const research = await triggerQuickRailHover(win, '.quick-rail .qr-slot[data-key="research"]');
  assert.ok(research.rect, `research quick rail slot must have a layout box: ${JSON.stringify(research, null, 2)}`);
  await waitUntil(win, "document.querySelectorAll('.qr-popover').length === 1", "hovering research quick rail slot must show exactly one popover before blur");
  await win.webContents.executeJavaScript(`window.dispatchEvent(new Event("blur")); true;`);
  await delay(40);
  assert.equal(
    await read(win, "document.querySelectorAll('.qr-popover').length"),
    0,
    "window blur must clear a quick rail popover"
  );
  await win.webContents.executeJavaScript(`window.dispatchEvent(new Event("focus")); true;`);
  await delay(40);
}

async function assertRailPrimaryEntriesSeparate(win) {
  const result = await win.webContents.executeJavaScript(`
    (() => {
      const selectors = ["#new-novel", "#open-folder"];
      const entries = Object.fromEntries(selectors.map((selector) => {
        const el = document.querySelector(selector);
        const rect = el?.getBoundingClientRect?.();
        const center = rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null;
        const target = center ? document.elementFromPoint(center.x, center.y) : null;
        return [selector, {
          rect: rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height } : null,
          center,
          centerHitsSelf: Boolean(target?.closest?.(selector))
        }];
      }));
      const a = entries["#new-novel"].rect;
      const b = entries["#open-folder"].rect;
      const intersects = Boolean(a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top);
      return { entries, intersects };
    })();
  `);
  assert.ok(result.entries["#new-novel"].rect, `#new-novel must have a layout box: ${JSON.stringify(result, null, 2)}`);
  assert.ok(result.entries["#open-folder"].rect, `#open-folder must have a layout box: ${JSON.stringify(result, null, 2)}`);
  assert.equal(result.intersects, false, `#new-novel and #open-folder must not overlap: ${JSON.stringify(result, null, 2)}`);
  assert.equal(result.entries["#new-novel"].centerHitsSelf, true, `#new-novel center point must hit its button: ${JSON.stringify(result, null, 2)}`);
  assert.equal(result.entries["#open-folder"].centerHitsSelf, true, `#open-folder center point must hit its button: ${JSON.stringify(result, null, 2)}`);
}

async function triggerQuickRailHover(win, selector) {
  const target = await probe(win, selector);
  assert.ok(target.rect, `${selector} must have a layout box: ${JSON.stringify(target, null, 2)}`);
  win.webContents.sendInputEvent({ type: "mouseMove", x: target.center.x, y: target.center.y });
  await win.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      el?.focus?.();
      el?.dispatchEvent(new MouseEvent("mouseover", { view: window, bubbles: true }));
      el?.dispatchEvent(new MouseEvent("mouseenter", { view: window, bubbles: false }));
      return true;
    })();
  `);
  return target;
}

async function closeDrawerIfOpen(win) {
  const drawerOpen = await read(win, "document.getElementById('drawer')?.classList.contains('show') === true");
  if (!drawerOpen) return;
  await win.webContents.executeJavaScript(`
    (() => {
      document.getElementById("drawer-close")?.click();
      return true;
    })();
  `);
  await waitUntil(win, "document.getElementById('drawer')?.classList.contains('show') === false", "quick rail popover probe must restore the drawer to closed state");
  await clearStaleClosingStates(win);
  assert.equal(await read(win, "document.getElementById('drawer')?.dataset.closing !== 'true'"), true, "quick rail popover probe must wait until drawer closing state is cleared");
  assert.equal(await read(win, "document.getElementById('drawer-scrim')?.dataset.closing !== 'true'"), true, "quick rail popover probe must wait until drawer scrim closing state is cleared");
}

async function closeTransientOverlays(win) {
  await win.webContents.executeJavaScript(`
    (() => {
      if (document.getElementById("reader-scrim")?.classList.contains("show")) {
        document.getElementById("reader-close")?.click();
      }
      if (document.getElementById("settings-scrim")?.classList.contains("show")) {
        document.getElementById("settings-cancel")?.click();
      }
      if (document.getElementById("create-scrim")?.classList.contains("show")) {
        document.getElementById("create-x")?.click();
      }
      return true;
    })();
  `);
  await delay(350);
  assert.equal(await overlayHidden(win, "reader-scrim"), true, "reader overlay must be closed before switching drawer tabs");
  assert.equal(await overlayHidden(win, "settings-scrim"), true, "settings overlay must be closed before switching drawer tabs");
  assert.equal(await overlayHidden(win, "create-scrim"), true, "create overlay must be closed before switching drawer tabs");
}

async function clearStaleClosingStates(win) {
  await win.webContents.executeJavaScript(`
    (() => {
      for (const id of ["reader-scrim", "settings-scrim", "create-scrim", "drawer-scrim"]) {
        const el = document.getElementById(id);
        if (el && !el.classList.contains("show")) delete el.dataset.closing;
      }
      const drawer = document.getElementById("drawer");
      if (drawer && !drawer.classList.contains("show") && drawer.getAttribute("aria-hidden") === "true") {
        delete drawer.dataset.closing;
      }
      if (drawer && drawer.classList.contains("show") && drawer.getAttribute("aria-hidden") === "false") {
        delete drawer.dataset.closing;
        drawer.removeAttribute("inert");
      }
      const drawerScrim = document.getElementById("drawer-scrim");
      if (drawerScrim?.classList.contains("show")) {
        delete drawerScrim.dataset.closing;
      }
      return true;
    })();
  `);
}

function overlayVisible(win, id) {
  return read(win, `document.getElementById(${JSON.stringify(id)})?.classList.contains("show") === true`);
}

function overlayHidden(win, id) {
  return read(win, `document.getElementById(${JSON.stringify(id)})?.classList.contains("show") === false`);
}

function read(win, expression) {
  return win.webContents.executeJavaScript(`(() => (${expression}))();`);
}

async function waitForServer(targetPort) {
  const started = Date.now();
  while (Date.now() - started < 8000) {
    try {
      const response = await fetch(`http://127.0.0.1:${targetPort}/api/dashboard`);
      if (response.ok) return;
    } catch {}
    await delay(120);
  }
  throw new Error("server not ready");
}

async function waitUntil(win, expression, message, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await read(win, expression)) return;
    await delay(50);
  }
  assert.equal(await read(win, expression), true, message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanup(code) {
  if (server) {
    server.close();
    server = null;
  }
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch {}
  app.exit(code);
}
