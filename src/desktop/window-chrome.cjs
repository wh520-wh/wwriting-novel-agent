const { windowColors } = require("./window-colors.cjs");

const TITLE_BAR_HEIGHT = 34;

function desktopWindowChrome(platform = process.platform, dark = false) {
  if (platform !== "win32") return {};
  const tokens = windowColors(dark);
  return {
    titleBarStyle: "hidden",
    titleBarOverlay: { color: tokens.background, symbolColor: tokens.symbol, height: TITLE_BAR_HEIGHT }
  };
}

module.exports = { desktopWindowChrome };
