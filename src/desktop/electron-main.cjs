const { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeTheme } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { listenWithFallback } = require("./server-start.cjs");
const { desktopWindowChrome } = require("./window-chrome.cjs");
const { windowColors } = require("./window-colors.cjs");

const rootDir = path.resolve(__dirname, "..", "..");
let port = Number(process.env.PORT || 4173);
const smokeMode = process.env.WWRITING_ELECTRON_SMOKE === "1";
let server = null;
let smokeUserDataDir = null;

if (smokeMode) {
  smokeUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wwriting-electron-smoke-"));
  app.setPath("userData", smokeUserDataDir);
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("no-sandbox");
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-sandbox");
  app.commandLine.appendSwitch("disable-http-cache");
  app.commandLine.appendSwitch("disk-cache-size", "1");
}

app.whenReady().then(async () => {
  installLocalizedApplicationMenu();

  ipcMain.handle("wwriting:select-project-folder", async () => {
    const result = await dialog.showOpenDialog({
      title: "打开本地项目文件夹",
      properties: ["openDirectory"]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle("wwriting:reveal-path", async (_event, targetPath) => {
    const resolved = path.resolve(String(targetPath ?? ""));
    // 安全：只允许打开 rootDir 下的路径
    if (!resolved.startsWith(rootDir + path.sep) && resolved !== rootDir) {
      throw new Error("路径不在项目工作区内");
    }
    try {
      fs.mkdirSync(resolved, { recursive: true });
    } catch (err) {
      throw new Error(`无法创建目录: ${err.message}`);
    }
    const result = await shell.openPath(resolved);
    if (result) throw new Error(`无法打开路径: ${result}`);
    return true;
  });

  // 外部链接（Task 8）：main 进程重新解析 URL，只接受 http:/https: 才交给系统
  // 默认浏览器；渲染进程侧已对 [data-external-link] preventDefault，这里不依赖
  // 渲染进程自证，即使被绕过也只放行 http/https。
  ipcMain.handle("wwriting:open-external-url", async (_event, rawUrl) => {
    let url;
    try {
      url = new URL(String(rawUrl ?? ""));
    } catch {
      throw new Error("无效的链接");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("仅允许 http/https 链接");
    }
    await shell.openExternal(url.toString());
    return true;
  });

  const { createAppShellServer } = await import(pathToFileURL(path.join(rootDir, "src", "core", "app-server.mjs")).href);
  server = createAppShellServer({
    workspaceRoot: process.env.WORKSPACE_ROOT || rootDir,
    selectedProjectRoot: process.env.PROJECT_ROOT || null,
    staticRoot: path.join(rootDir, "src", "app-shell"),
    secretsRoot: app.getPath("userData"),
    port
  });
  port = await listenWithFallback(server, port, "127.0.0.1");

  await waitForServer(port);
  if (smokeMode) {
    const result = JSON.stringify({
      ok: true,
      desktopShell: "electron",
      loaded: `http://127.0.0.1:${port}`
    });
    process.stdout.write(`${result}\n`, () => {
      if (server) {
        server.close();
        server = null;
      }
      app.exit(0);
    });
    return;
  }

  const isDark = nativeTheme.shouldUseDarkColors;
  const backgroundColor = windowColors(isDark).background;
  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    show: true,
    backgroundColor,
    autoHideMenuBar: true,
    ...desktopWindowChrome(process.platform, isDark),
    webPreferences: {
      preload: path.join(__dirname, "electron-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  ipcMain.handle("wwriting:set-title-bar-theme", (_event, dark) => {
    const overlay = desktopWindowChrome(process.platform, dark).titleBarOverlay;
    if (overlay) {
      window.setTitleBarOverlay(overlay);
    }
    window.setBackgroundColor(windowColors(dark).background);
  });

  await window.loadURL(`http://127.0.0.1:${port}`);
});

app.on("window-all-closed", () => {
  app.quit();
});

let quitInProgress = false;

app.on("before-quit", async (event) => {
  if (quitInProgress) return;
  event.preventDefault();
  quitInProgress = true;
  // §4.4: 先调本地关停 API 让 server 优雅终止活跃任务
  if (server) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
        method: "POST",
        signal: AbortSignal.timeout(3000)
      });
    } catch {
      // 超时或 server 已不可达 — 忽略，直接 close
    }
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
  app.quit();
});

app.on("will-quit", () => {
  if (smokeUserDataDir) {
    try {
      fs.rmSync(smokeUserDataDir, { recursive: true, force: true });
    } catch {
      // Windows can briefly keep Chromium cache files locked after smoke exit.
    }
  }
});

async function waitForServer(targetPort) {
  const started = Date.now();
  while (Date.now() - started < 8000) {
    try {
      const response = await fetch(`http://127.0.0.1:${targetPort}/api/dashboard`);
      if (response.ok) {
        return;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  throw new Error("App shell server did not become ready.");
}

function installLocalizedApplicationMenu() {
  const template = [
    {
      label: "文件",
      submenu: [
        {
          label: "退出",
          role: "quit"
        }
      ]
    },
    {
      label: "编辑",
      submenu: [
        { label: "撤销", role: "undo" },
        { label: "重做", role: "redo" },
        { type: "separator" },
        { label: "剪切", role: "cut" },
        { label: "复制", role: "copy" },
        { label: "粘贴", role: "paste" },
        { label: "全选", role: "selectAll" }
      ]
    },
    {
      label: "视图",
      submenu: [
        { label: "重新加载", role: "reload" },
        { label: "强制重新加载", role: "forceReload" },
        { label: "切换开发者工具", role: "toggleDevTools" },
        { type: "separator" },
        { label: "实际大小", role: "resetZoom" },
        { label: "放大", role: "zoomIn" },
        { label: "缩小", role: "zoomOut" },
        { type: "separator" },
        { label: "切换全屏", role: "togglefullscreen" }
      ]
    },
    {
      label: "窗口",
      submenu: [
        { label: "最小化", role: "minimize" },
        { label: "关闭窗口", role: "close" }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
