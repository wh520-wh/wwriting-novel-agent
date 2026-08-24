// src/app-shell/theme-privacy.js —— 主题（日间/夜间）与隐私模式（第十六轮 T9
// 从 app.js 拆出，行为不变）。deps：{ railRefs, showToast }。
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
  
  function initPrivacyMode() {
    let stored = "off";
    try {
      stored = window.localStorage.getItem("ww:privacy") ?? "off";
    } catch {
      stored = "off";
    }
    applyPrivacyState(stored === "on");
  }
  
  function setPrivacyMode(on) {
    applyPrivacyState(on);
    try {
      window.localStorage.setItem("ww:privacy", on ? "on" : "off");
      if (on && window.localStorage.getItem("ww:privacy:hinted") !== "1") {
        window.localStorage.setItem("ww:privacy:hinted", "1");
        showToast("隐私模式已开启：正文已模糊，鼠标悬停可临时查看。", "info");
      }
    } catch {
      // localStorage 不可用时忽略持久化。
    }
  }
  
  function applyPrivacyState(on) {
    railRefs.app.dataset.privacy = on ? "on" : "off";
    railRefs.privacyToggle.setAttribute("aria-pressed", on ? "true" : "false");
    railRefs.privacyToggle.classList.toggle("active", on);
    railRefs.privacyLabel.textContent = on ? "隐私 · 开" : "隐私";
  }
  initThemeMode();
  initPrivacyMode();
  return { setThemeMode, setPrivacyMode };
}
