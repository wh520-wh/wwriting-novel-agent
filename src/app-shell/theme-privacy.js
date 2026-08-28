// src/app-shell/theme-privacy.js —— 主题（日间/夜间，第十六轮 T9 从 app.js 拆出）。
// deps：{ railRefs, showToast }。（隐私模式已随 round17 整体删除。）
export function setupThemePrivacy({ railRefs, showToast }) {
  function initThemeMode() {
    let stored = null;
    try {
      stored = window.localStorage.getItem("ww:theme");
    } catch {
      stored = null;
    }
    const dark = stored === "dark" || (stored !== "light" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
    applyThemeState(dark);
    railRefs.themeToggle?.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme !== "dark";
      setThemeMode(next);
    });
  }
  
  function setThemeMode(dark) {
    applyThemeState(dark);
    try {
      window.localStorage.setItem("ww:theme", dark ? "dark" : "light");
    } catch {
      // localStorage 不可用时忽略持久化。
    }
  }
  
  function applyThemeState(dark) {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    railRefs.themeToggle?.setAttribute("aria-pressed", dark ? "true" : "false");
    railRefs.themeToggle?.classList.toggle("active", dark);
    if (railRefs.themeLabel) railRefs.themeLabel.textContent = dark ? "日间" : "夜间";
    try {
      window.wwritingDesktop?.setTitleBarTheme?.(dark);
    } catch {
      // 非 Electron 环境或旧版本忽略。
    }
  }
  
  initThemeMode();
  return { setThemeMode };
}
