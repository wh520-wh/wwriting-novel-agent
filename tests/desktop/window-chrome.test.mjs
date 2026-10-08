import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { desktopWindowChrome } = require("../../src/desktop/window-chrome.cjs");
const { WINDOW_COLORS, windowColors } = require("../../src/desktop/window-colors.cjs");

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/desktop");

test("Windows uses an integrated title bar while other platforms keep native defaults", () => {
  assert.deepEqual(desktopWindowChrome("linux"), {});
  assert.deepEqual(desktopWindowChrome("win32", false), {
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#fafbfc", symbolColor: "#202522", height: 34 }
  });
  assert.deepEqual(desktopWindowChrome("win32", true), {
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#16181a", symbolColor: "#eef2ef", height: 34 }
  });
});

test("native title bar follows the app canvas and text in both themes", () => {
  const css = fs.readFileSync(path.join(desktopDir, "../app-shell/styles.css"), "utf8");
  const light = css.match(/:root\s*\{([^}]+)\}/u)?.[1];
  const dark = css.match(/:root\[data-theme="dark"\]\s*\{([^}]+)\}/u)?.[1];
  for (const [theme, block] of [["light", light], ["dark", dark]]) {
    assert.equal(WINDOW_COLORS[theme].background, block.match(/--bg:\s*([^;]+);/u)?.[1]);
    assert.equal(WINDOW_COLORS[theme].symbol, block.match(/--ink:\s*([^;]+);/u)?.[1]);
  }
  assert.equal(windowColors(false), WINDOW_COLORS.light);
  assert.equal(windowColors(true), WINDOW_COLORS.dark);
});

test("electron-main and window-chrome consume the shared window-colors token module", () => {
  const mainSource = fs.readFileSync(path.join(desktopDir, "electron-main.cjs"), "utf8");
  const chromeSource = fs.readFileSync(path.join(desktopDir, "window-chrome.cjs"), "utf8");

  // 两个消费方都从 window-colors.cjs 取色，token 来源唯一。
  assert.match(mainSource, /require\("\.\/window-colors\.cjs"\)/u);
  assert.match(chromeSource, /require\("\.\/window-colors\.cjs"\)/u);

  // 消费方内不得再出现硬编码的窗口材料色（token 只许在 window-colors.cjs 中定义）。
  for (const hex of [...Object.values(WINDOW_COLORS).flatMap(Object.values), "#f4f3f0", "#191713", "#ede6d6", "#24211c"]) {
    assert.ok(!mainSource.includes(hex), `electron-main.cjs must not hardcode ${hex}`);
    assert.ok(!chromeSource.includes(hex), `window-chrome.cjs must not hardcode ${hex}`);
  }
});
