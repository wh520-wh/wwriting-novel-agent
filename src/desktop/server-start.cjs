function listenWithFallback(server, preferredPort, host = "127.0.0.1") {
  return listen(server, preferredPort, host, preferredPort !== 0);
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

module.exports = { listenWithFallback };
