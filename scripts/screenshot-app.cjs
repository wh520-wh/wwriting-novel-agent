const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { desktopWindowChrome } = require("../src/desktop/window-chrome.cjs");
const { listenWithFallback } = require("../src/desktop/server-start.cjs");

const rootDir = path.resolve(__dirname, "..");
let port = Number(process.env.PORT || 4319);
const outDir = path.resolve(process.env.OUT_DIR || path.join(os.tmpdir(), "ww-shots"));
const projectRoot = process.env.PROJECT_ROOT || null;
const width = Number(process.env.SHOT_WIDTH || 1360);
const height = Number(process.env.SHOT_HEIGHT || 880);

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ww-shot-userdata-"));
app.setPath("userData", userDataDir);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-gpu-sandbox");
app.commandLine.appendSwitch("disable-http-cache");

let server = null;

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const { createAppShellServer } = await import(pathToFileURL(path.join(rootDir, "src", "core", "app-server.mjs")).href);
  server = createAppShellServer({
    workspaceRoot: process.env.WORKSPACE_ROOT || rootDir,
    selectedProjectRoot: projectRoot,
    staticRoot: path.join(rootDir, "src", "app-shell"),
    secretsRoot: userDataDir,
    port
  });
  port = await listenWithFallback(server, port, "127.0.0.1");
  await waitForServer(port);

  const win = new BrowserWindow({
    width,
    height,
    show: true,
    backgroundColor: "#f4f3f0",
    ...desktopWindowChrome(),
    webPreferences: {
      preload: path.join(rootDir, "src", "desktop", "electron-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      offscreen: false
    }
  });
  await win.loadURL(`http://127.0.0.1:${port}`);
  await delay(1400);

  const shots = [];
  const views = (process.env.SHOT_VIEWS || "project,dashboard,settings,run,skills,research").split(",").map((v) => v.trim()).filter(Boolean);
  for (const view of views) {
    try {
      await win.webContents.executeJavaScript(
        `document.querySelector('[data-view-button="${view}"]')?.click(); true;`
      );
    } catch {}
    await delay(450);
    const image = await win.webContents.capturePage();
    const file = path.join(outDir, `view-${view}.png`);
    fs.writeFileSync(file, image.toPNG());
    shots.push(file);
  }

  process.stdout.write(`${JSON.stringify({ ok: true, outDir, shots }, null, 2)}\n`, () => {
    if (server) server.close();
    app.exit(0);
  });
});

app.on("window-all-closed", () => app.quit());

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
