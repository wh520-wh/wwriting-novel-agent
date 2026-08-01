import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { desktopWindowChrome } = require("../src/desktop/window-chrome.cjs");

test("Windows uses an integrated title bar while other platforms keep native defaults", () => {
  assert.deepEqual(desktopWindowChrome("linux"), {});
  assert.deepEqual(desktopWindowChrome("win32", false), {
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#f4f3f0", symbolColor: "#24211c", height: 34 }
  });
  assert.deepEqual(desktopWindowChrome("win32", true), {
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#191713", symbolColor: "#ede6d6", height: 34 }
  });
});
