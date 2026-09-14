// tests/helpers/http-test.mjs —— HTTP 测试基建（Task 7 共享）。
//
// fetch 安全端口分配与 server 关闭：node:test + fetch 需要避开 Node 全局 fetch
// 的黑名单端口，且 close 前必须强制断开 keep-alive 连接才能确定性退出。
// tests/http/agent-routes.test.mjs 与 tests/http/project-routes.test.mjs 共用，
// 避免各测试文件复制同一段 ~50 行的样板。
import assert from "node:assert/strict";
import http from "node:http";

export const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6697, 10080
]);

export async function listenOnFetchSafePort(server) {
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

export function closeServer(server) {
  // 强制断开残留 keep-alive 连接，server.close 才能确定性返回
  if (typeof server.closeAllConnections === "function") {
    server.closeAllConnections();
  }
  return new Promise((resolve) => server.close(resolve));
}

// 组装真实 HTTP server：router + 一组 route 模块（{ "METHOD /path": handler } 形状）。
// t.after 里先关 server 再执行 afterClose（如 harness cleanup）。
export async function startHttpServer(t, { router, routeModules = [], afterClose = null }) {
  for (const routes of routeModules) {
    for (const [pattern, handler] of Object.entries(routes)) {
      const [method, pathname] = pattern.split(" ");
      router.add(method, pathname, handler);
    }
  }
  const server = http.createServer((request, response) => router.handle(request, response));
  const port = await listenOnFetchSafePort(server);
  t.after(async () => {
    await closeServer(server);
    if (afterClose) await afterClose();
  });
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    async post(route, body = {}, headers = {}) {
      const res = await fetch(`${base}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body)
      });
      const data = await res.json().catch(() => null);
      return { res, data };
    },
    async get(route) {
      const res = await fetch(`${base}${route}`);
      const data = await res.json().catch(() => null);
      return { res, data };
    }
  };
}

// 断言 helper：路由错误响应形状（ok:false + code）。
export function assertErrorResponse({ res, data }, status, code) {
  assert.equal(res.status, status);
  assert.equal(data.ok, false);
  assert.equal(data.code, code);
}
