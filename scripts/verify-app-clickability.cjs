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
  clicks.push(await clickAndRead(win, ".rail-nav .nav-item:nth-of-type(2)", { label: "nav-search", consoleMessages }));
  clicks.push(await clickAndRead(win, ".rail-nav .nav-item:nth-of-type(3)", {
    label: "nav-skill",
    expect: () => read(win, "document.getElementById('drawer').classList.contains('show') === true && document.querySelector('[data-dtab=\"run\"]').getAttribute('aria-selected') === 'true'")
  }));
  clicks.push(await clickAndRead(win, "#drawer-close", {
    label: "nav-skill-drawer-close",
    expect: () => read(win, "document.getElementById('drawer').classList.contains('show') === false")
  }));
  clicks.push(await clickAndRead(win, ".rail-nav .nav-item:nth-of-type(5)", { label: "nav-auto" }));
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
    expect: () => overlayVisible(win, "create-scrim")
  }));
  clicks.push(await clickAndRead(win, "#create-x", {
    label: "open-folder-create-close",
    expect: () => overlayHidden(win, "create-scrim")
  }));
  clicks.push(await clickAndRead(win, ".proj.active", { label: "active-project" }));

  const newNovel = await clickAndRead(win, "#new-novel", {
    label: "new-novel",
    expect: () => overlayVisible(win, "create-scrim")
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
  clicks.push(await clickAndRead(win, ".sp-item:not(.on)", { label: "settings-provider-row" }));
  clicks.push(await clickAndRead(win, "#settings-add", {
    label: "settings-add",
    expect: () => read(win, "document.querySelector('#settings-provider-list .sp-item.on')?.textContent.includes('OpenAI') === true")
  }));
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

  const modalClosedState = await read(win, `
    (() => {
      const settings = document.getElementById("settings-scrim");
      const create = document.getElementById("create-scrim");
      return settings.hasAttribute("inert") && create.hasAttribute("inert");
    })()
  `);
  assert.equal(modalClosedState, true, "settings/create overlays must be inert after close");

  clicks.push(await clickAndRead(win, '.quick-rail .qr-slot[data-key="chapters"]', {
    label: "open-chapters",
    expect: () => read(win, "document.getElementById('drawer').classList.contains('show') && document.querySelector('[data-dtab=\"chapters\"]').getAttribute('aria-selected') === 'true'")
  }));
  clicks.push(await clickAndRead(win, ".chrow.completed", {
    label: "completed-chapter-row",
    expect: () => overlayVisible(win, "reader-scrim")
  }));
  clicks.push(await clickAndRead(win, "#reader-close", {
    label: "reader-close",
    expect: () => overlayHidden(win, "reader-scrim")
  }));
  clicks.push(await clickAndRead(win, "[data-dtab=\"model\"]", {
    label: "drawer-model-tab",
    expect: () => read(win, "document.querySelector('[data-dtab=\"model\"]').getAttribute('aria-selected') === 'true'")
  }));
  clicks.push(await clickAndRead(win, ".drawer-body .save-btn", {
    label: "drawer-open-model-settings",
    expect: () => overlayVisible(win, "settings-scrim")
  }));
  clicks.push(await clickAndRead(win, "#settings-cancel", {
    label: "settings-cancel",
    expect: () => overlayHidden(win, "settings-scrim")
  }));
  clicks.push(await clickAndRead(win, "[data-dtab=\"run\"]", {
    label: "drawer-run-tab",
    expect: () => read(win, "document.querySelector('[data-dtab=\"run\"]').getAttribute('aria-selected') === 'true'")
  }));
  clicks.push(await clickAndRead(win, ".drawer-body .dpanel:nth-child(3) .small-button", {
    label: "skill-toggle",
    settleMs: 650
  }));
  clicks.push(await clickAndRead(win, ".research-form .small-button", { label: "research-empty-search" }));
  clicks.push(await clickAndRead(win, ".research-form button:last-of-type", { label: "research-empty-fetch" }));
  clicks.push(await clickAndRead(win, "#drawer-close", {
    label: "drawer-close",
    expect: () => read(win, "document.getElementById('drawer').classList.contains('show') === false")
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
  clicks.push(await clickAndRead(win, "#drawer-scrim", {
    label: "drawer-scrim-close",
    expect: () => read(win, "document.getElementById('drawer').classList.contains('show') === false")
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
    targetAtCenter: before.targetAtCenter,
    clicked: (after.clickCount ?? 0) > (before.clickCount ?? 0),
    expectationPassed,
    errors: after.errors
  };
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
