import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runShellCommand } from "../src/core/chat/shell-runtime.mjs";

test("shell 返回 cwd、增量输出和退出码", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ww-shell-"));
  const chunks = [];
  const command = `"${process.execPath}" -e "console.log(process.cwd()); console.error('stderr-line')"`;
  const out = await runShellCommand({ command, cwd, timeoutMs: 5000, onOutput: (event) => chunks.push(event) });
  assert.equal(out.exitCode, 0);
  assert.match(out.stdout, new RegExp(cwd.replaceAll("\\", "\\\\"), "i"));
  assert.match(out.stderr, /stderr-line/u);
  assert.ok(chunks.some((chunk) => chunk.stream === "stdout"));
  assert.ok(chunks.some((chunk) => chunk.stream === "stderr"));
});

test("shell 超时会终止进程树", async () => {
  const command = `"${process.execPath}" -e "setInterval(() => {}, 1000)"`;
  await assert.rejects(
    () => runShellCommand({ command, cwd: os.tmpdir(), timeoutMs: 50 }),
    (error) => error.code === "shell_timeout"
  );
});

test("shell 响应 AbortSignal", async () => {
  const controller = new AbortController();
  const command = `"${process.execPath}" -e "setInterval(() => {}, 1000)"`;
  const pending = runShellCommand({ command, cwd: os.tmpdir(), timeoutMs: 5000, signal: controller.signal });
  controller.abort("用户停止");
  await assert.rejects(pending, (error) => error.code === "shell_cancelled");
});

test("shell spawn 失败时 reject 且不挂起", async () => {
  const missingCwd = path.join(os.tmpdir(), "ww-shell-missing-", String(Date.now()));
  await assert.rejects(
    () => runShellCommand({ command: "echo hi", cwd: missingCwd, timeoutMs: 5000 }),
    (error) => error.code === "ENOENT" || error.code === "shell_spawn_failed"
  );
});
