const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("wwritingDesktop", {
  platform: process.platform,
  shell: "electron",
  selectProjectFolder: () => ipcRenderer.invoke("wwriting:select-project-folder"),
  revealPath: (p) => ipcRenderer.invoke("wwriting:reveal-path", p),
  setTitleBarTheme: (dark) => ipcRenderer.invoke("wwriting:set-title-bar-theme", dark),
  openExternalUrl: (url) => ipcRenderer.invoke("wwriting:open-external-url", url),
  // 技能管理（Task 13）：选择技能文件夹/ZIP；reveal 的 canonical 根由 main 计算。
  selectSkillFolder: () => ipcRenderer.invoke("wwriting:select-skill-folder"),
  selectSkillZip: () => ipcRenderer.invoke("wwriting:select-skill-zip"),
  revealSkillDirectory: (scope, projectRoot) => ipcRenderer.invoke("wwriting:reveal-skill-directory", scope, projectRoot)
});
