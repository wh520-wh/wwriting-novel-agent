import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const port = 4700 + Math.floor(Math.random() * 300);
const require = createRequire(import.meta.url);
const electronBin = resolveElectronBinary();
const smokeArgs = [
  "--no-sandbox",
  "--disable-gpu",
  "--disable-gpu-sandbox",
  "--disable-gpu-compositing",
  "--disable-http-cache",
  "--disk-cache-size=1",
  "src/desktop/electron-main.cjs"
];

const child = spawn(electronBin, smokeArgs, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    WWRITING_ELECTRON_SMOKE: "1"
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString("utf8");
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

const exitCode = await waitForExit(child, 30000, () => ({ stdout, stderr }));
assert.equal(exitCode, 0, stderr);
const jsonLine = stdout
  .split(/\r?\n/u)
  .filter(Boolean)
  .find((line) => line.trim().startsWith("{"));
assert.ok(jsonLine, `Electron smoke output missing JSON. stdout=${stdout} stderr=${stderr}`);
const result = JSON.parse(jsonLine);
assert.equal(result.ok, true);
assert.equal(result.desktopShell, "electron");
const loadedUrl = new URL(result.loaded);
assert.equal(loadedUrl.hostname, "127.0.0.1");
assert.ok(Number(loadedUrl.port) > 0);

console.log(
  JSON.stringify(
    {
      ok: true,
      desktopShell: "electron",
      loaded: result.loaded
    },
    null,
    2
  )
);

function waitForExit(processHandle, timeoutMs, readOutput) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      processHandle.kill();
      const output = readOutput();
      reject(new Error(`Electron runtime smoke test timed out. stdout=${output.stdout} stderr=${output.stderr}`));
    }, timeoutMs);
    processHandle.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    processHandle.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function resolveElectronBinary() {
  const electronRoot = path.dirname(require.resolve("electron/package.json"));
  const pathFile = path.join(electronRoot, "path.txt");
  if (!fs.existsSync(pathFile)) {
    throw new Error("electron_binary_missing: node_modules/electron/path.txt is missing. Run npm rebuild electron or install-electron with network access.");
  }
  const executablePath = fs.readFileSync(pathFile, "utf8").trim();
  const binaryPath = path.join(electronRoot, "dist", executablePath);
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`electron_binary_missing: ${binaryPath} is missing. Run npm rebuild electron or install-electron with network access.`);
  }
  return binaryPath;
}
