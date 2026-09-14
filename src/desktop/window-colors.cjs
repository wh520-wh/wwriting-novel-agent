// 窗口亮/暗材料色 token 的唯一来源：electron-main.cjs 的 backgroundColor
// 与 window-chrome.cjs 的 titleBarOverlay 都必须从这里取色。
// 亮色与应用 --bg（#ffffff，src/app-shell/styles.css）保持一致；暗色维持 #191713。
const WINDOW_COLORS = {
  light: { background: "#ffffff", symbol: "#24211c" },
  dark: { background: "#191713", symbol: "#ede6d6" }
};

function windowColors(dark = false) {
  return dark ? WINDOW_COLORS.dark : WINDOW_COLORS.light;
}

module.exports = { WINDOW_COLORS, windowColors };
