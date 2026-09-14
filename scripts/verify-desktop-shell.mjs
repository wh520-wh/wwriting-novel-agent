import assert from "node:assert/strict";
import fs from "node:fs/promises";

const packageJson = JSON.parse(await fs.readFile("package.json", "utf8"));
const main = await fs.readFile("src/desktop/electron-main.cjs", "utf8");
const preload = await fs.readFile("src/desktop/electron-preload.cjs", "utf8");
const electronPackage = JSON.parse(await fs.readFile("node_modules/electron/package.json", "utf8"));

assert.equal(packageJson.scripts["desktop:electron"], "electron src/desktop/electron-main.cjs");
assert.equal(packageJson.scripts["package:dir"], "electron-builder --dir --win");
assert.equal(packageJson.scripts["package:installer"], "node scripts/package-installer.mjs");
assert.equal(packageJson.main, "src/desktop/electron-main.cjs");
assert.equal(packageJson.build.appId, "local.wwriting.novelagent");
assert.deepEqual(packageJson.build.win.target, ["dir", "nsis"]);
assert.equal(packageJson.build.nsis.oneClick, false);
assert.equal(packageJson.build.nsis.allowToChangeInstallationDirectory, true);
assert.ok(packageJson.devDependencies?.electron);
assert.ok(packageJson.devDependencies?.["electron-builder"]);
assert.equal(electronPackage.name, "electron");
assert.ok(main.includes("BrowserWindow"));
assert.ok(main.includes("Menu"));
assert.ok(main.includes("installLocalizedApplicationMenu"));
assert.ok(main.includes("Menu.setApplicationMenu"));
assert.ok(main.includes('label: "文件"'));
assert.ok(main.includes('label: "编辑"'));
assert.ok(main.includes('label: "视图"'));
assert.ok(main.includes('label: "窗口"'));
assert.ok(main.includes('label: "退出"'));
assert.ok(main.includes("desktopWindowChrome"), "desktop shell should use the shared window chrome helper");
assert.ok(/\.\.\.desktopWindowChrome\s*\(/.test(main), "desktop shell should apply the shared window chrome helper");
assert.ok(main.includes("app-server.mjs"));
assert.ok(main.includes("contextIsolation: true"));
assert.ok(main.includes("nodeIntegration: false"));
assert.ok(main.includes("WWRITING_ELECTRON_SMOKE"));
// 启动体验契约：窗口先行隐藏创建（ready-to-show 才显示），首屏加载与服务就绪
// 探测并行，服务组装失败销毁窗口并弹错误框。
assert.ok(main.includes("ready-to-show"), "主窗口应 ready-to-show 再显示，避免空白帧");
assert.ok(/Promise\.all\(\[\s*window\.loadURL/u.test(main.replace(/\s+/g, " ")),
  "loadURL 与 waitForServer 应并行");
assert.ok(main.includes("dialog.showErrorBox"), "启动失败应有系统错误框兜底");
assert.ok(preload.includes("contextBridge"));

console.log(
  JSON.stringify(
    {
      ok: true,
      desktopShell: "electron",
      main: "src/desktop/electron-main.cjs",
      preload: "src/desktop/electron-preload.cjs",
      electronPackageInstalled: true,
      packageDirScript: true,
      packageInstallerScript: true
    },
    null,
    2
  )
);
