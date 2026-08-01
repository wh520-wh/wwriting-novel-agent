const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("wwritingDesktop", {
  platform: process.platform,
  shell: "electron",
  selectProjectFolder: () => ipcRenderer.invoke("wwriting:select-project-folder"),
  revealPath: (p) => ipcRenderer.invoke("wwriting:reveal-path", p),
  setTitleBarTheme: (dark) => ipcRenderer.invoke("wwriting:set-title-bar-theme", dark)
});
