// 窗口亮/暗材料色 token 的唯一来源：electron-main.cjs 的 backgroundColor
// 与 window-chrome.cjs 的 titleBarOverlay 都必须从这里取色。
// 与 src/app-shell/styles.css 的 --bg / --ink 对齐，避免原生标题栏出现异色断层。
const WINDOW_COLORS = {
  light: { background: "#fafbfc", symbol: "#202522" },
  dark: { background: "#16181a", symbol: "#eef2ef" }
};

function windowColors(dark = false) {
  return dark ? WINDOW_COLORS.dark : WINDOW_COLORS.light;
}

module.exports = { WINDOW_COLORS, windowColors };
