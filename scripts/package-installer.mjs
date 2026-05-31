import { spawn } from "node:child_process";
import path from "node:path";

const cacheDir = path.resolve(".electron-builder-cache");
const command = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "npx";
const args = process.platform === "win32"
  ? ["/d", "/s", "/c", "npx", "electron-builder", "--win", "nsis"]
  : ["electron-builder", "--win", "nsis"];
const child = spawn(command, args, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ELECTRON_BUILDER_CACHE: cacheDir,
    ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/"
  },
  stdio: "inherit",
  windowsHide: true
});

child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});

child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
