import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const appDir = path.resolve("dist-desktop", "win-unpacked");
const exePath = path.join(appDir, "WWriting Novel Agent.exe");
const appAsar = path.join(appDir, "resources", "app.asar");
const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6697, 10080
]);
const port = await getFetchSafePort();

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

async function getFetchSafePort() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = await getFreePort();
    if (!FETCH_BLOCKED_PORTS.has(candidate)) {
      return candidate;
    }
  }
  throw new Error("Could not allocate a fetch-safe smoke-test port");
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => {
        if (!port) {
          reject(new Error("failed to allocate a free port"));
          return;
        }
        resolve(port);
      });
    });
  });
}
