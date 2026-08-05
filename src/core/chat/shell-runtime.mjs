import { spawn } from "node:child_process";

const MAX_CAPTURE_CHARS = 1024 * 1024;

export function runShellCommand({ command, cwd, timeoutMs = 120000, signal, onOutput = () => {} }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error("命令已停止。");
      error.code = "shell_cancelled";
      error.stdout = "";
      error.stderr = "";
      error.durationMs = 0;
      reject(error);
      return;
    }
    const startedAt = Date.now();
    const child = spawn(String(command), {
      cwd,
      shell: true,
      windowsHide: true,
      env: process.env
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;

    const capture = (stream, chunk) => {
      const text = chunk.toString("utf8");
      if (stream === "stdout") stdout = `${stdout}${text}`.slice(-MAX_CAPTURE_CHARS);
      else stderr = `${stderr}${text}`.slice(-MAX_CAPTURE_CHARS);
      onOutput({ stream, text });
    };
    child.stdout?.on("data", (chunk) => capture("stdout", chunk));
    child.stderr?.on("data", (chunk) => capture("stderr", chunk));

    const finishError = async (code, message) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      await terminateProcessTree(child);
      const error = new Error(message);
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      error.durationMs = Date.now() - startedAt;
      reject(error);
    };
    const onAbort = () => void finishError("shell_cancelled", "命令已停止。");
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => void finishError("shell_timeout", `命令超过 ${timeoutMs}ms 未结束。`), timeoutMs);

    child.on("error", (error) => void finishError(error.code ?? "shell_spawn_failed", error.message));
    child.on("close", (exitCode, closeSignal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        command: String(command),
        cwd,
        stdout,
        stderr,
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal: closeSignal ?? null,
        durationMs: Date.now() - startedAt
      });
    });
  });
}

async function terminateProcessTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      killer.on("close", resolve);
      killer.on("error", resolve);
    });
    return;
  }
  child.kill("SIGTERM");
  setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 500).unref();
}
