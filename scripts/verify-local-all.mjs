import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const steps = [
  ["npm", ["test"]],
  ["npm", ["run", "verify:unified-agent"]],
  ["npm", ["run", "verify:app-shell"]],
  ["npm", ["run", "verify:desktop-shell"]],
  ["npm", ["run", "verify:electron-runtime"]],
  ["npm", ["run", "verify:app-clickability"]],
  ["npm", ["run", "package:dir"]],
  ["npm", ["run", "verify:packaged-dir"]],
  ["npm", ["run", "package:installer"]],
  ["npm", ["run", "verify:installer"]]
];

const results = [];
for (const [command, args] of steps) {
  const started = Date.now();
  const result = await run(command, args);
  results.push({
    command: [command, ...args].join(" "),
    exitCode: result.exitCode,
    elapsedMs: Date.now() - started
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      localVerification: true,
      steps: results
    },
    null,
    2
  )
);

function run(command, args) {
  const resolved = resolveCommand(command, args);
  return new Promise((resolve, reject) => {
    const child = spawn(resolved.command, resolved.args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      process.stderr.write(chunk);
    });
    child.once("exit", (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
    child.once("error", reject);
  });
}

function resolveCommand(command, args) {
  if (process.platform === "win32" && ["npm", "npx"].includes(command)) {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", command, ...args]
    };
  }
  return { command, args };
}
