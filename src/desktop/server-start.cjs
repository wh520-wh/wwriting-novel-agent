// desktop 主进程可测试辅助（tests/desktop-main.test.mjs 直接 import 本模块）：
// 端口监听兜底 + 优雅关停（reveal 白名单见 app-dashboard.mjs）。electron-main.cjs
// 只做接线，关停语义在这里实现，普通 Node 进程即可测试。
function listenWithFallback(server, preferredPort, host = "127.0.0.1") {
  return listen(server, preferredPort, host, preferredPort !== 0);
}

// B17 退出 server.close 无超时：server.close 会一直等待残留 keep-alive 连接
// 结束，Electron before-quit 若直接 close 可能被拖死。超时后调用
// closeAllConnections 强制断开连接并 resolve，退出流程不被 server 阻塞。
function closeServerGracefully(server, options = {}) {
  const timeoutMs = Number.isFinite(options?.timeoutMs) ? options.timeoutMs : 5000;
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      if (done) return;
      if (typeof server?.closeAllConnections === "function") {
        server.closeAllConnections();
      }
      // 即使 closeAllConnections 缺失或仍有连接未结束，也主动 resolve——
      // 调用方（before-quit）不能因为 server 关不掉而卡死退出。
      finish();
    }, timeoutMs);
    try {
      server.close(finish);
    } catch {
      finish();
    }
  });
}

function listen(server, port, host, allowFallback) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onError = (error) => {
      if (settled) return;
      if (allowFallback && ["EADDRINUSE", "EACCES"].includes(error?.code)) {
        settled = true;
        server.removeListener("error", onError);
        listen(server, 0, host, false).then(resolve, reject);
        return;
      }
      settled = true;
      server.removeListener("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      if (settled) return;
      settled = true;
      server.removeListener("error", onError);
      resolve(server.address().port);
    });
  });
}

module.exports = { listenWithFallback, closeServerGracefully };
