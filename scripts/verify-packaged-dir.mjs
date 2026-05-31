import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const appDir = path.resolve("dist-desktop", "win-unpacked");
const exePath = path.join(appDir, "WWriting Novel Agent.exe");
const appAsar = path.join(appDir, "resources", "app.asar");
const port = 5000 + Math.floor(Math.random() * 300);

await fs.access(exePath);
await fs.access(appAsar);

const child = spawn(exePath, [
  "--no-sandbox",
  "--disable-gpu",
  "--disable-gpu-sandbox",
  "--disable-gpu-compositing",
  "--disable-http-cache",
  "--disk-cache-size=1"
], {
  cwd: appDir,
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
assert.ok(jsonLine, `Packaged app smoke output missing JSON. stdout=${stdout} stderr=${stderr}`);
const result = JSON.parse(jsonLine);
assert.equal(result.ok, true);
assert.equal(result.loaded, `http://127.0.0.1:${port}`);

console.log(
  JSON.stringify(
    {
      ok: true,
      packagedDir: appDir,
      executable: exePath,
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
      reject(new Error(`Packaged Electron app smoke test timed out. stdout=${output.stdout} stderr=${output.stderr}`));
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
