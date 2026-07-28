import assert from "node:assert/strict";
import test from "node:test";

import { getLastSeen, setLastSeen } from "../../src/app-shell/components/last-seen.js";

const ROOT = "D:\\novels\\clock-shop";

function withLocalStorageGetter(getter, callback) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get: getter
  });
  try {
    return callback();
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  }
}

test("last-seen storage errors degrade without throwing", () => {
  withLocalStorageGetter(() => {
    throw new Error("storage denied");
  }, () => {
    assert.equal(getLastSeen(ROOT, "research"), null);
    assert.doesNotThrow(() => setLastSeen(ROOT, "research"));
  });
});

test("last-seen missing storage is a no-op", () => {
  withLocalStorageGetter(() => undefined, () => {
    assert.equal(getLastSeen(ROOT, "reviewer"), null);
    assert.doesNotThrow(() => setLastSeen(ROOT, "reviewer"));
  });
});
