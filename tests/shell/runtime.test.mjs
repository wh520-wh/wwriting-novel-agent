// src/core/shell/runtime.mjs 的迁移测试（统一 Agent 内核计划 Task 4）。
//
// 前置计划 tests/shell-runtime.test.mjs 的可观察用例全部迁入本文件（cwd、增量输出、
// 退出码/信号/耗时、超时、响应 AbortSignal、调用前已 abort、spawn 失败），并新增：
//   - 进程树停止（stop 后子进程不得再写 marker）
//   - stdout/stderr 各自独立保留最后 1 MiB（不是合并上限）
//   - 子进程回归测试：本文件作为子进程运行 `node --test` 必须在最终 TAP 结果后
//     5 秒内退出 0（关闭前置计划 known_baseline_defect：旧 shell 测试进程不退出）。
//     子进程内用环境变量标记，跳过本测试避免无限递归。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createOutputDecoder, runShellCommand } from "../../src/core/shell/runtime.mjs";

const SELF = fileURLToPath(import.meta.url);
const IN_SUBPROCESS = process.env.WW_RUNTIME_SUBPROCESS_TEST === "1";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("shell 返回 cwd、增量输出和退出码", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ww-shell-"));
  try {
    const chunks = [];
    const command = `"${process.execPath}" -e "console.log(process.cwd()); console.error('stderr-line')"`;
    const out = await runShellCommand({ command, cwd, timeoutMs: 5000, onOutput: (event) => chunks.push(event) });
    assert.equal(out.exitCode, 0);
    assert.equal(out.command, command);
    assert.equal(out.cwd, cwd);
    assert.equal(out.signal, null);
    assert.ok(out.durationMs >= 0);
    assert.match(out.stdout, new RegExp(cwd.replaceAll("\\", "\\\\"), "i"));
    assert.match(out.stderr, /stderr-line/u);
    assert.ok(chunks.some((chunk) => chunk.stream === "stdout"));
    assert.ok(chunks.some((chunk) => chunk.stream === "stderr"));
    // 增量捕获完整：所有 stdout/stderr 分片按序拼接后应等于最终捕获结果
    assert.equal(
      chunks.filter((c) => c.stream === "stdout").map((c) => c.text).join(""),
      out.stdout
    );
    assert.equal(
      chunks.filter((c) => c.stream === "stderr").map((c) => c.text).join(""),
      out.stderr
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("onActivity 在 spawn 与 stdout/stderr 输出时回调（Task 2 可选活动钩子）", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ww-shell-act-"));
  try {
    const streams = [];
    const activity = [];
    const command = `"${process.execPath}" -e "console.log('out-line'); console.error('err-line')"`;
    const out = await runShellCommand({
      command,
      cwd,
      timeoutMs: 5000,
      onOutput: (event) => streams.push(event.stream),
      onActivity: () => activity.push("act")
    });
    assert.equal(out.exitCode, 0);
    assert.ok(streams.includes("stdout"), "应有 stdout 输出");
    assert.ok(streams.includes("stderr"), "应有 stderr 输出");
    // spawn + 每次输出 = 至少 3 次活动回调；stdout/stderr 都驱动活动（空闲期限刷新口径）
    assert.ok(activity.length >= 3, `spawn+stdout+stderr 至少三次活动回调，实际 ${activity.length}`);
    assert.ok(activity.length >= streams.length + 1, `每次输出都对应活动回调（外加 spawn），实际 ${activity.length}`);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("shell 超时会终止进程树", async () => {
  const command = `"${process.execPath}" -e "setInterval(() => {}, 1000)"`;
  await assert.rejects(
    () => runShellCommand({ command, cwd: os.tmpdir(), timeoutMs: 200 }),
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

test("shell 取消返回后 cwd 可立即删除", { skip: process.platform !== "win32" }, async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ww-shell-release-"));
  const controller = new AbortController();
  const command = `"${process.execPath}" -e "setTimeout(()=>{},30000)"`;
  const pending = runShellCommand({ command, cwd, timeoutMs: 30000, signal: controller.signal });
  await sleep(200);
  controller.abort("用户停止");
  await assert.rejects(pending, (error) => error.code === "shell_cancelled");
  await assert.doesNotReject(
    () => fs.rm(cwd, { recursive: true, force: true }),
    "取消完成后不得仍有进程占用工作目录"
  );
});

test("shell 超时返回后 cwd 可立即删除", { skip: process.platform !== "win32" }, async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ww-shell-release-timeout-"));
  const command = `"${process.execPath}" -e "setTimeout(()=>{},30000)"`;
  await assert.rejects(
    () => runShellCommand({ command, cwd, timeoutMs: 200 }),
    (error) => error.code === "shell_timeout"
  );
  // 与取消路径同一断言：超时返回后不得仍有进程占用工作目录（Windows handle 锁）
  await assert.doesNotReject(
    () => fs.rm(cwd, { recursive: true, force: true }),
    "超时完成后不得仍有进程占用工作目录"
  );
});

test("shell 调用前已 abort 直接 reject 且不 spawn", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      runShellCommand({
        command: `"${process.execPath}" -e "setInterval(() => {}, 1000)"`,
        cwd: os.tmpdir(),
        signal: controller.signal
      }),
    (error) => error.code === "shell_cancelled"
  );
});

test("shell spawn 失败时 reject 且不挂起", async () => {
  const missingCwd = path.join(os.tmpdir(), "ww-shell-missing-", String(Date.now()));
  await assert.rejects(
    () => runShellCommand({ command: "echo hi", cwd: missingCwd, timeoutMs: 5000 }),
    (error) => error.code === "ENOENT" || error.code === "shell_spawn_failed"
  );
});

test("停止后整棵进程树被终止（子进程不得继续写文件）", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ww-shell-tree-"));
  // 相对 marker 名：避免绝对路径反斜杠在 cmd 引号解析中被打断（与验收场景一致）
  const markerName = "stop-marker.txt";
  const marker = path.join(cwd, markerName);
  try {
    const controller = new AbortController();
    const command =
      `"${process.execPath}" -e "setTimeout(function(){` +
      `require('fs').writeFileSync('${markerName}','x')},1000);` +
      `setInterval(function(){},500)"`;
    const pending = runShellCommand({ command, cwd, timeoutMs: 30000, signal: controller.signal });
    await sleep(300);
    controller.abort("用户停止");
    await assert.rejects(pending, (error) => error.code === "shell_cancelled");
    // 给子进程足够时间完成 1s 延迟写入；若进程树未被终止则 marker 会出现
    await sleep(1500);
    await assert.rejects(() => fs.access(marker), "stop 后子进程不得再写 marker");
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("stdout 与 stderr 各自独立保留最后 1 MiB", async () => {
  // 1 MiB 字面量不能嵌进命令行（ENAMETOOLONG），由子进程在运行时生成
  const command =
    `"${process.execPath}" -e "` +
    `const a='A'.repeat(1048576);process.stdout.write(a+a);` +
    `const b='B'.repeat(1048576);process.stderr.write(b+b)"`;
  const out = await runShellCommand({ command, cwd: os.tmpdir(), timeoutMs: 30000 });
  assert.equal(out.exitCode, 0);
  // 两条流各 2 MiB，各自只保留最后 1 MiB（不是合并上限：若合并，任一流会被挤掉）
  assert.equal(out.stdout.length, 1024 * 1024, "stdout 应保留最后 1 MiB");
  assert.equal(out.stderr.length, 1024 * 1024, "stderr 应保留最后 1 MiB");
  assert.ok(out.stdout.endsWith("A"), "stdout 尾部应为 A");
  assert.ok(out.stderr.endsWith("B"), "stderr 尾部应为 B");
  assert.ok(!out.stdout.includes("B"), "stdout 不应混入 stderr 内容");
  assert.ok(!out.stderr.includes("A"), "stderr 不应混入 stdout 内容");
});

// 子进程回归测试：前置计划 known_baseline_defect（tests/shell-runtime.test.mjs
// 断言通过但进程不退出）必须在本任务消除。子进程内通过环境变量跳过本测试。
test("本文件作为子进程运行 node --test 在最终 TAP 结果后 5 秒内退出 0", { skip: IN_SUBPROCESS }, async () => {
  const child = spawn(process.execPath, ["--test", SELF], {
    env: { ...process.env, WW_RUNTIME_SUBPROCESS_TEST: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  const exited = new Promise((resolve) => child.on("close", (code) => resolve(code)));
  // 等待最终 TAP 摘要（# duration_ms 是 node:test 汇总的最后一行）
  while (!output.includes("# duration_ms")) {
    if (child.exitCode !== null) break;
    await sleep(50);
  }
  const code = await Promise.race([exited, sleep(5000).then(() => "TIMEOUT")]);
  const tail = output.slice(-600);
  assert.notEqual(code, "TIMEOUT", `子进程在最终 TAP 结果后 5 秒内未退出。输出尾部：\n${tail}`);
  assert.equal(code, 0, `子进程应退出 0。输出尾部：\n${tail}`);
});

// ---- Task C9：shell 输出 GBK 解码（Windows）----

test("createOutputDecoder：GBK 跨 chunk 分块字节正确解码；UTF-8 跨 chunk 不误切 GBK", () => {
  // "第一章" 的 GBK 字节 B5 DA D2 BB D5 C2，拆成三块喂入
  const gbk = createOutputDecoder();
  const parts = [Buffer.from([0xB5, 0xDA]), Buffer.from([0xD2, 0xBB]), Buffer.from([0xD5, 0xC2])];
  const out = parts.map((p) => gbk.decode(p)).join("") + gbk.flush();
  assert.equal(out, "第一章", "GBK 跨块字节必须完整解码");
  // UTF-8 跨块（"正" = E6 AD A3 拆两块）不得误切
  const utf8 = createOutputDecoder();
  const utf8Out = utf8.decode(Buffer.from([0xE6, 0xAD])) + utf8.decode(Buffer.from([0xA3])) + utf8.flush();
  assert.equal(utf8Out, "正");
  // 干净 UTF-8 输出不回退
  const clean = createOutputDecoder();
  assert.equal(clean.decode(Buffer.from("hello")), "hello");
});

test("createOutputDecoder：同一命令内先 UTF-8 后 GBK 也能各自正确（stream 状态不泄漏到下一命令）", () => {
  const a = createOutputDecoder();
  assert.equal(a.decode(Buffer.from("ok ")), "ok ");
  const b = createOutputDecoder();
  assert.equal(b.decode(Buffer.from([0xB5, 0xDA, 0xD2, 0xBB, 0xD5, 0xC2])), "第一章", "上一命令的状态不得泄漏");
});

test("GBK 字节流输出被正确解码（Windows cmd 场景）：UTF-8 输出不受影响", { skip: process.platform !== "win32" }, async (t) => {
  const command = 'node -e "process.stdout.write(Buffer.from([0xB5,0xDA,0xD2,0xBB,0xD5,0xC2]))"';
  const out = await runShellCommand({ command, cwd: os.tmpdir(), timeoutMs: 10000 });
  assert.match(out.stdout, /第一章/u, "GBK 字节应解码为中文");
  assert.ok(!out.stdout.includes("\uFFFD"), "不得出现替换符");
});
