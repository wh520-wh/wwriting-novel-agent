// src/core/shell/runtime.mjs
//
// 统一 Agent 内核计划 Task 4：从前置计划 `src/core/chat/shell-runtime.mjs` 端口迁入
// 的 Shell 运行时，可观察行为保持不变（同一契约，见 tests/helpers/project-agent-harness.mjs
// 的 shell port 形状冻结）。
//
// 行为契约（前置计划已验收，不得退化）：
//   - spawn(..., { shell: true, windowsHide: true })，命令按 cmd/sh 语义解析，调用方自行转义；
//   - cwd 可选；timeoutMs 缺省 120000ms；超时/abort 终止整棵进程树；
//   - 增量 stdout/stderr 回调（onOutput({ stream, text })）；
//   - 退出码、close 信号与耗时（durationMs，终止路径在终止进程树之前记录）；
//   - stdout 与 stderr 各自独立保留最后 1 MiB（不是合并上限）；
//   - Windows 用 `taskkill /T /F` 递归终止进程树；POSIX 用 detached 进程组，
//     SIGTERM 后 500ms SIGKILL 兜底；
//   - 调用前已 abort 直接 reject（code=shell_cancelled）且不 spawn；
//   - spawn 失败 reject（透传 error.code，兜底 shell_spawn_failed），不挂起。
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
      env: process.env,
      // POSIX 下 detached 让 sh 成为新进程组组长，便于按组终止整棵进程树；
      // Windows 下不能开启（DETACHED_PROCESS 会破坏 cmd 的管道捕获，stdout 变空），
      // 进程树终止由 taskkill /T 负责，taskkill 对 detached 与否一视同仁。
      detached: process.platform !== "win32"
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;

    const capture = (stream, chunk) => {
      if (settled) return; // kill 生效前 data 事件仍会到达，settle 后不再捕获/回调
      const text = chunk.toString("utf8");
      if (stream === "stdout") {
        stdout += text;
        if (stdout.length > MAX_CAPTURE_CHARS) stdout = stdout.slice(-MAX_CAPTURE_CHARS);
      } else {
        stderr += text;
        if (stderr.length > MAX_CAPTURE_CHARS) stderr = stderr.slice(-MAX_CAPTURE_CHARS);
      }
      onOutput({ stream, text });
    };
    child.stdout?.on("data", (chunk) => capture("stdout", chunk));
    child.stderr?.on("data", (chunk) => capture("stderr", chunk));

    const finishError = async (code, message) => {
      if (settled) return; // settled 后双 settle：清理已做过，直接忽略后续超时/abort/error 事件
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // durationMs 在终止进程树之前记录，超时路径的耗时不应包含 taskkill 等待
      const durationMs = Date.now() - startedAt;
      await terminateProcessTree(child);
      const error = new Error(message);
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      error.durationMs = durationMs;
      reject(error);
    };
    const onAbort = () => void finishError("shell_cancelled", "命令已停止。").catch(reject);
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(
      () => void finishError("shell_timeout", `命令超过 ${timeoutMs}ms 未结束。`).catch(reject),
      timeoutMs
    );

    child.on("error", (error) => void finishError(error.code ?? "shell_spawn_failed", error.message).catch(reject));
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
    // taskkill /T /F：Windows 下递归终止整棵进程树，/F 强制结束
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      killer.on("close", resolve);
      killer.on("error", resolve);
    });
    return;
  }
  // POSIX：detached 使 sh 成为进程组组长，向负 pid 发信号即终止整组；
  // 仅 kill sh 会让 sh -c 启动的子进程（如 node）成孤儿继续运行。
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM"); // 进程组不存在时回退到直接杀 sh
  }
  // 500ms 后仍存活则 SIGKILL 兜底（进程组级），确保不留残留进程
  setTimeout(() => {
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }, 500).unref();
}
