const { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeTheme } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { listenWithFallback, closeServerGracefully } = require("./server-start.cjs");
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

// 应用单实例（Task 18）：请求单实例锁。拿不到锁说明已有实例在运行，
// 本次启动直接退出，不注册任何启动流程；拿到锁才注册 whenReady 启动
// 流程并监听 second-instance —— 后续再次启动时恢复并聚焦已有实例的
// 主窗口，然后退出本次启动。
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

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
      // B1：reveal 类 IPC 统一走 validateProjectRoot 白名单（resolveRevealTarget）。
      // 只接受验证后的项目根/从根派生的目录，任意路径一律拒绝——不信任渲染进程
      // 传入的路径，也不再用应用安装目录做前缀判断（项目可能在工作区之外）。
      const { resolveRevealTarget } = await import(
        pathToFileURL(path.join(rootDir, "src", "core", "app-dashboard.mjs")).href
      );
      const resolved = await resolveRevealTarget(targetPath ?? "");
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

    // 技能管理（Task 13）：选择技能文件夹 / 技能 ZIP 包（对话框只负责选路径，
    // 校验与导入由服务端 importer 完成）。
    ipcMain.handle("wwriting:select-skill-folder", async () => {
      const result = await dialog.showOpenDialog({
        title: "选择技能文件夹（含 SKILL.md）",
        properties: ["openDirectory"]
      });
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      return result.filePaths[0];
    });

    ipcMain.handle("wwriting:select-skill-zip", async () => {
      const result = await dialog.showOpenDialog({
        title: "选择技能 ZIP 包",
        properties: ["openFile"],
        filters: [{ name: "ZIP 档案", extensions: ["zip"] }]
      });
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      return result.filePaths[0];
    });

    // 打开技能目录（Task 13）：main 进程自己计算 canonical 技能根，绝不接受渲染进程
    // 传入任意 reveal 路径。global → %USERPROFILE%\.wwriting\skills；project →
    // <校验过的项目根>\skills（项目根必须是真实 WWriting 项目，保留现有项目目录
    // 安全规则）。scope 只允许 global / project。
    ipcMain.handle("wwriting:reveal-skill-directory", async (_event, scope, projectRoot) => {
      let target;
      if (scope === "global") {
        target = path.join(os.homedir(), ".wwriting", "skills");
      } else if (scope === "project") {
        const { validateProjectRoot } = await import(
          pathToFileURL(path.join(rootDir, "src", "core", "app-dashboard.mjs")).href
        );
        const root = await validateProjectRoot(String(projectRoot ?? ""));
        target = path.join(root, "skills");
      } else {
        throw new Error("无效的技能目录 scope");
      }
      try {
        fs.mkdirSync(target, { recursive: true });
      } catch (err) {
        throw new Error(`无法创建目录: ${err.message}`);
      }
      const result = await shell.openPath(target);
      if (result) throw new Error(`无法打开路径: ${result}`);
      return true;
    });

    // 启动体验（对齐 VS Code/Linear 等桌面应用惯例）：主窗口在服务端组装前就
    // 隐藏创建，Chromium 进程预热与后端初始化并行；首帧可绘（ready-to-show）才
    // 显示，背景色取窗口主题材料色，不出现白闪。服务组装失败时销毁空窗并弹系统
    // 错误框退出，不留永久空白窗口。
    let window = null;
    try {
      if (!smokeMode) {
        const isDark = nativeTheme.shouldUseDarkColors;
        window = new BrowserWindow({
          width: 1320,
          height: 860,
          minWidth: 980,
          minHeight: 680,
          show: false,
          backgroundColor: windowColors(isDark).background,
          autoHideMenuBar: true,
          ...desktopWindowChrome(process.platform, isDark),
          webPreferences: {
            preload: path.join(__dirname, "electron-preload.cjs"),
            contextIsolation: true,
            nodeIntegration: false
          }
        });
        window.once("ready-to-show", () => window.show());

        ipcMain.handle("wwriting:set-title-bar-theme", (_event, dark) => {
          const overlay = desktopWindowChrome(process.platform, dark).titleBarOverlay;
          if (overlay) window.setTitleBarOverlay(overlay);
          window.setBackgroundColor(windowColors(dark).background);
        });
      }

      const { createAppShellServer } = await import(pathToFileURL(path.join(rootDir, "src", "core", "app-server.mjs")).href);
      server = createAppShellServer({
        workspaceRoot: process.env.WORKSPACE_ROOT || rootDir,
        selectedProjectRoot: process.env.PROJECT_ROOT || null,
        staticRoot: path.join(rootDir, "src", "app-shell"),
        secretsRoot: app.getPath("userData"),
        port
      });
      port = await listenWithFallback(server, port, "127.0.0.1");

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

      // 后端就绪探测与首屏加载并行：dashboard 冷启动不再串行挡住页面渲染；
      // ready-to-show 触发显示，两者谁先完成都不让用户多等。
      await Promise.all([
        window.loadURL(`http://127.0.0.1:${port}`),
        waitForServer(port)
      ]);
    } catch (error) {
      window?.destroy();
      dialog.showErrorBox("WWriting 启动失败", String(error?.stack ?? error));
      app.exit(1);
    }
  });
}

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
    // B17：server.close 无超时会因残留 keep-alive 连接拖死退出流程——
    // closeServerGracefully 在超时后调用 closeAllConnections 并 resolve。
    await closeServerGracefully(server, { timeoutMs: 5000 });
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
      // 服务器尚未可达：与非 ok 响应同走下方统一退避（非 ok 不退避会热循环 8 秒）。
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
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
