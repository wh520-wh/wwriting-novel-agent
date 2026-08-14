// src/core/shell/runtime.mjs
//
// 统一 Agent 内核计划 Task 4：从前置计划的 shell-runtime 模块端口迁入的 Shell
// 运行时，可观察行为保持不变（同一契约，见 tests/helpers/project-agent-harness.mjs
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
//   - 可选 onActivity 钩子（Task 2）：spawn 与每次 stdout/stderr 输出时回调，
//     用于刷新调用方（工具空闲期限）的活动计数；缺省不回调，保持原签名向后兼容；
//   - spawn 失败 reject（透传 error.code，兜底 shell_spawn_failed），不挂起。
import { spawn } from "node:child_process";

const MAX_CAPTURE_CHARS = 1024 * 1024;

// 输出解码：UTF-8/GBK 嗅探窗口设计（Windows cmd 场景）。
//
// 不再按 chunk 逐个做 UTF-8 流式解码并在出错时临时切 GBK。旧实现有两个已核实的
// 失败模式：(1) 字节级分块时 UTF-8 流式解码器会把 GBK 首字节暂存，次字节到达时
// 已不构成非法序列，从而永不触发切换，首字节被吞掉，英文/中文混排输出乱码；
// (2) GBK 双字节对其二字节恰落在 0x80~0xBF 时可能是合法 UTF-8（如 `一`=D2 BB
// 会按 `һ` U+04BB 解码），在出错的字节之前到达就会以错误编码吐出且不可恢复。
//
// 本实现先缓冲一个"嗅探窗口"再决定模式：
//   - mode ∈ { "sniff", "utf8", "gbk" }；sniff 阶段把到达的 chunk 累进 buffer。
//   - 决定模式的时机：(a) buffer 出现换行（\n 或 \r\n，取到含换行为止）；
//     (b) buffer 达到上限（64 KiB，取整个 buffer）；(c) flush() 被调用（取整个 buffer）。
//   - 决定方式：用非流式 `TextDecoder("utf-8", { fatal: true })` 解码窗口；不抛错则
//     mode=utf8，返回窗口文本，其后 chunk 用 UTF-8 流式；抛错则 mode=gbk，把整个
//     窗口用 GBK 解码器整体解码（非流式即可），其后 chunk 用 GBK 流式。
//   - 锁定后 decode(chunk) 走对应 `TextDecoder(label, { stream: true })` 流式。
//   - flush()：仍在 sniff 则对整个 buffer 做一次窗口决定并输出；已锁定则调用锁定
//     解码器的 flush()（UTF-8 丢弃尾部不完整多字节；GBK 排空残余）。
//
// 已知边界（文档化）：同一个流内先输出 UTF-8 后来又输出 GBK 时无法自动识别——
// 首个窗口一旦被判定为 UTF-8 便锁定，其后 GBK 字节会按 UTF-8 误解码。真实 Windows
// cmd 输出整体统一为 GBK，是本实现覆盖的目标场景，此边界可接受。
//
// 每个 runShellCommand 调用为 stdout/stderr 各建一个实例——模块级单例会把
// 跨命令/跨流的解码状态互相污染（对抗审查结论），禁止使用。
const SNIFF_CAP_BYTES = 64 * 1024;

export function createOutputDecoder() {
  let mode = "sniff";
  let buffer = Buffer.alloc(0);
  let utf8 = null; // 仅在 mode=utf8 时非空（流式解码器）
  let gbk = null; // 仅在 mode=gbk 时非空（流式解码器）

  // 用非流式方式对窗口字节决定模式，返回窗口解码后的文本并锁定 mode。
  function decideWindow(windowBytes) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(windowBytes);
      mode = "utf8";
      utf8 = new TextDecoder("utf-8", { fatal: true });
      return text;
    } catch {
      mode = "gbk";
      gbk = new TextDecoder("gbk");
      return gbk.decode(windowBytes);
    }
  }

  return {
    decode(chunk) {
      const bytes = Buffer.from(chunk);
      if (mode === "utf8") return utf8.decode(bytes, { stream: true });
      if (mode === "gbk") return gbk.decode(bytes, { stream: true });

      // sniff：累入 buffer，待换行 / 达到上限之一才决定模式
      buffer = Buffer.concat([buffer, bytes]);
      const nl = buffer.indexOf(0x0a);
      if (nl === -1 && buffer.length < SNIFF_CAP_BYTES) return "";

      const end = nl === -1 ? buffer.length : nl + 1; // 换行存在则窗口取到含换行为止
      const windowBytes = buffer.subarray(0, end);
      const remainder = buffer.subarray(end);
      buffer = Buffer.alloc(0);

      let out = decideWindow(windowBytes);
      if (remainder.length) {
        const locked = mode === "utf8" ? utf8 : gbk;
        out += locked.decode(remainder, { stream: true });
      }
      return out;
    },
    flush() {
      if (mode === "sniff") {
        if (buffer.length === 0) return "";
        const out = decideWindow(buffer);
        buffer = Buffer.alloc(0);
        return out;
      }
      if (mode === "utf8") {
        try {
          return utf8.decode();
        } catch {
          return ""; // 丢弃未完成的尾随多字节
        }
      }
      return gbk.decode(); // GBK 排空残余
    }
  };
}

export function runShellCommand({ command, cwd, timeoutMs = 120000, signal, onOutput = () => {}, onActivity = () => {} }) {
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
    // Task 2：受控进程事件（spawn）计入工具活动（刷新调用方的空闲期限）
    onActivity();
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;

    // Task C9：stdout/stderr 各自持有独立解码器（UTF-8 优先，非法字节切 GBK）。
    // 每个 runShellCommand 调用新建，绝不复用模块级单例，避免跨命令/跨流状态污染。
    const stdoutDecoder = createOutputDecoder();
    const stderrDecoder = createOutputDecoder();
    const capture = (stream, chunk) => {
      if (settled) return; // kill 生效前 data 事件仍会到达，settle 后不再捕获/回调
      const text = stream === "stdout" ? stdoutDecoder.decode(chunk) : stderrDecoder.decode(chunk);
      if (stream === "stdout") {
        stdout += text;
        if (stdout.length > MAX_CAPTURE_CHARS) stdout = stdout.slice(-MAX_CAPTURE_CHARS);
      } else {
        stderr += text;
        if (stderr.length > MAX_CAPTURE_CHARS) stderr = stderr.slice(-MAX_CAPTURE_CHARS);
      }
      onOutput({ stream, text });
      onActivity();
    };
    child.stdout?.on("data", (chunk) => capture("stdout", chunk));
    child.stderr?.on("data", (chunk) => capture("stderr", chunk));
    let resolveChildClosed;
    const childClosed = new Promise((resolve) => {
      resolveChildClosed = resolve;
    });

    // 幂等的终止序列 Promise：首次调用时建立，并发 abort/timeout/error 事件复用同一
    // 等待链，杜绝二次 taskkill / 二次 settle。顺序固定：终止进程树 -> 原 child close
    // -> stdio close，全部完成后外层 Promise 才 reject（见 finishError）。
    let terminateTreePromise = null;
    const terminateTree = () => {
      if (!terminateTreePromise) {
        terminateTreePromise = (async () => {
          if (child.pid && child.exitCode === null) {
            if (process.platform === "win32") {
              await terminateWindowsTree(child);
            } else {
              terminatePosixTree(child);
            }
          }
          await waitForChildClose(childClosed, child);
        })();
      }
      return terminateTreePromise;
    };

    const finishError = async (code, message) => {
      if (settled) return; // settled 后双 settle：清理已做过，直接忽略后续超时/abort/error 事件
      settled = true; // 守卫标志必须在等待前设置：并发 abort+timeout 不会二次终止/二次 settle
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // durationMs 在终止进程树之前记录，超时路径的耗时不应包含 taskkill 等待
      const durationMs = Date.now() - startedAt;
      try {
        await terminateTree();
      } finally {
        const error = new Error(message);
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        error.durationMs = durationMs;
        reject(error);
      }
    };
    const onAbort = () => void finishError("shell_cancelled", "命令已停止。").catch(reject);
    child.on("close", (exitCode, closeSignal) => {
      resolveChildClosed();
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // Task C9：收尾解码器残余缓冲（UTF-8 尾部不完整多字节会被丢弃；若已切 GBK 则
      // 解码残余并计入捕获），保持与旧实现相同的 stdout/stderr 返回形状。
      stdout += stdoutDecoder.flush();
      stderr += stderrDecoder.flush();
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
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(
      () => void finishError("shell_timeout", `命令超过 ${timeoutMs}ms 未结束。`).catch(reject),
      timeoutMs
    );
    // 防御外部 signal 实现未按标准同步派发 abort 事件的情况。
    if (signal?.aborted) void onAbort();

    child.on("error", (error) => void finishError(error.code ?? "shell_spawn_failed", error.message).catch(reject));
  });
}

async function waitForChildClose(childClosed, child, timeoutMs = 2000) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      // taskkill 正常情况下会先触发 close；若系统拒绝 taskkill 或管道仍被
      // 后代进程持有，主动销毁本地句柄，避免 Agent/测试进程永久挂起。
      child.stdout?.destroy();
      child.stderr?.destroy();
      try {
        child.kill();
      } catch {
        // 子进程已经退出时忽略
      }
      resolve();
    }, timeoutMs);
    timer.unref?.();
  });
  await Promise.race([childClosed, timeout]);
  if (timer) clearTimeout(timer);
}

// Windows 专用：taskkill /PID <pid> /T /F 递归强制终止整棵进程树，等待 taskkill 的
// close 事件确认结果。仅当 taskkill error 或非零退出（如受限环境拒绝访问）时回退到
// 直接 kill 子进程，由 waitForChildClose 以 2 秒兜底收尾。taskkill 的退出码/输出仅供
// 诊断，绝不回传给最终用户（错误字段契约见 finishError）。
async function terminateWindowsTree(child) {
  await new Promise((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    killer.on("error", () => {
      try {
        child.kill();
      } catch {
        // 子进程已经退出时忽略
      }
      resolve();
    });
    killer.on("close", (exitCode) => {
      if (exitCode !== 0) {
        try {
          child.kill();
        } catch {
          // 子进程已经退出时忽略
        }
      }
      resolve();
    });
  });
}

// POSIX 专用：detached 使 sh 成为进程组组长，向负 pid 发信号即终止整组；
// 仅 kill sh 会让 sh -c 启动的子进程（如 node）成孤儿继续运行。
function terminatePosixTree(child) {
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
