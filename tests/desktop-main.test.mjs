import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { listenWithFallback } from "../src/desktop/server-start.cjs";

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
