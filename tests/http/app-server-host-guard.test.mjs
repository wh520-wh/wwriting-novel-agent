// C2（2026-09-23 审计）：本地服务必须校验 Host 头，拒绝 DNS rebinding /
// 恶意网页直打（Host: attacker.com）。合法 127.0.0.1 / localhost 不受影响。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAppShellServer } from "../../src/core/app-server.mjs";

const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6697, 10080
]);

async function listenOnFetchSafePort(server) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    if (!FETCH_BLOCKED_PORTS.has(port)) {
      return port;
    }
    await closeServer(server);
  }
  throw new Error("Could not allocate a fetch-safe test port");
}

async function closeServer(server) {
  if (typeof server.closeAllConnections === "function") {
    server.closeAllConnections();
  }
  return new Promise((resolve) => server.close(resolve));
}

async function startServer(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "host-guard-test-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const server = createAppShellServer({
    workspaceRoot: path.join(root, "ws"),
    selectedProjectRoot: null,
    stateRoot: path.join(root, ".state"),
    secretsRoot: path.join(root, ".secrets"),
    staticRoot: path.resolve("src", "app-shell"),
    port: 0
  });
  const port = await listenOnFetchSafePort(server);
  t.after(() => closeServer(server));
  return { base: `http://127.0.0.1:${port}`, port };
}

test("Host 头非本机地址 → 403 HOST_REJECTED", async (t) => {
  const { base, port } = await startServer(t);
  // fetch 无法直接改 Host；用 node:http 手写请求
  const http = await import("node:http");
  const body = JSON.stringify({});
  const statuses = await Promise.all(["evil.example.com", `evil.example.com:${port}`, "[::1]"].map((host) =>
    new Promise((resolve) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/api/projects/list", method: "GET", headers: { host } },
        (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); }
      );
      req.end();
    })
  ));
  assert.deepEqual(statuses, [403, 403, 403]);
});

test("Host 头为 127.0.0.1 / localhost → 正常响应（非 403）", async (t) => {
  const { base, port } = await startServer(t);
  const http = await import("node:http");
  const statuses = await Promise.all([`127.0.0.1:${port}`, `localhost:${port}`].map((host) =>
    new Promise((resolve) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/api/projects/list", method: "GET", headers: { host } },
        (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); }
      );
      req.end();
    })
  ));
  for (const status of statuses) assert.notEqual(status, 403);
});
