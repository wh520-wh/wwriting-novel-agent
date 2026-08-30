// src/app-shell/theme.js —— 主题（日间/夜间，第十六轮 T9 从 app.js 拆出，round17 审查更名）。
// deps：{ railRefs }。（隐私模式已随 round17 整体删除；判定单点在 index.html 内联脚本。）
export function setupThemePrivacy({ railRefs }) {
  function initThemeMode() {
    // 内联脚本已在首帧落 data-theme：直接采用；仅在其缺席时兜底重算（口径同内联脚本）。
    let preset = document.documentElement.dataset.theme;
    if (preset !== "dark" && preset !== "light") {
      let stored = null;
      try {
        stored = window.localStorage.getItem("ww:theme");
      } catch {
        stored = null;
      }
      preset = stored === "dark" || (stored !== "light" && window.matchMedia?.("(prefers-color-scheme: dark)").matches)
        ? "dark"
        : "light";
    }
    applyThemeState(preset === "dark");
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
