import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { closeServerGracefully, listenWithFallback } from "../src/desktop/server-start.cjs";
import { resolveRevealTarget } from "../src/core/app-dashboard.mjs";

test("listenWithFallback retries on an occupied preferred port", async () => {
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const occupied = blocker.address().port;
  const server = http.createServer();
  try {
    const port = await listenWithFallback(server, occupied, "127.0.0.1");
    assert.notEqual(port, occupied);
    assert.equal(server.listening, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test("reveal whitelist accepts only validated project roots and derived directories", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-reveal-"));
  const projectRoot = path.join(base, "novel-a");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(path.join(projectRoot, "project.yaml"), 'title: "小说 A"\n', "utf8");

  // 项目根本身与其派生目录（无论是否存在）都在白名单内。
  assert.equal(await resolveRevealTarget(projectRoot), projectRoot);
  const derived = path.join(projectRoot, "exports");
  assert.equal(await resolveRevealTarget(derived), derived);
  assert.equal(await resolveRevealTarget(path.join(derived, "sub")), path.join(derived, "sub"));

  // 任意路径被拒：非项目目录、不存在的深层路径、空串、非字符串。
  const arbitrary = path.join(base, "not-a-project");
  await fs.mkdir(arbitrary, { recursive: true });
  await assert.rejects(() => resolveRevealTarget(arbitrary), /项目/u);
  await assert.rejects(() => resolveRevealTarget(path.join(arbitrary, "deep", "dir")), /项目/u);
  await assert.rejects(() => resolveRevealTarget(""), /项目/u);
  await assert.rejects(() => resolveRevealTarget(12345), /项目/u);
  await assert.rejects(() => resolveRevealTarget(null), /项目/u);
});

test("closeServerGracefully force-closes lingering connections after timeout and resolves", async () => {
  // 模拟 keep-alive 残留：客户端连接后从不发请求，server.close 会永远等待该连接。
  const server = http.createServer(() => {
    // 故意不响应任何请求。
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const socket = net.connect(port, "127.0.0.1");
  try {
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });

    let forceClosed = false;
    const original = server.closeAllConnections.bind(server);
    server.closeAllConnections = () => {
      forceClosed = true;
      original();
    };

    await Promise.race([
      closeServerGracefully(server, { timeoutMs: 80 }),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("closeServerGracefully 未在超时后 resolve")), 2000);
      })
    ]);
    assert.equal(forceClosed, true, "超时后必须调用 closeAllConnections");
    assert.equal(server.listening, false, "server 应已停止监听");
  } finally {
    socket.destroy();
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
  }
});
